import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import express, { type Request, type Response } from 'express'
import type { Server } from 'node:http'
import { createPrivateLlmApp } from './private-llm-app'
import { readPrivateLlmConfig } from './private-llm-config'
import { createPrivateLlmLogger, type LlmRequestEvent, type LlmRequestLogger } from './private-llm-logger'

const apiKey = 'test-private-llm-key-0123456789abcdef'
const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
const question = { messages: [{ role: 'user', content: 'Привет' }], stream: false }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
async function listen(app: ReturnType<typeof express>) {
  const server = await new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
    server.once('error', reject)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { server, url: `http://127.0.0.1:${address.port}` }
}
function stop(server: Server) {
  server.closeAllConnections()
  return new Promise<void>((resolve) => server.close(() => resolve()))
}
async function fixture(t: TestContext, options: { timeoutMs?: number; rate?: number; maxQueueSize?: number; queueTimeoutMs?: number; logger?: LlmRequestLogger; chat?: (req: Request, res: Response) => void | Promise<void> } = {}) {
  const requests: Array<Record<string, any>> = []
  const ollama = express()
  ollama.use(express.json())
  ollama.get('/api/tags', (_req, res) => res.json({ models: [{ name: 'qwen3.5:4b' }] }))
  ollama.post('/api/chat', async (req, res) => {
    requests.push(req.body)
    if (options.chat) { await options.chat(req, res); return }
    const result = { message: { role: 'assistant', content: 'Локальный ответ' }, done: true }
    if (req.body.stream) res.type('application/x-ndjson').end(JSON.stringify(result) + '\n')
    else res.json(result)
  })
  const upstream = await listen(ollama)
  const config = { ...readPrivateLlmConfig({ PRIVATE_LLM_API_KEY: apiKey }), baseUrl: upstream.url, timeoutMs: options.timeoutMs ?? 1000, requestsPerMinute: options.rate ?? 50, maxQueueSize: options.maxQueueSize ?? 3, queueTimeoutMs: options.queueTimeoutMs ?? 1000 }
  const service = await listen(createPrivateLlmApp(config, undefined, options.logger))
  t.after(async () => { await stop(service.server); await stop(upstream.server) })
  const post = (body: unknown = question, extraHeaders = {}) => fetch(`${service.url}/api/local-llm/chat`, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) })
  const status = async () => (await fetch(service.url + '/api/local-llm/status', { headers })).json()
  const waitForQueue = async (count: number) => {
    const deadline = Date.now() + 1000
    while (Date.now() < deadline) {
      if ((await status()).queue.waiting === count) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.fail(`Очередь не достигла размера ${count}`)
  }
  return { ...service, config, requests, post, status, waitForQueue }
}

test('configuration fails closed for weak keys, invalid budgets and cloud models', () => {
  assert.throws(() => readPrivateLlmConfig({}), /PRIVATE_LLM_API_KEY/)
  assert.throws(() => readPrivateLlmConfig({ PRIVATE_LLM_API_KEY: 'short' }), /PRIVATE_LLM_API_KEY/)
  assert.throws(() => readPrivateLlmConfig({ PRIVATE_LLM_API_KEY: apiKey, PRIVATE_LLM_CONTEXT: '1024', PRIVATE_LLM_MAX_TOKENS: '900' }), /Контекст/)
  assert.throws(() => readPrivateLlmConfig({ PRIVATE_LLM_API_KEY: apiKey, PRIVATE_LLM_RATE_LIMIT: 'NaN' }), /RATE_LIMIT/)
  assert.throws(() => readPrivateLlmConfig({ PRIVATE_LLM_API_KEY: apiKey, PRIVATE_LLM_QUEUE_SIZE: '-1' }), /QUEUE_SIZE/)
  assert.throws(() => readPrivateLlmConfig({ PRIVATE_LLM_API_KEY: apiKey, OLLAMA_CHAT_MODEL: 'qwen:cloud' }), /локальную/)
  assert.throws(() => createPrivateLlmApp({ ...readPrivateLlmConfig({ PRIVATE_LLM_API_KEY: apiKey }), baseUrl: 'https://example.com' }), /loopback/)
})

