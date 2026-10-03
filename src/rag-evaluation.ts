import type { RagEvidence } from './rag-questions'
import type { RagSource } from './rag-types'
import type { RagReport } from './rag-report-store'
import type { RagMode } from './rag-improved-config'

export function evidenceHits(sources: Pick<RagSource, 'source' | 'text'>[], evidence: RagEvidence[]) {
  return evidence.filter((item) => sources.some((source) => [item, ...(item.alternatives ?? [])].some((candidate) => source.source === candidate.source && source.text.includes(candidate.quote)))).length
}
export function reportStats(report: RagReport, mode: RagMode) {
  const evidenceQuestions = report.questions.filter((question) => question.evidence.length > 0).length
  const negatives = report.questions.length - evidenceQuestions
  let answered = 0, evidencePassed = 0, candidatePassed = 0, emptyNegatives = 0
  let full = 0, partial = 0, wrong = 0, tokens = 0, durationMs = 0
  for (const question of report.questions) {
    const comparison = report.results[question.id]
    const answer = comparison?.answers[mode]
    if (!answer) continue
    answered += 1; tokens += answer.totalTokens; durationMs += answer.durationMs
    if (question.evidence.length) {
      if (evidenceHits(answer.rag?.sources ?? [], question.evidence) === question.evidence.length) evidencePassed += 1
      if (evidenceHits(answer.rag?.trace?.candidates ?? [], question.evidence) === question.evidence.length) candidatePassed += 1
    } else {
      if (answer.rag?.trace?.emptyContext) emptyNegatives += 1
    }
    const grade = comparison.grades[mode]
    if (grade === 'full') full += 1
    if (grade === 'partial') partial += 1
    if (grade === 'wrong') wrong += 1
  }
  return { answered, evidenceQuestions, evidencePassed, candidatePassed, negatives, emptyNegatives, full, partial, wrong, tokens, averageMs: answered ? Math.round(durationMs / answered) : 0 }
}
