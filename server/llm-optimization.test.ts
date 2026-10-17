import test from 'node:test'
import assert from 'node:assert/strict'
import { optimizationCases, optimizationProfiles, checkOptimizationAnswer, summarizeOptimization } from '../src/llm-optimization'
import { answerOptimizedQuestion, benchmarkOptimization, optimizationMessages, optimizationSettings, resolveOptimizationContext, validateOptimizationProfile } from './llm-optimization-service'
import { optimizationDemoCases, optimizationHeavyCases } from '../src/llm-optimization-cases'
import { compatibleComparisonReport, emptyComparisonReport, mergeQuestionReport } from './llm-optimization-comparison'

const optimized = optimizationProfiles.find((item) => item.id === 'optimized')!
const storage = optimizationCases[0]
const responseText = 'data/scheduler.sqlite; BEGIN IMMEDIATE; 5 минут. [1]'
function fakeOllama(options: { missingMetrics?: boolean; length?: boolean; memoryError?: boolean; brokenStream?: boolean; q8WrongSize?: boolean } = {}) {
  const calls: { path: string; body: any }[] = []
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, body })
    if (init?.signal?.aborted) throw init.signal.reason
    if (path === '/api/tags') return Response.json({ models: [{ name: 'qwen3.5:4b', size: 3000, digest: 'q4' }, { name: 'qwen3.5:4b-q8_0', size: 5000, digest: 'q8' }] })
    if (path === '/api/show') return Response.json({ details: { quantization_level: body.model.endsWith('q8_0') ? 'Q8_0' : 'Q4_K_M' }, parameters: 'temperature 1', template: '{{ .Prompt }}', model_info: { 'general.architecture': 'qwen35', 'general.parameter_count': options.q8WrongSize && body.model.endsWith('q8_0') ? 9000 : 4000 } })
    if (path === '/api/ps') return options.memoryError ? Response.json({ error: 'ps failed' }, { status: 500 }) : Response.json({ models: [{ name: 'qwen3.5:4b', size: 4096, size_vram: 4000, context_length: 8192 }, { name: 'qwen3.5:4b-q8_0', size: 6000, size_vram: 5900, context_length: 8192 }] })
    if (body.keep_alive === 0) return Response.json({ done: true })
    const full = JSON.stringify({ message: { content: responseText } }) + '\n' + (options.brokenStream ? '' : JSON.stringify({ done: true, done_reason: options.length ? 'length' : 'stop',
      ...(options.missingMetrics ? {} : { load_duration: 1000000, prompt_eval_count: 100, prompt_eval_duration: 500000000, eval_count: 40, eval_duration: 2000000000 }) })) + '\n'
    const bytes = new TextEncoder().encode(full)
    // Split within multibyte Russian text, not just between complete JSON lines.
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close() } }))
  }
  return { request, calls }
}

