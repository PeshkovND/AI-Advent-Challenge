import 'dotenv/config'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
const chatId = process.env.TELEGRAM_CHAT_ID?.trim()
// The override is intentionally undocumented for application users. It lets
// the MCP contract be tested against a local HTTP fixture without ever
// sending a test message to Telegram.
const apiBaseUrl = (process.env.TELEGRAM_API_BASE_URL?.trim() || 'https://api.telegram.org').replace(/\/$/, '')

type TelegramApiResponse = {
  ok?: boolean
  result?: { message_id?: number; date?: number; chat?: { id?: number | string } }
  error_code?: number
  description?: string
}

function configurationError() {
  return new Error('Telegram не настроен: добавьте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env и перезапустите сервер.')
}

function safeTelegramError(error: unknown) {
  // Never return a URL because it contains the bot token in its path.
  if (error instanceof Error && error.message.startsWith('Telegram API:')) return error
  const cause = error as { cause?: { code?: unknown } }
  const code = typeof cause.cause?.code === 'string' ? cause.cause.code : undefined
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
    return new Error('Не удалось установить защищённое соединение с Telegram. Проверьте VPN, сеть или доступ к api.telegram.org.')
  }
  return new Error('Не удалось отправить сообщение в Telegram. Проверьте подключение и настройки бота.')
}

async function callTelegram(method: 'sendMessage' | 'editMessageText', body: Record<string, unknown>) {
  if (!token || !chatId) throw configurationError()
  let response: Response
  try {
    response = await fetch(`${apiBaseUrl}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, ...body }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) { throw safeTelegramError(error) }

  let data: TelegramApiResponse
  try { data = await response.json() as TelegramApiResponse } catch { throw new Error('Telegram API вернул некорректный ответ.') }
  if (!response.ok || !data.ok || !data.result?.message_id) {
    const description = typeof data.description === 'string' ? data.description : `HTTP ${response.status}`
    throw new Error(`Telegram API: ${description}`)
  }
  return data.result
}

function errorResult(error: unknown) {
  return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Не удалось выполнить операцию Telegram.' }], isError: true }
}

const sentNoteShape = z.object({
  messageId: z.number().int(),
  chatId: z.string(),
  sentAt: z.string(),
})

function createServer() {
  const server = new McpServer({ name: 'telegram-notes-mcp', version: '1.0.0' })

  server.registerTool('send_telegram_note', {
    title: 'Отправить заметку в Telegram',
    description: 'Отправляет готовый текст в личный чат пользователя с ботом Telegram. Используй после получения или изменения внешних данных, если пользователь явно просит прислать, сохранить или записать результат в Telegram.',
    inputSchema: z.object({
      text: z.string().min(1).max(4_096).describe('Готовый текст заметки для пользователя. Не включай секреты или внутренние технические данные.'),
      disableNotification: z.boolean().optional().default(false).describe('Не отправлять push-уведомление, если пользователь явно попросил тихое сообщение.'),
    }),
    outputSchema: sentNoteShape,
  }, async ({ text, disableNotification }) => {
    try {
      const result = await callTelegram('sendMessage', { text, disable_notification: disableNotification })
      return {
        content: [{ type: 'text', text: 'Заметка отправлена в Telegram.' }],
        structuredContent: {
          messageId: result.message_id!,
          chatId: String(result.chat?.id ?? chatId),
          sentAt: new Date((result.date ?? Math.floor(Date.now() / 1_000)) * 1_000).toISOString(),
        },
      }
    } catch (error) { return errorResult(error) }
  })

  server.registerTool('edit_telegram_note', {
    title: 'Обновить заметку в Telegram',
    description: 'Изменяет ранее отправленную ботом заметку по её messageId. Используй только если пользователь явно просит обновить именно известную заметку.',
    inputSchema: z.object({
      messageId: z.number().int().positive().describe('messageId заметки, возвращённый send_telegram_note'),
      text: z.string().min(1).max(4_096).describe('Новый полный текст заметки.'),
    }),
    outputSchema: sentNoteShape,
  }, async ({ messageId, text }) => {
    try {
      const result = await callTelegram('editMessageText', { message_id: messageId, text })
      return {
        content: [{ type: 'text', text: 'Заметка в Telegram обновлена.' }],
        structuredContent: {
          messageId: result.message_id!,
          chatId: String(result.chat?.id ?? chatId),
          sentAt: new Date((result.date ?? Math.floor(Date.now() / 1_000)) * 1_000).toISOString(),
        },
      }
    } catch (error) { return errorResult(error) }
  })

  return server
}

serveStdio(createServer, { onerror: (error) => console.error('Ошибка Telegram MCP:', error) })
