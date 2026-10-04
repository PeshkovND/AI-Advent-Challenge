import assert from 'node:assert/strict'
import test from 'node:test'
import { Agent, normalizeRagConfig } from './agent-service'
import { answerWithGrounding, parseGroundedAnswer, parseGroundingJudgments, renderGroundedAnswer } from './rag-grounding'
import { RagRetriever } from './rag-retrieval'
import type { RagSource, RagUsage } from '../src/rag-types'

const source: RagSource = { source: 'docs/day-18.md', title: 'Day 18', section: 'После сна', chunkId: 'known', strategy: 'structured', score: 0.8, text: 'Выполняется одна просроченная проверка. Все пропущенные интервалы подряд не воспроизводятся.' }
const question = 'Что происходит после сна?'
const messages = [{ role: 'user' as const, content: question }]
const usage: RagUsage = { inputTokens: 0, promptTokens: 10, completionTokens: 5, totalTokens: 15 }
const claimText = 'После сна выполняется одна просроченная проверка.'
const payload = (text = claimText, quote = 'Выполняется одна просроченная проверка.', chunkId = source.chunkId) => JSON.stringify({ status: 'answered', claims: [{ text, citations: [{ chunkId, quote }] }] })
const verdict = (supported = true) => JSON.stringify({ items: [{ claimId: 1, supported, reason: supported ? 'Следует из цитаты.' : 'Количество запусков противоречит цитате.' }] })
const config = { provider: 'deepseek' as const, model: 'test-model', rag: { enabled: true, strategy: 'structured' as const, topK: 4, rerank: { enabled: true, minRelevance: 2 }, grounding: { enabled: true } } }

