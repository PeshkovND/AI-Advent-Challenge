import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { Agent, AgentService, AgentStateStore, createAgentRouter, normalizeDialogueMemory, normalizeRagConfig } from './agent-service'
import { applyDialoguePatch, dialogueEvidence, emptyDialogueMemory, latestDialogueMemory, prepareDialogue } from './dialogue-memory'
import { answerWithGrounding, parseDialogueJudgments } from './rag-grounding'
import { ragChatAgentConfig } from '../src/rag-chat-config'
import { ragChatScenarios } from '../src/rag-chat-scenarios'
import type { RagCompletion, RagRetriever } from './rag-retrieval'
import type { AgentMessage } from './agent-service'

const source = { source: 'docs/day-18.md', title: 'Worker', section: 'Хранение', chunkId: 'doc-1', strategy: 'structured' as const, score: 0.8, text: 'Worker использует BEGIN IMMEDIATE для захвата задачи.' }
const context = { indexRunId: 'index', sources: [source], instruction: source.text }
const config = ragChatAgentConfig('index')
const usage = { inputTokens: 0, promptTokens: 10, completionTokens: 5, totalTokens: 15 }
const patch = (question: string, updates: unknown[] = [], forget: unknown[] = [], intent = 'documents') => JSON.stringify({ question, updates, forget, intent })
const update = (category: string, key: string, text: string, quote = text) => ({ category, key, text, quote })
const goalText = 'Моя цель — проверить надёжность фоновых задач.'
function fakeClient() {
  return { complete: async (messages: Array<{ role: string; content: string }>) => {
    let content: string
    if (messages[0].content.includes('Обнови компактную память')) {
      const data = JSON.parse(messages[messages.length - 1].content)
      content = patch(`Worker: ${data.input}`, data.memory.turn ? [] : [update('goal', 'goal', data.input)])
    } else if (messages[0].content.includes('Проверь соответствие')) {
      const data = JSON.parse(messages[messages.length - 1].content)
      content = JSON.stringify({ items: data.claims.map((claim: { claimId: number }) => ({ claimId: claim.claimId, supported: true, reason: 'Подтверждено.' })), taskCheck: { goalAligned: true, constraintsRespected: true, answersQuestion: true, reason: 'Задача выполнена.' } })
    } else content = JSON.stringify({ status: 'answered', claims: [{ text: source.text, citations: [{ chunkId: source.chunkId, quote: source.text }] }] })
    return { content, promptTokens: 10, tokens: 5, totalTokens: 15 }
  } } as unknown as ConstructorParameters<typeof Agent>[2]
}

test('memory patches retain early facts, replace a key explicitly and require current user evidence', () => {
  const first = applyDialoguePatch(patch('Вопрос', [update('goal', 'goal', goalText), update('constraints', 'libs', 'Новые зависимости запрещены')]), emptyDialogueMemory(), `${goalText} Новые зависимости запрещены`)
  let state = first.state
  for (let i = 0; i < 15; i++) state = applyDialoguePatch(patch('Следующий вопрос'), state, 'Дальше').state
  assert.equal(state.goal?.text, goalText)
  assert.equal(state.constraints[0].text, 'Новые зависимости запрещены')
  state = applyDialoguePatch(patch('Дальше', [update('constraints', 'libs', 'Новые зависимости разрешены')]), state, 'Новые зависимости разрешены').state
  assert.equal(state.constraints.length, 1)
  assert.equal(state.constraints[0].text, 'Новые зависимости разрешены')
  assert.throws(() => applyDialoguePatch(patch('Вопрос', [update('goal', 'goal', 'Придуманная цель')]), state, 'Привет'))
  assert.throws(() => applyDialoguePatch(patch('Вопрос', [update('goal', 'a', 'Привет'), update('goal', 'b', 'Привет')]), state, 'Привет'))
  state = applyDialoguePatch(patch('Вопрос', [], [{ category: 'constraints', key: 'libs', quote: 'Отменяю ограничение' }]), state, 'Отменяю ограничение').state
  assert.equal(state.constraints.length, 0)
})

