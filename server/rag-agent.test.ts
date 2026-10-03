import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, AgentStateStore } from './agent-service'
import type { RagRetriever } from './rag-retrieval'

const source = { source: 'docs/day-18.md', title: 'День 18', section: 'Хранение и worker', chunkId: 'structured-test', strategy: 'structured' as const, score: 0.82, text: 'Worker использует BEGIN IMMEDIATE.' }
const context = { indexRunId: 'test-index', sources: [source], instruction: 'Источник [1]: Worker использует BEGIN IMMEDIATE.' }

test('ordinary agent run adds RAG context but preserves original input', async () => {
  let retrievals = 0
  let sentMessages: Array<{ role: string; content: string }> = []
  const retriever = { retrieve: async (question: string) => { assert.equal(question, 'Как работает worker?'); retrievals += 1; return context } } as unknown as RagRetriever
  const client = { complete: async (messages: typeof sentMessages) => { sentMessages = messages; return { content: 'Через BEGIN IMMEDIATE [1].', promptTokens: 30, tokens: 8, totalTokens: 38 } } } as unknown as ConstructorParameters<typeof Agent>[2]
  const agent = new Agent('rag-test', { provider: 'deepseek', model: 'test-model', rag: { enabled: true, strategy: 'structured', topK: 4 } }, client, undefined, undefined, retriever)
  const result = await agent.run('Как работает worker?')
  assert.equal(retrievals, 1)
  assert.equal(result.input, 'Как работает worker?')
  assert.equal(result.rag?.sources[0].source, 'docs/day-18.md')
  assert.equal(sentMessages[sentMessages.length - 1]?.content, 'Как работает worker?')
  assert.ok(sentMessages.some((message) => message.role === 'system' && message.content.includes('Источник [1]')))
})

test('ordinary agent stream uses the same RAG configuration', async () => {
  let sentMessages: Array<{ role: string; content: string }> = []
  const retriever = { retrieve: async () => context } as unknown as RagRetriever
  const client = { stream: async (messages: typeof sentMessages, _options: unknown, onChunk: (value: string) => void) => { sentMessages = messages; onChunk('Ответ [1].'); return { tokens: 4, promptTokens: 20, totalTokens: 24 } } } as unknown as ConstructorParameters<typeof Agent>[2]
  const agent = new Agent('rag-stream-test', { provider: 'deepseek', model: 'test-model', rag: { enabled: true, strategy: 'structured', topK: 4 } }, client, undefined, undefined, retriever)
  let output = ''
  const result = await agent.stream('Вопрос', [], (part) => { output += part })
  assert.equal(output, 'Ответ [1].')
  assert.equal(result.rag?.indexRunId, 'test-index')
  assert.ok(sentMessages.some((message) => message.content.includes('Источник [1]')))
})

test('agent with RAG disabled does not retrieve documents', async () => {
  const retriever = { retrieve: async () => { throw new Error('retrieval must not run') } } as unknown as RagRetriever
  const client = { complete: async () => ({ content: 'Ответ без документов.', tokens: 4, promptTokens: 10, totalTokens: 14 }) } as unknown as ConstructorParameters<typeof Agent>[2]
  const agent = new Agent('plain-test', { provider: 'deepseek', model: 'test-model' }, client, undefined, undefined, retriever)
  const result = await agent.run('Вопрос')
  assert.equal(result.output, 'Ответ без документов.')
  assert.equal(result.rag, undefined)
})

test('clearing an agent removes every conversation scope but keeps other agents', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rag-agent-clear-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const filePath = join(directory, 'agent-state.json')
  const store = new AgentStateStore(filePath)
  const message = { role: 'user' as const, content: 'Вопрос' }
  await store.appendHistory('day22-with-rag', [message])
  await store.appendHistory('day22-with-rag::conversation::one', [message])
  await store.appendHistory('day22-with-rag::conversation::two', [message])
  await store.appendHistory('day22-without-rag::conversation::one', [message])
  await store.addConversationTokens('day22-with-rag::conversation::one', { inputTokens: 1, promptTokens: 2, completionTokens: 3, totalTokens: 5 })

  assert.equal(await store.clearAllHistory('day22-with-rag'), 3)
  const restored = new AgentStateStore(filePath)
  assert.deepEqual(await restored.getHistory('day22-with-rag'), [])
  assert.deepEqual(await restored.getHistory('day22-with-rag::conversation::one'), [])
  assert.deepEqual(await restored.getHistory('day22-with-rag::conversation::two'), [])
  assert.equal(await restored.getConversationTokens('day22-with-rag::conversation::one'), 0)
  assert.deepEqual(await restored.getHistory('day22-without-rag::conversation::one'), [message])
})
