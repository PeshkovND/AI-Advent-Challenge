import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { request as httpRequest } from 'node:http'
import express from 'express'
import { ReleaseService, releaseArtifacts, releaseInputSchema, releaseRepositoryInfo } from './release-service'
import { collectGitContext } from './git-context'
import { analyzeReleaseFile, parseReleaseAnalysis, releaseEvidence, ReleaseAnalysisError } from './release-analysis'
import { createReleaseRouter } from './release-router'
import { Projects } from './projects'
import type { ReleaseRun } from '../src/release-types'
import type { Completion } from './model-client'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'day35-release-')), root = join(directory, 'repo')
  mkdirSync(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (path: string, value: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value) }
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD') }
  git('init', '-q'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture')
  write('README.md', '# Calculator\nThe total function returns the sum of arguments.\n')
  write('src/math.ts', 'export function total(a: number, b: number) {\n  return a + b\n}\n')
  write('.env', 'SECRET=excluded-fixture-secret\n')
  const base = commit()
  write('src/math.ts', 'export function total(a: number, b: number) {\n  return a - b\n}\n')
  const head = commit()
  const input = releaseInputSchema.parse({ projectId: 'current', baseRef: base, headRef: head, version: '1.0.0', provider: 'local' })
  return { directory, root, git, write, commit, base, head, input, project: { name: 'Calculator', root }, close: () => rmSync(directory, { recursive: true, force: true }) }
}
const usage = { inputTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
function response(evidenceId: string) {
  return { summary: { text: 'Сложение аргументов заменено вычитанием.', evidenceIds: [evidenceId.replace(/^R/, 'L'), evidenceId] }, userNote: '',
    risks: [{ text: 'Если ожидается сумма, результат расчёта будет неверным.', severity: 'high', evidenceIds: [evidenceId] }],
    checks: [{ text: 'Расчёт суммы', evidenceIds: [evidenceId], steps: ['Вызвать total(10, 5).'], expected: '15 по контракту продукта.' }] }
}
function model(complete?: Completion) {
  const stats = { model: 'fixture-model', calls: 0, promptTokens: 0, outputTokens: 0 }
  return { stats, complete: complete || (async (messages, stage) => {
    stats.calls++
    if (stage === 'verify') {
      const { claims } = JSON.parse(messages[messages.length - 1].content)
      return { content: JSON.stringify({ items: claims.map((claim: { claimId: number }) => ({ claimId: claim.claimId, supported: true, reason: 'Подтверждено тестовым источником.' })) }), usage }
    }
    const payload = JSON.parse(messages[messages.length - 1].content)
    const evidence = payload.evidence.find((entry: { changed: boolean; quote: string }) => entry.changed && entry.quote.includes('a - b')) || payload.evidence.find((entry: { changed: boolean }) => entry.changed)
    return { content: JSON.stringify(response(evidence.id)), usage }
  }) }
}
async function waitFor(service: ReleaseService, id: string, state?: ReleaseRun['state']) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const run = service.get(id)
    if (state ? run.state === state : !['queued', 'collecting', 'analyzing'].includes(run.state)) return run
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error('Запуск не завершился за 15 секунд.')
}

test('release context compares exact endpoints and ignores dirty files, unlike PR merge-base mode', async () => {
  const f = fixture()
  try {
    f.git('checkout', '--detach', f.base); f.write('base-only.md', 'Present only on advanced base\n'); const advanced = f.commit()
    f.write('src/math.ts', 'UNCOMMITTED_POISON\n')
    const context = await collectGitContext(f.root, advanced, f.head, undefined, 'direct')
    assert.equal(context.base, advanced)
    assert.ok(context.files.some((file) => file.path === 'base-only.md' && file.status === 'D'))
    assert.ok(context.files.some((file) => file.patch.includes('return a - b')))
    assert.ok(!JSON.stringify(context).includes('UNCOMMITTED_POISON'))
    assert.ok(!JSON.stringify(context).includes('excluded-fixture-secret'))
    const pr = await collectGitContext(f.root, advanced, f.head)
    assert.ok(!pr.files.some((file) => file.path === 'base-only.md'))
  } finally { f.close() }
})

