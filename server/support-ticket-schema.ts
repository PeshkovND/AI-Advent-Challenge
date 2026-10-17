import { z } from 'zod'
import { supportId, ticketDetailsSchema } from './support-crm'

export const ticketStatusSchema = z.enum(['open', 'in_progress', 'pending', 'escalated', 'resolved'])
export const ticketSelectionSchema = z.object({ userId: supportId.optional(), ticketId: supportId }).strict()
export const ticketReadSchema = ticketSelectionSchema.extend({ includeDeleted: z.boolean().optional() }).strict()
export const ticketLifecycleSchema = ticketSelectionSchema.extend({ revision: z.number().int().nonnegative() }).strict()
const requestId = z.string().uuid()
export const createTicketSchema = z.object({
  userId: supportId.optional(), details: ticketDetailsSchema.optional(), title: z.string().trim().min(3).max(160), description: z.string().trim().min(10).max(1200),
  category: z.enum(['auth', 'profile', 'features', 'billing', 'integrations', 'general']).default('general'),
  errorCode: z.string().trim().regex(/^[A-Z0-9_]{1,64}$/).optional(),
  provider: z.enum(['local', 'cloud']).default('local'), requestId,
}).strict()
export const appendMessageSchema = ticketSelectionSchema.extend({ input: z.string().trim().min(1).max(4000), provider: z.enum(['local', 'cloud']).default('local'), requestId }).strict()
export const retryTicketSchema = ticketSelectionSchema.extend({ provider: z.enum(['local', 'cloud']).default('local'), requestId }).strict()
export const changeTicketStatusSchema = ticketSelectionSchema.extend({ status: z.enum(['open', 'pending', 'escalated', 'resolved']), revision: z.number().int().nonnegative() }).strict()
const citationSchema = z.object({ id: z.number().int().positive(), source: z.string().max(500), section: z.string().max(500), chunkId: z.string().max(200), quote: z.string().min(1).max(1200), kind: z.literal('dialogue').optional() })
export const messageReplySchema = z.object({
  outcome: z.enum(['answered', 'escalate']), provider: z.enum(['local', 'cloud']), model: z.string().min(1).max(200), durationMs: z.number().nonnegative(),
  citations: z.array(citationSchema).max(64), clarification: z.string().max(2000).optional(), indexRunId: z.string().max(100), capturedAt: z.string().optional(),
}).strict()
const messageSchema = z.object({ id: supportId, author: z.enum(['user', 'agent']), body: z.string().max(40000), createdAt: z.string(), replyTo: supportId.optional(), reply: messageReplySchema.optional() })
const jobSchema = z.object({ id: supportId, state: z.enum(['queued', 'running', 'completed', 'failed']), provider: z.enum(['local', 'cloud']), userMessageId: supportId, error: z.string().optional(), updatedAt: z.string() })
export const ticketRecordSchema = z.object({
  id: supportId, userId: supportId, title: z.string(), description: z.string(), category: z.enum(['auth', 'profile', 'features', 'billing', 'integrations', 'general']),
  details: ticketDetailsSchema.optional(), status: ticketStatusSchema, errorCode: z.string().optional(), createdAt: z.string(), updatedAt: z.string(), deletedAt: z.string().optional(), revision: z.number().int().nonnegative(),
  messages: z.array(messageSchema), job: jobSchema.nullable(),
})
export const ticketMutationSchema = z.object({ ticket: ticketRecordSchema, created: z.boolean() })
export const jobClaimSchema = z.object({ id: supportId, userId: supportId, ticketId: supportId, input: z.string(), provider: z.enum(['local', 'cloud']), userMessageId: supportId, leaseToken: z.string() }).nullable()
export const claimJobSchema = z.object({ workerId: supportId }).strict()
export const jobLeaseSchema = z.object({ jobId: supportId, leaseToken: z.string().uuid() }).strict()
export const completeJobSchema = jobLeaseSchema.extend({ body: z.string().trim().min(1).max(40000), reply: messageReplySchema }).strict()
export const failJobSchema = jobLeaseSchema.extend({ error: z.string().min(1).max(500) }).strict()
