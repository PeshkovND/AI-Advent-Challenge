import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import express from 'express'
import { JsonSupportCrm } from './support-crm'
import { SupportTicketStore } from './support-ticket-store'
import { createSupportRouter } from './support-router'
import { SupportTickets } from './support-tickets'
import type { RagSource } from '../src/rag-types'
import { SupportAssistant, supportContextSource } from './support-assistant'
import { collectSupportDocuments } from './support-corpus'
import { readSupportCatalog, readSupportContext, supportTicketClient } from './support-mcp-client'
import { OllamaEmbeddingClient } from './rag-indexer'
import { localRagSettings, modelClient } from './local-rag-service'
import { supportCrmDefault, supportKnowledgeDefault } from './support-defaults'

const project = fileURLToPath(new URL('../', import.meta.url))
const usage = { inputTokens: 1, promptTokens: 1, completionTokens: 1, totalTokens: 2 }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'support-myfamily-'))
  cpSync(join(project, 'support'), join(root, 'support'), { recursive: true })
  const crm = join(root, supportCrmDefault)
  return { root, crm, location: { crmPath: crm, ticketsPath: join(root, 'data/support-tickets.sqlite') }, close: () => rmSync(root, { recursive: true, force: true }) }
}
class Embeddings extends OllamaEmbeddingClient {
  override async embed(texts: string[], signal?: AbortSignal) { signal?.throwIfAborted(); return texts.map(() => [1, 0]) }
}

test('ticket-only MCP needs no users, preserves reported details and ignores injected profiles', async () => {
  const f = fixture()
  try {
    const source = JSON.parse(readFileSync(f.crm, 'utf8'))
    assert.equal(source.users, undefined)
    source.users = [{ id: 'fake', token: 'never_send', myFamily: { permissions: { camera: 'granted' } } }]
    writeFileSync(f.crm, JSON.stringify(source))
    const catalog = await readSupportCatalog(f.location)
    assert.equal(catalog.mode, 'tickets'); assert.deepEqual(catalog.users, [])
    const client = supportTicketClient(f.location)
    const input = { title: 'Не открывается камера', description: 'Хочу сделать фото, но камера не открывается.', details: { device: 'iPhone 15', osVersion: 'iOS 18.5', triedSteps: 'Перезапустил приложение' }, requestId: randomUUID() }
    const created = await client.create(input)
    assert.equal(created.ticket.userId, 'support-local')
    assert.equal((await client.create(input)).created, false)
    const snapshot = await readSupportContext(f.location, { ticketId: created.ticket.id })
    assert.equal(snapshot.receipt.result.customer, undefined)
    assert.deepEqual(snapshot.receipt.result.ticket?.details, input.details)
    const evidence = supportContextSource(snapshot).text
    assert.match(evidence, /СО СЛОВ АВТОРА/)
    assert.match(evidence, /iPhone 15/)
    assert.doesNotMatch(evidence, /never_send|granted|Роль в семье|Тариф:|undefined/)
    await assert.rejects(client.create({ ...input, userId: 'fake', requestId: randomUUID() }), /автор назначается/)
    assert.throws(() => client.create({ ...input, details: { ...input.details, camera: 'granted' } } as never))
    const job = await client.claim({ workerId: 'test-worker' }); assert.ok(job)
    await client.fail({ jobId: job.id, leaseToken: job.leaseToken, error: 'Test unavailable model' })
    await client.retry({ ticketId: created.ticket.id, requestId: randomUUID() })
    const running = await client.claim({ workerId: 'test-worker' }); assert.ok(running)
    const removed = await client.remove({ ticketId: created.ticket.id, revision: (await client.get({ ticketId: created.ticket.id })).revision })
    assert.ok(removed.deletedAt)
    await assert.rejects(client.complete({ jobId: running.id, leaseToken: running.leaseToken, body: 'stale', reply: { outcome: 'escalate', provider: 'local', model: 'test', durationMs: 1, citations: [], indexRunId: 'test' } }))
    const restored = await client.restore({ ticketId: created.ticket.id, revision: removed.revision })
    const resolved = await client.status({ ticketId: created.ticket.id, status: 'resolved', revision: restored.revision })
    assert.equal(resolved.status, 'resolved')
    const followup = await client.append({ ticketId: created.ticket.id, input: 'В галерее фото выбирается', requestId: randomUUID() })
    assert.equal(followup.ticket.messages.length, 2)
    assert.equal(followup.ticket.status, 'open')
    assert.deepEqual(followup.ticket.details, input.details)
  } finally { f.close() }
})

