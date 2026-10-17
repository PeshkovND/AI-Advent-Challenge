import { createHash } from 'node:crypto'
import { bytePrefix } from './code-review-context'
import { renderInlineFinding, type ReviewReport } from './code-review'

type Environment = NodeJS.ProcessEnv
export type ReviewTarget = { number: number; repository: { full_name: string } }
type Revision = { base: string; head: string }
type Pull = { state: string; base: { sha: string }; head: { sha: string } }
type ReviewFile = { filename: string; previous_filename?: string; status: string; patch?: string }
type InlineComment = { id: number; path: string; line: number | null; side: string; body: string; html_url: string
  user?: { login: string }; in_reply_to_id?: number; pull_request_review_id?: number }
type PlannedComment = { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string; marker: string }
export type InlinePublication = { reviewUrl: string; created: number; updated: number; unchanged: number; skipped: number; stale: boolean }
export class ActionError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

function githubClient(env: Environment, request: typeof fetch, signal?: AbortSignal) {
  const api = new URL(env.GITHUB_API_URL || 'https://api.github.com')
  if (api.protocol !== 'https:' || api.username || api.password) throw new ActionError('GITHUB_API_URL must use HTTPS.')
  return async <T>(path: string, method = 'GET', data?: unknown): Promise<T> => {
    const response = await request(new URL(api.href.replace(/\/$/, '') + path), { method,
      headers: { Authorization: `Bearer ${env.REVIEW_GITHUB_TOKEN?.trim()}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}), signal })
    if (!response.ok) throw new ActionError(`GitHub API returned HTTP ${response.status}. Check pull-requests: write permission.`, response.status)
    return response.json()
  }
}
type GithubClient = ReturnType<typeof githubClient>
async function pages<T>(call: GithubClient, path: string, maxPages = Infinity) {
  const result: T[] = []
  for (let page = 1; page <= maxPages; page++) {
    const items = await call<T[]>(`${path}?per_page=100&page=${page}`)
    result.push(...items)
    if (items.length < 100) return result
  }
  return result
}
const currentRevision = (pull: Pull, report: Revision) => pull.state === 'open' && pull.head.sha === report.head && pull.base.sha === report.base

export async function publishReviewComment(event: ReviewTarget, report: Revision, body: string,
  env: Environment, request: typeof fetch = fetch, signal?: AbortSignal) {
  const call = githubClient(env, request, signal), prefix = `/repos/${event.repository.full_name}`
  if (!currentRevision(await call<Pull>(`${prefix}/pulls/${event.number}`), report)) return ''
  let existing: { id: number } | undefined
  for (let page = 1; ; page++) {
    const comments = await call<Array<{ id: number; user?: { login: string }; body?: string }>>(`${prefix}/issues/${event.number}/comments?per_page=100&page=${page}`)
    existing = comments.find((comment) => comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith('<!-- day-32-ai-review -->'))
    if (existing || comments.length < 100) break
  }
  if (!currentRevision(await call<Pull>(`${prefix}/pulls/${event.number}`), report)) return ''
  const result = existing ? await call<{ html_url: string }>(`${prefix}/issues/comments/${existing.id}`, 'PATCH', { body })
    : await call<{ html_url: string }>(`${prefix}/issues/${event.number}/comments`, 'POST', { body })
  return String(result.html_url || '')
}

/** GitHub permits LEFT for deletions, RIGHT for additions and unchanged context. */
export function githubDiffLocations(patch: string) {
  const locations = new Map<string, string>()
  let left = 0, right = 0, active = false
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) { left = Number(hunk[1]); right = Number(hunk[2]); active = true; continue }
    if (!active) continue
    if (line.startsWith('-')) locations.set(`LEFT:${left++}`, line.slice(1))
    else if (line.startsWith('+')) locations.set(`RIGHT:${right++}`, line.slice(1))
    else if (line.startsWith(' ')) { locations.set(`RIGHT:${right++}`, line.slice(1)); left++ }
  }
  return locations
}

/** Group findings at a single anchor. Keep unsupported locations in the full report. */
export function planInlineComments(report: ReviewReport, files: ReviewFile[], limit = 50) {
  const groups = new Map<string, PlannedComment>()
  let skipped = 0
  const severity = { high: 0, medium: 1, low: 2 }
  const findings = report.findings.slice().sort((a, b) => severity[a.severity] - severity[b.severity])
  const locations = new Map(files.map((file) => [file.filename, githubDiffLocations(file.patch || '')]))
  for (const finding of findings) {
    const file = files.find((file) => file.filename === finding.path || finding.side === 'LEFT' && file.status === 'renamed' && file.previous_filename === finding.path)
    const text = file && locations.get(file.filename)?.get(`${finding.side}:${finding.line}`)
    if (!file || text === undefined || !finding.citations.some((citation) => citation.sourceId === 'diff' && text.includes(citation.quote))) { skipped++; continue }
    const key = JSON.stringify([file.filename, finding.side, finding.line])
    const existing = groups.get(key)
    const body = renderInlineFinding(finding, report.files.find((entry) => entry.path === finding.path)?.sources || [])
    if (existing) { existing.body += '\n\n---\n\n' + body; continue }
    if (groups.size >= limit) { skipped++; continue }
    // Quote-based identity survives line shifts; API coordinates must still match.
    const id = createHash('sha256').update(JSON.stringify([file.filename, finding.side, text])).digest('hex').slice(0, 24)
    const marker = `<!-- day-32-ai-inline:${id} -->`
    groups.set(key, { path: file.filename, line: finding.line, side: finding.side, marker, body: `${marker}\n${body}` })
  }
  for (const comment of groups.values()) if (Buffer.byteLength(comment.body) > 55000) {
    comment.body = bytePrefix(comment.body, 54000) + '\n\nПолный текст — в артефакте AI-ревью этого запуска.\n'
  }
  return { comments: [...groups.values()], skipped }
}

export async function publishInlineReview(event: ReviewTarget, report: ReviewReport,
  env: Environment, request: typeof fetch = fetch, signal?: AbortSignal): Promise<InlinePublication> {
  const result: InlinePublication = { reviewUrl: '', created: 0, updated: 0, unchanged: 0, skipped: 0, stale: false }
  const call = githubClient(env, request, signal), prefix = `/repos/${event.repository.full_name}`
  const isCurrent = async () => currentRevision(await call<Pull>(`${prefix}/pulls/${event.number}`), report)
  if (!await isCurrent()) return { ...result, stale: true }
  const files = await pages<ReviewFile>(call, `${prefix}/pulls/${event.number}/files`, 30)
  const plan = planInlineComments(report, files)
  result.skipped = plan.skipped
  if (!plan.comments.length) return result
  const existing = await pages<InlineComment>(call, `${prefix}/pulls/${event.number}/comments`)
  const pending: PlannedComment[] = []
  for (const comment of plan.comments) {
    const previous = existing.find((entry) => !entry.in_reply_to_id && entry.user?.login === 'github-actions[bot]'
      && entry.path === comment.path && entry.line === comment.line && entry.side === comment.side && entry.body.startsWith(comment.marker))
    if (!previous) { pending.push(comment); continue }
    result.reviewUrl ||= previous.html_url
    if (previous.body === comment.body) { result.unchanged++; continue }
    if (!await isCurrent()) return { ...result, stale: true }
    await call(`${prefix}/pulls/comments/${previous.id}`, 'PATCH', { body: comment.body })
    result.updated++
  }
  if (pending.length) {
    if (!await isCurrent()) return { ...result, stale: true }
    const review = await call<{ html_url: string }>(`${prefix}/pulls/${event.number}/reviews`, 'POST', {
      commit_id: report.head, event: 'COMMENT',
      body: `AI-ревью: ${pending.length} обсуждений привязаны к строкам diff. Общий отчёт и ограничения доступны в комментарии AI-ревью и артефакте запуска.`,
      comments: pending.map(({ path, line, side, body }) => ({ path, line, side, body })),
    })
    result.reviewUrl = review.html_url
    result.created = pending.length
  }
  return result
}