test('task extraction sees only user data and preserves a self-contained search question', async () => {
  const complete: RagCompletion = async (messages, stage) => {
    assert.equal(stage, 'memory')
    const data = JSON.parse(messages[messages.length - 1].content)
    assert.deepEqual(data.recentUsers, ['Как хранится индекс?'])
    return { content: patch('Как выполняется поиск в локальном индексе?'), usage }
  }
  const result = await prepareDialogue('А как в нём ищут?', emptyDialogueMemory(), ['Как хранится индекс?'], complete)
  assert.equal(result.question, 'Как выполняется поиск в локальном индексе?')
  assert.equal(result.usage.totalTokens, 15)
})

test('a greeting can have no search question, but a document route cannot', () => {
  assert.equal(applyDialoguePatch(patch('', [], [], 'conversation'), emptyDialogueMemory(), 'Привет').question, 'Привет')
  assert.equal(applyDialoguePatch(patch('', [], [], 'dialogue'), emptyDialogueMemory(), 'Моя цель — тест').question, 'Моя цель — тест')
  assert.throws(() => applyDialoguePatch(patch(''), emptyDialogueMemory(), 'Как устроен проект?'), /непустой question/)
})

test('ordinary agent searches every turn, resolves follow-ups, bounds history and keeps the early goal', async () => {
  const searches: string[] = []
  const retriever = { retrieve: async (question: string) => { searches.push(question); return context } } as unknown as RagRetriever
  const client = fakeClient()
  const original = client.complete.bind(client)
  client.complete = async (...args) => {
    const messages = args[0]
    if (messages.some((message) => message.content.includes('Верни только JSON одного из двух'))) {
      assert.ok(messages.filter((message) => message.role === 'assistant').length <= 3)
      assert.ok(messages.some((message) => message.content.includes(goalText)))
    }
    return original(...args)
  }
  const agent = new Agent('chat', config, client, undefined, undefined, retriever)
  const history: AgentMessage[] = []
  for (let turn = 1; turn <= 15; turn++) {
    const input = turn === 1 ? goalText : 'А как это работает?'
    const result = await agent.run(input, history)
    assert.equal(result.dialogueMemory?.goal?.text, goalText)
    assert.equal(result.dialogueMemory?.turn, turn)
    assert.equal(result.tokenMetrics.totalTokens, 45)
    assert.equal(result.rag?.grounding?.status, 'answered')
    assert.equal(result.rag?.grounding?.citations[0].quote, source.text)
    history.push({ role: 'user', content: input }, { role: 'assistant', content: result.output, dialogueMemory: result.dialogueMemory, grounding: result.rag?.grounding })
  }
  assert.equal(searches.length, 15)
  assert.equal(searches[searches.length - 1], 'Worker: А как это работает?')
})

test('dialogue evidence is original user text and cannot substitute weak project evidence', async () => {
  const state = applyDialoguePatch(patch('Цель', [update('goal', 'goal', goalText)]), emptyDialogueMemory(), goalText).state
  const sources = dialogueEvidence(state, [goalText])
  assert.equal(sources[0].text, goalText)
  assert.equal(sources[0].kind, 'dialogue')
  assert.throws(() => dialogueEvidence(state, ['Другой пользователь']))
  let calls = 0
  const complete: RagCompletion = async (_messages, stage) => {
    calls++
    return { content: stage === 'answer' ? JSON.stringify({ status: 'answered', claims: [{ text: goalText, citations: [{ chunkId: sources[0].chunkId, quote: goalText }] }] }) : JSON.stringify({ items: [{ claimId: 1, supported: true, reason: 'Цель пользователя.' }], taskCheck: { goalAligned: true, constraintsRespected: true, answersQuestion: true, reason: 'Цель сохранена.' } }), usage }
  }
  const refused = await answerWithGrounding('Сколько Redis-реплик?', [], [], complete, undefined, { question: 'Сколько Redis-реплик в проекте?', instruction: '', sources, allowDialogueOnly: false })
  assert.equal(refused.status, 'unknown')
  assert.equal(calls, 0)
  const goal = await answerWithGrounding('Напомни цель', [], [], complete, undefined, { question: 'Напомни цель', instruction: '', sources, allowDialogueOnly: true })
  assert.equal(goal.status, 'answered')
  assert.equal(goal.citations[0].kind, 'dialogue')
  assert.equal(calls, 2)
})

