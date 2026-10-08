import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

const base = new URL(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Для этой демонстрации нужен локальный OLLAMA_BASE_URL.')
const model = process.env.OLLAMA_CHAT_MODEL || 'qwen3.5:4b'
function limit(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} должен быть положительным целым числом.`)
  return value
}
const context = limit('OLLAMA_CHAT_CONTEXT', 32768)
const maxOutput = limit('OLLAMA_CHAT_MAX_TOKENS', 4096)
if (maxOutput >= context) throw new Error('Лимит ответа должен быть меньше размера контекста.')
const prompts = [
  { level: 'Простой', prompt: 'Сколько будет 17 + 25? Ответь одним числом.' },
  { level: 'Средний', prompt: 'Объясни на русском разницу между процессом и потоком. Приведи пример и уложись в 150 слов.' },
  { level: 'Сложный', prompt: 'Напиши TypeScript-функцию uniqueById<T extends { id: string }>(items: T[]): T[], которая удаляет дубликаты по id, сохраняет порядок и первое вхождение. Объясни сложность и покажи пример с пустым массивом и дубликатами. Ответь на русском.' },
]
async function api(path: string, body?: unknown) {
  const response = await fetch(new URL(path, base), { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(300_000) })
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`)
  return response.json()
}
const automatic = process.argv.includes('--auto')
async function* questions() {
  if (automatic) {
    yield* prompts
    return
  }
  console.log('Введите вопрос и нажмите Enter. Для выхода: /exit или Ctrl+D. Каждый вопрос отправляется отдельно, без истории.')
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
  let closed = false
  input.on('close', () => { closed = true })
  input.setPrompt('Вы: ')
  input.prompt()
  let count = 0
  try {
    for await (const line of input) {
      const prompt = line.trim()
      if (prompt === '/exit') break
      if (prompt) yield { level: `Запрос ${++count}`, prompt }
      if (!closed) input.prompt()
    }
  } finally {
    input.close()
  }
}
async function generate(prompt: string) {
  const response = await fetch(new URL('/api/chat', base), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true, think: false, keep_alive: '60s', options: { num_ctx: context, num_predict: maxOutput, temperature: 0.2 } }),
    signal: AbortSignal.timeout(600_000),
  })
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`)
  if (!response.body) throw new Error('Ollama вернула пустой поток.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', answer = ''
  let final: { done_reason?: string; eval_duration?: number; eval_count?: number; prompt_eval_count?: number } | undefined
  const consume = (line: string) => {
    if (!line.trim()) return
    const chunk = JSON.parse(line)
    if (chunk.error) throw new Error(String(chunk.error))
    const text = chunk.message?.content || ''
    answer += text
    process.stdout.write(text)
    if (chunk.done) final = chunk
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
      }
      if (done) { consume(buffer); break }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  if (!final) throw new Error('Поток прервался до завершения ответа.')
  if (!answer.trim()) throw new Error('Модель не вернула текст ответа.')
  return { ...final, answer }
}
async function main() {
  const details = await api('/api/show', { model })
  console.log(`Локальная модель: ${model}; ${details.details?.quantization_level}; контекст: ${context}; лимит ответа: ${maxOutput}`)
  const results: Record<string, unknown>[] = []
  const output = resolve(process.argv.slice(2).find((arg) => arg !== '--auto') || (automatic ? 'data/day-26-results.json' : 'data/day-26-console-results.json'))
  const save = async () => {
    await mkdir(resolve(output, '..'), { recursive: true })
    await writeFile(output, JSON.stringify({ createdAt: new Date().toISOString(), baseUrl: base.origin, model, details: details.details, options: { num_ctx: context, num_predict: maxOutput, think: false, keep_alive: '60s' }, results }, null, 2) + '\n')
  }
  for await (const item of questions()) {
    if (automatic) console.log(`\n${item.level}: ${item.prompt}`)
    else console.log('Модель отвечает…')
    const start = performance.now()
    try {
      const response = await generate(item.prompt)
      const seconds = (performance.now() - start) / 1000
      const tokensPerSecond = response.eval_duration ? (response.eval_count || 0) / (response.eval_duration / 1e9) : null
      console.log(`\nВремя: ${seconds.toFixed(1)} с; скорость: ${tokensPerSecond?.toFixed(1)} токенов/с`)
      if (response.done_reason === 'length') console.log('Достигнут лимит ответа. Показан и сохранён частичный текст; можно задать следующий вопрос.')
      results.push({ ...item, answer: response.answer, seconds, tokensPerSecond, promptTokens: response.prompt_eval_count, outputTokens: response.eval_count, doneReason: response.done_reason })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`\nОшибка запроса: ${message}. Можно повторить или задать другой вопрос.`)
      results.push({ ...item, error: message })
      if (automatic) process.exitCode = 1
    }
    await save()
  }
  await save()
  console.log(`\nОтчёт: ${output}`)
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
