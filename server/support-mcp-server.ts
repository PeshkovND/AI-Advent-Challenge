import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { dirname, resolve } from 'node:path'
import { JsonSupportCrm, selectionSchema } from './support-crm'
import { SupportError } from './support-errors'
import { SupportTicketStore } from './support-ticket-store'
import { appendMessageSchema, changeTicketStatusSchema, claimJobSchema, completeJobSchema, createTicketSchema, failJobSchema, jobLeaseSchema, retryTicketSchema, ticketLifecycleSchema, ticketReadSchema } from './support-ticket-schema'

const crm = new JsonSupportCrm(process.env.SUPPORT_TICKETS_SOURCE_PATH || process.env.SUPPORT_CRM_PATH || '')
const databasePath = process.env.SUPPORT_TICKETS_DB_PATH || resolve(dirname(crm.path), 'support-tickets.sqlite')
serveStdio(() => {
  const server = new McpServer({ name: 'support-json-crm', version: '1.0.0' })
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  const writes = { ...annotations, readOnlyHint: false }
  const result = (operation: (store: SupportTicketStore) => unknown) => {
    let output: Record<string, unknown>
    let store: SupportTicketStore | undefined
    try { store = new SupportTicketStore(crm, databasePath); output = { ok: true, data: operation(store) } }
    catch (error) { output = { ok: false, status: error instanceof SupportError ? error.status : 503,
      error: error instanceof SupportError ? error.message : 'Не удалось выполнить операцию с тикетом.' } }
    finally { store?.close() }
    return { ...(output.ok ? {} : { isError: true }), content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output }
  }
  server.registerTool('list_support_records', { description: 'Каталог тикетов; пользователи возвращаются только для старого CRM-источника. Удалённые включаются только по includeDeleted.', inputSchema: z.object({ includeDeleted: z.boolean().optional() }).strict(), annotations }, (data) => result((store) => store.catalog(data.includeDeleted)))
  server.registerTool('get_support_context', { description: 'Описание, сведения автора и последние шесть сообщений выбранного тикета. Профиль только в старом режиме CRM.', inputSchema: selectionSchema, annotations }, (selection) => result((store) => store.context(selection.userId, selection.ticketId)))
  server.registerTool('get_support_ticket', { description: 'Тикет и переписка. Для просмотра удалённого нужен includeDeleted; в старом режиме CRM требуется владелец.', inputSchema: ticketReadSchema, annotations }, (data) => result((store) => store.ticket(data.userId, data.ticketId, data.includeDeleted)))
  server.registerTool('delete_support_ticket', { description: 'Переместить тикет в удалённые и отменить его задания. Проверяет revision; в старом режиме CRM также владельца. Переписка сохраняется для восстановления.', inputSchema: ticketLifecycleSchema, annotations: writes }, (data) => result((store) => store.remove(data)))
  server.registerTool('restore_support_ticket', { description: 'Восстановить удалённый тикет с перепиской. Остановленный ответ повторяется только по отдельному действию пользователя.', inputSchema: ticketLifecycleSchema, annotations: writes }, (data) => result((store) => store.restore(data)))
  server.registerTool('create_support_ticket', { description: 'Создать тикет и поставить описание проблемы в очередь ассистента. requestId предотвращает дубли.', inputSchema: createTicketSchema, annotations: writes }, (data) => result((store) => store.create(data)))
  server.registerTool('append_support_message', { description: 'Добавить уточнение пользователя и поставить ответ ассистента в очередь. Решённый тикет открывается снова.', inputSchema: appendMessageSchema, annotations: writes }, (data) => result((store) => store.append(data)))
  server.registerTool('retry_support_ticket', { description: 'Повторить задание после технической ошибки без дублирования сообщения пользователя.', inputSchema: retryTicketSchema, annotations: writes }, (data) => result((store) => store.retry(data)))
  server.registerTool('set_support_ticket_status', { description: 'Изменить статус тикета с проверкой текущей revision и отсутствия активного ответа.', inputSchema: changeTicketStatusSchema, annotations: writes }, (data) => result((store) => store.changeStatus(data)))
  server.registerTool('claim_support_job', { description: 'Получить одно задание из устойчивой очереди для обработчика приложения.', inputSchema: claimJobSchema, annotations: { ...writes, idempotentHint: false } }, (data) => result((store) => store.claim(data.workerId)))
  server.registerTool('renew_support_job', { description: 'Продлить право обработчика на текущее задание.', inputSchema: jobLeaseSchema, annotations: writes }, (data) => result((store) => store.renew(data)))
  server.registerTool('complete_support_job', { description: 'Атомарно записать проверенный ответ ассистента и обновить статус тикета.', inputSchema: completeJobSchema, annotations: { ...writes, idempotentHint: false } }, (data) => result((store) => store.complete(data)))
  server.registerTool('fail_support_job', { description: 'Сохранить техническую ошибку задания; переписка пользователя остаётся доступной.', inputSchema: failJobSchema, annotations: writes }, (data) => result((store) => store.fail(data)))
  return server
}, { onerror: () => console.error('Support MCP: transport error') })
