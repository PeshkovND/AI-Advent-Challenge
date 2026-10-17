export type RagConfig = {
  enabled: boolean
  /** Always retrieve (legacy default), or let dialogue preparation decide. */
  retrievalPolicy?: 'always' | 'auto'
  strategy: 'fixed' | 'structured'
  /** Maximum number of passages sent to the answering model. */
  topK: number
  candidateTopK?: number
  minSimilarity?: number
  queryRewrite?: boolean
  rerank?: { enabled: boolean; minRelevance: number }
  /** Require literal citations and a semantic support check before releasing an answer. */
  grounding?: { enabled: boolean }
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
export type RagCitation = { id: number; source: string; section: string; chunkId: string; quote: string; kind?: 'dialogue' }
export type RagClaim = { id: number; text: string; citationIds: number[] }
export type RagTaskCheck = { goalAligned: boolean; constraintsRespected: boolean; answersQuestion: boolean; reason: string }
export type RagGrounding = {
  status: 'answered' | 'unknown'
  partial?: boolean
  answer: string
  sources: Array<{ source: string; section: string; chunkId: string; kind?: 'dialogue' }>
  citations: RagCitation[]
  claims: RagClaim[]
  clarification?: string
  reason?: 'weak-context' | 'insufficient-evidence' | 'unsupported-answer'
  verification: { status: 'passed' | 'abstained'; method?: 'tool-data'; attempts: number; judgments: Array<{ claimId: number; supported: boolean; reason: string }>; taskCheck?: RagTaskCheck }
  usage: RagUsage
}
export type RagResult = { indexRunId: string; sources: RagSource[]; trace?: RagTrace; grounding?: RagGrounding }
