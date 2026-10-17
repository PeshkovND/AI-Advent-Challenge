import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { McpToolRuntime } from './mcp-tool-runtime'

const calendarPath = fileURLToPath(new URL('./yandex-calendar-mcp-server.ts', import.meta.url))
const schedulerPath = fileURLToPath(new URL('./scheduler-mcp-server.ts', import.meta.url))
const telegramPath = fileURLToPath(new URL('./telegram-mcp-server.ts', import.meta.url))

test('runtime discovers one qualified tool catalogue from Calendar, Scheduler and Telegram servers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-orchestration-'))
  const runtime = new McpToolRuntime({
    model: 'test-model',
    servers: {
      'yandex-calendar': { command: process.execPath, args: ['--import', 'tsx', calendarPath] },
      scheduler: { command: process.execPath, args: ['--import', 'tsx', schedulerPath], env: { SCHEDULER_DB_PATH: join(directory, 'scheduler.sqlite') } },
      telegram: { command: process.execPath, args: ['--import', 'tsx', telegramPath] },
    },
  })
  try {
    const tools = await runtime.listTools(['yandex-calendar', 'scheduler', 'telegram'])
    assert.ok(tools.some((tool) => tool.serverId === 'yandex-calendar' && tool.name === 'get_calendar_events'))
    assert.ok(tools.some((tool) => tool.serverId === 'scheduler' && tool.name === 'create_scheduled_agent_task'))
    assert.ok(tools.some((tool) => tool.serverId === 'telegram' && tool.name === 'send_telegram_note'))
    assert.ok(tools.every((tool) => ['yandex-calendar', 'scheduler', 'telegram'].includes(tool.serverId)))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