test('ticket RAG uses only the selected description and reported details without fabricated account state', async () => {
  const f = fixture()
  let sources: RagSource[] = []
  try {
    const service = new SupportAssistant({ root: f.root, embeddings: new Embeddings('http://127.0.0.1:1', 'test'), model: () => ({
      stats: { provider: 'local', model: 'test', calls: 0, promptTokens: 0, outputTokens: 0, durationMs: 0, answerMs: 0 },
      setSources: (next) => { sources = next }, complete: async (messages, stage) => {
        if (stage === 'rerank') {
          const { candidates } = JSON.parse(messages[messages.length - 1].content)
          return { content: JSON.stringify({ items: candidates.map(({ chunkId, source }: { chunkId: string; source: string }) => ({ chunkId, relevance: source.includes('families') ? 3 : 0, reason: 'Семейные права' })) }), usage }
        }
        if (stage === 'verify') {
          const { claims } = JSON.parse(messages[messages.length - 1].content)
          return { content: JSON.stringify({ items: claims.map(({ claimId }: { claimId: number }) => ({ claimId, supported: true, reason: 'Данные и правило разделены' })), taskCheck: { goalAligned: true, constraintsRespected: true, answersQuestion: true, reason: 'Учтена роль' } }), usage }
        }
        const runtime = sources.find(({ source }) => source.startsWith('mcp://'))!
        const owner = runtime.text.includes('Я владелец семьи.')
        assert.doesNotMatch(runtime.text, /Разрешение camera:|Данные аккаунта|Pro активен/)
        const quote = 'В интерфейсе управления семьёй кнопки приглашения и удаления участников доступны владельцу owner; участнику regular они не показываются.'
        const document = sources.find(({ text }) => text.includes(quote))!
        assert.ok(document, 'Family rules must survive retrieval and source budgeting')
        return { content: JSON.stringify({ status: 'answered', claims: [
          { text: owner ? 'Если вы владелец семьи, вы можете управлять приглашениями.' : 'Если вы участник семьи, попросите владельца пригласить родственника.', citations: [{ chunkId: runtime.chunkId, quote: owner ? 'Я владелец семьи.' : 'Я участник семьи.' }, { chunkId: document.chunkId, quote }] },
        ] }), usage }
      },
    }) })
    assert.equal(service.crmPath, f.crm)
    assert.equal(service.knowledgeDirectory, supportKnowledgeDefault)
    await service.index()
    const client = supportTicketClient(f.location)
    const owner = (await client.create({ title: 'Приглашения', description: 'Я владелец семьи. Где управление приглашениями?', requestId: randomUUID() })).ticket
    const member = (await client.create({ title: 'Приглашения', description: 'Я участник семьи. Где управление приглашениями?', requestId: randomUUID() })).ticket
    const first = await service.ask('Кому доступно управление приглашениями?', { ticketId: owner.id })
    const second = await service.ask('Кому доступно управление приглашениями?', { ticketId: member.id })
    for (const answer of [first, second]) {
      assert.equal(answer.outcome, 'answered')
      assert.equal(answer.grounding.verification.status, 'passed')
      assert.ok(answer.grounding.citations.some(({ source }) => source.startsWith('mcp://')))
      assert.ok(answer.grounding.citations.some(({ source }) => source.startsWith(`${supportKnowledgeDefault}/`)))
    }
    assert.match(first.answer, /Если вы владелец/)
    assert.match(second.answer, /Если вы участник/)
  } finally { f.close() }
})

test('CRM revision mismatch fails before model generation', async () => {
  const f = fixture()
  try {
    const data = JSON.parse(readFileSync(f.crm, 'utf8')); data.knowledgeRevision = 'f'.repeat(40)
    writeFileSync(f.crm, JSON.stringify(data))
    const service = new SupportAssistant({ root: f.root, embeddings: new Embeddings('http://127.0.0.1:1', 'test'), model: () => { throw new Error('Model must not be called') } })
    await service.index()
    await assert.rejects(service.ask('Как пригласить участника?', { ticketId: 'MF-2002' }), /Версия CRM не соответствует/)
  } finally { f.close() }
})