test('API requires bearer auth, ignores keys in query strings and exposes limits after login', async (t) => {
  const f = await fixture(t)
  for (const suffix of ['', `?apiKey=${apiKey}`]) {
    const response = await fetch(`${f.url}/api/local-llm/status${suffix}`)
    assert.equal(response.status, 401)
  }
  assert.equal((await fetch(`${f.url}/api/local-llm/status`, { headers: { Authorization: 'Bearer wrong' } })).status, 401)
  const response = await fetch(`${f.url}/api/local-llm/status`, { headers })
  const status = await response.json()
  assert.equal(status.ready, true)
  assert.equal(status.context, 8192)
  assert.equal(status.limits.maxConcurrentRequests, 1)
  assert.equal(status.limits.maxQueueSize, 3)
  assert.deepEqual(status.queue, { active: 0, waiting: 0, maxSize: 3 })
  assert.match(response.headers.get('content-security-policy') || '', /connect-src 'self'/)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
})

test('other project APIs, raw Ollama and configuration files are not exposed', async (t) => {
  const f = await fixture(t)
  for (const path of ['/api/agents', '/api/optimization/report', '/api/tags', '/data/private-llm.env', '/.env', '/src/App.tsx']) {
    assert.equal((await fetch(f.url + path, { headers })).status, 404, path)
  }
})

test('JSON and NDJSON chat use only server-side model and generation limits', async (t) => {
  const f = await fixture(t)
  const response = await f.post({ ...question, model: 'other', options: { num_ctx: 999999, num_predict: 999999 } })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).message.content, 'Локальный ответ')
  assert.equal(f.requests[0].model, 'qwen3.5:4b')
  assert.equal(f.requests[0].think, false)
  assert.equal(f.requests[0].options.num_ctx, 8192)
  assert.equal(f.requests[0].options.num_predict, 1024)
  const stream = await f.post({ messages: question.messages })
  const chunks = (await stream.text()).trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(chunks[0].contextInfo.budget > 0)
  assert.equal(chunks[1].done, true)
})

test('invalid history, oversized context, malformed JSON and body size never reach Ollama', async (t) => {
  const f = await fixture(t)
  for (const body of [{ messages: [] }, { messages: [{ role: 'system', content: 'bad' }] }, { ...question, stream: 'false' }, { messages: [{ role: 'user', content: 'я'.repeat(4000) }] }]) {
    assert.equal((await f.post(body)).status, 400)
  }
  assert.equal((await f.post({ messages: [{ role: 'user', content: 'a'.repeat(1024 * 1024) }] })).status, 413)
  assert.equal((await fetch(f.url + '/api/local-llm/chat', { method: 'POST', headers, body: '{oops' })).status, 400)
  assert.equal(f.requests.length, 0)
})

test('old complete turns are removed while the latest question is retained', async (t) => {
  const f = await fixture(t)
  const response = await f.post({ stream: false, messages: [{ role: 'user', content: 'x'.repeat(7000) }, { role: 'assistant', content: 'old answer' }, ...question.messages] })
  assert.equal((await response.json()).contextInfo.dropped, 2)
  assert.deepEqual(f.requests[0].messages, question.messages)
})

test('disabling the queue preserves immediate 409 responses', async (t) => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { maxQueueSize: 0, chat: async (_req, res) => { entered.resolve(); await release.promise; res.json({ done: true, message: { content: 'ok' } }) } })
  const first = f.post()
  await entered.promise
  const blocked = await f.post()
  assert.equal(blocked.status, 409)
  assert.equal(blocked.headers.get('retry-after'), '2')
  release.resolve()
  assert.equal((await first).status, 200)
  assert.equal((await f.post()).status, 200)
})

