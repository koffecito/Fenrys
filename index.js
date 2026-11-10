import { MESSAGES } from './texts.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Bot is running!', { status: 200 })
    }

    try {
      const update = await request.json()
      const botToken = env.TELEGRAM_BOT_TOKEN
      const db = env.DB

      function isOwner(userId) {
        return Number(userId) === Number(env.OWNER_ID)
      }

      if (update.my_chat_member) {
        const mcm = update.my_chat_member
        const chatId = mcm.chat.id
        const user = mcm.from
        const newStatus = mcm.new_chat_member.status

        if (['group', 'supergroup'].includes(mcm.chat.type)) {
          if (['member', 'administrator'].includes(newStatus)) {
            if (!isOwner(user.id)) {
              await fetch(`https://api.telegram.org/bot${botToken}/leaveChat?chat_id=${chatId}`)
              return new Response('OK')
            } else {
              let chatLink = `https://t.me/${mcm.chat.username}`
              if (!mcm.chat.username) {
                try {
                  const inviteRes = await sendTelegram(botToken, 'exportChatInviteLink', { chat_id: chatId })
                  if (inviteRes && inviteRes.result) chatLink = inviteRes.result
                } catch (e) {}
              }

              await db.prepare(
                `INSERT INTO chats (chat_id, title, invite_link, mode) VALUES (?, ?, ?, 'pm') 
                 ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, invite_link = excluded.invite_link`
              ).bind(chatId, mcm.chat.title || 'Chat', chatLink).run()
            }
          }
        }
        return new Response('OK')
      }

      if (update.chat_member) {
        const cm = update.chat_member
        if (['group', 'supergroup'].includes(cm.chat.type) && !cm.via_join_request) {
          const wasOut = ['left', 'kicked'].includes(cm.old_chat_member.status)
          const isIn = cm.new_chat_member.status === 'member'
          if (wasOut && isIn) {
            const chatInfo = await db.prepare(`SELECT * FROM chats WHERE chat_id = ?`).bind(cm.chat.id).first()
            if (chatInfo && chatInfo.mode === 'free') {
              await startFreeCaptcha(botToken, db, cm.chat.id, cm.new_chat_member.user, false)
            }
          }
        }
        return new Response('OK')
      }

      if (update.message) {
        const msg = update.message
        const userId = msg.from.id
        const chatId = msg.chat.id
        const text = msg.text || ''

        if (msg.new_chat_members && ['group', 'supergroup'].includes(msg.chat.type)) {
          const chatInfo = await db.prepare(`SELECT * FROM chats WHERE chat_id = ?`).bind(chatId).first()
          if (chatInfo && chatInfo.mode === 'free') {
            for (const newMember of msg.new_chat_members) {
              await startFreeCaptcha(botToken, db, chatId, newMember, false)
            }
          }
          return new Response('OK')
        }

        if (msg.chat.type === 'private' && !isOwner(userId)) {
          return new Response('OK')
        }

        if (isOwner(userId)) {
          if (text.startsWith('/mode')) {
            const parts = text.split(' ')
            const newMode = parts[1]
            if (['pm', 'free', 'off'].includes(newMode)) {
              if (msg.chat.type === 'private') {
                await sendTelegram(botToken, 'sendMessage', {
                  chat_id: chatId,
                  text: 'Для смены режима конкретного чата используйте команду /chats в ЛС.'
                })
              } else {
                await db.prepare(`UPDATE chats SET mode = ? WHERE chat_id = ?`).bind(newMode, chatId).run()
                const modeName = MESSAGES.modeNames[newMode]
                await sendTelegram(botToken, 'sendMessage', {
                  chat_id: chatId,
                  text: MESSAGES.modeChanged(modeName),
                  parse_mode: 'HTML'
                })
              }
            } else {
              await sendTelegram(botToken, 'sendMessage', {
                chat_id: chatId,
                text: 'Использование: /mode pm, /mode free ИЛИ /mode off'
              })
            }
            return new Response('OK')
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

            const responseText = MESSAGES.statsHeader +
              MESSAGES.statsDay(stats.day_1 || 0) +
              MESSAGES.statsWeek(stats.days_7 || 0) +
              MESSAGES.statsTotal(stats.total || 0)

            await sendTelegram(botToken, 'sendMessage', {
              chat_id: chatId,
              text: responseText,
              parse_mode: 'HTML'
            })
            return new Response('OK')
          }

          if (text === '/chats' && msg.chat.type === 'private') {
            const { results: chats } = await db.prepare(`SELECT * FROM chats`).all()
            if (!chats || chats.length === 0) {
              await sendTelegram(botToken, 'sendMessage', { chat_id: chatId, text: MESSAGES.noChats })
              return new Response('OK')
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
              text: MESSAGES.chatsListTitle,
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: inlineKeyboard }
            })
            return new Response('OK')
          }

          if (text.startsWith('/ban')) {
            const parts = text.split(' ')
            const banUserId = parts[1]
            if (banUserId) {
              await db.prepare(`INSERT OR IGNORE INTO blacklist (user_id) VALUES (?)`).bind(banUserId).run()
              await sendTelegram(botToken, 'sendMessage', { 
                chat_id: chatId, 
                text: MESSAGES.blacklisted(banUserId),
                parse_mode: 'HTML'
              })
            }
            return new Response('OK')
          }

          if (text.startsWith('/unban')) {
            const parts = text.split(' ')
            const unbanUserId = parts[1]
            if (unbanUserId) {
              await db.prepare(`DELETE FROM blacklist WHERE user_id = ?`).bind(unbanUserId).run()
              await sendTelegram(botToken, 'sendMessage', { 
                chat_id: chatId, 
                text: MESSAGES.unblacklisted(unbanUserId),
                parse_mode: 'HTML'
              })
            } else {
              await sendTelegram(botToken, 'sendMessage', { 
                chat_id: chatId, 
                text: '⚠️ Укажите ID: <code>/unban 123456789</code>',
                parse_mode: 'HTML'
              })
            }
            return new Response('OK')
          }

          if (text.startsWith('/unverify')) {
            const parts = text.trim().split(/\s+/)
            const targetId = parts[1]
            if (targetId && /^\d+$/.test(targetId)) {
              await db.prepare(`DELETE FROM verified_users WHERE user_id = ?`).bind(targetId).run()
              await sendTelegram(botToken, 'sendMessage', {
                chat_id: chatId,
                text: MESSAGES.unverified(targetId),
                parse_mode: 'HTML'
              })
            } else {
              await sendTelegram(botToken, 'sendMessage', {
                chat_id: chatId,
                text: '⚠️ Укажите ID: <code>/unverify 123456789</code>',
                parse_mode: 'HTML'
              })
            }
            return new Response('OK')
          }

          if (text === '/unlink') {
            if (msg.chat.type === 'private') {
              await sendTelegram(botToken, 'sendMessage', {
                chat_id: chatId,
                text: 'Команду /unlink нужно использовать внутри группы, которую хотите отвязать.'
              })
            } else {
              await db.prepare(`DELETE FROM chats WHERE chat_id = ?`).bind(chatId).run()
              await sendTelegram(botToken, 'sendMessage', {
                chat_id: chatId,
                text: '🗑 <b>Чат успешно отвязан от бота.</b>',
                parse_mode: 'HTML'
              })
              await fetch(`https://api.telegram.org/bot${botToken}/leaveChat?chat_id=${chatId}`)
            }
            return new Response('OK')
          }
        }
      }

      if (update.callback_query) {
        const cb = update.callback_query
        const data = cb.data
        const userId = cb.from.id
        const message = cb.message

        if (data.startsWith('cfg_chat_') && isOwner(userId)) {
          const targetChatId = data.replace('cfg_chat_', '')
          const chat = await db.prepare(`SELECT * FROM chats WHERE chat_id = ?`).bind(targetChatId).first()
          
          if (chat) {
            const nextMode = { pm: 'free', free: 'off', off: 'pm' }[chat.mode] || 'pm'
            await db.prepare(`UPDATE chats SET mode = ? WHERE chat_id = ?`).bind(nextMode, targetChatId).run()

            await sendTelegram(botToken, 'answerCallbackQuery', {
              callback_query_id: cb.id,
              text: `Режим изменен на ${nextMode}`
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
          return new Response('OK')
        }

        if (data.startsWith('verify_')) {
          const parts = data.split('_')
          const targetChatId = parts[1]
          const targetUserId = Number(parts[2])

          if (userId !== targetUserId) {
            await sendTelegram(botToken, 'answerCallbackQuery', {
              callback_query_id: cb.id,
              text: MESSAGES.wrongUser,
              show_alert: true
            })
            return new Response('OK')
          }

          await db.prepare(`INSERT OR IGNORE INTO verified_users (user_id) VALUES (?)`).bind(userId).run()

          const chatConfig = await db.prepare(`SELECT mode FROM chats WHERE chat_id = ?`).bind(targetChatId).first()
          const chatMode = chatConfig ? chatConfig.mode : 'pm'

          if (chatMode === 'pm') {
            await fetch(`https://api.telegram.org/bot${botToken}/approveChatJoinRequest?chat_id=${targetChatId}&user_id=${userId}`)
          } else {
            await unmuteMember(botToken, targetChatId, userId)
          }

          await db.prepare(`UPDATE join_requests SET status = 'approved' WHERE chat_id = ? AND user_id = ? AND status = 'pending'`).bind(targetChatId, userId).run()

          await sendTelegram(botToken, 'answerCallbackQuery', {
            callback_query_id: cb.id,
            text: MESSAGES.alertSuccess
          })

          if (message) {
            await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: message.chat.id, message_id: message.message_id })
            })
            
            if (chatMode === 'pm') {
              await sendTelegram(botToken, 'sendMessage', {
                chat_id: userId,
                text: MESSAGES.successVerify,
                parse_mode: 'HTML'
              })
            }
          }

          return new Response('OK')
        }
      }

      if (update.chat_join_request) {
        const request = update.chat_join_request
        const userId = request.from.id
        const chatId = request.chat.id
        const userName = request.from.first_name || 'Пользователь'

        const chatModeInfo = await db.prepare(`SELECT mode FROM chats WHERE chat_id = ?`).bind(chatId).first()
        if (chatModeInfo && chatModeInfo.mode === 'off') {
          return new Response('OK')
        }

        const isBlacklisted = await db.prepare(`SELECT * FROM blacklist WHERE user_id = ?`).bind(userId).first()
        if (isBlacklisted) {
          await fetch(`https://api.telegram.org/bot${botToken}/declineChatJoinRequest?chat_id=${chatId}&user_id=${userId}`)
          await db.prepare(`INSERT INTO join_requests (chat_id, user_id, username, status) VALUES (?, ?, ?, 'blacklisted')`).bind(chatId, userId, userName).run()
          return new Response('OK')
        }

        const alreadyVerified = await db.prepare(`SELECT * FROM verified_users WHERE user_id = ?`).bind(userId).first()
        if (alreadyVerified) {
          await fetch(`https://api.telegram.org/bot${botToken}/approveChatJoinRequest?chat_id=${chatId}&user_id=${userId}`)
          await db.prepare(`INSERT INTO join_requests (chat_id, user_id, username, status) VALUES (?, ?, ?, 'approved')`).bind(chatId, userId, userName).run()
          return new Response('OK')
        }

        let chatInfo = await db.prepare(`SELECT * FROM chats WHERE chat_id = ?`).bind(chatId).first()
        const mode = chatInfo ? chatInfo.mode : 'pm'
        const chatTitle = chatInfo ? chatInfo.title : 'наш чат'
        const chatLink = chatInfo && chatInfo.invite_link ? chatInfo.invite_link : `https://t.me/`

        const inlineKeyboard = {
          inline_keyboard: [[
            { text: MESSAGES.verifyButton, callback_data: `verify_${chatId}_${userId}` }
          ]]
        }

        let sentMessageId = null

        if (mode === 'pm') {
          try {
            const sentMsgRes = await sendTelegram(botToken, 'sendMessage', {
              chat_id: userId,
              text: MESSAGES.pmCaptcha(userName, chatTitle, chatLink),
              parse_mode: 'HTML',
              reply_markup: inlineKeyboard
            })
            if (sentMsgRes && sentMsgRes.result) {
              sentMessageId = sentMsgRes.result.message_id
            }
          } catch (e) {}
        } else if (mode === 'free') {
          await startFreeCaptcha(botToken, db, chatId, request.from, true)
          return new Response('OK')
        }

        await db.prepare(
          `INSERT INTO join_requests (chat_id, user_id, username, message_id, status) VALUES (?, ?, ?, ?, 'pending')`
        ).bind(chatId, userId, userName, sentMessageId).run()
      }

      return new Response('OK')
    } catch (error) {
      console.error('Error:', error)
      return new Response('Error', { status: 500 })
    }
  }
}