test('develop corpus and CRM have matching provenance, cover real modules and preserve the main archive', () => {
  const documents = collectSupportDocuments(project, supportKnowledgeDefault)
  const manifest = JSON.parse(readFileSync(join(project, 'support/myfamily/develop/provenance.json'), 'utf8'))
  const crm = JSON.parse(readFileSync(join(project, supportCrmDefault), 'utf8'))
  assert.equal(manifest.commit, 'cbd4086dc5e30c8e5a77262e1c944cc1514d30d4')
  assert.equal(crm.knowledgeRevision, manifest.commit)
  assert.equal(crm.mode, 'tickets')
  assert.equal(crm.users, undefined)
  assert.equal(documents.length, 8)
  assert.equal(manifest.documents.length, documents.length)
  for (const document of documents) {
    assert.ok(document.text.includes(manifest.commit))
    const digest = createHash('sha256').update(readFileSync(join(project, document.source))).digest('hex')
    assert.equal(manifest.documents.find(({ path }: { path: string }) => path === document.source)?.sha256, digest)
    for (const path of document.text.matchAll(/`(XcodeProject\/[^`]+\.swift)`/g)) {
      assert.ok(manifest.sources.some((source: { path: string }) => source.path === path[1]), `Missing provenance: ${path[1]}`)
    }
  }
  const corpus = documents.map(({ text }) => text).join('\n')
  for (const term of ['VK ID', 'owner', 'regular', 'StoreKit', 'SwiftData', 'геолокации', 'комментар', 'токсич', 'микрофон']) assert.ok(corpus.includes(term), term)
  assert.doesNotMatch(corpus, /SSO_REQUIRED|BILLING_FORBIDDEN|WEBHOOK_DELIVERY_FAILED|My Profile Screen/)
  assert.ok(readFileSync(join(project, 'support/myfamily/knowledge/auth.md'), 'utf8').includes('fe9030e'))
})

test('support can use a larger local model without changing the model of other features', async () => {
  const original = localRagSettings().model
  let requested = ''
  const client = modelClient('local', undefined, (async (_url, init) => {
    requested = JSON.parse(String(init?.body)).model
    return Response.json({ message: { content: '{"question":"Проверка"}' }, prompt_eval_count: 1, eval_count: 1 })
  }) as typeof fetch, { localModel: 'support-fixture-9b' })
  await client.complete([{ role: 'user', content: 'Проверка' }], 'rewrite')
  assert.equal(requested, 'support-fixture-9b')
  assert.equal(client.stats.model, 'support-fixture-9b')
  assert.equal(modelClient('local', undefined).stats.model, original)
})


test('switching an existing JSON source to ticket mode preserves old authors, status, deletion and history', () => {
  const f = fixture()
  let store: SupportTicketStore | undefined
  try {
    const legacy = JSON.parse(readFileSync(join(project, 'examples/support-myfamily-users/crm.demo.json'), 'utf8'))
    writeFileSync(f.crm, JSON.stringify(legacy))
    store = new SupportTicketStore(new JsonSupportCrm(f.crm), f.location.ticketsPath)
    const original = store.ticket('mf_owner', 'MF-2001')
    const resolved = store.changeStatus({ userId: 'mf_owner', ticketId: original.id, revision: original.revision, status: 'resolved' })
    const removed = store.remove({ userId: 'mf_owner', ticketId: original.id, revision: resolved.revision })
    store.close(); store = undefined
    const current = { ...legacy, mode: 'tickets' }; delete current.users
    writeFileSync(f.crm, JSON.stringify(current))
    store = new SupportTicketStore(new JsonSupportCrm(f.crm), f.location.ticketsPath)
    const preserved = store.ticket(undefined, original.id, true)
    assert.equal(preserved.userId, 'mf_owner')
    assert.equal(preserved.status, 'resolved'); assert.equal(preserved.deletedAt, removed.deletedAt)
    assert.deepEqual(preserved.messages, original.messages)
    assert.equal(store.catalog(true).tickets.length, legacy.tickets.length)
    assert.deepEqual(store.catalog(true).users, [])
    const restored = store.restore({ ticketId: original.id, revision: preserved.revision })
    const context = store.context(undefined, restored.id)
    assert.equal(context.customer, undefined)
    assert.equal(context.ticket?.userId, 'mf_owner')
    assert.doesNotMatch(supportContextSource({ capturedAt: new Date().toISOString(), receipt: { name: 'get_support_context', result: context } }).text, /Роль в семье: owner/)
    assert.equal(store.create({ title: 'Новый тикет', description: 'Описание нового обращения.', provider: 'local', requestId: randomUUID() }).ticket.userId, 'support-local')
  } finally { store?.close(); f.close() }
})

test('HTTP operator workflow accepts tickets without a user and rejects fabricated telemetry fields', async () => {
  const f = fixture(), service = new SupportAssistant({ root: f.root })
  const worker = new SupportTickets(service)
  // Keep queued jobs idle: this checks the real HTTP/MCP contract, not model output.
  worker.start = () => {}; worker.wake = () => {}
  const app = express(); app.use(express.json()); app.use('/api/support', createSupportRouter(service, worker))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api/support`
  const post = (path: string, body: unknown, method = 'POST') => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const input = { title: 'Камера не открывается', description: 'При создании публикации не открывается камера.', details: { device: 'iPhone' }, requestId: randomUUID() }
    assert.equal((await post('/tickets', { ...input, customer: { camera: 'granted' } })).status, 400)
    const response = await post('/tickets', input); assert.equal(response.status, 202)
    const { ticket } = await response.json()
    const read = await fetch(`${base}/tickets/${ticket.id}`); assert.equal(read.status, 200)
    assert.deepEqual((await read.json()).details, { device: 'iPhone' })
    const context = await (await post('/context', { ticketId: ticket.id })).json()
    assert.equal(context.receipt.result.customer, undefined)
    const removed = await post(`/tickets/${ticket.id}`, { revision: ticket.revision }, 'DELETE'); assert.equal(removed.status, 200)
    const record = await removed.json()
    assert.equal((await post(`/tickets/${ticket.id}/restore`, { revision: record.revision })).status, 200)
  } finally { await worker.stop(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); f.close() }
})


