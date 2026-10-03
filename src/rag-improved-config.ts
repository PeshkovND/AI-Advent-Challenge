import type { RagConfig } from './rag-types'
import { ragAgentBaseConfig } from './rag-agent-config'

export const ragModes = ['baseline', 'rerank', 'rewrite', 'full'] as const
export type RagMode = typeof ragModes[number]
export const ragModeLabels: Record<RagMode, string> = { baseline: 'Базовый RAG', rerank: 'Реранкинг и фильтр', rewrite: 'Только query rewrite', full: 'Rewrite + реранкинг' }
export type RagSettings = { strategy: 'fixed' | 'structured'; candidateTopK: number; topK: number; minRelevance: number; minSimilarity?: number }
export const defaultRagSettings: RagSettings = { strategy: 'structured', candidateTopK: 20, topK: 4, minRelevance: 2 }
export const improvedAgentIds: Record<RagMode, string> = { baseline: 'day23-baseline', rerank: 'day23-rerank', rewrite: 'day23-rewrite', full: 'day23-full' }

export function improvedAgentConfig(mode: RagMode, settings: RagSettings, indexRunId: string) {
  const rerank = mode === 'rerank' || mode === 'full'
  const rag: RagConfig = {
    enabled: true, strategy: settings.strategy, topK: settings.topK, candidateTopK: settings.candidateTopK, indexRunId,
    ...((mode === 'rewrite' || mode === 'full') ? { queryRewrite: true } : {}),
    ...(rerank ? { rerank: { enabled: true, minRelevance: settings.minRelevance }, ...(settings.minSimilarity !== undefined ? { minSimilarity: settings.minSimilarity } : {}) } : {}),
  }
  return { ...ragAgentBaseConfig, name: `Day 23 · ${ragModeLabels[mode]}`, rag }
}
