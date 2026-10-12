import type { OptimizationProgress, OptimizationReport } from '../src/llm-optimization'
import { optimizationProfiles } from '../src/llm-optimization'
import { optimizationSuiteId } from '../src/llm-optimization-cases'
import { mergeQuestionReport } from './llm-optimization-comparison'
import { judgeReportCase, optimizationJudgeSettings } from './llm-optimization-judge'
import { benchmarkOptimization } from './llm-optimization-service'

type RunOptions = {
  report: OptimizationReport; caseIds: string[]; signal?: AbortSignal; concurrency?: number
  onReport?: (report: OptimizationReport, reviewedCaseId?: string) => Promise<void> | void
  onProgress?: (progress: OptimizationProgress) => Promise<void> | void
  onCaseError?: (caseId: string, error: string) => Promise<void> | void
}
type Dependencies = { judge?: typeof judgeReportCase; benchmark?: typeof benchmarkOptimization }

function serialTasks() {
  let tail = Promise.resolve()
  return (work: () => Promise<void>) => {
    const next = tail.then(work)
    tail = next.catch(() => {})
    return next
  }
}

async function concurrentCases(ids: string[], concurrency: number, signal: AbortSignal | undefined, work: (id: string, signal: AbortSignal) => Promise<void>) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 5) throw new Error('Нужно от 1 до 5 параллельных проверок.')
  const abort = new AbortController(), combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
  let next = 0, failure: unknown
  const worker = async () => {
    try {
      while (next < ids.length) {
        combined.throwIfAborted()
        const id = ids[next++]
        await work(id, combined)
      }
    } catch (error) {
      if (!abort.signal.aborted) { failure = error; abort.abort(error) }
    }
  }
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, ids.length) }, worker))
  if (failure !== undefined) throw failure
  combined.throwIfAborted()
}

export function mergeJudgeCase(current: OptimizationReport, judged: OptimizationReport, caseId: string): OptimizationReport {
  const pair = judged.samples.filter((sample) => sample.caseId === caseId && sample.repetition === 1 && ['baseline', 'optimized'].includes(sample.profileId))
  if (pair.length !== 2 || JSON.stringify(current.cases.find((test) => test.id === caseId)) !== JSON.stringify(judged.cases.find((test) => test.id === caseId))
    || !pair.every((sample) => current.samples.some((target) => target.caseId === caseId && target.profileId === sample.profileId && target.repetition === sample.repetition && JSON.stringify(target.answer) === JSON.stringify(sample.answer)))) return current
  return { ...current, samples: current.samples.map((sample) => {
    const result = pair.find((item) => item.caseId === sample.caseId && item.profileId === sample.profileId && item.repetition === sample.repetition)
    if (!result) return sample
    const { review: _review, reviewError: _error, ...rest } = sample
    return { ...rest, ...(result.review ? { review: result.review } : {}), ...(result.reviewError ? { reviewError: result.reviewError } : {}) }
  }) }
}

function runState(options: RunOptions, reviewTotal: number, concurrency: number) {
  let report = options.report, generatingCaseId: string | undefined, reviewed = 0
  const active = new Set<string>(), commit = serialTasks()
  const publish = (update?: (current: OptimizationReport) => OptimizationReport, caseId?: string) => commit(async () => {
    if (update) { report = update(report); await options.onReport?.(report, caseId) }
    await options.onProgress?.({ generatingCaseId, reviewingCaseIds: [...active], reviewed, reviewTotal, concurrency })
  })
  return {
    report: () => report, publish,
    generating: (id?: string) => { generatingCaseId = id },
    async review(id: string, signal: AbortSignal, judge: typeof judgeReportCase) {
      const snapshot = report
      active.add(id); await publish()
      try {
        const result = await judge(snapshot, id, signal)
        reviewed++
        await publish((current) => mergeJudgeCase(current, result, id), id)
      } finally { active.delete(id); await publish() }
    },
  }
}

export async function reviewOptimizationCases(options: RunOptions, dependencies: Dependencies = {}) {
  const concurrency = options.concurrency ?? optimizationJudgeSettings().concurrency
  const state = runState(options, options.caseIds.length, concurrency)
  await state.publish()
  await concurrentCases(options.caseIds, concurrency, options.signal, (id, signal) => state.review(id, signal, dependencies.judge || judgeReportCase))
  return state.report()
}

export async function compareOptimizationCases(options: RunOptions & { judgeEnabled?: boolean }, dependencies: Dependencies = {}) {
  const judgeEnabled = options.judgeEnabled ?? optimizationJudgeSettings().ready
  const concurrency = judgeEnabled ? options.concurrency ?? optimizationJudgeSettings().concurrency : 1
  const state = runState(options, judgeEnabled ? options.caseIds.length : 0, concurrency), generate = serialTasks()
  await state.publish()
  await concurrentCases(options.caseIds, concurrency, options.signal, async (id, signal) => {
    let generated = false
    await generate(async () => {
      signal.throwIfAborted()
      const test = state.report().cases.find((item) => item.id === id)
      if (!test) throw new Error('Неизвестный вопрос.')
      state.generating(id); await state.publish()
      try {
        await (dependencies.benchmark || benchmarkOptimization)({ cases: [test], profiles: optimizationProfiles.filter((item) => item.id === 'baseline' || item.id === 'optimized'),
          repetitions: 1, suiteId: optimizationSuiteId, timeoutMs: 120000, signal, onProgress: (progress) => state.publish((current) => mergeQuestionReport(current, progress, id)) })
        signal.throwIfAborted()
        generated = ['baseline', 'optimized'].every((profileId) => state.report().samples.some((sample) => sample.caseId === id && sample.profileId === profileId && sample.answer))
      } catch (error) {
        signal.throwIfAborted()
        await options.onCaseError?.(id, error instanceof Error ? error.message : String(error))
      } finally { state.generating(); await state.publish() }
    })
    if (generated && judgeEnabled) await state.review(id, signal, dependencies.judge || judgeReportCase)
  })
  return state.report()
}