for (const badText of [
  'Автор тикета сообщает, что не дал разрешение на использование камеры.',
  'AddPostViewController открывает UIImagePickerController, если isSourceTypeAvailable возвращает true.',
  'Проверьте доступ к камере. '.repeat(40),
]) test(`support repairs a customer reply before verification: ${badText.slice(0, 55)}`, async () => {
  const f = fixture()
  let sources: RagSource[] = [], attempts = 0, verifications = 0
  const instruction = 'Разрешите MyFamily доступ к камере: «Настройки» → «Конфиденциальность и безопасность» → «Камера».'
  try {
    const client = supportTicketClient(f.location)
    const ticket = (await client.create({ title: 'Не открывается камера', description: 'Камера не открывается при создании фото. Я не дал разрешение на использование камеры.', requestId: randomUUID() })).ticket
    const service = new SupportAssistant({ root: f.root, embeddings: new class extends Embeddings { override async embed(texts: string[]) { return texts.map((text) => /Я не дал|Если вы не разрешили/.test(text) ? [1, 0] : [0, 1]) } }('http://127.0.0.1:1', 'test'), model: () => ({
      stats: { provider: 'local', model: 'test', calls: 0, promptTokens: 0, outputTokens: 0, durationMs: 0, answerMs: 0 },
      setSources: (next) => { sources = next }, complete: async (messages, stage) => {
        const last = JSON.parse(stage === 'answer' ? '{}' : messages[messages.length - 1].content)
        if (stage === 'rerank') return { content: JSON.stringify({ items: last.candidates.map(({ chunkId, text }: { chunkId: string; text: string }) => ({ chunkId, relevance: text.includes('Как включить доступ к камере') || text.includes('Если вы не разрешили MyFamily') ? 3 : 0, reason: 'Изменение разрешения' })) }), usage }
        if (stage === 'verify') {
          verifications++
          assert.ok(messages.some(({ content }) => content.includes('Прямое последнее уточнение клиента')))
          assert.equal(last.claims.length, 1)
          assert.equal(last.claims[0].text, instruction)
          return { content: JSON.stringify({ items: [{ claimId: 1, supported: true, reason: 'Рекомендация по документу с учётом отказа в доступе' }], taskCheck: { goalAligned: true, constraintsRespected: true, answersQuestion: true, reason: 'Кратко и напрямую' } }), usage }
        }
        attempts++
        assert.ok(messages[0].content.includes('Пиши непосредственно клиенту'))
        if (attempts === 2) assert.ok(messages.some(({ content }) => content.startsWith('Исправь предыдущую попытку:')))
        const runtime = sources.find(({ source }) => source.startsWith('mcp://'))!
        const document = sources.find(({ text }) => text.includes('Если вы не разрешили MyFamily использовать камеру'))!
        assert.ok(document)
        const quote = 'Если вы не разрешили MyFamily использовать камеру, откройте на iPhone «Настройки» → «Конфиденциальность и безопасность» → «Камера» и включите доступ для MyFamily, если приложение есть в списке.'
        return { content: JSON.stringify({ status: 'answered', claims: [{ text: attempts === 1 ? badText : instruction, citations: [{ chunkId: runtime.chunkId, quote: 'Я не дал разрешение на использование камеры.' }, { chunkId: document.chunkId, quote }] }] }), usage }
      },
    }) })
    await service.index()
    const result = await service.ask('Я не дал разрешение на использование камеры.', { ticketId: ticket.id })
    assert.equal(attempts, 2); assert.equal(verifications, 1)
    assert.equal(result.outcome, 'answered')
    assert.equal(result.grounding.claims.length, 1)
    assert.equal(result.grounding.citations.length, 2)
    assert.match(result.answer, /^Разрешите MyFamily/)
    assert.doesNotMatch(result.answer, /Автор тикета|ViewController|неизвестно/)
  } finally { f.close() }
})


