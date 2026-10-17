import test from 'node:test'
import assert from 'node:assert/strict'
import { compareLocalRag, localRagSettings, modelClient } from './local-rag-service'
import { demoQuestions, demoModes, demoAgentConfig } from '../src/rag-demo-config'
import { ragQuestions } from '../src/rag-questions'
import { speedSummary } from '../src/local-rag-types'
import type { RagSource } from '../src/rag-types'

const source: RagSource = { source: 'doc.md', title: 'Doc', section: 'Search', chunkId: 'id-1', strategy: 'structured', score: 1, text: 'Search runs locally in SQLite.' }
const retrieve = { retrieve: async () => ({ indexRunId: 'existing-index', sources: [source], instruction: source.text }) }
function generation(prompt: string) {
  return prompt.includes('Проверь соответствие') ? JSON.stringify({ items: { '1': { supported: true, reason: 'Supported by quote.' } } }) : JSON.stringify({ status: 'answered', claims: [{ text: 'Search runs locally.', evidenceIds: ['e1'] }] })
}
const mock = (async (_url, init) => Response.json({ message: { content: generation(String(init?.body)) }, eval_count: 10, prompt_eval_count: 20, eval_duration: 1e9 })) as typeof fetch

test('comparison uses the unchanged 11 RAG questions and four modes', () => {
  assert.equal(demoQuestions.length, 11)
  assert.deepEqual(demoQuestions.slice(0, 10), ragQuestions)
  assert.deepEqual(demoModes, ['without', 'structured', 'fixed', 'improved'])
})
test('local grounded mode uses loopback, the original prompt and literal citations', async () => {
  const urls: string[] = []
  const result = await compareLocalRag('How does search run?', false, 'structured', 'existing-index', undefined, {
    retriever: retrieve, fetch: (async (url, init) => {
      urls.push(String(url)); assert.ok(String(url).startsWith('http://127.0.0.1:'))
      const body = JSON.parse(String(init?.body)); assert.equal(body.think, false); if (JSON.stringify(body.messages).includes('Каталог доказательств:')) { assert.ok(body.format.anyOf); assert.deepEqual(body.format.anyOf[0].properties.claims.items.properties.evidenceIds.items.enum, ['e1']) }
      else {
        assert.deepEqual(body.format.properties.items.required, ['1'])
        assert.equal(body.format.properties.items.properties['1'].additionalProperties, false)
      }
      return mock(url, init)
    }) as typeof fetch,
  })
  assert.equal(result.cloud, undefined); assert.equal(urls.length, 2)
  assert.equal(result.local.grounding?.verification.status, 'passed')
  assert.equal(result.local.grounding?.citations[0].quote, source.text)
  assert.equal(result.local.durationMs, result.retrievalMs + result.local.answerMs)
})
test('without RAG performs no retrieval and requests plain text', async () => {
  const result = await compareLocalRag('Search?', false, 'without', 'existing-index', undefined, {
    retriever: { retrieve: async () => { throw new Error('must not retrieve') } },
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.format, undefined)
      assert.equal(body.messages[0].content, demoAgentConfig('without', 'existing-index').systemPrompt)
      return Response.json({ message: { content: 'Typical approach, not confirmed for this project.' }, eval_count: 10, eval_duration: 1e9 })
    }) as typeof fetch,
  })
  assert.equal(result.rag, undefined); assert.equal(result.retrievalMs, 0)
  assert.equal(result.local.grounding, undefined); assert.equal(result.local.calls, 1)
  assert.match(result.local.output!, /Typical approach/)
})
test('local improved comparison reduces candidates and preserves shared RAG safeguards', async () => {
  for (const mode of ['fixed', 'improved'] as const) {
    await compareLocalRag('Search?', false, mode, 'existing-index', undefined, {
      retriever: { retrieve: async (_question, config, complete) => {
        const original = demoAgentConfig(mode, 'existing-index').rag!
        assert.deepEqual(config, mode === 'improved' ? { ...original, candidateTopK: 10 } : original)
        if (mode === 'improved') assert.equal(original.candidateTopK, 20)
        assert.ok(complete)
        return retrieve.retrieve()
      } }, fetch: mock,
    })
  }
})
test('cloud failure keeps local answer and shares a single local retrieval', async () => {
  let retrievals = 0, requests = 0
  const originalKey = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'test-key'
  try {
    const result = await compareLocalRag('Search?', true, 'structured', 'existing-index', undefined, {
      retriever: { retrieve: async () => { retrievals++; return retrieve.retrieve() } },
      fetch: (async (url, init) => {
        if (String(url).startsWith('https:')) { requests++; throw new Error('cloud outage') }
        return mock(url, init)
      }) as typeof fetch,
    })
    assert.equal(retrievals, 1); assert.equal(requests, 1)
    assert.equal(result.local.grounding?.status, 'answered'); assert.equal(result.cloud?.error, 'cloud outage')
  } finally { if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = originalKey }
})
test('empty retrieval abstains without generation and another index is rejected', async () => {
  const result = await compareLocalRag('Unknown?', false, 'structured', 'existing-index', undefined, {
    retriever: { retrieve: async () => ({ indexRunId: 'existing-index', sources: [], instruction: 'No sources.' }) },
    fetch: (async () => { throw new Error('must not generate') }) as typeof fetch,
  })
  assert.equal(result.local.grounding?.status, 'unknown'); assert.equal(result.local.calls, 0)
  await assert.rejects(compareLocalRag('Unknown?', false, 'fixed', 'other-index', undefined, { retriever: retrieve, fetch: mock }), /другой/)
})
test('large rerank prompt is batched without losing candidates or bypassing the budget', async () => {
  const candidates = Array.from({ length: 20 }, (_, i) => ({ chunkId: 'id-' + i, text: 'документ '.repeat(600) }))
  const graded: string[] = []
  let batches = 0
  await compareLocalRag('Search?', false, 'improved', 'existing-index', undefined, {
    retriever: { retrieve: async (_question, _config, complete) => {
      const response = await complete!([
        { role: 'system', content: 'Верни ВСЕ 20 переданных chunkId.' },
        { role: 'user', content: JSON.stringify({ question: 'Search?', expectedCount: 20, candidates }) },
      ], 'rerank')
      const items = JSON.parse(response.content).items
      assert.equal(items.length, 20)
      assert.deepEqual(items.map((item: { chunkId: string }) => item.chunkId), candidates.map((item) => item.chunkId))
      return { indexRunId: 'existing-index', sources: [], instruction: 'No sources.' }
    } },
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const estimate = body.messages.reduce((n: number, item: { content: string }) => n + new TextEncoder().encode(item.content).length + 64, 0)
      assert.ok(estimate + body.options.num_predict + 512 <= body.options.num_ctx)
      const batch = JSON.parse(body.messages[1].content)
      assert.equal(batch.expectedCount, batch.candidates.length)
      batches++
      const aliases = batch.candidates.map((item: { chunkId: string }) => item.chunkId)
      graded.push(...aliases)
      assert.deepEqual(aliases, aliases.map((_: string, index: number) => 'c' + (index + 1)))
      assert.deepEqual(body.format.properties.items.required, aliases)
      assert.equal(body.format.properties.items.additionalProperties, false)
      assert.equal(body.format.properties.items.properties.c1.properties.reason.maxLength, 60)
      return Response.json({ message: { content: JSON.stringify({ items: Object.fromEntries(aliases.map((alias: string) => [alias, { relevance: 0, reason: 'No evidence.' }])) }) } })
    }) as typeof fetch,
  })
  assert.equal(graded.length, 20)
  assert.ok(batches > 1)
})
test('speed aggregates use successful attempts and do not count failed requests as fast answers', async () => {
  const item = await compareLocalRag('Search?', false, 'structured', 'existing-index', undefined, { retriever: retrieve, fetch: mock })
  const summary = speedSummary([
    { ...item, retrievalMs: 100, local: { ...item.local, durationMs: 1000, answerMs: 900 } },
    { ...item, retrievalMs: 100, local: { ...item.local, durationMs: 3000, answerMs: 2900 } },
    { ...item, local: { ...item.local, durationMs: 1, error: 'failure' } },
  ], 'local')
  assert.equal(summary.attempts, 3); assert.equal(summary.errors, 1)
  assert.equal(summary.averageMs, 2000); assert.equal(summary.medianMs, 2000)
  assert.equal(summary.retrievalMs, 100); assert.equal(summary.answerMs, 1900)
})
test('remote Ollama URL is rejected', () => {
  const original = process.env.OLLAMA_BASE_URL
  process.env.OLLAMA_BASE_URL = 'https://external.invalid'
  try { assert.throws(localRagSettings, /loopback/) } finally { if (original === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = original }
})

test('local reranker rejects missing keys and invalid grades instead of inventing scores', async () => {
  for (const items of [{ c1: { relevance: 3, reason: 'Relevant' } },
    { c1: { relevance: 9, reason: 'Invalid' }, c2: { relevance: 0, reason: 'Other' } },
    { c1: { relevance: 3, reason: '   ' }, c2: { relevance: 0, reason: 'Other' } }]) {
    await assert.rejects(compareLocalRag('Search?', false, 'improved', 'existing-index', undefined, {
      retriever: { retrieve: async (_question, _config, complete) => {
        await complete!([{ role: 'system', content: 'Grade passages.' },
          { role: 'user', content: JSON.stringify({ question: 'Search?', candidates: [{ chunkId: 'long-id-1', text: 'First' }, { chunkId: 'long-id-2', text: 'Second' }] }) }], 'rerank')
        return retrieve.retrieve()
      } },
      fetch: (async () => Response.json({ message: { content: JSON.stringify({ items }) } })) as typeof fetch,
    }), /Реранкер/)
  }
})

test('cloud reranker keeps native chunk IDs and incomplete arrays for shared retrieval validation', async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'test-key'
  try {
    const items = [{ chunkId: 'structured-original-1', relevance: 3, reason: 'Direct evidence' }]
    const prompt = [{ role: 'system' as const, content: 'Верни только JSON с массивом items и исходными chunkId.' },
      { role: 'user' as const, content: JSON.stringify({ question: 'Search?', expectedCount: 2, candidates: [
        { chunkId: 'structured-original-1', text: 'First passage' }, { chunkId: 'structured-original-2', text: 'Second passage' },
      ] }) }]
    const client = modelClient('cloud', undefined, (async (url, init) => {
      assert.equal(String(url), 'https://api.deepseek.com/chat/completions')
      const body = JSON.parse(String(init?.body))
      assert.deepEqual(body.messages, prompt)
      assert.deepEqual(body.response_format, { type: 'json_object' })
      assert.equal(body.format, undefined)
      return Response.json({ choices: [{ message: { content: JSON.stringify({ items }) } }] })
    }) as typeof fetch)
    const response = await client.complete(prompt, 'rerank')
    assert.deepEqual(JSON.parse(response.content), { items })
  } finally { if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = originalKey }
})