test('failed extraction and cancellation do not advance memory or make a retrieval call', async () => {
  const retriever = { retrieve: async () => { throw new Error('must not search') } } as unknown as RagRetriever
  const client = { complete: async () => ({ content: '{}', tokens: 5, promptTokens: 10, totalTokens: 15 }) } as unknown as ConstructorParameters<typeof Agent>[2]
  const agent = new Agent('failed', config, client, undefined, undefined, retriever)
  await assert.rejects(agent.run('Вопрос'), /intent|question|Invalid|expected/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(agent.run('Вопрос', [], undefined, 'failed', controller.signal), /abort/i)
})

test('a factually supported answer that violates the task is repaired and reverified; persistent failure abstains', async () => {
  const dialogue = { question: 'Дай один пункт', instruction: 'Нужен один пункт', sources: [], allowDialogueOnly: false }
  let checks = 0
  let answers = 0
  const complete: RagCompletion = async (messages, stage) => {
    if (stage === 'answer') {
      answers++
      if (answers > 1) assert.ok(messages.some((message) => message.content.includes('Весь ответ не выполняет задачу')))
      return { content: JSON.stringify({ status: 'answered', claims: [{ text: source.text, citations: [{ chunkId: source.chunkId, quote: source.text }] }] }), usage }
    }
    checks++
    return { content: JSON.stringify({ items: [{ claimId: 1, supported: true, reason: 'Цитата подтверждает факт.' }], taskCheck: { goalAligned: true, constraintsRespected: checks > 1, answersQuestion: true, reason: 'Проверено количество пунктов.' } }), usage }
  }
  const result = await answerWithGrounding('Дай один пункт', [], [source], complete, undefined, dialogue)
  assert.equal(answers, 2); assert.equal(checks, 2)
  assert.equal(result.verification.taskCheck?.constraintsRespected, true)
  assert.equal(result.usage.totalTokens, 60)
  const reject: RagCompletion = async (_messages, stage) => ({ content: stage === 'answer'
    ? JSON.stringify({ status: 'answered', claims: [{ text: source.text, citations: [{ chunkId: source.chunkId, quote: source.text }] }] })
    : JSON.stringify({ items: [{ claimId: 1, supported: true, reason: 'Факт подтверждён.' }], taskCheck: { goalAligned: true, constraintsRespected: false, answersQuestion: false, reason: 'Просьба не выполнена.' } }), usage })
  const refused = await answerWithGrounding('Дай один пункт', [], [source], reject, undefined, dialogue)
  assert.equal(refused.status, 'unknown')
  assert.equal(refused.verification.taskCheck?.constraintsRespected, false)
  assert.throws(() => parseDialogueJudgments('{"items":[]}', []))
})

test('user evidence is bounded to original fact quotes, not full messages', () => {
  const input = `${goalText} ${'длинный контекст '.repeat(300)}`
  const state = applyDialoguePatch(patch('Вопрос', [update('goal', 'goal', goalText)]), emptyDialogueMemory(), input).state
  const evidence = dialogueEvidence(state, [input])
  assert.equal(evidence[0].text, goalText)
  assert.ok(evidence[0].chunkId.startsWith('dialogue-user-1-goal-'))
})

test('a provider failure after memory preparation commits neither memory nor a partial turn', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rag-chat-rollback-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const client = fakeClient(); const original = client.complete.bind(client)
  client.complete = async (...args) => {
    if (!args[0][0].content.includes('Обнови компактную память')) throw new Error('Provider unavailable')
    return original(...args)
  }
  const service = new AgentService({ defaultDeepSeekModel: 'test', stateStore: new AgentStateStore(join(directory, 'state.json')), client, ragRetriever: { retrieve: async () => context } as unknown as RagRetriever })
  await service.create({ id: 'chat', config })
  await assert.rejects(service.run('chat', goalText, [], undefined, 'one'), /Provider unavailable/)
  assert.deepEqual(await service.getHistory('chat', 'one'), [])
  assert.equal((await service.listConversations('chat')).length, 0)
  client.complete = original
  const result = await service.run('chat', goalText, [], undefined, 'one')
  assert.equal(result.dialogueMemory?.turn, 1)
})

