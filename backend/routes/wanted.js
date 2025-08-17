const express = require('express');
const router = express.Router();
const upload = require('../config/multer');

router.post('/persons', authenticate, upload.single('photo'), async (req, res) => {
  // Ваш существующий код обработчика
});

module.exports = router;