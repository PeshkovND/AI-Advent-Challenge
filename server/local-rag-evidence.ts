import { z } from 'zod'
import type { RagSource } from '../src/rag-types'

export type LocalEvidence = { id: string; chunkId: string; source: string; section: string; quote: string }

/** Every selectable quote is an unchanged, bounded substring of a retrieved chunk. */
export function localEvidence(sources: RagSource[]): LocalEvidence[] {
  const evidence: LocalEvidence[] = []
  for (const source of sources) {
    for (const paragraph of source.text.split(/\n\s*\n/)) {
      let start = 0
      while (start < paragraph.length) {
        let end = Math.min(start + 1100, paragraph.length)
        if (end < paragraph.length) {
          const boundary = paragraph.lastIndexOf('\n', end)
          if (boundary > start + 550) end = boundary
        }
        const quote = paragraph.slice(start, end).trim()
        if (quote.length >= 12) evidence.push({ id: 'e' + (evidence.length + 1), chunkId: source.chunkId, source: source.source, section: source.section, quote })
        if (end === paragraph.length) break
        start = Math.max(start + 1, end - 160)
      }
    }
  }
  return evidence
}

const selectedAnswer = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown') }).strict(),
  z.object({ status: z.literal('answered'), claims: z.array(z.object({
    text: z.string().trim().min(1).max(4000), evidenceIds: z.array(z.string()).min(1).max(8),
  }).strict()).min(1).max(8) }).strict(),
])

export function resolveLocalEvidence(content: string, evidence: LocalEvidence[]) {
  const parsed = selectedAnswer.parse(JSON.parse(content))
  if (parsed.status === 'unknown') return JSON.stringify(parsed)
  return JSON.stringify({ status: 'answered', claims: parsed.claims.map((claim) => ({
    text: claim.text, citations: [...new Set(claim.evidenceIds)].map((id) => {
      const entry = evidence.find((item) => item.id === id)
      if (!entry) throw new Error('Unknown evidence ID: ' + id)
      return { chunkId: entry.chunkId, quote: entry.quote }
    }),
  })) })
}
