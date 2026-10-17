import 'dotenv/config'
import './network-config'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { summarizeJudgeReviews } from '../src/llm-optimization'
import { loadComparisonReport, saveComparisonReport } from './llm-optimization-comparison'
import { currentJudgeReview, optimizationJudgeSettings } from './llm-optimization-judge'
import { reviewOptimizationCases } from './llm-optimization-runner'

const args = process.argv.slice(2)
if (args.some((arg) => !arg.startsWith('--case=') && !arg.startsWith('--output=') && arg !== '--force')) throw new Error('Флаги: --case=memory --output=docs/day-29-judge-results.json --force')
const settings = optimizationJudgeSettings()
if (!settings.ready) throw new Error('Настройте DEEPSEEK_API_KEY в .env.')
const caseId = args.find((arg) => arg.startsWith('--case='))?.slice(7)
const output = resolve(args.find((arg) => arg.startsWith('--output='))?.slice(9) || 'docs/day-29-judge-results.json')
const abort = new AbortController()
process.once('SIGINT', () => abort.abort())
process.once('SIGTERM', () => abort.abort())
let report = await loadComparisonReport()
const cases = report.cases.filter((test) => !caseId || test.id === caseId)
if (!cases.length) throw new Error('Неизвестный вопрос.')
const save = async () => {
  await saveComparisonReport(report)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output + '.tmp', JSON.stringify(report, null, 2) + '\n'); await rename(output + '.tmp', output)
}
try {
  console.log(`Агент проверки: ${settings.model}, thinking=enabled, effort=high, параллельно до ${settings.concurrency} пар`)
  const pending = cases.filter((test) => {
    const pair = ['baseline', 'optimized'].map((id) => report.samples.find((sample) => sample.caseId === test.id && sample.profileId === id))
    if (!pair.every((sample) => sample?.answer)) { console.log(`${test.id}: нет пары ответов, пропуск`); return false }
    if (!args.includes('--force') && pair.every((sample) => !sample!.reviewError && currentJudgeReview(test, sample!.answer!, sample!.review))) { console.log(`${test.id}: актуальная оценка сохранена`); return false }
    return true
  })
  const started = new Set<string>()
  report = await reviewOptimizationCases({ report, caseIds: pending.map((test) => test.id), signal: abort.signal, concurrency: settings.concurrency,
    onProgress: (progress) => { for (const id of progress.reviewingCaseIds) if (!started.has(id)) { started.add(id); console.log(`Проверяем: ${id}`) } },
    onReport: async (next, reviewedCaseId) => {
      report = next; await save()
      for (const sample of report.samples.filter((item) => item.caseId === reviewedCaseId)) console.log(`${sample.caseId} · ${sample.profileId}: ${sample.reviewError || `${sample.review!.score}/10 · ${sample.review!.verdict} · ${sample.review!.rationale}`}`)
    },
  })
  for (const id of ['baseline', 'optimized']) console.log(id, JSON.stringify(summarizeJudgeReviews(report.samples.filter((sample) => sample.profileId === id))))
  if (report.samples.some((sample) => sample.reviewError)) process.exitCode = 1
} catch (error) { console.error(abort.signal.aborted ? 'Проверка остановлена; завершённые оценки сохранены.' : String(error)); process.exitCode = 1 }
console.log('Отчёт: ' + output)