test('FIFO queue serializes generation, updates positions and keeps separate request bodies', async (t) => {
  const entered = deferred(), release = deferred()
  let active = 0, peak = 0
  const order: string[] = []
  const events: LlmRequestEvent[] = []
  const f = await fixture(t, { logger: (event) => events.push(event), chat: async (req, res) => {
    const content = req.body.messages[0].content
    order.push(content); active += 1; peak = Math.max(peak, active)
    if (content === 'first') { entered.resolve(); await release.promise }
    active -= 1
    const result = { done: true, message: { content } }
    if (req.body.stream) res.type('application/x-ndjson').end(JSON.stringify(result) + '\n')
    else res.json(result)
  } })
  const body = (content: string, stream = false) => ({ messages: [{ role: 'user', content }], stream })
  const first = f.post(body('first'))
  await entered.promise
  const second = await f.post(body('second', true))
  const third = await f.post(body('third', true))
  assert.deepEqual((await f.status()).queue, { active: 1, waiting: 2, maxSize: 3 })
  assert.equal(f.requests.length, 1)
  release.resolve()
  assert.equal((await first).status, 200)
  const secondEvents = (await second.text()).trim().split('\n').map((line) => JSON.parse(line))
  const thirdEvents = (await third.text()).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(secondEvents[0].queueInfo.position, 1)
  assert.equal(thirdEvents[0].queueInfo.position, 2)
  assert.ok(thirdEvents.some((event) => event.queueInfo?.state === 'queued' && event.queueInfo.position === 1))
  assert.ok(secondEvents.some((event) => event.queueInfo?.state === 'running' && event.queueInfo.initialPosition === 1))
  assert.equal(secondEvents[secondEvents.length - 1].message.content, 'second')
  assert.equal(thirdEvents[thirdEvents.length - 1].message.content, 'third')
  assert.deepEqual(order, ['first', 'second', 'third'])
  assert.equal(peak, 1)
  assert.deepEqual((await f.status()).queue, { active: 0, waiting: 0, maxSize: 3 })
  assert.deepEqual(events.filter((event) => event.type === 'started').map((event) => event.requestId), ['0001', '0002', '0003'])
  assert.ok(events.some((event) => event.type === 'queued' && event.requestId === '0003' && event.position === 2))
  assert.ok(events.some((event) => event.type === 'queued' && event.requestId === '0003' && event.position === 1))
  assert.equal(events.filter((event) => event.type === 'finished').length, 3)
})

test('request logs correlate receipt, prompt, generation and completion without credentials or spoofed IPs', async (t) => {
  const events: LlmRequestEvent[] = []
  const f = await fixture(t, { logger: (event) => events.push(event) })
  const response = await fetch(f.url + '/api/local-llm/chat?apiKey=never-log-query', { method: 'POST', headers: { ...headers, Cookie: 'never-log-cookie', 'X-Forwarded-For': '10.123.45.67' }, body: JSON.stringify(question) })
  assert.equal(response.status, 200)
  await response.json()
  assert.deepEqual(events.map((event) => event.type), ['received', 'prompt', 'started', 'finished'])
  assert.ok(events.every((event) => event.requestId === '0001' && event.clientIp === '127.0.0.1'))
  assert.equal(events[1].prompt, 'Привет')
  assert.equal(events[3].status, 200)
  const logged = JSON.stringify(events)
  for (const value of [apiKey, 'never-log-query', 'never-log-cookie', '10.123.45.67']) assert.ok(!logged.includes(value))
  assert.equal((await f.post(question, { Authorization: 'Bearer wrong' })).status, 401)
  assert.deepEqual(events.filter((event) => event.requestId === '0002').map((event) => event.type), ['received', 'finished'])
})

