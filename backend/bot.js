const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Конфигурация
const config = {
  BOT_TOKEN: '8397535293:AAEsTk9RspKn6kOedJ-HpoNKkyZYH0DrpdM',
  API_URL: 'http://localhost:5000'
};

const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

// Хранилище данных пользователей (временное, лучше использовать БД)
const userData = {};

// Команда старта
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    '👋 Добро пожаловать!\n\n' +
    'Для подписания заявления отправьте:\n' +
    '/sign [номер заявления] [Ваше ФИО]\n\n' +
    'Для проверки статуса:\n' +
    '/status [номер заявления]',
    {
      reply_markup: {
        remove_keyboard: true
      }
    }
  );
});

// Подписание заявления
bot.onText(/\/sign (\d+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const statementId = match[1];
  const userFullName = match[2];

  // Сохраняем ФИО пользователя
  userData[chatId] = { fullName: userFullName };

  try {
    // Запрос на подписание
    const response = await axios.post(`${config.API_URL}/api/statements/${statementId}/sign`, {
      user_id: chatId,
      full_name: userFullName,
      signed_at: new Date().toISOString()
    });

    if (response.data.success) {
      bot.sendMessage(chatId, `✅ Заявление #${statementId} успешно подписано!`);
    } else {
      bot.sendMessage(chatId, `❌ Ошибка: ${response.data.error || 'Неизвестная ошибка'}`);
    }
  } catch (error) {
    console.error('Signing error:', error.response?.data || error.message);
    bot.sendMessage(chatId, '❌ Ошибка при подписании. Попробуйте позже.');
  }
});

// Проверка статуса
bot.onText(/\/status (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const statementId = match[1];

  try {
    const response = await axios.get(`${config.API_URL}/api/statements/${statementId}/status`);
    
    if (response.data.success) {
      const status = response.data.status;
      let statusText = '';
      
      switch(status) {
        case 'signed': statusText = '✅ Подписано'; break;
        case 'processing': statusText = '🔄 В обработке'; break;
        case 'completed': statusText = '✔️ Завершено'; break;
        default: statusText = status;
      }
      
      bot.sendMessage(
        chatId,
        `📋 Статус заявления #${statementId}:\n` +
        `Состояние: ${statusText}\n` +
        `Дата: ${new Date(response.data.date).toLocaleString()}`
      );
    } else {
      bot.sendMessage(chatId, `❌ Ошибка: ${response.data.error || 'Заявление не найдено'}`);
    }
  } catch (error) {
    console.error('Status check error:', error);
    bot.sendMessage(chatId, '❌ Ошибка при проверке статуса.');
  }
});

// Обработка ошибок
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

console.log('Бот запущен. Доступные команды:\n/sign [номер] [ФИО]\n/status [номер]');