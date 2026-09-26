import 'dotenv/config'
import './network-config'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { randomUUID } from 'node:crypto'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { z } from 'zod'

const defaultCalendar = 'events-default'
const caldavBaseUrl = (process.env.YANDEX_CALDAV_URL?.trim() || 'https://caldav.yandex.ru').replace(/\/$/, '')
const caldavHttpsAgent = new HttpsAgent({ keepAlive: true, family: 4, maxSockets: 4 })
const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

type CalendarEvent = { uid: string; title: string; startsAt: string; endsAt: string; calendar: string; description?: string; location?: string; etag?: string }

function configurationError() { return 'Настройте YANDEX_CALDAV_EMAIL и один из секретов: YANDEX_CALDAV_APP_PASSWORD или YANDEX_CALDAV_OAUTH_TOKEN.' }
function calendarUrl(calendar: string, uid?: string) {
  const email = process.env.YANDEX_CALDAV_EMAIL?.trim()
  if (!email) throw new Error(configurationError())
  return `${caldavBaseUrl}/calendars/${encodeURIComponent(email)}/${encodeURIComponent(calendar)}/${uid ? `${encodeURIComponent(uid)}.ics` : ''}`
}
function authorizationHeader() {
  const token = process.env.YANDEX_CALDAV_OAUTH_TOKEN?.trim()
  if (token) return `OAuth ${token}`
  const email = process.env.YANDEX_CALDAV_EMAIL?.trim()
  const password = process.env.YANDEX_CALDAV_APP_PASSWORD?.trim()
  if (email && password) return `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`
  throw new Error(configurationError())
}
function caldavRequestOnce(url: string, method: string, options: { body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ body: string; etag?: string }>((resolve, reject) => {
    const request = httpsRequest(url, { method, agent: caldavHttpsAgent, family: 4, headers: { Authorization: authorizationHeader(), ...options.headers }, timeout: 10_000 }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          reject(new Error(`CalDAV вернул HTTP ${status}: ${body.slice(0, 500) || response.statusMessage || 'пустой ответ'}`))
          return
        }
        const header = response.headers.etag
        resolve({ body, ...(typeof header === 'string' ? { etag: header } : {}) })
      })
    })
    request.on('timeout', () => request.destroy(new Error('превышено время ожидания 10 секунд')))
    request.on('error', (error) => reject(new Error(`Не удалось подключиться к CalDAV Яндекса (${error.message}). Проверьте интернет-соединение, VPN/прокси и доступ к caldav.yandex.ru.`)))
    if (options.body) request.write(options.body)
    request.end()
  })
}

