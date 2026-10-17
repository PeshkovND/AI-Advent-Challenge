import { createHash, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import express, { type ErrorRequestHandler } from 'express'
import { createLocalLlmRouter } from './local-llm-router'
import type { PrivateLlmConfig } from './private-llm-config'
import type { LlmRequestLogger } from './private-llm-logger'

export function createPrivateLlmApp(config: PrivateLlmConfig, staticDirectory = resolve('dist-private-llm'), logger?: LlmRequestLogger) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', false)
  // Observability must not interrupt a request if the output destination fails.
  const log: LlmRequestLogger = (event) => { try { logger?.(event) } catch { /* Continue serving the request. */ } }
  let nextRequestId = 0
  app.post('/api/local-llm/chat', (req, res, next) => {
    const requestId = String(++nextRequestId).padStart(4, '0')
    const clientIp = req.socket.remoteAddress || 'unknown'
    const started = performance.now()
    res.locals.llmRequestId = requestId
    log({ type: 'received', requestId, clientIp })
    res.once('finish', () => log({ type: 'finished', requestId, clientIp, status: res.statusCode, durationMs: Math.round(performance.now() - started) }))
    res.once('close', () => {
      if (!res.writableFinished) log({ type: 'canceled', requestId, clientIp, durationMs: Math.round(performance.now() - started) })
    })
    next()
  })
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    next()
  })
  const expectedKey = createHash('sha256').update(config.apiKey).digest()
  app.use('/api', (req, res, next) => {
    const header = req.headers.authorization || ''
    if (header.length > 300 || !header.startsWith('Bearer ') || !timingSafeEqual(expectedKey, createHash('sha256').update(header.slice(7)).digest())) {
      res.status(401).json({ error: 'Введите ключ доступа к приватному сервису.' }); return
    }
    next()
  })
  // One shared key has one shared budget, independent of IP or spoofed proxy headers.
  const windowMs = 60000
  let windowStarted = 0, requestCount = 0
  app.post('/api/local-llm/chat', (_req, res, next) => {
    const now = Date.now()
    if (now - windowStarted >= windowMs) { windowStarted = now; requestCount = 0 }
    const resetSeconds = Math.max(1, Math.ceil((windowStarted + windowMs - now) / 1000))
    res.setHeader('RateLimit-Limit', config.requestsPerMinute)
    res.setHeader('RateLimit-Reset', resetSeconds)
    res.setHeader('RateLimit-Remaining', Math.max(0, config.requestsPerMinute - requestCount - 1))
    if (requestCount >= config.requestsPerMinute) {
      res.setHeader('Retry-After', resetSeconds)
      res.status(429).json({ error: `Лимит запросов исчерпан. Повторите через ${resetSeconds} сек.` }); return
    }
    requestCount += 1
    next()
  })
  const maxBodyBytes = 1024 * 1024
  app.use('/api', express.json({ limit: maxBodyBytes }))
  app.use('/api/local-llm', createLocalLlmRouter({ ...config, log, limits: { requestsPerMinute: config.requestsPerMinute, maxConcurrentRequests: 1, timeoutMs: config.timeoutMs, maxBodyBytes, maxQueueSize: config.maxQueueSize, queueTimeoutMs: config.queueTimeoutMs } }))
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Endpoint не найден.' }) })
  app.use('/assets', express.static(resolve(staticDirectory, 'assets'), { dotfiles: 'deny', index: false }))
  app.get('/', (_req, res) => res.sendFile(resolve(staticDirectory, 'private-llm.html')))
  app.use((_req, res) => { res.status(404).json({ error: 'Страница не найдена.' }) })
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500
    res.status(status).json({ error: status === 413 ? 'Размер запроса превышает 1 МБ.' : status === 400 ? 'Некорректный JSON.' : 'Ошибка приватного сервиса.' })
  }
  app.use(errors)
  return app
}
