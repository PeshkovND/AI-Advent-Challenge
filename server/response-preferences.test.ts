import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyDialoguePatch, dialogueStateSchema, emptyDialogueMemory, prepareDialogue } from './dialogue-memory'
import { answerWithoutDocuments, renderClaims, replyInstruction, DialogueReplyConflict } from './response-preferences'
import { Agent, AgentService, AgentStateStore } from './agent-service'
import { answerWithGrounding, parseGroundedAnswer } from './rag-grounding'
import { ragChatAgentConfig } from '../src/rag-chat-config'
import type { RagCompletion, RagRetriever } from './rag-retrieval'
import type { AgentMessage } from './agent-service'

const usage = { inputTokens: 0, promptTokens: 10, completionTokens: 5, totalTokens: 15 }
const patch = (overrides: Record<string, unknown> = {}) => JSON.stringify({ intent: 'preferences', question: '', updates: [], forget: [], temporary: [], ...overrides })
const item = (key: string, quote: string, text = quote) => ({ category: 'constraints', key, text, quote })
const doc = { source: 'docs/day-21.md', title: 'RAG', section: 'Индекс', chunkId: 'doc', strategy: 'structured' as const, score: 0.9, text: 'Индекс хранится в файле data/rag-index.sqlite.' }
const valid = { constraintsRespected: true, appropriateToRoute: true, reason: 'Ответ соответствует текущему режиму и пожеланиям.' }

test('arbitrary wishes, keys, categories and legacy annotations do not form a semantic whitelist', () => {
  const input = 'Сначала метафора, затем диаграмма; избегай слова «очевидно»; поясняй для незрячего читателя.'
  const result = applyDialoguePatch(patch({ updates: [
    { ...item('answer_length', 'Сначала метафора, затем диаграмма'), preference: 'a-new-future-type', unknownAnnotation: 42 },
    { ...item('bannedWord', 'избегай слова «очевидно»'), category: 'style' },
    item('__proto__', 'поясняй для незрячего читателя'),
  ], preferenceBindings: [{ name: 'anything', value: { newKind: true } }] }), emptyDialogueMemory(), input)
  assert.equal(result.state.constraints.length, 3)
  assert.equal(result.state.constraints[0].key, 'answer_length')
  assert.equal(Object.prototype.hasOwnProperty.call(result.state.constraints[0], 'preference'), false)
  assert.equal(({} as Record<string, unknown>).newKind, undefined)
  const later = applyDialoguePatch(patch({ intent: 'general', question: 'Что такое RAG?' }), result.state, 'Что такое RAG?')
  assert.deepEqual(later.state.constraints, result.state.constraints)
})

test('more than twelve independent wishes survive without eviction', () => {
  const quotes = Array.from({ length: 30 }, (_, index) => `Пожелание ${index}: собственный стиль ${index}`)
  const result = applyDialoguePatch(patch({ updates: quotes.map((quote, index) => item(`custom-${index}`, quote)) }), emptyDialogueMemory(), quotes.join('\n'))
  assert.equal(result.state.constraints.length, 30)
  assert.equal(result.state.constraints[0].quote, quotes[0])
})

test('replacement and cancellation require the exact old record; unrelated wishes survive', () => {
  const first = applyDialoguePatch(patch({ updates: [item('brief', 'Отвечай кратко'), item('calendar', 'Календарь только для чтения')] }), emptyDialogueMemory(), 'Отвечай кратко. Календарь только для чтения.')
  assert.throws(() => applyDialoguePatch(patch({ updates: [item('brief', 'Максимум один пункт')] }), first.state, 'Максимум один пункт'), /Замена требует/)
  const second = applyDialoguePatch(patch({ updates: [item('count', 'Максимум один пункт')] }), first.state, 'Максимум один пункт')
  assert.deepEqual(second.state.constraints.slice(0, 2), first.state.constraints)
  const third = applyDialoguePatch(patch({ updates: [{ ...item('brief', 'Теперь подробно'), previousQuote: 'Отвечай кратко' }] }), second.state, 'Теперь подробно')
  assert.equal(third.state.constraints[0].text, 'Теперь подробно')
  assert.throws(() => applyDialoguePatch(patch({ forget: [{ category: 'constraints', key: 'calendar', quote: 'Отмени правило', previousQuote: 'Другая запись' }] }), third.state, 'Отмени правило'), /Отмена требует/)
  const cleared = applyDialoguePatch(patch({ forget: [{ category: 'constraints', key: 'count', quote: 'Отменяю лимит пунктов', previousQuote: 'Максимум один пункт' }] }), third.state, 'Отменяю лимит пунктов')
  assert.equal(cleared.state.constraints.length, 2)
  assert.ok(cleared.state.constraints.some((fact) => fact.key === 'calendar'))
  assert.equal(first.state.constraints[0].text, 'Отвечай кратко')
})

