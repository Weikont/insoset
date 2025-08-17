require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/citizens/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'photo-' + uniqueSuffix + ext);
  }
});

// Инициализация upload middleware
const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Разрешены только изображения'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB
  }
});

// Создаем папку для загрузок, если ее нет
const fs = require('fs');
const uploadDir = 'public/uploads/citizens';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
// Добавьте это после инициализации app, но до маршрутов
app.use('/uploads', express.static('public/uploads'));
// Database connection
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'event_management',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Constants
const USER_ROLES = {
  CIVIL: 'Гражданский',
  POLICE: 'МВД',
  NG: 'ФСВНГ',
  MEDIC: 'СМП',
  MCHS: 'МЧС',
  ADMIN: 'admin',
  CANDIDATE: 'Кандидат'
};

const NOTIFICATION_TYPES = {
  ROLE_CHANGE: 'role_change',
  WARNING: 'warning',
  BAN: 'ban',
  INFO: 'info',
  APPLICATION_UPDATE: 'application_update'
};
function generatePassportData() {
  const series = Math.floor(1000 + Math.random() * 9000).toString();
  const number = Math.floor(100000 + Math.random() * 900000).toString();
  return { series, number };
}

// Генератор номеров водительских прав
function generateDriverLicenseNumber() {
  const prefix = 'РФ';
  const numbers = Math.floor(100000 + Math.random() * 900000).toString();
  return `${prefix}${numbers}`;
}
const ADMIN_EMAILS = process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',') : [];

// Helpers
const isAdminEmail = (email) => ADMIN_EMAILS.includes(email);

// Middlewares
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Authorization header is required in format: Bearer <token>' 
      });
    }

    const token = authHeader.split(' ')[1];
    
    if (!token || token.length < 50) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid authentication token format' 
      });
    }

    const decodedToken = await admin.auth().verifyIdToken(token);
    
    // Check if user exists and is banned
    let [users] = await pool.query(
      'SELECT id, is_banned, ban_reason FROM users WHERE auth_uid = ? LIMIT 1',
      [decodedToken.uid]
    );

    if (users.length > 0 && users[0].is_banned) {
      return res.status(403).json({
        success: false,
        error: 'Account is banned',
        details: {
          reason: users[0].ban_reason || 'No reason provided',
          banned: true
        }
      });
    }

    if (users.length === 0) {
      // Create new user if not exists
      const [result] = await pool.query(
        `INSERT INTO users (email, name, auth_uid, roles) 
         VALUES (?, ?, ?, ?)`,
        [
          decodedToken.email || null, 
          decodedToken.name || null, 
          decodedToken.uid, 
          JSON.stringify([USER_ROLES.CANDIDATE])
        ]
      );
      users = [{ id: result.insertId }];
    }

    // Get user profile
    const [profile] = await pool.query(
      `SELECT first_name, last_name, middle_name, rank, department, badge_number 
       FROM user_profiles 
       WHERE user_id = ?`,
      [users[0].id]
    );

    req.user = { 
      id: users[0].id,
      uid: decodedToken.uid,
      email: decodedToken.email,
      profile: profile[0] || null
    };

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    
    let errorMessage = 'Invalid authentication token';
    if (error.code === 'auth/id-token-expired') {
      errorMessage = 'Authentication token expired';
    } else if (error.code === 'auth/argument-error') {
      errorMessage = 'Invalid token format';
    }
    
    res.status(401).json({ 
      success: false, 
      error: errorMessage,
      details: error.message
    });
  }
};


const adminOnly = async (req, res, next) => {
  try {
    const [users] = await pool.query(
      'SELECT role, is_admin FROM users WHERE id = ?', 
      [req.user.id]
    );
    
    if (users.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    const user = users[0];
    const isAdmin = user.role === 'admin' || user.is_admin === 1;
    
    if (!isAdmin) {
      return res.status(403).json({ 
        success: false, 
        error: 'Admin access required'
      });
    }
    
    next();
  } catch (error) {
    console.error('Admin check error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Server error during admin verification' 
    });
  }
};
const logSearch = async (req, searchType, query, result, details = null) => {
  try {
    const [profile] = await pool.query(
      `SELECT first_name, last_name, rank, department, badge_number 
       FROM user_profiles 
       WHERE user_id = ?`,
      [req.user.uid]
    );
    
    await pool.query(
      `INSERT INTO gibdd_search_logs 
       (user_id, user_name, search_type, search_query, search_result, result_details, department, badge_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.uid,
        profile.length ? `${profile[0].rank} ${profile[0].last_name} ${profile[0].first_name}` : 'Unknown',
        searchType,
        query,
        result,
        details,
        profile.length ? profile[0].department : null,
        profile.length ? profile[0].badge_number : null
      ]
    );
  } catch (error) {
    console.error('Ошибка логирования:', error);
  }
};
// Notification helper
const createNotification = async (userId, message, type) => {
  await pool.query(
    `INSERT INTO user_notifications 
     (user_id, message, type) 
     VALUES (?, ?, ?)`,
    [userId, message, type]
  );
};

// Initialize database
const initializeDatabase = async () => {
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(255),
      avatar VARCHAR(512),
      auth_provider VARCHAR(50),
      auth_uid VARCHAR(255),
      roles JSON NOT NULL,  
      warnings INT DEFAULT 0,
      is_banned BOOLEAN DEFAULT FALSE,
      ban_reason TEXT,
      last_login TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS applications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
      rejection_reason TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS news (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      content TEXT NOT NULL,
      author_id INT NOT NULL,
      image_url VARCHAR(512),
      is_published BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS user_warnings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      reason TEXT NOT NULL,
      admin_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS user_notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      message TEXT NOT NULL,
      type ENUM('role_change', 'warning', 'ban', 'info', 'application_update') NOT NULL,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
     `
  CREATE TABLE IF NOT EXISTS emergency_call_reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    call_id INT NOT NULL,
    officer_id INT NOT NULL,
    report_type ENUM('arrival', 'completion', 'incident') NOT NULL,
    report_data JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (call_id) REFERENCES emergency_calls(id) ON DELETE CASCADE,
    FOREIGN KEY (officer_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`,
`
  CREATE TABLE IF NOT EXISTS emergency_call_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    call_id INT NOT NULL,
    user_id INT NOT NULL,
    message TEXT NOT NULL,
    photo_url VARCHAR(512),
    is_system BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (call_id) REFERENCES emergency_calls(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`
  ];

  for (const table of tables) {
    await pool.query(table);
  }

  try {
    await pool.query(`
      ALTER TABLE applications 
      ADD COLUMN rejection_reason TEXT NULL AFTER status
    `);
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') {
      console.error('Error adding column:', err);
    }
  }
};

// Initialize database and start server
pool.getConnection()
  .then(connection => {
    console.log('✅ Успешное подключение к MySQL');
    connection.release();
    return initializeDatabase();
  })
  .then(() => {
    // Routes
    // User routes
 app.get('/api/user', authenticate, async (req, res) => {
  try {
    const [users] = await pool.query(
      `SELECT 
        id, 
        email, 
        name, 
        avatar, 
        roles,
        is_banned,
        ban_reason,
        warnings,
        created_at,
        is_admin as isAdmin
      FROM users 
      WHERE id = ?`,
      [req.user.id]
    );
    
    if (users.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    const userData = users[0];
    
    // Check if user is banned
    if (userData.is_banned) {
      return res.status(403).json({
        success: false,
        error: 'Account is banned',
        details: {
          reason: userData.ban_reason || 'No reason provided',
          banned: true
        }
      });
    }

    // Handle roles parsing more gracefully
    let rolesArray = [];
    try {
      // Try to parse as JSON first
      if (userData.roles && typeof userData.roles === 'string') {
        rolesArray = JSON.parse(userData.roles);
      } else if (Array.isArray(userData.roles)) {
        rolesArray = userData.roles;
      } else if (userData.roles) {
        // If it's a plain string (like "Кандидат"), convert to array
        rolesArray = [userData.roles];
      }
    } catch (e) {
      console.error('Error parsing roles:', e);
      // If parsing fails, treat it as a single role
      rolesArray = userData.roles ? [userData.roles] : [];
    }
    
    res.json({
      success: true,
      user: {
        ...userData,
        roles: rolesArray,
        isAdmin: userData.isAdmin === 1 || isAdminEmail(userData.email),
        is_banned: userData.is_banned === 1 || userData.is_banned === true,
        ban_reason: userData.ban_reason || null
      }
    });
    
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch user',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});
app.get('/api/user/notifications', authenticate, async (req, res) => {
  try {
    console.log(`Fetching notifications for user: ${req.user.uid}`);
    
    const [notifications] = await pool.query(
      `SELECT id, message, type, is_read, created_at 
       FROM user_notifications 
       WHERE user_id = ? 
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.uid]
    );
    
    console.log(`Found ${notifications.length} notifications`);
    console.log('Sample notification:', notifications[0]);
    
    res.json({ success: true, notifications });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch notifications',
      details: error.message
    });
  }
});


