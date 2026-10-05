import type { RagGrounding, RagUsage } from './rag-types'

export type DialogueMemoryConfig = { enabled: boolean; historyWindow: number }
export type DialogueFact = { key: string; text: string; quote: string; userTurn: number }
export type DialogueMemoryState = {
  turn: number
  goal?: DialogueFact
  clarifications: DialogueFact[]
  constraints: DialogueFact[]
  terms: DialogueFact[]
  pendingTurns?: number[]
  /** Deletion revisions prevent pending old requests from reviving cancelled rules. */
  removed?: Array<{ group: 'goal' | 'clarifications' | 'constraints' | 'terms'; key: string; afterTurn: number }>
}
export type DialogueIntent = 'documents' | 'dialogue' | 'preferences' | 'conversation' | 'general' | 'clarification'
export type RetrievalDecision = { policy: 'always' | 'auto'; route: DialogueIntent; searched: boolean; reason: string }
export type DialoguePreparation = { state: DialogueMemoryState; question: string; intent: DialogueIntent; reason: string; instructions: DialogueFact[]; clarification?: string; usage: RagUsage }
export type RagChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
  grounding?: RagGrounding
  dialogueMemory?: DialogueMemoryState
  searchQuery?: string
  retrieval?: RetrievalDecision
}
export type RagChatConversation = { id: string; title: string; messageCount: number }