test('one-shot arbitrary instructions expire; forged quotes and conflicting duplicate operations cannot apply', () => {
  const first = applyDialoguePatch(patch({ updates: [item('layout', 'Всегда списком')] }), emptyDialogueMemory(), 'Всегда списком')
  const second = applyDialoguePatch(patch({ temporary: [{ key: 'layout', text: 'Только сейчас как диалог двух собеседников', quote: 'Только сейчас как диалог двух собеседников' }] }), first.state, 'Только сейчас как диалог двух собеседников')
  assert.equal(second.instructions.length, 1)
  assert.deepEqual(second.state.constraints, first.state.constraints)
  assert.deepEqual(applyDialoguePatch(patch(), second.state, 'Продолжай').instructions, [])
  assert.throws(() => applyDialoguePatch(patch({ temporary: [{ key: 'x', text: 'Условие', quote: 'Выдуманная цитата' }] }), first.state, 'Привет'), /дословной цитаты/)
  const repeated = item('a', 'Новое правило')
  assert.equal(applyDialoguePatch(patch({ updates: [repeated, repeated] }), first.state, 'Новое правило').state.constraints.length, 2)
  assert.throws(() => applyDialoguePatch(patch({ updates: [repeated, { ...repeated, text: 'Противоположное' }] }), first.state, 'Новое правило'), /противоречивые/)
})

test('unknown transport annotations and fenced JSON are tolerated; legacy snapshots keep original evidence', () => {
  const old = { ...emptyDialogueMemory(), turn: 1, constraints: [{ key: 'old', text: 'Кратко', quote: 'Кратко', userTurn: 1, preference: 'alien', future: true }] }
  const restored = dialogueStateSchema.parse(old)
  assert.equal(restored.constraints[0].quote, 'Кратко')
  const result = applyDialoguePatch(`\x60\x60\x60json\n${patch({ harmlessTransport: 'ok' })}\n\x60\x60\x60`, restored, 'Спасибо')
  assert.deepEqual(result.state.constraints, restored.constraints)
  assert.equal(applyDialoguePatch(patch({ updates: [item('short', 'Да')] }), emptyDialogueMemory(), 'Да').state.constraints[0].quote, 'Да')
})

test('memory replacement audit prevents semantic loss even with a syntactically valid old quote', async () => {
  const first = applyDialoguePatch(patch({ updates: [item('brief', 'Отвечай кратко')] }), emptyDialogueMemory(), 'Отвечай кратко')
  let calls = 0
  const complete: RagCompletion = async (messages) => {
    calls++
    if (calls === 1) return { content: patch({ updates: [{ ...item('brief', 'Максимум один пункт'), previousQuote: 'Отвечай кратко' }] }), usage }
    if (calls === 2) {
      assert.ok(messages[0].content.includes('Проверь изменение памяти'))
      return { content: JSON.stringify({ valid: false, reason: 'Число пунктов не отменяет краткость.' }), usage }
    }
    assert.ok(messages.some((message) => message.content.includes('Число пунктов не отменяет краткость')))
    return { content: patch({ updates: [item('count', 'Максимум один пункт')] }), usage }
  }
  const result = await prepareDialogue('Максимум один пункт', first.state, [], complete)
  assert.equal(result.state.constraints.length, 2)
  assert.equal(result.state.constraints[0].text, 'Отвечай кратко')
  assert.equal(result.usage.totalTokens, 45)
})

test('explicit conflict asks for a priority without applying ambiguous rules', () => {
  const result = applyDialoguePatch(patch({ intent: 'clarification', clarification: 'Что важнее: подробность или лимит двух слов?' }), emptyDialogueMemory(), 'Подробно, но ровно два слова')
  assert.equal(result.intent, 'clarification')
  assert.equal(result.state.constraints.length, 0)
  assert.ok(result.clarification?.includes('важнее'))
})

