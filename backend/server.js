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
const TelegramBot = require('node-telegram-bot-api');
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
const config ={
    BOT_TOKEN: '8397535293:AAEsTk9RspKn6kOedJ-HpoNKkyZYH0DrpdM',
}
const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

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

    // Get user profile (исправленный запрос)
    const [profile] = await pool.query(
      `SELECT first_name, last_name, middle_name, \`rank\`, department, badge_number 
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

// Добавляем в существующий бекенд новые маршруты для поиска

// Модель данных для поиска
const SEARCH_TYPES = {
  CITIZEN: 'citizen',
  VEHICLE: 'vehicle',
  WEAPON: 'weapon',
  DOCUMENT: 'document'
};

// Логирование поисковых запросов
app.post('/api/search/log', authenticate, async (req, res) => {
  try {
    const { type, query, reason, comment, officer } = req.body;

    // Валидация входных данных
    if (!type || !query || !reason || !officer) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать type, query, reason и officer'
      });
    }

    // Проверяем тип поиска
    if (!Object.values(SEARCH_TYPES).includes(type)) {
      return res.status(400).json({
        success: false,
        error: `Недопустимый тип поиска. Допустимые значения: ${Object.values(SEARCH_TYPES).join(', ')}`
      });
    }

    // Получаем профиль сотрудника, если не передан
    let officerProfile = officer;
    if (!officerProfile) {
      const [profile] = await pool.query(
        `SELECT first_name, last_name, middle_name, \`rank\`, department, badge_number 
         FROM user_profiles 
         WHERE user_id = ?`,
        [req.user.id]
      );
      
      if (profile.length > 0) {
        officerProfile = {
          id: req.user.id,
          name: `${profile[0].last_name} ${profile[0].first_name} ${profile[0].middle_name || ''}`.trim(),
          rank: profile[0].rank,
          department: profile[0].department,
          badgeNumber: profile[0].badge_number
        };
      }
    }

    // Сохраняем лог поиска
    const [result] = await pool.query(
      `INSERT INTO search_logs SET ?`, {
        user_id: req.user.id,
        search_type: type,
        search_query: JSON.stringify(query),
        search_reason: reason,
        search_comment: comment || null,
        officer_data: JSON.stringify(officerProfile),
        timestamp: new Date()
      }
    );

    res.json({
      success: true,
      logId: result.insertId
    });
  } catch (error) {
    console.error('Search log error:', error);
    res.status(500).json({
      success: false,
      error: 'Ошибка при логировании поискового запроса'
    });
  }
});
app.put('/api/medical/calls/:callId/status', authenticate, async (req, res) => {
  try {
    const { callId } = req.params;
    const { status } = req.body;
    const validStatuses = ['accepted', 'on_scene', 'transporting', 'completed', 'cancelled'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Недопустимый статус' });
    }

    const [current] = await pool.query('SELECT status FROM ambulance_calls WHERE id = ?', [callId]);
    if (!current.length) return res.status(404).json({ error: 'Вызов не найден' });

    await pool.query('UPDATE ambulance_calls SET status = ? WHERE id = ?', [status, callId]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка обновления статуса:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/medical/calls/:callId/complete', authenticate, async (req, res) => {
  try {
    const { callId } = req.params;
    const { diagnosis, procedures, decision, notes } = req.body;

    // Обновляем статус вызова
    await pool.query('UPDATE ambulance_calls SET status = "completed" WHERE id = ?', [callId]);
    
    // Создаем медицинскую запись
    const [call] = await pool.query('SELECT patient_id FROM ambulance_calls WHERE id = ?', [callId]);
    const patientId = call[0].patient_id;

    if (!patientId) {
      return res.status(400).json({ error: 'Пациент не указан в вызове' });
    }

    await pool.query(`
      INSERT INTO medical_records 
        (patient_id, call_id, record_type, title, description)
      VALUES (?, ?, 'call_report', 'Отчет по вызову', ?)
    `, [patientId, callId, JSON.stringify({
      diagnosis,
      procedures,
      decision,
      notes
    })]);

    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка завершения вызова:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});
app.post('/api/medical/patients/search', authenticate, async (req, res) => {
  try {
    const { lastName, firstName, middleName, omsNumber, phone } = req.body;
    
    let query = `
      SELECT 
        p.id,
        p.last_name AS lastName,
        p.first_name AS firstName,
        p.middle_name AS middleName,
        p.birth_date AS birthDate,
        p.gender,
        p.oms_number AS omsNumber,
        p.phone,
        r.address,
        (SELECT COUNT(*) FROM ambulance_calls WHERE patient_id = p.id) AS callCount
      FROM patients p
      LEFT JOIN registrations r ON p.id = r.patient_id AND r.is_main = 1
      WHERE 1=1
    `;
    
    const params = [];
    
    if (lastName) {
      query += ' AND p.last_name LIKE ?';
      params.push(`%${lastName}%`);
    }
    
    if (firstName) {
      query += ' AND p.first_name LIKE ?';
      params.push(`%${firstName}%`);
    }
    
    if (middleName) {
      query += ' AND p.middle_name LIKE ?';
      params.push(`%${middleName}%`);
    }
    
    if (omsNumber) {
      query += ' AND p.oms_number = ?';
      params.push(omsNumber);
    }
    
    if (phone) {
      query += ' AND p.phone = ?';
      params.push(phone);
    }
    
    query += ' LIMIT 50';
    
    const [patients] = await pool.query(query, params);
    
    res.json({
      success: true,
      results: patients.map(p => ({
        ...p,
        birthDate: p.birthDate ? new Date(p.birthDate).toISOString() : null
      }))
    });
    
  } catch (error) {
    console.error('Ошибка поиска пациентов:', error);
    res.status(500).json({
      success: false,
      error: 'Ошибка при поиске пациентов'
    });
  }
});

app.post('/api/search/citizen', authenticate, async (req, res) => {
  try {
    let { lastName, firstName, middleName, birthDate, passport } = req.body;

    // Нормализация входных данных
    lastName = lastName ? lastName.trim() : '';
    firstName = firstName ? firstName.trim() : '';
    middleName = middleName ? middleName.trim() : '';

    if (!lastName || !firstName) {
      return res.status(400).json({
        success: false,
        error: 'Фамилия и имя являются обязательными полями'
      });
    }

    console.log('Нормализованные параметры поиска:', { lastName, firstName, middleName, birthDate, passport });

    // Базовый запрос
    let query = `
      SELECT 
        c.id,
        c.last_name,
        c.first_name,
        c.middle_name,
        c.birth_date,
        c.passport_series,
        c.passport_number,
        r.address,
        wp.id as wanted_id,
        wp.search_reason as wanted_reason,
        wp.crime_details as wanted_details,
        wp.photo_path as wanted_photo,
        CONCAT(up.last_name, ' ', up.first_name) as officer_name,
        up.rank as officer_rank,
        up.badge_number as officer_badge
      FROM citizens c
      LEFT JOIN registrations r ON c.id = r.citizen_id AND r.is_main = 1
      LEFT JOIN wanted_persons wp ON 1=1
      LEFT JOIN user_profiles up ON wp.created_by = up.user_id
      WHERE c.last_name LIKE ? 
        AND c.first_name LIKE ?
    `;

    const params = [
      `%${lastName}%`,
      `%${firstName}%`
    ];

    if (middleName) {
      query += ' AND c.middle_name LIKE ?';
      params.push(`%${middleName}%`);
    }

    if (birthDate) {
      query += ' AND c.birth_date = ?';
      params.push(birthDate);
    }

    if (passport) {
      const cleanPassport = passport.replace(/\D/g, '');
      if (cleanPassport.length === 10) {
        const series = cleanPassport.substring(0, 4);
        const number = cleanPassport.substring(4);
        query += ' AND c.passport_series = ? AND c.passport_number = ?';
        params.push(series, number);
      } else {
        query += ' AND CONCAT(c.passport_series, c.passport_number) LIKE ?';
        params.push(`%${cleanPassport}%`);
      }
    }

    query += ' LIMIT 50';

    console.log('Итоговый SQL запрос:', query);
    console.log('Параметры:', params);

    const [citizens] = await pool.query(query, params);

    console.log('Найдено записей:', citizens.length);

    if (citizens.length === 0) {
      return res.json({
        success: true,
        message: 'Граждане с указанными данными не найдены',
        results: []
      });
    }

    // Форматирование результатов
    const results = citizens.map(citizen => {
      const isWanted = !!citizen.wanted_id;
      
      return {
        id: citizen.id,
        lastName: citizen.last_name,
        firstName: citizen.first_name,
        middleName: citizen.middle_name,
        birthDate: citizen.birth_date,
        passport: citizen.passport_series && citizen.passport_number 
          ? `${citizen.passport_series} ${citizen.passport_number}`
          : null,
        address: citizen.address,
        isWanted,
        wantedInfo: isWanted ? {
          reason: citizen.wanted_reason,
          details: citizen.wanted_details,
          photo: citizen.wanted_photo,
          officer: {
            name: citizen.officer_name,
            rank: citizen.officer_rank,
            badge: citizen.officer_badge
          }
        } : null
      };
    });

    res.json({
      success: true,
      count: results.length,
      results
    });

  } catch (error) {
    console.error('Ошибка при поиске:', error);
    res.status(500).json({
      success: false,
      error: 'Внутренняя ошибка сервера при поиске'
    });
  }
});

app.post('/api/protocol/detention', authenticate, async (req, res) => {
  try {
    const { citizenId, reason, articles, detentionTime, location } = req.body;

    // Проверяем, есть ли гражданин в базе
    const [citizen] = await pool.query('SELECT * FROM citizens WHERE id = ?', [citizenId]);
    if (!citizen.length) {
      return res.status(404).json({
        success: false,
        error: 'Гражданин не найден в базе'
      });
    }

    // Получаем данные сотрудника
    const [officer] = await pool.query(
      `SELECT first_name, last_name, middle_name, \`rank\`, badge_number, department 
       FROM user_profiles 
       WHERE user_id = ?`,
      [req.user.id]
    );

    if (!officer.length) {
      return res.status(400).json({
        success: false,
        error: 'Профиль сотрудника не заполнен'
      });
    }

    // Генерируем номер протокола
    const protocolNumber = `ПВД-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

    // Создаем протокол
    const [result] = await pool.query(
      `INSERT INTO detention_protocols SET ?`, {
        protocol_number: protocolNumber,
        citizen_id: citizenId,
        officer_id: req.user.id,
        reason: reason,
        articles: articles.join(', '),
        detention_time: detentionTime,
        location: location,
        status: 'processing',
        created_at: new Date()
      }
    );

    // Если гражданин в розыске - отмечаем задержание
    if (req.body.isWanted) {
      await pool.query(
        `UPDATE wanted_persons 
         SET status = 'detained',
             detained_by = ?,
             detained_at = NOW()
         WHERE id = ?`,
        [req.user.id, req.body.wantedId]
      );
    }

    res.json({
      success: true,
      protocolId: result.insertId,
      protocolNumber,
      message: 'Протокол доставления успешно создан'
    });

  } catch (error) {
    console.error('Detention protocol error:', error);
    res.status(500).json({
      success: false,
      error: 'Ошибка при создании протокола'
    });
  }
});

// Шаблоны протоколов (можно расширить)
const PROTOCOL_TEMPLATES = {
  DETENTION: (data) => `
    ПРОТОКОЛ ДОСТАВЛЕНИЯ №${data.protocol_number}

    Я, ${data.officer_rank} ${data.officer_last_name} ${data.officer_first_name}, 
    доставил в ${data.department} гражданина:
    ФИО: ${data.last_name} ${data.first_name} ${data.middle_name || ''}
    Дата рождения: ${data.birth_date}
    Паспорт: ${data.passport_series} ${data.passport_number}
    
    Основание доставления: ${data.reason}
    Время доставления: ${new Date(data.detention_time).toLocaleString()}
    Место доставления: ${data.location}
    
    Статьи КоАП/УК РФ: ${data.articles}
    
    Подпись сотрудника: ___________
    Подпись гражданина: ___________
    
    Дата составления: ${new Date(data.created_at).toLocaleDateString()}
  `,
  ADMIN_ARREST: (data) => `
    ПРОТОКОЛ ОБ АДМИНИСТРАТИВНОМ ПРАВОНАРУШЕНИИ №${data.protocol_number}

    Составлен ${new Date(data.created_at).toLocaleDateString()}
    Сотрудник: ${data.officer_rank} ${data.officer_last_name} ${data.officer_first_name}
    Нарушитель: ${data.last_name} ${data.first_name} ${data.middle_name || ''}
    
    Статья: ${data.articles}
    Обстоятельства: ${data.reason}
    
    Мера пресечения: административный арест
    Срок: [указать срок ареста]
    
    Подписи:
    Сотрудник - ___________
    Нарушитель - ___________
    
    Примечания: ${data.description || 'нет'}
  `
};


// Добавление в розыск
app.post('/api/wanted/add', authenticate, upload.single('photo'), async (req, res) => {
  try {
    const {
      lastName, firstName, middleName, 
      birthDate, passportSeries, passportNumber,
      searchReason, crimeDetails, description
    } = req.body;

    if (!lastName || !firstName || !searchReason) {
      return res.status(400).json({
        success: false,
        error: 'Фамилия, имя и причина розыска обязательны'
      });
    }

    const photoPath = req.file ? `/uploads/wanted/${req.file.filename}` : null;

    const [result] = await pool.query(
      `INSERT INTO wanted_persons SET ?`, {
        last_name: lastName,
        first_name: firstName,
        middle_name: middleName || null,
        birth_date: birthDate || null,
        passport_series: passportSeries || null,
        passport_number: passportNumber || null,
        search_reason: searchReason,
        crime_details: crimeDetails,
        description: description,
        photo_path: photoPath,
        created_by: req.user.id,
        status: 'wanted',
        created_at: new Date()
      }
    );

    res.json({
      success: true,
      wantedId: result.insertId,
      message: 'Гражданин успешно добавлен в розыск'
    });

  } catch (error) {
    console.error('Add to wanted error:', error);
    res.status(500).json({
      success: false,
      error: 'Ошибка при добавлении в розыск'
    });
  }
});

// Генерация PDF протокола
app.get('/api/protocol/:id/pdf', authenticate, async (req, res) => {
  try {
    const [protocol] = await pool.query(
      `SELECT 
        dp.*,
        c.last_name, c.first_name, c.middle_name,
        c.birth_date, c.passport_series, c.passport_number,
        up.first_name as officer_first_name,
        up.last_name as officer_last_name,
        up.rank as officer_rank
       FROM detention_protocols dp
       JOIN citizens c ON dp.citizen_id = c.id
       JOIN user_profiles up ON dp.officer_id = up.user_id
       WHERE dp.id = ?`,
      [req.params.id]
    );

    if (!protocol.length) {
      return res.status(404).json({
        success: false,
        error: 'Протокол не найден'
      });
    }

    const data = protocol[0];
    const template = PROTOCOL_TEMPLATES.DETENTION.template
      .replace('${officer.rank}', data.officer_rank)
      .replace('${officer.last_name}', data.officer_last_name)
      .replace('${officer.first_name}', data.officer_first_name)
      .replace('${citizen.last_name}', data.last_name)
      .replace('${citizen.first_name}', data.first_name)
      .replace('${citizen.middle_name}', data.middle_name || '')
      .replace('${citizen.birth_date}', data.birth_date)
      .replace('${citizen.passport_series}', data.passport_series)
      .replace('${citizen.passport_number}', data.passport_number)
      .replace('${reason}', data.reason)
      .replace('${detentionTime}', data.detention_time)
      .replace('${location}', data.location)
      .replace('${articles}', data.articles);

    // Здесь должна быть реальная генерация PDF (например, с помощью pdfkit)
    // Для примера возвращаем текстовый шаблон
    res.setHeader('Content-Type', 'text/plain');
    res.send(`=== ${PROTOCOL_TEMPLATES.DETENTION.title} ===\n\n${template}`);

  } catch (error) {
    console.error('Protocol PDF error:', error);
    res.status(500).json({
      success: false,
      error: 'Ошибка генерации протокола'
    });
  }
});

// История поисковых запросов пользователя
app.get('/api/search/history', authenticate, async (req, res) => {
  try {
    const [history] = await pool.query(
      `SELECT 
        id,
        search_type,
        search_reason,
        created_at as timestamp,
        search_query->>'$.lastName' as last_name,
        search_query->>'$.firstName' as first_name,
        search_result->>'$.results' as results_data
       FROM search_logs
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id]
    );

    const formattedHistory = history.map(item => ({
      id: item.id,
      type: item.search_type,
      query: {
        lastName: item.last_name,
        firstName: item.first_name
      },
      reason: item.search_reason,
      result: item.results_data ? JSON.parse(item.results_data) : null,
      timestamp: item.timestamp
    }));

    res.json({
      success: true,
      history: formattedHistory
    });

  } catch (error) {
    console.error('Ошибка при получении истории:', error);
    res.status(500).json({
      success: false,
      error: 'Ошибка при получении истории поиска'
    });
  }
});
app.post('/api/search/citizen-full', authenticate, async (req, res) => {
  try {
    const { id } = req.body;

    // Проверка наличия ID
    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Необходимо указать ID гражданина'
      });
    }

    // 1. Получаем основную информацию о гражданине
    const [citizen] = await pool.query(`
      SELECT 
        c.id,
        c.last_name,
        c.first_name,
        c.middle_name,
        c.birth_date,
        c.passport_series,
        c.passport_number,
        c.passport_issued_by,
        c.passport_issue_date,
        r.address,
        r.registration_date,
        (SELECT photo_path FROM citizen_photos WHERE citizen_id = c.id LIMIT 1) as photo
      FROM citizens c
      LEFT JOIN registrations r ON c.id = r.citizen_id AND r.is_main = 1
      WHERE c.id = ?
    `, [id]);

    if (citizen.length === 0) {
      return res.json({
        success: true,
        result: null,
        message: 'Гражданин не найден'
      });
    }

    // 2. Получаем транспортные средства
    const [vehicles] = await pool.query(`
      SELECT 
        id,
        brand,
        model,
        year,
        color,
        plate_number,
        vin,
        registration_date
      FROM vehicles
      WHERE owner_id = ?
    `, [id]);

    // 3. Получаем оружие
    const [weapons] = await pool.query(`
      SELECT 
        w.id,
        w.type,
        w.model,
        w.serial_number,
        w.registration_date,
        wl.license_type,
        wl.issue_date,
        wl.expiration_date
      FROM weapons w
      LEFT JOIN weapon_licenses wl ON w.license_id = wl.id
      WHERE w.citizen_id = ?
    `, [id]);

    // Формируем ответ
    const response = {
      citizen: {
        ...citizen[0],
        passport: citizen[0].passport_series && citizen[0].passport_number 
          ? `${citizen[0].passport_series} ${citizen[0].passport_number}`
          : null
      },
      vehicles: vehicles,
      weapons: weapons
    };

    res.json({
      success: true,
      result: response
    });

  } catch (error) {
    console.error('Ошибка в /api/search/citizen-full:', error);
    res.status(500).json({
      success: false,
      error: 'Внутренняя ошибка сервера',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});
// GET /api/search/citizen-full/:id
app.get('/api/search/citizen-full/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Проверка ID
    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Некорректный ID гражданина'
      });
    }

    // 1. Основная информация о гражданине
    const [citizen] = await pool.query(`
      SELECT 
        c.id,
        c.last_name,
        c.first_name,
        c.middle_name,
        c.birth_date,
        c.passport_series,
        c.passport_number,
        c.passport_issued_by,
        c.passport_issue_date,
        r.address,
        r.registration_date,
        (SELECT photo_path FROM citizen_photos WHERE citizen_id = c.id LIMIT 1) as photo
      FROM citizens c
      LEFT JOIN registrations r ON c.id = r.citizen_id AND r.is_main = 1
      WHERE c.id = ?
    `, [id]);

    if (citizen.length === 0) {
      return res.json({
        success: true,
        result: null,
        message: 'Гражданин не найден'
      });
    }

    // 2. Транспортные средства
    const [vehicles] = await pool.query(`
      SELECT * FROM vehicles 
      WHERE owner_id = ?
    `, [id]);

    // 3. Оружие
    const [weapons] = await pool.query(`
      SELECT 
        w.*,
        wl.license_type,
        wl.issue_date,
        wl.expiration_date
      FROM weapons w
      LEFT JOIN weapon_licenses wl ON w.license_id = wl.id
      WHERE w.citizen_id = ?
    `, [id]);

    // Формируем ответ
    const response = {
      citizen: {
        ...citizen[0],
        passport: citizen[0].passport_series && citizen[0].passport_number 
          ? `${citizen[0].passport_series} ${citizen[0].passport_number}`
          : null
      },
      vehicles: vehicles,
      weapons: weapons
    };

    res.json({
      success: true,
      result: response
    });

  } catch (error) {
    console.error('Ошибка в GET /api/search/citizen-full:', error);
    res.status(500).json({
      success: false,
      error: 'Внутренняя ошибка сервера'
    });
  }
});
app.get('/api/gibdd/accident-reports/:id/view', authenticate, async (req, res) => {
  try {
    const reportId = req.params.id;
    
    const [report] = await pool.query(`
      SELECT 
        ar.*,
        CONCAT(up.first_name, ' ', up.last_name) as officer_name,
        up.rank as officer_rank,
        up.badge_number as officer_badge,
        up.department as officer_department
      FROM accident_reports ar
      JOIN user_profiles up ON ar.created_by = up.user_id
      WHERE ar.id = ?
    `, [reportId]);

    if (report.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Справка о ДТП не найдена' 
      });
    }

    // Функция для безопасного парсинга JSON данных
    const safeParse = (data) => {
      if (typeof data === 'string') {
        try {
          return JSON.parse(data);
        } catch (e) {
          return [];
        }
      }
      return data || [];
    };

    const response = {
      success: true,
      report: {
        ...report[0],
        participants: safeParse(report[0].participants),
        vehicles: safeParse(report[0].vehicles),
        damages: safeParse(report[0].damages),
        created_at: report[0].created_at,
        updated_at: report[0].updated_at
      }
    };

    await pool.query(
      `INSERT INTO report_views 
       (report_id, user_id, viewed_at) 
       VALUES (?, ?, NOW())`,
      [reportId, req.user.id]
    );

    res.json(response);

  } catch (error) {
    console.error('Ошибка при получении справки:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Внутренняя ошибка сервера'
    });
  }
});
app.get('/api/user/me', authenticate, async (req, res) => {
  try {
    const [user] = await pool.query(
      `SELECT u.id, u.email, u.name, u.avatar, u.roles,
              up.first_name, up.last_name, up.middle_name, 
              up.rank, up.position, up.department, up.badge_number
       FROM users u
       LEFT JOIN user_profiles up ON u.id = up.user_id
       WHERE u.id = ?`,
      [req.user.id]
    );

    if (!user.length) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const userData = user[0];
    
    // Обработка ролей - поддержка как JSON массива, так и простой строки
    let roles = [];
    try {
      // Пытаемся распарсить как JSON
      roles = JSON.parse(userData.roles || '[]');
      
      // Если это не массив (например, распарсилась строка), создаем массив
      if (!Array.isArray(roles)) {
        roles = [userData.roles];
      }
    } catch (e) {
      // Если парсинг не удался, используем как строку в массиве
      roles = [userData.roles];
    }

    const response = {
      id: userData.id,
      email: userData.email,
      name: userData.name,
      avatar: userData.avatar,
      roles: roles, // Используем обработанные роли
      profile: {
        firstName: userData.first_name,
        lastName: userData.last_name,
        middleName: userData.middle_name,
        rank: userData.rank,
        position: userData.position,
        department: userData.department,
        badgeNumber: userData.badge_number,
        fullName: `${userData.rank} ${userData.last_name} ${userData.first_name} ${userData.middle_name || ''}`.trim(),
        shortName: `${userData.last_name} ${userData.first_name[0]}.${userData.middle_name ? ` ${userData.middle_name[0]}.` : ''}`
      }
    };

    res.json({ success: true, user: response });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch user data',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});

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
async function logSearch(userId, searchQuery) {
  try {
    const [rows] = await pool.query(`
      SELECT first_name, last_name, \`rank\`, department, badge_number 
      FROM user_profiles 
      WHERE user_id = ?
    `, [userId]);
    
    

    
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
    throw error;
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
`CREATE TABLE IF NOT EXISTS mchs_teams (
      id INT AUTO_INCREMENT PRIMARY KEY,
      team_name VARCHAR(100) NOT NULL,
      team_type ENUM('fire_team', 'rescue_team', 'chemical_protection', 'medical_team') NOT NULL,
      status ENUM('ready', 'on_mission', 'maintenance') DEFAULT 'ready',
      vehicle_id INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    
    `CREATE TABLE IF NOT EXISTS mchs_team_members (
      id INT AUTO_INCREMENT PRIMARY KEY,
      team_id INT NOT NULL,
      user_id INT NOT NULL,
      position VARCHAR(100) NOT NULL,
      is_leader BOOLEAN DEFAULT FALSE,
      FOREIGN KEY (team_id) REFERENCES mchs_teams(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    
    `CREATE TABLE IF NOT EXISTS mchs_vehicles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      type ENUM('fire_truck', 'rescue_vehicle', 'ambulance', 'command_vehicle') NOT NULL,
      license_plate VARCHAR(20) NOT NULL,
      status ENUM('ready', 'in_use', 'maintenance') DEFAULT 'ready',
      last_maintenance DATE,
      next_maintenance DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    
    `CREATE TABLE IF NOT EXISTS mchs_equipment (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      type VARCHAR(100) NOT NULL,
      quantity INT NOT NULL,
      team_id INT,
      vehicle_id INT,
      last_check DATE,
      next_check DATE,
      FOREIGN KEY (team_id) REFERENCES mchs_teams(id) ON DELETE SET NULL,
      FOREIGN KEY (vehicle_id) REFERENCES mchs_vehicles(id) ON DELETE SET NULL
    )`,
    
    `CREATE TABLE IF NOT EXISTS mchs_missions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      emergency_call_id INT,
      team_id INT NOT NULL,
      start_time DATETIME NOT NULL,
      end_time DATETIME,
      status ENUM('dispatched', 'on_scene', 'completed', 'cancelled') DEFAULT 'dispatched',
      report TEXT,
      created_by INT NOT NULL,
      FOREIGN KEY (emergency_call_id) REFERENCES emergency_calls(id) ON DELETE SET NULL,
      FOREIGN KEY (team_id) REFERENCES mchs_teams(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`,
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
`CREATE TABLE IF NOT EXISTS wanted_persons (
      id INT AUTO_INCREMENT PRIMARY KEY,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      middle_name VARCHAR(100),
      birth_date DATE,
      passport_series VARCHAR(4),
      passport_number VARCHAR(6),
      description TEXT,
      crime_details TEXT,
      search_reason ENUM('розыск', 'пропавший без вести', 'розыск свидетеля', 'подозреваемый') NOT NULL,
      photo_path VARCHAR(255),
      created_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS wanted_vehicles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      make VARCHAR(100) NOT NULL,
      model VARCHAR(100) NOT NULL,
      year INT,
      color VARCHAR(50),
      plate_number VARCHAR(20),
      vin VARCHAR(17),
      description TEXT,
      crime_details TEXT,
      search_reason ENUM('угон', 'участие в преступлении', 'розыск') NOT NULL,
      photo_path VARCHAR(255),
      created_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS wanted_weapons (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type ENUM('огнестрельное', 'холодное', 'гранатомет', 'взрывчатые вещества') NOT NULL,
      model VARCHAR(100) NOT NULL,
      serial_number VARCHAR(50),
      description TEXT,
      crime_details TEXT,
      search_reason ENUM('утерянное', 'украденное', 'использованное в преступлении') NOT NULL,
      photo_path VARCHAR(255),
      created_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS wanted_documents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type ENUM('паспорт', 'водительские права', 'военный билет', 'диплом') NOT NULL,
      series VARCHAR(20),
      number VARCHAR(50) NOT NULL,
      description TEXT,
      crime_details TEXT,
      search_reason ENUM('утерянный', 'украденный', 'поддельный') NOT NULL,
      created_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS wanted_search_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      search_type ENUM('person', 'vehicle', 'weapon', 'document') NOT NULL,
      search_query TEXT NOT NULL,
      search_result ENUM('found', 'not_found', 'error') NOT NULL,
      result_details TEXT,
      department VARCHAR(100),
      badge_number VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

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

app.post('/api/mvd/search/persons', authenticate, async (req, res) => {
  try {
    const { query } = req.body;
    
    // Поиск по ФИО или паспортным данным
    const [results] = await pool.query(`
      SELECT 
        wp.*,
        CONCAT(up.last_name, ' ', up.first_name) as officer_name,
        up.rank as officer_rank,
        up.badge_number as officer_badge
      FROM wanted_persons wp
      LEFT JOIN user_profiles up ON wp.created_by = up.user_id
      WHERE 
        CONCAT(wp.last_name, ' ', wp.first_name, ' ', COALESCE(wp.middle_name, '')) LIKE ? OR
        CONCAT(wp.passport_series, wp.passport_number) LIKE ?
      ORDER BY wp.created_at DESC
      LIMIT 50
    `, [`%${query}%`, `%${query}%`]);

    // Логируем поиск
    await logSearch(req, 'person', query, results.length > 0 ? 'found' : 'not_found', 
      results.length > 0 ? `Найдено ${results.length} совпадений` : null);

    res.json({ success: true, results });
  } catch (error) {
    console.error('Person search error:', error);
    await logSearch(req, 'person', query, 'error', error.message);
    res.status(500).json({ success: false, error: 'Ошибка поиска' });
  }
});

app.post('/api/mvd/search/vehicles', authenticate, async (req, res) => {
  try {
    const { query } = req.body;
    
    const [results] = await pool.query(`
      SELECT 
        wv.*,
        CONCAT(up.last_name, ' ', up.first_name) as officer_name,
        up.rank as officer_rank,
        up.badge_number as officer_badge
      FROM wanted_vehicles wv
      LEFT JOIN user_profiles up ON wv.created_by = up.user_id
      WHERE 
        wv.plate_number LIKE ? OR
        wv.vin LIKE ? OR
        CONCAT(wv.make, ' ', wv.model) LIKE ?
      ORDER BY wv.created_at DESC
      LIMIT 50
    `, [`%${query}%`, `%${query}%`, `%${query}%`]);

    await logSearch(req, 'vehicle', query, results.length > 0 ? 'found' : 'not_found', 
      results.length > 0 ? `Найдено ${results.length} совпадений` : null);

    res.json({ success: true, results });
  } catch (error) {
    console.error('Vehicle search error:', error);
    await logSearch(req, 'vehicle', query, 'error', error.message);
    res.status(500).json({ success: false, error: 'Ошибка поиска' });
  }
});

app.post('/api/mvd/wanted', authenticate, upload.single('photo'), async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      middleName,
      birthDate,
      passportSeries,
      passportNumber,
      description,
      crimeDetails,
      searchReason
    } = req.body;

    const photoPath = req.file ? `/uploads/wanted/${req.file.filename}` : null;

    const [result] = await pool.query(
      `INSERT INTO wanted_persons SET ?`, {
        first_name: firstName,
        last_name: lastName,
        middle_name: middleName,
        birth_date: birthDate,
        passport_series: passportSeries,
        passport_number: passportNumber,
        description,
        crime_details: crimeDetails,
        search_reason: searchReason,
        photo_path: photoPath,
        created_by: req.user.id
      }
    );

    res.json({ 
      success: true, 
      message: 'Данные успешно добавлены в систему розыска',
      id: result.insertId
    });
  } catch (error) {
    console.error('Add to wanted error:', error);
    res.status(500).json({ success: false, error: 'Ошибка добавления в розыск' });
  }
});
// Получение списка разыскиваемых лиц
app.get('/api/mvd/wanted/persons', authenticate, async (req, res) => {
  try {
    const [persons] = await pool.query(`
      SELECT 
        wp.*,
        CONCAT(up.last_name, ' ', up.first_name) as officer_name,
        up.rank as officer_rank,
        up.badge_number as officer_badge
      FROM wanted_persons wp
      LEFT JOIN user_profiles up ON wp.created_by = up.user_id
      ORDER BY wp.created_at DESC
    `);

    res.json({ 
      success: true, 
      results: persons.map(p => ({
        ...p,
        isDetained: p.status === 'detained'
      }))
    });
  } catch (error) {
    console.error('Error fetching wanted persons:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка загрузки списка разыскиваемых лиц' 
    });
  }
});
app.post('/api/mvd/wanted/persons/:id/detain', authenticate, async (req, res) => {
  try {
    const { detainedBy } = req.body;
    const detainedAt = new Date().toISOString().slice(0, 19).replace('T', ' '); // Формат: 'YYYY-MM-DD HH:MM:SS'
    
    await pool.query(
      `UPDATE wanted_persons 
       SET status = 'detained',
           detained_by = ?,
           detained_at = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [detainedBy, detainedAt, req.params.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Detain error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка отметки задержания',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});



// Генерация номера справки о ДТП
function generateAccidentNumber() {
  const prefix = 'ДТП';
  const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const randomPart = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${datePart}-${randomPart}`;
}

// Создание новой справки о ДТП
app.post('/api/gibdd/accident-reports', authenticate, async (req, res) => {
  try {
    const {
      accident_date,
      accident_location,
      accident_description,
      participants,
      vehicles,
      damages,
      circumstances,
      witnesses
    } = req.body;

    // Валидация данных
    if (!accident_date || !accident_location || !accident_description || 
        !participants || !vehicles || !damages || !circumstances) {
      return res.status(400).json({ 
        success: false, 
        error: 'Все обязательные поля должны быть заполнены' 
      });
    }

    // Получаем данные инспектора
  const [profile] = await pool.query(
  `SELECT first_name, last_name, middle_name, \`rank\`, badge_number, department 
   FROM user_profiles 
   WHERE user_id = ?`,
  [req.user.id]
);

    if (profile.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Профиль инспектора не найден' 
      });
    }

    const officerData = profile[0];
    const officerName = [
      officerData.rank,
      officerData.last_name,
      officerData.first_name,
      officerData.middle_name
    ].filter(Boolean).join(' ');

    // Создаем справку
    const [result] = await pool.query(
      `INSERT INTO accident_reports SET ?`, {
        accident_number: generateAccidentNumber(),
        accident_date,
        accident_location,
        accident_description,
        participants: JSON.stringify(participants),
        vehicles: JSON.stringify(vehicles),
        damages: JSON.stringify(damages),
        circumstances,
        witnesses: witnesses || null,
        created_by: req.user.id
      }
    );

    // Логируем создание справки
    await pool.query(
      `INSERT INTO gibdd_activity_logs 
       (user_id, action_type, action_details, entity_type, entity_id)
       VALUES (?, ?, ?, ?, ?)`,
      [
        req.user.id,
        'create_accident_report',
        `Создана справка о ДТП №${result.insertId}`,
        'accident_report',
        result.insertId
      ]
    );

    res.json({
      success: true,
      reportId: result.insertId,
      accidentNumber: generateAccidentNumber()
    });

  } catch (error) {
    console.error('Error creating accident report:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при создании справки о ДТП',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});

// Получение списка справок
app.get('/api/gibdd/accident-reports', authenticate, async (req, res) => {
  try {
    const [reports] = await pool.query(`
      SELECT 
        ar.*,
        CONCAT(up.first_name, ' ', up.last_name) as officer_name,
        up.rank as officer_rank,
        up.badge_number as officer_badge
      FROM accident_reports ar
      JOIN user_profiles up ON ar.created_by = up.user_id
      ORDER BY ar.accident_date DESC
      LIMIT 100
    `);

    const processedReports = reports.map(report => ({
      ...report,
      participants: JSON.parse(report.participants),
      vehicles: JSON.parse(report.vehicles),
      damages: JSON.parse(report.damages)
    }));

    res.json({ success: true, reports: processedReports });
  } catch (error) {
    console.error('Error fetching accident reports:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при получении списка справок' 
    });
  }
});

// Получение конкретной справки
app.get('/api/gibdd/accident-reports/:id', authenticate, async (req, res) => {
  try {
    const [reports] = await pool.query(`
      SELECT 
        ar.*,
        CONCAT(up.first_name, ' ', up.last_name) as officer_name,
        up.rank as officer_rank,
        up.badge_number as officer_badge,
        up.department as officer_department
      FROM accident_reports ar
      JOIN user_profiles up ON ar.created_by = up.user_id
      WHERE ar.id = ?
    `, [req.params.id]);

    if (reports.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Справка не найдена' 
      });
    }

    const report = reports[0];
    const response = {
      ...report,
      participants: JSON.parse(report.participants),
      vehicles: JSON.parse(report.vehicles),
      damages: JSON.parse(report.damages)
    };

    res.json({ success: true, report: response });
  } catch (error) {
    console.error('Error fetching accident report:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при получении справки' 
    });
  }
});

// Подписание справки
app.post('/api/gibdd/accident-reports/:id/sign', authenticate, async (req, res) => {
  try {
    const { signature_data } = req.body;

    if (!signature_data) {
      return res.status(400).json({ 
        success: false, 
        error: 'Данные подписи обязательны' 
      });
    }

    // Проверяем существование справки
    const [report] = await pool.query(
      'SELECT id FROM accident_reports WHERE id = ?',
      [req.params.id]
    );

    if (report.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Справка не найдена' 
      });
    }

    // Добавляем подпись
    await pool.query(
      `INSERT INTO accident_report_signatures 
       (report_id, officer_id, signature_data) 
       VALUES (?, ?, ?)`,
      [req.params.id, req.user.id, signature_data]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error signing accident report:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при подписании справки' 
    });
  }
});

// // Генерация PDF справки
// app.get('/api/gibdd/accident-reports/:id/pdf', authenticate, async (req, res) => {
//   try {
//     const reportId = req.params.id; // Получаем ID из URL
    
//     // Проверяем существование справки
//     const [report] = await pool.query(
//       'SELECT * FROM accident_reports WHERE id = ?',
//       [reportId]
//     );

//     if (report.length === 0) {
//       return res.status(404).json({ 
//         success: false, 
//         error: 'Справка не найдена' 
//       });
//     }

//     // Формируем данные для PDF
//     const reportData = {
//       ...report[0],
//       participants: JSON.parse(report[0].participants),
//       vehicles: JSON.parse(report[0].vehicles),
//       damages: JSON.parse(report[0].damages)
//     };

//     // Здесь должна быть реальная генерация PDF
//     // Пока возвращаем JSON с данными
//     res.json({
//       success: true,
//       report: reportData
//     });

//   } catch (error) {
//     console.error('PDF generation error:', error);
//     res.status(500).json({ 
//       success: false, 
//       error: 'Ошибка при генерации PDF'
//     });
//   }
// });



app.post('/api/mvd/wanted/persons', authenticate, upload.single('photo'), async (req, res) => {
  try {
    // Валидация входных данных
    const requiredFields = ['firstName', 'lastName', 'birthDate', 'searchReason'];
    const missingFields = requiredFields.filter(field => !req.body[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Не заполнены обязательные поля: ${missingFields.join(', ')}`
      });
    }

    const {
      firstName,
      lastName,
      middleName = '',
      birthDate,
      passportSeries = '',
      passportNumber = '',
      description = '',
      crimeDetails = '',
      searchReason
    } = req.body;

    const photoPath = req.file ? `/uploads/wanted/${req.file.filename}` : null;

    // Проверка формата даты
    if (isNaN(new Date(birthDate).getTime())) {
      return res.status(400).json({
        success: false,
        error: 'Неверный формат даты рождения'
      });
    }

    const [result] = await pool.query(
      `INSERT INTO wanted_persons SET ?`, {
        first_name: firstName,
        last_name: lastName,
        middle_name: middleName,
        birth_date: new Date(birthDate).toISOString().slice(0, 19).replace('T', ' '),
        passport_series: passportSeries,
        passport_number: passportNumber,
        description,
        crime_details: crimeDetails,
        search_reason: searchReason,
        photo_path: photoPath,
        created_by: req.user.id,
        created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
      }
    );

    // Логирование успешного добавления
    console.log(`Добавлен в розыск: ${lastName} ${firstName} ${middleName}`);

    res.status(201).json({ 
      success: true, 
      message: 'Данные успешно добавлены в систему розыска',
      id: result.insertId
    });

  } catch (error) {
    console.error('Add to wanted error:', error);
    
    // Удаляем загруженный файл, если возникла ошибка
    if (req.file) {
      const fs = require('fs');
      fs.unlink(`public/uploads/wanted/${req.file.filename}`, (err) => {
        if (err) console.error('Ошибка удаления файла:', err);
      });
    }

    res.status(500).json({ 
      success: false, 
      error: 'Ошибка добавления в розыск',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});
app.get('/api/mvd/wanted/:id', authenticate, async (req, res) => {
  try {
    const [person] = await pool.query(`
      SELECT 
        wp.*,
        CONCAT(up.last_name, ' ', up.first_name) as officer_name,
        up.rank as officer_rank,
        up.department as officer_department,
        up.badge_number as officer_badge
      FROM wanted_persons wp
      LEFT JOIN user_profiles up ON wp.created_by = up.user_id
      WHERE wp.id = ?
    `, [req.params.id]);

    if (person.length === 0) {
      return res.status(404).json({ success: false, error: 'Запись не найдена' });
    }

    res.json({ success: true, person: person[0] });
  } catch (error) {
    console.error('Get wanted person error:', error);
    res.status(500).json({ success: false, error: 'Ошибка получения данных' });
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
app.post('/api/user/link-telegram', authenticate, async (req, res) => {
  try {
    const { telegram_id } = req.body;
    
    await pool.query(
      'UPDATE users SET telegram_id = ? WHERE id = ?',
      [telegram_id, req.user.id]
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Linking failed' });
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
    app.get('/api/mchs/stats', authenticate, async (req, res) => {
  try {
    const [activeCalls] = await pool.query(
      `SELECT COUNT(*) as count FROM emergency_calls WHERE status = 'active'`
    );
    
    const [availableTeams] = await pool.query(
      `SELECT COUNT(*) as count FROM mchs_teams WHERE status = 'ready'`
    );
    
    const [activeMissions] = await pool.query(
      `SELECT COUNT(*) as count FROM emergency_calls WHERE status = 'in_progress'`
    );
    
    res.json({
      success: true,
      stats: {
        activeCalls: activeCalls[0].count,
        availableTeams: availableTeams[0].count,
        activeMissions: activeMissions[0].count
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: 'Ошибка получения статистики' });
  }
});
app.get('/api/mchs/equipment', authenticate, async (req, res) => {
  try {
    const [equipment] = await pool.query('SELECT * FROM mchs_equipment');
    res.json({ success: true, equipment });
  } catch (error) {
    console.error('Error fetching equipment:', error);
    res.status(500).json({ success: false, error: 'Ошибка получения техники' });
  }
});
app.get('/api/mchs/stats', authenticate, async (req, res) => {
  try {
    const [activeCalls] = await pool.query(
      `SELECT COUNT(*) as count FROM emergency_calls WHERE status = 'active'`
    );
    
    const [availableTeams] = await pool.query(
      `SELECT COUNT(*) as count FROM mchs_teams WHERE status = 'ready'`
    );
    
    const [activeMissions] = await pool.query(
      `SELECT COUNT(*) as count FROM emergency_calls WHERE status = 'in_progress'`
    );
    
    res.json({
      success: true,
      stats: {
        activeCalls: activeCalls[0].count,
        availableTeams: availableTeams[0].count,
        activeMissions: activeMissions[0].count
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: 'Ошибка получения статистики' });
  }
});
app.get('/api/mchs/personnel', authenticate, async (req, res) => {
  try {
    const [personnel] = await pool.query(`
      SELECT 
        u.id,
        up.first_name,
        up.last_name,
        up.rank,
        up.department
      FROM users u
      JOIN user_profiles up ON u.id = up.user_id
      WHERE JSON_CONTAINS(u.roles, '"МЧС"')
    `);
    
    res.json({ success: true, personnel });
  } catch (error) {
    console.error('Error fetching personnel:', error);
    res.status(500).json({ success: false, error: 'Ошибка получения персонала' });
  }
});
app.get('/api/mchs/reports', authenticate, async (req, res) => {
  try {
    const [reports] = await pool.query(`
      SELECT 
        r.*,
        CONCAT(up.first_name, ' ', up.last_name) as author_name
      FROM mchs_reports r
      LEFT JOIN user_profiles up ON r.author_id = up.user_id
      ORDER BY r.created_at DESC
    `);
    
    res.json({ success: true, reports });
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ success: false, error: 'Ошибка получения отчетов' });
  }
});
app.get('/api/mchs/teams', authenticate, async (req, res) => {
  try {
    const [teams] = await pool.query(`
      SELECT 
        t.*,
        COUNT(tm.user_id) as members_count,
        GROUP_CONCAT(CONCAT(up.first_name, ' ', up.last_name) SEPARATOR ', ') as members_names
      FROM mchs_teams t
      LEFT JOIN mchs_team_members tm ON t.id = tm.team_id
      LEFT JOIN user_profiles up ON tm.user_id = up.user_id
      GROUP BY t.id
    `);
    
    res.json({ success: true, teams });
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ success: false, error: 'Ошибка получения экипажей' });
  }
});

// Создание новой бригады
app.post('/api/mchs/teams', authenticate, async (req, res) => {
  try {
    const { team_name, team_type, vehicle_id } = req.body;
    
    const [result] = await pool.query(
      `INSERT INTO mchs_teams SET ?`, {
        team_name,
        team_type,
        vehicle_id: vehicle_id || null,
        status: 'ready'
      }
    );
    
    res.json({ 
      success: true, 
      teamId: result.insertId,
      message: 'Бригада успешно создана'
    });
  } catch (error) {
    console.error('Create team error:', error);
    res.status(500).json({ success: false, error: 'Ошибка создания бригады' });
  }
});

// Добавление сотрудника в бригаду
app.post('/api/mchs/teams/:id/members', authenticate, async (req, res) => {
  try {
    const { user_id, position, is_leader } = req.body;
    
    // Проверяем, что пользователь существует
    const [user] = await pool.query('SELECT id FROM users WHERE id = ?', [user_id]);
    if (user.length === 0) {
      return res.status(404).json({ success: false, error: 'Пользователь не найден' });
    }
    
    // Проверяем, что бригада существует
    const [team] = await pool.query('SELECT id FROM mchs_teams WHERE id = ?', [req.params.id]);
    if (team.length === 0) {
      return res.status(404).json({ success: false, error: 'Бригада не найдена' });
    }
    
    // Добавляем сотрудника в бригаду
    const [result] = await pool.query(
      `INSERT INTO mchs_team_members SET ?`, {
        team_id: req.params.id,
        user_id,
        position,
        is_leader: is_leader || false
      }
    );
    
    res.json({ 
      success: true, 
      message: 'Сотрудник успешно добавлен в бригаду'
    });
  } catch (error) {
    console.error('Add team member error:', error);
    res.status(500).json({ success: false, error: 'Ошибка добавления сотрудника' });
  }
});

// Получение списка транспортных средств
app.get('/api/mchs/vehicles', authenticate, async (req, res) => {
  try {
    const [vehicles] = await pool.query('SELECT * FROM mchs_vehicles ORDER BY name');
    res.json({ success: true, vehicles });
  } catch (error) {
    console.error('MCHS vehicles error:', error);
    res.status(500).json({ success: false, error: 'Ошибка загрузки транспорта' });
  }
});

// Создание миссии (назначение бригады на вызов)
app.post('/api/mchs/missions', authenticate, async (req, res) => {
  try {
    const { emergency_call_id, team_id } = req.body;
    
    // Проверяем, что бригада свободна
    const [team] = await pool.query(
      'SELECT status FROM mchs_teams WHERE id = ?', 
      [team_id]
    );
    
    if (team.length === 0) {
      return res.status(404).json({ success: false, error: 'Бригада не найдена' });
    }
    
    if (team[0].status !== 'ready') {
      return res.status(400).json({ 
        success: false, 
        error: 'Бригада уже занята на другом вызове' 
      });
    }
    
    // Создаем миссию
    const [result] = await pool.query(
      `INSERT INTO mchs_missions SET ?`, {
        emergency_call_id,
        team_id,
        start_time: new Date(),
        status: 'dispatched',
        created_by: req.user.id
      }
    );
    
    // Обновляем статус бригады
    await pool.query(
      'UPDATE mchs_teams SET status = "on_mission" WHERE id = ?',
      [team_id]
    );
    
    // Обновляем статус вызова
    await pool.query(
      'UPDATE emergency_calls SET status = "in_progress" WHERE id = ?',
      [emergency_call_id]
    );
    
    res.json({ 
      success: true, 
      missionId: result.insertId,
      message: 'Бригада успешно назначена на вызов'
    });
  } catch (error) {
    console.error('Create mission error:', error);
    res.status(500).json({ success: false, error: 'Ошибка создания миссии' });
  }
});

// Завершение миссии
app.put('/api/mchs/missions/:id/complete', authenticate, async (req, res) => {
  try {
    const { report } = req.body;
    
    // Получаем информацию о миссии
    const [mission] = await pool.query(
      'SELECT team_id FROM mchs_missions WHERE id = ?',
      [req.params.id]
    );
    
    if (mission.length === 0) {
      return res.status(404).json({ success: false, error: 'Миссия не найдена' });
    }
    
    // Обновляем миссию
    await pool.query(
      `UPDATE mchs_missions SET 
        status = 'completed',
        end_time = NOW(),
        report = ?
       WHERE id = ?`,
      [report, req.params.id]
    );
    
    // Возвращаем бригаду в готовность
    await pool.query(
      'UPDATE mchs_teams SET status = "ready" WHERE id = ?',
      [mission[0].team_id]
    );
    
    // Обновляем статус вызова
    await pool.query(
      `UPDATE emergency_calls ec
       JOIN mchs_missions mm ON ec.id = mm.emergency_call_id
       SET ec.status = 'completed'
       WHERE mm.id = ?`,
      [req.params.id]
    );
    
    res.json({ 
      success: true,
      message: 'Миссия успешно завершена'
    });
  } catch (error) {
    console.error('Complete mission error:', error);
    res.status(500).json({ success: false, error: 'Ошибка завершения миссии' });
  }
});

// Получение активных миссий
app.get('/api/mchs/missions/active', authenticate, async (req, res) => {
  try {
    const [missions] = await pool.query(`
      SELECT 
        mm.*,
        mt.team_name,
        mt.team_type,
        ec.address as call_address,
        ec.description as call_description,
        CONCAT(up.first_name, ' ', up.last_name) as created_by_name
      FROM mchs_missions mm
      JOIN mchs_teams mt ON mm.team_id = mt.id
      LEFT JOIN emergency_calls ec ON mm.emergency_call_id = ec.id
      LEFT JOIN user_profiles up ON mm.created_by = up.user_id
      WHERE mm.status != 'completed' AND mm.status != 'cancelled'
      ORDER BY mm.start_time DESC
    `);
    
    res.json({ success: true, missions });
  } catch (error) {
    console.error('Active missions error:', error);
    res.status(500).json({ success: false, error: 'Ошибка загрузки активных миссий' });
  }
});

// Получение списка сотрудников МЧС

// Создание нового сотрудника МЧС
app.post('/api/mchs/personnel', authenticate, async (req, res) => {
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
    
    // Создаем пользователя
    const [userResult] = await pool.query(
      `INSERT INTO users (email, name, roles) 
       VALUES (?, ?, ?)`,
      [
        `${first_name.toLowerCase()}.${last_name.toLowerCase()}@mchs.gov`, 
        `${last_name} ${first_name} ${middle_name || ''}`.trim(),
        JSON.stringify(['МЧС'])
      ]
    );
    
    // Создаем профиль
    await pool.query(
      `INSERT INTO user_profiles SET ?`, {
        user_id: userResult.insertId,
        first_name,
        last_name,
        middle_name: middle_name || null,
        rank: rank || MCHS_RANKS.LIEUTENANT,
        position,
        department: department || 'Пожарная часть',
        badge_number
      }
    );
    
    res.json({ 
      success: true,
      userId: userResult.insertId,
      message: 'Сотрудник успешно создан'
    });
  } catch (error) {
    console.error('Create personnel error:', error);
    res.status(500).json({ success: false, error: 'Ошибка создания сотрудника' });
  }
});

// Генерация отчета о вызове в формате PDF
app.get('/api/mchs/missions/:id/report', authenticate, async (req, res) => {
  try {
    const [mission] = await pool.query(`
      SELECT 
        mm.*,
        mt.team_name,
        mt.team_type,
        ec.address as call_location,
        ec.description as call_description,
        ec.call_time,
        CONCAT(up.first_name, ' ', up.last_name) as commander_name,
        up.rank as commander_rank
      FROM mchs_missions mm
      JOIN mchs_teams mt ON mm.team_id = mt.id
      LEFT JOIN emergency_calls ec ON mm.emergency_call_id = ec.id
      LEFT JOIN user_profiles up ON mm.created_by = up.user_id
      WHERE mm.id = ?
    `, [req.params.id]);
    
    if (mission.length === 0) {
      return res.status(404).json({ success: false, error: 'Миссия не найдена' });
    }
    
    const [teamMembers] = await pool.query(`
      SELECT 
        up.first_name,
        up.last_name,
        up.rank,
        tm.position,
        tm.is_leader
      FROM mchs_team_members tm
      JOIN user_profiles up ON tm.user_id = up.user_id
      WHERE tm.team_id = ?
    `, [mission[0].team_id]);
    
    // Формируем данные для отчета
    const reportData = {
      missionId: mission[0].id,
      teamName: mission[0].team_name,
      teamType: mission[0].team_type,
      callLocation: mission[0].call_location,
      callDescription: mission[0].call_description,
      callTime: mission[0].call_time,
      startTime: mission[0].start_time,
      endTime: mission[0].end_time,
      commander: {
        name: mission[0].commander_name,
        rank: mission[0].commander_rank
      },
      members: teamMembers,
      report: mission[0].report
    };
    
    // Здесь должна быть реальная генерация PDF (например, с помощью pdfkit)
    // Для примера возвращаем JSON с данными
    res.json({
      success: true,
      report: reportData,
      pdfUrl: `/reports/mchs_mission_${req.params.id}.pdf` // Пример URL сгенерированного PDF
    });
  } catch (error) {
    console.error('Mission report error:', error);
    res.status(500).json({ success: false, error: 'Ошибка генерации отчета' });
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
    const { 
      emergency_type, 
      address, 
      description, 
      caller_name, 
      caller_phone,
      is_false_alarm = false // Добавляем параметр ложного вызова
    } = req.body;
    
    // Валидация типа вызова
    const validTypes = ['fire', 'rescue', 'chemical', 'gas_leak', 'police', 'medical'];
    if (!validTypes.includes(emergency_type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Неверный тип вызова' 
      });
    }

    const [result] = await pool.query(
      `INSERT INTO emergency_calls SET ?`,
      {
        user_id: req.user.uid,
        emergency_type,
        address,
        description,
        caller_name, // Сохраняем ФИО звонящего
        caller_phone,
        is_false_alarm, // Сохраняем флаг ложного вызова
        call_time: new Date().toISOString().slice(0, 19).replace('T', ' '),
        status: is_false_alarm ? 'false_alarm' : 'sent' // Автоматически отмечаем как ложный если нужно
      }
    );

    res.json({ success: true, callId: result.insertId });
  } catch (error) {
    console.error('Error saving emergency call:', error);
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
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
// Генерация номера водительского удостоверения
const license_number = 'РФ' + Math.floor(1000000 + Math.random() * 9000000);
   app.post('/api/gosuslugi/citizens', authenticate, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    
    const {
      first_name, last_name, middle_name, gender, 
      birth_date, birth_place, passport_issued_by,
      passport_issue_date, passport_department_code,
      registrations, driver_license, workplace
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
        passport_series,
        passport_number,
        passport_issued_by, passport_issue_date, passport_department_code,  workplace,
        user_id: req.user.id
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
    if (driver_license && driver_license.has_license && driver_license.categories.length > 0) {
      const license_number = 'РФ' + Math.floor(1000000 + Math.random() * 9000000);
      await connection.query(
        `INSERT INTO driver_licenses SET ?`, {
          citizen_id: citizenResult.insertId,
          license_number,
          categories: driver_license.categories.join(','),
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
// Медицинская информация - добавление
app.post('/api/gosuslugi/medical', authenticate, async (req, res) => {
  try {
    const {
      citizen_id,
      blood_type,
      rh_factor,
      allergies,
      chronic_diseases,
      disabilities,
      workplace,
      workplace_address,
      workplace_position,
      last_medical_checkup,
      next_medical_checkup,
      insurance_number,
      emergency_contact_name,
      emergency_contact_phone
    } = req.body;

    // Валидация обязательных полей
    if (!citizen_id || !blood_type || !workplace || !insurance_number) {
      return res.status(400).json({
        success: false,
        error: 'Не заполнены обязательные поля: группа крови, место работы, номер страховки'
      });
    }

    const [result] = await pool.query(
      `INSERT INTO medical_info SET ?`, {
        citizen_id,
        user_id: req.user.uid,
        blood_type,
        rh_factor: rh_factor || 'positive',
        allergies: allergies || 'Нет',
        chronic_diseases: chronic_diseases || 'Нет',
        disabilities: disabilities || 'Нет',
        workplace,
        workplace_address,
        workplace_position,
        last_medical_checkup: last_medical_checkup || null,
        next_medical_checkup: next_medical_checkup || null,
        insurance_number,
        emergency_contact_name: emergency_contact_name || 'Не указано',
        emergency_contact_phone: emergency_contact_phone || 'Не указано',
        registration_date: new Date().toISOString().split('T')[0]
      }
    );

    res.json({ 
      success: true, 
      medical_id: result.insertId,
      message: 'Медицинская информация успешно сохранена'
    });
  } catch (error) {
    console.error('Error saving medical info:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при сохранении медицинской информации',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});

// Получение медицинской информации
app.get('/api/gosuslugi/medical/:citizen_id', authenticate, async (req, res) => {
  try {
    const { citizen_id } = req.params;

    const [results] = await pool.query(
      `SELECT m.*, 
              c.first_name, c.last_name, c.middle_name,
              c.passport_series, c.passport_number
       FROM medical_info m
       JOIN citizens c ON m.citizen_id = c.id
       WHERE m.citizen_id = ? AND m.user_id = ?`,
      [citizen_id, req.user.uid]
    );

    if (results.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Медицинская информация не найдена'
      });
    }

    res.json({
      success: true,
      medicalInfo: results[0]
    });
  } catch (error) {
    console.error('Error fetching medical info:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при получении медицинской информации',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});

// Обновление медицинской информации
app.put('/api/gosuslugi/medical/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      blood_type,
      rh_factor,
      allergies,
      chronic_diseases,
      disabilities,
      workplace,
      workplace_address,
      workplace_position,
      last_medical_checkup,
      next_medical_checkup,
      insurance_number,
      emergency_contact_name,
      emergency_contact_phone
    } = req.body;

    // Проверка существования записи
    const [check] = await pool.query(
      `SELECT id FROM medical_info WHERE id = ? AND user_id = ?`,
      [id, req.user.uid]
    );

    if (check.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Медицинская информация не найдена'
      });
    }

    await pool.query(
      `UPDATE medical_info SET ? WHERE id = ?`,
      [{
        blood_type,
        rh_factor,
        allergies,
        chronic_diseases,
        disabilities,
        workplace,
        workplace_address,
        workplace_position,
        last_medical_checkup,
        next_medical_checkup,
        insurance_number,
        emergency_contact_name,
        emergency_contact_phone,
        updated_at: new Date()
      }, id]
    );

    res.json({ 
      success: true,
      message: 'Медицинская информация успешно обновлена'
    });
  } catch (error) {
    console.error('Error updating medical info:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при обновлении медицинской информации',
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
    (SELECT dl.license_number FROM driver_licenses dl WHERE dl.citizen_id = c.id LIMIT 1) as license_number,
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
        c.birth_date,
        c.passport_series,
        c.passport_number,
        c.passport_issued_by,
        c.passport_issue_date,
       c.gender
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
      `Найдено ТС: ${vehicle.brand} ${vehicle.model}, владелец: ${vehicle.owner_name}`
    ]);
    
    res.json({
      success: true,
      vehicle: {
        id: vehicle.id,
        plateNumber: vehicle.plate_number,
        brand: vehicle.brand,
        model: vehicle.model,
        year: vehicle.year,
        vin: vehicle.vin,
        color: vehicle.color,
        engine_number: vehicle.engine_number,
        registration_date: vehicle.registration_date,
        ownerName: vehicle.owner_name,
        birthDate: vehicle.birth_date,
        passportSeries: vehicle.passport_series,
        passportNumber: vehicle.passport_number,
        passportIusseBy: vehicle.passport_issued_by,
        passportTusseDate: vehicle.passport_issue_date,
        gender: vehicle.gender,
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
app.get('/api/smp/calls', authenticate, async (req, res) => {
  try {
    const [calls] = await pool.query(`
      SELECT 
        ec.*,
        CONCAT(up.last_name, ' ', up.first_name) as officer_name,
        up.rank as officer_rank,
        up.badge_number as officer_badge
      FROM emergency_calls ec
      LEFT JOIN user_profiles up ON ec.assigned_officer = up.user_id
      WHERE ec.emergency_type IN ('fire', 'rescue', 'chemical', 'medical')
      ORDER BY ec.call_time DESC
      LIMIT 100
    `);
    
    res.json({ success: true, calls });
  } catch (error) {
    console.error('MCHS calls error:', error);
    res.status(500).json({ success: false, error: 'Ошибка загрузки вызовов' });
  }
});
// Маршруты для пожарных вызовов
app.get('/api/mchs/calls', authenticate, async (req, res) => {
  try {
    const [calls] = await pool.query(`
      SELECT 
        ec.*,
        CONCAT(up.last_name, ' ', up.first_name) as officer_name,
        up.rank as officer_rank,
        up.badge_number as officer_badge
      FROM emergency_calls ec
      LEFT JOIN user_profiles up ON ec.assigned_officer = up.user_id
      WHERE ec.emergency_type IN ('fire', 'rescue', 'chemical', 'gas_leak')
      ORDER BY ec.call_time DESC
      LIMIT 100
    `);
    
    res.json({ success: true, calls });
  } catch (error) {
    console.error('MCHS calls error:', error);
    res.status(500).json({ success: false, error: 'Ошибка загрузки вызовов' });
  }
});

// Принятие вызова пожарным
app.put('/api/mchs/calls/:id/assign', authenticate, async (req, res) => {
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
      : 'Сотрудник МЧС';

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


// Завершение вызова с отчетом (специфичный для МЧС)
app.post('/api/mchs/calls/:id/complete', authenticate, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.query('START TRANSACTION');

    const { 
      actions_taken, 
      casualties = '[]', 
      fire_area, 
      equipment_used = '[]', 
      conclusion 
    } = req.body;

    if (!actions_taken || !conclusion || !fire_area) {
      throw new Error('Не заполнены обязательные поля: actions_taken, fire_area и conclusion');
    }

    // Подготовка данных отчета
    const reportData = {
      actions: actions_taken.trim(),
      casualties: safeJsonParse(casualties),
      fire_area: fire_area,
      equipment_used: safeJsonParse(equipment_used),
      conclusion: conclusion.trim(),
      officer: {
        id: req.user.id,
        name: req.user.name,
        rank: req.user.rank
      },
      completion_time: new Date()
    };

    // Проверка существования вызова
    const [call] = await connection.query(
      `SELECT id FROM emergency_calls 
       WHERE id = ? AND status != 'completed' FOR UPDATE`,
      [req.params.id]
    );

    if (!call.length) {
      throw new Error('Вызов не найден или уже завершен');
    }

    // Сохранение отчета
    const [reportResult] = await connection.query(
      `INSERT INTO emergency_call_reports 
       (call_id, officer_id, report_type, report_data) 
       VALUES (?, ?, 'fire_report', ?)`,
      [req.params.id, req.user.id, JSON.stringify(reportData)]
    );

    // Обновление статуса вызова
    await connection.query(
      `UPDATE emergency_calls 
       SET status = 'completed',
           completion_time = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [reportData.completion_time, req.params.id]
    );

    // Системное уведомление
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
    res.status(400).json({ 
      success: false, 
      error: error.message
    });
  } finally {
    connection.release();
  }
});
app.get('/api/mchs/calls/:id', authenticate, async (req, res) => {
  try {
    const [call] = await pool.query(`
      SELECT 
        ec.*,
        CONCAT(up.first_name, ' ', up.last_name) as officer_name,
        up.rank as officer_rank,
        up.badge_number as officer_badge,
        up.department as officer_department
      FROM emergency_calls ec
      LEFT JOIN user_profiles up ON ec.assigned_officer = up.user_id
      WHERE ec.id = ? AND ec.emergency_type IN ('fire', 'rescue', 'chemical')
    `, [req.params.id]);

    if (call.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Вызов не найден' 
      });
    }

    // Безопасный парсинг JSON данных
    const safeParse = (data) => {
      if (!data) return null;
      try {
        return typeof data === 'string' ? JSON.parse(data) : data;
      } catch (e) {
        console.error('JSON parse error:', e);
        return null;
      }
    };

    const response = {
      ...call[0],
      participants: safeParse(call[0].participants) || [],
      vehicles: safeParse(call[0].vehicles) || [],
      damages: safeParse(call[0].damages) || []
    };

    res.json({ 
      success: true, 
      call: response 
    });

  } catch (error) {
    console.error('Error fetching call:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при получении вызова',
      details: process.env.NODE_ENV === 'development' ? error.message : null
    });
  }
});
// Добавить в бекенд (в раздел routes после других user routes)
// Получить Telegram данные пользователя
app.get('/api/user/telegram', authenticate, async (req, res) => {
  try {
    const [user] = await pool.query(
      'SELECT telegram_id, telegram_username FROM users WHERE id = ?',
      [req.user.id]
    );
    
    res.json({
      success: true,
      telegram: {
        id: user[0]?.telegram_id || null,
        username: user[0]?.telegram_username || null
      }
    });
  } catch (error) {
    console.error('Get Telegram data error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch Telegram data' 
    });
  }
});

