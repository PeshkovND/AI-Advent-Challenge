import test from 'node:test'
import assert from 'node:assert/strict'
import type { OptimizationProgress, OptimizationReport, OptimizationSample } from '../src/llm-optimization'
import { emptyComparisonReport } from './llm-optimization-comparison'
import { compareOptimizationCases, mergeJudgeCase, reviewOptimizationCases } from './llm-optimization-runner'
import type { judgeReportCase } from './llm-optimization-judge'
import type { benchmarkOptimization } from './llm-optimization-service'

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function reportWithPairs(count: number) {
  const report = emptyComparisonReport()
  report.cases = report.cases.slice(0, count)
  report.samples = report.cases.flatMap((item) => ['baseline', 'optimized'].map((profileId) => ({ profileId, caseId: item.id, repetition: 1,
    answer: { content: `${item.id}/${profileId}`, doneReason: 'stop', metrics: { wallMs: 123, outputTokens: 45 } },
  } as OptimizationSample)))
  return report
}
function reviewed(report: OptimizationReport, id: string) {
  return { ...report, samples: report.samples.map((sample) => sample.caseId !== id ? sample : { ...sample, review: {
    accuracy: 5, completeness: 5, grounding: 5, citations: 5, verdict: 'correct' as const, rationale: 'Проверено.', errors: [], omissions: [], score: 10,
    model: 'fake', returnedModel: 'fake', rubricVersion: 'fake', inputHash: 'fake', evaluatedAt: '2026-10-12', blindLabel: 'A' as const, wallMs: 999,
  } }) }
}
function controlledJudge(ids: string[]) {
  const gates = new Map(ids.map((id) => [id, { started: deferred(), done: deferred() }]))
  const calls: string[] = []
  let active = 0, maximum = 0
  const judge: typeof judgeReportCase = async (report, id, signal) => {
    calls.push(id); active++; maximum = Math.max(maximum, active)
    const gate = gates.get(id)!, abort = () => gate.done.reject(signal!.reason)
    signal?.addEventListener('abort', abort, { once: true })
    gate.started.resolve()
    try { signal?.throwIfAborted(); await gate.done.promise; return reviewed(report, id) }
    finally { active--; signal?.removeEventListener('abort', abort) }
  }
  return { judge, gates, calls, maximum: () => maximum }
}

test('parallel reviews have bounded concurrency, serialize saves and merge out-of-order results without losing metrics', async () => {
  const report = reportWithPairs(5), ids = report.cases.map((item) => item.id), fake = controlledJudge(ids)
  const saved: OptimizationReport[] = [], progress: OptimizationProgress[] = []
  let writers = 0, maxWriters = 0
  const run = reviewOptimizationCases({ report, caseIds: ids, concurrency: 3,
    onProgress: (item) => { progress.push(item) },
    onReport: async (next) => { writers++; maxWriters = Math.max(maxWriters, writers); await Promise.resolve(); saved.push(next); writers-- },
  }, { judge: fake.judge })
  await Promise.all(ids.slice(0, 3).map((id) => fake.gates.get(id)!.started.promise))
  assert.deepEqual(fake.calls, ids.slice(0, 3))
  fake.gates.get(ids[1])!.done.resolve()
  await fake.gates.get(ids[3])!.started.promise
  assert.ok(saved[0].samples.filter((sample) => sample.caseId === ids[1]).every((sample) => sample.review))
  fake.gates.get(ids[3])!.done.resolve()
  await fake.gates.get(ids[4])!.started.promise
  for (const id of [ids[4], ids[2], ids[0]]) fake.gates.get(id)!.done.resolve()
  const result = await run
  assert.equal(fake.maximum(), 3); assert.equal(maxWriters, 1)
  assert.equal(saved.length, 5)
  assert.ok(result.samples.every((sample) => sample.review && !sample.reviewError))
  assert.deepEqual(result.samples.map((sample) => sample.answer), report.samples.map((sample) => sample.answer))
  assert.ok(progress.every((item) => item.reviewingCaseIds.length <= 3))
  assert.equal(progress[progress.length - 1].reviewed, 5)
  assert.deepEqual(progress[progress.length - 1].reviewingCaseIds, [])
})