app.get('/api/gibdd/unpaid-fines', authenticate, async (req, res) => {
  try {
    const [fines] = await pool.query(`
      SELECT 
        id,
        article,
        description,
        fine_amount as fineAmount,
        DATE_FORMAT(date_time, '%Y-%m-%d %H:%i:%s') as dateTime,
        location
      FROM violations 
      WHERE officer_id = ? AND sent_to_gosuslugi = TRUE AND paid = FALSE
    `, [req.user.uid]);
    
    res.json({ success: true, fines });
  } catch (error) {
    console.error('Error fetching unpaid fines:', error);
    res.status(500).json({ success: false, error: 'Ошибка проверки штрафов' });
  }
});
app.post('/api/gibdd/fines/:id/pay', authenticate, async (req, res) => {
  try {
    await pool.query(
      `UPDATE violations SET paid = TRUE WHERE id = ? AND officer_id = ?`,
      [req.params.id, req.user.uid]
    );
    
    res.json({ success: true, message: 'Штраф успешно оплачен' });
  } catch (error) {
    console.error('Error paying fine:', error);
    res.status(500).json({ success: false, error: 'Ошибка оплаты штрафа' });
  }
});


// ГИБДД: Добавление нарушения
app.post('/api/gibdd/violations', authenticate, async (req, res) => {
  try {
    // 1. Сначала проверим существование таблицы
    const [tables] = await pool.query(`
      SHOW TABLES LIKE 'user_profiles'
    `);
    
    if (tables.length === 0) {
      throw new Error('Таблица user_profiles не существует');
    }

    // 2. Проверим существование всех необходимых столбцов
    const [columns] = await pool.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'user_profiles' 
      AND TABLE_SCHEMA = DATABASE()
    `);
    
    const requiredColumns = ['first_name', 'last_name', 'middle_name', 'rank', 'badge_number'];
    const missingColumns = requiredColumns.filter(col => 
      !columns.some(c => c.COLUMN_NAME === col)
    );
    
    if (missingColumns.length > 0) {
      throw new Error(`Отсутствуют столбцы: ${missingColumns.join(', ')}`);
    }

    // 3. Исправленный запрос с экранированием имен столбцов
    const [profile] = await pool.query(`
      SELECT 
        \`first_name\`,
        \`last_name\`, 
        \`middle_name\`, 
        \`rank\`, 
        \`badge_number\`
      FROM \`user_profiles\`
      WHERE \`user_id\` = ?
      LIMIT 1
    `, [req.user.id]);

    if (profile.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Профиль инспектора не найден. Заполните свой профиль.'
      });
    }

    const officerData = profile[0];
    const officerName = [
      officerData.rank,
      officerData.last_name,
      officerData.first_name,
      officerData.middle_name
    ].filter(Boolean).join(' ');

    // 4. Создаем нарушение
    const [result] = await pool.query(`
      INSERT INTO \`violations\` SET ?
    `, {
      vehicle_id: req.body.vehicleId,
      officer_id: req.user.uid,
      officer_name: officerName,
      badge_number: officerData.badge_number,
      article: req.body.article,
      description: req.body.description,
      fine_amount: req.body.fineAmount,
      location: req.body.location,
      date_time: req.body.dateTime,
      circumstances: req.body.circumstances,
      evidence: req.body.evidence || null,
      department: 'ОДД ГИБДД',
      paid: false,
      created_at: new Date()
    });

    res.json({
      success: true,
      message: 'Протокол успешно составлен',
      violationId: result.insertId
    });

  } catch (error) {
    console.error('Add violation error:', {
      message: error.message,
      stack: error.stack,
      sql: error.sql
    });
    
    res.status(500).json({
      success: false,
      error: 'Ошибка при создании протокола',
      details: process.env.NODE_ENV === 'development' ? {
        message: error.message,
        sql: error.sql
      } : null
    });
  }
});

app.post('/api/gibdd/violations/:id/send', authenticate, async (req, res) => {
  try {
    await pool.query(
      `UPDATE violations 
       SET sent_to_gosuslugi = TRUE, 
           sent_date = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [req.params.id]
    );

    res.json({ success: true, message: 'Протокол успешно отправлен в Госуслуги' });
  } catch (error) {
    console.error('Send violation error:', error);
    res.status(500).json({ success: false, error: 'Ошибка отправки протокола' });
  }
});

// ГИБДД: Поиск по водительским правам
app.get('/api/gibdd/licenses/:number', authenticate, async (req, res) => {
  try {
    const licenseNumber = req.params.number.toUpperCase();
    
    const [licenses] = await pool.query(`
      SELECT 
        dl.*,
        CONCAT(c.last_name, ' ', c.first_name, ' ', COALESCE(c.middle_name, '')) as owner_name,
        c.passport_series, c.passport_number,
        c.birth_date, c.birth_place,
        (
          SELECT JSON_ARRAYAGG(
            JSON_OBJECT(
              'id', vv.id,
              'violation_date', vv.violation_date,
              'violation_type', vv.violation_type,
              'fine_amount', vv.fine_amount,
              'paid', vv.paid,
              'vehicle_plate', v.plate_number
            )
          )
          FROM vehicle_violations vv
          JOIN vehicles v ON vv.vehicle_id = v.id
          WHERE vv.driver_license = dl.license_number
          ORDER BY vv.violation_date DESC
          LIMIT 10
        ) as violations,
        (
          SELECT COUNT(*) 
          FROM vehicle_violations 
          WHERE driver_license = dl.license_number 
          AND violation_date > DATE_SUB(CURRENT_DATE, INTERVAL 1 YEAR)
        ) as violations_last_year,
        dl.points as penalty_points
      FROM driver_licenses dl
      JOIN citizens c ON dl.citizen_id = c.id
      WHERE dl.license_number = ?
      LIMIT 1
    `, [licenseNumber]);

    if (licenses.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Водительские права не найдены' 
      });
    }

    const license = licenses[0];
    license.violations = license.violations ? JSON.parse(license.violations) : [];
    
    // Проверяем срок действия
    const isExpired = new Date(license.expiration_date) < new Date();
    
    res.json({
      success: true,
      license: {
        ...license,
        isExpired,
        isValid: !isExpired && license.penalty_points < 10
      }
    });
  } catch (error) {
    console.error('License check error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка проверки водительских прав',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});


app.post('/api/user/notifications/:id/read', authenticate, async (req, res) => {
  try {
    await pool.query(
      `UPDATE user_notifications 
       SET is_read = TRUE 
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.uid]
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to mark notification as read' });
  }
});
app.get('/api/scuo/weapons', authenticate, adminOnly, async (req, res) => {
  try {
    const [weapons] = await pool.query(`
      SELECT 
        w.*,
        CONCAT(c.last_name, ' ', c.first_name) as owner_name,
        c.passport_series, c.passport_number,
        wl.license_type
      FROM weapons w
      JOIN citizens c ON w.citizen_id = c.id
      LEFT JOIN weapon_licenses wl ON w.license_id = wl.id
      ORDER BY w.registration_date DESC
    `);
    
    res.json({ success: true, weapons });
  } catch (error) {
    console.error('SCUO weapons error:', error);
    res.status(500).json({ success: false, error: 'Ошибка загрузки оружия' });
  }
});

