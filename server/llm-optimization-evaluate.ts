import 'dotenv/config'
import './network-config'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { benchmarkOptimization } from './llm-optimization-service'
import { optimizationProfiles } from '../src/llm-optimization'
import { optimizationDemoCases, optimizationSuiteId } from '../src/llm-optimization-cases'

const args = process.argv.slice(2)
const repetitionsArg = args.find((arg) => arg.startsWith('--repetitions='))
const outputArg = args.find((arg) => arg.startsWith('--output='))
if (args.some((arg) => arg !== '--q8' && arg !== '--heavy' && !arg.startsWith('--repetitions=') && !arg.startsWith('--output='))) throw new Error('Флаги: --heavy --q8 --repetitions=2 --output=docs/day-29-results.json')
const heavy = args.includes('--heavy')
const output = resolve(outputArg?.slice('--output='.length) || (heavy ? 'data/day-29-heavy-comparison.json' : 'data/day-29-optimization.json'))
const abort = new AbortController()
process.once('SIGINT', () => abort.abort())
process.once('SIGTERM', () => abort.abort())
let previousCount = -1
try {
  const report = await benchmarkOptimization({ includeQ8: args.includes('--q8'), repetitions: repetitionsArg ? Number(repetitionsArg.split('=')[1]) : 2,
    ...(heavy ? { cases: optimizationDemoCases, profiles: optimizationProfiles.filter((item) => item.id === 'baseline' || item.id === 'optimized' || args.includes('--q8') && item.id === 'q8'), suiteId: optimizationSuiteId, timeoutMs: 120000 } : {}),
    signal: abort.signal, onProgress: async (value) => {
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output + '.tmp', JSON.stringify(value, null, 2) + '\n')
      await rename(output + '.tmp', output)
      if (value.samples.length !== previousCount) {
        previousCount = value.samples.length
        const last = value.samples[value.samples.length - 1]
        if (last) console.log(`${last.profileId} / ${last.caseId} / повтор ${last.repetition}: ${last.error || `${(last.answer!.metrics.wallMs / 1000).toFixed(2)} с, факты ${last.quality!.factsPassed ? 'OK' : 'FAIL'}, протокол ${last.quality!.protocolPassed ? 'OK' : 'FAIL'}`}`)
        else console.log('Прогон начат; отчёт: ' + output)
      }
    } })
  console.table(report.summaries)
  console.log('Отчёт: ' + output)
  if (report.cancelled || report.samples.some((item) => item.error)) process.exitCode = 1
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
