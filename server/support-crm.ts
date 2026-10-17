import { readFileSync, statSync } from 'node:fs'
import { z } from 'zod'
import type { SupportCatalog, SupportContext } from '../src/support-types'
import { SupportError } from './support-errors'

export const supportId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
export const supportLocalAuthor = 'support-local'
export const ticketDetailsSchema = z.object({
  device: z.string().trim().min(1).max(120).optional(), osVersion: z.string().trim().min(1).max(80).optional(),
  appVersion: z.string().trim().min(1).max(80).optional(), triedSteps: z.string().trim().min(1).max(600).optional(),
}).strict()
export const selectionSchema = z.object({ userId: supportId.optional(), ticketId: supportId.optional() }).strict()
const customerSchema = z.object({
  id: supportId, plan: z.enum(['free', 'team', 'business']).optional(), role: z.enum(['owner', 'admin', 'member', 'viewer']).optional(),
  authMethod: z.enum(['password', 'sso', 'sms', 'vk_id']), ssoRequired: z.boolean().optional(), accountState: z.enum(['active', 'locked', 'disabled', 'unknown']),
  myFamily: z.object({
    platform: z.literal('ios'), build: z.string().min(1).max(80).optional(),
    authStage: z.enum(['phone_entry', 'sms_requested', 'vk_authorizing', 'signed_in', 'unknown']),
    sessionState: z.enum(['absent', 'valid', 'expired', 'unknown']), profileState: z.enum(['complete', 'incomplete', 'unknown']),
    family: z.object({ membership: z.enum(['member', 'none', 'unknown']), id: supportId.optional(), role: z.enum(['owner', 'regular', 'unknown']) }).optional(),
    pro: z.object({ state: z.enum(['active', 'inactive', 'unknown']), purchaseState: z.enum(['none', 'verified', 'pending', 'cancelled', 'unverified', 'unknown']) }).optional(),
    permissions: z.object({
      location: z.enum(['not_determined', 'denied', 'restricted', 'when_in_use', 'always', 'unknown']),
      microphone: z.enum(['not_determined', 'denied', 'granted', 'unknown']),
      camera: z.enum(['not_determined', 'denied', 'restricted', 'granted', 'unknown']),
      photos: z.enum(['not_determined', 'denied', 'restricted', 'limited', 'granted', 'unknown']),
    }).optional(),
    contentCheck: z.enum(['text_toxic', 'image_unsafe', 'check_failed', 'none', 'unknown']).optional(),
    lastAuthError: z.object({ code: z.string().regex(/^[A-Z0-9_]{1,64}$/), retryAfterSeconds: z.number().int().min(0).max(86400).optional() }).optional(),
  }).optional(),
})
const ticketSchema = z.object({
  details: ticketDetailsSchema.optional(),
  id: supportId, userId: supportId, title: z.string().min(1).max(160),
  status: z.enum(['open', 'in_progress', 'pending', 'escalated', 'resolved']), category: z.enum(['auth', 'profile', 'features', 'billing', 'integrations', 'general']),
  description: z.string().max(1200), errorCode: z.string().regex(/^[A-Z0-9_]{1,64}$/).optional(),
  messages: z.array(z.object({ author: z.enum(['user', 'agent']), body: z.string().max(600) })).max(100),
})
const crmSchema = z.object({
  product: z.string().min(1).max(80), demo: z.boolean(), knowledgeRevision: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  users: z.array(customerSchema.extend({ displayName: z.string().min(1).max(80) })).min(1).max(1000),
  tickets: z.array(ticketSchema).max(5000),
})
const ticketsSourceSchema = crmSchema.omit({ users: true }).extend({ mode: z.literal('tickets'),
  tickets: z.array(ticketSchema.extend({ userId: supportId.default(supportLocalAuthor) })).max(5000),
})
export const catalogSchema = z.object({ product: z.string(), demo: z.boolean(), mode: z.enum(['tickets', 'crm']).optional(),
  users: z.array(z.object({ id: supportId, displayName: z.string(), plan: customerSchema.shape.plan })),
  tickets: z.array(ticketSchema.pick({ id: true, userId: true, title: true, status: true }).extend({ createdAt: z.string().optional(), updatedAt: z.string().optional(), deletedAt: z.string().optional() })),
})
export const contextSchema = z.object({ product: z.string().max(80).optional(), demo: z.boolean().optional(), knowledgeRevision: crmSchema.shape.knowledgeRevision, mode: z.enum(['tickets', 'crm']).optional(), customer: customerSchema.optional(), ticket: ticketSchema.extend({
  messages: z.array(z.object({ author: z.enum(['user', 'agent']), body: z.string().max(40000) })).max(6),
}).nullable(), messagesOmitted: z.number().int().nonnegative() })