// Изъятие оружия
app.put('/api/scuo/weapons/:id/seize', authenticate, adminOnly, async (req, res) => {
  try {
    const { reason } = req.body;
    
    await pool.query(
      `UPDATE weapons SET 
        status = 'seized',
        seizure_reason = ?,
        seizure_date = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [reason, req.params.id]
    );

    // Получаем полную информацию об оружии, включая владельца
    const [weapon] = await pool.query(
      `SELECT w.*, c.user_id 
       FROM weapons w
       JOIN citizens c ON w.citizen_id = c.id
       WHERE w.id = ?`,
      [req.params.id]
    );
    
    if (weapon.length > 0 && weapon[0].user_id) {
      await createNotification(
        weapon[0].user_id, // Используем user_id из таблицы citizens
        `Ваше оружие изъято. Причина: ${reason}`,
        'warning' // Используем существующий тип уведомления
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error seizing weapon:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка изъятия оружия',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});
app.put('/api/scuo/weapons/:id/approve', authenticate, adminOnly, async (req, res) => {
  try {
    await pool.query(
      `UPDATE weapons SET status = 'active' WHERE id = ?`,
      [req.params.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error approving weapon:', error);
    res.status(500).json({ success: false, error: 'Ошибка подтверждения оружия' });
  }
});
app.delete('/api/user/notifications/:id', authenticate, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM user_notifications 
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.uid]
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete notification' });
  }
});

    // Auth routes
    app.post('/api/auth/google', async (req, res) => {
      try {
        const { uid, email, displayName = '', photoURL = null } = req.body;
        
        const role = isAdminEmail(email) ? 'admin' : 'user';
        
        const [result] = await pool.query(`
          INSERT INTO users (email, name, avatar, auth_provider, auth_uid, role)
          VALUES (?, ?, ?, 'google', ?, ?)
          ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            avatar = VALUES(avatar),
            role = VALUES(role),
            updated_at = CURRENT_TIMESTAMP
        `, [email, displayName, photoURL, uid, role]);

        const [userData] = await pool.query(
          `SELECT id, email, name, avatar, role, created_at 
           FROM users WHERE email = ?`, 
          [email]
        );

        res.json({
          success: true,
          user: {
            ...userData[0],
            isAdmin: userData[0].role === 'admin'
          }
        });
      } catch (error) {
        console.error('Google auth error:', error);
        res.status(500).json({ success: false, error: 'Authentication failed' });
      }
    });

    // Admin routes
    app.get('/api/admin/users', authenticate, adminOnly, async (req, res) => {
      try {
        const [users] = await pool.query(
          `SELECT id, name, email, roles, is_banned, warnings, created_at 
           FROM users ORDER BY created_at DESC`
        );
        res.json({ success: true, users });
      } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch users' });
      }
    });
// Добавьте новые маршруты для работы с историей вызовов
app.get('/api/emergency/calls/history', authenticate, async (req, res) => {
  try {
    // Сначала проверим существование колонок
    const [columns] = await pool.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'emergency_calls' 
      AND TABLE_SCHEMA = DATABASE()
    `);
    
    const columnNames = columns.map(c => c.COLUMN_NAME);
    const hasResponseTime = columnNames.includes('response_time');
    const hasCompletionTime = columnNames.includes('completion_time');
    const hasOfficerNotes = columnNames.includes('officer_notes');

    // Формируем запрос динамически в зависимости от существующих колонок
    let query = `
      SELECT 
        id,
        emergency_type,
        address,
        description,
        caller_name,
        caller_phone,
        call_time,
        status
    `;
    
    if (hasResponseTime) query += ', response_time';
    if (hasCompletionTime) query += ', completion_time';
    if (hasOfficerNotes) query += ', officer_notes';
    
    query += `
      FROM emergency_calls
      WHERE user_id = ?
      ORDER BY call_time DESC
    `;

    const [calls] = await pool.query(query, [req.user.uid]);
    
    res.json({ success: true, calls });
  } catch (error) {
    console.error('Error fetching emergency calls history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch emergency calls history',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});

app.put('/api/emergency/calls/:id/status', authenticate, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const allowedStatuses = ['sent', 'in_progress', 'completed', 'false_alarm'];
    
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid status value' 
      });
    }

    // Проверяем, что вызов принадлежит пользователю
    const [existingCall] = await pool.query(
      'SELECT id FROM emergency_calls WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.uid]
    );
    
    if (existingCall.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Emergency call not found or access denied' 
      });
    }

    // Обновляем статус
    const updateData = { status };
    
    if (status === 'in_progress') {
      updateData.response_time = new Date();
    } else if (status === 'completed' || status === 'false_alarm') {
      updateData.completion_time = new Date();
    }
    
    if (notes) {
      updateData.officer_notes = notes;
    }

    await pool.query(
      'UPDATE emergency_calls SET ? WHERE id = ?',
      [updateData, req.params.id]
    );

    const [updatedCall] = await pool.query(
      'SELECT * FROM emergency_calls WHERE id = ?',
      [req.params.id]
    );

    res.json({ 
      success: true, 
      call: updatedCall[0],
      message: 'Статус вызова успешно обновлен'
    });
  } catch (error) {
    console.error('Error updating emergency call status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update emergency call status',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});
    app.get('/api/admin/users/:id', authenticate, adminOnly, async (req, res) => {
      try {
        const [users] = await pool.query(
          `SELECT id, email, name, avatar, roles, is_banned, ban_reason, warnings, created_at 
           FROM users WHERE id = ?`,
          [req.params.id]
        );
        
        if (users.length === 0) {
          return res.status(404).json({ success: false, error: 'User not found' });
        }
        
        res.json({ success: true, user: users[0] });
      } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch user' });
      }
    });

   app.put('/api/admin/users/:id', authenticate, adminOnly, async (req, res) => {
  try {
    const { name, email, roles, is_banned, ban_reason } = req.body;
    
    // Validate roles - accept both array and string (convert string to array)
    let rolesArray = [];
    if (Array.isArray(roles)) {
      rolesArray = roles;
    } else if (typeof roles === 'string') {
      try {
        // Try to parse if it's a JSON string
        rolesArray = JSON.parse(roles);
      } catch (e) {
        // If not JSON, treat as single role
        rolesArray = [roles];
      }
    } else {
      return res.status(400).json({ 
        success: false, 
        error: 'Roles must be an array or string' 
      });
    }

    // Get current user data
    const [currentData] = await pool.query(
      'SELECT name, email, roles FROM users WHERE id = ?',
      [req.params.id]
    );

    // Convert current roles to array for comparison
    let currentRoles = [];
    try {
      currentRoles = JSON.parse(currentData[0].roles);
    } catch (e) {
      currentRoles = currentData[0].roles ? [currentData[0].roles] : [];
    }

    await pool.query(
      `UPDATE users 
       SET name = ?, email = ?, roles = ?, is_banned = ?, ban_reason = ?
       WHERE id = ?`,
      [name, email, JSON.stringify(rolesArray), is_banned, ban_reason, req.params.id]
    );

    // Create notifications for changes
    if (name !== currentData[0].name) {
      await createNotification(
        req.params.id,
        `Администратор изменил ваше имя с "${currentData[0].name}" на "${name}"`,
        NOTIFICATION_TYPES.INFO
      );
    }

    if (email !== currentData[0].email) {
      await createNotification(
        req.params.id,
        `Администратор изменил ваш email с "${currentData[0].email}" на "${email}"`,
        NOTIFICATION_TYPES.INFO
      );
    }

    // Compare roles as arrays
    if (JSON.stringify(rolesArray.sort()) !== JSON.stringify(currentRoles.sort())) {
      await createNotification(
        req.params.id,
        `Администратор изменил ваши роли на: ${rolesArray.join(', ')}`,
        NOTIFICATION_TYPES.ROLE_CHANGE
      );
    }

    const [updatedUser] = await pool.query(
      `SELECT id, email, name, avatar, roles, is_banned, ban_reason, warnings, created_at 
       FROM users WHERE id = ?`,
      [req.params.id]
    );

    res.json({ 
      success: true, 
      user: {
        ...updatedUser[0],
        // Ensure roles is always an array in response
        roles: typeof updatedUser[0].roles === 'string' ? JSON.parse(updatedUser[0].roles) : updatedUser[0].roles
      }
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update user',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});



app.get('/api/user/profile', authenticate, async (req, res) => {
  try {
    const [profile] = await pool.query(
      `SELECT * FROM user_profiles WHERE user_id = ?`,
      [req.user.id]
    );
    
    if (profile.length === 0) {
      // Создаем пустой профиль, если его нет
      await pool.query(
        `INSERT INTO user_profiles (user_id) VALUES (?)`,
        [req.user.id]
      );
      return res.json({ success: true, profile: {} });
    }
    
    res.json({ 
      success: true, 
      profile: {
        ...profile[0],
        contacts: profile[0].contacts ? JSON.parse(profile[0].contacts) : {}
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch profile' 
    });
  }
});

// Обновить профиль пользователя
app.put('/api/user/profile', authenticate, async (req, res) => {
  try {
    const { 
      first_name, 
      last_name, 
      middle_name, 
      rank, 
      position, 
      department, 
      badge_number 
    } = req.body;

    const [existing] = await pool.query(
      `SELECT id FROM user_profiles WHERE user_id = ?`,
      [req.user.id]
    );

    if (existing.length > 0) {
      await pool.query(
        `UPDATE user_profiles 
         SET first_name = ?, last_name = ?, middle_name = ?, 
             \`rank\` = ?, position = ?, department = ?, badge_number = ?
         WHERE user_id = ?`,
        [
          first_name,
          last_name,
          middle_name,
          rank,
          position,
          department,
          badge_number,
          req.user.id
        ]
      );
    } else {
      await pool.query(
        `INSERT INTO user_profiles 
         (user_id, first_name, last_name, middle_name, \`rank\`, position, department, badge_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          first_name,
          last_name,
          middle_name,
          rank,
          position,
          department,
          badge_number
        ]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update profile',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});

// Получить профиль пользователя (для админа)
app.get('/api/admin/users/:id/profile', authenticate, adminOnly, async (req, res) => {
  try {
    const [profile] = await pool.query(
      `SELECT * FROM user_profiles WHERE user_id = ?`,
      [req.params.id]
    );
    
    if (profile.length === 0) {
      return res.json({ success: true, profile: {} });
    }
    
    res.json({ 
      success: true, 
      profile: {
        ...profile[0],
        contacts: profile[0].contacts ? JSON.parse(profile[0].contacts) : {}
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch profile' 
    });
  }
});

// Обновить профиль пользователя (для админа)
app.put('/api/admin/users/:id/profile', authenticate, adminOnly, async (req, res) => {
  try {
    const { 
      first_name, 
      last_name, 
      middle_name, 
      rank, 
      position, 
      department, 
      bio,
      contacts
    } = req.body;

    // Проверяем, существует ли профиль
    const [existing] = await pool.query(
      `SELECT id FROM user_profiles WHERE user_id = ?`,
      [req.params.id]
    );

    if (existing.length > 0) {
      // Обновляем существующий профиль
      await pool.query(
        `UPDATE user_profiles 
         SET first_name = ?, last_name = ?, middle_name = ?, 
             rank = ?, position = ?, department = ?, bio = ?, contacts = ?
         WHERE user_id = ?`,
        [
          first_name,
          last_name,
          middle_name,
          rank,
          position,
          department,
          bio,
          JSON.stringify(contacts || {}),
          req.params.id
        ]
      );
    } else {
      // Создаем новый профиль
      await pool.query(
        `INSERT INTO user_profiles 
         (user_id, first_name, last_name, middle_name, rank, position, department, bio, contacts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.params.id,
          first_name,
          last_name,
          middle_name,
          rank,
          position,
          department,
          bio,
          JSON.stringify(contacts || {})
        ]
      );
    }

    // Обновляем имя пользователя в основной таблице
    if (first_name && last_name) {
      await pool.query(
        `UPDATE users SET name = ? WHERE id = ?`,
        [`${last_name} ${first_name} ${middle_name || ''}`.trim(), req.params.id]
      );
    }

    const [updatedProfile] = await pool.query(
      `SELECT * FROM user_profiles WHERE user_id = ?`,
      [req.params.id]
    );

    res.json({ 
      success: true, 
      profile: {
        ...updatedProfile[0],
        contacts: updatedProfile[0].contacts ? JSON.parse(updatedProfile[0].contacts) : {}
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update profile' 
    });
  }
});






    app.post('/api/admin/users/:id/warnings', authenticate, adminOnly, async (req, res) => {
      try {
        const { reason } = req.body;
        
        if (!reason) {
          return res.status(400).json({ success: false, error: 'Reason is required' });
        }

        await pool.query(
          `INSERT INTO user_warnings (user_id, reason, admin_id) VALUES (?, ?, ?)`,
          [req.params.id, reason, req.user.id]
        );

        await pool.query(
          `UPDATE users SET warnings = warnings + 1 WHERE id = ?`,
          [req.params.id]
        );

        await createNotification(
          req.params.id,
          `Вы получили предупреждение от администратора. Причина: ${reason}`,
          NOTIFICATION_TYPES.WARNING
        );

        const [updatedUser] = await pool.query(
          `SELECT id, email, name, warnings FROM users WHERE id = ?`,
          [req.params.id]
        );

        res.json({ success: true, user: updatedUser[0] });
      } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to add warning' });
      }
    });
app.get('/api/gosuslugi/weapons', authenticate, async (req, res) => {
  try {
    const [weapons] = await pool.query(`
      SELECT 
        w.*,
        CONCAT(c.last_name, ' ', c.first_name) as owner_name,
        c.passport_series,
        c.passport_number
      FROM weapons w
      JOIN citizens c ON w.citizen_id = c.id
      WHERE w.user_id = ?
    `, [req.user.uid]);

    res.json({ success: true, weapons });
  } catch (error) {
    console.error('Error fetching weapons:', error);
    res.status(500).json({ success: false, error: 'Ошибка загрузки оружия' });
  }
});
app.get('/api/mvd/calls', authenticate, async (req, res) => {
  try {
    const [calls] = await pool.query(`
      SELECT 
        ec.*,
        CONCAT(up.last_name, ' ', up.first_name) as officer_name,
        up.rank as officer_rank,
        up.badge_number as officer_badge
      FROM emergency_calls ec
      LEFT JOIN user_profiles up ON ec.assigned_officer = up.user_id
      WHERE ec.emergency_type IN ('police', 'fire', 'other')
      ORDER BY ec.call_time DESC
      LIMIT 100
    `);
    
    res.json({ success: true, calls });
  } catch (error) {
    console.error('MVD calls error:', error);
    res.status(500).json({ success: false, error: 'Ошибка загрузки вызовов' });
  }
});

// Принятие вызова сотрудником МВД
app.put('/api/mvd/calls/:id/assign', authenticate, async (req, res) => {
  try {
    await pool.query(
      `UPDATE emergency_calls 
       SET status = 'in_progress',
           assigned_officer = ?,
           response_time = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [req.user.id, req.params.id]
    );

    // Добавляем системное сообщение
    const [profile] = await pool.query(
      `SELECT first_name, last_name, rank FROM user_profiles WHERE user_id = ?`,
      [req.user.id]
    );
    
    const officerName = profile.length > 0 
      ? `${profile[0].rank} ${profile[0].last_name} ${profile[0].first_name}`
      : 'Сотрудник';

    await pool.query(
      `INSERT INTO emergency_call_messages 
       (call_id, user_id, message, is_system) 
       VALUES (?, ?, ?, TRUE)`,
      [
        req.params.id, 
        req.user.id,
        `${officerName} принял вызов и направляется к месту происшествия`
      ]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Ошибка назначения' });
  }
});

// Система чата для вызова
app.get('/api/mvd/calls/:id', authenticate, async (req, res) => {
  try {
    // Основная информация о вызове
    const [call] = await pool.query(`
      SELECT 
        ec.*,
        CONCAT(up.last_name, ' ', up.first_name) as officer_name,
        up.rank as officer_rank,
        up.badge_number as officer_badge
      FROM emergency_calls ec
      LEFT JOIN user_profiles up ON ec.assigned_officer = up.user_id
      WHERE ec.id = ?
    `, [req.params.id]);

    if (call.length === 0) {
      return res.status(404).json({ success: false, error: 'Вызов не найден' });
    }

    // Сообщения по вызову
    const [messages] = await pool.query(`
      SELECT 
        ecm.*,
        u.email as user_email,
        CONCAT(up.first_name, ' ', up.last_name) as user_name,
        up.rank as user_rank
      FROM emergency_call_messages ecm
      JOIN users u ON ecm.user_id = u.id
      LEFT JOIN user_profiles up ON ecm.user_id = up.user_id
      WHERE ecm.call_id = ?
      ORDER BY ecm.created_at ASC
    `, [req.params.id]);

    // Отчеты по вызову
    const [reports] = await pool.query(`
      SELECT 
        ecr.*,
        CONCAT(up.first_name, ' ', up.last_name) as officer_name,
        up.rank as officer_rank
      FROM emergency_call_reports ecr
      JOIN user_profiles up ON ecr.officer_id = up.user_id
      WHERE ecr.call_id = ?
      ORDER BY ecr.created_at DESC
    `, [req.params.id]);

    res.json({ 
      success: true,
      call: call[0],
      messages,
      reports
    });
  } catch (error) {
    console.error('Get call details error:', error);
    res.status(500).json({ success: false, error: 'Ошибка загрузки вызова' });
  }
});
app.get('/api/mvd/reports', authenticate, async (req, res) => {
  try {
    // Проверка соединения с базой данных
    const [connectionCheck] = await pool.query('SELECT 1');
    if (!connectionCheck) {
      return res.status(500).json({ 
        success: false, 
        error: 'Ошибка подключения к базе данных' 
      });
    }

    // Получаем отчёты из базы данных
    const [reports] = await pool.query(`
      SELECT 
        ecr.id,
        ecr.call_id,
        ecr.officer_id,
        ecr.report_data,
        ecr.created_at,
        ec.emergency_type,
        ec.address,
        CONCAT(up.first_name, ' ', up.last_name) as officer_name,
        up.rank as officer_rank
      FROM emergency_call_reports ecr
      JOIN emergency_calls ec ON ecr.call_id = ec.id
      JOIN user_profiles up ON ecr.officer_id = up.user_id
      ORDER BY ecr.created_at DESC
    `);

    // Обрабатываем и проверяем данные
    const processedReports = reports.map(report => {
      try {
        return {
          ...report,
          report_data: report.report_data ? JSON.parse(report.report_data) : null
        };
      } catch (parseError) {
        console.error('Error parsing report data:', parseError);
        return {
          ...report,
          report_data: null,
          parse_error: 'Ошибка обработки данных отчёта'
        };
      }
    });

    res.json({ 
      success: true, 
      reports: processedReports
    });

  } catch (error) {
    console.error('Error fetching reports:', error);
    
    // Определяем тип ошибки для более информативного ответа
    let errorMessage = 'Ошибка загрузки отчетов';
    if (error.code === 'ER_NO_SUCH_TABLE') {
      errorMessage = 'Ошибка: Таблицы не существуют в базе данных';
    } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      errorMessage = 'Ошибка доступа к базе данных';
    }

    res.status(500).json({ 
      success: false, 
      error: errorMessage,
      // В development режиме можно показать больше деталей
      details: process.env.NODE_ENV === 'development' ? {
        message: error.message,
        stack: error.stack
      } : undefined
    });
  }
});
app.post('/api/mvd/calls/:id/messages', authenticate, upload.single('photo'), async (req, res) => {
  try {
    const { message } = req.body;
    const photoUrl = req.file ? `/uploads/calls/${req.file.filename}` : null;

    await pool.query(
      `INSERT INTO emergency_call_messages 
       (call_id, user_id, message, photo_url) 
       VALUES (?, ?, ?, ?)`,
      [req.params.id, req.user.id, message, photoUrl]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Ошибка отправки сообщения' });
  }
});

// Завершение вызова с отчетом
app.post('/api/mvd/calls/:id/complete', authenticate, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.query('START TRANSACTION');

    // 1. Валидация входных данных
    const { 
      actions_taken, 
      victims = '[]', 
      suspects = '[]', 
      evidence = '[]', 
      conclusion 
    } = req.body;

    if (!actions_taken || !conclusion) {
      throw new Error('Не заполнены обязательные поля: actions_taken и conclusion');
    }

    // 2. Подготовка данных отчета
    const reportData = {
      actions: actions_taken.trim(),
      victims: safeJsonParse(victims),
      suspects: safeJsonParse(suspects),
      evidence: safeJsonParse(evidence),
      conclusion: conclusion.trim(),
      officer: {
        id: req.user.id,
        name: req.user.name,
        rank: req.user.rank
      },
      completion_time: new Date()
    };

    // 3. Проверка существования вызова
    const [call] = await connection.query(
      `SELECT id FROM emergency_calls 
       WHERE id = ? AND status != 'completed' FOR UPDATE`,
      [req.params.id]
    );

    if (!call.length) {
      throw new Error('Вызов не найден или уже завершен');
    }

    // 4. Сохранение отчета
    const [reportResult] = await connection.query(
      `INSERT INTO emergency_call_reports 
       (call_id, officer_id, report_type, report_data) 
       VALUES (?, ?, 'completion', ?)`,
      [req.params.id, req.user.id, JSON.stringify(reportData)]
    );

    // 5. Обновление статуса вызова
    await connection.query(
      `UPDATE emergency_calls 
       SET status = 'completed',
           completion_time = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [reportData.completion_time, req.params.id]
    );

    // 6. Системное уведомление
    await connection.query(
      `INSERT INTO emergency_call_messages 
       (call_id, user_id, message, is_system) 
       VALUES (?, ?, ?, TRUE)`,
      [
        req.params.id, 
        req.user.id,
        `Вызов #${req.params.id} завершен. Отчет #${reportResult.insertId} составлен.`
      ]
    );

    await connection.query('COMMIT');
    
    res.json({ 
      success: true,
      reportId: reportResult.insertId
    });

  } catch (error) {
    await connection.query('ROLLBACK');
    
    console.error('Complete call error:', error);
    
    const statusCode = error.message.includes('не заполнены') ? 400 : 500;
    
    res.status(statusCode).json({ 
      success: false, 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    connection.release();
  }
});
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return [];
  }
}
// Добавление нового оружия
app.post('/api/gosuslugi/weapons', authenticate, async (req, res) => {
  try {
    const { citizen_id, type, model, serial_number } = req.body;
    
    const [result] = await pool.query(
      `INSERT INTO weapons SET ?`, {
        user_id: req.user.uid,
        citizen_id,
        type,
        model,
        serial_number,
        registration_date: new Date().toISOString().split('T')[0]
      }
    );

    res.json({ success: true, weaponId: result.insertId });
  } catch (error) {
    console.error('Error adding weapon:', error);
    res.status(500).json({ success: false, error: 'Ошибка добавления оружия' });
  }
});

    app.post('/api/admin/users/:id/ban', authenticate, adminOnly, async (req, res) => {
      try {
        const { is_banned, ban_reason } = req.body;
        
        await pool.query(
          `UPDATE users SET is_banned = ?, ban_reason = ? WHERE id = ?`,
          [is_banned, is_banned ? ban_reason : null, req.params.id]
        );

        await createNotification(
          req.params.id,
          is_banned 
            ? `Ваш аккаунт заблокирован. Причина: ${ban_reason || 'не указана'}`
            : 'Ваш аккаунт разблокирован',
          NOTIFICATION_TYPES.BAN
        );

        const [updatedUser] = await pool.query(
          `SELECT id, email, name, is_banned, ban_reason FROM users WHERE id = ?`,
          [req.params.id]
        );

        res.json({ success: true, user: updatedUser[0] });
      } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to update ban status' });
      }
    });

    // Application routes
    app.post('/api/applications', authenticate, async (req, res) => {
      try {
        const { title, description, firstName, lastName, gender, department, birthDate, about, socialLinks } = req.body;
        
        if (!title || !description || !firstName || !lastName || !gender || !department || !birthDate || !about) {
          return res.status(400).json({ success: false, error: 'All required fields must be filled' });
        }

        const [result] = await pool.query(
          `INSERT INTO applications (
            user_id, title, description, first_name, last_name, 
            gender, department, birth_date, about, social_links
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.user.id, title, description, firstName, lastName, gender, department, birthDate, about, socialLinks || null]
        );
        
        const [application] = await pool.query(
          `SELECT a.*, u.name as user_name, u.email as user_email
           FROM applications a JOIN users u ON a.user_id = u.id
           WHERE a.id = ?`,
          [result.insertId]
        );

        res.json({ success: true, application: application[0] });
      } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to create application' });
      }
    });

    app.get('/api/applications/my', authenticate, async (req, res) => {
      try {
        const [applications] = await pool.query(
          `SELECT a.*, u.name as user_name, u.email as user_email
           FROM applications a JOIN users u ON a.user_id = u.id
           WHERE a.user_id = ?
           ORDER BY a.created_at DESC`,
          [req.user.id]
        );
        
        res.json({ success: true, applications });
      } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch applications' });
      }
    });

    app.get('/api/admin/applications', authenticate, adminOnly, async (req, res) => {
      try {
        const [applications] = await pool.query(
          `SELECT a.*, u.name as user_name, u.email as user_email
           FROM applications a JOIN users u ON a.user_id = u.id
           ORDER BY a.created_at DESC`
        );
        
        res.json({ success: true, applications });
      } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch applications' });
      }
    });

    app.get('/api/admin/applications/:id', authenticate, async (req, res) => {
      try {
        const [application] = await pool.query(
          `SELECT 
            a.id, a.title, a.description, a.first_name, a.last_name,
            a.gender, a.department, DATE_FORMAT(a.birth_date, '%Y-%m-%d') as birth_date,
            a.about, a.social_links, a.status, a.rejection_reason,
            a.created_at, a.updated_at,
            u.id as user_id, u.name as user_name, u.email as user_email, u.avatar as user_avatar
           FROM applications a JOIN users u ON a.user_id = u.id
           WHERE a.id = ?`,
          [req.params.id]
        );
        
        if (application.length === 0) {
          return res.status(404).json({ 
            success: false, 
            error: 'Application not found'
          });
        }
        
        const appData = application[0];
        const response = {
          success: true,
          application: {
            id: appData.id,
            title: appData.title,
            description: appData.description,
            status: appData.status,
            rejection_reason: appData.rejection_reason,
            created_at: appData.created_at,
            updated_at: appData.updated_at,
            personal_info: {
              first_name: appData.first_name,
              last_name: appData.last_name,
              full_name: `${appData.first_name} ${appData.last_name}`,
              gender: appData.gender,
              gender_display: appData.gender === 'male' ? 'Мужской' : 'Женский',
              department: appData.department,
              birth_date: appData.birth_date,
              about: appData.about,
              social_links: appData.social_links ? appData.social_links.split(',') : []
            },
            user: {
              id: appData.user_id,
              name: appData.user_name,
              email: appData.user_email,
              avatar: appData.user_avatar
            }
          }
        };

        res.json(response);
      } catch (error) {
        res.status(500).json({ 
          success: false, 
          error: 'Failed to fetch application'
        });
      }
    });
app.post('/api/emergency/calls', authenticate, async (req, res) => {
  try {
    const { emergency_type, address, description, caller_name, caller_phone } = req.body;
    
    const [result] = await pool.query(
      `INSERT INTO emergency_calls SET ?`,
      {
        user_id: req.user.uid,
        emergency_type,
        address,
        description,
        caller_name,
        caller_phone,
        call_time: new Date().toISOString().slice(0, 19).replace('T', ' '),
        status: 'sent' // Добавляем статус по умолчанию
      }
    );

    res.json({ success: true, callId: result.insertId });
  } catch (error) {
    console.error('Error saving emergency call:', error);
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});
   app.put('/api/admin/applications/:id', authenticate, adminOnly, async (req, res) => {
  try {
    const { status, rejection_reason } = req.body;
    
    // Валидация статуса
    const allowedStatuses = ['pending', 'approved', 'rejected'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Недопустимое значение статуса' 
      });
    }

    // Получаем текущую заявку
    const [currentApp] = await pool.query(
      `SELECT user_id FROM applications WHERE id = ?`,
      [req.params.id]
    );
    
    if (currentApp.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Заявка не найдена' 
      });
    }

    // Обновляем заявку
    await pool.query(
      `UPDATE applications 
       SET status = ?, 
           rejection_reason = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        status, 
        status === 'rejected' ? rejection_reason || 'Причина не указана' : null, 
        req.params.id
      ]
    );

    // Получаем обновлённую заявку
    const [updatedApp] = await pool.query(
      `SELECT a.*, u.name as user_name, u.email as user_email
       FROM applications a
       JOIN users u ON a.user_id = u.id
       WHERE a.id = ?`,
      [req.params.id]
    );

    // Создаем уведомление для пользователя
    let notificationMessage = '';
    if (status === 'approved') {
      notificationMessage = `Ваша заявка "${updatedApp[0].title}" была одобрена`;
    } else if (status === 'rejected') {
      notificationMessage = `Ваша заявка "${updatedApp[0].title}" была отклонена. Причина: ${rejection_reason || 'не указана'}`;
    } else {
      notificationMessage = `Статус вашей заявки "${updatedApp[0].title}" изменен на "На рассмотрении"`;
    }

    await createNotification(
      currentApp[0].user_id,
      notificationMessage,
      NOTIFICATION_TYPES.APPLICATION_UPDATE
    );

    res.json({ 
      success: true, 
      application: updatedApp[0],
      message: `Статус заявки успешно изменен на "${status}"`
    });

  } catch (error) {
    console.error('Ошибка при обновлении заявки:', {
      message: error.message,
      stack: error.stack,
      params: req.params,
      body: req.body
    });
    
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка сервера при обновлении заявки',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});
app.delete('/api/gosuslugi/citizens/:id', authenticate, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM citizens WHERE id = ?', [req.params.id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Гражданин не найден' });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка удаления гражданина:', error);
    res.status(500).json({ success: false, error: 'Ошибка сервера при удалении гражданина' });
  }
});

// Удаление транспортного средства
app.delete('/api/gosuslugi/vehicles/:id', authenticate, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM vehicles WHERE id = ?', [req.params.id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Транспортное средство не найдено' });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка удаления ТС:', error);
    res.status(500).json({ success: false, error: 'Ошибка сервера при удалении ТС' });
  }
});
app.get('/api/gosuslugi/citizens/:id', authenticate, async (req, res) => {
  try {
    // Проверяем аутентификацию (middleware уже сделал это)
    if (!req.user) {
      return res.status(401).json({ 
        success: false, 
        error: 'Требуется авторизация. Пожалуйста, войдите в систему.'
      });
    }

    const [citizen] = await pool.query(`
      SELECT c.*, 
        (SELECT cp.photo_path FROM citizen_photos cp WHERE cp.citizen_id = c.id LIMIT 1) as photo
      FROM citizens c
      WHERE c.id = ?
    `, [req.params.id]);

    if (!citizen.length) {
      return res.status(404).json({ error: 'Гражданин не найден' });
    }

    res.json({
      ...citizen[0],
      photo: citizen[0].photo || null
    });

  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Внутренняя ошибка сервера' 
    });
  }
});
app.post('/api/gosuslugi/citizens/:id/photo', authenticate, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      throw new Error('Файл не был загружен');
    }

    const photoUrl = `/uploads/citizens/${req.file.filename}`;
    
    // Используем новую таблицу
    await pool.query(
      `INSERT INTO citizen_photos (citizen_id, photo_path)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE photo_path = VALUES(photo_path)`,
      [req.params.id, photoUrl]
    );

    res.json({ 
      success: true, 
      photoUrl: photoUrl 
    });
  } catch (error) {
    console.error('Ошибка загрузки фото:', error);
    res.status(400).json({ 
      success: false, 
      error: error.message 
    });
  }
});
    // News routes
    app.get('/api/news', async (req, res) => {
      try {
        const [news] = await pool.query(`
          SELECT n.*, u.name as author_name 
          FROM news n JOIN users u ON n.author_id = u.id
          WHERE n.is_published = TRUE
          ORDER BY n.created_at DESC LIMIT 100
        `);
        res.json({ success: true, news });
      } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch news' });
      }
    });

    app.post('/api/gosuslugi/citizens', authenticate, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    
    const {
      first_name, last_name, middle_name, gender, 
      birth_date, birth_place, passport_issued_by,
      passport_issue_date, passport_department_code,
      registrations, driver_license
    } = req.body;
      if (!registrations || !registrations.length || !registrations[0].address) {
      throw new Error('Адрес прописки обязателен');
    }

    // Генерация паспортных данных
    const passport_series = Math.floor(1000 + Math.random() * 9000).toString();
    const passport_number = Math.floor(100000 + Math.random() * 900000).toString();

    // Создаем гражданина
     const [citizenResult] = await connection.query(
      `INSERT INTO citizens SET ?`, {
        first_name, last_name, middle_name, gender,
        birth_date, birth_place, 
        passport_series: Math.floor(1000 + Math.random() * 9000).toString(),
        passport_number: Math.floor(100000 + Math.random() * 900000).toString(),
        passport_issued_by, passport_issue_date, passport_department_code,
        user_id: req.user.id // Привязываем к текущему пользователю
      }
    );

    // Добавляем прописку
    await connection.query(
      `INSERT INTO registrations SET ?`, {
        citizen_id: citizenResult.insertId,
        address: registrations[0].address,
        is_main: true,
        registration_date: registrations[0].registration_date || new Date().toISOString().split('T')[0]
      }
    );

    // Добавляем водительские права (если есть категории)
   if (driver_license && driver_license.has_license) {
      const license_number = 'РФ' + Math.floor(1000000 + Math.random() * 9000000);
      await connection.query(
        `INSERT INTO driver_licenses SET ?`, {
          citizen_id: citizenResult.insertId,
          license_number,
          categories: driver_license.categories.join(','), // Используем categories из driver_license
          issue_date: driver_license.issue_date || new Date().toISOString().split('T')[0],
          expiration_date: driver_license.expiration_date || 
            new Date(new Date().setFullYear(new Date().getFullYear() + 10)).toISOString().split('T')[0]
        }
      );
    }

     await connection.commit();
    res.json({ success: true, citizen_id: citizenResult.insertId });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating citizen:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при создании гражданина'
    });
  } finally {
    connection.release();
  }
});
// Выдача прав гражданину
app.post('/api/gosuslugi/citizens/:id/license', authenticate, async (req, res) => {
  try {
    const { categories } = req.body;
    
    // Проверяем существование гражданина
    const [citizen] = await pool.query('SELECT id FROM citizens WHERE id = ?', [req.params.id]);
    if (!citizen.length) {
      return res.status(404).json({ success: false, error: 'Гражданин не найден' });
    }

    // Обновляем или создаем права
    await pool.query(
      `INSERT INTO driver_licenses (citizen_id, license_number, categories, issue_date, expiration_date)
       VALUES (?, ?, ?, CURRENT_DATE, DATE_ADD(CURRENT_DATE, INTERVAL 10 YEAR))
       ON DUPLICATE KEY UPDATE 
         categories = VALUES(categories),
         issue_date = VALUES(issue_date),
         expiration_date = VALUES(expiration_date)`,
      [
        req.params.id,
        generateDriverLicenseNumber(), // Используем функцию генерации номера
        categories.join(',') // Сохраняем категории через запятую
      ]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка при выдаче прав:', error);
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});
app.post('/api/gosuslugi/vehicles', authenticate, async (req, res) => {
  try {
    const {
      owner_id, brand, model, year, color,
      plate_number, vin, engine_number
    } = req.body;

    const [result] = await pool.query(
      `INSERT INTO vehicles SET ?`, {
        owner_id,
        user_id: req.user.uid,
        brand, 
        model, 
        year, 
        color,
        plate_number, 
        vin, 
        engine_number,
        registration_date: new Date().toISOString().split('T')[0]
      }
    );

    res.json({ success: true, vehicle_id: result.insertId });
  } catch (error) {
    console.error('Error creating vehicle:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при создании автомобиля',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});
    app.get('/api/admin/news', authenticate, adminOnly, async (req, res) => {
      try {
        const [news] = await pool.query(`
          SELECT n.*, u.name as author_name 
          FROM news n JOIN users u ON n.author_id = u.id
          ORDER BY n.created_at DESC
        `);
        res.json({ success: true, news });
      } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch news' });
      }
    });

    app.post('/api/admin/news', authenticate, adminOnly, async (req, res) => {
      try {
        const { title, content, image_url } = req.body;
        
        if (!title || !content) {
          return res.status(400).json({ success: false, error: 'Title and content are required' });
        }

        const [result] = await pool.query(
          `INSERT INTO news (title, content, author_id, image_url) VALUES (?, ?, ?, ?)`,
          [title, content, req.user.id, image_url || null]
        );
        
        const [newNews] = await pool.query(`
          SELECT n.*, u.name as author_name 
          FROM news n JOIN users u ON n.author_id = u.id
          WHERE n.id = ?
        `, [result.insertId]);
        
        res.json({ success: true, news: newNews[0] });
      } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to create news' });
      }
    });
   app.get('/api/gosuslugi/citizens', authenticate, async (req, res) => {
  try {
    const [citizens] = await pool.query(`
      SELECT 
        c.*,
        (SELECT r.address FROM registrations r WHERE r.citizen_id = c.id AND r.is_main = 1 LIMIT 1) as main_address,
        (SELECT dl.categories FROM driver_licenses dl WHERE dl.citizen_id = c.id LIMIT 1) as license_categories
      FROM citizens c
      WHERE c.user_id = ?
      ORDER BY c.last_name, c.first_name
    `, [req.user.id]);
    
    res.json(citizens.map(c => ({
      ...c,
      photoUrl: c.photo ? `${process.env.BASE_URL || 'http://localhost:5000'}${c.photo}` : null
    })));
  } catch (error) {
    console.error('Error fetching citizens:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Проверка владельца перед операциями
const checkCitizenOwnership = async (req, res, next) => {
  try {
    const [citizen] = await pool.query(
      'SELECT user_id FROM citizens WHERE id = ?', 
      [req.params.id]
    );
    
    if (citizen.length === 0) {
      return res.status(404).json({ error: 'Гражданин не найден' });
    }
    
    if (citizen[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }
    
    next();
  } catch (error) {
    console.error('Ownership check error:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
};
// Роуты для работы с разрешениями
app.post('/api/gosuslugi/weapon-licenses', authenticate, async (req, res) => {
  try {
    const { citizen_id, license_type, weapon_type, weapon_model, weapon_serial, categories } = req.body;
    
    // Генерируем серийный номер, если он не предоставлен
    const serialNumber = weapon_serial || generateWeaponSerialNumber(weapon_type);
    
    const [result] = await pool.query(
      `INSERT INTO weapon_licenses SET ?`, {
        user_id: req.user.uid,
        citizen_id,
        license_type,
        weapon_type,
        weapon_model,
        weapon_serial: serialNumber,
        categories: Array.isArray(categories) ? categories.join(',') : categories,
        status: 'pending',
        application_date: new Date().toISOString().slice(0, 19).replace('T', ' ')
      }
    );

    res.json({ 
      success: true, 
      licenseId: result.insertId,
      weapon_serial: serialNumber // Возвращаем клиенту использованный серийный номер
    });
  } catch (error) {
    console.error('Error creating weapon license:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при создании заявки',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});
app.get('/api/gosuslugi/rejected-licenses', authenticate, async (req, res) => {
  try {
    const [licenses] = await pool.query(`
      SELECT 
        wl.*,
        CONCAT(c.last_name, ' ', c.first_name) as citizen_name,
        c.passport_series, c.passport_number
      FROM weapon_licenses wl
      JOIN citizens c ON wl.citizen_id = c.id
      WHERE wl.user_id = ? AND wl.status = 'rejected' AND wl.license_type = 'РОХА'
      ORDER BY wl.decision_date DESC
    `, [req.user.uid]);

    res.json({ success: true, licenses });
  } catch (error) {
    console.error('Error fetching rejected licenses:', error);
    res.status(500).json({ success: false, error: 'Ошибка загрузки отклоненных заявок' });
  }
});
app.get('/api/scuo/weapons', authenticate, async (req, res) => {
  try {
    const [weapons] = await pool.query(`
      SELECT 
        w.*,
        CONCAT(c.last_name, ' ', c.first_name) as owner_name,
        c.passport_series,
        c.passport_number
      FROM weapons w
      JOIN citizens c ON w.citizen_id = c.id
      ORDER BY w.registration_date DESC
    `);
    
    res.json(weapons);
  } catch (error) {
    console.error('SCUO weapons error:', error);
    res.status(500).json({ error: 'Ошибка загрузки реестра оружия' });
  }
});

// Добавление оружия в реестр
app.post('/api/scuo/weapons', authenticate, async (req, res) => {
  try {
    const { citizen_id, type, model, serial_number } = req.body;
    
    const [result] = await pool.query(
      `INSERT INTO weapons SET ?`, {
        citizen_id,
        type,
        model,
        serial_number,
        registration_date: new Date(),
        status: 'active'
      }
    );

    res.json({ id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка регистрации оружия' });
  }
});
app.get('/api/scuo/registry', authenticate, async (req, res) => {
  try {
    const [weapons] = await pool.query(`
      SELECT 
        w.*,
        CONCAT(c.last_name, ' ', c.first_name) as owner_name,
        c.passport_series,
        c.passport_number,
        wl.license_type,
        wl.status as license_status,
        wl.issue_date,
        wl.expiration_date
      FROM weapons w
      JOIN citizens c ON w.citizen_id = c.id
      LEFT JOIN weapon_licenses wl ON w.id = wl.weapon_id
      ORDER BY w.registration_date DESC
    `);
    
    res.json(weapons);
  } catch (error) {
    console.error('SCUO registry error:', error);
    res.status(500).json({ error: 'Ошибка загрузки реестра' });
  }
});

// Получение заявок на лицензии для SCUO
app.get('/api/scuo/license-applications', authenticate, adminOnly, async (req, res) => {
  try {
    const [applications] = await pool.query(`
      SELECT 
        wl.*,
        CONCAT(c.last_name, ' ', c.first_name) as citizen_name,
        c.passport_series, c.passport_number,
        u.email as user_email
      FROM weapon_licenses wl
      JOIN citizens c ON wl.citizen_id = c.id
      JOIN users u ON wl.user_id = u.auth_uid
      WHERE wl.status = 'pending'
      ORDER BY wl.application_date DESC
    `);

    res.json({ success: true, applications });
  } catch (error) {
    console.error('SCUO applications error:', error);
    res.status(500).json({ success: false, error: 'Ошибка загрузки заявок' });
  }
});
// Обновление статуса лицензии (для SCUO)
app.put('/api/scuo/license-applications/:id', authenticate, adminOnly, async (req, res) => {
  try {
    const { status, rejection_reason, officer_notes } = req.body;
    
    await pool.query('START TRANSACTION');

    // Обновляем лицензию
    await pool.query(
      `UPDATE weapon_licenses 
       SET status = ?,
           rejection_reason = ?,
           officer_notes = ?,
           decision_date = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, rejection_reason, officer_notes, req.params.id]
    );

    // Если одобрено - регистрируем оружие
    if (status === 'approved') {
      const [license] = await pool.query(
        'SELECT * FROM weapon_licenses WHERE id = ?', 
        [req.params.id]
      );
      
      if (license.length > 0) {
        await pool.query(
          `INSERT INTO weapons SET ?`, {
            license_id: req.params.id,
            user_id: license[0].user_id,
            citizen_id: license[0].citizen_id,
            type: license[0].weapon_type,
            model: license[0].weapon_model,
            serial_number: license[0].weapon_serial,
            registration_date: new Date(),
            status: 'active'
          }
        );
      }
    }

    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('SCUO update error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка обработки заявки',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});
function generateWeaponSerialNumber(weaponType) {
  const letters = 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ';
  const isRifled = ['Карабин', 'Винтовка', 'Пистолет', 'Револьвер'].some(type => weaponType.includes(type));
  
  // Генерация буквенной части
  const letterPart = 
    letters.charAt(Math.floor(Math.random() * letters.length)) +
    letters.charAt(Math.floor(Math.random() * letters.length));
  
  // Генерация цифровой части
  const digitCount = isRifled ? 7 : 6; // 7 цифр для нарезного, 6 для гладкоствольного
  let digitPart = '';
  for (let i = 0; i < digitCount; i++) {
    digitPart += Math.floor(Math.random() * 10);
  }
  
  return `${letterPart}-${digitPart}`;
}
app.get('/api/gibdd/vehicles/:plate', authenticate, async (req, res) => {
  try {
    const plateNumber = req.params.plate.toUpperCase().replace(/\s/g, '');
    
    const [vehicles] = await pool.query(`
      SELECT 
        v.*,
        CONCAT(c.last_name, ' ', c.first_name, ' ', COALESCE(c.middle_name, '')) as owner_name,
        c.birth_date
      FROM vehicles v
      JOIN citizens c ON v.owner_id = c.id
      WHERE v.plate_number = ?
      LIMIT 1
    `, [plateNumber]);

    if (vehicles.length === 0) {
      // Логирование при отсутствии ТС
      await pool.query(`
        INSERT INTO gibdd_search_logs 
        (user_id, search_type, search_query, search_result, result_details)
        VALUES (?, 'vehicle', ?, 'not_found', 'ТС не найдено')
      `, [req.user.uid, plateNumber]);
      
      return res.status(404).json({ success: false, error: 'Транспортное средство не найдено' });
    }

    const vehicle = vehicles[0];
    
    const [violations] = await pool.query(`
      SELECT 
        v.*,
        up.rank as officer_rank,
        up.badge_number as officer_badge
      FROM violations v
      LEFT JOIN user_profiles up ON v.officer_id = up.user_id
      WHERE v.vehicle_id = ?
      ORDER BY v.date_time DESC
    `, [vehicle.id]);

    // Логирование успешного запроса
    await pool.query(`
      INSERT INTO gibdd_search_logs 
      (user_id, search_type, search_query, search_result, result_details)
      VALUES (?, 'vehicle', ?, 'success', ?)
    `, [
      req.user.uid, 
      plateNumber,
      `Найдено ТС: ${vehicle.make} ${vehicle.model}, владелец: ${vehicle.owner_name}`
    ]);
    
    res.json({
      success: true,
      vehicle: {
        id: vehicle.id,
        plateNumber: vehicle.plate_number,
        make: vehicle.make,
        model: vehicle.model,
        vin: vehicle.vin,
        ownerName: vehicle.owner_name,
        birthDate: vehicle.birth_date,
        insuranceValid: vehicle.insurance_valid,
        inspectionValid: vehicle.inspection_valid,
        violations: violations.map(v => ({
          id: v.id,
          article: v.article,
          description: v.description,
          fineAmount: v.fine_amount,
          location: v.location,
          dateTime: v.date_time,
          circumstances: v.circumstances,
          evidence: v.evidence,
          officerName: v.officer_name,
          officerRank: v.officer_rank,
          officerBadge: v.officer_badge,
          department: v.department,
          sentToGosuslugi: v.sent_to_gosuslugi,
          sentDate: v.sent_date
        }))
      }
    });
  } catch (error) {
    // Логирование ошибки
    await pool.query(`
      INSERT INTO gibdd_search_logs 
      (user_id, search_type, search_query, search_result, result_details)
      VALUES (?, 'vehicle', ?, 'error', ?)
    `, [req.user.uid, req.params.plate, error.message]);
    
    console.error('Vehicle check error:', error);
    res.status(500).json({ success: false, error: 'Ошибка проверки транспортного средства' });
  }
});
app.get('/api/gosuslugi/citizens/:id/has-weapon-license', authenticate, async (req, res) => {
  try {
    const [result] = await pool.query(
      `SELECT 1 FROM weapon_licenses 
       WHERE citizen_id = ? AND status = 'approved' LIMIT 1`,
      [req.params.id]
    );
    
    res.json({ hasLicense: result.length > 0 });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Ошибка проверки лицензии' });
  }
});
app.get('/api/gosuslugi/citizens/:id/license-check', authenticate, async (req, res) => {
  try {
    const [license] = await pool.query(
      `SELECT 1 FROM weapon_licenses 
       WHERE citizen_id = ? AND status = 'approved' LIMIT 1`,
      [req.params.id]
    );
    
    res.json({ hasLicense: license.length > 0 });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Ошибка проверки' });
  }
});
// Изъятие оружия
app.put('/api/scuo/weapons/:id/seize', authenticate, async (req, res) => {
  try {
    const { reason } = req.body;
    
    await pool.query(
      `UPDATE weapons SET 
        status = 'seized',
        seizure_reason = ?,
        seizure_date = NOW()
       WHERE id = ?`,
      [reason, req.params.id]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка изъятия оружия' });
  }
});
app.put('/api/gosuslugi/weapon-licenses/:id', authenticate, async (req, res) => {
  try {
    const { status, rejection_reason, officer_notes } = req.body;
    
    await pool.query(
      `UPDATE weapon_licenses SET 
        status = ?,
        rejection_reason = ?,
        officer_notes = ?,
        decision_date = ${status !== 'pending' ? 'NOW()' : 'NULL'}
       WHERE id = ?`,
      [status, rejection_reason, officer_notes, req.params.id]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});
app.get('/api/gosuslugi/weapon-licenses', authenticate, async (req, res) => {
  try {
    let query = `
      SELECT wl.*, 
        CONCAT(c.last_name, ' ', c.first_name) as citizen_name,
        c.passport_series, c.passport_number,
        u.auth_uid as user_id
      FROM weapon_licenses wl
      JOIN citizens c ON wl.citizen_id = c.id
      JOIN users u ON wl.user_id = u.id
    `;
    
    // Для обычных пользователей показываем только их заявки
    if (!req.user.isAdmin) {
      query += ` WHERE wl.user_id = ?`;
    }
    
    query += ` ORDER BY wl.application_date DESC`;
    
    const [licenses] = await pool.query(query, req.user.isAdmin ? [] : [req.user.id]);
    
    res.json(licenses);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});


// Роуты для админов (МВД)
app.get('/api/admin/weapon-licenses', authenticate, adminOnly, async (req, res) => {
  try {
    const [licenses] = await pool.query(`
      SELECT wl.*, 
        CONCAT(c.last_name, ' ', c.first_name) as citizen_name,
        c.passport_series, c.passport_number,
        u.email as user_email
      FROM weapon_licenses wl
      JOIN citizens c ON wl.citizen_id = c.id
      JOIN users u ON wl.user_id = u.auth_uid
      ORDER BY wl.application_date DESC
    `);

    res.json({ success: true, licenses });
  } catch (error) {
    console.error('Error fetching weapon licenses:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при получении списка разрешений' 
    });
  }
});

app.put('/api/admin/weapon-licenses/:id', authenticate, adminOnly, async (req, res) => {
  try {
    const { status, rejection_reason, officer_notes } = req.body;
    
    const updateData = { status };
    if (status === 'approved') {
      updateData.issue_date = new Date().toISOString().split('T')[0];
      updateData.expiration_date = new Date(new Date().setFullYear(new Date().getFullYear() + 5)).toISOString().split('T')[0];
    }
    if (rejection_reason) updateData.rejection_reason = rejection_reason;
    if (officer_notes) updateData.officer_notes = officer_notes;

    await pool.query(
      'UPDATE weapon_licenses SET ? WHERE id = ?',
      [updateData, req.params.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating weapon license:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при обновлении разрешения' 
    });
  }
});

// Получение списка транспортных средств
app.get('/api/gosuslugi/vehicles', authenticate, async (req, res) => {
  try {
    const [vehicles] = await pool.query(`
      SELECT 
        v.*,
        CONCAT(c.last_name, ' ', c.first_name) as owner_name
      FROM vehicles v
      JOIN citizens c ON v.owner_id = c.id
      WHERE v.user_id = ?
      ORDER BY v.brand, v.model
    `, [req.user.uid]);
    
    res.json({ success: true, vehicles });
  } catch (error) {
    console.error('Error fetching vehicles:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка загрузки транспортных средств' 
    });
  }
});

    // Admin access check
    app.get('/api/admin/check-access', authenticate, adminOnly, (req, res) => {
      res.json({ success: true, message: 'Admin access granted' });
    });

    // Logging middleware
    app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
      if (req.method === 'POST' || req.method === 'PUT') {
        console.log('Request body:', req.body);
      }
      next();
    });

    // Start server
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Admin emails: ${ADMIN_EMAILS.join(', ')}`);
    });
  })
  .catch(err => {
    console.error('❌ Ошибка подключения к MySQL:', err);
    process.exit(1);
  });