test('console logs use Omsk time, bound and sanitize prompts, and support hiding prompt text', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T00:00:00Z') })
  const lines: string[] = []
  const log = createPrivateLlmLogger({}, (line) => lines.push(line))
  log({ type: 'prompt', requestId: '0001', clientIp: '::ffff:192.168.0.25', prompt: 'Вопрос\n\u001b[31m' + 'я'.repeat(250) })
  assert.match(lines[0], /^\[06:00:00\] \[#0001\] \[192\.168\.0\.25\] Вопрос: /)
  assert.ok(!/[\r\n\u001b]/.test(lines[0]))
  const promptText = JSON.parse(lines[0].split('Вопрос: ')[1])
  assert.equal([...promptText].length, 201)
  assert.ok(promptText.endsWith('…'))
  const hiddenLog = createPrivateLlmLogger({ logPrompts: false }, (line) => lines.push(line))
  hiddenLog({ type: 'prompt', requestId: '0002', clientIp: '127.0.0.1', prompt: 'private text' })
  assert.equal(lines.length, 1)
})

test('logging failures do not interrupt chat or occupy the generation slot', async (t) => {
  const f = await fixture(t, { logger: () => { throw new Error('output unavailable') } })
  assert.equal((await f.post()).status, 200)
  assert.equal((await f.status()).queue.active, 0)
})

test('full queue returns 503 and rejected requests never reach Ollama', async (t) => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { maxQueueSize: 1, chat: async (_req, res) => { entered.resolve(); await release.promise; res.json({ done: true, message: { content: 'ok' } }) } })
  const first = f.post()
  await entered.promise
  const second = f.post()
  await f.waitForQueue(1)
  const blocked = await f.post()
  assert.equal(blocked.status, 503)
  assert.match((await blocked.json()).error, /Очередь заполнена/)
  assert.equal(blocked.headers.get('retry-after'), '2')
  release.resolve()
  assert.equal((await first).status, 200)
  assert.equal((await second).status, 200)
  assert.equal(f.requests.length, 2)
})

test('queued client cancellation removes it immediately and updates the next position', async (t) => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { chat: async (req, res) => {
    if (req.body.messages[0].content === 'Привет') { entered.resolve(); await release.promise }
    res.type('application/x-ndjson').end('{"done":true,"message":{"content":"ok"}}\n')
  } })
  const first = f.post({ ...question, stream: true })
  await entered.promise
  const abort = new AbortController()
  const canceled = await fetch(f.url + '/api/local-llm/chat', { method: 'POST', headers, signal: abort.signal, body: JSON.stringify({ messages: [{ role: 'user', content: 'canceled' }], stream: true }) })
  const next = await f.post({ messages: [{ role: 'user', content: 'next' }], stream: true })
  const reader = canceled.body!.getReader()
  await reader.read(); abort.abort(); await reader.cancel().catch(() => {})
  await f.waitForQueue(1)
  release.resolve()
  await (await first).text()
  const events = (await next.text()).trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(events.some((event) => event.queueInfo?.state === 'queued' && event.queueInfo.position === 1))
  assert.deepEqual(f.requests.map((req) => req.messages[0].content), ['Привет', 'next'])
})

test('queue deadline returns 504 in JSON or NDJSON without starting a generation', async (t) => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { queueTimeoutMs: 50, chat: async (_req, res) => { entered.resolve(); await release.promise; res.json({ done: true, message: { content: 'ok' } }) } })
  const first = f.post()
  await entered.promise
  const jsonWaiting = f.post()
  const streamWaiting = await f.post({ ...question, stream: true })
  const jsonTimeout = await jsonWaiting
  assert.equal(jsonTimeout.status, 504)
  assert.match((await jsonTimeout.json()).error, /ожидания в очереди/)
  const events = (await streamWaiting.text()).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(events[0].queueInfo.state, 'queued')
  assert.equal(events[events.length - 1].status, 504)
  assert.equal(f.requests.length, 1)
  assert.equal((await f.status()).queue.waiting, 0)
  release.resolve(); assert.equal((await first).status, 200)
  assert.equal((await f.post()).status, 200)
})

test('generation timeout starts after promotion and the queue timer stops after promotion', async (t) => {
  const entered = deferred(), release = deferred()
  let attempt = 0
  const f = await fixture(t, { timeoutMs: 150, queueTimeoutMs: 120, chat: async (_req, res) => {
    if (attempt++ === 0) { entered.resolve(); await release.promise }
    else await new Promise((resolve) => setTimeout(resolve, 100))
    res.json({ done: true, message: { content: 'ok' } })
  } })
  const first = f.post()
  await entered.promise
  const second = f.post()
  await f.waitForQueue(1)
  await new Promise((resolve) => setTimeout(resolve, 90))
  release.resolve()
  await first
  const result = await second
  assert.equal(result.status, 200)
  assert.ok((await result.json()).queueInfo.waitedMs >= 90)
})