test('cloud reranker batches large prompts without local aliases or lost grades', async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'test-key'
  try {
    const candidates = Array.from({ length: 20 }, (_, i) => ({ chunkId: 'structured-original-' + i, text: 'документ '.repeat(600) }))
    let batches = 0
    const client = modelClient('cloud', undefined, (async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const batch = JSON.parse(body.messages[body.messages.length - 1].content)
      assert.equal(batch.expectedCount, batch.candidates.length)
      assert.ok(batch.candidates.every((item: { chunkId: string }) => item.chunkId.startsWith('structured-original-')))
      const estimate = body.messages.reduce((n: number, item: { content: string }) => n + new TextEncoder().encode(item.content).length + 64, 0)
      assert.ok(estimate + body.max_tokens + 512 <= localRagSettings().context)
      batches++
      return Response.json({ choices: [{ message: { content: JSON.stringify({ items: batch.candidates.map((item: { chunkId: string }) => ({ chunkId: item.chunkId, relevance: 3, reason: 'Evidence' })) }) } }] })
    }) as typeof fetch)
    const response = await client.complete([{ role: 'system', content: 'Верни ВСЕ 20 переданных chunkId.' },
      { role: 'user', content: JSON.stringify({ question: 'Search?', expectedCount: 20, candidates }) }], 'rerank')
    assert.ok(batches > 1)
    assert.deepEqual(JSON.parse(response.content).items.map((item: { chunkId: string }) => item.chunkId), candidates.map((item) => item.chunkId))
  } finally { if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = originalKey }
})

