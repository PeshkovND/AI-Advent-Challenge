import 'dotenv/config'
import './network-config'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { optimizationProfiles, reviewedOptimizationScore, type OptimizationProfile, type OptimizationReport } from '../src/llm-optimization'
import { optimizationHeavyCases, tuningCaseIds } from '../src/llm-optimization-cases'
import { benchmarkOptimization } from './llm-optimization-service'
import { judgeOptimizationPair, optimizationJudgeSettings } from './llm-optimization-judge'

const stages = [
  { parameter: 'context', values: [8192, 16384, 32768] },
  { parameter: 'maxTokens', values: [256, 512, 1024] },
  { parameter: 'temperature', values: [0, 0.2, 0.5] },
  { parameter: 'topP', values: [0.85, 0.95] },
] as const
const abort = new AbortController()
process.once('SIGINT', () => abort.abort())
process.once('SIGTERM', () => abort.abort())
const cases = optimizationHeavyCases.filter((item) => tuningCaseIds.includes(item.id))
const output = resolve('docs/day-29-tuning-agent.json')
let selected: OptimizationProfile = { ...optimizationProfiles.find((item) => item.id === 'optimized')!, adaptiveContext: false, context: 32768, maxTokens: 1024, temperature: 0, topP: 0.95 }
type Trial = { parameter: typeof stages[number]['parameter']; value: number; profile: OptimizationProfile; report: OptimizationReport }
const trials: Trial[] = []
let adaptiveValidation: OptimizationReport | undefined
let baselineReference: OptimizationReport | undefined
const score = (trial: Trial) => reviewedOptimizationScore(trial.report.samples)
async function evaluate(report: OptimizationReport) {
  report.notes.push('Качество для выбора параметров оценивает независимый агент DeepSeek; текстовые проверки сохраняются только как диагностика.')
  for (const sample of report.samples) {
    if (!sample.answer) continue
    const test = cases.find((item) => item.id === sample.caseId)!
    const reference = baselineReference!.samples.find((item) => item.caseId === sample.caseId)!.answer!
    const review = await judgeOptimizationPair(test, reference, sample.answer, abort.signal)
    sample.review = review.after
    console.log(`DeepSeek / ${sample.caseId}: ${sample.review.score}/10 — ${sample.review.verdict}`)
    await save()
  }
}
async function save(finished = false) {
  await mkdir(resolve('docs'), { recursive: true })
  const report = { version: 1, method: 'Последовательный подбор одного параметра за этап; остальные зафиксированы. Это не полный совместный grid search.',
    caseIds: cases.map((item) => item.id), judgeModel: optimizationJudgeSettings().model, stages, trials, selected, baselineReference, ...(adaptiveValidation ? { adaptiveValidation } : {}), ...(finished ? { finishedAt: new Date().toISOString() } : {}) }
  await writeFile(output + '.tmp', JSON.stringify(report, null, 2) + '\n'); await rename(output + '.tmp', output)
}
try {
  if (!optimizationJudgeSettings().ready) throw new Error('Для подбора с семантической оценкой настройте DEEPSEEK_API_KEY. Текстовые проверки не заменяют агента.')
  baselineReference = await benchmarkOptimization({ repetitions: 1, cases, profiles: [optimizationProfiles.find((item) => item.id === 'baseline')!], signal: abort.signal })
  if (baselineReference.cancelled || baselineReference.samples.some((sample) => !sample.answer)) throw new Error('Не получены все исходные ответы; подбор не начат.')
  await save()
  for (const stage of stages) {
    const candidates: Trial[] = []
    for (const value of stage.values) {
      abort.signal.throwIfAborted()
      const profile = { ...selected, [stage.parameter]: value }
      console.log(`${stage.parameter}=${value}: ${cases.length} тяжёлых вопросов`)
      const report = await benchmarkOptimization({ repetitions: 1, cases, profiles: [profile], signal: abort.signal })
      if (report.cancelled) throw new Error('Подбор остановлен.')
      const trial = { parameter: stage.parameter, value, profile, report }
      trials.push(trial); candidates.push(trial); await save()
      await evaluate(report)
      console.log(JSON.stringify(report.summaries[0]))
    }
    candidates.sort((a, b) => score(b) - score(a) || (stage.parameter === 'topP'
      ? Math.abs(a.value - 0.95) - Math.abs(b.value - 0.95) : a.value - b.value))
    selected = candidates[0].profile
    console.log(`Выбран ${stage.parameter}=${selected[stage.parameter]}`)
    await save()
  }
  if (trials.every((trial) => trial.report.summaries[0].errors === cases.length)) throw new Error('Ни один вариант не выполнил запросы; настройки не сохранены.')
  const adapted = { ...selected, adaptiveContext: true }
  console.log('Проверяем выбор окна по длине входа')
  adaptiveValidation = await benchmarkOptimization({ repetitions: 1, cases, profiles: [adapted], signal: abort.signal })
  if (adaptiveValidation.cancelled) throw new Error('Подбор остановлен.')
  await evaluate(adaptiveValidation)
  const fixed = [...trials].reverse().find((trial) => trial.value === selected.topP && trial.parameter === 'topP')!.report
  if (!adaptiveValidation.summaries[0].errors && reviewedOptimizationScore(adaptiveValidation.samples) >= reviewedOptimizationScore(fixed.samples)) selected = adapted
  await writeFile(resolve('src/llm-optimized-settings.json'), JSON.stringify({ temperature: selected.temperature, maxTokens: selected.maxTokens, context: selected.context, topP: selected.topP, adaptiveContext: selected.adaptiveContext }, null, 2) + '\n')
  await save(true)
  console.log('Выбранные настройки сохранены в src/llm-optimized-settings.json; подбор с агентом: ' + output)
} catch (error) { await save(); console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
