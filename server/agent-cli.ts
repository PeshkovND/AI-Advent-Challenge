import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

type CliConfig = {
  id?: string
  config?: Record<string, unknown>
  agents?: Array<Record<string, unknown>>
}

const [command = 'create', ...argumentsList] = process.argv.slice(2)
const configPath = readArgument('--config')
const serviceUrl = process.env.AGENT_SERVICE_URL?.replace(/\/$/, '') || 'http://localhost:8787'

if (!configPath) {
  console.error('Укажите файл конфигурации: npm run agents:cli -- create --config agent-config.json')
  process.exit(1)
}

if (!['create', 'bulk'].includes(command)) {
  console.error('Доступные команды: create и bulk.')
  process.exit(1)
}

const raw = JSON.parse(await readFile(resolve(configPath), 'utf8')) as CliConfig | Array<Record<string, unknown>>
const isBulk = command === 'bulk' || Array.isArray(raw) || Array.isArray((raw as CliConfig).agents)
const endpoint = `${serviceUrl}/api/agents${isBulk ? '/bulk' : ''}`
const body = isBulk
  ? { agents: Array.isArray(raw) ? raw : raw.agents }
  : raw

const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const result = await response.json() as Record<string, unknown>
if (!response.ok) {
  console.error(`Ошибка ${response.status}: ${typeof result.error === 'string' ? result.error : 'не удалось создать агента.'}`)
  process.exit(1)
}

console.log(JSON.stringify(result, null, 2))

function readArgument(name: string) {
  const index = argumentsList.indexOf(name)
  return index >= 0 ? argumentsList[index + 1] : undefined
}