test('malformed memory degrades to clarification, preserves old rules and records a recovery pointer', async () => {
  const first = applyDialoguePatch(patch({ updates: [item('brief', 'Отвечай кратко')] }), emptyDialogueMemory(), 'Отвечай кратко')
  let calls = 0
  const result = await prepareDialogue('Запомни символ ⊕ для сложения', first.state, [], async () => { calls++; return { content: 'not json', usage } })
  assert.equal(calls, 2)
  assert.equal(result.intent, 'clarification')
  assert.equal(result.state.turn, 2)
  assert.deepEqual(result.state.pendingTurns, [2])
  assert.deepEqual(result.state.constraints, first.state.constraints)
  assert.equal(result.usage.totalTokens, 30)
})

test('pending recovery uses the original turn and cannot roll back a newer instruction', () => {
  const previous = { ...emptyDialogueMemory(), turn: 3, pendingTurns: [2], constraints: [{ key: 'language', text: 'Английский', quote: 'Теперь на английском', userTurn: 3 }] }
  const pending = [{ userTurn: 2, input: 'На русском. Термин ⊕ означает сложение.' }]
  const result = applyDialoguePatch(patch({ updates: [
    { ...item('language', 'На русском'), userTurn: 2, previousQuote: 'Теперь на английском' },
    { category: 'terms', key: 'sum', text: '⊕ — сложение', quote: 'Термин ⊕ означает сложение.', userTurn: 2 },
  ], resolvedPendingTurns: [2] }), previous, 'Восстанови последнее уточнение', pending)
  assert.equal(result.state.constraints[0].text, 'Английский')
  assert.equal(result.state.terms[0].userTurn, 2)
  assert.deepEqual(result.state.pendingTurns, [])
  assert.throws(() => applyDialoguePatch(patch({ resolvedPendingTurns: [99] }), previous, 'Продолжай', pending), /не было передано/)
})

test('resource overflow asks clarification without evicting an old goal', async () => {
  const previous = { ...emptyDialogueMemory(), turn: 1, goal: { key: 'goal', text: 'Демонстрация', quote: 'Подготовить демонстрацию', userTurn: 1 } }
  const raw = 'Добавь ещё пожелания'
  const oversized = patch({ updates: Array.from({ length: 30 }, (_, index) => item(`rule-${index}`, raw, 'Д'.repeat(3900))) })
  const result = await prepareDialogue(raw, previous, [], async () => ({ content: oversized, usage }))
  assert.equal(result.intent, 'clarification')
  assert.deepEqual(result.state.goal, previous.goal)
  assert.deepEqual(result.state.pendingTurns, [2])
})

test('pending recovery cannot resurrect a cancelled record; a new explicit wish can restore it', () => {
  const previous = { ...emptyDialogueMemory(), turn: 2, pendingTurns: [1], constraints: [{ key: 'analogy', text: 'Начинай с аналогии', quote: 'Начинай с аналогии', userTurn: 2 }] }
  const cancelled = applyDialoguePatch(patch({ forget: [{ category: 'constraints', key: 'analogy', quote: 'Отмени аналогию', previousQuote: 'Начинай с аналогии' }] }), previous, 'Отмени аналогию').state
  assert.equal(cancelled.constraints.length, 0)
  assert.equal(cancelled.removed?.[0].afterTurn, 3)
  const recovered = applyDialoguePatch(patch({ updates: [{ ...item('analogy', 'Начинай с аналогии'), userTurn: 1 }], resolvedPendingTurns: [1] }), cancelled, 'Восстанови старое сообщение', [{ userTurn: 1, input: 'Начинай с аналогии' }]).state
  assert.equal(recovered.constraints.length, 0)
  assert.deepEqual(recovered.removed, [])
  const restored = applyDialoguePatch(patch({ updates: [item('analogy', 'Снова начинай с аналогии')] }), cancelled, 'Снова начинай с аналогии').state
  assert.equal(restored.constraints[0].userTurn, 4)
  assert.deepEqual(restored.removed, [])
})

test('free-form layout retains numbering, tables, code fences and verified citation IDs', () => {
  assert.equal(renderClaims([{ id: 1, text: '1. Сначала пример', citationIds: [1] }, { id: 2, text: '2. Затем вывод', citationIds: [2] }]), '1. Сначала пример [1]\n\n2. Затем вывод [2]')
  const table = renderClaims([{ id: 1, text: '| Подход | Пример |\n| --- | --- |\n| RAG | Индекс |', citationIds: [1] }])
  assert.ok(table.endsWith('Индекс  [1] |'))
  assert.ok(renderClaims([{ id: 1, text: '```json\n{"name":"index"}\n```', citationIds: [1] }]).endsWith('```\n\n[1]'))
  assert.ok(replyInstruction([{ key: 'unusual', text: 'Пример до объяснения', quote: 'Пример до объяснения', userTurn: 1 }]).includes('Пример до объяснения'))
})

