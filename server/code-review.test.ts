import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CodeReviewAssistant, parseReviewResponse, patchLocations, renderReview, reviewComment, reviewPayload, type ReviewFinding } from './code-review'
import { collectReviewContext, retrieveReviewSources, reviewPath, reviewLimits, type ReviewContext } from './code-review-context'
import type { RagCompletion } from './rag-retrieval'
import { modelClient } from './local-rag-service'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'day32-review-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (path: string, text: string | Buffer) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD') }
  git('init', '-q'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture')
  write('README.md', '# Arithmetic\nThe total function returns the sum of both arguments.\n')
  write('docs/architecture.md', '# Contract\nArithmetic total belongs to the domain layer and must return a sum.\n')
  write('src/math.ts', 'export function total(a: number, b: number) {\n  return a + b\n}\n')
  write('src/caller.ts', "import { total } from './math'\nexport const invoiceTotal = total(10, 5)\n")
  write('src/remove.ts', 'export const remove = true\n')
  write('src/rename.ts', 'export const renamed = true\n')
  write('.env', 'SECRET=never-send-this\n')
  const base = commit()
  write('src/math.ts', 'export function total(a: number, b: number) {\n  return a - b\n}\n')
  const head = commit()
  return { root, git, write, commit, base, head, close: () => rmSync(root, { recursive: true, force: true }) }
}
const usage = { inputTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
const finding: ReviewFinding = { category: 'bug', severity: 'high', path: 'src/math.ts', line: 2, side: 'RIGHT',
  title: 'Сумма заменена разностью', explanation: 'Для total(10, 5) результат станет 5 вместо 15.', suggestion: 'Вернуть сложение аргументов.',
  citations: [{ sourceId: 'diff', quote: 'return a - b' }] }

test('immutable PR context uses merge-base; RAG retrieves real docs and unchanged code without Ollama', async () => {
  const f = fixture()
  try {
    f.git('checkout', '--detach', f.base)
    f.write('base-only.md', 'This change belongs only to the advanced base branch')
    const advanced = f.commit()
    // Leave an uncommitted poison file; retrieval must use Git blobs, not disk.
    f.write('src/caller.ts', 'POISON_WORKTREE_TEXT')
    const context = await collectReviewContext(f.root, advanced, f.head)
    assert.equal(context.mergeBase, f.base)
    assert.equal(context.base, advanced)
    assert.deepEqual(context.files.map(({ path }) => path), ['src/math.ts'])
    assert.match(context.files[0].patch, /-  return a \+ b\n\+  return a - b/)
    assert.match(context.files[0].content, /return a - b/)
    const sources = retrieveReviewSources(context.files[0], context.corpus)
    assert.ok(sources.some((source) => source.kind === 'documentation'))
    assert.ok(sources.some((source) => source.kind === 'code' && source.path === 'src/caller.ts'))
    assert.ok(!JSON.stringify(context).includes('POISON_WORKTREE_TEXT'))
    assert.ok(!JSON.stringify(context).includes('never-send-this'))
    assert.ok(!context.corpus.some(({ source }) => source === 'base-only.md'))
    assert.equal(f.git('rev-parse', 'HEAD'), advanced, 'Reviewer must not change the checkout')
  } finally { f.close() }
})

test('deleted/renamed files, literal pathspecs, binary files and symlinks have explicit handling', async () => {
  const f = fixture()
  try {
    rmSync(join(f.root, 'src/remove.ts'))
    renameSync(join(f.root, 'src/rename.ts'), join(f.root, 'src/renamed.ts'))
    f.write('src/:(glob)*.ts', 'export const literal = 1\n')
    f.write('src/binary.ts', Buffer.from([0, 1, 2, 3]))
    symlinkSync('../.env', join(f.root, 'src/link.ts'))
    f.write('.env', 'SECRET=changed-secret\n')
    f.write('.github/workflows/check.yml', 'name: Check\non: push\n')
    const head = f.commit()
    const context = await collectReviewContext(f.root, f.base, head)
    const removed = context.files.find(({ path }) => path === 'src/remove.ts')!
    assert.equal(removed.status, 'D'); assert.match(removed.content, /remove = true/)
    assert.equal(patchLocations(removed.patch).get('LEFT:1'), 'export const remove = true')
    assert.equal(context.files.find(({ path }) => path === 'src/rename.ts')?.status, 'D')
    assert.equal(context.files.find(({ path }) => path === 'src/renamed.ts')?.status, 'A')
    const literal = context.files.find(({ path }) => path === 'src/:(glob)*.ts')!
    assert.match(literal.patch, /literal = 1/); assert.ok(!literal.patch.includes('return a - b'))
    assert.ok(context.files.some(({ path }) => path === '.github/workflows/check.yml'))
    for (const path of ['.env', 'src/link.ts', 'src/binary.ts']) assert.ok(context.skipped.some((skip) => skip.path === path))
    assert.ok(!JSON.stringify(context.files).includes('changed-secret'))
    assert.equal(reviewPath('.github/workflows/secrets.yml'), false)
    assert.equal(reviewPath('data/history.json'), false)
    assert.equal(reviewPath('package-lock.json'), false)
  } finally { f.close() }
})

test('file and context limits are visible; UTF-8 and hunk lines stay intact', async () => {
  const f = fixture()
  try {
    f.write('src/math.ts', 'export const total = 0\n' + Array.from({ length: 1500 }, (_, i) => `// Строка ${i} — тест`).join('\n') + '\n')
    for (let i = 0; i < reviewLimits.files + 2; i++) f.write(`src/extra-${i}.ts`, `export const value${i} = ${i}\n`)
    const context = await collectReviewContext(f.root, f.base, f.commit())
    assert.equal(context.files.length, reviewLimits.files)
    assert.equal(context.skipped.filter(({ reason }) => reason.includes('Лимит')).length, 3)
    // math sorts after extra files; inspect it independently too.
    const file = (await collectReviewContext(f.root, f.base, f.head)).files[0]
    const sources = retrieveReviewSources(file, context.corpus)
    const payload = reviewPayload({ ...file, content: '😀'.repeat(30000) }, sources)
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 21000)
    assert.equal(payload.limited, true)
    assert.equal(payload.file.contentTruncated, true)
    assert.ok(!JSON.stringify(payload).includes('\uFFFD'))
    const patch = '+export const x = "😀"\n'.repeat(1000)
    f.git('checkout', '--detach', f.head)
    f.write('src/math.ts', patch)
    const large = (await collectReviewContext(f.root, f.base, f.commit())).files[0]
    assert.equal(large.patchTruncated, true)
    assert.ok(large.patch.endsWith('\n'))
    assert.ok(!large.patch.includes('\uFFFD'))
    assert.ok(Buffer.byteLength(large.patch) <= reviewLimits.patchBytes)
  } finally { f.close() }
})

