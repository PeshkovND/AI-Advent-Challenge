import 'dotenv/config'
import './network-config'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Agent, LlmClient, createRagCompletion, normalizeRagConfig } from './agent-service'
import { RagRetriever } from './rag-retrieval'
import { RagIndexStore } from './rag-indexer'
import { ragQuestions } from '../src/rag-questions'
import { day23Questions } from '../src/rag-day23-questions'
import { defaultRagSettings, improvedAgentConfig, ragModeLabels, ragModes, type RagMode } from '../src/rag-improved-config'
import { reportStats } from '../src/rag-evaluation'
import type { RagReport, RagRunResult } from '../src/rag-report-store'

const args = process.argv.slice(2)
const values = new Map<string, string>()
const flags = new Set<string>()
const allowedValues = new Set(['--strategy', '--candidate-top-k', '--top-k', '--min-relevance', '--min-similarity', '--modes', '--question-id', '--output', '--index-id'])
for (let i = 0; i < args.length; i++) {
  const argument = args[i]
  if (argument === '--answers' || argument === '--extended') flags.add(argument)
  else if (allowedValues.has(argument) && args[i + 1] && !args[i + 1].startsWith('--')) values.set(argument, args[++i])
  else throw new Error(`Неизвестный параметр или отсутствует значение: ${argument}`)
}
const numberOption = (key: string, fallback: number) => values.has(key) ? Number(values.get(key)) : fallback
const strategy = values.get('--strategy') ?? defaultRagSettings.strategy
if (strategy !== 'fixed' && strategy !== 'structured') throw new Error('Стратегия: fixed или structured.')
const settings = { ...defaultRagSettings, strategy, candidateTopK: numberOption('--candidate-top-k', 20), topK: numberOption('--top-k', 4), minRelevance: numberOption('--min-relevance', 2), ...(values.has('--min-similarity') ? { minSimilarity: Number(values.get('--min-similarity')) } : {}) } as typeof defaultRagSettings
if (!Number.isInteger(settings.topK) || settings.topK < 1 || settings.topK > 8) throw new Error('Top-K для ответа: целое число 1–8.')
for (const mode of ragModes) normalizeRagConfig(improvedAgentConfig(mode, settings, 'validation').rag)
const modes = (values.get('--modes') ?? 'baseline,full').split(',') as RagMode[]
if (new Set(modes).size !== modes.length || modes.some((mode) => !ragModes.includes(mode))) throw new Error('Режимы: baseline,rerank,rewrite,full; без повторов.')
const allQuestions = flags.has('--extended') ? day23Questions : ragQuestions
const questions = values.has('--question-id') ? allQuestions.filter((question) => question.id === Number(values.get('--question-id'))) : allQuestions
if (!questions.length) throw new Error('Контрольный вопрос не найден.')
const store = new RagIndexStore()
const index = values.has('--index-id') ? store.getRun(values.get('--index-id')!) : store.latestRun()
store.close()
if (!index) throw new Error('Индекс не найден. Выполните npm run rag:index.')
const client = new LlmClient({ deepSeekApiKey: process.env.DEEPSEEK_API_KEY?.trim(), defaultDeepSeekModel: 'deepseek-v4-flash' })
const report: RagReport = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), index, settings, modes, questions, results: {}, completed: false }
const outputPath = resolve(values.get('--output') ?? `data/rag-day23/${report.id}.json`)
console.log(`Индекс ${index.id}; ${strategy}; ${settings.candidateTopK} → ${settings.topK}; порог ${settings.minRelevance}; ${flags.has('--answers') ? 'с ответами LLM' : 'только поиск'}`)
if (modes.some((mode) => mode !== 'baseline') || flags.has('--answers')) console.log('Вопросы и найденные фрагменты будут отправлены в DeepSeek для включённых LLM-этапов.')
let failures = 0
for (const question of questions) {
  report.results[question.id] = { answers: {}, errors: {}, grades: {} }
  for (const mode of modes) {
    try {
      const config = improvedAgentConfig(mode, settings, index.id)
      const startedAt = Date.now()
      let answer: RagRunResult
      if (flags.has('--answers')) answer = await new Agent(`day23-evaluation-${mode}`, config, client).run(question.question) as RagRunResult
      else {
        const context = await new RagRetriever().retrieve(question.question, config.rag, createRagCompletion(client, config))
        answer = { output: 'Проверка поиска: генерация ответа не запускалась.', durationMs: Date.now() - startedAt, model: config.model, totalTokens: context.trace?.usage.totalTokens ?? 0, rag: { indexRunId: context.indexRunId, sources: context.sources, trace: context.trace } }
      }
      report.results[question.id].answers[mode] = answer
      console.log(`${question.id} · ${ragModeLabels[mode]} · ${answer.rag?.trace?.candidates.length} → ${answer.rag?.sources.length} · ${answer.totalTokens} токенов · ${answer.durationMs} мс`)
    } catch (error) {
      failures += 1; report.results[question.id].errors[mode] = String(error); console.error(`${question.id} · ${mode}: ${String(error)}`)
    }
  }
}
report.completed = true
const statistics = Object.fromEntries(modes.map((mode) => [mode, reportStats(report, mode)]))
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, JSON.stringify({ ...report, generatedAnswers: flags.has('--answers'), statistics }, null, 2), { flag: 'wx' })
console.log(JSON.stringify(statistics, null, 2))
console.log(`Отчёт: ${outputPath}`)
if (failures) process.exitCode = 1
