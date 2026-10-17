import test from 'node:test'
import assert from 'node:assert/strict'
import { ActionError, githubDiffLocations, planInlineComments, publishInlineReview } from './code-review-github'
import type { ReviewFinding, ReviewReport } from './code-review'

const target = { number: 7, repository: { full_name: 'example/project' } }
const env = { REVIEW_GITHUB_TOKEN: 'github-fixture-token' }
const base = 'a'.repeat(40), head = 'b'.repeat(40)
const patch = '@@ -1,3 +1,3 @@\n export function total(a, b) {\n-  return a + b\n+  return a - b\n }\n'
const file = { filename: 'src/math.ts', status: 'modified', patch }
const finding: ReviewFinding = { category: 'bug', severity: 'high', path: file.filename, line: 2, side: 'RIGHT',
  title: 'Неверная сумма', explanation: 'Вместо суммы возвращается разность.', suggestion: 'Вернуть сложение.',
  citations: [{ sourceId: 'diff', quote: 'return a - b' }] }
function report(findings: ReviewFinding[] = [finding]): ReviewReport {
  return { createdAt: '2026-10-17T00:00:00Z', base, head, mergeBase: base, provider: 'cloud', model: 'fixture', status: 'complete',
    totalFiles: 1, reviewedFiles: 1, skipped: [], limitedFiles: [], corpusDocuments: 2, corpusTruncated: false,
    files: [{ path: file.filename, sources: [], findings }], findings }
}
type Call = { path: string; method: string; body?: Record<string, unknown> }
function transport(options: { comments?: unknown[]; files?: unknown[]; staleAt?: number; failPost?: boolean } = {}) {
  const calls: Call[] = []
  let pullReads = 0
  const request = (async (url, init) => {
    const u = new URL(String(url)), method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: u.pathname, method, body })
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer github-fixture-token')
    if (u.pathname.endsWith('/pulls/7')) {
      pullReads++
      return Response.json({ state: 'open', base: { sha: base }, head: { sha: pullReads === options.staleAt ? 'changed' : head } })
    }
    if (u.pathname.endsWith('/files')) return Response.json(options.files || [file])
    if (u.pathname.endsWith('/pulls/7/comments')) return Response.json(options.comments || [])
    if (method === 'PATCH') return Response.json({ html_url: 'https://github.com/example/project/pull/7#discussion_r99' })
    assert.equal(method, 'POST'); assert.ok(u.pathname.endsWith('/pulls/7/reviews'))
    if (options.failPost) return Response.json({ message: 'invalid location' }, { status: 422 })
    return Response.json({ html_url: 'https://github.com/example/project/pull/7#pullrequestreview-100' })
  }) as typeof fetch
  return { request, calls }
}
function previous(overrides: Record<string, unknown> = {}) {
  const comment = planInlineComments(report(), [file]).comments[0]
  return { id: 99, path: file.filename, line: 2, side: 'RIGHT', body: comment.body,
    html_url: 'https://github.com/example/project/pull/7#discussion_r99', user: { login: 'github-actions[bot]' }, ...overrides }
}

test('native review batches anchored findings with commit_id, COMMENT event and no deprecated position', async () => {
  const second: ReviewFinding = { ...finding, side: 'LEFT', title: 'Изменение контракта', citations: [{ sourceId: 'diff', quote: 'return a + b' }] }
  const t = transport()
  const result = await publishInlineReview(target, report([finding, second]), env, t.request)
  const writes = t.calls.filter(({ method }) => method === 'POST')
  assert.equal(writes.length, 1); assert.equal(result.created, 2)
  assert.equal(writes[0].body?.commit_id, head); assert.equal(writes[0].body?.event, 'COMMENT')
  const comments = writes[0].body?.comments as Array<Record<string, unknown>>
  assert.deepEqual(comments.map(({ path, line, side }) => ({ path, line, side })), [
    { path: file.filename, line: 2, side: 'RIGHT' }, { path: file.filename, line: 2, side: 'LEFT' },
  ])
  assert.ok(comments.every((comment) => !('position' in comment)))
  assert.match(result.reviewUrl, /pullrequestreview-100/)
})

test('findings on one line share a single discussion and model Markdown is escaped', () => {
  const extra = { ...finding, category: 'recommendation' as const, severity: 'low' as const, title: '<img>@team ![x](https://example.test)' }
  const plan = planInlineComments(report([finding, extra]), [file])
  assert.equal(plan.comments.length, 1)
  assert.match(plan.comments[0].body, /Неверная сумма/)
  assert.ok(!plan.comments[0].body.includes('<img>'))
  assert.ok(!plan.comments[0].body.includes('@team'))
  assert.ok(!plan.comments[0].body.includes('![x]('))
})

