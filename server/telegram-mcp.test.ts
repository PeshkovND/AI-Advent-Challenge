import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { fileURLToPath } from 'node:url'

const serverPath = fileURLToPath(new URL('./telegram-mcp-server.ts', import.meta.url))

type CapturedRequest = { path?: string; body: Record<string, unknown> }

test('Telegram MCP sends and updates a note through its isolated server contract', async () => {
  const requests: CapturedRequest[] = []
  const api = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> })
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ ok: true, result: { message_id: 42, date: 1_790_000_000, chat: { id: -100123 } } }))
    })
  })
  api.listen(0, '127.0.0.1')
  await once(api, 'listening')
  const address = api.address()
  assert.ok(address && typeof address === 'object')

  const client = new Client({ name: 'telegram-mcp-test', version: '1.0.0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', serverPath],
    env: {
      PATH: process.env.PATH ?? '',
      TELEGRAM_BOT_TOKEN: '123456:test-token',
      TELEGRAM_CHAT_ID: '-100123',
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${address.port}`,
    },
  }))
  try {
    const tools = await client.listTools()
    assert.ok(tools.tools.some((tool) => tool.name === 'send_telegram_note'))
    assert.ok(tools.tools.some((tool) => tool.name === 'edit_telegram_note'))

    const sent = await client.callTool({ name: 'send_telegram_note', arguments: { text: 'План на завтра', disableNotification: true } })
    assert.notEqual(sent.isError, true)
    assert.deepEqual(sent.structuredContent, { messageId: 42, chatId: '-100123', sentAt: '2026-09-21T14:13:20.000Z' })
    assert.deepEqual(requests[0], {
      path: '/bot123456:test-token/sendMessage',
      body: { chat_id: '-100123', text: 'План на завтра', disable_notification: true },
    })

    const edited = await client.callTool({ name: 'edit_telegram_note', arguments: { messageId: 42, text: 'План на завтра (обновлён)' } })
    assert.notEqual(edited.isError, true)
    assert.deepEqual(requests[1], {
      path: '/bot123456:test-token/editMessageText',
      body: { chat_id: '-100123', message_id: 42, text: 'План на завтра (обновлён)' },
    })
  } finally {
    await client.close()
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()))
  }
})
