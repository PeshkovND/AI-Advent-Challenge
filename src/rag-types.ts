export type RagConfig = {
  enabled: boolean
  strategy: 'fixed' | 'structured'
  /** Maximum number of passages sent to the answering model. */
  topK: number
  candidateTopK?: number
  minSimilarity?: number
  queryRewrite?: boolean
  rerank?: { enabled: boolean; minRelevance: number }
  indexRunId?: string
}
export type RagSource = {
  source: string; title: string; section: string; chunkId: string
  strategy: 'fixed' | 'structured'; score: number; text: string
}
export type RagUsage = { inputTokens: number; promptTokens: number; completionTokens: number; totalTokens: number }
export type RagCandidate = RagSource & {
  rankBefore: number; originalRank?: number; rewrittenRank?: number; fusionScore?: number
  relevance?: number; reason?: string; rankAfter?: number; selected: boolean
  rejection?: 'similarity' | 'relevance' | 'top-k'
}
export type RagTrace = {
  originalQuestion: string; searchQuery: string; candidateTopK: number; topK: number
  minSimilarity?: number; minRelevance?: number; candidates: RagCandidate[]
  rewrite: { status: 'disabled' | 'applied' | 'fallback'; durationMs: number; usage?: RagUsage; warning?: string }
  rerank: { status: 'disabled' | 'applied' | 'skipped'; durationMs: number; usage?: RagUsage; attempts?: number; warning?: string }
  timings: { embeddingMs: number; searchMs: number; totalMs: number }
  usage: RagUsage; emptyContext: boolean
}
export type RagResult = { indexRunId: string; sources: RagSource[]; trace?: RagTrace }
