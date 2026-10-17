import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import express from 'express'
import type { RagSource } from '../src/rag-types'
import type { SupportAnswer, SupportMessageReply } from '../src/support-types'
import { SupportAssistant } from './support-assistant'
import { JsonSupportCrm } from './support-crm'
import { SupportError, SupportGenerationError } from './support-errors'
import { readSupportCatalog, readSupportContext, supportTicketClient } from './support-mcp-client'
import { createSupportRouter } from './support-router'
import { SupportTicketStore } from './support-ticket-store'
import { SupportTickets } from './support-tickets'
import { OllamaEmbeddingClient } from './rag-indexer'

const policy = 'При обязательном SSO вход по паролю отключён. Выберите «Войти через SSO».'
const usage = { inputTokens: 1, promptTokens: 1, completionTokens: 1, totalTokens: 2 }
const citation = { id: 1, source: 'support/knowledge/auth.md', section: 'SSO', chunkId: 'fixture-doc', quote: policy }
const reply: SupportMessageReply = { outcome: 'answered', provider: 'local', model: 'fixture', durationMs: 1, citations: [citation], indexRunId: 'fixture-run' }
class Embeddings extends OllamaEmbeddingClient {
  constructor() { super('http://127.0.0.1:1', 'fixture-embedding') }
  override async embed(texts: string[], signal?: AbortSignal) { signal?.throwIfAborted(); return texts.map(() => [1, 0]) }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'support-tickets-')), crmPath = join(root, 'support/crm.json'), ticketsPath = join(root, 'data/tickets.sqlite')
  mkdirSync(join(root, 'support/knowledge'), { recursive: true })
  writeFileSync(join(root, 'support/knowledge/auth.md'), `# Авторизация\n\n## SSO\n\n${policy}`)
  writeFileSync(crmPath, JSON.stringify({ product: 'Fixture', demo: true, users: [
    { id: 'anna', displayName: 'Анна', plan: 'business', role: 'admin', authMethod: 'sso', ssoRequired: true, accountState: 'active', token: 'do-not-expose' },
    { id: 'oleg', displayName: 'Олег', plan: 'free', role: 'owner', authMethod: 'password', ssoRequired: false, accountState: 'locked' },
  ], tickets: [] }))
  const location = { crmPath, ticketsPath }
  const store = () => new SupportTicketStore(new JsonSupportCrm(crmPath), ticketsPath)
  const create = () => ({ userId: 'anna', title: 'Не работает авторизация', description: 'Получаю SSO_REQUIRED при входе по паролю.', category: 'auth' as const, errorCode: 'SSO_REQUIRED', provider: 'local' as const, requestId: randomUUID() })
  return { root, crmPath, ticketsPath, location, store, create, close: () => rmSync(root, { recursive: true, force: true }) }
}
async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const until = Date.now() + 15000
  while (Date.now() < until) { const value = await read(); if (ready(value)) return value; await delay(100) }
  throw new Error('Timed out waiting for ticket state')
}

test('ticket creation is durable, idempotent and leaves JSON fixtures unchanged', () => {
  const f = fixture(), original = readFileSync(f.crmPath, 'utf8'), input = f.create()
  let store = f.store()
  try {
    const first = store.create(input)
    assert.equal(first.created, true); assert.equal(first.ticket.status, 'open')
    assert.equal(first.ticket.messages.length, 1); assert.equal(first.ticket.messages[0].body, input.description)
    assert.equal(first.ticket.job?.state, 'queued')
    const duplicate = store.create(input)
    assert.equal(duplicate.created, false); assert.equal(duplicate.ticket.id, first.ticket.id)
    assert.throws(() => store.create({ ...input, title: 'Другая проблема' }), (error: unknown) => error instanceof SupportError && error.status === 409)
    store.close(); store = f.store()
    assert.equal(store.ticket('anna', first.ticket.id).messages.length, 1)
    assert.equal(readFileSync(f.crmPath, 'utf8'), original)
    assert.throws(() => store.ticket('oleg', first.ticket.id), (error: unknown) => error instanceof SupportError && error.status === 403)
  } finally { store.close(); f.close() }
})