test('local generation rechecks premature unknown and keeps verifier after a supported answer', async () => {
  let answers = 0
  const result = await compareLocalRag('Search?', false, 'structured', 'existing-index', undefined, {
    retriever: retrieve, fetch: (async (url, init) => {
      if (String(init?.body).includes('Каталог доказательств:') && ++answers === 1) return Response.json({ message: { content: '{"status":"unknown"}' }, eval_count: 2, prompt_eval_count: 3 })
      return mock(url, init)
    }) as typeof fetch,
  })
  assert.equal(answers, 2)
  assert.equal(result.local.calls, 3)
  assert.equal(result.local.grounding?.verification.status, 'passed')
  assert.equal(result.local.promptTokens, 43)
})
test('two unsupported local refusals remain unknown without fabricated evidence or verification', async () => {
  const result = await compareLocalRag('Unknown?', false, 'structured', 'existing-index', undefined, {
    retriever: retrieve, fetch: (async () => Response.json({ message: { content: '{"status":"unknown"}' } })) as typeof fetch,
  })
  assert.equal(result.local.calls, 2)
  assert.equal(result.local.grounding?.status, 'unknown')
  assert.deepEqual(result.local.grounding?.citations, [])
})

test('literal evidence selectors do not bypass rejection of unsupported claims', async () => {
  const result = await compareLocalRag('Search?', false, 'structured', 'existing-index', undefined, {
    retriever: retrieve, fetch: (async (_url, init) => {
      const verify = String(init?.body).includes('Проверь соответствие')
      const content = verify ? { items: { '1': { supported: false, reason: 'The selected passage says search is local, not cloud.' } } }
        : { status: 'answered', claims: [{ text: 'Search runs in the cloud.', evidenceIds: ['e1'] }] }
      return Response.json({ message: { content: JSON.stringify(content) } })
    }) as typeof fetch,
  })
  assert.equal(result.local.grounding?.status, 'unknown')
  assert.equal(result.local.grounding?.reason, 'unsupported-answer')
  assert.deepEqual(result.local.grounding?.citations, [])
  assert.equal(result.local.calls, 4)
})