test('shared completion receives real diff, file contents and docs/code RAG; validated review renders all sections', async () => {
  const f = fixture()
  try {
    let calls = 0
    const complete: RagCompletion = async (messages, stage) => {
      calls++
      assert.equal(stage, 'answer')
      assert.match(messages[0].content, /недоверенные данные/)
      const payload = JSON.parse(messages[messages.length - 1].content)
      assert.match(payload.file.patch, /return a - b/)
      assert.match(payload.file.content, /return a - b/)
      assert.ok(payload.sources.some((source: { kind: string }) => source.kind === 'documentation'))
      assert.ok(payload.sources.some((source: { kind: string }) => source.kind === 'code'))
      return { content: JSON.stringify({ findings: [finding] }), usage }
    }
    const report = await new CodeReviewAssistant({ root: f.root, complete }).review(f.base, f.head)
    assert.equal(report.status, 'complete'); assert.equal(calls, 1)
    assert.equal(report.findings.length, 1); assert.equal(report.reviewedFiles, 1)
    const markdown = renderReview(report)
    for (const title of ['Потенциальные баги', 'Архитектурные проблемы', 'Рекомендации', 'src/math.ts:2', f.head]) assert.ok(markdown.includes(title))
    assert.match(markdown, /total\\\(10, 5\\\)/)
  } finally { f.close() }
})

