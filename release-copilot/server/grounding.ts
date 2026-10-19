import { z } from 'zod'

export const groundingSchema = z.object({ items: z.array(z.object({ claimId: z.number().int().positive(), supported: z.boolean(), reason: z.string().trim().min(1).max(500) }).strict()) }).strict()
export function parseGroundingJudgments(content: string, claims: Array<{ id: number; text: string; citationIds: number[] }>) {
  const result = groundingSchema.parse(JSON.parse(content)), ids = new Set(claims.map((claim) => claim.id))
  if (result.items.length !== claims.length || result.items.some((item) => !ids.delete(item.claimId))) throw new Error('Проверяющий должен оценить каждый пункт ровно один раз.')
  return result.items
}
