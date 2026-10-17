export type LlmRequestEvent = {
  type: 'received' | 'prompt' | 'queued' | 'started' | 'failed' | 'finished' | 'canceled'
  requestId: string
  clientIp: string
  prompt?: string
  position?: number
  model?: string
  waitedMs?: number
  status?: number
  durationMs?: number
}
export type LlmRequestLogger = (event: LlmRequestEvent) => void

// Keep untrusted text on one terminal line, without ANSI escape sequences.
function preview(value: string, maxLength = 200) {
  const characters = [...value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()]
  return characters.slice(0, maxLength).join('') + (characters.length > maxLength ? '…' : '')
}

export function createPrivateLlmLogger({ logPrompts = true, timeZone = 'Asia/Omsk' } = {}, write: (line: string) => void = console.log): LlmRequestLogger {
  const clock = new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  return (event) => {
    if (event.type === 'prompt' && !logPrompts) return
    const ip = preview(event.clientIp.replace(/^::ffff:/, ''), 64)
    const prefix = `[${clock.format(new Date())}] [#${preview(event.requestId, 16)}] [${ip}]`
    let message: string
    switch (event.type) {
      case 'received': message = 'Получен POST /api/local-llm/chat'; break
      case 'prompt': message = `Вопрос: ${JSON.stringify(preview(event.prompt || ''))}`; break
      case 'queued': message = `Ожидание в очереди · позиция ${event.position}`; break
      case 'started': message = `Начало генерации · ${preview(event.model || '', 80)} · ожидание ${event.waitedMs} мс`; break
      case 'failed': message = `Ошибка обработки · статус ${event.status}`; break
      case 'finished': message = `Завершён · HTTP ${event.status} · ${event.durationMs} мс`; break
      case 'canceled': message = `Клиент отключился · запрос отменён · ${event.durationMs} мс`; break
    }
    write(`${prefix} ${message}`)
  }
}