test('identical rerun creates no review or comments; changed text updates the existing bot thread', async () => {
  const t = transport({ comments: [previous()] })
  const unchanged = await publishInlineReview(target, report(), env, t.request)
  assert.equal(unchanged.unchanged, 1); assert.equal(unchanged.created, 0)
  assert.ok(t.calls.every(({ method }) => method === 'GET'))
  const t2 = transport({ comments: [previous()] })
  const updated = await publishInlineReview(target, report([{ ...finding, explanation: 'Для 10 и 5 возвращается 5 вместо 15.' }]), env, t2.request)
  assert.equal(updated.updated, 1); assert.equal(updated.created, 0)
  assert.equal(t2.calls.filter(({ method }) => method === 'PATCH').length, 1)
  assert.ok(!t2.calls.some(({ method }) => method === 'POST'))
})

test('human comments, replies and outdated anchors are preserved instead of being edited', async () => {
  const t = transport({ comments: [previous({ user: { login: 'human' } }), previous({ in_reply_to_id: 10 }), previous({ line: null })] })
  const result = await publishInlineReview(target, report(), env, t.request)
  assert.equal(result.created, 1); assert.equal(result.updated, 0)
  assert.ok(!t.calls.some(({ method }) => method === 'PATCH'))
})

test('unchanged code shifted to another line reuses GitHub-mapped coordinates on the newer commit', async () => {
  const moved = { ...file, patch: patch.replace('@@ -1,3 +1,3 @@', '@@ -9,3 +9,3 @@') }
  const t = transport({ files: [moved], comments: [previous({ line: 10 })] })
  const result = await publishInlineReview(target, report([{ ...finding, line: 10 }]), env, t.request)
  assert.equal(result.unchanged, 1); assert.equal(result.created, 0)
})

test('missing GitHub patches, unknown locations and invalid citations stay in report without invalid API writes', async () => {
  const r = report([{ ...finding, line: 99 }, { ...finding, citations: [{ sourceId: 'diff', quote: 'invented code' }] }])
  const t = transport()
  const result = await publishInlineReview(target, r, env, t.request)
  assert.equal(result.skipped, 2); assert.equal(result.created, 0)
  assert.equal(r.findings.length, 2)
  assert.ok(t.calls.every(({ method }) => method === 'GET'))
  assert.equal(planInlineComments(report(), [{ ...file, patch: undefined }]).skipped, 1)
})

test('renamed files use new GitHub path for LEFT anchors; context is allowed only on RIGHT', () => {
  const rename = { ...file, filename: 'src/renamed.ts', previous_filename: file.filename, status: 'renamed' }
  const left = { ...finding, side: 'LEFT' as const, citations: [{ sourceId: 'diff', quote: 'return a + b' }] }
  const plan = planInlineComments(report([left]), [rename])
  assert.equal(plan.comments[0].path, 'src/renamed.ts'); assert.equal(plan.comments[0].side, 'LEFT')
  const locations = githubDiffLocations(patch)
  assert.ok(locations.has('RIGHT:1')); assert.ok(!locations.has('LEFT:1'))
})

test('stale revisions prevent writes before planning and immediately before submission', async () => {
  for (const staleAt of [1, 2]) {
    const t = transport({ staleAt })
    const result = await publishInlineReview(target, report(), env, t.request)
    assert.equal(result.stale, true)
    assert.ok(t.calls.every(({ method }) => method === 'GET'))
  }
})

test('publication limits keep highest severity first and API validation failures are explicit', async () => {
  const low = { ...finding, severity: 'low' as const, side: 'LEFT' as const, citations: [{ sourceId: 'diff', quote: 'return a + b' }] }
  const plan = planInlineComments(report([low, finding]), [file], 1)
  assert.equal(plan.comments.length, 1); assert.equal(plan.comments[0].side, 'RIGHT'); assert.equal(plan.skipped, 1)
  const t = transport({ failPost: true })
  await assert.rejects(publishInlineReview(target, report(), env, t.request), (error: unknown) => error instanceof ActionError && error.status === 422)
})

test('file and inline-comment pagination finds anchors and bot threads beyond page one', async () => {
  const pages: string[] = []
  const request = (async (url, init) => {
    assert.equal(init?.method, 'GET')
    const u = new URL(String(url)), page = u.searchParams.get('page')
    if (u.pathname.endsWith('/pulls/7')) return Response.json({ state: 'open', base: { sha: base }, head: { sha: head } })
    pages.push(`${u.pathname.split('/').pop()}:${page}`)
    if (u.pathname.endsWith('/files')) return Response.json(page === '1'
      ? Array.from({ length: 100 }, (_, i) => ({ filename: `unrelated-${i}.ts`, status: 'modified' })) : [file])
    return Response.json(page === '1' ? Array.from({ length: 100 }, (_, i) => previous({ id: i, user: { login: 'human' } })) : [previous()])
  }) as typeof fetch
  const result = await publishInlineReview(target, report(), env, request)
  assert.equal(result.unchanged, 1); assert.equal(result.created, 0)
  assert.deepEqual(pages, ['files:1', 'files:2', 'comments:1', 'comments:2'])
})
