import { Client } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import type { SupportSelection, SupportSnapshot } from '../src/support-types'
import { catalogSchema, contextSchema, selectionSchema } from './support-crm'
import { SupportError } from './support-errors'
import { appendMessageSchema, changeTicketStatusSchema, claimJobSchema, completeJobSchema, createTicketSchema, failJobSchema, jobClaimSchema, jobLeaseSchema, retryTicketSchema, ticketLifecycleSchema, ticketMutationSchema, ticketReadSchema, ticketRecordSchema } from './support-ticket-schema'

export type SupportCrmLocation = string | { crmPath: string; ticketsPath: string }

/** The app chooses a fixed tool and IDs; neither the prompt nor the model can select another file/tool. */
async function callCrm<T>(location: SupportCrmLocation, name: string, args: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const path = typeof location === 'string' ? location : location.crmPath
  const ticketsPath = typeof location === 'string' ? resolve(dirname(location), 'support-tickets.sqlite') : location.ticketsPath
  const client = new Client({ name: 'support-assistant', version: '1.0.0' })
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', 'tsx', fileURLToPath(new URL('./support-mcp-server.ts', import.meta.url))],
    env: { ...getDefaultEnvironment(), SUPPORT_TICKETS_SOURCE_PATH: path, SUPPORT_CRM_PATH: path, SUPPORT_TICKETS_DB_PATH: ticketsPath },
  })
  try {
    signal?.throwIfAborted()
    await client.connect(transport, { timeout: 10000, signal })
    const response = await client.callTool({ name, arguments: args }, { timeout: 10000, signal })
    const envelope = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: schema }),
      z.object({ ok: z.literal(false), status: z.union([z.literal(400), z.literal(403), z.literal(404), z.literal(409), z.literal(413), z.literal(503)]), error: z.string() }),
    ]).parse(response.structuredContent)
    if (!envelope.ok) throw new SupportError(envelope.error, envelope.status)
    if (response.isError) throw new Error('MCP rejected result')
    return envelope.data
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof SupportError) throw error
    throw new SupportError('MCP-контекст поддержки недоступен. Повторите запрос после проверки JSON и MCP.', 503)
  } finally {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
  }
}
export const readSupportCatalog = (path: SupportCrmLocation, signal?: AbortSignal, includeDeleted = false) => callCrm(path, 'list_support_records', { includeDeleted }, catalogSchema, signal)
export async function readSupportContext(path: SupportCrmLocation, selection: SupportSelection, signal?: AbortSignal): Promise<SupportSnapshot> {
  const result = await callCrm(path, 'get_support_context', selectionSchema.parse(selection), contextSchema, signal)
  if (result.mode !== 'tickets' && result.customer?.id !== selection.userId || (result.ticket?.id || undefined) !== selection.ticketId || selection.userId && result.ticket && result.ticket.userId !== selection.userId) {
    throw new SupportError('MCP вернул контекст другого пользователя или тикета.', 503)
  }
  return { capturedAt: new Date().toISOString(), receipt: { name: 'get_support_context', result } }
}

export function supportTicketClient(location: SupportCrmLocation) {
  return {
    get: (input: z.input<typeof ticketReadSchema>, signal?: AbortSignal) => callCrm(location, 'get_support_ticket', ticketReadSchema.parse(input), ticketRecordSchema, signal),
    remove: (input: z.input<typeof ticketLifecycleSchema>, signal?: AbortSignal) => callCrm(location, 'delete_support_ticket', ticketLifecycleSchema.parse(input), ticketRecordSchema, signal),
    restore: (input: z.input<typeof ticketLifecycleSchema>, signal?: AbortSignal) => callCrm(location, 'restore_support_ticket', ticketLifecycleSchema.parse(input), ticketRecordSchema, signal),
    create: (input: z.input<typeof createTicketSchema>, signal?: AbortSignal) => callCrm(location, 'create_support_ticket', createTicketSchema.parse(input), ticketMutationSchema, signal),
    append: (input: z.input<typeof appendMessageSchema>, signal?: AbortSignal) => callCrm(location, 'append_support_message', appendMessageSchema.parse(input), ticketMutationSchema, signal),
    retry: (input: z.input<typeof retryTicketSchema>, signal?: AbortSignal) => callCrm(location, 'retry_support_ticket', retryTicketSchema.parse(input), ticketMutationSchema, signal),
    status: (input: z.input<typeof changeTicketStatusSchema>, signal?: AbortSignal) => callCrm(location, 'set_support_ticket_status', changeTicketStatusSchema.parse(input), ticketRecordSchema, signal),
    claim: (input: z.input<typeof claimJobSchema>, signal?: AbortSignal) => callCrm(location, 'claim_support_job', claimJobSchema.parse(input), jobClaimSchema, signal),
    renew: (input: z.input<typeof jobLeaseSchema>, signal?: AbortSignal) => callCrm(location, 'renew_support_job', jobLeaseSchema.parse(input), z.object({ renewed: z.boolean() }), signal),
    complete: (input: z.input<typeof completeJobSchema>, signal?: AbortSignal) => callCrm(location, 'complete_support_job', completeJobSchema.parse(input), ticketRecordSchema, signal),
    fail: (input: z.input<typeof failJobSchema>, signal?: AbortSignal) => callCrm(location, 'fail_support_job', failJobSchema.parse(input), ticketRecordSchema, signal),
  }
}
