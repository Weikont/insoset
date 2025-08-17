const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

module.exports = {
  sendKuspStatusUpdate: async (userId, kuspNumber, status, notes = '') => {
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
      return true;
    } catch (error) {
      console.error('Notification error:', error);
      return false;
    }
  }
};