test('literal citations resolve canonical metadata and every claim has a citation', () => {
  const parsed = parseGroundedAnswer(payload(), [source])
  assert.equal(parsed.status, 'answered')
  if (parsed.status !== 'answered') throw new Error('Expected answer')
  assert.deepEqual(parsed.claims[0].citationIds, [1])
  assert.deepEqual(parsed.citations[0], { id: 1, source: source.source, section: source.section, chunkId: 'known', quote: 'Выполняется одна просроченная проверка.' })
})
test('fabricated sources, non-literal quotes, uncited claims and an unchecked free answer are rejected', () => {
  for (const invalid of [payload(claimText, source.text, 'invented'), payload(`${claimText} [999]`), payload(claimText, 'Выполняются все просроченные проверки.'), payload(claimText, 'Выполняется одна ... проверка.'),
    '{"status":"answered","claims":[{"text":"Факт","citations":[]}]}',
    JSON.stringify({ ...JSON.parse(payload()), answer: 'Непроверенное дополнение' }),
    JSON.stringify({ ...JSON.parse(payload()), claims: [{ text: claimText, citations: [{ chunkId: 'known', quote: source.text, source: 'fake.md' }] }] }),
    '{"status":"unknown","claims":[]}', 'not json']) {
    assert.throws(() => parseGroundedAnswer(invalid, [source]))
  }
})
test('quotation deduplication keeps canonical references on each claim', () => {
  const parsed = parseGroundedAnswer(JSON.stringify({ status: 'answered', claims: [JSON.parse(payload()).claims[0], JSON.parse(payload()).claims[0]] }), [source])
  assert.equal(parsed.status, 'answered')
  if (parsed.status === 'answered') { assert.equal(parsed.citations.length, 1); assert.deepEqual(parsed.claims.map((claim) => claim.citationIds), [[1], [1]]) }
})
test('semantic verifier must return every claim ID once with a boolean verdict', () => {
  const claims = [{ id: 1, text: claimText, citationIds: [1] }]
  assert.equal(parseGroundingJudgments(verdict(), claims)[0].supported, true)
  for (const content of ['{"items":[]}', '{"items":[{"claimId":2,"supported":true,"reason":"x"}]}', '{"items":[{"claimId":1,"supported":"true","reason":"x"}]}',
    '{"items":[{"claimId":1,"supported":true,"reason":"x"},{"claimId":1,"supported":true,"reason":"x"}]}']) assert.throws(() => parseGroundingJudgments(content, claims))
})
test('weak context bypasses generation and returns explicit unknown with clarification and empty evidence', async () => {
  const answer = await answerWithGrounding(question, messages, [], () => { throw new Error('LLM must not run') })
  assert.equal(answer.reason, 'weak-context')
  assert.equal(answer.status, 'unknown')
  assert.deepEqual(answer.sources, [])
  assert.deepEqual(answer.citations, [])
  assert.ok(renderGroundedAnswer(answer).includes('Не знаю'))
  assert.ok(renderGroundedAnswer(answer).includes('Уточните'))
  assert.equal(answer.usage.totalTokens, 0)
})
test('confirmed answer is derived solely from checked claims and contains exact quotes and metadata', async () => {
  const calls: string[] = []
  const answer = await answerWithGrounding(question, messages, [source], async (input, stage) => {
    calls.push(stage)
    if (stage === 'answer') {
      assert.equal(input[input.length - 1]?.content, question)
      return { content: payload(), usage }
    }
    const data = JSON.parse(input[1].content)
    assert.equal(data.claims[0].citations[0].quote, 'Выполняется одна просроченная проверка.')
    return { content: verdict(), usage }
  })
  assert.deepEqual(calls, ['answer', 'verify'])
  assert.equal(answer.verification.status, 'passed')
  assert.equal(answer.usage.totalTokens, 30)
  assert.ok(renderGroundedAnswer(answer).includes(source.section))
  assert.ok(renderGroundedAnswer(answer).includes('chunk_id: `known`'))
  assert.ok(renderGroundedAnswer(answer).includes('> Выполняется одна просроченная проверка.'))
})
test('non-literal initial citation is repaired once without verifying invalid claims', async () => {
  let generations = 0, checks = 0
  const answer = await answerWithGrounding(question, messages, [source], async (_input, stage) => {
    if (stage === 'answer') return { content: ++generations === 1 ? payload(claimText, 'Выдуманная цитата, которой нет.') : payload(), usage }
    checks++; return { content: verdict(), usage }
  })
  assert.equal(generations, 2); assert.equal(checks, 1)
  assert.equal(answer.status, 'answered'); assert.equal(answer.usage.totalTokens, 45)
})
test('unsupported claims are repaired and rechecked before release', async () => {
  let checks = 0, generations = 0
  const answer = await answerWithGrounding(question, messages, [source], async (_input, stage) => {
    if (stage === 'answer') return { content: ++generations === 1 ? payload('Выполняются все пропущенные запуски.') : payload(), usage }
    return { content: verdict(++checks === 2), usage }
  })
  assert.equal(answer.status, 'answered')
  assert.equal(answer.answer, `${claimText} [1]`)
  assert.equal(answer.verification.attempts, 2)
  assert.equal(answer.usage.totalTokens, 60)
})
test('persistent contradiction yields unknown instead of fabricated facts or quotes', async () => {
  const answer = await answerWithGrounding(question, messages, [source], async (_input, stage) => ({ content: stage === 'answer' ? payload('Выполняются все пропущенные запуски.') : verdict(false), usage }))
  assert.equal(answer.reason, 'unsupported-answer'); assert.equal(answer.status, 'unknown')
  assert.equal(answer.verification.status, 'abstained'); assert.equal(answer.usage.totalTokens, 60)
  assert.deepEqual(answer.citations, [])
  assert.ok(!renderGroundedAnswer(answer).includes('Выполняются все'))
})
test('model can abstain when available passages do not substantiate the answer', async () => {
  const answer = await answerWithGrounding(question, messages, [source], async (_input, stage) => {
    assert.equal(stage, 'answer'); return { content: '{"status":"unknown"}', usage }
  })
  assert.equal(answer.reason, 'insufficient-evidence'); assert.equal(answer.usage.totalTokens, 15)
})
test('malformed JSON after two attempts and invalid verifier responses stay technical errors', async () => {
  let calls = 0
  await assert.rejects(() => answerWithGrounding(question, messages, [source], async () => { calls++; return { content: '{}', usage } }), /после двух попыток/)
  assert.equal(calls, 2)
  await assert.rejects(() => answerWithGrounding(question, messages, [source], async (_input, stage) => ({ content: stage === 'answer' ? payload() : '{"items":[]}', usage })), /каждое утверждение/)
})
test('cancellation stops generation or semantic verification', async () => {
  await assert.rejects(() => answerWithGrounding(question, messages, [source], () => { throw new Error('must not run') }, AbortSignal.abort()))
  const controller = new AbortController()
  await assert.rejects(() => answerWithGrounding(question, messages, [source], async () => { controller.abort(); return { content: payload(), usage } }, controller.signal))
})
test('grounded ordinary run and stream buffer verification, preserve input and account for all usage', async () => {
  for (const stream of [false, true]) {
    let checks = 0, output = ''
    const retriever = { retrieve: async () => ({ indexRunId: 'pinned', sources: [source], instruction: source.text }) } as unknown as RagRetriever
    const client = { complete: async (input: Array<{ content: string }>, options: { format?: string }) => {
      assert.equal(options.format, 'json')
      const verify = input[0].content.includes('Проверь соответствие')
      if (verify) checks++
      return { content: verify ? verdict() : payload(), tokens: 5, promptTokens: 10, totalTokens: 15 }
    }, stream: () => { throw new Error('unverified stream must not run') } } as unknown as ConstructorParameters<typeof Agent>[2]
    const agent = new Agent('grounded', config, client, undefined, undefined, retriever)
    const result = stream ? await agent.stream(question, [], (part) => { assert.equal(checks, 1); output += part }) : await agent.run(question)
    assert.equal(result.input, question); assert.equal(result.rag?.grounding?.status, 'answered'); assert.equal(result.totalTokens, 30)
    assert.ok(result.output.includes('Источники и цитаты'))
    if (stream) assert.equal(output, result.output)
  }
})
test('grounded JSON output keeps the complete contract and character limit never truncates citations', async () => {
  const retriever = { retrieve: async () => ({ indexRunId: 'pinned', sources: [source], instruction: source.text }) } as unknown as RagRetriever
  const client = { complete: async (input: Array<{ content: string }>) => ({ content: input[0].content.includes('Проверь соответствие') ? verdict() : payload(), tokens: 5, promptTokens: 10, totalTokens: 15 }) } as unknown as ConstructorParameters<typeof Agent>[2]
  const result = await new Agent('json', { ...config, outputPolicy: { format: 'json' } }, client, undefined, undefined, retriever).run(question)
  assert.equal(JSON.parse(result.output).citations[0].chunkId, 'known')
  await assert.rejects(() => new Agent('short', { ...config, outputPolicy: { maxCharacters: 10 } }, client, undefined, undefined, retriever).run(question), /Лимит ответа/)
})
test('grounding config is opt-in, independent of reranking and rejects incompatible runtime contracts', () => {
  assert.equal(normalizeRagConfig(config.rag)?.grounding?.enabled, true)
  assert.equal(normalizeRagConfig({ ...config.rag, grounding: { enabled: false } })?.grounding, undefined)
  const client = {} as ConstructorParameters<typeof Agent>[2]
  assert.doesNotThrow(() => new Agent('basic', { ...config, rag: { ...config.rag, rerank: undefined } }, client))
  assert.throws(() => new Agent('task', { ...config, taskMachine: true }, client), /не совмещается/)
  assert.throws(() => new Agent('mcp', { ...config, mcp: { enabled: true, servers: ['test'] } }, client), /не совмещается/)
  assert.throws(() => new Agent('stop', { ...config, outputPolicy: { stopSequences: ['END'] } }, client), /Stop/)
})