test('local verifier rejects missing, unknown and malformed judgments without bypassing validation', async () => {
  for (const items of [{}, { '2': { supported: true, reason: 'Unknown claim' } },
    { '1': { supported: true, reason: 'Extra field', items: [] } },
    { '1': { supported: 'true', reason: 'Wrong type' } }]) {
    const result = await compareLocalRag('Search?', false, 'structured', 'existing-index', undefined, {
      retriever: retrieve, fetch: (async (url, init) => {
        if (String(init?.body).includes('Проверь соответствие')) return Response.json({ message: { content: JSON.stringify({ items }) } })
        return mock(url, init)
      }) as typeof fetch,
    })
    assert.match(result.local.error!, /Проверяющий|Некорректный результат/)
    assert.equal(result.local.grounding, undefined)
  }
})

test('local verifier binds multiple required judgments to their original claims', async () => {
  const result = await compareLocalRag('How and where does search run?', false, 'structured', 'existing-index', undefined, {
    retriever: retrieve, fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      if (String(init?.body).includes('Проверь соответствие')) {
        assert.deepEqual(body.format.properties.items.required, ['1', '2'])
        return Response.json({ message: { content: JSON.stringify({ items: {
          '1': { supported: true, reason: 'Local search' }, '2': { supported: true, reason: 'SQLite search' },
        } }) } })
      }
      return Response.json({ message: { content: JSON.stringify({ status: 'answered', claims: [
        { text: 'Search runs locally.', evidenceIds: ['e1'] }, { text: 'Search uses SQLite.', evidenceIds: ['e1'] },
      ] }) } })
    }) as typeof fetch,
  })
  assert.equal(result.local.grounding?.status, 'answered')
  assert.deepEqual(result.local.grounding?.verification.judgments.map((item) => item.claimId), [1, 2])
})

