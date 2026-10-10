import type { RagGrounding, RagResult } from './rag-types'
import type { DemoMode } from './rag-demo-config'

export type LocalRagAnswer = {
  provider: 'local' | 'cloud'; model: string; output?: string; grounding?: RagGrounding; error?: string
  durationMs: number; answerMs: number; calls: number; promptTokens: number; outputTokens: number
  generationTokensPerSecond?: number
}
export type LocalRagComparison = {
  createdAt: string; question: string; mode: DemoMode; indexRunId: string
  rag?: RagResult; retrievalMs: number; local: LocalRagAnswer; cloud?: LocalRagAnswer
}
export type LocalRagStatus = {
  index?: { id: string; model: string; sourceCount: number; chunkCount: number; strategies: string[] }
  localModel: string; cloudModel: string; cloudAvailable: boolean; localReady: boolean; error?: string
}
export type LocalRagQuestionResult = Partial<Record<DemoMode, LocalRagComparison>> & { errors?: Partial<Record<DemoMode, string>> }
export type LocalRagSnapshot = {
  version: 2; createdAt: string; indexRunId: string; includeCloud: boolean
  results: Record<number, LocalRagQuestionResult>
}

export function speedSummary(comparisons: LocalRagComparison[], provider: 'local' | 'cloud') {
  const attempts = comparisons.flatMap((item) => item[provider] ? [item[provider]!] : [])
  const ok = attempts.filter((answer) => !answer.error)
  const durations = ok.map((answer) => answer.durationMs).sort((a, b) => a - b)
  const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
  return {
    attempts: attempts.length, errors: attempts.length - ok.length,
    averageMs: mean(durations),
    medianMs: durations.length ? (durations[Math.floor((durations.length - 1) / 2)] + durations[Math.floor(durations.length / 2)]) / 2 : null,
    retrievalMs: mean(comparisons.filter((item) => item[provider] && !item[provider]!.error).map((item) => item.retrievalMs)),
    answerMs: mean(ok.map((answer) => answer.answerMs)),
  }
}
