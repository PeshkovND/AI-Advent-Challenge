import test from 'node:test'
import assert from 'node:assert/strict'
import { optimizationCases, reviewedOptimizationScore, summarizeJudgeReviews, type OptimizationAnswer } from '../src/llm-optimization'
import { emptyComparisonReport } from './llm-optimization-comparison'
import { blindJudgeInput, currentJudgeReview, judgeInputHash, judgeOptimizationPair, judgeReportCase, optimizationJudgeSettings, parseJudgeAssessment, type JudgeFormatDiagnostic } from './llm-optimization-judge'

const before: OptimizationAnswer = { content: 'Сохраняется только Long-term.', doneReason: 'stop', metrics: { wallMs: 111, outputTokens: 20 } }
const after: OptimizationAnswer = { content: 'Short-term очищается; Working и Long-term сохраняются. [1]', doneReason: 'stop', metrics: { wallMs: 222, outputTokens: 30 } }
const memory = optimizationCases.find((item) => item.id === 'memory')!
const assessment = (value: number) => ({ accuracy: value, completeness: value, grounding: value, citations: value, verdict: value === 5 ? 'correct' : 'partial', rationale: 'Проверка смысла по материалу [1].', errors: value === 5 ? [] : ['Основной вывод противоречит источнику [1].'], omissions: [] })
async function configured(run: () => Promise<void> | void) {
  const key = process.env.DEEPSEEK_API_KEY, model = process.env.DEEPSEEK_JUDGE_MODEL
  process.env.DEEPSEEK_API_KEY = 'test-key'; process.env.DEEPSEEK_JUDGE_MODEL = 'deepseek-v4-pro'
  try { await run() } finally {
    if (key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = key
    if (model === undefined) delete process.env.DEEPSEEK_JUDGE_MODEL; else process.env.DEEPSEEK_JUDGE_MODEL = model
  }
}
function fakeJudge(options: { finish?: string; content?: string; status?: number } = {}) {
  const calls: { url: string; body: any }[] = []
  const request: typeof fetch = async (url, init) => {
    init?.signal?.throwIfAborted()
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    if (options.status) return Response.json({ error: { message: 'Authorization test-key' } }, { status: options.status })
    return Response.json({ model: 'deepseek-v4-pro', usage: { prompt_tokens: 100, completion_tokens: 200 }, choices: [{ finish_reason: options.finish || 'stop',
      message: { content: options.content ?? JSON.stringify({ A: assessment(2), B: assessment(5) }) },
    }] })
  }
  return { request, calls }
}
test('judge sees full evidence and anonymous answers, with no tuning settings or answer keys', () => {
  const blind = blindJudgeInput(memory, before, after)
  const data = JSON.parse(blind.messages[1].content)
  assert.deepEqual(data.materials, memory.materials.map((item, index) => ({ id: index + 1, title: item.title, text: item.text })))
  assert.equal(data.question, memory.question)
  assert.equal(data.answers.A.text, blind.reversed ? after.content : before.content)
  assert.equal(data.answers.B.text, blind.reversed ? before.content : after.content)
  for (const text of ['baseline', 'optimized', 'temperature', 'maxTokens', 'expected', 'pattern', 'wallMs', 'outputTokens']) assert.ok(!blind.messages[1].content.includes(text), text)
  assert.equal(data.answers.A.complete, true)
  assert.equal(blind.messages[0].content.includes('те же поля'), false)
  const example = JSON.parse(blind.messages[0].content.slice(blind.messages[0].content.indexOf('{"A":')))
  assert.ok(parseJudgeAssessment(JSON.stringify(example)))
  assert.equal(blindJudgeInput(memory, { ...before, doneReason: 'length' }, after).messages.length, 2)
  assert.ok(optimizationCases.some((item) => blindJudgeInput(item, before, after).reversed))
  assert.ok(optimizationCases.some((item) => !blindJudgeInput(item, before, after).reversed))
})
test('strong judge uses thinking/high, validates JSON, maps blind order, and leaves local metrics intact', async () => configured(async () => {
  const fake = fakeJudge(), beforeCopy = structuredClone(before), afterCopy = structuredClone(after)
  const reviews = await judgeOptimizationPair(memory, before, after, undefined, { fetch: fake.request })
  const reversed = blindJudgeInput(memory, before, after).reversed
  assert.equal(reviews.before.score, reversed ? 10 : 4)
  assert.equal(reviews.after.score, reversed ? 4 : 10)
  assert.equal(reviews.before.inputHash, judgeInputHash(memory, before))
  assert.equal(reviews.before.promptTokens, 100)
  assert.equal(reviews.before.outputTokens, 200)
  assert.equal(fake.calls[0].url, 'https://api.deepseek.com/chat/completions')
  assert.equal(fake.calls[0].body.model, 'deepseek-v4-pro')
  assert.deepEqual(fake.calls[0].body.thinking, { type: 'enabled' })
  assert.equal(fake.calls[0].body.reasoning_effort, 'high')
  assert.equal(fake.calls[0].body.temperature, undefined)
  assert.deepEqual(fake.calls[0].body.response_format, { type: 'json_object' })
  assert.deepEqual(before, beforeCopy); assert.deepEqual(after, afterCopy)
  assert.equal(JSON.stringify(reviews).includes('test-key'), false)
}))
test('bad grades, hallucinated fields and incomplete model responses are errors', async () => configured(async () => {
  for (const value of [
    { A: { ...assessment(5), accuracy: 6 }, B: assessment(5) },
    { A: { ...assessment(5), grounding: 2.5 }, B: assessment(5) },
    { A: { ...assessment(5), errors: 'none' }, B: assessment(5) },
    { A: { ...assessment(5), rationale: '' }, B: assessment(5) },
    { A: assessment(5) }, { A: assessment(5), B: assessment(5), winner: 'B' },
  ]) assert.throws(() => parseJudgeAssessment(JSON.stringify(value)))
  await assert.rejects(judgeOptimizationPair(memory, before, after, undefined, { fetch: fakeJudge({ finish: 'length' }).request }), /не завершил/)
  const invalid = fakeJudge({ content: 'not JSON' }), diagnostics: JudgeFormatDiagnostic[] = []
  await assert.rejects(judgeOptimizationPair(memory, before, after, undefined, { fetch: invalid.request, onFormatError: (item) => { diagnostics.push(item) } }), /некорректным/)
  assert.equal(invalid.calls.length, 2)
  assert.equal(diagnostics.length, 2)
  await assert.rejects(judgeOptimizationPair(memory, before, after, undefined, { fetch: fakeJudge({ status: 401 }).request }), (error: any) => !error.message.includes('test-key') && error.message.includes('[redacted]'))
}))
test('judge accepts one JSON code fence but never extracts, rounds or invents grades', () => {
  const content = JSON.stringify({ A: assessment(2), B: assessment(5) })
  assert.deepEqual(parseJudgeAssessment('```json\n' + content + '\n```'), parseJudgeAssessment(content))
  assert.throws(() => parseJudgeAssessment('Explanation\n' + content))
  assert.throws(() => parseJudgeAssessment(JSON.stringify({ A: { ...assessment(2), accuracy: '2' }, B: assessment(5) })))
  assert.throws(() => parseJudgeAssessment(JSON.stringify({ A: { ...assessment(2), accuracy: 2.5 }, B: assessment(5) })))
})
test('invalid fields trigger one format retry with the same blind inputs and safe diagnostics', async () => configured(async () => {
  const invalid = fakeJudge({ content: JSON.stringify({ A: { ...assessment(2), accuracy: 2.5 }, B: assessment(5) }) })
  const valid = fakeJudge(), diagnostics: JudgeFormatDiagnostic[] = []
  let count = 0
  const request: typeof fetch = (url, init) => (++count === 1 ? invalid : valid).request(url, init)
  const result = await judgeOptimizationPair(memory, before, after, undefined, { fetch: request, onFormatError: (item) => { diagnostics.push(item) } })
  assert.equal(count, 2)
  assert.equal(diagnostics.length, 1)
  assert.match(diagnostics[0].issue, /A.accuracy.*целое число/)
  assert.equal(diagnostics[0].attempt, 1)
  assert.deepEqual(valid.calls[0].body.messages.slice(0, 2), invalid.calls[0].body.messages)
  assert.ok(valid.calls[0].body.messages[2].content.includes('A.accuracy'))
  assert.equal(result.before.promptTokens, 200)
  assert.equal(result.before.outputTokens, 400)
  assert.equal(result.before.inputHash, judgeInputHash(memory, before))
  assert.deepEqual(before.metrics, { wallMs: 111, outputTokens: 20 })
}))
test('failed retry reports the actual field, redacts secrets and preserves answers without a fake grade', async () => configured(async () => {
  const invalid = fakeJudge({ content: JSON.stringify({ A: { ...assessment(2), errors: 'test-key' }, B: assessment(5) }) })
  const diagnostics: JudgeFormatDiagnostic[] = [], report = emptyComparisonReport()
  report.samples = [{ profileId: 'baseline', caseId: memory.id, repetition: 1, answer: before }, { profileId: 'optimized', caseId: memory.id, repetition: 1, answer: after }]
  const result = await judgeReportCase(report, memory.id, undefined, { fetch: invalid.request, onFormatError: (item) => { diagnostics.push(item) } })
  assert.equal(invalid.calls.length, 2)
  assert.ok(result.samples.every((sample) => !sample.review && /A.errors/.test(sample.reviewError!) && /Автоматический повтор/.test(sample.reviewError!)))
  assert.deepEqual(result.samples.map((sample) => sample.answer), [before, after])
  assert.equal(JSON.stringify(diagnostics).includes('test-key'), false)
  assert.ok(diagnostics[0].content.includes('[redacted]'))
}))
test('cancellation after a malformed response prevents retry even when diagnostics cannot be saved', async () => configured(async () => {
  const abort = new AbortController(), invalid = fakeJudge({ content: 'not JSON' })
  await assert.rejects(judgeOptimizationPair(memory, before, after, abort.signal, { fetch: invalid.request, onFormatError: () => { abort.abort() } }), { name: 'AbortError' })
  assert.equal(invalid.calls.length, 1)
  let count = 0
  const valid = fakeJudge()
  const result = await judgeOptimizationPair(memory, before, after, undefined, {
    fetch: (url, init) => (++count === 1 ? invalid : valid).request(url, init),
    onFormatError: () => { throw new Error('disk unavailable') },
  })
  assert.ok(result.before)
  assert.equal(count, 2)
}))
test('missing key never triggers a cloud request', async () => configured(async () => {
  delete process.env.DEEPSEEK_API_KEY
  assert.equal(optimizationJudgeSettings().ready, false)
  const fake = fakeJudge()
  await assert.rejects(judgeOptimizationPair(memory, before, after, undefined, { fetch: fake.request }), /DEEPSEEK_API_KEY/)
  assert.equal(fake.calls.length, 0)
}))
test('changed evidence, answer, completion or judge model invalidates a saved grade', async () => configured(async () => {
  const review = (await judgeOptimizationPair(memory, before, after, undefined, { fetch: fakeJudge().request })).before
  assert.equal(currentJudgeReview(memory, before, review), true)
  assert.equal(currentJudgeReview(memory, { ...before, content: 'Changed' }, review), false)
  assert.equal(currentJudgeReview(memory, { ...before, doneReason: 'length' }, review), false)
  assert.equal(currentJudgeReview({ ...memory, materials: [{ title: 'doc', text: 'Changed' }] }, before, review), false)
  process.env.DEEPSEEK_JUDGE_MODEL = 'other-model'
  assert.equal(currentJudgeReview(memory, before, review), false)
}))
test('pair review preserves all answers and metrics, isolates cloud errors, and counts only actual reviews', async () => configured(async () => {
  const report = emptyComparisonReport()
  report.samples = [{ profileId: 'baseline', caseId: memory.id, repetition: 1, answer: before }, { profileId: 'optimized', caseId: memory.id, repetition: 1, answer: after }]
  const rated = await judgeReportCase(report, memory.id, undefined, { fetch: fakeJudge().request })
  assert.ok(rated.samples.every((sample) => sample.review))
  assert.equal(rated.samples[0].answer, before)
  assert.equal(summarizeJudgeReviews(rated.samples).meanScore, 7)
  assert.equal(summarizeJudgeReviews(report.samples).meanScore, undefined)
  const failed = await judgeReportCase(report, memory.id, undefined, { fetch: fakeJudge({ status: 500 }).request })
  assert.ok(failed.samples.every((sample) => sample.reviewError && !sample.review))
  assert.deepEqual(failed.samples.map((sample) => sample.answer), [before, after])
  const abort = new AbortController(); abort.abort()
  await assert.rejects(judgeReportCase(report, memory.id, abort.signal, { fetch: fakeJudge().request }))
  assert.ok(report.samples.every((sample) => !sample.review && !sample.reviewError))
}))
test('parameter selection uses semantic reviews, never lexical matches, and rejects unreviewed or cut answers', async () => configured(async () => {
  const grade = (await judgeOptimizationPair(memory, before, after, undefined, { fetch: fakeJudge().request })).before
  const sample = { profileId: 'optimized' as const, caseId: memory.id, repetition: 1, answer: after, review: { ...grade, score: 9 } }
  assert.ok(reviewedOptimizationScore([sample]) > reviewedOptimizationScore([{ ...sample, review: { ...grade, score: 3 } }]))
  assert.ok(reviewedOptimizationScore([sample]) > reviewedOptimizationScore([{ ...sample, review: undefined }]))
  assert.ok(reviewedOptimizationScore([sample]) > reviewedOptimizationScore([{ ...sample, answer: { ...after, doneReason: 'length' } }]))
}))
