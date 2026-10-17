import type { RagGrounding, RagSource, RagTrace } from './rag-types'

export type SupportProvider = 'local' | 'cloud'
export type SupportTicketStatus = 'open' | 'in_progress' | 'pending' | 'escalated' | 'resolved'
export type SupportSelection = { userId?: string; ticketId?: string }
export type SupportCustomer = {
  id: string; plan?: 'free' | 'team' | 'business'; role?: 'owner' | 'admin' | 'member' | 'viewer'
  authMethod: 'password' | 'sso' | 'sms' | 'vk_id'; ssoRequired?: boolean; accountState: 'active' | 'locked' | 'disabled' | 'unknown'
  myFamily?: {
    platform: 'ios'; build?: string; authStage: 'phone_entry' | 'sms_requested' | 'vk_authorizing' | 'signed_in' | 'unknown'
    sessionState: 'absent' | 'valid' | 'expired' | 'unknown'; profileState: 'complete' | 'incomplete' | 'unknown'
    family?: { membership: 'member' | 'none' | 'unknown'; id?: string; role: 'owner' | 'regular' | 'unknown' }
    pro?: { state: 'active' | 'inactive' | 'unknown'; purchaseState: 'none' | 'verified' | 'pending' | 'cancelled' | 'unverified' | 'unknown' }
    permissions?: {
      location: 'not_determined' | 'denied' | 'restricted' | 'when_in_use' | 'always' | 'unknown'
      microphone: 'not_determined' | 'denied' | 'granted' | 'unknown'
      camera: 'not_determined' | 'denied' | 'restricted' | 'granted' | 'unknown'
      photos: 'not_determined' | 'denied' | 'restricted' | 'limited' | 'granted' | 'unknown'
    }
    contentCheck?: 'text_toxic' | 'image_unsafe' | 'check_failed' | 'none' | 'unknown'
    lastAuthError?: { code: string; retryAfterSeconds?: number }
  }
}
export type SupportTicketDetails = { device?: string; osVersion?: string; appVersion?: string; triedSteps?: string }
export type SupportTicket = {
  id: string; userId: string; title: string; status: SupportTicketStatus
  details?: SupportTicketDetails
  category: 'auth' | 'profile' | 'features' | 'billing' | 'integrations' | 'general'; description: string; errorCode?: string
  messages: Array<{ author: 'user' | 'agent'; body: string }>
}
export type SupportCatalog = {
  product: string; demo: boolean; mode?: 'tickets' | 'crm'
  users: Array<{ id: string; displayName: string; plan?: SupportCustomer['plan'] }>
  tickets: Array<Pick<SupportTicket, 'id' | 'userId' | 'title' | 'status'> & { updatedAt?: string; createdAt?: string; deletedAt?: string }>
}
export type SupportContext = {
  product?: string; demo?: boolean; knowledgeRevision?: string
  mode?: 'tickets' | 'crm'; customer?: SupportCustomer; ticket: SupportTicket | null
  messagesOmitted: number
}
export type SupportSnapshot = {
  capturedAt: string; receipt: { name: 'get_support_context'; result: SupportContext }
}
export type SupportIndex = { id: string; createdAt: string; model: string; sourceCount: number; chunkCount: number }
export type SupportStatus = {
  index: SupportIndex | null; stale: boolean; documents: string[]; busy: boolean
  cloudAvailable: boolean; localModel: string; cloudModel: string
}
export type SupportAnswer = {
  question: string; selection: SupportSelection; provider: SupportProvider; model: string
  answer: string; outcome: 'answered' | 'escalate'; grounding: RagGrounding
  sources: RagSource[]; trace?: RagTrace; context?: SupportSnapshot
  indexRunId: string; durationMs: number
}

export type SupportMessageReply = {
  outcome: 'answered' | 'escalate'; provider: SupportProvider; model: string; durationMs: number
  citations: RagGrounding['citations']; clarification?: string; indexRunId: string; capturedAt?: string
}
export type SupportMessage = {
  id: string; author: 'user' | 'agent'; body: string; createdAt: string; replyTo?: string
  reply?: SupportMessageReply
}
export type SupportJob = {
  id: string; state: 'queued' | 'running' | 'completed' | 'failed'; provider: SupportProvider
  userMessageId: string; error?: string; updatedAt: string
}
export type SupportTicketRecord = Omit<SupportTicket, 'messages'> & {
  createdAt: string; updatedAt: string; deletedAt?: string; revision: number; messages: SupportMessage[]; job: SupportJob | null
}
export type SupportJobClaim = {
  id: string; userId: string; ticketId: string; input: string; provider: SupportProvider
  userMessageId: string; leaseToken: string
}