test('real concurrent MCP mutations create one ticket and one initial message', async () => {
  const f = fixture(), client = supportTicketClient(f.location), input = f.create()
  try {
    const results = await Promise.all([client.create(input), client.create(input), client.create(input)])
    assert.equal(new Set(results.map(({ ticket }) => ticket.id)).size, 1)
    assert.equal(results.filter(({ created }) => created).length, 1)
    const ticket = await client.get({ userId: 'anna', ticketId: results[0].ticket.id })
    assert.equal(ticket.messages.length, 1)
    const job = await client.claim({ workerId: 'fixture-worker' }); assert.ok(job)
    await client.complete({ jobId: job.id, leaseToken: job.leaseToken, body: policy.repeat(12), reply })
    const context = await readSupportContext(f.location, { userId: 'anna', ticketId: ticket.id })
    assert.ok(context.receipt.result.ticket!.messages[1].body.length > 600, 'Long saved answers must remain readable through MCP')
    await assert.rejects(client.get({ userId: 'oleg', ticketId: ticket.id }), (error: unknown) => error instanceof SupportError && error.status === 403)
    assert.ok(!JSON.stringify(await readSupportContext(f.location, { userId: 'anna', ticketId: ticket.id })).includes('do-not-expose'))
  } finally { f.close() }
})

test('answers, status changes and clarification messages are persisted as one ticket thread', () => {
  const f = fixture(), store = f.store()
  try {
    const ticket = store.create(f.create()).ticket
    const job = store.claim('worker-a')!
    assert.equal(store.ticket('anna', ticket.id).status, 'in_progress')
    assert.throws(() => store.changeStatus({ userId: 'anna', ticketId: ticket.id, status: 'resolved', revision: 2 }), /уже отвечает/)
    const answered = store.complete({ jobId: job.id, leaseToken: job.leaseToken, body: policy, reply })
    assert.equal(answered.status, 'pending'); assert.equal(answered.messages.length, 2)
    assert.equal(answered.messages[1].replyTo, answered.messages[0].id)
    assert.deepEqual(answered.messages[1].reply?.citations, [citation])
    assert.throws(() => store.changeStatus({ userId: 'anna', ticketId: ticket.id, status: 'resolved', revision: 0 }), /Тикет изменился/)
    const resolved = store.changeStatus({ userId: 'anna', ticketId: ticket.id, status: 'resolved', revision: answered.revision })
    assert.equal(resolved.status, 'resolved')
    const followup = { userId: 'anna', ticketId: ticket.id, input: 'А по паролю теперь совсем нельзя?', provider: 'local' as const, requestId: randomUUID() }
    const reopened = store.append(followup).ticket
    assert.equal(reopened.status, 'open'); assert.equal(reopened.messages.length, 3)
    assert.equal(store.append(followup).created, false)
    assert.throws(() => store.append({ ...followup, requestId: randomUUID() }), /уже отвечает/)
    const next = store.claim('worker-a')!
    assert.equal(next.input, followup.input)
    const done = store.complete({ jobId: next.id, leaseToken: next.leaseToken, body: policy, reply })
    assert.equal(done.messages.length, 4); assert.equal(done.status, 'pending')
  } finally { store.close(); f.close() }
})

test('expired jobs can be reclaimed after restart; a stale worker cannot publish a duplicate answer', () => {
  const f = fixture(), store = f.store()
  try {
    const ticket = store.create(f.create()).ticket, first = store.claim('old-worker')!
    assert.equal(store.claim('other-worker'), null)
    const db = new DatabaseSync(f.ticketsPath)
    try { db.prepare('UPDATE support_jobs SET lease_until=0 WHERE id=?').run(first.id) } finally { db.close() }
    const second = store.claim('new-worker')!
    assert.equal(first.id, second.id); assert.notEqual(first.leaseToken, second.leaseToken)
    assert.throws(() => store.complete({ jobId: first.id, leaseToken: first.leaseToken, body: 'stale', reply }), /другому обработчику/)
    store.renew({ jobId: second.id, leaseToken: second.leaseToken })
    const completed = store.complete({ jobId: second.id, leaseToken: second.leaseToken, body: policy, reply })
    assert.equal(completed.messages.length, 2)
    assert.throws(() => store.complete({ jobId: second.id, leaseToken: second.leaseToken, body: policy, reply }), /другому обработчику/)
    assert.equal(store.ticket('anna', ticket.id).messages.length, 2)
  } finally { store.close(); f.close() }
})