test('fabricated citations, wrong paths/lines and invalid JSON are rejected; malformed result is repaired once', async () => {
  const f = fixture()
  try {
    const context = await collectReviewContext(f.root, f.base, f.head)
    const file = context.files[0], sources = retrieveReviewSources(file, context.corpus)
    for (const invalid of [
      { ...finding, path: '../secret.ts' }, { ...finding, line: 99 }, { ...finding, side: 'LEFT' },
      { ...finding, citations: [{ sourceId: 'diff', quote: 'made-up quote' }] },
      { ...finding, citations: [...finding.citations, { sourceId: 'unknown', quote: 'return' }] },
    ]) assert.throws(() => parseReviewResponse(JSON.stringify({ findings: [invalid] }), file, sources))
    assert.throws(() => parseReviewResponse('{broken', file, sources))
    let calls = 0
    const report = await new CodeReviewAssistant({ root: f.root, context: async () => context,
      complete: async (messages) => {
        calls++
        if (calls === 2) assert.match(messages[1].content, /Предыдущий ответ не прошёл/)
        return { content: calls === 1 ? '{broken' : JSON.stringify({ findings: [finding] }), usage }
      } }).review(f.base, f.head)
    assert.equal(calls, 2); assert.equal(report.status, 'complete')
    assert.deepEqual(report.findings, [finding])
  } finally { f.close() }
})

test('existing cloud model client sends diff and RAG in the actual HTTP request, without grounded-answer adaptation', async () => {
  const f = fixture(), previousKey = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'fixture-key'
  try {
    let calls = 0
    const request = (async (url, init) => {
      calls++
      assert.equal(url, 'https://api.deepseek.com/chat/completions')
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fixture-key')
      const body = JSON.parse(String(init?.body))
      assert.equal(body.response_format.type, 'json_object')
      const payload = JSON.parse(body.messages[body.messages.length - 1].content)
      assert.match(payload.file.patch, /return a - b/)
      assert.ok(payload.sources.some((source: { kind: string }) => source.kind === 'documentation'))
      assert.ok(payload.sources.some((source: { kind: string }) => source.kind === 'code'))
      assert.ok(!JSON.stringify(body.messages).includes('fixture-key'))
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ findings: [finding] }) } }] })
    }) as typeof fetch
    const client = modelClient('cloud', undefined, request)
    const report = await new CodeReviewAssistant({ root: f.root, complete: client.complete, model: client.stats.model }).review(f.base, f.head)
    assert.equal(report.status, 'complete'); assert.equal(calls, 1)
    assert.deepEqual(report.findings, [finding])
  } finally {
    f.close()
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousKey
  }
})

test('model failure is not a clean review; private provider error is withheld and cancellation propagates', async () => {
  const f = fixture()
  try {
    const report = await new CodeReviewAssistant({ root: f.root, complete: async () => { throw new Error('key=do-not-print') } }).review(f.base, f.head)
    assert.equal(report.status, 'failed'); assert.equal(report.reviewedFiles, 0)
    assert.ok(!JSON.stringify(report).includes('do-not-print'))
    assert.match(renderReview(report), /Покрытие неполное/)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(new CodeReviewAssistant({ root: f.root }).review(f.base, f.head, controller.signal))
  } finally { f.close() }
})

test('skipped files and corpus limits produce partial scope; model prose cannot render mentions, images or HTML', async () => {
  const f = fixture()
  try {
    const context: ReviewContext = { ...await collectReviewContext(f.root, f.base, f.head),
      totalFiles: 2, corpusTruncated: true, skipped: [{ path: '.env', reason: 'Закрытый путь' }] }
    const injected = { ...finding, title: '<script>@someone</script> ![x](https://example.test)' }
    const report = await new CodeReviewAssistant({ root: f.root, context: async () => context,
      complete: async () => ({ content: JSON.stringify({ findings: [injected] }), usage }) }).review(f.base, f.head)
    assert.equal(report.status, 'partial')
    const markdown = renderReview(report)
    assert.ok(!markdown.includes('<script>')); assert.ok(!markdown.includes('@someone')); assert.ok(!markdown.includes('![x]('))
    assert.match(markdown, /Пропущен/)
    const comment = reviewComment(markdown + '😀'.repeat(20000))
    assert.ok(Buffer.byteLength(comment) <= 55000)
    assert.match(comment, /review.md и review.json/)
    assert.ok(!comment.includes('\uFFFD'))
  } finally { f.close() }
})
