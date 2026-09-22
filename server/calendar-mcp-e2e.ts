import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const apiUrl = (process.env.CALENDAR_E2E_API_URL ?? 'http://localhost:8787').replace(/\/$/, '')
const agentId = `calendar-e2e-${randomUUID()}`
const suffix = randomUUID().slice(0, 8)
const firstTitle = `MCP E2E ${suffix} A`
const updatedTitle = `MCP E2E ${suffix} B`
const startsAt = new Date(Date.now() + 48 * 60 * 60 * 1_000).toISOString()
const endsAt = new Date(new Date(startsAt).getTime() + 60 * 60 * 1_000).toISOString()

type ToolCall = { name: string; isError: boolean; result: { event?: { uid?: string } } }
type AgentRun = { output?: string; mcpToolCalls?: ToolCall[] }
type CalendarEvent = { uid: string; title: string }

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
  const client = new Client({ name: 'calendar-e2e-verifier', version: '1.0.0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'server/yandex-calendar-mcp-server.ts'],
  }))
  try {
    return await operation(client)
  } finally {
    await client.close()
  }
}

async function findEvent(uid: string) {
  return withCalendar(async (client) => {
    const result = await client.callTool({
      name: 'get_calendar_events',
      arguments: {
        calendar: 'events-default',
        from: new Date(new Date(startsAt).getTime() - 60 * 60 * 1_000).toISOString(),
        to: new Date(new Date(endsAt).getTime() + 60 * 60 * 1_000).toISOString(),
      },
    })
    assert(!result.isError, 'Read-only CalDAV verification failed.')
    const events = (result.structuredContent as { events?: CalendarEvent[] } | undefined)?.events ?? []
    return events.find((event) => event.uid === uid)
  })
}

async function main() {
  if (process.env.RUN_CALENDAR_E2E !== '1') {
    throw new Error('This test changes the real calendar. Run with RUN_CALENDAR_E2E=1 only.')
  }

  let uid: string | undefined
  try {
    await api(`/api/agents`, 'POST', {
      id: agentId,
      config: {
        name: 'Calendar MCP E2E',
        provider: 'deepseek',
        model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash',
        systemPrompt: 'Execute only the current explicit user request. Confirm calendar changes only from the MCP result.',
        mcp: { enabled: true, servers: ['yandex-calendar'] },
      },
    })

    const created = await api<AgentRun>(`/api/agents/${agentId}/run`, 'POST', {
      input: `Создай тестовое событие «${firstTitle}» с ${startsAt} до ${endsAt}.`,
    })
    const createCall = created.mcpToolCalls?.find((call) => call.name === 'create_calendar_event' && !call.isError)
    uid = createCall?.result.event?.uid
    assert(uid, `Create was not confirmed by MCP: ${created.output ?? 'no output'}`)
    assert((await findEvent(uid))?.title === firstTitle, 'Created event was not found in CalDAV.')

    const updated = await api<AgentRun>(`/api/agents/${agentId}/run`, 'POST', {
      input: `Переименуй только что созданное тестовое событие в «${updatedTitle}». Время не меняй.`,
    })
    assert(updated.mcpToolCalls?.some((call) => call.name === 'update_calendar_event' && !call.isError), `Update was not confirmed by MCP: ${updated.output ?? 'no output'}`)
    assert((await findEvent(uid))?.title === updatedTitle, 'Updated title was not found in CalDAV.')

    const deleted = await api<AgentRun>(`/api/agents/${agentId}/run`, 'POST', {
      input: 'Удаляй только что переименованное тестовое событие.',
    })
    assert(deleted.mcpToolCalls?.some((call) => call.name === 'delete_calendar_event' && !call.isError), `Delete was not confirmed by MCP: ${deleted.output ?? 'no output'}`)
    assert(!await findEvent(uid), 'Deleted event is still present in CalDAV.')
    uid = undefined
    console.log('Calendar MCP E2E: create → verify → update → verify → delete → verify passed.')
  } finally {
    if (uid) {
      await withCalendar(async (client) => {
        await client.callTool({ name: 'delete_calendar_event', arguments: { uid, calendar: 'events-default' } })
      }).catch(() => {})
    }
    await fetch(`${apiUrl}/api/agents/${agentId}`, { method: 'DELETE' }).catch(() => {})
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
