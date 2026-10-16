import { Hono } from 'hono'

const app = new Hono()

function isOwner(userId, env) {
  return Number(userId) === Number(env.OWNER_ID)
}

app.get('/', (c) => c.text('Bot is running!'))

app.post('/', async (c) => {
  try {
    const update = await c.req.json()
    const botToken = c.env.TELEGRAM_BOT_TOKEN
    const db = c.env.DB

    // 1. Защита от добавления в посторонние чаты
    if (update.my_chat_member) {
      const mcm = update.my_chat_member
      const chatId = mcm.chat.id
      const user = mcm.from
      const newStatus = mcm.new_chat_member.status

      if (['group', 'supergroup'].includes(mcm.chat.type)) {
        if (['member', 'administrator'].includes(newStatus)) {
          if (!isOwner(user.id, env)) {
            await fetch(`https://api.telegram.org/bot${botToken}/leaveChat?chat_id=${chatId}`)
            return c.text('Left unauthorized chat')
          } else {
            await db.prepare(
              `INSERT INTO chats (chat_id, title, mode) VALUES (?, ?, 'pm') 
               ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title`
            ).bind(chatId, mcm.chat.title || 'Chat').run()
          }
        }
      }
      return c.text('OK')
    }

    // 2. Отслеживание ручного одобрения владельцем
    if (update.chat_member) {
      const cm = update.chat_member
      const chatId = cm.chat.id
      const userId = cm.new_chat_member.user.id
      const newStatus = cm.new_chat_member.status

      if (newStatus === 'member') {
        const pendingReq = await db.prepare(
          `SELECT * FROM join_requests WHERE chat_id = ? AND user_id = ? AND status = 'pending'`
        ).bind(chatId, userId).first()

        if (pendingReq) {
          await db.prepare(`UPDATE join_requests SET status = 'approved' WHERE id = ?`).bind(pendingReq.id).run()

          if (pendingReq.message_id) {
            try {
              await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: userId, message_id: pendingReq.message_id })
              })
            } catch (e) {}
          }

          try {
            await sendTelegram(botToken, 'sendMessage', {
              chat_id: userId,
              text: '✅ Ваша заявка на вступление в чат была одобрена администратором!'
            })
          } catch (e) {}
        }
      }
      return c.text('OK')
    }

    // 3. Команды владельца
    if (update.message) {
      const msg = update.message
      const userId = msg.from.id
      const chatId = msg.chat.id
      const text = msg.text || ''

      if (msg.chat.type === 'private' && !isOwner(userId, env)) {
        return c.text('Ignored')
      }

      if (isOwner(userId, env)) {
        if (text.startsWith('/mode')) {
          const parts = text.split(' ')
          const newMode = parts[1]
          if (['pm', 'free'].includes(newMode)) {
            if (msg.chat.type === 'private') {
              await sendTelegram(botToken, 'sendMessage', {
                chat_id: chatId,
                text: 'Для смены режима конкретного чата используйте команду /chats в ЛС.'
              })
            } else {
              await db.prepare(`UPDATE chats SET mode = ? WHERE chat_id = ?`).bind(newMode, chatId).run()
              await sendTelegram(botToken, 'sendMessage', {
                chat_id: chatId,
                text: `✅ Режим чата успешно изменен на: <b>${newMode === 'pm' ? 'Личные сообщения' : 'Свободный (с мьютом)'}</b>`,
                parse_mode: 'HTML'
              })
            }
          } else {
            await sendTelegram(botToken, 'sendMessage', {
              chat_id: chatId,
              text: 'Использование: /mode pm ИЛИ /mode free'
            })
          }
          return c.text('OK')
        }

        if (text.startsWith('/stats')) {
          const targetChatId = msg.chat.type === 'private' ? null : chatId
          
          let statsQuery = `
            SELECT 
              SUM(CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 end) as day_1,
              SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 end) as days_7,
              COUNT(*) as total
            FROM join_requests 
            WHERE status = 'approved'
          `
          let params = []
          if (targetChatId) {
            statsQuery += ` AND chat_id = ?`
            params.push(targetChatId)
          }

          const stats = await db.prepare(statsQuery).bind(...params).first()

          const responseText = `📊 <b>Статистика принятых заявок:</b>\n\n` +
            `• За последние 24 часа: <b>${stats.day_1 || 0}</b>\n` +
            `• За последние 7 дней: <b>${stats.days_7 || 0}</b>\n` +
            `• За все время: <b>${stats.total || 0}</b>`

          await sendTelegram(botToken, 'sendMessage', {
            chat_id: chatId,
            text: responseText,
            parse_mode: 'HTML'
          })
          return c.text('OK')
        }

        if (text === '/chats' && msg.chat.type === 'private') {
          const { results: chats } = await db.prepare(`SELECT * FROM chats`).all()
          if (!chats || chats.length === 0) {
            await sendTelegram(botToken, 'sendMessage', { chat_id: chatId, text: 'Бот пока не добавлен ни в один чат.' })
            return c.text('OK')
          }

          let inlineKeyboard = []
          for (const chat of chats) {
            inlineKeyboard.push([{
              text: `${chat.title} [Режим: ${chat.mode}]`,
              callback_data: `cfg_chat_${chat.chat_id}`
            }])
          }

          await sendTelegram(botToken, 'sendMessage', {
            chat_id: chatId,
            text: 'Выберите чат для настройки режима:',
            reply_markup: { inline_keyboard: inlineKeyboard }
          })
          return c.text('OK')
        }

        if (text.startsWith('/ban')) {
          const parts = text.split(' ')
          const banUserId = parts[1]
          if (banUserId) {
            await db.prepare(`INSERT OR IGNORE INTO blacklist (user_id) VALUES (?)`).bind(banUserId).run()
            await sendTelegram(botToken, 'sendMessage', { chat_id: chatId, text: `🚫 Пользователь ${banUserId} добавлен в черный список.` })
          }
          return c.text('OK')
        }
      }
    }

    // 4. Обработка нажатий на инлайн-кнопку капчи
    if (update.callback_query) {
      const cb = update.callback_query
      const data = cb.data
      const userId = cb.from.id
      const message = cb.message

      if (data.startsWith('cfg_chat_') && isOwner(userId, env)) {
        const targetChatId = data.replace('cfg_chat_', '')
        const chat = await db.prepare(`SELECT * FROM chats WHERE chat_id = ?`).bind(targetChatId).first()
        
        if (chat) {
          const nextMode = chat.mode === 'pm' ? 'free' : 'pm'
          await db.prepare(`UPDATE chats SET mode = ? WHERE chat_id = ?`).bind(nextMode, targetChatId).run()

          await sendTelegram(botToken, 'answerCallbackQuery', {
            callback_query_id: cb.id,
            text: `Режим чата "${chat.title}" изменен на ${nextMode}`
          })

          const { results: chats } = await db.prepare(`SELECT * FROM chats`).all()
          let inlineKeyboard = []
          for (const ch of chats) {
            inlineKeyboard.push([{
              text: `${ch.title} [Режим: ${ch.mode}]`,
              callback_data: `cfg_chat_${ch.chat_id}`
            }])
          }
          await sendTelegram(botToken, 'editMessageReplyMarkup', {
            chat_id: userId,
            message_id: message.message_id,
            reply_markup: { inline_keyboard: inlineKeyboard }
          })
        }
        return c.text('OK')
      }

      if (data.startsWith('verify_')) {
        const parts = data.split('_')
        const targetChatId = parts[1]
        const targetUserId = Number(parts[2])

        if (userId !== targetUserId) {
          await sendTelegram(botToken, 'answerCallbackQuery', {
            callback_query_id: cb.id,
            text: 'Эта кнопка не для вас!',
            show_alert: true
          })
          return c.text('OK')
        }

        await db.prepare(`INSERT OR IGNORE INTO verified_users (user_id) VALUES (?)`).bind(userId).run()

        await fetch(`https://api.telegram.org/bot${botToken}/approveChatJoinRequest?chat_id=${targetChatId}&user_id=${userId}`)

        await db.prepare(`UPDATE join_requests SET status = 'approved' WHERE chat_id = ? AND user_id = ? AND status = 'pending'`).bind(targetChatId, userId).run()

        const chatConfig = await db.prepare(`SELECT mode FROM chats WHERE chat_id = ?`).bind(targetChatId).first()
        if (chatConfig && chatConfig.mode === 'free') {
          await fetch(`https://api.telegram.org/bot${botToken}/restrictChatMember`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: targetChatId,
              user_id: userId,
              permissions: {
                can_send_messages: true,
                can_send_media_messages: true,
                can_send_other_messages: true,
                can_add_web_page_previews: true
              }
            })
          })

          if (message) {
            await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage?chat_id=${targetChatId}&message_id=${message.message_id}`)
          }
        }

        await sendTelegram(botToken, 'answerCallbackQuery', {
          callback_query_id: cb.id,
          text: '✅ Успешно! Заявка одобрена.'
        })

        if (message) {
          await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: message.chat.id, message_id: message.message_id })
          })
          await sendTelegram(botToken, 'sendMessage', {
            chat_id: userId,
            text: '✅ Верификация успешно пройдена! Добро пожаловать в чат.'
          })
        }

        return c.text('OK')
      }
    }

    // 5. Обработка заявок на вступление
    if (update.chat_join_request) {
      const request = update.chat_join_request
      const userId = request.from.id
      const chatId = request.chat.id
      const userName = request.from.first_name || 'Пользователь'

      const isBlacklisted = await db.prepare(`SELECT * FROM blacklist WHERE user_id = ?`).bind(userId).first()
      if (isBlacklisted) {
        await fetch(`https://api.telegram.org/bot${botToken}/declineChatJoinRequest?chat_id=${chatId}&user_id=${userId}`)
        await db.prepare(`INSERT INTO join_requests (chat_id, user_id, username, status) VALUES (?, ?, ?, 'blacklisted')`).bind(chatId, userId, userName).run()
        return c.text('Declined due to blacklist')
      }

      // Если пользователь подтверждал себя ранее (2+ раз / доверенный)
      const alreadyVerified = await db.prepare(`SELECT * FROM verified_users WHERE user_id = ?`).bind(userId).first()
      if (alreadyVerified) {
        await fetch(`https://api.telegram.org/bot${botToken}/approveChatJoinRequest?chat_id=${chatId}&user_id=${userId}`)
        await db.prepare(`INSERT INTO join_requests (chat_id, user_id, username, status) VALUES (?, ?, ?, 'approved')`).bind(chatId, userId, userName).run()
        return c.text('Auto-approved trusted user')
      }

      let chatConfig = await db.prepare(`SELECT mode FROM chats WHERE chat_id = ?`).bind(chatId).first()
      const mode = chatConfig ? chatConfig.mode : 'pm'

      const inlineKeyboard = {
        inline_keyboard: [[
          { text: '🤖 Я не робот (Подтвердить)', callback_data: `verify_${chatId}_${userId}` }
        ]]
      }

      let sentMessageId = null

      if (mode === 'pm') {
        try {
          const sentMsgRes = await sendTelegram(botToken, 'sendMessage', {
            chat_id: userId,
            text: `Привет, ${userName}! Вы подали заявку на вступление в чат. Пожалуйста, подтверрите, что вы не робот, нажав кнопку ниже:`,
            reply_markup: inlineKeyboard
          })
          if (sentMsgRes && sentMsgRes.result) {
            sentMessageId = sentMsgRes.result.message_id
          }
        } catch (e) {}
      } else if (mode === 'free') {
        await fetch(`https://api.telegram.org/bot${botToken}/approveChatJoinRequest?chat_id=${chatId}&user_id=${userId}`)
        
        await fetch(`https://api.telegram.org/bot${botToken}/restrictChatMember`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            user_id: userId,
            permissions: {
              can_send_messages: false,
              can_send_media_messages: false,
              can_send_other_messages: false,
              can_add_web_page_previews: false
            }
          })
        })

        const sentMsgRes = await sendTelegram(botToken, 'sendMessage', {
          chat_id: chatId,
          text: `👋 Добро пожаловать, <a href="tg://user?id=${userId}">${userName}</a>!\n\nВы временно ограничены. Подтверрите, что вы не робот:`,
          parse_mode: 'HTML',
          reply_markup: inlineKeyboard
        })
        if (sentMsgRes && sentMsgRes.result) {
          sentMessageId = sentMsgRes.result.message_id
        }
      }

      await db.prepare(
        `INSERT INTO join_requests (chat_id, user_id, username, message_id, status) VALUES (?, ?, ?, ?, 'pending')`
      ).bind(chatId, userId, userName, sentMessageId).run()
    }

    return c.text('OK')
  } catch (error) {
    console.error('Error handling webhook:', error)
    return c.text('Internal Error', 500)
  }
})

async function sendTelegram(token, method, payload) {
  const url = `https://api.telegram.org/bot${token}/${method}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return await response.json()
}

export default app
        