async function caldavRequest(url: string, method: string, options: { body?: string; headers?: Record<string, string> } = {}) {
  const safeToRetry = ['GET', 'HEAD', 'PROPFIND', 'REPORT'].includes(method)
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await caldavRequestOnce(url, method, options)
    } catch (error) {
      lastError = error
      // A socket that dies before TLS is established has not sent an HTTP
      // request, so retrying a mutation cannot create a duplicate event. Other
      // mutations remain single-attempt to avoid replaying an ambiguous write.
      const beforeRequest = error instanceof Error && /socket disconnected before secure TLS connection was established/i.test(error.message)
      if (!safeToRetry && !beforeRequest) break
      if (attempt + 1 < 4) await pause(500 * (attempt + 1))
    }
  }
  throw lastError
}
function escapeIcs(value: string) { return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,') }
function toIcsDate(value: string) { return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') }
function createIcs(event: Omit<CalendarEvent, 'etag'>) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Day 17 MCP Calendar//RU', 'BEGIN:VEVENT', `UID:${event.uid}`, `DTSTAMP:${toIcsDate(new Date().toISOString())}`, `DTSTART:${toIcsDate(event.startsAt)}`, `DTEND:${toIcsDate(event.endsAt)}`, `SUMMARY:${escapeIcs(event.title)}`]
  if (event.description) lines.push(`DESCRIPTION:${escapeIcs(event.description)}`)
  if (event.location) lines.push(`LOCATION:${escapeIcs(event.location)}`)
  return [...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
}
function property(ics: string, name: string) {
  const unfolded = ics.replace(/\r?\n[ \t]/g, '')
  const line = unfolded.split(/\r?\n/).find((item) => item.startsWith(`${name}:`) || item.startsWith(`${name};`))
  return line?.slice(line.indexOf(':') + 1).replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}
function parseIcsDate(value: string | undefined) {
  if (!value || !/^\d{8}T\d{6}Z$/.test(value)) return value
  return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`).toISOString()
}
function parseEvent(ics: string, calendar: string): CalendarEvent | undefined {
  const eventComponent = ics.match(/BEGIN:VEVENT\r?\n[\s\S]*?END:VEVENT/)?.[0]
  if (!eventComponent) return undefined
  const uid = property(eventComponent, 'UID'), title = property(eventComponent, 'SUMMARY'), startsAt = parseIcsDate(property(eventComponent, 'DTSTART')), endsAt = parseIcsDate(property(eventComponent, 'DTEND'))
  if (!uid || !title || !startsAt || !endsAt) return undefined
  const description = property(eventComponent, 'DESCRIPTION'), location = property(eventComponent, 'LOCATION')
  return { uid, title, startsAt, endsAt, calendar, ...(description ? { description } : {}), ...(location ? { location } : {}) }
}
const eventShape = z.object({ uid: z.string(), title: z.string(), startsAt: z.string(), endsAt: z.string(), calendar: z.string(), description: z.string().optional(), location: z.string().optional(), etag: z.string().optional() })
const eventInput = { title: z.string().min(1).max(500).describe('Название события'), startsAt: z.string().datetime({ offset: true }).describe('Начало в ISO 8601, например 2026-09-23T10:00:00+06:00'), endsAt: z.string().datetime({ offset: true }).describe('Конец в ISO 8601'), description: z.string().max(5000).optional().describe('Описание'), location: z.string().max(500).optional().describe('Место'), calendar: z.string().min(1).default(defaultCalendar).describe('CalDAV-календарь; events-default — основной') }
function toolError(error: unknown) { return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Не удалось выполнить запрос к календарю.' }], isError: true } }

function createCalendarServer() {
  const server = new McpServer({ name: 'yandex-calendar-mcp', version: '1.0.0' })
  server.registerTool('create_calendar_event', { title: 'Создать событие в Яндекс Календаре', description: 'Создаёт новое событие в CalDAV-календаре Яндекса.', inputSchema: z.object(eventInput).refine(({ startsAt, endsAt }) => new Date(endsAt) > new Date(startsAt), { message: 'endsAt должно быть позже startsAt' }), outputSchema: z.object({ event: eventShape }) }, async (input) => {
    try {
      const event = { uid: randomUUID(), ...input }
      const { etag } = await caldavRequest(calendarUrl(input.calendar, event.uid), 'PUT', { body: createIcs(event), headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' } })
      return { content: [{ type: 'text', text: `Событие «${event.title}» создано.` }], structuredContent: { event: { ...event, ...(etag ? { etag } : {}) } } }
    } catch (error) { return toolError(error) }
  })
  server.registerTool('get_calendar_events', { title: 'Получить события Яндекс Календаря', description: 'Возвращает события, пересекающиеся с указанным периодом.', inputSchema: z.object({ calendar: z.string().min(1).default(defaultCalendar).describe('CalDAV-календарь; events-default — основной'), from: z.string().datetime({ offset: true }).describe('Начало периода в ISO 8601'), to: z.string().datetime({ offset: true }).describe('Конец в ISO 8601') }).refine(({ from, to }) => new Date(to) > new Date(from), { message: 'to должно быть позже from' }), outputSchema: z.object({ events: z.array(eventShape) }), annotations: { readOnlyHint: true } }, async ({ calendar, from, to }) => {
    try {
      const report = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${toIcsDate(from)}" end="${toIcsDate(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`
      const { body } = await caldavRequest(calendarUrl(calendar), 'REPORT', { body: report, headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' } })
      const events = [...body.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)].flatMap((response) => {
        const event = parseEvent(response[1].match(/BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/)?.[0] ?? '', calendar)
        const etag = response[1].match(/<(?:[\w-]+:)?getetag[^>]*>([^<]+)<\/(?:[\w-]+:)?getetag>/i)?.[1]
        return event ? [{ ...event, ...(etag ? { etag } : {}) }] : []
      })
      return { content: [{ type: 'text', text: `Найдено событий: ${events.length}.` }], structuredContent: { events } }
    } catch (error) { return toolError(error) }
  })
  server.registerTool('update_calendar_event', { title: 'Изменить событие Яндекс Календаря', description: 'Полностью обновляет поля события по UID. Передавайте etag из чтения, чтобы не затереть параллельные изменения.', inputSchema: z.object({ uid: z.string().uuid().describe('UID события'), ...eventInput, etag: z.string().optional().describe('Текущий ETag события') }).refine(({ startsAt, endsAt }) => new Date(endsAt) > new Date(startsAt), { message: 'endsAt должно быть позже startsAt' }), outputSchema: z.object({ event: eventShape }) }, async ({ etag, ...event }) => {
    try {
      const { etag: nextEtag } = await caldavRequest(calendarUrl(event.calendar, event.uid), 'PUT', { body: createIcs(event), headers: { 'Content-Type': 'text/calendar; charset=utf-8', ...(etag ? { 'If-Match': etag } : {}) } })
      return { content: [{ type: 'text', text: `Событие «${event.title}» обновлено.` }], structuredContent: { event: { ...event, ...(nextEtag ? { etag: nextEtag } : {}) } } }
    } catch (error) { return toolError(error) }
  })
  server.registerTool('delete_calendar_event', { title: 'Удалить событие Яндекс Календаря', description: 'Удаляет событие по UID. Передайте etag, чтобы не удалить обновлённую версию.', inputSchema: z.object({ uid: z.string().uuid().describe('UID события'), calendar: z.string().min(1).default(defaultCalendar).describe('CalDAV-календарь'), etag: z.string().optional().describe('Текущий ETag события') }), outputSchema: z.object({ uid: z.string(), deleted: z.literal(true) }) }, async ({ uid, calendar, etag }) => {
    try {
      await caldavRequest(calendarUrl(calendar, uid), 'DELETE', { headers: etag ? { 'If-Match': etag } : {} })
      return { content: [{ type: 'text', text: 'Событие удалено.' }], structuredContent: { uid, deleted: true } }
    } catch (error) { return toolError(error) }
  })
  return server
}
serveStdio(createCalendarServer, { onerror: (error) => console.error('Ошибка Яндекс Calendar MCP:', error) })