test('parameter and prompt profiles isolate the intended variables', () => {
  const [baseline, parameters, prompt, optimizedProfile, q8] = optimizationProfiles
  assert.equal(parameters.systemPrompt, baseline.systemPrompt)
  assert.equal(prompt.context, baseline.context)
  assert.equal(prompt.maxTokens, baseline.maxTokens)
  assert.equal(prompt.temperature, baseline.temperature)
  assert.equal(prompt.systemPrompt, optimizedProfile.systemPrompt)
  assert.deepEqual({ ...q8, id: optimizedProfile.id, label: optimizedProfile.label }, optimizedProfile)
})
test('reject invalid settings and oversized material without silent truncation', () => {
  for (const overrides of [{ temperature: NaN }, { context: 8192.5 }, { maxTokens: 8192 }, { context: 2048, maxTokens: 1800 }, { systemPrompt: '' }]) assert.throws(() => validateOptimizationProfile({ ...optimized, ...overrides }))
  assert.throws(() => optimizationMessages('Вопрос', [{ title: 'doc', text: 'я'.repeat(10000) }], optimized), /бюджет/)
  assert.throws(() => optimizationMessages('Вопрос', [], optimized), /материал/)
})
test('prompt contains materials and question but no answer key', () => {
  for (const item of optimizationCases) {
    const messages = optimizationMessages(item.question, item.materials, optimized)
    assert.equal(messages.length, 2)
    assert.ok(messages[1].content.includes(item.question))
    assert.ok(!messages[1].content.includes(item.expected))
    assert.ok(!messages[1].content.includes('pattern'))
  }
})
test('client material cannot replace server source numbers or add fields to prompt', () => {
  const input = [{ ...storage.materials[0], id: 999, instruction: 'injected' }]
  const prompt = optimizationMessages(storage.question, input, optimized)[1].content
  assert.ok(prompt.includes('"id":1'))
  assert.ok(!prompt.includes('999'))
  assert.ok(!prompt.includes('injected'))
})
test('handles fragmented UTF-8 stream and separates generation throughput from wall time', async () => {
  const fake = fakeOllama()
  const answer = await answerOptimizedQuestion(storage.question, storage.materials, optimized, undefined, { fetch: fake.request })
  assert.equal(answer.content, responseText)
  assert.equal(answer.metrics.tokensPerSecond, 20)
  assert.equal(answer.metrics.generationMs, 2000)
  assert.equal(answer.metrics.modelMemoryBytes, 4096)
  const sent = fake.calls.find((item) => item.path === '/api/chat')!.body
  assert.deepEqual(sent.options, { temperature: optimized.temperature, num_ctx: resolveOptimizationContext(optimizationMessages(storage.question, storage.materials, optimized), optimized), num_predict: optimized.maxTokens, seed: 29, ...(optimized.topP === undefined ? {} : { top_p: optimized.topP }) })
  assert.equal(sent.think, false)
})
test('missing metrics stay unavailable; memory failure does not destroy answer', async () => {
  const fake = fakeOllama({ missingMetrics: true, memoryError: true })
  const answer = await answerOptimizedQuestion(storage.question, storage.materials, optimized, undefined, { fetch: fake.request })
  assert.equal(answer.metrics.outputTokens, undefined)
  assert.equal(answer.metrics.tokensPerSecond, undefined)
  assert.equal(answer.metrics.modelMemoryBytes, undefined)
  assert.match(answer.metrics.memoryError!, /ps failed/)
  assert.equal(answer.content, responseText)
})
test('truncation fails quality even when required keywords are present; incomplete stream is an error', async () => {
  const fake = fakeOllama({ length: true })
  const answer = await answerOptimizedQuestion(storage.question, storage.materials, optimized, undefined, { fetch: fake.request })
  const quality = checkOptimizationAnswer(storage, answer.content, answer.doneReason)
  assert.equal(quality.factsPassed, true)
  assert.equal(quality.complete, false)
  assert.equal(quality.protocolPassed, false)
  await assert.rejects(answerOptimizedQuestion(storage.question, storage.materials, optimized, undefined, { fetch: fakeOllama({ brokenStream: true }).request }), /прерван/)
})
test('abstention and citations cannot pass just by mentioning unknown or an invalid source', () => {
  const unknown = optimizationCases.find((item) => item.refusal)!
  assert.equal(checkOptimizationAnswer(unknown, 'Не знаю: в предоставленных материалах нет ответа.', 'stop').protocolPassed, true)
  assert.equal(checkOptimizationAnswer(unknown, 'Не знаю, но Redis обычно localhost:6379.', 'stop').factsPassed, false)
  assert.equal(checkOptimizationAnswer(storage, responseText.replace('[1]', '[2]'), 'stop').protocolPassed, false)
})
test('memory contradiction cannot pass by listing layer names; Markdown does not hide numbers', () => {
  const memory = optimizationCases.find((item) => item.id === 'memory')!
  const wrong = 'Short-term очищается. Working не сохраняется автоматически. Сохраняется только Long-term. [1]'
  assert.equal(checkOptimizationAnswer(memory, wrong, 'stop').factsPassed, false)
  const correct = 'Short-term очищается кнопкой «Новый диалог»; working — отдельной кнопкой «Очистить» после завершения задачи; long-term удаляется только явно, по одной записи или целиком. [1]'
  assert.equal(checkOptimizationAnswer(memory, correct, 'stop').factsPassed, true)
  assert.equal(checkOptimizationAnswer(storage, responseText.replace('5 минут', '**5** минут'), 'stop').factsPassed, true)
})
test('summary counts errors and uses even median without treating missing metrics as zero', () => {
  const samples = [10, 30].map((wallMs, index) => ({ profileId: optimized.id, caseId: storage.id, repetition: index + 1,
    answer: { content: responseText, doneReason: 'stop', metrics: { wallMs, ...(index ? { tokensPerSecond: 20, modelMemoryBytes: 40 } : {}) } }, quality: checkOptimizationAnswer(storage, responseText, 'stop') }))
  const result = summarizeOptimization([...samples, { profileId: optimized.id, caseId: 'unknown', repetition: 1, error: 'failure' }], [optimized])[0]
  assert.equal(result.samples, 3); assert.equal(result.errors, 1); assert.equal(result.medianMs, 20)
  assert.equal(result.meanTokensPerSecond, 20); assert.equal(result.maxMemoryBytes, 40); assert.equal(result.protocolPassed, 2)
})
test('benchmark excludes warmup, reverses order, unloads previous model, records digests', async () => {
  const fake = fakeOllama()
  const report = await benchmarkOptimization({ repetitions: 2, includeQ8: true, profiles: optimizationProfiles.map((item) => ({ ...item, adaptiveContext: false })) }, { fetch: fake.request })
  assert.equal(report.samples.length, optimizationCases.length * optimizationProfiles.length * 2)
  assert.equal(report.warmups.length, 10)
  assert.equal(report.samples[0].profileId, 'baseline')
  assert.equal(report.samples[30].profileId, 'q8')
  assert.equal(report.samples[30].caseId, optimizationCases[5].id)
  assert.equal(report.models[0].digest, 'q4')
  assert.equal(report.models[1].quantization, 'Q8_0')
  assert.ok(report.finishedAt)
  const unloads = fake.calls.filter((item) => item.body?.keep_alive === 0)
  assert.ok(unloads.some((item) => item.body.model === 'qwen3.5:4b-q8_0'))
})
test('reject comparing quantization across model sizes', async () => {
  await assert.rejects(benchmarkOptimization({ repetitions: 1, includeQ8: true }, { fetch: fakeOllama({ q8WrongSize: true }).request }), /архитектуры/)
})
test('cancellation preserves completed samples in an explicitly incomplete report', async () => {
  const abort = new AbortController(), fake = fakeOllama()
  const report = await benchmarkOptimization({ signal: abort.signal, onProgress: (value) => { if (value.samples.length === 1) abort.abort() } }, { fetch: fake.request })
  assert.equal(report.samples.length, 1); assert.equal(report.cancelled, true); assert.equal(report.finishedAt, undefined)
})
test('local-only endpoint validation rejects external URLs', () => {
  const original = process.env.OLLAMA_BASE_URL
  process.env.OLLAMA_BASE_URL = 'https://example.com'
  try { assert.throws(optimizationSettings, /loopback/) }
  finally { if (original === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = original }
})
test('heavy suite has unique questions and long input is rejected instead of truncated', () => {
  assert.equal(optimizationDemoCases.length, 10)
  assert.equal(new Set(optimizationDemoCases.map((item) => item.id)).size, 10)
  const long = optimizationHeavyCases.find((item) => item.id === 'long-policy')!
  assert.throws(() => optimizationMessages(long.question, long.materials, { ...optimized, context: 8192, maxTokens: 1024 }), /бюджет/)
  assert.equal(optimizationMessages(long.question, long.materials, { ...optimized, context: 16384, maxTokens: 1024 }).length, 2)
  assert.throws(() => validateOptimizationProfile({ ...optimized, topP: 0 }), /top_p/)
})
test('numeric citation ranges do not masquerade as valid material references', () => {
  assert.equal(checkOptimizationAnswer(storage, responseText + ' [1–44]', 'stop').citationPassed, false)
})
test('a new question run replaces both old sides while preserving other questions', () => {
  const before = emptyComparisonReport()
  before.finishedAt = 'old'
  before.samples = [
    { profileId: 'baseline', caseId: 'storage', repetition: 1, error: 'old' },
    { profileId: 'optimized', caseId: 'storage', repetition: 1, error: 'old' },
    { profileId: 'baseline', caseId: 'missed', repetition: 1, error: 'keep' },
  ]
  const progress = emptyComparisonReport()
  progress.samples = [{ profileId: 'baseline', caseId: 'storage', repetition: 1, error: 'new' }]
  const next = mergeQuestionReport(before, progress, 'storage')
  assert.equal(next.samples.filter((item) => item.caseId === 'storage').length, 1)
  assert.equal(next.samples.find((item) => item.caseId === 'storage')!.error, 'new')
  assert.equal(next.samples.find((item) => item.caseId === 'missed')!.error, 'keep')
  assert.equal(next.finishedAt, undefined)
})
test('different suites and settings cannot silently mix saved comparisons', () => {
  const current = emptyComparisonReport()
  assert.equal(compatibleComparisonReport(current), true)
  assert.equal(compatibleComparisonReport({ ...current, suiteId: undefined }), false)
  assert.equal(compatibleComparisonReport({ ...current, profiles: current.profiles.map((item) => ({ ...item, context: 2048 })) }), false)
})
test('adaptive context keeps the entire input and output reserve within the configured maximum', async () => {
  const fixed = { ...optimized, adaptiveContext: false, context: 16384 }
  const adaptive = { ...fixed, adaptiveContext: true }
  const shortMessages = optimizationMessages(storage.question, storage.materials, adaptive)
  assert.equal(resolveOptimizationContext(shortMessages, fixed), 16384)
  const small = resolveOptimizationContext(shortMessages, adaptive)
  assert.ok(small < 16384)
  const required = shortMessages.reduce((sum, item) => sum + new TextEncoder().encode(item.content).length + 64, 0) + adaptive.maxTokens + 512
  assert.ok(small >= required)
  const long = optimizationHeavyCases.find((item) => item.id === 'long-policy')!
  assert.equal(resolveOptimizationContext(optimizationMessages(long.question, long.materials, adaptive), adaptive), 16384)
  assert.throws(() => resolveOptimizationContext([{ content: 'я'.repeat(10000) }], adaptive), /бюджет/)
  const fake = fakeOllama()
  await answerOptimizedQuestion(storage.question, storage.materials, adaptive, undefined, { fetch: fake.request })
  assert.equal(fake.calls.find((item) => item.path === '/api/chat')!.body.options.num_ctx, small)
  assert.throws(() => validateOptimizationProfile({ ...optimized, adaptiveContext: 'yes' }), /boolean/)
})
test('long-document answer cannot pass by mentioning values while claiming they are absent', () => {
  const long = optimizationHeavyCases.find((item) => item.id === 'long-policy')!
  const wrong = 'В документе отсутствуют конкретные числовые значения. POLICY-A73, 20 секунд, 7 минут, 120 секунд, TRACE; повтор не выполняется. [1]'
  assert.equal(checkOptimizationAnswer(long, wrong, 'stop').factsPassed, false)
  const correct = 'POLICY-A73, 20 секунд, 7 минут, 120 секунд простоя; TRACE — архивы диагностики; повтор не выполняется. [1]'
  assert.equal(checkOptimizationAnswer(long, correct, 'stop').factsPassed, true)
})
test('adaptive benchmark warms each changed context before measuring its cases', async () => {
  const fake = fakeOllama()
  const long = optimizationHeavyCases.find((item) => item.id === 'long-policy')!
  const profile = { ...optimized, context: 16384, adaptiveContext: true }
  const report = await benchmarkOptimization({ profiles: [profile], cases: [storage, long], repetitions: 1 }, { fetch: fake.request })
  const shortContext = resolveOptimizationContext(optimizationMessages(storage.question, storage.materials, profile), profile)
  const chats = fake.calls.filter((item) => item.path === '/api/chat' && item.body.keep_alive !== 0)
  assert.deepEqual(chats.map((item) => [item.body.options.num_ctx, item.body.options.num_predict]), [[shortContext, 8], [shortContext, profile.maxTokens], [16384, 8], [16384, profile.maxTokens]])
  assert.equal(report.warmups.length, 2)
  assert.equal(report.samples.length, 2)
  assert.equal(report.warmups[1].caseId, long.id)
})
test('source blocks preserve material content and expose only server-issued source ids', () => {
  const memory = optimizationCases.find((item) => item.id === 'memory')!
  const profile = { ...optimized, sourceLayout: 'blocks' as const }
  const prompt = optimizationMessages(memory.question, memory.materials, profile)[1].content
  assert.ok(prompt.includes(memory.materials[0].text.replace(/;[ \t]*/g, ';\n')))
  assert.ok(prompt.includes('Допустимые ссылки на материалы: [1].'))
  const baseline = optimizationProfiles.find((item) => item.id === 'baseline')!
  const original = optimizationMessages(memory.question, memory.materials, baseline)[1].content
  assert.ok(original.startsWith('Материалы (JSON):\n'))
  assert.ok(!original.includes('Допустимые ссылки'))
  assert.throws(() => validateOptimizationProfile({ ...profile, sourceLayout: 'unknown' }), /шаблон/)
})