test('both basic chunking strategies use normal top-K retrieval and return verified literal citations', async () => {
  for (const strategy of ['fixed', 'structured'] as const) {
    let calls = 0
    const retriever = new RagRetriever({
      store: () => ({ latestRun: () => ({ id: 'test', createdAt: '', model: 'test', embeddingProfile: 'plain', sourceCount: 1, chunkCount: 1, vectorDimensions: 1, strategies: [strategy] }),
        getRun: () => undefined, search: (_vector, topK, requestedStrategy) => {
          assert.equal(topK, 4); assert.equal(requestedStrategy, strategy)
          return [{ score: 0.4, chunk: { source: source.source, title: source.title, section: source.section, chunk_id: 'known', strategy, ordinal: 0, characterCount: source.text.length, text: source.text } }]
        }, close: () => {} }),
      embeddings: () => ({ embedQueries: async (queries) => { assert.deepEqual(queries, [question]); return [[1]] } }),
    })
    const client = { complete: async (input: Array<{ content: string }>) => {
      calls++
      const verify = input[0].content.includes('Проверь соответствие')
      assert.ok(verify || input.some((message) => message.content.includes('Верни только JSON одного из двух видов')))
      return { content: verify ? verdict() : payload(), tokens: 5, promptTokens: 10, totalTokens: 15 }
    } } as unknown as ConstructorParameters<typeof Agent>[2]
    const result = await new Agent(strategy, { ...config, rag: { enabled: true, strategy, topK: 4, grounding: { enabled: true } } }, client, undefined, undefined, retriever).run(question)
    assert.equal(calls, 2)
    assert.equal(result.rag?.trace?.rerank.status, 'disabled')
    assert.equal(result.rag?.trace?.rewrite.status, 'disabled')
    assert.equal(result.rag?.grounding?.status, 'answered')
    assert.equal(result.rag?.grounding?.citations[0].quote, 'Выполняется одна просроченная проверка.')
    assert.ok(result.output.includes('Источники и цитаты'))
    assert.equal(result.totalTokens, 30)
  }
})

