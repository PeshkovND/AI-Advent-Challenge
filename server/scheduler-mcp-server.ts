import 'dotenv/config'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { SchedulerStore } from './scheduler-store'
import { getDefaultSchedulerTimeZone } from './scheduler-timezone'

const store = new SchedulerStore()
const defaultAgentId = 'day18-scheduler-agent'
const defaultTimeZone = getDefaultSchedulerTimeZone()

function errorResult(error: unknown) {
  return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Не удалось выполнить операцию планировщика.' }], isError: true }
}

const jobShape = z.object({
  id: z.string(),
  agentId: z.string(),
  name: z.string(),
  cron: z.string(),
  timezone: z.string(),
  instructionText: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.string(),
  lastRunAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

function createServer() {
  const server = new McpServer({ name: 'scheduler-mcp', version: '1.0.0' })

  server.registerTool('create_scheduled_agent_task', {
    title: 'Создать периодическую агентскую задачу',
    description: 'Сохраняет периодическую задачу. instruction передаётся будущему запуску без потери естественно-языковых условий пользователя.',
    inputSchema: z.object({
      name: z.string().min(1).max(200).describe('Короткое название задачи'),
      cron: z.string().min(9).max(120).describe('Cron из пяти полей: минута час день-месяца месяц день-недели; например 0 9 * * 1-5'),
      timezone: z.string().min(1).max(100).default(defaultTimeZone).describe('IANA часовой пояс, например Asia/Omsk'),
      instruction: z.string().min(1).max(8_000).describe('Исходная задача и условия пользователя на естественном языке'),
    }),
    outputSchema: z.object({ job: jobShape }),
  }, async ({ name, cron, timezone, instruction }) => {
    try {
      const job = store.createJob({ name, cron, timezone, instructionText: instruction, agentId: defaultAgentId })
      return { content: [{ type: 'text', text: `Задача «${job.name}» создана. Следующий запуск: ${job.nextRunAt}.` }], structuredContent: { job } }
    } catch (error) { return errorResult(error) }
  })

  server.registerTool('list_scheduled_tasks', {
    title: 'Показать периодические задачи',
    description: 'Возвращает сохранённые задания, их статус и следующее выполнение.',
    inputSchema: z.object({}),
    outputSchema: z.object({ jobs: z.array(jobShape) }),
    annotations: { readOnlyHint: true },
  }, async () => {
    try {
      const jobs = store.listJobs()
      return { content: [{ type: 'text', text: `Активных и сохранённых задач: ${jobs.length}.` }], structuredContent: { jobs } }
    } catch (error) { return errorResult(error) }
  })

  server.registerTool('get_scheduled_task_result', {
    title: 'Получить результат периодической задачи',
    description: 'Возвращает последнюю сводку и историю запусков задачи.',
    inputSchema: z.object({ jobId: z.string().uuid() }),
    outputSchema: z.object({ job: jobShape, latestRun: z.unknown().optional(), runs: z.array(z.unknown()) }),
    annotations: { readOnlyHint: true },
  }, async ({ jobId }) => {
    try {
      const job = store.getJob(jobId)
      if (!job) throw new Error('Задание не найдено.')
      const runs = store.getRuns(jobId)
      return { content: [{ type: 'text', text: runs.length ? `Последний запуск: ${runs[0].status}.` : 'Задача ещё не запускалась.' }], structuredContent: { job, ...(runs[0] ? { latestRun: runs[0] } : {}), runs } }
    } catch (error) { return errorResult(error) }
  })

  server.registerTool('delete_scheduled_task', {
    title: 'Удалить периодическую задачу',
    description: 'Отменяет и удаляет задачу вместе с её историей запусков.',
    inputSchema: z.object({ jobId: z.string().uuid() }),
    outputSchema: z.object({ jobId: z.string(), deleted: z.literal(true) }),
  }, async ({ jobId }) => {
    try {
      if (!store.deleteJob(jobId)) throw new Error('Задание не найдено.')
      return { content: [{ type: 'text', text: 'Задача удалена.' }], structuredContent: { jobId, deleted: true } }
    } catch (error) { return errorResult(error) }
  })

  server.registerTool('run_scheduled_task_now', {
    title: 'Запустить периодическую задачу сейчас',
    description: 'Ставит ручной запуск в очередь worker и возвращает идентификатор запуска.',
    inputSchema: z.object({ jobId: z.string().uuid() }),
    outputSchema: z.object({ run: z.object({ id: z.string(), jobId: z.string(), trigger: z.literal('manual'), status: z.literal('queued') }) }),
  }, async ({ jobId }) => {
    try {
      const run = store.enqueueManualRun(jobId)
      return { content: [{ type: 'text', text: 'Ручной запуск поставлен в очередь.' }], structuredContent: { run } }
    } catch (error) { return errorResult(error) }
  })

  return server
}

serveStdio(createServer, { onerror: (error) => console.error('Ошибка Scheduler MCP:', error) })
