import { Router } from 'express'
import { z } from 'zod'
import { SupportAssistant } from './support-assistant'
import { selectionSchema } from './support-crm'
import { SupportError } from './support-errors'
import { SupportTickets } from './support-tickets'
import { appendMessageSchema, changeTicketStatusSchema, createTicketSchema, retryTicketSchema, ticketLifecycleSchema, ticketReadSchema, ticketSelectionSchema } from './support-ticket-schema'

const askSchema = selectionSchema.extend({ input: z.string().trim().min(1).max(4000), provider: z.enum(['local', 'cloud']).default('local') }).strict()
export function createSupportRouter(service = new SupportAssistant(), tickets = new SupportTickets(service)) {
  const router = Router()
  router.use((req, res, next) => {
    const local = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)
    try {
      if (!local(req.hostname) || req.headers.origin && !local(new URL(req.headers.origin).hostname)) { res.status(403).json({ error: 'Поддержка доступна из локального приложения оператора.' }); return }
    } catch { res.status(403).json({ error: 'Некорректный Origin.' }); return }
    next()
  })
  router.get('/status', (_req, res) => {
    try { res.json(service.status()) }
    catch (error) { res.status(error instanceof SupportError ? error.status : 503).json({ error: error instanceof Error ? error.message : 'Не удалось прочитать состояние.' }) }
  })
  router.get('/tickets/:ticketId', async (req, res) => {
    const parsed = ticketReadSchema.safeParse({ userId: req.query.userId, ticketId: req.params.ticketId, ...(req.query.includeDeleted !== undefined ? { includeDeleted: req.query.includeDeleted === 'true' ? true : req.query.includeDeleted === 'false' ? false : req.query.includeDeleted } : {}) })
    if (!parsed.success) { res.status(400).json({ error: 'Укажите корректный ticketId.' }); return }
    try { res.json(await tickets.client.get(parsed.data, AbortSignal.timeout(15000))) }
    catch (error) { res.status(error instanceof SupportError ? error.status : 503).json({ error: error instanceof Error ? error.message : 'Тикет недоступен.' }) }
  })
  for (const operation of ['remove', 'restore'] as const) {
    const path = `/tickets/:ticketId${operation === 'restore' ? '/restore' : ''}`
    const handler: import('express').RequestHandler = async (req, res) => {
      const body = ticketLifecycleSchema.omit({ ticketId: true }).safeParse(req.body)
      if (!body.success || !ticketSelectionSchema.shape.ticketId.safeParse(req.params.ticketId).success) {
        res.status(400).json({ error: 'Укажите текущую revision тикета.' }); return
      }
      try {
        const data = ticketLifecycleSchema.parse({ ...body.data, ticketId: req.params.ticketId })
        const record = await tickets.client[operation](data, AbortSignal.timeout(15000))
        if (operation === 'remove') tickets.cancel(data.ticketId)
        res.json(record)
      } catch (error) { res.status(error instanceof SupportError ? error.status : 503).json({ error: error instanceof Error ? error.message : 'Не удалось изменить тикет.' }) }
    }
    if (operation === 'remove') router.delete(path, handler)
    else router.post(path, handler)
  }
  for (const operation of ['create', 'message', 'retry', 'status'] as const) {
    const path = operation === 'create' ? '/tickets' : `/tickets/:ticketId/${operation === 'message' ? 'messages' : operation}`
    const handler: import('express').RequestHandler = async (req, res) => {
      const schema = operation === 'create' ? createTicketSchema : operation === 'message' ? appendMessageSchema.omit({ ticketId: true }) : operation === 'retry' ? retryTicketSchema.omit({ ticketId: true }) : changeTicketStatusSchema.omit({ ticketId: true })
      const parsed = schema.safeParse(req.body)
      if (!parsed.success || operation !== 'create' && !ticketSelectionSchema.shape.ticketId.safeParse(req.params.ticketId).success) {
        res.status(400).json({ error: 'Проверьте поля тикета, сообщение, статус и requestId. Описание: 10–1200 символов, сообщение: до 4000.' }); return
      }
      try {
        const data = { ...parsed.data, ...(operation !== 'create' ? { ticketId: req.params.ticketId } : {}) }
        const signal = AbortSignal.timeout(15000)
        const result = operation === 'create' ? await tickets.client.create(createTicketSchema.parse(data), signal)
          : operation === 'message' ? await tickets.client.append(appendMessageSchema.parse(data), signal)
          : operation === 'retry' ? await tickets.client.retry(retryTicketSchema.parse(data), signal)
          : await tickets.client.status(changeTicketStatusSchema.parse(data), signal)
        if (operation !== 'status') { tickets.start(); tickets.wake() }
        res.status(operation === 'status' ? 200 : 202).json(result)
      } catch (error) { res.status(error instanceof SupportError ? error.status : 503).json({ error: error instanceof Error ? error.message : 'Не удалось сохранить тикет.' }) }
    }
    if (operation === 'status') router.patch(path, handler)
    else router.post(path, handler)
  }
  for (const route of ['catalog', 'context', 'index', 'ask'] as const) {
    const handler: import('express').RequestHandler = async (req, res) => {
      const parsed = (route === 'ask' ? askSchema : route === 'context' ? selectionSchema : z.object({}).strict()).safeParse(req.body || {})
      if (!parsed.success) { res.status(400).json({ error: 'Укажите корректный ticketId и вопрос до 4000 символов. Произвольные пути и поля запрещены.' }); return }
      const abort = new AbortController(), closed = () => { if (!res.writableEnded) abort.abort() }
      res.on('close', closed)
      const timer = setTimeout(() => abort.abort(), 600000)
      try {
        const result = route === 'catalog' ? await service.catalog(abort.signal, req.query.includeDeleted === 'true') : route === 'context' ? await service.context(selectionSchema.parse(parsed.data), abort.signal)
          : route === 'index' ? await service.index(abort.signal) : await (() => { const body = askSchema.parse(parsed.data); return service.ask(body.input, { userId: body.userId, ...(body.ticketId ? { ticketId: body.ticketId } : {}) }, body.provider, abort.signal) })()
        if (!res.destroyed) res.json(result)
      } catch (error) {
        if (!res.destroyed) res.status(error instanceof SupportError ? error.status : abort.signal.aborted ? 504 : 502).json({ error: abort.signal.aborted ? 'Превышено время ожидания или запрос остановлен.' : error instanceof Error ? error.message : 'Ошибка ассистента поддержки.' })
      } finally { clearTimeout(timer); res.off('close', closed) }
    }
    if (route === 'catalog') router.get('/catalog', handler)
    else router.post(`/${route}`, handler)
  }
  return Object.assign(router, { tickets })
}