async function sendTelegram(token, method, payload) {
  const url = `https://api.telegram.org/bot${token}/${method}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return await response.json()
}

const MUTED_PERMISSIONS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_change_info: false,
  can_manage_topics: false
}

const OPEN_PERMISSIONS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_invite_users: true
}

async function muteMember(token, chatId, userId) {
  return await sendTelegram(token, 'restrictChatMember', {
    chat_id: chatId,
    user_id: userId,
    permissions: MUTED_PERMISSIONS,
    use_independent_chat_permissions: true
  })
}

async function unmuteMember(token, chatId, userId) {
  let permissions = OPEN_PERMISSIONS
  try {
    const chatRes = await sendTelegram(token, 'getChat', { chat_id: chatId })
    if (chatRes && chatRes.ok && chatRes.result && chatRes.result.permissions) {
      permissions = chatRes.result.permissions
    }
  } catch (e) {}

  return await sendTelegram(token, 'restrictChatMember', {
    chat_id: chatId,
    user_id: userId,
    permissions: permissions,
    use_independent_chat_permissions: true
  })
}

async function startFreeCaptcha(token, db, chatId, member, approveRequest) {
  if (member.is_bot) return

  const memberId = member.id
  const memberName = member.first_name || 'Пользователь'

  const isBlacklisted = await db.prepare(`SELECT * FROM blacklist WHERE user_id = ?`).bind(memberId).first()
  if (isBlacklisted) {
    if (approveRequest) {
      await sendTelegram(token, 'declineChatJoinRequest', { chat_id: chatId, user_id: memberId })
    } else {
      await sendTelegram(token, 'banChatMember', { chat_id: chatId, user_id: memberId })
    }
    return
  }

  const alreadyVerified = await db.prepare(`SELECT * FROM verified_users WHERE user_id = ?`).bind(memberId).first()
  if (alreadyVerified) {
    if (approveRequest) {
      await sendTelegram(token, 'approveChatJoinRequest', { chat_id: chatId, user_id: memberId })
      await db.prepare(
        `INSERT INTO join_requests (chat_id, user_id, username, status) VALUES (?, ?, ?, 'approved')`
      ).bind(chatId, memberId, memberName).run()
    }
    return
  }

  const { results: stale } = await db.prepare(
    `SELECT message_id FROM join_requests WHERE chat_id = ? AND user_id = ? AND status = 'pending' AND created_at < datetime('now', '-60 seconds')`
  ).bind(chatId, memberId).all()

  for (const row of stale || []) {
    if (row.message_id) {
      await sendTelegram(token, 'deleteMessage', { chat_id: chatId, message_id: row.message_id })
    }
  }
  await db.prepare(
    `DELETE FROM join_requests WHERE chat_id = ? AND user_id = ? AND status = 'pending' AND created_at < datetime('now', '-60 seconds')`
  ).bind(chatId, memberId).run()

  const claim = await db.prepare(
    `INSERT INTO join_requests (chat_id, user_id, username, status)
     SELECT ?, ?, ?, 'pending'
     WHERE NOT EXISTS (
       SELECT 1 FROM join_requests
       WHERE chat_id = ? AND user_id = ? AND status = 'pending'
     )`
  ).bind(chatId, memberId, memberName, chatId, memberId).run()

  if (!claim.meta || !claim.meta.changes) return
  const rowId = claim.meta.last_row_id

  if (approveRequest) {
    await sendTelegram(token, 'approveChatJoinRequest', { chat_id: chatId, user_id: memberId })
  }

  const muteRes = await muteMember(token, chatId, memberId)
  if (!muteRes || !muteRes.ok) {
    await db.prepare(`DELETE FROM join_requests WHERE rowid = ?`).bind(rowId).run()
    return
  }

  const sentMsgRes = await sendTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text: MESSAGES.groupCaptcha(memberId, memberName),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: MESSAGES.verifyButton, callback_data: `verify_${chatId}_${memberId}` }
      ]]
    }
  })

  if (sentMsgRes && sentMsgRes.result) {
    await db.prepare(`UPDATE join_requests SET message_id = ? WHERE rowid = ?`).bind(sentMsgRes.result.message_id, rowId).run()
  }
}