test('rejects fabricated evidence IDs and citations only to unchanged lines; retains immutable quote and side', async () => {
  const f = fixture()
  try {
    const context = await collectGitContext(f.root, f.base, f.head, undefined, 'direct'), file = context.files[0]
    const evidence = releaseEvidence(file, [], f.base, f.head)
    assert.throws(() => parseReleaseAnalysis(JSON.stringify(response('R9999')), file, evidence))
    const unchanged = evidence.find((item) => !item.changed)!
    assert.throws(() => parseReleaseAnalysis(JSON.stringify(response(unchanged.id)), file, evidence))
    const parsed = parseReleaseAnalysis(JSON.stringify(response('R2')), file, evidence)
    const after = parsed.evidence.find((item) => item.id === 'R2')!
    assert.equal(after.quote.trim(), 'return a - b')
    assert.equal(after.commit, f.head); assert.equal(after.line, 2)
    const oneSided = response('R2'); oneSided.summary.evidenceIds = ['R2']
    assert.deepEqual(new Set(parseReleaseAnalysis(JSON.stringify(oneSided), file, evidence).summary.evidenceIds), new Set(['L2', 'R2']))
    assert.equal(parsed.checks[0].status, 'pending')
  } finally { f.close() }
})

test('reads full changed files and diffs beyond the former byte and file-count limits', async () => {
  const f = fixture()
  try {
    const large = Array.from({ length: 4000 }, (_, index) => `let field${index} = "Полный контекст ${index}"`).join('\n') + '\n// END_OF_LARGE_FILE\n'
    f.write('Package.swift', large)
    for (let index = 0; index < 31; index++) f.write(`src/extra${index}.ts`, `export const value${index} = ${index}\n`)
    const head = f.commit()
    const context = await collectGitContext(f.root, f.base, head, undefined, 'direct')
    const file = context.files.find(({ path }) => path === 'Package.swift')!
    assert.ok(Buffer.byteLength(large) > 128000)
    assert.equal(file.content, large)
    assert.ok(Buffer.byteLength(file.patch) > 10000)
    assert.match(file.patch, /\+\/\/ END_OF_LARGE_FILE/)
    assert.equal(file.contentTruncated, false); assert.equal(file.patchTruncated, false)
    const evidence = releaseEvidence(file, [], context.base, context.head)
    assert.ok(Buffer.byteLength(JSON.stringify(evidence)) > 18000)
    assert.ok(evidence.some(({ quote, changed }) => changed && quote === '// END_OF_LARGE_FILE'))
    assert.equal(context.files.length, 33); assert.deepEqual(context.skipped, [])
    const complete: Completion = async (messages, stage) => {
      const payload = JSON.parse(messages.at(-1)!.content)
      if (stage === 'verify') return { content: JSON.stringify({ items: payload.claims.map(({ claimId }: { claimId: number }) => ({ claimId, supported: true, reason: 'Есть строка.' })) }), usage }
      assert.equal(payload.content, large)
      assert.ok(payload.evidence.some(({ quote }: { quote: string }) => quote === '// END_OF_LARGE_FILE'))
      return { content: JSON.stringify({ summary: { text: 'Добавлен файл.', evidenceIds: Array.from({ length: 16 }, (_, index) => `R${3986 + index}`) }, userNote: '', risks: [], checks: [{ text: 'Проверить файл.', evidenceIds: ['R4001'], steps: ['Открыть файл.'], expected: 'В конце есть комментарий.' }] }), usage }
    }
    assert.equal((await analyzeReleaseFile(file, context, complete)).limited, false)
  } finally { f.close() }
})