// Привязать Telegram аккаунт
app.post('/api/user/link-telegram', authenticate, async (req, res) => {
  try {
    const { telegramId, telegramUsername } = req.body;
    
    if (!telegramId) {
      return res.status(400).json({
        success: false,
        error: 'Telegram ID is required'
      });
    }

    await pool.query(
      'UPDATE users SET telegram_id = ?, telegram_username = ? WHERE id = ?',
      [telegramId, telegramUsername, req.user.id]
    );

    // Отправить тестовое сообщение через бота
    try {
      await axios.post(`${process.env.TELEGRAM_BOT_URL}/send-notification`, {
        chatId: telegramId,
        message: '🔔 Ваш аккаунт успешно привязан к системе!'
      });
    } catch (botError) {
      console.error('Failed to send Telegram notification:', botError);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Link Telegram error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to link Telegram account' 
    });
  }
});

// Отвязать Telegram аккаунт
app.post('/api/user/unlink-telegram', authenticate, async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET telegram_id = NULL, telegram_username = NULL WHERE id = ?',
      [req.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Unlink Telegram error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to unlink Telegram account' 
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









// Получение заявлений по статусу (для сотрудников)
app.get('/api/statements/by-status', authenticate, async (req, res) => {
  try {
    const { status } = req.query;
    const validStatuses = ['draft', 'pending_signature', 'signed', 'registered', 'processing', 'completed', 'rejected'];
    
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Укажите корректный статус' 
      });
    }

    const [statements] = await pool.query(
      `SELECT 
        s.id, s.type, s.content, s.status,
        s.created_at, s.kusp_number,
        CONCAT(up.first_name, ' ', up.last_name) as employee_name,
        up.department as employee_department,
        s.citizen_fio as citizen_name,
        ss.signed_at
       FROM statements s
       JOIN user_profiles up ON s.employee_id = up.user_id
       LEFT JOIN statement_signatures ss ON s.id = ss.statement_id
       WHERE s.status = ?
       ORDER BY s.created_at DESC`,
      [status]
    );

    res.json({ 
      success: true, 
      statements 
    });
  } catch (error) {
    console.error('Get statements error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при получении заявлений' 
    });
  }
});
// Статистика заявлений
app.get('/api/statements/stats', authenticate, async (req, res) => {
  try {
    const [stats] = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(status = 'registered') as registered,
        SUM(status = 'processing') as processing,
        SUM(status = 'completed') as completed
      FROM statements
    `);

    const [recent] = await pool.query(`
      SELECT id, type, status, citizen_fio, created_at
      FROM statements
      ORDER BY created_at DESC
      LIMIT 5
    `);

    res.json({ 
      success: true,
      ...stats[0],
      recent
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ success: false, error: 'Ошибка получения статистики' });
  }
});

// Поиск заявлений
app.get('/api/statements/search', authenticate, async (req, res) => {
  try {
    const { query } = req.query;
    
    const [statements] = await pool.query(`
      SELECT 
        s.id, s.type, s.status, s.created_at, s.kusp_number,
        s.citizen_fio, s.citizen_passport,
        CONCAT(u.first_name, ' ', u.last_name) as employee_name
      FROM statements s
      JOIN user_profiles u ON s.employee_id = u.user_id
      WHERE 
        s.id LIKE ? OR
        s.kusp_number LIKE ? OR
        s.citizen_fio LIKE ? OR
        s.citizen_passport LIKE ?
      ORDER BY s.created_at DESC
      LIMIT 20
    `, [`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`]);

    res.json({ 
      success: true,
      statements
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ success: false, error: 'Ошибка поиска' });
  }
});
async function sendUserNotification(userId, kuspNumber, status, notes = '') {
  try {
    const statusText = {
      'registered': '🆕 Зарегистрирован',
      'processing': '🔄 В работе',
      'completed': '✅ Завершён',
      'rejected': '❌ Отклонён'
    }[status] || status;

    const message = `📢 *Обновление статуса КУСП ${kuspNumber}*\n\n` +
      `Новый статус: *${statusText}*\n` +
      (notes ? `Комментарий: ${notes}` : '');

    await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Notification error:', error);
    // Можно добавить дополнительную обработку ошибок отправки
  }
}
app.post('/api/kusp/:number/status', authenticate, async (req, res) => {
  try {
    const { status, officer_id, notes } = req.body;
    const validStatuses = ['registered', 'processing', 'completed', 'rejected'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Недопустимый статус' 
      });
    }

    // Получаем текущий статус перед обновлением
    const [currentKusp] = await pool.query(
      `SELECT status FROM kusp_records WHERE kusp_number = ?`,
      [req.params.number]
    );

    // Обновляем статус
    await pool.query(
      `UPDATE kusp_records SET 
       status = ?,
       officer_id = ?,
       notes = ?,
       updated_at = NOW()
       WHERE kusp_number = ?`,
      [status, officer_id, notes, req.params.number]
    );

    // Очищаем кэш
    kuspCache.del(req.params.number);

    // Получаем данные для уведомления
    const [kuspData] = await pool.query(
      `SELECT 
        k.*,
        ss.telegram_id as user_id,
        ss.message_id,
        s.citizen_fio
      FROM kusp_records k
      JOIN statements s ON k.statement_id = s.id
      LEFT JOIN statement_signatures ss ON s.id = ss.statement_id
      WHERE k.kusp_number = ?`,
      [req.params.number]
    );

    if (kuspData.length > 0) {
      const kusp = kuspData[0];
      
      // Отправляем уведомление через бота только если статус изменился
      if (!currentKusp.length || currentKusp[0].status !== status) {
        // Уведомление пользователю
        if (kusp.user_id) {
          await sendUserNotification(
            kusp.user_id,
            req.params.number,
            status,
            notes
          );
          
          // Обновляем сообщение с информацией о КУСП, если оно есть
          if (kusp.message_id) {
            try {
              const updatedKusp = {
                ...kusp,
                status: status,
                notes: notes || kusp.notes,
                officer_id: officer_id || kusp.officer_id
              };
              
              await updateBotMessage(
                kusp.user_id,
                kusp.message_id,
                updatedKusp
              );
            } catch (updateError) {
              console.error('Failed to update message:', updateError);
            }
          }
        }

        // Уведомление сотруднику, если он указан и это не тот, кто менял статус
        if (officer_id && officer_id !== req.user.id) {
          const [officer] = await pool.query(
            `SELECT telegram_id FROM user_profiles WHERE user_id = ?`,
            [officer_id]
          );
          
          if (officer.length > 0 && officer[0].telegram_id) {
            await sendOfficerNotification(
              officer[0].telegram_id,
              req.params.number,
              status,
              notes,
              kusp.citizen_fio
            );
          }
        }
      }
    }

    res.json({ 
      success: true,
      message: 'Статус обновлён'
    });
  } catch (error) {
    console.error('Update KUSP status error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при обновлении статуса' 
    });
  }
});
async function sendOfficerNotification(chatId, kuspNumber, status, notes = '', citizenName = '') {
  try {
    const statusText = {
      'registered': '🆕 Зарегистрирован',
      'processing': '🔄 Назначен вам в работу',
      'completed': '✅ Завершён',
      'rejected': '❌ Отклонён'
    }[status] || status;

    const message = `📢 *Назначение КУСП ${kuspNumber}*\n\n` +
      `Новый статус: *${statusText}*\n` +
      (citizenName ? `Гражданин: *${citizenName}*\n` : '') +
      (notes ? `Комментарий: ${notes}\n\n` : '\n') +
      `Для работы с заявлением используйте команду:\n` +
      `/kusp ${kuspNumber}`;

    await bot.sendMessage(chatId, message, { 
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { 
            text: 'Перейти к КУСП', 
            callback_data: `show_kusp_${kuspNumber}`
          }
        ]]
      }
    });
  } catch (error) {
    console.error('Officer notification error:', error);
  }
}
// Изменение статуса
app.post('/api/statements/:id/status', authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['registered', 'processing', 'completed', 'rejected'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Некорректный статус' });
    }

    await pool.query(
      `UPDATE statements SET status = ? WHERE id = ?`,
      [status, req.params.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Status update error:', error);
    res.status(500).json({ success: false, error: 'Ошибка обновления статуса' });
  }
});

const NodeCache = require('node-cache');
const kuspCache = new NodeCache({ stdTTL: 300, checkperiod: 120 });
app.get('/api/kusp/:number', async (req, res) => {
  try {
    const cachedKusp = kuspCache.get(req.params.number);
    if (cachedKusp) {
      return res.json({ success: true, fromCache: true, kusp: cachedKusp });
    }

    const [kusp] = await pool.query(
      `SELECT 
        k.*,
        s.type as statement_type,
        s.content as statement_content,
        CONCAT(up.first_name, ' ', up.last_name) as officer_name,
        up.rank as officer_rank,
        ss.telegram_id as user_id
      FROM kusp_records k
      JOIN statements s ON k.statement_id = s.id
      LEFT JOIN user_profiles up ON k.officer_id = up.user_id
      LEFT JOIN statement_signatures ss ON s.id = ss.statement_id
      WHERE k.kusp_number = ?`,
      [req.params.number]
    );

    if (kusp.length === 0) {
      return res.status(404).json({ success: false, error: 'КУСП не найден' });
    }

    kuspCache.set(req.params.number, kusp[0]);
    res.json({ success: true, fromCache: false, kusp: kusp[0] });
  } catch (error) {
    console.error('Check KUSP error:', error);
    res.status(500).json({ success: false, error: 'Ошибка при проверке КУСП' });
  }
});
// Создание заявления сотрудником
app.post('/api/statements', authenticate, async (req, res) => {
  try {
    const { type, content, citizenId, citizenFio, citizenPassport } = req.body;

    // Проверка, что сотрудник заполнил обязательные поля
    if (!type || !content) {
      return res.status(400).json({ 
        success: false, 
        error: 'Тип и содержание заявления обязательны' 
      });
    }

    const [result] = await pool.query(
      `INSERT INTO statements SET ?`, {
        employee_id: req.user.id,
        citizen_id: citizenId || null,
        citizen_fio: citizenFio || null,
        citizen_passport: citizenPassport || null,
        type,
        content,
        status: citizenId ? 'pending_signature' : 'draft'
      }
    );

    res.json({ 
      success: true, 
      statementId: result.insertId,
      needsSignature: !!citizenId
    });
  } catch (error) {
    console.error('Create statement error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при создании заявления' 
    });
  }
});

// Получение заявления для подписания (для Telegram бота)
app.get('/api/statements/:id/for-signature', async (req, res) => {
  try {
    const [statements] = await pool.query(
      `SELECT 
        s.id, s.type, s.content, 
        s.citizen_id, s.citizen_fio, s.citizen_passport,
        CONCAT(u.first_name, ' ', u.last_name) as employee_name,
        u.department as employee_department
      FROM statements s
      JOIN user_profiles u ON s.employee_id = u.user_id
      WHERE s.id = ? AND s.status = 'pending_signature'`,
      [req.params.id]
    );

    if (statements.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Заявление не найдено или уже подписано' 
      });
    }

    res.json({ 
      success: true, 
      statement: statements[0] 
    });
  } catch (error) {
    console.error('Get statement for signature error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при получении заявления' 
    });
  }
});

// Проверка статуса КУСП
app.get('/api/kusp/:number', async (req, res) => {
  try {
    const [kusp] = await pool.query(
      `SELECT 
        k.*,
        s.type as statement_type,
        s.content as statement_content,
        CONCAT(up.first_name, ' ', up.last_name) as officer_name,
        up.rank as officer_rank
      FROM kusp_records k
      JOIN statements s ON k.statement_id = s.id
      LEFT JOIN user_profiles up ON k.officer_id = up.user_id
      WHERE k.kusp_number = ?`,
      [req.params.number]
    );

    if (kusp.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'КУСП не найден' 
      });
    }

    res.json({ 
      success: true, 
      kusp: kusp[0] 
    });
  } catch (error) {
    console.error('Check KUSP error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при проверке КУСП' 
    });
  }
});
// Дополнения к существующему бекенду

// Получение последнего КУСП для пользователя
app.get('/api/kusp/last', async (req, res) => {
  try {
    const { user_id } = req.query;
    
    if (!user_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'ID пользователя обязательно' 
      });
    }

    const [kusp] = await pool.query(
      `SELECT k.kusp_number
       FROM kusp_records k
       JOIN statement_signatures ss ON k.statement_id = ss.statement_id
       WHERE ss.citizen_id = ? OR ss.telegram_id = ?
       ORDER BY k.created_at DESC
       LIMIT 1`,
      [user_id, user_id]
    );

    if (kusp.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'КУСП не найден' 
      });
    }

    res.json({ 
      success: true, 
      kusp_number: kusp[0].kusp_number 
    });
  } catch (error) {
    console.error('Get last KUSP error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при получении КУСП' 
    });
  }
});

// Получение заявлений, ожидающих подписания
app.get('/api/statements/pending', async (req, res) => {
  try {
    const { user_id } = req.query;
    
    if (!user_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'ID пользователя обязательно' 
      });
    }

    const [statements] = await pool.query(
      `SELECT s.id
       FROM statements s
       JOIN statement_signatures ss ON s.id = ss.statement_id
       WHERE (ss.citizen_id = ? OR ss.telegram_id = ?)
       AND s.status = 'pending_signature'
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [user_id, user_id]
    );

    if (statements.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Нет заявлений для подписания' 
      });
    }

    res.json({ 
      success: true, 
      statement_id: statements[0].id 
    });
  } catch (error) {
    console.error('Get pending statements error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при получении заявлений' 
    });
  }
});