test('configuration is opt-in and accepts only bounded even windows with grounded RAG', () => {
  assert.equal(normalizeDialogueMemory({ enabled: false }), undefined)
  assert.deepEqual(normalizeDialogueMemory({ enabled: true }), { enabled: true, historyWindow: 6 })
  for (const historyWindow of [0, 3, 22, '6']) assert.throws(() => normalizeDialogueMemory({ enabled: true, historyWindow }))
  assert.throws(() => new Agent('bad', { ...config, rag: undefined }, fakeClient()))
  assert.throws(() => new Agent('bad', { ...config, contextStrategy: { strategy: 'sliding' } }, fakeClient()))
  assert.throws(() => new Agent('bad', { ...config, dialogueMemory: undefined }, fakeClient()), /retrievalPolicy/)
  assert.throws(() => normalizeRagConfig({ enabled: true, retrievalPolicy: 'sometimes' }), /retrievalPolicy/)
  assert.equal(normalizeRagConfig({ enabled: true })?.retrievalPolicy, undefined)
  assert.equal(normalizeRagConfig(config.rag)?.retrievalPolicy, 'auto')
  assert.equal(ragChatScenarios.length, 2)
  assert.ok(ragChatScenarios.every((scenario) => scenario.turns.length >= 10 && scenario.turns.length <= 15))
})

test('auto routes ordinary conversation and general knowledge without retrieval, preserves memory and retrieves project follow-ups', async () => {
  const routes = [
    { input: 'Привет', intent: 'conversation', output: 'Привет! Чем могу помочь?' },
    { input: 'Моя цель — проверить worker.', intent: 'dialogue', output: 'Моя цель — проверить worker.' },
    { input: 'Спасибо', intent: 'conversation', output: 'Пожалуйста!' },
    { input: 'Объясни cosine similarity в целом', intent: 'general', output: 'Это мера сходства направлений векторов.' },
    { input: 'Привет! Как работает worker в нашем проекте?', intent: 'documents', output: source.text },
    { input: 'А как он захватывает задачу?', intent: 'documents', output: source.text },
    { input: 'Напомни мою цель', intent: 'dialogue', output: 'Моя цель — проверить worker.' },
  ]
  let current = routes[0]
  let answerCalls = 0
  let verifyCalls = 0
  const client = { complete: async (messages: AgentMessage[]) => {
    if (messages[0].content.includes('Обнови компактную память')) {
      const data = JSON.parse(messages[messages.length - 1].content)
      assert.equal(data.input, current.input)
      assert.ok(messages[0].content.includes('Наличие старой цели НЕ превращает приветствие'))
      assert.ok(messages[0].content.includes('Приветствие плюс вопрос о проекте тоже documents'))
      return { content: patch(current.intent === 'documents' ? `Worker: ${current.input}` : current.input,
        current.input === routes[1].input ? [update('goal', 'goal', current.input)] : [], [], current.intent), promptTokens: 10, tokens: 5, totalTokens: 15 }
    }
    if (messages[0].content.includes('Проверь соответствие')) {
      verifyCalls++
      const data = JSON.parse(messages[messages.length - 1].content)
      return { content: JSON.stringify({ items: data.claims.map((claim: { claimId: number }) => ({ claimId: claim.claimId, supported: true, reason: 'Подтверждено.' })), taskCheck: { goalAligned: true, constraintsRespected: true, answersQuestion: true, reason: 'Проверено.' } }), promptTokens: 10, tokens: 5, totalTokens: 15 }
    }
    answerCalls++
    if (current.intent === 'conversation' || current.intent === 'general') {
      assert.ok(messages.some((message) => message.content.includes('поиск по документам не нужен и НЕ выполнялся')))
      assert.ok(!messages.some((message) => message.content.includes('Верни только JSON одного из двух')))
      return { content: current.output, promptTokens: 10, tokens: 5, totalTokens: 15 }
    }
    const chunkId = current.intent === 'dialogue' ? 'dialogue-user-2-goal-goal' : source.chunkId
    return { content: JSON.stringify({ status: 'answered', claims: [{ text: current.output, citations: [{ chunkId, quote: current.output }] }] }), promptTokens: 10, tokens: 5, totalTokens: 15 }
  } } as unknown as ConstructorParameters<typeof Agent>[2]
  const searches: string[] = []
  const retriever = { retrieve: async (question: string) => { searches.push(question); return context } } as unknown as RagRetriever
  const agent = new Agent('auto', config, client, undefined, undefined, retriever)
  const history: AgentMessage[] = []
  for (current of routes) {
    const answer = await agent.run(current.input, history)
    assert.equal(answer.retrieval?.route, current.intent)
    assert.equal(answer.retrieval?.searched, current.intent === 'documents')
    assert.equal(Boolean(answer.rag), current.intent === 'documents')
    if (current.intent === 'dialogue') assert.equal(answer.grounding?.citations[0].kind, 'dialogue')
    if (current.intent === 'general' || current.intent === 'conversation') {
      assert.equal(answer.output, current.output)
      assert.equal(answer.grounding, undefined)
      assert.equal(answer.totalTokens, 30)
    }
    if (history.length >= 2) assert.equal(answer.dialogueMemory?.goal?.text, routes[1].input)
    history.push({ role: 'user', content: current.input }, { role: 'assistant', content: answer.output, dialogueMemory: answer.dialogueMemory, grounding: answer.grounding ?? answer.rag?.grounding, retrieval: answer.retrieval })
  }
  assert.deepEqual(searches, [`Worker: ${routes[4].input}`, `Worker: ${routes[5].input}`])
  assert.equal(answerCalls, 7)
  assert.equal(verifyCalls, 4)
  assert.equal(latestDialogueMemory(history).turn, 7)
})

