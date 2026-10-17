import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { z } from 'zod'
import type { SupportCatalog, SupportContext, SupportJobClaim, SupportTicketRecord } from '../src/support-types'
import { JsonSupportCrm, supportLocalAuthor } from './support-crm'
import { SupportError } from './support-errors'
import { appendMessageSchema, changeTicketStatusSchema, completeJobSchema, createTicketSchema, failJobSchema, jobLeaseSchema, retryTicketSchema, ticketLifecycleSchema } from './support-ticket-schema'

type TicketRow = { id: string; user_id: string; title: string; description: string; category: SupportTicketRecord['category']; status: SupportTicketRecord['status']; error_code: string | null; created_at: string; updated_at: string; revision: number; deleted_at: string | null; details_json: string | null }
type JobRow = { id: string; ticket_id: string; user_id: string; input: string; provider: 'local' | 'cloud'; user_message_id: string; state: 'queued' | 'running' | 'completed' | 'failed'; lease_token: string | null; lease_until: number | null; error: string | null; updated_at: string }
const id = (prefix: string) => `${prefix}-${randomUUID()}`
const leaseMs = 90000

/** Durable ticket aggregate and job queue. Every mutation is a short SQLite transaction. */
export class SupportTicketStore {
  private readonly db: DatabaseSync
  private readonly scope: string
  constructor(private readonly crm: JsonSupportCrm, path: string) {
    this.scope = createHash('sha256').update(realpathSync(crm.path)).digest('hex')
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS support_crm_sources (scope TEXT PRIMARY KEY, seeded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS support_tickets (
        scope TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
        category TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, details_json TEXT, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS support_messages (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, id TEXT NOT NULL, ticket_id TEXT NOT NULL,
        author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, reply_to TEXT, reply_json TEXT,
        UNIQUE(scope,id), FOREIGN KEY(scope,ticket_id) REFERENCES support_tickets(scope,id));
      CREATE TABLE IF NOT EXISTS support_jobs (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, id TEXT NOT NULL, ticket_id TEXT NOT NULL,
        user_id TEXT NOT NULL, user_message_id TEXT NOT NULL, input TEXT NOT NULL, provider TEXT NOT NULL,
        state TEXT NOT NULL, worker_id TEXT, lease_token TEXT, lease_until INTEGER, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(scope,id),
        FOREIGN KEY(scope,ticket_id) REFERENCES support_tickets(scope,id));
      CREATE UNIQUE INDEX IF NOT EXISTS support_active_job ON support_jobs(scope,ticket_id) WHERE state IN ('queued','running');
      CREATE TABLE IF NOT EXISTS support_requests (
        scope TEXT NOT NULL, user_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
        ticket_id TEXT NOT NULL, PRIMARY KEY(scope,user_id,request_id));
      CREATE INDEX IF NOT EXISTS support_message_order ON support_messages(scope,ticket_id,ordinal);
    `)
    // MCP processes may start concurrently against an existing database.
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(support_tickets)').all() as Array<{ name: string }>
      if (!columns.some(({ name }) => name === 'details_json')) this.db.exec('ALTER TABLE support_tickets ADD COLUMN details_json TEXT')
      if (!columns.some(({ name }) => name === 'deleted_at')) this.db.exec('ALTER TABLE support_tickets ADD COLUMN deleted_at TEXT')
    })
    this.seed()
  }
  close() { this.db.close() }
  private transaction<T>(operation: () => T) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private seed() {
    if (this.db.prepare('SELECT 1 FROM support_crm_sources WHERE scope=?').get(this.scope)) return
    const source = this.crm.records(), now = new Date().toISOString()
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM support_crm_sources WHERE scope=?').get(this.scope)) return
      for (const ticket of source.tickets) {
        this.db.prepare('INSERT INTO support_tickets(scope,id,user_id,title,description,category,status,error_code,created_at,updated_at,details_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(this.scope, ticket.id, ticket.userId, ticket.title, ticket.description, ticket.category, ticket.status === 'in_progress' ? 'open' : ticket.status, ticket.errorCode || null, now, now, ticket.details ? JSON.stringify(ticket.details) : null)
        for (const message of ticket.messages) this.addMessage(ticket.id, message.author, message.body, now)
      }
      this.db.prepare('INSERT INTO support_crm_sources VALUES(?,?)').run(this.scope, now)
    })
  }
  private user(userId: string) { return this.crm.context({ userId }).customer }
  private author(userId?: string) {
    if (this.crm.ticketOnly) {
      if (userId && userId !== supportLocalAuthor) throw new SupportError('В режиме тикетов автор назначается приложением.', 400)
      return supportLocalAuthor
    }
    if (!userId) throw new SupportError('Для старого CRM-источника требуется userId.', 400)
    this.user(userId); return userId
  }
  private row(userId: string | undefined, ticketId: string, includeDeleted = false): TicketRow {
    if (!this.crm.ticketOnly) { if (!userId) throw new SupportError('Для старого CRM-источника требуется userId.', 400); this.user(userId) }
    const ticket = this.db.prepare('SELECT * FROM support_tickets WHERE scope=? AND id=?').get(this.scope, ticketId) as TicketRow | undefined
    if (!ticket) throw new SupportError('Тикет не найден.', 404)
    if (userId !== undefined && ticket.user_id !== userId) throw new SupportError('Тикет не принадлежит выбранному пользователю.', 403)
    if (ticket.deleted_at && !includeDeleted) throw new SupportError('Тикет удалён. Его можно восстановить в разделе «Удалённые».', 404)
    return ticket
  }
  catalog(includeDeleted = false): SupportCatalog {
    const catalog = this.crm.catalog()
    const users = new Set(catalog.users.map(({ id }) => id))
    const rows = this.db.prepare('SELECT * FROM support_tickets WHERE scope=? ORDER BY updated_at DESC,rowid DESC').all(this.scope) as TicketRow[]
    return { ...catalog, tickets: rows.filter((row) => (catalog.mode === 'tickets' || users.has(row.user_id)) && (includeDeleted || !row.deleted_at)).map((row) => ({ id: row.id, userId: row.user_id, title: row.title, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}) })) }
  }
  ticket(userId: string | undefined, ticketId: string, includeDeleted = false): SupportTicketRecord {
    const row = this.row(userId, ticketId, includeDeleted)
    const messages = this.db.prepare('SELECT * FROM support_messages WHERE scope=? AND ticket_id=? ORDER BY ordinal').all(this.scope, ticketId) as Array<{ id: string; author: 'user' | 'agent'; body: string; created_at: string; reply_to: string | null; reply_json: string | null }>
    const job = this.db.prepare('SELECT * FROM support_jobs WHERE scope=? AND ticket_id=? ORDER BY ordinal DESC LIMIT 1').get(this.scope, ticketId) as JobRow | undefined
    return { ...(row.details_json ? { details: JSON.parse(row.details_json) } : {}), id: row.id, userId: row.user_id, title: row.title, description: row.description, category: row.category, status: row.status,
      ...(row.error_code ? { errorCode: row.error_code } : {}), createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision, ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
      messages: messages.map((message) => ({ id: message.id, author: message.author, body: message.body, createdAt: message.created_at,
        ...(message.reply_to ? { replyTo: message.reply_to } : {}), ...(message.reply_json ? { reply: JSON.parse(message.reply_json) } : {}) })),
      job: job ? { id: job.id, state: job.state, provider: job.provider, userMessageId: job.user_message_id, updatedAt: job.updated_at, ...(job.error ? { error: job.error } : {}) } : null,
    }
  }
  context(userId: string | undefined, ticketId?: string): SupportContext {
    const account = this.crm.context({ userId })
    if (!ticketId) return account
    const ticket = this.ticket(userId, ticketId)
    return { ...account, ticket: { ...(ticket.details ? { details: ticket.details } : {}), id: ticket.id, userId: ticket.userId, title: ticket.title, description: ticket.description, category: ticket.category, status: ticket.status,
      ...(ticket.errorCode ? { errorCode: ticket.errorCode } : {}), messages: ticket.messages.slice(-6).map(({ author, body }) => ({ author, body })) }, messagesOmitted: Math.max(0, ticket.messages.length - 6) }
  }
  private addMessage(ticketId: string, author: 'user' | 'agent', body: string, now: string, replyTo?: string, reply?: unknown) {
    const messageId = id('msg')
    this.db.prepare('INSERT INTO support_messages(scope,id,ticket_id,author,body,created_at,reply_to,reply_json) VALUES(?,?,?,?,?,?,?,?)')
      .run(this.scope, messageId, ticketId, author, body, now, replyTo || null, reply ? JSON.stringify(reply) : null)
    return messageId
  }
  private touch(ticketId: string, status: SupportTicketRecord['status'], now: string) {
    this.db.prepare('UPDATE support_tickets SET status=?,updated_at=?,revision=revision+1 WHERE scope=? AND id=?').run(status, now, this.scope, ticketId)
  }
  private previous(userId: string, requestId: string, payload: unknown) {
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    const existing = this.db.prepare('SELECT * FROM support_requests WHERE scope=? AND user_id=? AND request_id=?').get(this.scope, userId, requestId) as { payload_hash: string; ticket_id: string } | undefined
    if (existing && existing.payload_hash !== hash) throw new SupportError('Этот requestId уже использован для другого запроса.', 409)
    return { hash, ticketId: existing?.ticket_id }
  }
  private remember(userId: string, requestId: string, hash: string, ticketId: string) {
    this.db.prepare('INSERT INTO support_requests VALUES(?,?,?,?,?)').run(this.scope, userId, requestId, hash, ticketId)
  }
  private enqueue(ticketId: string, userId: string, input: string, provider: 'local' | 'cloud', userMessageId: string, now: string) {
    this.db.prepare('INSERT INTO support_jobs(scope,id,ticket_id,user_id,user_message_id,input,provider,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(this.scope, id('job'), ticketId, userId, userMessageId, input, provider, 'queued', now, now)
    this.touch(ticketId, 'open', now)
  }
  private idle(ticketId: string) {
    if (this.db.prepare("SELECT 1 FROM support_jobs WHERE scope=? AND ticket_id=? AND state IN ('queued','running')").get(this.scope, ticketId)) throw new SupportError('Ассистент уже отвечает в этом тикете. Дождитесь ответа.', 409)
  }
  create(input: z.input<typeof createTicketSchema>) {
    const parsed = createTicketSchema.parse(input), data = { ...parsed, userId: this.author(parsed.userId) }
    return this.transaction(() => {
      const previous = this.previous(data.userId, data.requestId, { operation: 'create', ...data })
      if (previous.ticketId) return { ticket: this.ticket(data.userId, previous.ticketId), created: false }
      const ticketId = id('TCK'), now = new Date().toISOString()
      this.db.prepare('INSERT INTO support_tickets(scope,id,user_id,title,description,category,status,error_code,created_at,updated_at,details_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(this.scope, ticketId, data.userId, data.title, data.description, data.category, 'open', data.errorCode || null, now, now, data.details ? JSON.stringify(data.details) : null)
      const messageId = this.addMessage(ticketId, 'user', data.description, now)
      this.enqueue(ticketId, data.userId, data.description, data.provider, messageId, now)
      this.remember(data.userId, data.requestId, previous.hash, ticketId)
      return { ticket: this.ticket(data.userId, ticketId), created: true }
    })
  }
  append(input: z.input<typeof appendMessageSchema>) {
    const parsed = appendMessageSchema.parse(input), data = { ...parsed, userId: this.row(parsed.userId, parsed.ticketId).user_id }
    return this.transaction(() => {
      this.row(data.userId, data.ticketId)
      const previous = this.previous(data.userId, data.requestId, { operation: 'message', ...data })
      if (previous.ticketId) return { ticket: this.ticket(data.userId, data.ticketId), created: false }
      this.idle(data.ticketId)
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE scope=? AND ticket_id=?').get(this.scope, data.ticketId) as { n: number }
      if (count.n >= 999) throw new SupportError('В тикете достигнут лимит 1000 сообщений. Создайте новое обращение.', 409)
      const now = new Date().toISOString(), messageId = this.addMessage(data.ticketId, 'user', data.input, now)
      this.enqueue(data.ticketId, data.userId, data.input, data.provider, messageId, now)
      this.remember(data.userId, data.requestId, previous.hash, data.ticketId)
      return { ticket: this.ticket(data.userId, data.ticketId), created: true }
    })
  }
  retry(input: z.input<typeof retryTicketSchema>) {
    const parsed = retryTicketSchema.parse(input), data = { ...parsed, userId: this.row(parsed.userId, parsed.ticketId).user_id }
    return this.transaction(() => {
      this.row(data.userId, data.ticketId)
      const previous = this.previous(data.userId, data.requestId, { operation: 'retry', ...data })
      if (previous.ticketId) return { ticket: this.ticket(data.userId, data.ticketId), created: false }
      this.idle(data.ticketId)
      const ticket = this.ticket(data.userId, data.ticketId)
      if (ticket.job?.state !== 'failed') throw new SupportError('Повтор доступен после технической ошибки ассистента.', 409)
      const message = ticket.messages.find(({ id }) => id === ticket.job!.userMessageId)!
      this.enqueue(data.ticketId, data.userId, message.body, data.provider, message.id, new Date().toISOString())
      this.remember(data.userId, data.requestId, previous.hash, data.ticketId)
      return { ticket: this.ticket(data.userId, data.ticketId), created: true }
    })
  }
  changeStatus(input: z.input<typeof changeTicketStatusSchema>) {
    const parsed = changeTicketStatusSchema.parse(input), data = { ...parsed, userId: this.row(parsed.userId, parsed.ticketId).user_id }
    return this.transaction(() => {
      const ticket = this.row(data.userId, data.ticketId); this.idle(data.ticketId)
      if (ticket.revision !== data.revision) throw new SupportError('Тикет изменился. Обновите его перед сменой статуса.', 409)
      this.touch(data.ticketId, data.status, new Date().toISOString())
      return this.ticket(data.userId, data.ticketId)
    })
  }
  remove(input: z.input<typeof ticketLifecycleSchema>) {
    const parsed = ticketLifecycleSchema.parse(input), data = { ...parsed, userId: this.row(parsed.userId, parsed.ticketId, true).user_id }
    return this.transaction(() => {
      const ticket = this.row(data.userId, data.ticketId, true)
      if (ticket.deleted_at) return this.ticket(data.userId, data.ticketId, true)
      if (ticket.revision !== data.revision) throw new SupportError('Тикет изменился. Обновите его перед удалением.', 409)
      const now = new Date().toISOString()
      const cancelled = this.db.prepare("UPDATE support_jobs SET state='failed',error=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE scope=? AND ticket_id=? AND state IN ('queued','running')")
        .run('Обработка остановлена: тикет был удалён. После восстановления можно повторить ответ.', now, this.scope, data.ticketId)
      this.db.prepare('UPDATE support_tickets SET deleted_at=?,updated_at=?,status=?,revision=revision+1 WHERE scope=? AND id=?')
        .run(now, now, cancelled.changes ? 'escalated' : ticket.status, this.scope, data.ticketId)
      return this.ticket(data.userId, data.ticketId, true)
    })
  }
  restore(input: z.input<typeof ticketLifecycleSchema>) {
    const parsed = ticketLifecycleSchema.parse(input), data = { ...parsed, userId: this.row(parsed.userId, parsed.ticketId, true).user_id }
    return this.transaction(() => {
      const ticket = this.row(data.userId, data.ticketId, true)
      if (!ticket.deleted_at) return this.ticket(data.userId, data.ticketId)
      if (ticket.revision !== data.revision) throw new SupportError('Тикет изменился. Обновите его перед восстановлением.', 409)
      this.db.prepare('UPDATE support_tickets SET deleted_at=NULL,updated_at=?,revision=revision+1 WHERE scope=? AND id=?')
        .run(new Date().toISOString(), this.scope, data.ticketId)
      return this.ticket(data.userId, data.ticketId)
    })
  }
  claim(workerId: string): SupportJobClaim | null {
    return this.transaction(() => {
      const now = Date.now()
      const job = this.db.prepare("SELECT * FROM support_jobs WHERE scope=? AND (state='queued' OR state='running' AND lease_until<?) ORDER BY ordinal LIMIT 1").get(this.scope, now) as JobRow | undefined
      if (!job) return null
      const token = randomUUID()
      this.db.prepare("UPDATE support_jobs SET state='running',worker_id=?,lease_token=?,lease_until=?,updated_at=? WHERE scope=? AND id=?")
        .run(workerId, token, now + leaseMs, new Date(now).toISOString(), this.scope, job.id)
      this.touch(job.ticket_id, 'in_progress', new Date(now).toISOString())
      return { id: job.id, userId: job.user_id, ticketId: job.ticket_id, input: job.input, provider: job.provider, userMessageId: job.user_message_id, leaseToken: token }
    })
  }
  private leased(jobId: string, token: string) {
    const job = this.db.prepare("SELECT * FROM support_jobs WHERE scope=? AND id=? AND state='running' AND lease_token=? AND lease_until>=?").get(this.scope, jobId, token, Date.now()) as JobRow | undefined
    if (!job) throw new SupportError('Задание уже передано другому обработчику.', 409)
    return job
  }
  renew(input: z.input<typeof jobLeaseSchema>) {
    const data = jobLeaseSchema.parse(input)
    return this.transaction(() => { this.leased(data.jobId, data.leaseToken); this.db.prepare('UPDATE support_jobs SET lease_until=? WHERE scope=? AND id=?').run(Date.now() + leaseMs, this.scope, data.jobId); return { renewed: true } })
  }
  complete(input: z.input<typeof completeJobSchema>) {
    const data = completeJobSchema.parse(input)
    return this.transaction(() => {
      const job = this.leased(data.jobId, data.leaseToken), now = new Date().toISOString()
      if (job.provider !== data.reply.provider) throw new SupportError('Провайдер ответа не совпадает с заданием.', 409)
      this.addMessage(job.ticket_id, 'agent', data.body, now, job.user_message_id, data.reply)
      this.db.prepare("UPDATE support_jobs SET state='completed',lease_token=NULL,lease_until=NULL,updated_at=? WHERE scope=? AND id=?").run(now, this.scope, job.id)
      this.touch(job.ticket_id, data.reply.outcome === 'answered' ? 'pending' : 'escalated', now)
      return this.ticket(job.user_id, job.ticket_id)
    })
  }
  fail(input: z.input<typeof failJobSchema>) {
    const data = failJobSchema.parse(input)
    return this.transaction(() => {
      const job = this.leased(data.jobId, data.leaseToken), now = new Date().toISOString()
      this.db.prepare("UPDATE support_jobs SET state='failed',error=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE scope=? AND id=?").run(data.error, now, this.scope, job.id)
      this.touch(job.ticket_id, 'escalated', now)
      return this.ticket(job.user_id, job.ticket_id)
    })
  }
}