test('regression: captured DeepSeek camera checks reach verification without an artificial MCP citation', async () => {
  const f = fixture()
  const captured = JSON.parse(readFileSync(new URL('./fixtures/support-camera-cloud.json', import.meta.url), 'utf8'))
  let sources: RagSource[] = [], verified = 0
  try {
    const client = supportTicketClient(f.location)
    const question = 'Хочу сделать фото/видео через приложение и выложить в семейную ленту, но камера не открывается, в чем может быть проблема?'
    const ticket = (await client.create({ title: 'Не открывается камера', description: question, requestId: randomUUID() })).ticket
    const service = new SupportAssistant({ root: f.root, embeddings: new class extends Embeddings { override async embed(texts: string[]) { return texts.map((text) => /камера не открывается|Если вы не разрешили/i.test(text) ? [1, 0] : [0, 1]) } }('http://127.0.0.1:1', 'test'), model: () => ({
      stats: { provider: 'cloud', model: 'captured-deepseek', calls: 0, promptTokens: 0, outputTokens: 0, durationMs: 0, answerMs: 0 },
      setSources: (next) => { sources = next }, complete: async (messages, stage) => {
        const last = stage === 'answer' ? {} : JSON.parse(messages[messages.length - 1].content)
        if (stage === 'rerank') return { content: JSON.stringify({ items: last.candidates.map(({ chunkId }: { chunkId: string }) => ({ chunkId, relevance: captured.claims.some((claim: { citations: Array<{ chunkId: string }> }) => claim.citations.some((citation) => citation.chunkId === chunkId)) ? 3 : 0, reason: 'Проверки камеры' })) }), usage }
        if (stage === 'verify') {
          verified++
          assert.equal(last.additionalSources[0].source, 'mcp://support/get_support_context')
          assert.ok(last.additionalSources[0].text.includes(question))
          assert.ok(last.claims.every((claim: { citations: Array<{ source: string }> }) => claim.citations.every(({ source }) => !source.startsWith('mcp://'))))
          return { content: JSON.stringify({ items: last.claims.map(({ claimId }: { claimId: number }) => ({ claimId, supported: true, reason: 'Условные проверки из FAQ, состояние разрешения не утверждается' })), taskCheck: { goalAligned: true, constraintsRespected: true, answersQuestion: true, reason: 'Общие проверки допустимы без диагноза' } }), usage }
        }
        for (const claim of captured.claims) for (const citation of claim.citations) assert.ok(sources.some(({ chunkId, text }) => chunkId === citation.chunkId && text.includes(citation.quote)))
        return { content: JSON.stringify(captured), usage }
      },
    }) })
    await service.index()
    const result = await service.ask(question, { ticketId: ticket.id }, 'cloud')
    assert.equal(verified, 1)
    assert.equal(result.outcome, 'answered')
    assert.equal(result.context?.receipt.result.ticket?.id, ticket.id)
    assert.equal(result.grounding.verification.status, 'passed')
    assert.ok(result.grounding.citations.every(({ source }) => !source.startsWith('mcp://')))
    assert.match(result.answer, /^Проверьте доступ к камере/)
  } finally { f.close() }
})