test('technical failures preserve the user question and support a retry without duplicating it', () => {
  const f = fixture(), store = f.store()
  try {
    const ticket = store.create(f.create()).ticket, job = store.claim('worker')!
    const failed = store.fail({ jobId: job.id, leaseToken: job.leaseToken, error: 'Модель недоступна' })
    assert.equal(failed.status, 'escalated'); assert.equal(failed.messages.length, 1)
    assert.equal(failed.job?.state, 'failed')
    const retried = store.retry({ userId: 'anna', ticketId: ticket.id, provider: 'local', requestId: randomUUID() }).ticket
    assert.equal(retried.messages.length, 1)
    const retryJob = store.claim('worker')!
    const unknown = store.complete({ jobId: retryJob.id, leaseToken: retryJob.leaseToken, body: 'Нужна помощь оператора.', reply: { ...reply, outcome: 'escalate', citations: [] } })
    assert.equal(unknown.status, 'escalated'); assert.equal(unknown.messages.length, 2)
    assert.equal(unknown.job?.state, 'completed')
  } finally { store.close(); f.close() }
})

test('worker uses real MCP + SQLite + RAG and resolves follow-ups from the persisted conversation', async () => {
  const f = fixture()
  let sources: RagSource[] = [], rewrites = 0
  const service = new SupportAssistant({ knowledgeDirectory: 'support/knowledge', root: f.root, crmPath: f.crmPath, dataDirectory: join(f.root, 'data'), embeddings: new Embeddings(), model: () => ({
    stats: { provider: 'local', model: 'fixture', calls: 0, promptTokens: 0, outputTokens: 0, durationMs: 0, answerMs: 0 },
    setSources: (next) => { sources = next }, complete: async (messages, stage) => {
      const last = messages[messages.length - 1].content
      if (stage === 'rewrite') {
        rewrites++
        const context = JSON.parse(last)
        assert.ok(context.history.some(({ author, body }: { author: string; body: string }) => author === 'agent' && body.includes('SSO')))
        return { content: JSON.stringify({ question: 'Можно ли войти по паролю при обязательном SSO?' }), usage }
      }
      if (stage === 'rerank') return { content: JSON.stringify({ items: JSON.parse(last).candidates.map(({ chunkId }: { chunkId: string }) => ({ chunkId, relevance: 3, reason: 'Инструкция авторизации' })) }), usage }
      if (stage === 'verify') return { content: JSON.stringify({ items: JSON.parse(last).claims.map(({ claimId }: { claimId: number }) => ({ claimId, supported: true, reason: 'Цитата подтверждает' })), taskCheck: { goalAligned: true, constraintsRespected: true, answersQuestion: true, reason: 'Учтён тикет' } }), usage }
      const runtime = sources.find(({ source }) => source.startsWith('mcp://'))!, doc = sources.find(({ source, text }) => source.startsWith('support/knowledge/') && text.includes(policy))!
      assert.ok(!runtime.text.includes('В аккаунте обязателен SSO. При обязательном SSO'), 'Prior assistant statements must not become fresh MCP evidence')
      return { content: JSON.stringify({ status: 'answered', claims: [{ text: 'В аккаунте обязателен SSO. При обязательном SSO вход по паролю отключён.', citations: [{ chunkId: runtime.chunkId, quote: 'SSO обязателен: да' }, { chunkId: doc.chunkId, quote: policy }] }] }), usage }
    },
  }) })
  const worker = new SupportTickets(service, { pollMs: 100, ask: async (...args) => {
    try { return await service.ask(...args) } catch (error) { console.error('Workflow generation failed:', error); throw error }
  } })
  try {
    await service.index()
    const created = await worker.client.create(f.create())
    worker.start()
    const first = await eventually(() => worker.client.get({ userId: 'anna', ticketId: created.ticket.id }), (ticket) => { assert.notEqual(ticket.job?.state, 'failed', ticket.job?.error || 'Задание завершилось с ошибкой'); return ticket.job?.state === 'completed' })
    assert.equal(first.status, 'pending'); assert.equal(first.messages.length, 2)
    assert.ok(first.messages[1].reply?.citations.some(({ source }) => source.startsWith('mcp://')))
    await worker.client.append({ userId: 'anna', ticketId: first.id, input: 'А по паролю теперь совсем нельзя?', provider: 'local', requestId: randomUUID() })
    worker.wake()
    const second = await eventually(() => worker.client.get({ userId: 'anna', ticketId: first.id }), (ticket) => ticket.messages.length === 4)
    assert.equal(second.status, 'pending'); assert.equal(rewrites, 1)
    await worker.stop()
    const freshClient = supportTicketClient(service.crmLocation)
    assert.equal((await freshClient.get({ userId: 'anna', ticketId: first.id })).messages.length, 4)
  } finally { await worker.stop(); f.close() }
})

