import type { RagGrounding, RagSource, RagTrace } from './rag-types'

export type DeveloperProvider = 'local' | 'cloud'
export type DeveloperProject = { id: string; name: string; root?: string }
export type DeveloperFolderListing = { path: string; parent: string | null; home: string; directories: string[]; truncated: boolean }
export type DeveloperIndex = {
  id: string; createdAt: string; model: string; sourceCount: number; chunkCount: number
}
export type DeveloperStatus = {
  projectId?: string
  project: string; index: DeveloperIndex | null; stale: boolean; documents: string[]
  cloudAvailable: boolean; localModel: string; cloudModel: string; busy: boolean
}
export type ProjectReceipt = { name: string; result: Record<string, unknown> }
export type DeveloperAnswer = {
  projectId?: string
  question: string; provider: DeveloperProvider; model: string; indexRunId: string
  answer: string; grounding: RagGrounding; sources: RagSource[]; trace?: RagTrace
  context: { capturedAt: string; receipts: ProjectReceipt[] }; durationMs: number
}
