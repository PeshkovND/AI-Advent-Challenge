import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { fileURLToPath } from 'node:url'

const serverPath = fileURLToPath(new URL('./yandex-calendar-mcp-server.ts', import.meta.url))

test('Calendar MCP exposes the read → analyze step without a CalDAV request', async () => {
  const client = new Client({ name: 'calendar-pipeline-test', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', serverPath] }))
  try {
    const listed = await client.listTools()
    assert.ok(listed.tools.some((tool) => tool.name === 'get_calendar_events'))
    assert.ok(listed.tools.some((tool) => tool.name === 'find_free_calendar_slots'))

    const result = await client.callTool({
      name: 'find_free_calendar_slots',
      arguments: {
        events: [{ uid: 'test-event', title: 'Занято', startsAt: '2026-09-28T10:00:00+06:00', endsAt: '2026-09-28T11:00:00+06:00', calendar: 'events-default' }],
        from: '2026-09-28T09:00:00+06:00',
        to: '2026-09-28T18:00:00+06:00',
        durationMinutes: 60,
        workdayStart: '09:00',
        workdayEnd: '18:00',
        timezone: 'Asia/Omsk',
      },
    })
    assert.notEqual(result.isError, true)
    const slots = (result.structuredContent as { slots?: Array<{ startsAt: string; endsAt: string }> } | undefined)?.slots
    assert.deepEqual(slots?.[0], { startsAt: '2026-09-28T03:00:00.000Z', endsAt: '2026-09-28T04:00:00.000Z' })
  } finally {
    await client.close()
  }
})