test('ordinary agent refuses context rejected by cosine or relevance cutoff without generation calls', async () => {
  for (const cutoff of ['cosine', 'rerank']) {
    let calls = 0
    const retriever = new RagRetriever({
      store: () => ({ latestRun: () => ({ id: 'test', createdAt: '', model: 'test', embeddingProfile: 'plain', sourceCount: 1, chunkCount: 1, vectorDimensions: 1, strategies: ['structured'] }),
        getRun: () => undefined, search: () => [{ score: 0.4, chunk: { source: source.source, title: source.title, section: source.section, chunk_id: 'known', strategy: 'structured', ordinal: 0, characterCount: source.text.length, text: source.text } }], close: () => {} }),
      embeddings: () => ({ embedQueries: async () => [[1]] }),
    })
    const client = { complete: async (input: Array<{ content: string }>) => {
      calls++
      assert.ok(input[0].content.includes('Ты оцениваешь фрагменты'))
      return { content: JSON.stringify({ items: [{ chunkId: 'known', relevance: 1, reason: 'Только общая тема.' }] }), tokens: 5, promptTokens: 10, totalTokens: 15 }
    } } as unknown as ConstructorParameters<typeof Agent>[2]
    const rag = cutoff === 'cosine' ? { ...config.rag, minSimilarity: 0.5 } : config.rag
    const result = await new Agent(cutoff, { ...config, rag }, client, undefined, undefined, retriever).run(question)
    assert.equal(result.rag?.grounding?.reason, 'weak-context')
    assert.deepEqual(result.rag?.sources, [])
    assert.equal(result.rag?.trace?.emptyContext, true)
    assert.equal(calls, cutoff === 'cosine' ? 0 : 1)
    assert.equal(result.totalTokens, calls * 15)
    assert.ok(result.output.includes('Уточните'))
  }
})