test('generation stays serial while three independent DeepSeek requests overlap it; new samples preserve arriving grades', async () => {
  const initial = reportWithPairs(4), ids = initial.cases.map((item) => item.id), fake = controlledJudge(ids)
  initial.samples = []
  const saved: OptimizationReport[] = [], localCalls: string[] = [], progress: OptimizationProgress[] = []
  let localActive = 0, localMaximum = 0
  const benchmark: typeof benchmarkOptimization = async (options) => {
    localActive++; localMaximum = Math.max(localMaximum, localActive)
    const id = options!.cases![0].id
    localCalls.push(id)
    try {
      const generated = reportWithPairs(4)
      const pair = generated.samples.filter((sample) => sample.caseId === id)
      generated.samples = [pair[0]]
      await options!.onProgress!(generated)
      generated.samples = pair
      await options!.onProgress!(generated)
      return generated
    } finally { localActive-- }
  }
  const run = compareOptimizationCases({ report: initial, caseIds: ids, judgeEnabled: true, concurrency: 3,
    onReport: (next) => { saved.push(next) }, onProgress: (item) => { progress.push(item) },
  }, { benchmark, judge: fake.judge })
  await Promise.all(ids.slice(0, 3).map((id) => fake.gates.get(id)!.started.promise))
  assert.deepEqual(localCalls, ids.slice(0, 3))
  assert.ok(progress.some((item) => item.generatingCaseId === ids[2] && item.reviewingCaseIds.length > 0))
  fake.gates.get(ids[1])!.done.resolve()
  await fake.gates.get(ids[3])!.started.promise
  assert.ok(saved[saved.length - 1].samples.filter((sample) => sample.caseId === ids[1]).every((sample) => sample.review))
  for (const id of [ids[0], ids[2], ids[3]]) fake.gates.get(id)!.done.resolve()
  const result = await run
  assert.equal(localMaximum, 1); assert.equal(fake.maximum(), 3)
  assert.equal(result.samples.length, 8)
  assert.ok(result.samples.every((sample) => sample.review))
  assert.deepEqual(result.samples.map((sample) => sample.answer), reportWithPairs(4).samples.map((sample) => sample.answer))
})

test('one failed evaluation does not discard other parallel grades or local answers', async () => {
  const report = reportWithPairs(4), ids = report.cases.map((item) => item.id)
  const judge: typeof judgeReportCase = async (snapshot, id) => id === ids[1]
    ? { ...snapshot, samples: snapshot.samples.map((sample) => sample.caseId === id ? { ...sample, reviewError: 'DeepSeek: 429' } : sample) }
    : reviewed(snapshot, id)
  const result = await reviewOptimizationCases({ report, caseIds: ids, concurrency: 3 }, { judge })
  assert.equal(result.samples.filter((sample) => sample.reviewError).length, 2)
  assert.equal(result.samples.filter((sample) => sample.review).length, 6)
  assert.deepEqual(result.samples.map((sample) => sample.answer), report.samples.map((sample) => sample.answer))
})

test('cancel stops all in-flight reviews, starts no more jobs and waits for cleanup while retaining completed grades', async () => {
  const report = reportWithPairs(5), ids = report.cases.map((item) => item.id), fake = controlledJudge(ids), abort = new AbortController()
  let saved = report, saves = 0
  const savedFirst = deferred()
  const run = reviewOptimizationCases({ report, caseIds: ids, concurrency: 2, signal: abort.signal,
    onReport: (next) => { saved = next; saves++; savedFirst.resolve() },
  }, { judge: fake.judge })
  await Promise.all(ids.slice(0, 2).map((id) => fake.gates.get(id)!.started.promise))
  fake.gates.get(ids[0])!.done.resolve()
  await savedFirst.promise
  abort.abort()
  await assert.rejects(run, { name: 'AbortError' })
  assert.deepEqual(fake.calls, ids.slice(0, 2))
  assert.equal(saved.samples.filter((sample) => sample.review).length, 2)
  assert.equal(saves, 1)
  await Promise.resolve()
  assert.equal(saves, 1)
})

test('stale pair results cannot overwrite a regenerated answer or changed evidence', () => {
  const report = reportWithPairs(2), id = report.cases[0].id, judged = reviewed(report, id)
  const newer = structuredClone(report)
  newer.samples[0].answer!.content = 'Новый ответ'
  assert.equal(mergeJudgeCase(newer, judged, id), newer)
  const changedEvidence = structuredClone(report)
  changedEvidence.cases[0].materials[0].text = 'Другие материалы'
  assert.equal(mergeJudgeCase(changedEvidence, judged, id), changedEvidence)
})

test('serial mode and invalid concurrency never start extra cloud requests', async () => {
  const report = reportWithPairs(2), ids = report.cases.map((item) => item.id), fake = controlledJudge(ids)
  const run = reviewOptimizationCases({ report, caseIds: ids, concurrency: 1 }, { judge: fake.judge })
  await fake.gates.get(ids[0])!.started.promise
  assert.deepEqual(fake.calls, [ids[0]])
  fake.gates.get(ids[0])!.done.resolve()
  await fake.gates.get(ids[1])!.started.promise
  fake.gates.get(ids[1])!.done.resolve()
  await run
  assert.equal(fake.maximum(), 1)
  for (const concurrency of [0, 6, 1.5]) await assert.rejects(reviewOptimizationCases({ report, caseIds: ids, concurrency }, { judge: fake.judge }), /от 1 до 5/)
  assert.equal(fake.calls.length, 2)
})
