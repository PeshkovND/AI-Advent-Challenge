import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'

export const privateLlmConfigPath = resolve('data/private-llm.env')

export async function initializePrivateLlmEnvironment() {
  await mkdir(resolve('data'), { recursive: true })
  try {
    await writeFile(privateLlmConfigPath, `# Локальный секрет. Не добавлять в Git и не передавать в URL.
PRIVATE_LLM_API_KEY=${randomBytes(32).toString('hex')}
PRIVATE_LLM_HOST=0.0.0.0
PRIVATE_LLM_PORT=8788
PRIVATE_LLM_CONTEXT=8192
PRIVATE_LLM_MAX_TOKENS=1024
PRIVATE_LLM_RATE_LIMIT=12
PRIVATE_LLM_TIMEOUT_MS=120000
PRIVATE_LLM_QUEUE_SIZE=3
PRIVATE_LLM_QUEUE_TIMEOUT_MS=60000
PRIVATE_LLM_LOG_PROMPTS=1
`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  // Process environment > private service config > existing application config.
  loadEnv({ path: [privateLlmConfigPath, resolve('.env')], quiet: true })
  return readPrivateLlmConfig()
}

export function readPrivateLlmConfig(env: NodeJS.ProcessEnv = process.env) {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(env[name] ?? fallback)
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}: нужно целое число от ${min} до ${max}.`)
    return value
  }
  const apiKey = env.PRIVATE_LLM_API_KEY || ''
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(apiKey)) throw new Error('PRIVATE_LLM_API_KEY: нужен ключ из 32–256 букв, цифр, _ или -. Выполните npm run llm:service:init.')
  const host = env.PRIVATE_LLM_HOST || '0.0.0.0'
  if (!isIP(host)) throw new Error('PRIVATE_LLM_HOST должен быть IP-адресом интерфейса сервера.')
  const port = integer('PRIVATE_LLM_PORT', 8788, 1, 65535)
  const context = integer('PRIVATE_LLM_CONTEXT', 8192, 1024, 32768)
  const maxTokens = integer('PRIVATE_LLM_MAX_TOKENS', 1024, 1, 8192)
  if (maxTokens + 512 >= context) throw new Error('Контекст должен вмещать ответ, вопрос и запас 512 токенов.')
  const requestsPerMinute = integer('PRIVATE_LLM_RATE_LIMIT', 12, 1, 600)
  const timeoutMs = integer('PRIVATE_LLM_TIMEOUT_MS', 120000, 1000, 600000)
  const maxQueueSize = integer('PRIVATE_LLM_QUEUE_SIZE', 3, 0, 10)
  const queueTimeoutMs = integer('PRIVATE_LLM_QUEUE_TIMEOUT_MS', 60000, 1000, 600000)
  const logPrompts = integer('PRIVATE_LLM_LOG_PROMPTS', 1, 0, 1) === 1
  const baseUrl = env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'
  const model = env.OLLAMA_CHAT_MODEL || 'qwen3.5:4b'
  if (!model.trim() || /(?:[:/-]cloud)(?:$|[:/-])/i.test(model)) throw new Error('Для приватного сервиса выберите локальную модель Ollama.')
  return { apiKey, host, port, baseUrl, model, context, maxTokens, timeoutMs, requestsPerMinute, maxQueueSize, queueTimeoutMs, logPrompts }
}

export type PrivateLlmConfig = ReturnType<typeof readPrivateLlmConfig>
