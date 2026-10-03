import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeRagConfig, Agent, createRagCompletion } from './agent-service'
import { RagRetriever, parseReranking, type RagCompletion } from './rag-retrieval'
import type { RagIndexRun, RagSearchResult } from './rag-indexer'
import type { RagConfig } from '../src/rag-types'

const run: RagIndexRun = { id: 'pinned', createdAt: '2026-10-03', model: 'embedding-test', embeddingProfile: 'plain', sourceCount: 1, chunkCount: 8, vectorDimensions: 1, strategies: ['structured'] }
const results: RagSearchResult[] = Array.from({ length: 8 }, (_, i) => ({ chunk: { source: 'doc.md', title: 'Doc', section: `Section ${i}`, chunk_id: `chunk-${i}`, strategy: 'structured', ordinal: i, characterCount: 20, text: i === 6 ? 'Прямой ответ: MCP receipt.' : `Сведения об общей теме ${i}.` }, score: 0.9 - i * 0.05 }))
const usage = { inputTokens: 2, promptTokens: 10, completionTokens: 5, totalTokens: 15 }
const config: RagConfig = { enabled: true, strategy: 'structured', candidateTopK: 8, topK: 4, indexRunId: run.id }

function fixture(lists = [results]) {
  let queries: string[] = [], closed = false, searches = 0
  const retriever = new RagRetriever({
    store: () => ({ latestRun: () => { throw new Error('must use pinned run') }, getRun: (id) => id === run.id ? run : undefined, search: (_vector, limit, strategy, id) => { assert.equal(id, run.id); assert.equal(strategy, 'structured'); return lists[searches++].slice(0, limit) }, close: () => { closed = true } }),
    embeddings: () => ({ embedQueries: async (input) => { queries = input; return input.map(() => [1]) } }),
  })
  return { retriever, queries: () => queries, closed: () => closed }
}
const rerank: RagCompletion = async (messages, stage) => {
  assert.equal(stage, 'rerank')
  const input = JSON.parse(messages[1].content)
  assert.equal(input.question, 'Исходный вопрос')
  return { content: JSON.stringify({ items: input.candidates.map((candidate: { chunkId: string }) => ({ chunkId: candidate.chunkId, relevance: candidate.chunkId === 'chunk-6' ? 3 : 1, reason: 'Оценка текста.' })) }), usage }
}

