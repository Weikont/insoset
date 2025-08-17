const TelegramBot = require('node-telegram-bot-api')
const axios = require('axios')
const express = require('express');
// Замените на ваш токен
const token = '7998396251:AAEJr6H-KGY2eA4Y0s1bOwDc3fEiD80uxXE'
const bot = new TelegramBot(token, { polling: true })
const app = express();
// Обработчик команды /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id
  const username = msg.from.username
  
  try {
    // Проверяем, есть ли пользователь в системе
    const response = await axios.post(`${process.env.API_URL}/api/check-telegram-user`, {
      telegramId: userId,
      telegramUsername: username
    })
    
    if (response.data.exists) {
      // Предлагаем привязать аккаунт
      bot.sendMessage(chatId, '🔐 Для привязки аккаунта введите код из приложения:')
    } else {
      bot.sendMessage(chatId, '❌ Ваш аккаунт не найден в системе. Пожалуйста, зарегистрируйтесь сначала в веб-приложении.')
    }
  } catch (error) {
    console.error('Error checking user:', error)
    bot.sendMessage(chatId, '⚠️ Произошла ошибка. Пожалуйста, попробуйте позже.')
  }
})

// API endpoint для отправки уведомлений
app.post('/send-notification', async (req, res) => {
  try {
    const { chatId, message } = req.body
    await bot.sendMessage(chatId, message)
    res.json({ success: true })
  } catch (error) {
    console.error('Failed to send notification:', error)
    res.status(500).json({ success: false, error: 'Failed to send message' })
  }
})