test('local verifier preserves the required whole-answer check, including a negative verdict', async () => {
  const taskCheck = { goalAligned: true, constraintsRespected: true, answersQuestion: false, reason: 'Only the current branch was returned.' }
  const client = modelClient('local', undefined, (async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body.format.required, ['items', 'taskCheck'])
    assert.deepEqual(body.format.properties.taskCheck.required, ['goalAligned', 'constraintsRespected', 'answersQuestion', 'reason'])
    return Response.json({ message: { content: JSON.stringify({ items: { '1': { supported: true, reason: 'True fact.' } }, taskCheck }) } })
  }) as typeof fetch)
  const response = await client.complete([{ role: 'system', content: 'Проверь соответствие. Верни только JSON: items и taskCheck.' },
    { role: 'user', content: JSON.stringify({ taskCheckRequired: true, claims: [{ claimId: 1 }] }) }], 'verify')
  assert.deepEqual(JSON.parse(response.content), { items: [{ claimId: 1, supported: true, reason: 'True fact.' }], taskCheck })
})

test('local verifier cannot silently drop a missing or malformed whole-answer check', async () => {
  for (const taskCheck of [undefined, {}, { goalAligned: true, constraintsRespected: true, answersQuestion: 'true', reason: 'Wrong type' }]) {
    const client = modelClient('local', undefined, (async () => Response.json({ message: { content: JSON.stringify({ items: { '1': { supported: true, reason: 'True fact.' } }, taskCheck }) } })) as typeof fetch)
    await assert.rejects(client.complete([{ role: 'system', content: 'Проверь соответствие.' },
      { role: 'user', content: JSON.stringify({ taskCheckRequired: true, claims: [{ claimId: 1 }] }) }], 'verify'), /соответствие ответа вопросу/)
  }
})

test('local support answers allow documented checks and use MCP when the claim needs it', async () => {
  const context: RagSource = { ...source, source: 'mcp://support/get_support_context', chunkId: 'selected-context', text: 'The selected user has family role regular.' }
  for (const ids of [['e1'], ['e2', 'e1']]) {
    const client = modelClient('local', undefined, (async (_url, init) => {
      const request = JSON.parse(String(init?.body)), answered = request.format.anyOf[0]
      assert.deepEqual(answered.required, ['status', 'claims'])
      assert.equal(answered.properties.claims.minItems, 1)
      assert.equal(answered.properties.claims.maxItems, 3)
      return Response.json({ message: { content: JSON.stringify({ status: 'answered', claims: [{ text: 'Ask your family owner to invite the relative.', evidenceIds: ids }] }) } })
    }) as typeof fetch, { contextSourcePrefix: 'mcp://support/' })
    client.setSources([source, context])
    const result = JSON.parse((await client.complete([{ role: 'system', content: 'Support' }, { role: 'user', content: 'How can I invite a relative?' }], 'answer')).content)
    assert.equal(result.claims.length, 1)
    assert.equal(result.claims[0].citations.length, ids.length)
    assert.equal(result.claims[0].text, 'Ask your family owner to invite the relative.')
  }
})

test('support still rejects fabricated evidence IDs and permits unknown', async () => {
  const context: RagSource = { ...source, source: 'mcp://support/get_support_context', chunkId: 'selected-context', text: 'The selected user has family role regular.' }
  for (const status of ['answered', 'unknown']) {
    const client = modelClient('local', undefined, (async () => Response.json({ message: { content: JSON.stringify(status === 'unknown' ? { status } : {
      status, claims: [{ text: 'Invented evidence', evidenceIds: ['unknown-id'] }],
    }) } })) as typeof fetch, { contextSourcePrefix: 'mcp://support/' })
    client.setSources([source, context])
    const run = client.complete([{ role: 'user', content: 'Question' }], 'answer')
    if (status === 'answered') await assert.rejects(run, /Unknown evidence ID/)
    else assert.equal((await run).content, '{"status":"unknown"}')
  }
})

test('support context selector excludes technical receipt metadata from the required customer evidence', async () => {
  const context: RagSource = { ...source, source: 'mcp://support/get_support_context', chunkId: 'selected-context', text: 'MCP get_support_context. Получено: test.\n\nПродукт: MyFamily.\n\nСообщение пользователя 1:\nЯ не дал разрешение на использование камеры.' }
  const client = modelClient('local', undefined, (async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    assert.deepEqual(request.format.anyOf[0].properties.claims.items.properties.evidenceIds.items.enum, ['e1', 'e4'])
    return Response.json({ message: { content: '{"status":"unknown"}' } })
  }) as typeof fetch, { contextSourcePrefix: 'mcp://support/' })
  client.setSources([source, context])
  await client.complete([{ role: 'user', content: 'Как разрешить камеру?' }], 'answer')
})