test('legacy retrieval keeps cosine ordering without auxiliary model calls', async () => {
  const f = fixture()
  const context = await f.retriever.retrieve('Исходный вопрос', { ...config, candidateTopK: undefined }, () => { throw new Error('LLM must not run') })
  assert.deepEqual(context.sources.map((source) => source.chunkId), ['chunk-0', 'chunk-1', 'chunk-2', 'chunk-3'])
  assert.equal(context.trace?.usage.totalTokens, 0)
  assert.ok(f.closed())
})
test('reranking promotes the seventh candidate, applies cutoff, never fills with rejected passages', async () => {
  const f = fixture()
  const context = await f.retriever.retrieve('Исходный вопрос', { ...config, rerank: { enabled: true, minRelevance: 2 } }, rerank)
  assert.deepEqual(context.sources.map((source) => source.chunkId), ['chunk-6'])
  assert.equal(context.trace?.candidates[6].rankBefore, 7)
  assert.equal(context.trace?.candidates[6].rankAfter, 1)
  assert.equal(context.trace?.candidates[0].rejection, 'relevance')
  assert.equal(context.trace?.usage.totalTokens, 15)
  assert.ok(context.instruction.includes('[1] doc.md'))
})
test('rewrite retains original retrieval, merges duplicate chunks and reranks against original question', async () => {
  const f = fixture([results, [...results].reverse()])
  const context = await f.retriever.retrieve('Исходный вопрос', { ...config, queryRewrite: true, rerank: { enabled: true, minRelevance: 2 } }, async (messages, stage) => stage === 'rewrite' ? { content: '{"query":"MCP receipt проверка"}', usage } : rerank(messages, stage))
  assert.deepEqual(f.queries(), ['Исходный вопрос', 'MCP receipt проверка'])
  assert.equal(context.trace?.candidates.length, 8)
  assert.equal(new Set(context.trace?.candidates.map((candidate) => candidate.chunkId)).size, 8)
  assert.equal(context.trace?.usage.totalTokens, 30)
  assert.equal(context.sources[0].chunkId, 'chunk-6')
})
test('all candidates below similarity threshold produce empty context and skip reranking', async () => {
  const f = fixture()
  const context = await f.retriever.retrieve('Исходный вопрос', { ...config, minSimilarity: 0.99, rerank: { enabled: true, minRelevance: 2 } }, () => { throw new Error('LLM must not run') })
  assert.equal(context.sources.length, 0)
  assert.equal(context.trace?.emptyContext, true)
  assert.equal(context.trace?.rerank.status, 'skipped')
  assert.ok(context.instruction.includes('подтверждения'))
})
test('invalid rewrite falls back explicitly, preserves usage, and still searches original question', async () => {
  const f = fixture()
  const context = await f.retriever.retrieve('Исходный вопрос', { ...config, queryRewrite: true }, async () => ({ content: '{"query":""}', usage }))
  assert.deepEqual(f.queries(), ['Исходный вопрос'])
  assert.equal(context.trace?.rewrite.status, 'fallback')
  assert.ok(context.trace?.rewrite.warning)
  assert.equal(context.trace?.usage.totalTokens, 15)
})
test('incomplete reranking retries only missing IDs, preserves grades and counts both calls', async () => {
  const f = fixture()
  let calls = 0
  const context = await f.retriever.retrieve('Исходный вопрос', { ...config, rerank: { enabled: true, minRelevance: 2 } }, async (messages, stage) => {
    const input = JSON.parse(messages[1].content)
    calls++
    assert.equal(input.expectedCount, input.candidates.length)
    if (calls === 1) {
      const response = await rerank(messages, stage)
      const parsed = JSON.parse(response.content)
      return { ...response, content: JSON.stringify({ items: parsed.items.slice(0, 6) }) }
    }
    assert.deepEqual(input.candidates.map((item: { chunkId: string }) => item.chunkId), ['chunk-6', 'chunk-7'])
    assert.ok(input.correction)
    return rerank(messages, stage)
  })
  assert.equal(calls, 2)
  assert.deepEqual(context.sources.map((source) => source.chunkId), ['chunk-6'])
  assert.equal(context.trace?.candidates.filter((candidate) => candidate.relevance !== undefined).length, 8)
  assert.equal(context.trace?.rerank.attempts, 2)
  assert.ok(context.trace?.rerank.warning?.includes('6 из 8'))
  assert.equal(context.trace?.usage.totalTokens, 30)
  assert.ok(f.closed())
})
test('invalid JSON, duplicate IDs, unknown IDs and invalid grades are retried without trusting the malformed batch', async () => {
  for (const invalid of ['not JSON', '{"items":[]}', JSON.stringify({ items: [
    { chunkId: 'chunk-0', relevance: 3, reason: 'x' }, { chunkId: 'chunk-0', relevance: 3, reason: 'x' },
  ] }), ...[{ chunkId: 'invented', relevance: 3, reason: 'x' }, { chunkId: 'chunk-0', relevance: 9, reason: 'x' }, { chunkId: 'chunk-0', relevance: 3, reason: '' }].map((item) => JSON.stringify({ items: [item] }))]) {
    const f = fixture()
    let calls = 0
    const context = await f.retriever.retrieve('Исходный вопрос', { ...config, rerank: { enabled: true, minRelevance: 2 } }, async (messages, stage) => {
      if (++calls === 1) return { content: invalid, usage }
      assert.equal(JSON.parse(messages[1].content).candidates.length, 8)
      return rerank(messages, stage)
    })
    assert.equal(calls, 2)
    assert.deepEqual(context.sources.map((source) => source.chunkId), ['chunk-6'])
    assert.equal(context.trace?.usage.totalTokens, 30)
  }
})
test('global top-K and relevance cutoff are applied after combining repaired reranking grades', async () => {
  const f = fixture()
  let calls = 0
  const context = await f.retriever.retrieve('Q', { ...config, topK: 2, rerank: { enabled: true, minRelevance: 2 } }, async (messages) => {
    const input = JSON.parse(messages[1].content)
    const items = input.candidates.map((candidate: { chunkId: string }) => ({ chunkId: candidate.chunkId, relevance: candidate.chunkId === 'chunk-6' ? 3 : candidate.chunkId === 'chunk-7' ? 0 : 2, reason: 'x' }))
    return { content: JSON.stringify({ items: ++calls === 1 ? items.slice(0, 6) : items }), usage }
  })
  assert.deepEqual(context.sources.map((source) => source.chunkId), ['chunk-6', 'chunk-0'])
  assert.equal(context.trace?.candidates[7].rejection, 'relevance')
  assert.equal(context.trace?.candidates[1].rejection, 'top-k')
})
test('cancellation after an incomplete response prevents the repair call', async () => {
  const f = fixture(), controller = new AbortController()
  let calls = 0
  await assert.rejects(() => f.retriever.retrieve('Q', { ...config, rerank: { enabled: true, minRelevance: 2 } }, async () => {
    calls++; controller.abort(); return { content: '{"items":[]}', usage }
  }, controller.signal))
  assert.equal(calls, 1)
  assert.ok(f.closed())
})
test('malformed reranking fails visibly and always closes index', async () => {
  const f = fixture()
  let calls = 0
  await assert.rejects(() => f.retriever.retrieve('Исходный вопрос', { ...config, rerank: { enabled: true, minRelevance: 2 } }, async () => { calls++; return { content: '{"items":[]}', usage } }), /после двух попыток: оценено 0 из 8/)
  assert.equal(calls, 2)
  assert.ok(f.closed())
  const candidate = { ...results[0].chunk, source: 'doc', chunkId: 'known', score: 0.5, selected: false, rankBefore: 1 }
  for (const item of [{ chunkId: 'invented', relevance: 3, reason: 'x' }, { chunkId: 'known', relevance: 9, reason: 'x' }, { chunkId: 'known', relevance: 2.5, reason: 'x' }]) {
    assert.throws(() => parseReranking(JSON.stringify({ items: [item] }), [candidate]))
  }
})
test('diagnostics, reranking and answering use the same bounded passage text', async () => {
  const long = { ...results[0], chunk: { ...results[0].chunk, text: 'a'.repeat(3_600) + 'HIDDEN ANSWER' } }
  const f = fixture([[long]])
  const context = await f.retriever.retrieve('Исходный вопрос', config)
  assert.equal(context.sources[0].text.length, 3_600)
  assert.ok(!context.instruction.includes('HIDDEN ANSWER'))
})
test('config normalization preserves old defaults and validates new ranges', () => {
  assert.deepEqual(normalizeRagConfig({ enabled: true, strategy: 'fixed', topK: 4 }), { enabled: true, strategy: 'fixed', topK: 4 })
  assert.equal(normalizeRagConfig({ ...config, queryRewrite: true, rerank: { enabled: true } })?.rerank?.minRelevance, 2)
  for (const invalid of [{ candidateTopK: 2 }, { candidateTopK: 31 }, { candidateTopK: 4.5 }, { minSimilarity: 1.1 }, { rerank: { enabled: true, minRelevance: 4 } }]) assert.throws(() => normalizeRagConfig({ ...config, ...invalid }))
})
test('agent run and stream count auxiliary usage and keep original input as final message', async () => {
  for (const streaming of [false, true]) {
    const f = fixture([results, results])
    const client = {
      complete: async (messages: Array<{ content: string }>, options: { format?: string }) => {
        if (options.format === 'json') return { content: messages[0].content.includes('Перепиши') ? '{"query":"MCP receipt"}' : JSON.stringify({ items: results.map(({ chunk }) => ({ chunkId: chunk.chunk_id, relevance: 3, reason: 'Прямой ответ.' })) }), tokens: 5, promptTokens: 10, totalTokens: 15 }
        assert.equal(messages[messages.length - 1]?.content, 'Исходный вопрос')
        return { content: 'Ответ.', tokens: 5, promptTokens: 10, totalTokens: 15 }
      },
      stream: async (messages: Array<{ content: string }>, _options: unknown, onChunk: (value: string) => void) => {
        assert.equal(messages[messages.length - 1]?.content, 'Исходный вопрос'); onChunk('Ответ.'); return { tokens: 5, promptTokens: 10, totalTokens: 15 }
      },
    } as unknown as ConstructorParameters<typeof Agent>[2]
    const agent = new Agent('test', { provider: 'deepseek', model: 'test-model', rag: { ...config, queryRewrite: true, rerank: { enabled: true, minRelevance: 2 } } }, client, undefined, undefined, f.retriever)
    const answer = streaming ? await agent.stream('Исходный вопрос', [], () => {}) : await agent.run('Исходный вопрос')
    assert.equal(answer.totalTokens, 45)
    assert.equal(answer.rag?.trace?.usage.totalTokens, 30)
    assert.equal(answer.input, 'Исходный вопрос')
  }
})
test('cancelled retrieval does not call rewrite or open index', async () => {
  const f = fixture()
  await assert.rejects(() => f.retriever.retrieve('Question', { ...config, queryRewrite: true }, rerank, AbortSignal.abort()))
})
test('auxiliary completions use agent provider, JSON format and a separate output budget', async () => {
  const complete = createRagCompletion({ complete: async (_messages, options, signal) => {
    assert.equal(options.provider, 'openrouter'); assert.equal(options.model, 'selected-model'); assert.equal(options.format, 'json'); assert.equal(options.maxTokens, 400); assert.ok(signal)
    return { content: '{"query":"Q"}', tokens: 2, promptTokens: 8, totalTokens: 10 }
  } }, { provider: 'openrouter', model: 'selected-model' })
  assert.equal((await complete([{ role: 'user', content: 'Q' }], 'rewrite')).usage.totalTokens, 10)
})