test('repairs schema failures using the exact field constraint and previous answer', async () => {
  const f = fixture()
  try {
    const context = await collectGitContext(f.root, f.base, f.head, undefined, 'direct'), file = context.files[0]
    const invalid = response('R2'); invalid.summary.text = 'X'.repeat(901)
    let calls = 0
    const complete: Completion = async (messages, stage) => {
      if (stage === 'verify') return model().complete(messages, stage)
      calls++
      if (calls === 1) return { content: JSON.stringify(invalid), usage }
      assert.ok(messages.some(({ role, content }) => role === 'assistant' && content === JSON.stringify(invalid)))
      assert.match(messages.filter(({ role }) => role === 'system').map(({ content }) => content).join('\n'), /summary\.text: too_big; максимум 900/)
      return { content: JSON.stringify(response('R2')), usage }
    }
    assert.equal((await analyzeReleaseFile(file, context, complete)).verification?.attempts, 2)
    await assert.rejects(analyzeReleaseFile(file, context, async () => ({ content: JSON.stringify(invalid), usage })), (error: unknown) => {
      assert.ok(error instanceof ReleaseAnalysisError)
      assert.equal(error.diagnostics.length, 3)
      assert.match(error.diagnostics[2].issues[0], /summary\.text/)
      assert.ok(!/LEFT|evidenceIds|Предыдущий ответ/.test(error.message))
      return true
    })
  } finally { f.close() }
})

test('persists queue, fixed SHAs, materials and manual results; ready requires every check and review', async () => {
  const f = fixture(), directory = join(f.directory, 'runs')
  const first = new ReleaseService({ directory, model: () => model() })
  let second: ReleaseService | undefined
  try {
    const queued = await first.create({ ...f.input, headRef: 'HEAD' }, f.project)
    assert.equal(queued.state, 'queued'); assert.throws(() => first.artifacts(queued.id))
    f.write('another.md', 'Later unrelated commit\n'); f.commit()
    second = new ReleaseService({ directory, model: () => model() }); second.start()
    const run = await waitFor(second, queued.id)
    assert.equal(run.head, f.head); assert.equal(run.state, 'awaiting_checks'); assert.equal(run.coverage, 'complete')
    assert.ok(!run.files.some((file) => file.path === 'another.md'))
    assert.equal(run.files[0].checks[0].status, 'pending')
    assert.ok(run.files[0].verification?.judgments.every((item) => item.supported))
    assert.equal(second.update(run.id, { reviewed: true }).state, 'awaiting_checks')
    const checkId = run.files[0].checks[0].id
    assert.equal(second.update(run.id, { checkId, status: 'failed', note: 'Результат 5.' }).state, 'awaiting_checks')
    assert.equal(second.update(run.id, { checkId, status: 'passed', note: 'Проверено после исправления.' }).state, 'ready')
    assert.equal(second.update(run.id, { reviewed: false }).state, 'awaiting_checks')
    assert.throws(() => second!.update(run.id, { checkId: 'invented', status: 'passed' }))
    const artifacts = second.artifacts(run.id)
    assert.match(artifacts['changelog.md'], /return a - b/)
    assert.match(artifacts['test-plan.md'], /Проверено после исправления/)
    assert.equal(JSON.parse(readFileSync(join(directory, run.id, 'readiness.json'), 'utf8')).head, f.head)
    const restored = new ReleaseService({ directory })
    assert.equal(restored.get(run.id).files[0].checks[0].note, 'Проверено после исправления.')
    await second.stop()
    second.retry(run.id)
    assert.equal(second.get(run.id).state, 'queued')
    assert.equal(existsSync(join(directory, run.id, 'readiness.json')), false)
  } finally { await first.stop(); await second?.stop(); f.close() }
})

test('CI pin changes cannot invent user-facing features or dependency regression risks', () => {
  const file = { path: '.github/workflows/review.yml', status: 'M', content: '- uses: org/action@new\n', contentTruncated: false, patchTruncated: false,
    patch: '@@ -1 +1 @@\n-- uses: org/action@old\n+- uses: org/action@new\n' }
  const evidence = releaseEvidence(file, [], 'base', 'head')
  const data = response('R1')
  data.userNote = 'Новая функция продукта'
  assert.throws(() => parseReleaseAnalysis(JSON.stringify(data), file, evidence))
  data.userNote = ''
  assert.throws(() => parseReleaseAnalysis(JSON.stringify(data), file, evidence))
  data.risks = []
  assert.equal(parseReleaseAnalysis(JSON.stringify(data), file, evidence).userNote, '')
})

