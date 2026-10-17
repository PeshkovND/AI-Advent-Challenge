import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { demoQuestions } from '../src/rag-demo-config'
import { speedSummary, type LocalRagComparison, type LocalRagSnapshot } from '../src/local-rag-types'

const modes = ['improved'] as const
const base = process.env.LOCAL_RAG_APP_URL || 'http://127.0.0.1:8787'
const response = await fetch(base + '/api/local-rag/status')
const status = await response.json()
if (!response.ok || !status.localReady || !status.index?.strategies.includes('structured')) throw new Error(status.error || 'Local RAG is not ready.')
const includeCloud = process.argv.includes('--cloud')
if (includeCloud && !status.cloudAvailable) throw new Error('Для --cloud настройте DEEPSEEK_API_KEY на сервере.')
const snapshot: LocalRagSnapshot = { version: 2, createdAt: new Date().toISOString(), indexRunId: status.index.id, includeCloud, results: {} }
const path = resolve(includeCloud ? 'data/day-28-rag-comparison-cloud.json' : 'data/day-28-rag-comparison.json')
await mkdir(resolve('data'), { recursive: true })
const summaries = () => Object.fromEntries(modes.map((mode) => {
  const comparisons = Object.values(snapshot.results).flatMap((result) => result[mode] ? [result[mode]!] : [])
  return [mode, { local: speedSummary(comparisons, 'local'), ...(includeCloud ? { cloud: speedSummary(comparisons, 'cloud') } : {}) }]
}))
async function save() {
  await writeFile(path, JSON.stringify({ ...snapshot, questions: demoQuestions, speed: summaries() }, null, 2) + '\n')
}
for (const question of demoQuestions) {
  snapshot.results[question.id] = {}
  for (const mode of modes) {
    console.log(question.id + '/11 · ' + mode + ' · ' + question.question)
    try {
      const response = await fetch(base + '/api/local-rag/compare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.question, includeCloud, mode, indexRunId: snapshot.indexRunId }),
        signal: AbortSignal.timeout(900000),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status)
      const comparison = result as LocalRagComparison
      snapshot.results[question.id][mode] = comparison
      console.log('local: ' + (comparison.local.error || comparison.local.grounding?.status || 'answered') + '; ' + (comparison.local.durationMs / 1000).toFixed(1) + ' s')
    } catch (error) {
      (snapshot.results[question.id].errors ??= {})[mode] = String(error)
      console.error(error)
    }
    await save()
  }
}
console.log(JSON.stringify(summaries(), null, 2))
console.log('Report: ' + path)
if (Object.values(snapshot.results).some((row) => Object.keys(row.errors || {}).length || modes.some((mode) => row[mode]?.local.error || row[mode]?.cloud?.error))) process.exitCode = 1