test('auto still abstains on weak project context, while always retains unconditional retrieval', async () => {
  let searches = 0
  let calls = 0
  const client = { complete: async () => {
    calls++
    return { content: patch('Как работает Redis нашего проекта?'), promptTokens: 10, tokens: 5, totalTokens: 15 }
  } } as unknown as ConstructorParameters<typeof Agent>[2]
  const retriever = { retrieve: async () => { searches++; return { ...context, sources: [] } } } as unknown as RagRetriever
  const answer = await new Agent('auto', config, client, undefined, undefined, retriever).run('Как работает Redis нашего проекта?')
  assert.equal(answer.retrieval?.searched, true)
  assert.equal(answer.rag?.grounding?.status, 'unknown')
  assert.ok(answer.output.includes('Не знаю'))
  assert.equal(calls, 1)
  const greetingClient = { complete: async () => ({ content: patch('Привет', [], [], 'conversation'), promptTokens: 10, tokens: 5, totalTokens: 15 }) } as unknown as ConstructorParameters<typeof Agent>[2]
  for (const retrievalPolicy of [undefined, 'always'] as const) {
    const strict = await new Agent('strict', { ...config, rag: { ...config.rag, retrievalPolicy } }, greetingClient, undefined, undefined, retriever).run('Привет')
    assert.equal(strict.retrieval?.policy, 'always')
    assert.equal(strict.retrieval?.searched, true)
    assert.equal(strict.rag?.grounding?.status, 'unknown')
  }
  assert.equal(searches, 3)
})

