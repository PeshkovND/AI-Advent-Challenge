import { ragAgentBaseConfig } from './rag-agent-config'
import { defaultRagSettings, improvedAgentConfig } from './rag-improved-config'
import type { RagReport, RagRunResult } from './rag-report-store'
import { ragQuestions } from './rag-questions'
import type { RagConfig } from './rag-types'

export const demoModes = ['without', 'structured', 'fixed', 'improved'] as const
export type DemoMode = typeof demoModes[number]
export const demoAgentIds: Record<DemoMode, string> = { without: 'day22-without-rag', structured: 'day22-with-rag', fixed: 'day22-with-rag-fixed', improved: 'day23-full' }
export const demoLabels: Record<DemoMode, string> = { without: 'Без RAG', structured: 'RAG · structured', fixed: 'RAG · fixed', improved: 'Улучшенный RAG' }
export type DemoComparison = Partial<Record<DemoMode, RagRunResult>> & { errors?: Partial<Record<DemoMode, string>> }
export type DemoSnapshot = { createdAt: string; indexRunId?: string; results: Record<number, DemoComparison> }

export function demoAgentConfig(mode: DemoMode, indexRunId: string): typeof ragAgentBaseConfig & { name: string; rag?: RagConfig } {
  if (mode === 'improved') return improvedAgentConfig('full', defaultRagSettings, indexRunId)
  return { ...ragAgentBaseConfig, name: `Day 22 · ${demoLabels[mode]}`, ...(mode !== 'without' ? { rag: { enabled: true, strategy: mode, topK: 4, indexRunId } } : {}) }
}

/** Restore actual Day 23 answers without regenerating or mixing different runs. */
export function restoreDemoReport(reports: RagReport[]): DemoSnapshot | undefined {
  const compatible = reports.filter((report) => report.settings.strategy === 'structured' && report.settings.topK === 4
    && report.settings.candidateTopK === 20 && report.settings.minRelevance === 2 && report.settings.minSimilarity === undefined
    && report.modes.includes('baseline') && report.modes.includes('full'))
  const matching = (report: RagReport) => ragQuestions.filter((question) => report.questions.some((saved) => saved.id === question.id && saved.question === question.question))
  const count = (report: RagReport) => matching(report).filter((question) => report.results[question.id]?.answers.baseline?.rag?.indexRunId === report.index.id
    && report.results[question.id]?.answers.full?.rag?.indexRunId === report.index.id).length
  const selected = compatible.sort((a, b) => count(b) - count(a) || b.createdAt.localeCompare(a.createdAt))[0]
  if (!selected || count(selected) === 0) return undefined
  const results: DemoSnapshot['results'] = {}
  for (const question of matching(selected)) {
    const comparison = selected.results[question.id]
    if (!comparison) continue
    const structured = comparison.answers.baseline, improved = comparison.answers.full
    if (structured?.rag?.indexRunId !== selected.index.id || improved?.rag?.indexRunId !== selected.index.id) continue
    results[question.id] = { structured, improved }
  }
  return { createdAt: selected.createdAt, indexRunId: selected.index.id, results }
}
