export type ReleaseProvider = 'local' | 'cloud'
export type ReleaseDiagnostic = { attempt: number; stage: 'format' | 'evidence' | 'verification'; issues: string[] }
export type ReleaseState = 'queued' | 'collecting' | 'analyzing' | 'awaiting_checks' | 'ready' | 'failed' | 'cancelled'
export type ReleaseEvidence = { id: string; path: string; commit: string; line?: number; side?: 'LEFT' | 'RIGHT'; quote: string; changed: boolean }
export type ReleaseClaim = { text: string; evidenceIds: string[] }
export type ReleaseCheck = ReleaseClaim & { steps: string[]; expected: string; id: string; status: 'pending' | 'passed' | 'failed'; note: string }
export type ReleaseFile = {
  path: string; status: string; summary: ReleaseClaim; userNote: string
  risks: Array<ReleaseClaim & { severity: 'low' | 'medium' | 'high' }>
  checks: ReleaseCheck[]; evidence: ReleaseEvidence[]; limited: boolean
  verification?: { attempts: number; judgments: Array<{ claimId: number; supported: boolean; reason: string }> }
}
export type ReleaseRelation = { from: string; to: string; symbols: string[]; versions: Array<'base' | 'head'> }
export type ReleaseImpact = {
  state: 'pending' | 'analyzing' | 'complete' | 'failed'
  method: 'symbols-and-imports'; files: string[]; scannedFiles: number; relations: ReleaseRelation[]
  summary?: ReleaseClaim
  findings: Array<ReleaseClaim & { title: string; status: 'risk' | 'compatible' | 'needs_review'; severity: 'low' | 'medium' | 'high' }>
  riskReviews: Array<{ riskId: string; verdict: 'confirmed' | 'dismissed' | 'uncertain'; reason: string; evidenceIds: string[] }>
  checks: ReleaseCheck[]; evidence: ReleaseEvidence[]
  verification?: { attempts: number; judgments: Array<{ claimId: number; supported: boolean; reason: string }> }
  error?: string; diagnostics?: ReleaseDiagnostic[]
}
export type ReleaseRun = {
  id: string; projectId: string; projectName: string; root: string; version: string
  baseRef: string; headRef: string; base: string; head: string; provider: ReleaseProvider; model: string
  createdAt: string; updatedAt: string; state: ReleaseState; progress: string
  totalFiles: number; files: ReleaseFile[]; skipped: Array<{ path: string; reason: string }>
  fileErrors: Array<{ path: string; error: string; diagnostics?: ReleaseDiagnostic[] }>; corpusDocuments: number; corpusLimited: boolean
  coverage: 'pending' | 'complete' | 'partial'; reviewed: boolean; error?: string
  impact?: ReleaseImpact; analysisMode?: 'full' | 'impact'
  metrics: { calls: number; promptTokens: number; outputTokens: number; durationMs: number }
}
export type ReleaseRepositoryInfo = { refs: string[]; refsTruncated: boolean; head: string; suggestedBase: string; dirty: boolean }
export type ReleaseArtifacts = Record<'release-notes.md' | 'changelog.md' | 'test-plan.md' | 'readiness.json', string>
export const releaseRiskId = (path: string, index: number) => `${path}:risk:${index}`
export const releaseChecks = (run: ReleaseRun) => [...run.files.flatMap((file) => file.checks), ...(run.impact?.checks || [])]
