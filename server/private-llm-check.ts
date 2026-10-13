import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { privateLlmConfigPath } from './private-llm-config'

loadEnv({ path: [privateLlmConfigPath, resolve('.env')], quiet: true })
const args = process.argv.slice(2)
function argument(name: string, fallback: string) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] || fallback : fallback
}
const target = new URL(argument('--url', `http://127.0.0.1:${process.env.PRIVATE_LLM_PORT || 8788}`))
const apiKey = process.env.PRIVATE_LLM_API_KEY
if (!apiKey) throw new Error('Укажите PRIVATE_LLM_API_KEY или сначала выполните npm run llm:service:init.')
const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
const report: Record<string, unknown> = { checkedAt: new Date().toISOString(), target: target.origin, clientLocation: 'machine-running-this-command', checks: [] }
const checks = report.checks as Array<Record<string, unknown>>
let requestTimeoutMs = 190000
async function request(path: string, init: RequestInit = {}) {
  return fetch(new URL(path, target), { ...init, signal: AbortSignal.timeout(requestTimeoutMs) })
}
async function chat(messages: Array<{ role: 'user' | 'assistant'; content: string }>) {
  const started = Date.now()
  const response = await request('/api/local-llm/chat', { method: 'POST', headers, body: JSON.stringify({ messages, stream: false }) })
  const body = await response.json()
  return { status: response.status, answer: body.message?.content as string | undefined, error: body.error, contextInfo: body.contextInfo, queueInfo: body.queueInfo, elapsedMs: Date.now() - started, retryAfter: response.headers.get('retry-after') }
}
const output = resolve(argument('--output', 'docs/day-30-results.json'))
try {
  assert.equal((await request('/api/local-llm/status')).status, 401)
  checks.push({ name: 'authentication', passed: true, statusWithoutKey: 401 })
  const statusResponse = await request('/api/local-llm/status', { headers })
  assert.equal(statusResponse.status, 200)
  const status = await statusResponse.json()
  assert.equal(status.ready, true, status.error)
  requestTimeoutMs = status.limits.queueTimeoutMs + status.limits.timeoutMs + 10000
  report.service = status
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const prompt of ['Сколько будет 17 + 25? Ответь только числом.', 'Прибавь 8 к предыдущему результату. Ответь только числом.', 'Назови столицу Франции. Ответь одним словом.']) {
    history.push({ role: 'user', content: prompt })
    const result = await chat(history)
    assert.equal(result.status, 200, result.error)
    assert.ok(result.answer?.trim())
    checks.push({ name: 'sequential-chat', passed: true, prompt, ...result })
    history.push({ role: 'assistant', content: result.answer! })
  }
  const overflow = await chat([{ role: 'user', content: 'x'.repeat(status.context) }])
  assert.equal(overflow.status, 400)
  checks.push({ name: 'max-context', passed: true, ...overflow })
  const parallel = await Promise.all(Array.from({ length: 3 }, () => chat([{ role: 'user', content: 'Сколько будет 6 * 7? Ответь только числом.' }])))
  assert.deepEqual(parallel.map((item) => item.status), [200, 200, 200])
  assert.ok(parallel.every((item) => item.answer?.trim()))
  assert.deepEqual(parallel.map((item) => item.queueInfo.initialPosition).sort(), [0, 1, 2])
  checks.push({ name: 'concurrent-requests', passed: true, results: parallel })
  const recovery = await chat([{ role: 'user', content: 'Сколько будет 5 + 5? Ответь только числом.' }])
  assert.equal(recovery.status, 200)
  checks.push({ name: 'recovery-after-concurrency', passed: true, ...recovery })
  const hugeResponse = await request('/api/local-llm/chat', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'a'.repeat(1024 * 1024) }] }) })
  assert.equal(hugeResponse.status, 413)
  checks.push({ name: 'max-body', passed: true, status: hugeResponse.status })
  let rateResult
  for (let index = 0; index <= status.limits.requestsPerMinute; index += 1) {
    rateResult = await chat([])
    if (rateResult.status === 429) break
    assert.equal(rateResult.status, 400)
  }
  assert.equal(rateResult?.status, 429)
  checks.push({ name: 'rate-limit', passed: true, ...rateResult })
  report.passed = true
  console.log(`Проверки пройдены: ${checks.length}. Отчёт: ${output}`)
} catch (error) {
  report.passed = false
  report.error = error instanceof Error ? error.message : String(error)
  console.error(`Проверка не прошла: ${report.error}`)
  process.exitCode = 1
} finally { await writeFile(output, JSON.stringify(report, null, 2) + '\n') }
