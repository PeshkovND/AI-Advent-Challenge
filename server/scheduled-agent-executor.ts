import { z } from 'zod'
import type { AgentRunResult, AgentService } from './agent-service'
import type { ScheduledTaskExecutor } from './scheduler-worker'

export const scheduledAgentId = 'day18-scheduler-agent'

const scheduledDecision = z.object({
  status: z.enum(['success', 'skipped']),
  reason: z.string().min(1).max(4_000),
  summary: z.string().min(1).max(20_000).optional(),
})

const scheduledAgentConfig = {
  name: 'Фоновый агент календарных сводок',
  provider: 'deepseek' as const,
  systemPrompt: `Ты выполняешь фоновые задачи календарных сводок. Работай только с текущей инструкцией worker. Ты можешь читать календарь, но никогда не создавай, не изменяй и не удаляй события. Сначала оцени естественно-языковые условия пользователя. Если запуск сегодня не нужен, верни статус skipped. Если нужен — получи необходимые календарные данные и сформируй сводку.

Верни только JSON без Markdown: {"status":"success"|"skipped","reason":"краткое объяснение","summary":"текст сводки при success"}. Не утверждай, что получил данные календаря, если не было успешного MCP-вызова в этом запуске.`,
  outputPolicy: { format: 'json' as const, maxCharacters: 24_000 },
  mcp: { enabled: true, servers: ['yandex-calendar'], toolAccess: 'read-only' as const },
}

export async function ensureScheduledAgent(service: AgentService) {
  await service.ready
  const existing = service.list().find((agent) => agent.id === scheduledAgentId)
  if (!existing) {
    await service.create({ id: scheduledAgentId, config: scheduledAgentConfig })
  } else if (existing.config.mcp?.toolAccess !== 'read-only') {
    await service.update(scheduledAgentId, scheduledAgentConfig)
  }
}

function scheduledInput(job: { name: string; timezone: string; instructionText: string }) {
  const current = new Intl.DateTimeFormat('ru-RU', {
    timeZone: job.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date())
  return `Это фоновый запуск задачи «${job.name}».\n\nТекущая дата и время в timezone ${job.timezone}: ${current}.\nИсходная инструкция пользователя:\n${job.instructionText}\n\nОцени условия и выполни задачу, только если они соблюдены.`
}

function toOutcome(result: Pick<AgentRunResult, 'output' | 'mcpToolCalls'>) {
  let raw: unknown
  try { raw = JSON.parse(result.output) } catch { raw = undefined }
  const parsed = scheduledDecision.safeParse(raw)
  if (!parsed.success) {
    return {
      status: 'error' as const,
      reason: 'Агент вернул результат не по контракту scheduled task.',
      error: parsed.error.issues.map((issue) => issue.message).join('; '),
      toolCalls: result.mcpToolCalls ?? [],
    }
  }
  const successfulTools = result.mcpToolCalls?.filter((call) => !call.isError) ?? []
  const failedTools = result.mcpToolCalls?.filter((call) => call.isError) ?? []
  if (parsed.data.status === 'success' && !successfulTools.length) {
    return {
      status: 'error' as const,
      reason: 'Сводка не подтверждена успешным MCP-вызовом.',
      error: 'Агент вернул success без tool receipt.',
      toolCalls: result.mcpToolCalls ?? [],
    }
  }
  if (failedTools.length && !successfulTools.length) {
    return {
      status: 'error' as const,
      reason: 'Все MCP-вызовы фоновой задачи завершились ошибкой.',
      error: failedTools.map((call) => call.name).join(', '),
      toolCalls: result.mcpToolCalls ?? [],
    }
  }
  return {
    status: parsed.data.status,
    reason: parsed.data.reason,
    ...(parsed.data.summary ? { summary: parsed.data.summary } : {}),
    toolCalls: result.mcpToolCalls ?? [],
  }
}

export function createScheduledTaskExecutor(service: AgentService): ScheduledTaskExecutor {
  return async (job) => {
    const result = await service.run(job.agentId, scheduledInput(job), [], undefined, `scheduled:${job.id}`)
    return toOutcome(result)
  }
}