test('no-search metadata survives restart and streaming works even if the document retriever is unavailable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rag-chat-routing-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const filePath = join(directory, 'state.json')
  const client = { complete: async (messages: AgentMessage[]) => ({ content: messages[0].content.includes('Обнови компактную память') ? patch('', [], [], 'conversation') : 'Привет! Чем могу помочь?', promptTokens: 10, tokens: 5, totalTokens: 15 }) } as unknown as ConstructorParameters<typeof Agent>[2]
  const options = { defaultDeepSeekModel: 'test', stateStore: new AgentStateStore(filePath), client, ragRetriever: { retrieve: async () => { throw new Error('Ollama недоступен') } } as unknown as RagRetriever }
  const service = new AgentService(options)
  await service.create({ id: 'chat', config })
  const chunks: string[] = []
  const answer = await service.stream('chat', 'Привет', [], (chunk) => { chunks.push(chunk) }, 'one')
  assert.equal(answer.output, 'Привет! Чем могу помочь?')
  assert.deepEqual(chunks, [answer.output])
  assert.equal(answer.totalTokens, 30)
  const restored = new AgentService({ ...options, stateStore: new AgentStateStore(filePath) })
  const history = await restored.getHistory('chat', 'one')
  assert.equal(history.length, 2)
  assert.equal(history[1].retrieval?.route, 'conversation')
  assert.equal(history[1].retrieval?.searched, false)
  assert.equal(history[1].searchQuery, undefined)
  assert.equal(history[1].grounding, undefined)
  assert.equal(history[1].dialogueMemory?.turn, 1)
})

test('ordinary HTTP API restores isolated conversations, citations and memory after restart; stream persists only once', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rag-chat-api-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const filePath = join(directory, 'state.json')
  const options = { defaultDeepSeekModel: 'test', stateStore: new AgentStateStore(filePath), client: fakeClient(), ragRetriever: { retrieve: async () => context } as unknown as RagRetriever }
  const service = new AgentService(options)
  await service.create({ id: 'chat', config })
  const app = express(); app.use(express.json()); app.use('/api/agents', createAgentRouter(service))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api/agents/chat`
  const send = (input: string, conversationId: string) => fetch(`${base}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, conversationId, history: [{ role: 'user', content: 'Чужая цель' }] }) })
  assert.equal((await send(goalText, 'one')).status, 200)
  assert.equal((await send('Другая цель — изучить память.', 'two')).status, 200)
  const first = await (await fetch(`${base}/history?conversationId=one`)).json()
  assert.equal(first.count, 2)
  assert.equal(first.dialogueMemory.goal.text, goalText)
  assert.equal(first.messages[1].grounding.citations[0].quote, source.text)
  assert.equal((await (await fetch(`${base}/history`)).json()).count, 0)
  assert.equal((await fetch(`${base}/history?conversationId=bad%3Aid`)).status, 400)
  const stream = await fetch(`${base}/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'ВНУТРЕННЕЕ ПРОДОЛЖЕНИЕ: это обычное сообщение пользователя в RAG-чате.', conversationId: 'one' }) })
  assert.equal(stream.status, 200)
  assert.ok((await stream.text()).includes('Источники и цитаты'))
  assert.equal((await service.getHistory('chat', 'one')).length, 4)
  const restored = new AgentService({ ...options, stateStore: new AgentStateStore(filePath) })
  await restored.ready
  const messages = await restored.getHistory('chat', 'one')
  assert.equal(latestDialogueMemory(messages).goal?.text, goalText)
  assert.equal(messages[1].grounding?.citations[0].quote, source.text)
  assert.equal((await restored.listConversations('chat')).length, 2)
  await restored.clearHistory('chat', 'one')
  assert.equal((await restored.getHistory('chat', 'one')).length, 0)
  assert.equal((await restored.getHistory('chat', 'two')).length, 2)
})

test('overlapping requests to one dialogue are rejected without losing the first turn', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rag-chat-lock-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  let release!: () => void
  let started!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  const client = fakeClient(); const original = client.complete.bind(client)
  client.complete = async (...args) => { started(); await barrier; return original(...args) }
  const service = new AgentService({ defaultDeepSeekModel: 'test', stateStore: new AgentStateStore(join(directory, 'state.json')), client, ragRetriever: { retrieve: async () => context } as unknown as RagRetriever })
  await service.create({ id: 'chat', config })
  const first = service.run('chat', goalText, [], undefined, 'one')
  await entered
  await assert.rejects(service.run('chat', 'Параллельный вопрос', [], undefined, 'one'), /Дождитесь/)
  await assert.rejects(service.clearHistory('chat', 'one'), /Дождитесь/)
  await assert.rejects(service.clearAllHistory('chat'), /Дождитесь/)
  release(); await first
  assert.equal((await service.getHistory('chat', 'one')).length, 2)
})
