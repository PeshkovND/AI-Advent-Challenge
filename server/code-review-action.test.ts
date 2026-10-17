import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { actionSettings, publishReviewComment, runReviewAction } from './code-review-action'
import type { RagCompletion } from './rag-retrieval'

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'review-action-'))
  const root = join(workspace, 'target'), temp = join(workspace, 'temp')
  mkdirSync(root); mkdirSync(temp)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q'); git('config', 'user.name', 'Action test'); git('config', 'user.email', 'action@example.test')
  mkdirSync(join(root, 'Docs'))
  writeFileSync(join(root, 'Docs/Architecture.md'), '# Invoice\nSwift Invoice.total returns price multiplied by quantity.\n')
  writeFileSync(join(root, 'Invoice.swift'), 'func total(price: Int, quantity: Int) -> Int { price * quantity }\n')
  writeFileSync(join(root, 'App.xcconfig'), 'SWIFT_VERSION = 5.0\n')
  writeFileSync(join(root, 'App.pbxproj'), '// Xcode project\n')
  writeFileSync(join(root, 'Info.plist'), '<plist><dict/></plist>\n')
  writeFileSync(join(root, 'App.entitlements'), '<plist><dict/></plist>\n')
  git('add', '.'); git('commit', '-qm', 'baseline'); const base = git('rev-parse', 'HEAD')
  writeFileSync(join(root, 'Invoice.swift'), 'func total(price: Int, quantity: Int) -> Int { price + quantity }\n')
  writeFileSync(join(root, '.env'), 'DEEPSEEK_API_KEY=TARGET_KEY_MUST_NOT_BE_LOADED\n')
  git('add', 'Invoice.swift'); git('commit', '-qm', 'regression'); const head = git('rev-parse', 'HEAD')
  const event = { number: 7, repository: { full_name: 'example/MyFamily' }, pull_request: {
    number: 7, base: { sha: base, repo: { full_name: 'example/MyFamily' } }, head: { sha: head },
  } }
  const eventPath = join(temp, 'event.json'); writeFileSync(eventPath, JSON.stringify(event))
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temp,
    GITHUB_REPOSITORY: 'example/MyFamily', GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_EVENT_PATH: eventPath,
    REVIEW_REPOSITORY_PATH: 'target', REVIEW_API_KEY: 'fixture-model-key', REVIEW_GITHUB_TOKEN: 'fixture-github-key',
    REVIEW_BASE: '', REVIEW_HEAD: '', REVIEW_MODEL: 'fixture-model', REVIEW_PREPARE_ONLY: 'false', REVIEW_PUBLISH_COMMENT: 'false',
    GITHUB_OUTPUT: join(temp, 'outputs'), GITHUB_STEP_SUMMARY: join(temp, 'summary'),
  }
  return { workspace, root, temp, git, base, head, event, env, close: () => rmSync(workspace, { recursive: true, force: true }) }
}
const usage = { inputTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
const complete: RagCompletion = async (messages) => {
  const payload = JSON.parse(messages[messages.length - 1].content)
  assert.equal(payload.file.path, 'Invoice.swift')
  assert.match(payload.file.patch, /price \+ quantity/)
  assert.ok(payload.sources.some((source: { kind: string }) => source.kind === 'documentation'))
  assert.ok(!JSON.stringify(payload).includes('TARGET_KEY_MUST_NOT_BE_LOADED'))
  return { content: JSON.stringify({ findings: [{ category: 'bug', severity: 'high', path: 'Invoice.swift', line: 1, side: 'RIGHT',
    title: 'Неверная сумма', explanation: 'Для 100 и 3 возвращается 103 вместо 300.', suggestion: 'Вернуть умножение.',
    citations: [{ sourceId: 'diff', quote: 'price + quantity' }] }] }), usage }
}

test('portable action reviews a separate Swift repository, preserves artifacts and ignores target .env', async () => {
  const f = fixture(), originalKey = process.env.DEEPSEEK_API_KEY
  try {
    const result = await runReviewAction(f.env, { complete })
    assert.equal(result.status, 'complete'); assert.equal(result.failed, false)
    const report = JSON.parse(readFileSync(join(result.directory, 'review.json'), 'utf8'))
    assert.equal(report.findings.length, 1); assert.equal(report.findings[0].path, 'Invoice.swift')
    assert.equal(report.corpusDocuments, 6)
    const outputs = readFileSync(f.env.GITHUB_OUTPUT!, 'utf8')
    assert.match(outputs, /status=complete/); assert.match(outputs, /findings=1/)
    assert.ok(!outputs.includes('fixture-model-key')); assert.ok(!outputs.includes('fixture-github-key'))
    assert.match(readFileSync(f.env.GITHUB_STEP_SUMMARY!, 'utf8'), /Invoice.swift:1/)
    assert.equal(process.env.DEEPSEEK_API_KEY, originalKey)
    assert.equal(f.git('rev-parse', 'HEAD'), f.head)
    assert.ok(!existsSync(join(f.root, 'node_modules')))
  } finally { f.close() }
})

test('action rejects unsafe publication events, ref overrides, escaping paths, missing keys and invalid flags', () => {
  const f = fixture()
  try {
    assert.throws(() => actionSettings({ ...f.env, REVIEW_PUBLISH_COMMENT: 'true', GITHUB_EVENT_NAME: 'pull_request' }), /pull_request_target/)
    assert.throws(() => actionSettings({ ...f.env, REVIEW_PUBLISH_COMMENT: 'true', REVIEW_HEAD: f.base }), /exact base\/head/)
    assert.throws(() => actionSettings({ ...f.env, REVIEW_API_KEY: '' }), /api-key/)
    assert.throws(() => actionSettings({ ...f.env, REVIEW_PREPARE_ONLY: 'maybe' }), /Boolean/)
    assert.throws(() => actionSettings({ ...f.env, GITHUB_REPOSITORY: 'other/repo' }), /does not match/)
    const outside = mkdtempSync(join(tmpdir(), 'review-outside-'))
    try {
      symlinkSync(outside, join(f.workspace, 'escaped'))
      assert.throws(() => actionSettings({ ...f.env, REVIEW_REPOSITORY_PATH: 'escaped' }), /within github.workspace/)
    } finally { rmSync(outside, { recursive: true, force: true }) }
  } finally { f.close() }
})

test('GitHub publisher paginates, updates only the bot comment and withholds stale reviews', async () => {
  const f = fixture()
  try {
    const calls: Array<{ path: string; method: string; body?: string }> = []
    const request = (async (url, init) => {
      const path = new URL(String(url)).pathname + new URL(String(url)).search
      const method = init?.method || 'GET'; calls.push({ path, method, body: init?.body as string })
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fixture-github-key')
      if (path.includes('/pulls/7')) return Response.json({ state: 'open', base: { sha: f.base }, head: { sha: f.head } })
      if (new URL(String(url)).searchParams.get('page') === '1') return Response.json(Array.from({ length: 100 }, (_, id) => ({ id, user: { login: 'someone' }, body: '<!-- day-32-ai-review -->' })))
      if (new URL(String(url)).searchParams.get('page') === '2') return Response.json([{ id: 123, user: { login: 'github-actions[bot]' }, body: '<!-- day-32-ai-review -->previous' }])
      assert.equal(method, 'PATCH'); assert.match(path, /issues\/comments\/123$/)
      assert.equal(JSON.parse(String(init?.body)).body, 'new review')
      return Response.json({ html_url: 'https://github.com/example/MyFamily/pull/7#issuecomment-123' })
    }) as typeof fetch
    const url = await publishReviewComment(f.event, f, 'new review', f.env, request)
    assert.match(url, /issuecomment-123/); assert.equal(calls.length, 5)
    let staleCalls = 0
    const stale = (async () => { staleCalls++; return Response.json({ state: 'open', base: { sha: f.base }, head: { sha: 'different' } }) }) as typeof fetch
    assert.equal(await publishReviewComment(f.event, f, 'review', f.env, stale), '')
    assert.equal(staleCalls, 1)
  } finally { f.close() }
})

test('model failure keeps reports and signals action failure instead of approving the PR', async () => {
  const f = fixture()
  try {
    const result = await runReviewAction(f.env, { complete: async () => { throw new Error('private provider error fixture-model-key') } })
    assert.equal(result.failed, true); assert.equal(result.status, 'failed')
    const report = readFileSync(join(result.directory, 'review.json'), 'utf8')
    assert.ok(!report.includes('fixture-model-key'))
    assert.ok(existsSync(join(result.directory, 'comment.md')))
    assert.match(readFileSync(f.env.GITHUB_OUTPUT!, 'utf8'), /status=failed/)
  } finally { f.close() }
})

test('committed bundle runs without source files, node_modules, tsx or keys in an external iOS checkout', () => {
  const f = fixture()
  try {
    const bundle = join(f.temp, 'standalone.cjs')
    cpSync(new URL('../dist-action/index.cjs', import.meta.url), bundle)
    const stdout = execFileSync(process.execPath, [bundle], { cwd: f.root, encoding: 'utf8', env: {
      ...f.env, GITHUB_EVENT_NAME: 'push', REVIEW_BASE: f.base, REVIEW_HEAD: f.head,
      REVIEW_PREPARE_ONLY: 'true', REVIEW_API_KEY: '', REVIEW_GITHUB_TOKEN: '',
      NODE_OPTIONS: '', NODE_PATH: '',
    } })
    assert.match(stdout, /AI review: prepared/)
    const outputs = readFileSync(f.env.GITHUB_OUTPUT!, 'utf8')
    const directory = outputs.match(/report-directory=(.+)/)![1]
    const context = JSON.parse(readFileSync(join(directory, 'context.json'), 'utf8'))
    assert.equal(context.files[0].path, 'Invoice.swift'); assert.equal(context.corpusDocuments, 6)
    assert.equal(context.skipped.length, 0)
    assert.ok(!existsSync(join(f.root, 'node_modules')))
  } finally { f.close() }
})