test('failed style checks repair once then return a checked clarification, not unknown or a JSON error', async () => {
  let answers = 0
  const completeText = async () => ({ content: ++answers < 3 ? 'Ответ не соблюдает просьбу.' : 'Что важнее: краткость или подробное объяснение?', usage })
  const verify: RagCompletion = async (messages) => ({ content: JSON.stringify(JSON.parse(messages[messages.length - 1].content).route === 'clarification' ? { ...valid, constraintsRespected: false } : { constraintsRespected: false, appropriateToRoute: true, reason: 'Несовместимые условия.' }), usage })
  const result = await answerWithoutDocuments([], 'Условия пользователя', [], 'general', completeText, verify)
  assert.equal(answers, 3)
  assert.equal(result.needsClarification, true)
  assert.ok(result.content.includes('важнее'))
  assert.equal(result.usage.totalTokens, 90)
  await assert.rejects(answerWithoutDocuments([], '', [], 'general', completeText, async () => ({ content: '{}', usage })))
})

test('invalid presentation-verifier JSON is retried once and never exposes a schema dump', async () => {
  let checks = 0
  const result = await answerWithoutDocuments([], '', [], 'preferences', async () => ({ content: 'Хорошо, учту.', usage }), async () => ({ content: ++checks === 1 ? '{}' : JSON.stringify(valid), usage }))
  assert.equal(checks, 2)
  assert.equal(result.content, 'Хорошо, учту.')
  assert.equal(result.usage.totalTokens, 45)
  await assert.rejects(answerWithoutDocuments([], '', [], 'preferences', async () => ({ content: 'Хорошо', usage }), async () => ({ content: '{}', usage })), /Не удалось надёжно проверить/)
})

test('ten grounded items are supported in dialogue; legacy budget and quote verification stay enforced', async () => {
  const claims = Array.from({ length: 10 }, (_, index) => ({ text: `${index + 1}. ${doc.text}`, citations: [{ chunkId: doc.chunkId, quote: doc.text }] }))
  const body = JSON.stringify({ status: 'answered', claims })
  assert.throws(() => parseGroundedAnswer(body, [doc]), /бюджет/)
  const complete: RagCompletion = async (_messages, stage) => ({ content: stage === 'answer' ? body : JSON.stringify({ items: claims.map((_, index) => ({ claimId: index + 1, supported: true, reason: 'Цитата точна.' })), taskCheck: { goalAligned: true, constraintsRespected: true, answersQuestion: true, reason: 'Десять пунктов.' } }), usage })
  const answer = await answerWithGrounding('Дай 10 пунктов', [], [doc], complete, undefined, { question: 'Дай 10 пунктов', instruction: '', sources: [], allowDialogueOnly: false })
  assert.equal(answer.claims.length, 10)
  assert.ok(answer.answer.includes('10.'))
})

test('focused presentation check rejects paragraphs mistaken for bullets by the factual verifier', async () => {
  let answers = 0
  const complete: RagCompletion = async (messages, stage) => {
    let content: string
    if (stage === 'answer') content = JSON.stringify({ status: 'answered', claims: [{ text: `${++answers === 1 ? '' : '- '}${doc.text}`, citations: [{ chunkId: doc.chunkId, quote: doc.text }] }] })
    else if (messages[0].content.includes('Проверь ТОЛЬКО реально')) {
      const data = JSON.parse(messages[1].content)
      assert.equal(data.claims, undefined)
      content = JSON.stringify({ constraintsRespected: data.displayedAnswer.startsWith('- '), reason: 'Проверены реальные маркеры Markdown.' })
    } else content = JSON.stringify({ items: [{ claimId: 1, supported: true, reason: 'Факт подтверждён.' }], taskCheck: { goalAligned: true, constraintsRespected: true, answersQuestion: true, reason: 'Проверено.' } })
    return { content, usage }
  }
  const result = await answerWithGrounding('Где индекс? Только сейчас маркированным списком', [], [doc], complete, undefined, { question: 'Где индекс?', instruction: '', sources: [], allowDialogueOnly: false, checkWishes: true })
  assert.equal(result.answer, `- ${doc.text} [1]`)
  assert.equal(result.verification.attempts, 2)
  assert.equal(result.usage.totalTokens, 90)
})