test('a skipped file prevents ready; draft export explains coverage', async () => {
  const f = fixture(), service = new ReleaseService({ directory: join(f.directory, 'runs'), model: () => model() })
  try {
    f.write('asset.bin', 'binary-ish unsupported extension'); const head = f.commit()
    const queued = await service.create({ ...f.input, headRef: head }, f.project); service.start()
    const run = await waitFor(service, queued.id)
    assert.equal(run.coverage, 'partial'); assert.equal(run.skipped[0].path, 'asset.bin')
    service.update(run.id, { reviewed: true })
    for (const check of run.files.flatMap((file) => file.checks)) service.update(run.id, { checkId: check.id, status: 'passed' })
    assert.equal(service.get(run.id).state, 'awaiting_checks')
    assert.match(service.artifacts(run.id)['changelog.md'], /asset.bin/)
  } finally { await service.stop(); f.close() }
})

test('provider failure produces a saved error with no fake checks; retry preserves commits', async () => {
  const f = fixture()
  let fail = true
  const service = new ReleaseService({ directory: join(f.directory, 'runs'), model: () => model(fail ? async () => { throw new Error('provider-response-sensitive') } : undefined) })
  try {
    service.start(); const queued = await service.create(f.input, f.project)
    const run = await waitFor(service, queued.id)
    assert.equal(run.state, 'failed'); assert.equal(run.files.length, 0)
    assert.ok(!JSON.stringify(run).includes('provider-response-sensitive'))
    fail = false; service.retry(run.id)
    const retried = await waitFor(service, run.id)
    assert.equal(retried.state, 'awaiting_checks'); assert.equal(retried.base, f.base); assert.equal(retried.head, f.head)
  } finally { await service.stop(); f.close() }
})

test('cancellation during model call cannot publish a late result', async () => {
  const f = fixture()
  let entered!: () => void, finish!: (value: Awaited<ReturnType<Completion>>) => void
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
  const service = new ReleaseService({ directory: join(f.directory, 'runs'), model: () => model(async () => { entered(); return new Promise((resolve) => { finish = resolve }) }) })
  try {
    service.start(); const run = await service.create(f.input, f.project)
    await enteredPromise
    assert.equal(service.cancel(run.id).state, 'cancelled')
    finish({ content: JSON.stringify(response('R2')), usage })
    await service.stop()
    assert.equal(service.get(run.id).state, 'cancelled'); assert.equal(service.get(run.id).files.length, 0)
    assert.throws(() => service.artifacts(run.id))
  } finally { await service.stop(); f.close() }
})

test('semantic rejection withholds material despite genuine diff citations', async () => {
  const f = fixture()
  let verifications = 0
  const service = new ReleaseService({ directory: join(f.directory, 'runs'), model: (_provider, _signal, purpose) => purpose === 'analysis' ? model() : model(async (messages) => {
    verifications++
    const { claims } = JSON.parse(messages[messages.length - 1].content)
    return { content: JSON.stringify({ items: claims.map((claim: { claimId: number }) => ({ claimId: claim.claimId, supported: false, reason: 'Сводка содержит неподтверждённое утверждение.' })) }), usage }
  }) })
  try {
    service.start(); const queued = await service.create(f.input, f.project)
    const run = await waitFor(service, queued.id)
    assert.equal(verifications, 3); assert.equal(run.state, 'failed'); assert.equal(run.files.length, 0)
    assert.throws(() => service.artifacts(run.id))
  } finally { await service.stop(); f.close() }
})