test('HTTP creates immediately, persists the automatic answer, validates status and blocks another user', async () => {
  const f = fixture(), service = new SupportAssistant({ knowledgeDirectory: 'support/knowledge', root: f.root, crmPath: f.crmPath, embeddings: new Embeddings() })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const worker = new SupportTickets(service, { pollMs: 100, ask: async (question, selection) => {
    await gate
    return { question, selection, provider: 'local', model: 'fixture', answer: policy, outcome: 'answered', indexRunId: 'fixture', durationMs: 1,
      grounding: { status: 'answered', answer: policy, sources: [], citations: [citation], claims: [], verification: { status: 'passed', attempts: 1, judgments: [] }, usage }, sources: [],
    } satisfies SupportAnswer
  } })
  const router = createSupportRouter(service, worker), app = express(); app.use(express.json()); app.use('/api/support', router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}/api/support`
  const post = (path: string, body: unknown, method = 'POST') => fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.equal((await post('/tickets', { ...f.create(), root: '/tmp' })).status, 400)
    const response = await post('/tickets', f.create())
    assert.equal(response.status, 202)
    const { ticket } = await response.json()
    assert.equal(ticket.messages.length, 1)
    assert.equal((await fetch(`${base}/tickets/${ticket.id}?userId=oleg`)).status, 403)
    assert.equal((await post(`/tickets/${ticket.id}/status`, { userId: 'anna', status: 'in_progress', revision: ticket.revision }, 'PATCH')).status, 400)
    release()
    const finished = await eventually(async () => (await fetch(`${base}/tickets/${ticket.id}?userId=anna`)).json(), (record) => record.job?.state === 'completed')
    assert.equal(finished.messages.length, 2); assert.equal(finished.status, 'pending')
    const resolved = await post(`/tickets/${ticket.id}/status`, { userId: 'anna', status: 'resolved', revision: finished.revision }, 'PATCH')
    assert.equal(resolved.status, 200); assert.equal((await resolved.json()).status, 'resolved')
  } finally { release(); await worker.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); f.close() }
})

test('MCP deletion hides a ticket, cancels its lease and restores its messages without reviving an old worker', async () => {
  const f = fixture(), client = supportTicketClient(f.location), input = f.create()
  try {
    const created = await client.create(input), job = await client.claim({ workerId: 'delete-worker' })
    assert.ok(job)
    const current = await client.get({ userId: 'anna', ticketId: created.ticket.id })
    const action = { userId: 'anna', ticketId: current.id, revision: current.revision }
    await assert.rejects(client.remove({ ...action, userId: 'oleg' }), (e: unknown) => e instanceof SupportError && e.status === 403)
    await assert.rejects(client.remove({ ...action, revision: 0 }), (e: unknown) => e instanceof SupportError && e.status === 409)
    const removed = await client.remove(action)
    assert.ok(removed.deletedAt); assert.equal(removed.job?.state, 'failed')
    assert.equal(removed.messages.length, 1)
    assert.equal((await client.remove(action)).deletedAt, removed.deletedAt, 'A network retry must not change the deletion')
    await assert.rejects(client.get({ userId: 'anna', ticketId: current.id }), (e: unknown) => e instanceof SupportError && e.status === 404)
    await assert.rejects(readSupportContext(f.location, { userId: 'anna', ticketId: current.id }), (e: unknown) => e instanceof SupportError && e.status === 404)
    await assert.rejects(client.create(input), (e: unknown) => e instanceof SupportError && e.status === 404)
    assert.equal((await readSupportCatalog(f.location)).tickets.length, 0)
    assert.equal((await readSupportCatalog(f.location, undefined, true)).tickets[0].deletedAt, removed.deletedAt)
    assert.equal((await client.get({ userId: 'anna', ticketId: current.id, includeDeleted: true })).messages.length, 1)
    await assert.rejects(client.get({ userId: 'oleg', ticketId: current.id, includeDeleted: true }), (e: unknown) => e instanceof SupportError && e.status === 403)
    await assert.rejects(client.renew({ jobId: job.id, leaseToken: job.leaseToken }), (e: unknown) => e instanceof SupportError && e.status === 409)
    await assert.rejects(client.complete({ jobId: job.id, leaseToken: job.leaseToken, body: policy, reply }), (e: unknown) => e instanceof SupportError && e.status === 409)
    assert.equal(await client.claim({ workerId: 'other-worker' }), null)
    const restored = await client.restore({ ...action, revision: removed.revision })
    assert.equal(restored.deletedAt, undefined); assert.equal(restored.messages.length, 1)
    await assert.rejects(client.remove(action), (e: unknown) => e instanceof SupportError && e.status === 409)
    await assert.rejects(client.complete({ jobId: job.id, leaseToken: job.leaseToken, body: policy, reply }), (e: unknown) => e instanceof SupportError && e.status === 409)
    await client.retry({ userId: 'anna', ticketId: current.id, provider: 'local', requestId: randomUUID() })
    const next = await client.claim({ workerId: 'new-worker' }); assert.ok(next)
    assert.notEqual(next.id, job.id)
    assert.equal((await client.complete({ jobId: next.id, leaseToken: next.leaseToken, body: policy, reply })).messages.length, 2)
  } finally { f.close() }
})

test('deleted JSON seed tickets stay deleted after reopening and restore their complete conversation', () => {
  const f = fixture(), data = JSON.parse(readFileSync(f.crmPath, 'utf8'))
  data.tickets = [{ id: 'seed-ticket', userId: 'anna', title: 'Начальное обращение', description: 'Описание начального обращения', status: 'pending', category: 'auth', messages: [{ author: 'user', body: 'Исходный вопрос' }, { author: 'agent', body: 'Исходный ответ' }] }]
  writeFileSync(f.crmPath, JSON.stringify(data))
  let store = f.store()
  try {
    const ticket = store.ticket('anna', 'seed-ticket')
    const removed = store.remove({ userId: 'anna', ticketId: ticket.id, revision: ticket.revision })
    store.close(); store = f.store()
    assert.equal(store.catalog().tickets.length, 0)
    assert.equal(store.catalog(true).tickets.length, 1)
    const restored = store.restore({ userId: 'anna', ticketId: ticket.id, revision: removed.revision })
    assert.equal(restored.status, 'pending')
    assert.deepEqual(restored.messages.map(({ body }) => body), ['Исходный вопрос', 'Исходный ответ'])
    assert.equal(store.restore({ userId: 'anna', ticketId: ticket.id, revision: removed.revision }).revision, restored.revision)
  } finally { store.close(); f.close() }
})

test('an existing database is migrated once even when several MCP processes open it concurrently', async () => {
  const f = fixture(), store = f.store()
  const ticket = store.create(f.create()).ticket
  store.close()
  const db = new DatabaseSync(f.ticketsPath)
  try { db.exec('ALTER TABLE support_tickets DROP COLUMN deleted_at') } finally { db.close() }
  try {
    const clients = Array.from({ length: 3 }, () => supportTicketClient(f.location))
    const records = await Promise.all(clients.map((client) => client.get({ userId: 'anna', ticketId: ticket.id })))
    assert.ok(records.every((record) => record.messages.length === 1 && !record.deletedAt))
    const removed = await clients[0].remove({ userId: 'anna', ticketId: ticket.id, revision: ticket.revision })
    assert.ok(removed.deletedAt)
  } finally { f.close() }
})

test('HTTP deletion aborts active generation, validates ownership/revision and supports explicit trash reads and restoration', async () => {
  const f = fixture(), service = new SupportAssistant({ knowledgeDirectory: 'support/knowledge', root: f.root, crmPath: f.crmPath, embeddings: new Embeddings() })
  let started = false, aborted = false
  const worker = new SupportTickets(service, { pollMs: 100, ask: async (question, selection, _provider, signal) => {
    started = true
    try { await delay(60000, undefined, { signal }) } catch (error) { aborted = true; throw error }
    return { question, selection, provider: 'local', model: 'fixture', answer: policy, outcome: 'answered', indexRunId: 'fixture', durationMs: 1,
      grounding: { status: 'answered', answer: policy, sources: [], citations: [citation], claims: [], verification: { status: 'passed', attempts: 1, judgments: [] }, usage }, sources: [],
    } satisfies SupportAnswer
  } })
  const app = express(); app.use(express.json()); app.use('/api/support', createSupportRouter(service, worker))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}/api/support`
  const send = (path: string, body: unknown, method = 'POST') => fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const { ticket } = await (await send('/tickets', f.create())).json()
    const running = await eventually(async () => (await fetch(`${base}/tickets/${ticket.id}?userId=anna`)).json(), (record) => started && record.job?.state === 'running')
    assert.equal((await send(`/tickets/${ticket.id}`, { userId: 'anna' }, 'DELETE')).status, 400)
    assert.equal((await send(`/tickets/${ticket.id}`, { userId: 'oleg', revision: running.revision }, 'DELETE')).status, 403)
    assert.equal((await send(`/tickets/${ticket.id}`, { userId: 'anna', revision: 0 }, 'DELETE')).status, 409)
    const response = await send(`/tickets/${ticket.id}`, { userId: 'anna', revision: running.revision }, 'DELETE')
    assert.equal(response.status, 200)
    const removed = await response.json(); assert.ok(removed.deletedAt)
    await eventually(() => Promise.resolve(aborted), Boolean)
    assert.equal((await fetch(`${base}/tickets/${ticket.id}?userId=anna`)).status, 404)
    assert.equal((await fetch(`${base}/tickets/${ticket.id}?userId=oleg&includeDeleted=true`)).status, 403)
    assert.equal((await fetch(`${base}/tickets/${ticket.id}?userId=anna&includeDeleted=bad`)).status, 400)
    assert.equal((await (await fetch(`${base}/catalog`)).json()).tickets.length, 0)
    assert.equal((await (await fetch(`${base}/catalog?includeDeleted=true`)).json()).tickets.length, 1)
    assert.equal((await (await fetch(`${base}/tickets/${ticket.id}?userId=anna&includeDeleted=true`)).json()).messages.length, 1)
    assert.equal((await send(`/tickets/${ticket.id}/messages`, { userId: 'anna', input: 'Уточнение', requestId: randomUUID() })).status, 404)
    assert.equal((await send(`/tickets/${ticket.id}/restore`, { userId: 'oleg', revision: removed.revision })).status, 403)
    const restored = await send(`/tickets/${ticket.id}/restore`, { userId: 'anna', revision: removed.revision })
    assert.equal(restored.status, 200)
    assert.equal((await restored.json()).deletedAt, undefined)
    assert.equal((await (await fetch(`${base}/tickets/${ticket.id}?userId=anna`)).json()).messages.length, 1)
  } finally { await worker.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); f.close() }
})


test('worker persists a specific safe failure explanation without provider secrets', async () => {
  const f = fixture(), service = new SupportAssistant({ knowledgeDirectory: 'support/knowledge', root: f.root, crmPath: f.crmPath, dataDirectory: join(f.root, 'data'), embeddings: new Embeddings() })
  const worker = new SupportTickets(service, { pollMs: 100, ask: async () => { throw new SupportGenerationError('model_format', 'verify', new Error('provider-secret-never-save')) } })
  try {
    const created = (await worker.client.create(f.create())).ticket
    worker.start()
    const failed = await eventually(() => worker.client.get({ userId: 'anna', ticketId: created.id }), (ticket) => ticket.job?.state === 'failed')
    assert.match(failed.job!.error!, /некорректный формат ответа или проверки/)
    assert.doesNotMatch(JSON.stringify(failed), /provider-secret-never-save/)
    await worker.stop()
    const reopened = await supportTicketClient(service.crmLocation).get({ userId: 'anna', ticketId: created.id })
    assert.equal(reopened.job?.error, failed.job?.error)
    assert.equal(reopened.messages.length, 1)
  } finally { await worker.stop(); f.close() }
})