test('arbitrary wishes, failed extraction and recovery survive service restart without a partial fact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rag-chat-flexible-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const filePath = join(directory, 'state.json')
  const failedInput = 'Запомни обозначение ⊕ для сложения'
  const client = { complete: async (messages: AgentMessage[]) => {
    let content: string
    if (messages[0].content.includes('Обнови компактную память')) {
      const users = messages.filter((message) => message.role === 'user')
      const data = JSON.parse(users[users.length - 1].content)
      content = data.input === failedInput ? 'not json' : data.input === 'Да, сохрани это' ? patch({ updates: [{ category: 'terms', key: 'sum', text: '⊕ — сложение', quote: failedInput, userTurn: 2 }], resolvedPendingTurns: [2] }) : patch({ updates: [item('presentation', 'Начинай с аналогии')] })
    } else if (messages[0].content.includes('Проверь соблюдение')) content = JSON.stringify(valid)
    else content = messages.some((message) => message.content.includes('Нужно уточнение')) ? 'Что именно нужно запомнить?' : 'Хорошо, учту пожелание.'
    return { content, tokens: 5, promptTokens: 10, totalTokens: 15 }
  } } as unknown as ConstructorParameters<typeof Agent>[2]
  const options = { defaultDeepSeekModel: 'test', client, ragRetriever: { retrieve: async () => { throw new Error('Поиск не нужен') } } as unknown as RagRetriever }
  const service = new AgentService({ ...options, stateStore: new AgentStateStore(filePath) })
  await service.create({ id: 'chat', config: ragChatAgentConfig('index') })
  await service.run('chat', 'Начинай с аналогии', [], undefined, 'one')
  const failed = await service.run('chat', failedInput, [], undefined, 'one')
  assert.equal(failed.retrieval?.route, 'clarification')
  assert.deepEqual(failed.dialogueMemory?.pendingTurns, [2])
  const restored = new AgentService({ ...options, stateStore: new AgentStateStore(filePath) })
  const history = await restored.getHistory('chat', 'one')
  assert.equal(history.length, 4)
  assert.equal(history[2].content, failedInput)
  assert.equal(history[3].dialogueMemory?.constraints[0].text, 'Начинай с аналогии')
  const recovered = await restored.run('chat', 'Да, сохрани это', [], undefined, 'one')
  assert.equal(recovered.dialogueMemory?.terms[0].userTurn, 2)
  assert.deepEqual(recovered.dialogueMemory?.pendingTurns, [])
})

test('unsupported facts are not released when wishes conflict; the agent asks clarification', async () => {
  const client = { complete: async (messages: AgentMessage[]) => {
    let content: string
    if (messages[0].content.includes('Обнови компактную память')) content = patch({ intent: 'documents' })
    else if (messages[0].content.includes('Проверь соответствие')) content = JSON.stringify({ items: [{ claimId: 1, supported: true, reason: 'Факт верен.' }], taskCheck: { goalAligned: true, constraintsRespected: false, answersQuestion: true, reason: 'Несовместимые условия.' } })
    else if (messages[0].content.includes('Проверь соблюдение')) content = JSON.stringify(valid)
    else if (messages.some((message) => message.content.includes('Вместо фактического ответа'))) content = 'Что важнее: подробно или одно слово?'
    else content = JSON.stringify({ status: 'answered', claims: [{ text: doc.text, citations: [{ chunkId: doc.chunkId, quote: doc.text }] }] })
    return { content, tokens: 5, promptTokens: 10, totalTokens: 15 }
  } } as unknown as ConstructorParameters<typeof Agent>[2]
  const retriever = { retrieve: async () => ({ indexRunId: 'index', sources: [doc], instruction: doc.text }) } as unknown as RagRetriever
  const answer = await new Agent('chat', ragChatAgentConfig('index'), client, undefined, undefined, retriever).run('Где индекс? Подробно, но одно слово')
  assert.equal(answer.retrieval?.route, 'clarification')
  assert.equal(answer.rag?.grounding, undefined)
  assert.equal(answer.output, 'Что важнее: подробно или одно слово?')
  assert.equal(answer.totalTokens, 105)
  assert.ok(!(new DialogueReplyConflict('conflict', usage) instanceof SyntaxError))
})
