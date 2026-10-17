import { Router } from 'express'
import { selectLocalContext } from '../src/local-llm-context'
import { LocalLlmQueue, LocalLlmQueueError } from './local-llm-queue'
import type { LlmRequestEvent, LlmRequestLogger } from './private-llm-logger'

export type LocalLlmOptions = {
  baseUrl?: string
  model?: string
  context?: number
  maxTokens?: number
  timeoutMs?: number
  maxQueueSize?: number
  queueTimeoutMs?: number
  log?: LlmRequestLogger
  limits?: { requestsPerMinute: number; maxConcurrentRequests: number; timeoutMs: number; maxBodyBytes: number; maxQueueSize: number; queueTimeoutMs: number }
}

export function createLocalLlmRouter(options: LocalLlmOptions = {}) {
  const router = Router()
  const base = new URL(options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434')
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Локальный чат требует HTTP loopback-адрес Ollama.')
  const model = options.model ?? (process.env.OLLAMA_CHAT_MODEL || 'qwen3.5:4b')
  const context = options.context ?? Number(process.env.OLLAMA_CHAT_CONTEXT || 32768)
  const maxTokens = options.maxTokens ?? Number(process.env.OLLAMA_CHAT_MAX_TOKENS || 4096)
  const timeoutMs = options.timeoutMs ?? 600000
  if (![context, maxTokens, timeoutMs].every((v) => Number.isSafeInteger(v) && v > 0) || maxTokens + 512 >= context) throw new Error('Некорректные лимиты локальной LLM.')
  const maxQueueSize = options.maxQueueSize ?? 0
  const queueTimeoutMs = options.queueTimeoutMs ?? 60000
  if (!Number.isSafeInteger(maxQueueSize) || maxQueueSize < 0 || maxQueueSize > 10 || !Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs <= 0) throw new Error('Некорректные лимиты очереди LLM.')
  const queue = new LocalLlmQueue(maxQueueSize, queueTimeoutMs)
  router.get('/status', async (_req, res) => {
    try {
      const response = await fetch(new URL('/api/tags', base), { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error('Ollama недоступна.')
      const data = await response.json()
      const installed = data.models?.some((item: { name: string }) => item.name === model || item.name === `${model}:latest`)
      res.json({ model, context, maxTokens, ready: Boolean(installed), limits: options.limits, queue: queue.snapshot(), error: installed ? undefined : `Загрузите модель: ollama pull ${model}` })
    } catch { res.status(503).json({ model, context, maxTokens, ready: false, error: 'Запустите Ollama: ollama serve' }) }
  })
  router.post('/chat', async (req, res) => {
    const log = (event: Omit<LlmRequestEvent, 'requestId' | 'clientIp'>) => options.log?.({ ...event, requestId: res.locals.llmRequestId || 'local', clientIp: req.socket.remoteAddress || 'unknown' })
    if (req.body?.stream !== undefined && typeof req.body.stream !== 'boolean') {
      res.status(400).json({ error: 'stream должен быть true или false.' }); return
    }
    const stream = req.body?.stream !== false
    const messages = req.body?.messages
    if (!Array.isArray(messages) || !messages.length || messages.length > 1000 || messages.some((m) => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) || messages[messages.length - 1].role !== 'user') {
      res.status(400).json({ error: 'Нужна история сообщений с последним вопросом пользователя.' }); return
    }
    let selected: ReturnType<typeof selectLocalContext>
    try { selected = selectLocalContext(messages, context, maxTokens) }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Контекст слишком большой.' }); return }
    log({ type: 'prompt', prompt: messages[messages.length - 1].content })
    const abort = new AbortController()
    const close = () => { if (!res.writableEnded) abort.abort() }
    res.on('close', close)
    let release: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined
    let initialPosition = 0, generationTimedOut = false
    const started = performance.now()
    const contextInfo = { dropped: selected.dropped, estimatedTokens: selected.estimatedTokens, budget: selected.budget }
    const writeEvent = (event: object) => {
      if (res.destroyed || res.writableEnded) { abort.abort(); return }
      const first = !res.headersSent
      if (first) {
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache')
        res.flushHeaders()
      }
      try { res.write(JSON.stringify(first ? { contextInfo, ...event } : event) + '\n') }
      catch { abort.abort() }
    }
    try {
      release = await queue.acquire(abort.signal, (position) => {
        if (!initialPosition) initialPosition = position
        log({ type: 'queued', position })
        if (stream) writeEvent({ queueInfo: { state: 'queued', position, timeoutMs: queueTimeoutMs } })
      })
      if (abort.signal.aborted) return
      const queueInfo = { state: 'running', position: 0, initialPosition, waitedMs: initialPosition ? Math.round(performance.now() - started) : 0 }
      log({ type: 'started', model, waitedMs: queueInfo.waitedMs })
      if (stream && res.headersSent) writeEvent({ queueInfo })
      timer = setTimeout(() => { generationTimedOut = true; abort.abort() }, timeoutMs)
      const upstream = await fetch(new URL('/api/chat', base), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal,
        body: JSON.stringify({ model, messages: selected.messages.map(({ role, content }) => ({ role, content })), stream, think: false, keep_alive: '60s', options: { num_ctx: context, num_predict: maxTokens, temperature: 0.2 } }),
      })
      if (!upstream.ok) throw new Error(`Ollama: ${await upstream.text()}`)
      if (!stream) { res.json({ ...await upstream.json(), contextInfo, queueInfo }); return }
      if (!upstream.body) throw new Error('Ollama вернула пустой поток.')
      if (!res.headersSent) writeEvent(maxQueueSize ? { queueInfo } : {})
      const reader = upstream.body.getReader()
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (!res.write(value)) await new Promise<void>((resolve) => {
            const cleanup = () => { res.off('drain', finish); res.off('close', finish) }
            const finish = () => { cleanup(); resolve() }
            res.once('drain', finish); res.once('close', finish)
          })
          if (abort.signal.aborted) break
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      res.end()
    } catch (error) {
      if (!res.destroyed) {
        const queueError = error instanceof LocalLlmQueueError
        const status = queueError ? error.status : generationTimedOut ? 504 : 502
        log({ type: 'failed', status })
        const message = queueError ? error.message : generationTimedOut ? 'Превышено время ожидания ответа.' : error instanceof Error ? error.message : 'Не удалось получить ответ.'
        if (res.headersSent) res.end(JSON.stringify({ error: message, status }) + '\n')
        else {
          if (status === 409 || status === 503) res.setHeader('Retry-After', '2')
          res.status(status).json({ error: queueError ? message : `Локальная LLM недоступна: ${message}. Проверьте Ollama.` })
        }
      }
    } finally { clearTimeout(timer); res.off('close', close); release?.() }
  })
  return router
}