test('a failed active generation promotes the next queued request', async (t) => {
  const entered = deferred(), release = deferred()
  let attempt = 0
  const f = await fixture(t, { chat: async (_req, res) => {
    if (attempt++ === 0) { entered.resolve(); await release.promise; res.status(503).json({ error: 'upstream failure' }) }
    else res.json({ done: true, message: { content: 'next' } })
  } })
  const first = f.post()
  await entered.promise
  const second = f.post()
  await f.waitForQueue(1)
  release.resolve()
  assert.equal((await first).status, 502)
  assert.equal((await second).status, 200)
  assert.equal((await f.status()).queue.active, 0)
})

test('canceling an active stream promotes the next queued request', async (t) => {
  let attempt = 0
  const closed = deferred()
  const f = await fixture(t, { chat: (_req, res) => {
    if (attempt++ === 0) {
      res.type('application/x-ndjson'); res.write('{"done":false,"message":{"content":"first"}}\n')
      res.on('close', closed.resolve)
    } else res.type('application/x-ndjson').end('{"done":true,"message":{"content":"next"}}\n')
  } })
  const abort = new AbortController()
  const first = await fetch(f.url + '/api/local-llm/chat', { method: 'POST', headers, signal: abort.signal, body: JSON.stringify({ ...question, stream: true }) })
  const second = await f.post({ ...question, stream: true })
  const reader = first.body!.getReader()
  await reader.read(); abort.abort(); await reader.cancel().catch(() => {})
  await closed.promise
  const events = (await second.text()).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(events[0].queueInfo.state, 'queued')
  assert.equal(events[events.length - 1].message.content, 'next')
  assert.equal((await f.status()).queue.active, 0)
})

test('upstream failure releases the generation slot', async (t) => {
  let attempt = 0
  const f = await fixture(t, { chat: (_req, res) => { if (attempt++ === 0) res.status(503).json({ error: 'offline' }); else res.json({ done: true, message: { content: 'ok' } }) } })
  assert.equal((await f.post()).status, 502)
  assert.equal((await f.post()).status, 200)
})

test('timeout aborts the upstream and releases the generation slot', async (t) => {
  let attempt = 0
  const closed = deferred()
  const f = await fixture(t, { timeoutMs: 80, chat: (_req, res) => {
    if (attempt++ === 0) res.on('close', closed.resolve)
    else res.json({ done: true, message: { content: 'ok' } })
  } })
  assert.equal((await f.post()).status, 504)
  await closed.promise
  assert.equal((await f.post()).status, 200)
})

test('disconnecting a streaming client cancels generation and permits the next request', async (t) => {
  let attempt = 0
  const closed = deferred()
  const f = await fixture(t, { chat: (_req, res) => {
    if (attempt++ === 0) {
      res.type('application/x-ndjson'); res.write('{"message":{"content":"first"},"done":false}\n')
      res.on('close', closed.resolve)
    } else res.json({ done: true, message: { content: 'next' } })
  } })
  const abort = new AbortController()
  const response = await fetch(f.url + '/api/local-llm/chat', { method: 'POST', headers, body: JSON.stringify({ messages: question.messages }), signal: abort.signal })
  const reader = response.body!.getReader()
  await reader.read()
  abort.abort()
  await reader.cancel().catch(() => {})
  await closed.promise
  assert.equal((await f.post()).status, 200)
})

test('shared rate limit cannot be bypassed with proxy headers; unauthorized requests do not consume it', async (t) => {
  const f = await fixture(t, { rate: 2 })
  assert.equal((await f.post(question, { Authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await f.post()).status, 200)
  assert.equal((await f.post()).status, 200)
  const limited = await f.post(question, { 'X-Forwarded-For': '10.0.0.99' })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('ratelimit-remaining'), '0')
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
  assert.equal((await fetch(f.url + '/api/local-llm/status', { headers })).status, 200)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60001 })
  assert.equal((await f.post()).status, 200)
})