test('interrupted runs are recoverable and invalid/equal refs fail before calling AI', async () => {
  const f = fixture(), directory = join(f.directory, 'runs'), service = new ReleaseService({ directory })
  try {
    await assert.rejects(service.create({ ...f.input, baseRef: 'missing-branch' }, f.project))
    await assert.rejects(service.create({ ...f.input, baseRef: f.head }, f.project))
    assert.equal(releaseInputSchema.safeParse({ ...f.input, headRef: '--help' }).success, false)
    const run = await service.create(f.input, f.project)
    writeFileSync(join(directory, run.id, 'run.json'), JSON.stringify({ ...run, state: 'analyzing' }))
    service.start()
    assert.equal(service.get(run.id).state, 'failed'); assert.match(service.get(run.id).error!, /Сервер остановился/)
    assert.throws(() => service.get('../../outside'))
    const info = await releaseRepositoryInfo(f.root)
    assert.equal(info.head, f.head); assert.ok(info.refs.includes('HEAD'))
  } finally { await service.stop(); f.close() }
})

test('HTTP validates local access, creates asynchronously and exports only allowlisted materials', async () => {
  const f = fixture(), directory = join(f.directory, 'runs'), service = new ReleaseService({ directory, model: () => model() })
  const projects = new Projects({ configPath: join(f.directory, 'projects.json') }); const opened = projects.open(f.root)
  const app = express(); app.use(express.json()); app.use('/api/releases', createReleaseRouter(service, projects))
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}/api/releases`
  const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.equal((await fetch(`${url}/status`, { headers: { Origin: 'https://untrusted.test' } })).status, 403)
    const foreignHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${url}/status`, { headers: { Host: 'untrusted.test' } }, (response) => { response.resume(); resolve(response.statusCode!) })
      request.on('error', reject); request.end()
    })
    assert.equal(foreignHostStatus, 403)
    assert.equal((await fetch(`${url}/runs`, post({ ...f.input, root: '/' }))).status, 400)
    service.start()
    const created = await fetch(`${url}/runs`, post({ ...f.input, projectId: opened.project.id })); assert.equal(created.status, 202)
    const { id } = await created.json()
    const run = await waitFor(service, id)
    const download = await fetch(`${url}/runs/${id}/artifacts/bundle.json`)
    assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition')!, /attachment/)
    const bundle = await download.json()
    assert.equal(bundle.format, 'release-copilot-v1'); assert.equal(Object.keys(bundle.files).length, 4)
    assert.equal(JSON.parse(bundle.files['readiness.json']).head, run.head)
    const updated = service.update(id, { checkId: run.files[0].checks[0].id, status: 'failed', note: 'Проверено вручную: результат 5 вместо 15.' })
    const zipDownload = await fetch(`${url}/runs/${id}/artifacts/bundle.zip`)
    assert.equal(zipDownload.status, 200)
    assert.equal(zipDownload.headers.get('content-type'), 'application/zip')
    assert.match(zipDownload.headers.get('content-disposition')!, /attachment; filename="bundle.zip"/)
    const zipPath = join(f.directory, 'bundle.zip')
    writeFileSync(zipPath, Buffer.from(await zipDownload.arrayBuffer()))
    // Validate with an independent ZIP reader, including CRC and UTF-8 content.
    execFileSync('unzip', ['-t', zipPath])
    const names = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n')
    const expectedFiles = releaseArtifacts(updated)
    assert.deepEqual(names.sort(), Object.keys(expectedFiles).sort())
    for (const [name, content] of Object.entries(expectedFiles)) {
      assert.equal(execFileSync('unzip', ['-p', zipPath, name], { encoding: 'utf8' }), content)
    }
    assert.equal((await fetch(`${url}/runs/${id}/artifacts/run.json`)).status, 404)
    assert.equal((await fetch(`${url}/runs/${id}`, { ...post({ reviewed: true, state: 'ready' }), method: 'PATCH' })).status, 400)
    assert.equal(JSON.parse(releaseArtifacts(run)['readiness.json']).state, 'awaiting_checks')
  } finally { await service.stop(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); f.close() }
})
