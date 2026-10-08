import { Router } from 'express'
import { selectLocalContext } from '../src/local-llm-context'

export function createLocalLlmRouter() {
  const router = Router()
  const base = new URL(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Локальный чат требует loopback-адрес Ollama.')
  const model = process.env.OLLAMA_CHAT_MODEL || 'qwen3.5:4b'
  const context = Number(process.env.OLLAMA_CHAT_CONTEXT || 32768)
  const maxTokens = Number(process.env.OLLAMA_CHAT_MAX_TOKENS || 4096)
  if (![context, maxTokens].every((v) => Number.isSafeInteger(v) && v > 0) || maxTokens >= context) throw new Error('Некорректные лимиты локальной LLM.')
  let busy = false
  router.get('/status', async (_req, res) => {
    try {
      const response = await fetch(new URL('/api/tags', base), { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error('Ollama недоступна.')
      const data = await response.json()
      const installed = data.models?.some((item: { name: string }) => item.name === model || item.name === `${model}:latest`)
      res.json({ model, context, maxTokens, ready: Boolean(installed), error: installed ? undefined : `Загрузите модель: ollama pull ${model}` })
    } catch { res.status(503).json({ model, context, maxTokens, ready: false, error: 'Запустите Ollama: ollama serve' }) }
  })
  router.post('/chat', async (req, res) => {
    const messages = req.body?.messages
    if (!Array.isArray(messages) || !messages.length || messages.length > 1000 || messages.some((m) => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) || messages[messages.length - 1].role !== 'user') {
      res.status(400).json({ error: 'Нужна история сообщений с последним вопросом пользователя.' }); return
    }
    let selected: ReturnType<typeof selectLocalContext>
    try { selected = selectLocalContext(messages, context, maxTokens) }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Контекст слишком большой.' }); return }
    if (busy) { res.status(409).json({ error: 'Локальная модель занята. Дождитесь завершения запроса.' }); return }
    busy = true
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 600000)
    const close = () => { if (!res.writableEnded) abort.abort() }
    res.on('close', close)
    try {
      const upstream = await fetch(new URL('/api/chat', base), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal,
        body: JSON.stringify({ model, messages: selected.messages.map(({ role, content }) => ({ role, content })), stream: true, think: false, keep_alive: '60s', options: { num_ctx: context, num_predict: maxTokens, temperature: 0.2 } }),
      })
      if (!upstream.ok) throw new Error(`Ollama: ${await upstream.text()}`)
      if (!upstream.body) throw new Error('Ollama вернула пустой поток.')
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      res.flushHeaders()
      res.write(JSON.stringify({ contextInfo: { dropped: selected.dropped, estimatedTokens: selected.estimatedTokens, budget: selected.budget } }) + '\n')
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
        const message = error instanceof Error ? error.message : 'Не удалось получить ответ.'
        if (res.headersSent) res.end(JSON.stringify({ error: message }) + '\n')
        else res.status(502).json({ error: `Локальная LLM недоступна: ${message}. Проверьте Ollama.` })
      }
    } finally { clearTimeout(timer); res.off('close', close); busy = false }
  })
  return router
}
