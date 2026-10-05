import type { RagGrounding, RagUsage } from './rag-types'

export type DialogueMemoryConfig = { enabled: boolean; historyWindow: number }
export type DialogueFact = { key: string; text: string; quote: string; userTurn: number }
export type DialogueMemoryState = {
  turn: number
  goal?: DialogueFact
  clarifications: DialogueFact[]
  constraints: DialogueFact[]
  terms: DialogueFact[]
}
export type DialogueIntent = 'documents' | 'dialogue' | 'conversation' | 'general'
export type RetrievalDecision = { policy: 'always' | 'auto'; route: DialogueIntent; searched: boolean; reason: string }
export type DialoguePreparation = { state: DialogueMemoryState; question: string; intent: DialogueIntent; reason: string; usage: RagUsage }
export type RagChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
  grounding?: RagGrounding
  dialogueMemory?: DialogueMemoryState
  searchQuery?: string
  retrieval?: RetrievalDecision
}
export type RagChatConversation = { id: string; title: string; messageCount: number }
