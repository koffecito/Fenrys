export const MESSAGES = {
  pmCaptcha: (userName, chatTitle, chatLink) => 
    `👋 Привет, <b>${userName}</b>!\n\n` +
    `Вы подали заявку на вступление в группу <a href="${chatLink}">${chatTitle}</a>.\n\n` +
    `🤖 Для одобрения заявки, пожалуйста, подтвердите, что вы не робот.`,

  groupCaptcha: (userId, userName) => 
    `👋 Добро пожаловать, <a href="tg://user?id=${userId}">${userName}</a>!\n\n` +
    `🛡 Пожалуйста, подтвердите, что вы не робот, чтобы получить возможность писать сообщения.`,

  verifyButton: "✅ Я не робот (Подтвердить)",
  successVerify: "🎉 <b>Верификация успешно пройдена!</b>\nДобро пожаловать в чат.",
  wrongUser: "❌ Эта кнопка предназначена не для вас.",
  alertSuccess: "✅ Готово! Ваша заявка одобрена.",

  statsHeader: "📊 <b>Статистика принятых заявок:</b>\n\n",
  statsDay: (count) => `• За 24 часа: <b>${count}</b>\n`,
  statsWeek: (count) => `• За 7 дней: <b>${count}</b>\n`,
  statsTotal: (count) => `• За все время: <b>${count}</b>`,

  modePmText: "Личные сообщения (с капчей)",
  modeFreeText: "Свободный (с мутом в группе)",
  modeChanged: (modeName) => `⚙️ Режим чата изменен на: <b>${modeName}</b>`,
  chatsListTitle: "📋 <b>Выберите чат для настройки режима:</b>",
  noChats: "⚠️ Бот пока не добавлен ни в один чат в качестве администратора.",

  blacklisted: (userId) => `🚫 Пользователь <code>${userId}</code> успешно добавлен в черный список.`
};
