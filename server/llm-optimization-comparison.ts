import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { optimizationProfiles, summarizeOptimization, type OptimizationReport } from '../src/llm-optimization'
import { optimizationDemoCases, optimizationSuiteId } from '../src/llm-optimization-cases'
import { optimizationSettings } from './llm-optimization-service'
import { currentJudgeReview } from './llm-optimization-judge'

export function emptyComparisonReport(): OptimizationReport {
  const { model } = optimizationSettings()
  const profiles = optimizationProfiles.filter((item) => item.id === 'baseline' || item.id === 'optimized').map((item) => ({ ...item, model }))
  return { version: 1, suiteId: optimizationSuiteId, startedAt: new Date().toISOString(), repetitions: 1,
    cases: optimizationDemoCases, profiles, models: [], warmups: [], samples: [], summaries: summarizeOptimization([], profiles),
    notes: ['Сравнение до/после на одинаковых материалах. На странице хранится одна актуальная пара ответов на каждый вопрос. Прогрев исключён из времени ответа.'] }
}
export function compatibleComparisonReport(value: unknown): value is OptimizationReport {
  const report = value as OptimizationReport | null
  const current = emptyComparisonReport()
  return Boolean(report && report.version === 1 && report.suiteId === optimizationSuiteId && Array.isArray(report.samples)
    && JSON.stringify(report.cases) === JSON.stringify(current.cases) && Array.isArray(report.profiles)
    && JSON.stringify(report.profiles.filter((item) => item.id === 'baseline' || item.id === 'optimized')) === JSON.stringify(current.profiles))
}
export async function loadComparisonReport(): Promise<OptimizationReport> {
  for (const path of ['data/day-29-heavy-comparison.json', 'docs/day-29-heavy-results.json']) {
    try {
      const value: unknown = JSON.parse(await readFile(resolve(path), 'utf8'))
      if (!compatibleComparisonReport(value)) continue
      const profiles = value.profiles.filter((item) => item.id === 'baseline' || item.id === 'optimized')
      const samples = value.samples.filter((item) => item.repetition === 1 && profiles.some((profile) => profile.id === item.profileId)).map((sample) => {
        const test = value.cases.find((item) => item.id === sample.caseId)
        if (!sample.review || test && sample.answer && currentJudgeReview(test, sample.answer, sample.review)) return sample
        const { review: _stale, ...current } = sample
        return current
      })
      return { ...value, repetitions: 1, profiles, samples, summaries: summarizeOptimization(samples, profiles) }
    } catch { /* Try the next compatible report. */ }
  }
  return emptyComparisonReport()
}
export async function saveComparisonReport(report: OptimizationReport) {
  const directory = resolve('data'), output = resolve(directory, 'day-29-heavy-comparison.json')
  await mkdir(directory, { recursive: true })
  await writeFile(output + '.tmp', JSON.stringify(report, null, 2) + '\n')
  await rename(output + '.tmp', output)
}

export function mergeQuestionReport(previous: OptimizationReport, progress: OptimizationReport, caseId: string): OptimizationReport {
  const samples = [...previous.samples.filter((item) => item.caseId !== caseId), ...progress.samples]
  const complete = previous.cases.every((test) => previous.profiles.every((profile) => samples.some((sample) => sample.caseId === test.id && sample.profileId === profile.id)))
  const { finishedAt: _finished, cancelled: _cancelled, ...base } = previous
  return { ...base, models: progress.models, samples, warmups: progress.warmups,
    summaries: summarizeOptimization(samples, previous.profiles), ...(complete ? { finishedAt: new Date().toISOString() } : {}), ...(progress.cancelled ? { cancelled: true } : {}) }
}