// Обновление статуса КУСП
// Получение списка заявлений по статусу
app.get('/api/statements', async (req, res) => {
  try {
    const { status } = req.query;
    const validStatuses = ['draft', 'pending_signature', 'signed', 'registered', 'processing', 'completed', 'rejected'];
    
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Укажите корректный статус' 
      });
    }

    const [statements] = await pool.query(
      `SELECT 
        s.id, s.type, s.content, s.status,
        s.created_at, s.kusp_number,
        CONCAT(up.first_name, ' ', up.last_name) as employee_name,
        up.department as employee_department,
        s.citizen_fio as citizen_name,
        ss.signed_at
       FROM statements s
       JOIN user_profiles up ON s.employee_id = up.user_id
       LEFT JOIN statement_signatures ss ON s.id = ss.statement_id
       WHERE s.status = ?
       ORDER BY s.created_at DESC`,
      [status]
    );

    res.json({ 
      success: true, 
      statements 
    });
  } catch (error) {
    console.error('Get statements error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при получении заявлений' 
    });
  }
});

// Доработка эндпоинта подписания заявления для работы с Telegram
app.post('/api/statements/:id/sign', async (req, res) => {
  try {
    const { passport, birth_date, user_id, user_info, signature_data } = req.body;

    // 1. Проверка обязательных полей
    if (!signature_data) {
      return res.status(400).json({ 
        success: false, 
        error: 'Данные подписи обязательны' 
      });
    }

    // 2. Проверяем существование заявления
    const [statement] = await pool.query(
      `SELECT id, citizen_id 
       FROM statements 
       WHERE id = ? AND status = 'pending_signature'`,
      [req.params.id]
    );

    if (!statement.length) {
      return res.status(404).json({ 
        success: false, 
        error: 'Заявление не найдено или уже подписано' 
      });
    }

    const stmt = statement[0];
    let citizenId = stmt.citizen_id;

    // 3. Если заявление не привязано к гражданину - ищем по паспорту
    if (!citizenId) {
      if (!passport || !birth_date) {
        return res.status(400).json({ 
          success: false, 
          error: 'Для неподписанных заявлений требуются паспортные данные и дата рождения' 
        });
      }

      const [citizen] = await pool.query(
        `SELECT id FROM citizens 
         WHERE CONCAT(passport_series, passport_number) = ?
         AND birth_date = STR_TO_DATE(?, '%d.%m.%Y')`,
        [passport.replace(/\s/g, ''), birth_date]
      );

      if (!citizen.length) {
        return res.status(400).json({ 
          success: false, 
          error: 'Гражданин с указанными данными не найден' 
        });
      }
      citizenId = citizen[0].id;
    }

    // 4. Сохраняем подпись
    const [result] = await pool.query(
      `INSERT INTO statement_signatures SET ?`, {
        statement_id: req.params.id,
        citizen_id: citizenId,
        telegram_id: user_id,
        user_info: JSON.stringify(user_info),
        signature_data: signature_data,
        signed_at: new Date()
      }
    );

    // 5. Обновляем статус заявления
    await pool.query(
      `UPDATE statements SET status = 'signed' WHERE id = ?`,
      [req.params.id]
    );

    // 6. Генерируем КУСП
    const kuspNumber = `КУСП-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;
    
    await pool.query(
      `INSERT INTO kusp_records SET ?`, {
        statement_id: req.params.id,
        kusp_number: kuspNumber,
        status: 'registered'
      }
    );

    res.json({ 
      success: true,
      kuspNumber,
      message: 'Заявление успешно подписано и зарегистрировано'
    });

  } catch (error) {
    console.error('Sign statement error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка при подписании заявления',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
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