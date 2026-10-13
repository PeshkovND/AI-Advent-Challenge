import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { privateLlmConfigPath } from './private-llm-config'

loadEnv({ path: [privateLlmConfigPath, resolve('.env')], quiet: true })
const args = process.argv.slice(2)
const argument = (name: string, fallback: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] || fallback : fallback }
const target = new URL(argument('--url', `http://127.0.0.1:${process.env.PRIVATE_LLM_PORT || 8788}`))
const apiKey = process.env.PRIVATE_LLM_API_KEY
if (!apiKey) throw new Error('Нужен PRIVATE_LLM_API_KEY или локальный data/private-llm.env.')
const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
type Result = { id: number; status: number; answer: string; error?: string; elapsedMs: number; events: Array<Record<string, unknown>> }
const report: Record<string, unknown> = { checkedAt: new Date().toISOString(), target: target.origin, clientLocation: 'machine-running-this-command' }
const output = resolve(argument('--output', 'docs/day-30-queue-results.json'))
const startedOrder: number[] = []
let requestTimeoutMs = 190000

async function chat(id: number): Promise<Result> {
  const started = Date.now()
  const response = await fetch(new URL('/api/local-llm/chat', target), { method: 'POST', headers,
    body: JSON.stringify({ messages: [{ role: 'user', content: `Сколько будет 20 + ${id}? Ответь только числом.` }], stream: true }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
  const result: Result = { id, status: response.status, answer: '', elapsedMs: 0, events: [] }
  if (!response.ok) {
    result.error = (await response.json()).error
    console.log(`#${id}: HTTP ${response.status} — ${result.error}`)
  } else {
    assert.ok(response.body)
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = '', done = false
    const consume = (line: string) => {
      if (!line.trim()) return
      const event = JSON.parse(line)
      if (event.queueInfo) {
        result.events.push({ ...event.queueInfo, elapsedMs: Date.now() - started })
        if (event.queueInfo.state === 'queued') console.log(`#${id}: ожидает, позиция ${event.queueInfo.position}`)
        else { startedOrder.push(id); console.log(`#${id}: генерация началась, ожидание ${event.queueInfo.waitedMs} мс`) }
      }
      result.answer += event.message?.content || ''
      if (event.done) done = true
      if (event.error) { result.error = event.error; result.status = event.status || 502 }
    }
    try {
      while (true) {
        const chunk = await reader.read()
        buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1) }
        if (chunk.done) { consume(buffer); break }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    if (!result.error && (!done || !result.answer.trim())) { result.error = 'Ответ не завершён.'; result.status = 502 }
    console.log(`#${id}: ${result.error || `ответ ${result.answer}`}`)
  }
  result.elapsedMs = Date.now() - started
  return result
}

try {
  const statusResponse = await fetch(new URL('/api/local-llm/status', target), { headers, signal: AbortSignal.timeout(10000) })
  assert.equal(statusResponse.status, 200)
  const status = await statusResponse.json()
  assert.equal(status.ready, true, status.error)
  requestTimeoutMs = status.limits.queueTimeoutMs + status.limits.timeoutMs + 10000
  assert.ok(status.limits.maxQueueSize > 0, 'Очередь выключена. Установите PRIVATE_LLM_QUEUE_SIZE=3 и перезапустите сервис.')
  assert.equal(status.queue.active + status.queue.waiting, 0, 'Перед демонстрацией дождитесь завершения текущих запросов.')
  const count = status.limits.maxQueueSize + 2
  assert.ok(status.limits.requestsPerMinute > count, 'Для демонстрации увеличьте rate limit выше размера очереди + 2.')
  report.service = status
  console.log(`Отправляю ${count} запросов одновременно: 1 генерация, ${status.limits.maxQueueSize} места в очереди.`)
  const results = await Promise.all(Array.from({ length: count }, (_, index) => chat(index + 1)))
  report.results = results
  report.startedOrder = [...startedOrder]
  assert.equal(results.filter((item) => item.status === 200).length, count - 1)
  assert.equal(results.filter((item) => item.status === 503).length, 1)
  const admitted = results.filter((item) => item.status === 200)
  assert.deepEqual(admitted.map((item) => item.events.find((event) => event.state === 'running')?.initialPosition).sort((a, b) => Number(a) - Number(b)), Array.from({ length: count - 1 }, (_, index) => index))
  const fifo = [...admitted].sort((a, b) => Number(a.events.find((event) => event.state === 'running')?.initialPosition) - Number(b.events.find((event) => event.state === 'running')?.initialPosition)).map((item) => item.id)
  assert.deepEqual(report.startedOrder, fifo)
  const recovery = await chat(count + 1)
  report.recovery = recovery
  assert.equal(recovery.status, 200)
  report.passed = true
  console.log(`FIFO, переполнение и восстановление проверены. Отчёт: ${output}`)
} catch (error) {
  report.passed = false
  report.error = error instanceof Error ? error.message : String(error)
  console.error(`Демонстрация не прошла: ${report.error}`)
  process.exitCode = 1
} finally { await writeFile(output, JSON.stringify(report, null, 2) + '\n') }
