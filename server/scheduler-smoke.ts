import { Client } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { fileURLToPath } from 'node:url'
import { McpToolRuntime } from './mcp-tool-runtime'
import { createScheduledTaskExecutor } from './scheduled-agent-executor'
import { SchedulerStore } from './scheduler-store'
import { SchedulerWorker } from './scheduler-worker'

const databasePath = (() => {
  const value = process.env.SCHEDULER_DB_PATH?.trim()
  if (!value) throw new Error('Для smoke-теста укажите отдельный SCHEDULER_DB_PATH.')
  return value
})()

async function assertWorkerQueue() {
  const store = new SchedulerStore(databasePath)
  const job = store.createJob({
    agentId: 'smoke-agent',
    name: 'Проверка очереди',
    cron: '0 9 * * 1-5',
    timezone: 'Asia/Omsk',
    instructionText: 'Это изолированная проверка без внешних вызовов.',
  })
  const queued = store.enqueueManualRun(job.id)
  const worker = new SchedulerWorker(store, async (claimedJob, run) => ({
    status: 'success',
    reason: 'Подставной executor завершил запуск.',
    summary: `${claimedJob.name}:${run.id}`,
  }))
  await worker.tick()
  const completed = store.getLatestRun(job.id)
  const events = completed ? store.getEvents(completed.id) : []
  if (!completed || completed.id !== queued.id || completed.status !== 'success' || completed.jobId !== job.id) {
    throw new Error('Worker не завершил именно поставленный в очередь запуск.')
  }
  if (!events.some((event) => event.stage === 'claimed') || !events.some((event) => event.stage === 'success')) {
    throw new Error('В журнале запуска отсутствуют обязательные этапы.')
  }
  return { jobId: job.id, runId: completed.id, eventCount: events.length }
}

async function assertMcpUsesConfiguredDatabase() {
  const serverPath = fileURLToPath(new URL('./scheduler-mcp-server.ts', import.meta.url))
  const client = new Client({ name: 'scheduler-smoke', version: '1.0.0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', serverPath],
    env: { ...getDefaultEnvironment(), SCHEDULER_DB_PATH: databasePath, AGENT_TIME_ZONE: 'Asia/Omsk' },
  }))
  try {
    const response = await client.callTool({
      name: 'create_scheduled_agent_task',
      arguments: {
        name: 'Проверка MCP-контракта',
        cron: '*/5 * * * *',
        timezone: 'Asia/Omsk',
        instruction: 'Тестовый контракт MCP. Никаких внешних вызовов.',
        agentId: 'smoke-agent',
      },
    })
    if (response.isError) throw new Error('MCP-сервер вернул ошибку при создании задачи.')
    const jobs = new SchedulerStore(databasePath).listJobs()
    if (!jobs.some((job) => job.name === 'Проверка MCP-контракта')) throw new Error('MCP-сервер записал задачу не в указанную SQLite-базу.')
    return { storedJobs: jobs.length }
  } finally {
    await client.close()
  }
}

async function assertCalendarReadOnlyCatalogue() {
  const calendarPath = fileURLToPath(new URL('./yandex-calendar-mcp-server.ts', import.meta.url))
  const runtime = new McpToolRuntime({
    model: 'deepseek-v4-flash',
    servers: {
      calendar: { command: process.execPath, args: ['--import', 'tsx', calendarPath], env: { AGENT_TIME_ZONE: 'Asia/Omsk' } },
    },
  })
  const tools = await runtime.listTools(['calendar'])
  const readable = tools.filter((tool) => tool.readOnly).map((tool) => tool.name)
  if (readable.join(',') !== 'get_calendar_events') throw new Error(`Read-only каталог календаря некорректен: ${readable.join(', ')}`)
  return { readable }
}

async function assertUnverifiedSummaryIsRejected() {
  const executor = createScheduledTaskExecutor({
    run: async () => ({ output: JSON.stringify({ status: 'success', reason: 'Тест', summary: 'Неподтверждённая сводка.' }), mcpToolCalls: [] }),
  } as never)
  const outcome = await executor({
    id: '00000000-0000-4000-8000-000000000001', agentId: 'smoke-agent', name: 'Проверка receipt', cron: '0 9 * * *', timezone: 'Asia/Omsk', instructionText: 'Тест', enabled: true, nextRunAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }, { id: '00000000-0000-4000-8000-000000000002', jobId: '00000000-0000-4000-8000-000000000001', trigger: 'manual', status: 'running' })
  if (outcome.status !== 'error') throw new Error('Неподтверждённая success-сводка не была отклонена.')
  return { rejected: true }
}

const worker = await assertWorkerQueue()
const mcp = await assertMcpUsesConfiguredDatabase()
const calendar = await assertCalendarReadOnlyCatalogue()
const receipt = await assertUnverifiedSummaryIsRejected()
console.log(JSON.stringify({ ok: true, worker, mcp, calendar, receipt }))
