import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const apiUrl = (process.env.CALENDAR_E2E_API_URL ?? 'http://localhost:8787').replace(/\/$/, '')
const agentId = `calendar-pipeline-e2e-${randomUUID()}`
const title = `MCP Pipeline ${randomUUID().slice(0, 8)}`
const from = new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000)
const to = new Date(from.getTime() + 10 * 24 * 60 * 60 * 1_000)

type ToolCall = { name: string; isError: boolean; result: { event?: { uid?: string; title?: string } } }
type AgentRun = { output?: string; mcpToolCalls?: ToolCall[] }

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function api<T>(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(data.error ?? `API returned HTTP ${response.status}.`)
  return data
}

async function withCalendar<T>(operation: (client: Client) => Promise<T>) {
  const client = new Client({ name: 'calendar-pipeline-e2e-verifier', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'server/yandex-calendar-mcp-server.ts'] }))
  try { return await operation(client) } finally { await client.close() }
}

async function eventExists(uid: string) {
  return withCalendar(async (client) => {
    const result = await client.callTool({ name: 'get_calendar_events', arguments: { calendar: 'events-default', from: from.toISOString(), to: to.toISOString() } })
    assert(!result.isError, 'Read-only CalDAV verification failed.')
    const events = (result.structuredContent as { events?: Array<{ uid: string; title: string }> } | undefined)?.events ?? []
    return events.find((event) => event.uid === uid)
  })
}

async function main() {
  if (process.env.RUN_CALENDAR_PIPELINE_E2E !== '1') {
    throw new Error('This test changes the real calendar. Run with RUN_CALENDAR_PIPELINE_E2E=1 only.')
  }

  let uid: string | undefined
  try {
    await api('/api/agents', 'POST', {
      id: agentId,
      config: {
        name: 'Calendar Pipeline E2E',
        provider: 'deepseek',
        model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash',
        systemPrompt: 'Выполняй только явную текущую просьбу. Для поиска свободного окна и создания события обязательно последовательно вызови get_calendar_events, find_free_calendar_slots и create_calendar_event. Подтверждай создание только по MCP receipt.',
        mcp: { enabled: true, servers: ['yandex-calendar'] },
      },
    })
    const result = await api<AgentRun>(`/api/agents/${agentId}/run`, 'POST', {
      input: `В календаре events-default найди первое свободное окно на 60 минут в будние дни с 09:00 до 18:00 по Asia/Omsk в период с ${from.toISOString()} до ${to.toISOString()} и создай там тестовое событие «${title}».`,
      clientContext: { timeZone: 'Asia/Omsk' },
    })
    const successful = result.mcpToolCalls?.filter((call) => !call.isError) ?? []
    const names = successful.map((call) => call.name)
    assert(names.join('|') === 'get_calendar_events|find_free_calendar_slots|create_calendar_event', `Expected automatic 3-step pipeline, got: ${names.join(', ') || result.output || 'no calls'}`)
    uid = successful[2]?.result.event?.uid
    assert(uid, 'Create receipt has no event UID.')
    assert((await eventExists(uid))?.title === title, 'Pipeline-created event was not found in CalDAV.')
    console.log('Calendar MCP pipeline E2E: read → find slot → create → verify passed.')
  } finally {
    if (uid) await withCalendar((client) => client.callTool({ name: 'delete_calendar_event', arguments: { uid, calendar: 'events-default' } })).catch(() => {})
    await fetch(`${apiUrl}/api/agents/${agentId}`, { method: 'DELETE' }).catch(() => {})
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