/** Parse an allowlist on each call. Unknown structured fields are dropped; free text remains operator-controlled. */
export class JsonSupportCrm {
  constructor(readonly path: string) {}
  private read() {
    try {
      if (statSync(this.path).size > 2 * 1024 * 1024) throw new Error('Oversized CRM')
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      const parsed = raw.mode === 'tickets' ? ticketsSourceSchema.parse(raw) : crmSchema.parse(raw)
      const data = { ...parsed, mode: raw.mode === 'tickets' ? 'tickets' as const : 'crm' as const, users: 'users' in parsed ? parsed.users : [] }
      const users = new Set(data.users.map(({ id }) => id)), tickets = new Set(data.tickets.map(({ id }) => id))
      if (users.size !== data.users.length || tickets.size !== data.tickets.length || data.mode !== 'tickets' && data.tickets.some(({ userId }) => !users.has(userId))) throw new Error('Invalid references')
      return data
    } catch { throw new SupportError('JSON-CRM недоступна или не соответствует схеме. Проверьте SUPPORT_TICKETS_SOURCE_PATH или SUPPORT_CRM_PATH.', 503) }
  }
  catalog(): SupportCatalog {
    const data = this.read()
    return { product: data.product, demo: data.demo, mode: data.mode,
      users: data.users.map(({ id, displayName, plan }) => ({ id, displayName, plan })),
      tickets: data.tickets.map(({ id, userId, title, status }) => ({ id, userId, title, status })),
    }
  }
  records() { return this.read() }
  get ticketOnly() { return this.read().mode === 'tickets' }
  context(selection: z.infer<typeof selectionSchema>): SupportContext {
    const { userId, ticketId } = selectionSchema.parse(selection)
    const data = this.read()
    if (data.mode === 'tickets') {
      const ticket = ticketId ? data.tickets.find(({ id }) => id === ticketId) : undefined
      if (ticketId && !ticket) throw new SupportError('Тикет не найден.', 404)
      return { product: data.product, demo: data.demo, mode: 'tickets', knowledgeRevision: data.knowledgeRevision,
        ticket: ticket ? { ...ticket, messages: ticket.messages.slice(-6) } : null, messagesOmitted: Math.max(0, (ticket?.messages.length || 0) - 6) }
    }
    const user = data.users.find(({ id }) => id === userId)
    if (!user) throw new SupportError('Пользователь не найден.', 404)
    const ticket = ticketId ? data.tickets.find(({ id }) => id === ticketId) : undefined
    if (ticketId && !ticket) throw new SupportError('Тикет не найден.', 404)
    if (ticket && ticket.userId !== userId) throw new SupportError('Тикет не принадлежит выбранному пользователю.', 403)
    return { product: data.product, demo: data.demo, ...(data.knowledgeRevision ? { knowledgeRevision: data.knowledgeRevision } : {}), customer: customerSchema.parse(user),
      ticket: ticket ? { ...ticket, messages: ticket.messages.slice(-6) } : null,
      messagesOmitted: Math.max(0, (ticket?.messages.length || 0) - 6),
    }
  }
}
