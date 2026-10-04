import { z } from 'zod'
import type { RagReport } from './rag-report-store'

const finite = z.number().finite()
const strategy = z.enum(['fixed', 'structured'])
const mode = z.enum(['baseline', 'rerank', 'rewrite', 'full'])
const evidence = z.object({ source: z.string(), quote: z.string(), alternatives: z.array(z.object({ source: z.string(), quote: z.string() })).optional() })
const source = z.object({ source: z.string(), title: z.string(), section: z.string(), chunkId: z.string(), strategy, score: finite, text: z.string() })
const usage = z.object({ inputTokens: finite, promptTokens: finite, completionTokens: finite, totalTokens: finite })
const grounding = z.object({
  status: z.enum(['answered', 'unknown']), answer: z.string(),
  sources: z.array(z.object({ source: z.string(), section: z.string(), chunkId: z.string() })),
  citations: z.array(z.object({ id: finite.int().positive(), source: z.string(), section: z.string(), chunkId: z.string(), quote: z.string() })),
  claims: z.array(z.object({ id: finite.int().positive(), text: z.string(), citationIds: z.array(finite.int().positive()) })),
  clarification: z.string().optional(), reason: z.enum(['weak-context', 'insufficient-evidence', 'unsupported-answer']).optional(),
  verification: z.object({ status: z.enum(['passed', 'abstained']), attempts: finite.int().min(0).max(2), judgments: z.array(z.object({ claimId: finite.int().positive(), supported: z.boolean(), reason: z.string() })) }), usage,
})
const trace = z.object({
  originalQuestion: z.string(), searchQuery: z.string(), candidateTopK: finite, topK: finite,
  minSimilarity: finite.optional(), minRelevance: finite.optional(),
  candidates: z.array(source.extend({ rankBefore: finite, originalRank: finite.optional(), rewrittenRank: finite.optional(), fusionScore: finite.optional(), relevance: finite.optional(), reason: z.string().optional(), rankAfter: finite.optional(), selected: z.boolean(), rejection: z.enum(['similarity', 'relevance', 'top-k']).optional() })),
  rewrite: z.object({ status: z.enum(['disabled', 'applied', 'fallback']), durationMs: finite, usage: usage.optional(), warning: z.string().optional() }),
  rerank: z.object({ status: z.enum(['disabled', 'applied', 'skipped']), durationMs: finite, usage: usage.optional(), attempts: finite.int().min(1).max(2).optional(), warning: z.string().optional() }),
  timings: z.object({ embeddingMs: finite, searchMs: finite, totalMs: finite }), usage, emptyContext: z.boolean(),
})
const result = z.object({ output: z.string(), durationMs: finite, model: z.string(), totalTokens: finite, promptTokens: finite.optional(), rag: z.object({ indexRunId: z.string(), sources: z.array(source), trace: trace.optional(), grounding: grounding.optional() }).optional() })
const reportSchema = z.object({
  id: z.string().uuid(), createdAt: z.string().datetime(), completed: z.boolean(),
  index: z.object({ id: z.string(), model: z.string(), embeddingProfile: z.string() }),
  settings: z.object({ strategy, candidateTopK: finite.int().min(1).max(30), topK: finite.int().min(1).max(8), minRelevance: finite.int().min(0).max(3), minSimilarity: finite.min(-1).max(1).optional() }),
  modes: z.array(mode).min(1),
  questions: z.array(z.object({ id: finite.int().positive(), question: z.string(), expected: z.string(), sources: z.array(z.string()), evidence: z.array(evidence) })).min(1),
  results: z.record(z.string(), z.object({ answers: z.partialRecord(mode, result), errors: z.partialRecord(mode, z.string()), grades: z.partialRecord(mode, z.enum(['full', 'partial', 'wrong'])) })),
})

/** Import only comparison reports with actual generated answers, not retrieval-only probes. */
export function parseRagReport(text: string): RagReport {
  const data: unknown = JSON.parse(text)
  if (data && typeof data === 'object' && 'generatedAnswers' in data && data.generatedAnswers === false) throw new Error('Это отчёт только о поиске, без ответов моделей.')
  const parsed = reportSchema.safeParse(data)
  if (!parsed.success) throw new Error('Некорректный формат отчёта Day 23.')
  return parsed.data
}
