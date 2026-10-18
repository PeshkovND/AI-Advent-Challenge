import type { DeveloperProvider } from './developer-types'

export type FileChange = { path: string; before: string | null; after: string; diff: string }
export type CodingStep = { tool: string; arguments: Record<string, unknown>; result: Record<string, unknown> }
export type CodingRun = {
  id: string; projectId?: string; goal: string; root: string; provider: DeveloperProvider; model: string
  createdAt: string; durationMs: number; status: 'preview' | 'applied' | 'completed'
  answer: string; steps: CodingStep[]; readFiles: string[]; changes: FileChange[]
}
