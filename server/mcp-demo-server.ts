import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

function createDemoServer() {
  const server = new McpServer({
    name: 'day-16-demo-server',
    version: '1.0.0',
  })

  server.registerTool(
    'greet',
    {
      title: 'Приветствие',
      description: 'Возвращает персональное приветствие.',
      inputSchema: z.object({
        name: z.string().min(1).describe('Имя для приветствия'),
      }),
      outputSchema: z.object({
        greeting: z.string(),
      }),
    },
    async ({ name }) => {
      const greeting = `Привет, ${name}!`

      return {
        content: [{ type: 'text', text: greeting }],
        structuredContent: { greeting },
      }
    },
  )

  server.registerTool(
    'get_current_time',
    {
      title: 'Текущее время',
      description: 'Возвращает текущее время на сервере в формате ISO 8601.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        currentTime: z.string(),
      }),
    },
    async () => {
      const currentTime = new Date().toISOString()

      return {
        content: [{ type: 'text', text: currentTime }],
        structuredContent: { currentTime },
      }
    },
  )

  server.registerTool(
    'calculate_sum',
    {
      title: 'Сложение чисел',
      description: 'Складывает два числа и возвращает их сумму.',
      inputSchema: z.object({
        first: z.number().describe('Первое слагаемое'),
        second: z.number().describe('Второе слагаемое'),
      }),
      outputSchema: z.object({
        sum: z.number(),
      }),
    },
    async ({ first, second }) => {
      const sum = first + second

      return {
        content: [{ type: 'text', text: String(sum) }],
        structuredContent: { sum },
      }
    },
  )

  return server
}

serveStdio(createDemoServer, {
  onerror: (error) => console.error('Ошибка MCP-сервера:', error),
})
