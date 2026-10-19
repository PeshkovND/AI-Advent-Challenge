import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectGitContext } from './git-context'
import { candidateRelations, collectImpactContext, type ImpactContext } from './release-relations'
import { analyzeImpact, parseImpact, impactRisks } from './release-impact'
import { ReleaseAnalysisError } from './release-analysis'
import { ReleaseService } from './release-service'
import { releaseChecks, type ReleaseFile, type ReleaseRun } from '../src/release-types'
import type { Completion } from './model-client'

const usage = { inputTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-impact-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (name: string, text: string) => writeFileSync(join(root, name), text)
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD') }
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test')
  write('Profile.swift', 'struct ProfileCompletion {\n  let first: String\n  let last: String\n  var isComplete: Bool { !first.isEmpty && !last.isEmpty }\n}\n')
  write('Auth.swift', 'func profileReady(_ first: String, _ last: String) -> Bool {\n  return !first.isEmpty && !last.isEmpty\n}\n')
  write('Consumer.swift', 'func canEnter() -> Bool { profileReady("Alice", "") }\n')
  write('Legacy.swift', 'func legacyReady() -> Bool { true }\n')
  write('LegacyCaller.swift', 'func legacyConsumer() -> Bool { legacyReady() }\n')
  write('.env', 'SECRET=impact-fixture-secret\n')
  write('Unrelated.swift', '// ProfileCompletion and profileReady are only mentioned in a comment.\nlet copy = "ProfileCompletion"\n')
  const base = commit()
  write('Profile.swift', 'struct ProfileCompletion {\n  let first: String\n  let last: String\n  var isComplete: Bool { !first.isEmpty || !last.isEmpty }\n}\n')
  write('Auth.swift', 'func profileReady(_ first: String, _ last: String) -> Bool {\n  return ProfileCompletion(first: first, last: last).isComplete\n}\n')
  rmSync(join(root, 'Legacy.swift')); const head = commit()
  return { root, write, base, head, close: () => rmSync(root, { recursive: true, force: true }) }
}
function data(context: ImpactContext, files: ReleaseFile[] = []) {
  const id = (path: string, side: 'LEFT' | 'RIGHT', part: string) => context.evidence.find((e) => e.path === path && e.side === side && e.quote.includes(part))!.id
  const ids = [id('Profile.swift', 'LEFT', '&&'), id('Profile.swift', 'RIGHT', '||'), id('Auth.swift', 'LEFT', '&&'), id('Auth.swift', 'RIGHT', 'ProfileCompletion')]
  return { summary: { text: 'Проверка заполненности профиля изменилась с двух полей на хотя бы одно.', evidenceIds: ids }, findings: [{ title: 'Частично заполненный профиль проходит проверку', status: 'risk', severity: 'medium', text: 'Auth вызывает новый предикат с OR, раньше требовались оба поля.', evidenceIds: ids }],
    riskReviews: impactRisks(files, context).map(({ riskId }) => ({ riskId, verdict: 'confirmed', reason: 'Вызов использует предикат с OR вместо прежнего AND.', evidenceIds: ids })),
    checks: [{ text: 'Профиль с одним полем', evidenceIds: ids, steps: ['Вызвать profileReady("Alice", "").'], expected: 'Новая версия вернёт true, предыдущая возвращала false.' }] }
}
const fileWithRisk: ReleaseFile = { path: 'Auth.swift', status: 'M', summary: { text: 'Изменена проверка.', evidenceIds: [] }, userNote: '', risks: [{ text: 'Частично заполненный профиль может пройти проверку.', severity: 'medium', evidenceIds: [] }], checks: [], evidence: [], limited: false }
const verdict: Completion = async (messages) => {
  const { claims } = JSON.parse(messages.at(-1)!.content)
  return { content: JSON.stringify({ items: claims.map(({ claimId }: { claimId: number }) => ({ claimId, supported: true, reason: 'Обосновано двумя версиями вызова и реализации.' })) }), usage }
}

test('relations use both frozen trees, include unchanged consumers and removed symbols, and exclude comments/secrets', async () => {
  const f = fixture()
  try {
    f.write('Profile.swift', 'WORKTREE_POISON')
    const git = await collectGitContext(f.root, f.base, f.head, undefined, 'direct')
    const context = await collectImpactContext(f.root, git)
    assert.ok(context.relations.some((e) => e.from === 'Auth.swift' && e.to === 'Profile.swift' && e.versions.includes('head')))
    assert.ok(context.files.includes('Consumer.swift'))
    assert.ok(context.relations.some((e) => e.from === 'LegacyCaller.swift' && e.to === 'Legacy.swift' && e.versions.includes('base')))
    assert.ok(!context.files.includes('Unrelated.swift'))
    assert.ok(!JSON.stringify(context).includes('impact-fixture-secret')); assert.ok(!JSON.stringify(context).includes('WORKTREE_POISON'))
    for (const e of context.evidence) assert.equal(e.quote, context.documents.find((d) => d.path === e.path && d.commit === e.commit)!.lines[e.line! - 1].text)
    assert.equal(context.evidence.find((e) => e.path === 'Profile.swift' && e.quote.includes('||'))!.commit, f.head)
    assert.equal(parseImpact(JSON.stringify(data(context, [fileWithRisk])), context, [fileWithRisk]).riskReviews[0].verdict, 'confirmed')
  } finally { f.close() }
})

test('candidate relations resolve relative imports but do not guess ambiguous method owners', () => {
  const edges = candidateRelations([{ path: 'src/caller.ts', text: "// import './ignored'\nconst copy = \"import './ignored'\"\nimport { entry } from './helper'\nexport const invoke = () => entry()" }, { path: 'src/helper.ts', text: 'export function entry() {}' }, { path: 'src/ignored.ts', text: 'export function ignored() {}' }, { path: 'a.swift', text: 'func ambiguous() {}' }, { path: 'b.swift', text: 'func ambiguous() {}' }, { path: 'c.swift', text: 'func user() { ambiguous() }' }])
  assert.ok(edges.some((e) => e.from === 'src/caller.ts' && e.to === 'src/helper.ts'))
  assert.ok(!edges.some((e) => e.from === 'c.swift'))
  assert.ok(!edges.some((e) => e.from === 'src/caller.ts' && e.to === 'src/ignored.ts'))
})

test('impact rejects fabricated, single-file, unchanged-only citations and missing risk verdicts', async () => {
  const f = fixture()
  try {
    const git = await collectGitContext(f.root, f.base, f.head, undefined, 'direct'), context = await collectImpactContext(f.root, git)
    for (const ids of [['F999:R1'], [context.evidence.find((e) => e.path === 'Profile.swift' && e.changed)!.id], context.evidence.filter((e) => !e.changed && ['Profile.swift', 'Auth.swift'].includes(e.path)).map((e) => e.id)]) {
      const value = data(context); value.findings[0].evidenceIds = ids
      assert.throws(() => parseImpact(JSON.stringify(value), context, []))
    }
    assert.throws(() => parseImpact(JSON.stringify(data(context)), context, [fileWithRisk]))
    const single = data(context); single.findings[0].evidenceIds = [context.evidence.find((e) => e.path === 'Profile.swift' && e.changed)!.id]
    single.checks[0].evidenceIds = single.findings[0].evidenceIds
    assert.throws(() => parseImpact(JSON.stringify(single), context, []), (error: Error) => /findings\[0\]/.test(error.message) && /checks\[0\]/.test(error.message))
    const value = data(context, [fileWithRisk]); value.riskReviews[0].riskId = 'invented'
    assert.throws(() => parseImpact(JSON.stringify(value), context, [fileWithRisk]))
    const intrinsic = { ...fileWithRisk, path: 'Profile.swift' }, intrinsicData = data(context, [intrinsic])
    intrinsicData.riskReviews[0].reason = 'Предикат в реализации использует OR.'
    intrinsicData.riskReviews[0].evidenceIds = [context.evidence.find((e) => e.path === 'Profile.swift' && e.quote.includes('||'))!.id]
    assert.equal(parseImpact(JSON.stringify(intrinsicData), context, [intrinsic]).riskReviews.length, 1)
    let attempts = 0
    await assert.rejects(analyzeImpact(context, [fileWithRisk], async () => { attempts++; return { content: JSON.stringify(data(context, [fileWithRisk])), usage } }, async (messages) => {
      const result = await verdict(messages, 'verify'), parsed = JSON.parse(result.content)
      parsed.items[0].supported = false; parsed.items[0].reason = 'Не подтверждено.'
      return { ...result, content: JSON.stringify(parsed) }
    }), ReleaseAnalysisError)
    assert.equal(attempts, 3)
  } finally { f.close() }
})

test('cancelling impact analysis discards a late model response before verification', async () => {
  const f = fixture()
  try {
    const context = await collectImpactContext(f.root, await collectGitContext(f.root, f.base, f.head, undefined, 'direct'))
    const abort = new AbortController()
    let enter!: () => void, finish!: (response: Awaited<ReturnType<Completion>>) => void, verifications = 0
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const work = analyzeImpact(context, [], async () => { enter(); return new Promise((resolve) => { finish = resolve }) }, async (messages, stage) => { verifications++; return verdict(messages, stage) }, abort.signal)
    const rejected = assert.rejects(work, { name: 'AbortError' })
    await entered; abort.abort(); finish({ content: JSON.stringify(data(context)), usage })
    await rejected; assert.equal(verifications, 0)
  } finally { f.close() }
})

test('repair places the exact corrections after the rejected assistant response', async () => {
  const f = fixture()
  try {
    const context = await collectImpactContext(f.root, await collectGitContext(f.root, f.base, f.head, undefined, 'direct'))
    const invalid = data(context)
    invalid.findings[0].evidenceIds = [context.evidence.find((e) => e.path === 'Profile.swift' && e.changed)!.id]
    let calls = 0
    const result = await analyzeImpact(context, [], async (messages) => {
      calls++
      if (calls === 1) return { content: JSON.stringify(invalid), usage }
      assert.equal(messages.at(-2)!.role, 'assistant'); assert.equal(messages.at(-2)!.content, JSON.stringify(invalid))
      assert.equal(messages.at(-1)!.role, 'user'); assert.match(messages.at(-1)!.content, /findings\[0\]/)
      assert.ok(JSON.parse(messages[1].content).documents.length > 0)
      return { content: JSON.stringify(data(context)), usage }
    }, verdict)
    assert.equal(result.verification?.attempts, 2)
  } finally { f.close() }
})

async function done(service: ReleaseService, id: string): Promise<ReleaseRun> {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) { const run = service.get(id); if (!['queued', 'collecting', 'analyzing'].includes(run.state)) return run; await new Promise((resolve) => setTimeout(resolve, 20)) }
  throw new Error('Worker timed out')
}
test('impact is persisted/exported, gates ready, and can rerun without losing per-file check notes or repeating file analysis', async () => {
  const f = fixture(); let fileCalls = 0, failImpact = false
  const service = new ReleaseService({ directory: join(f.root, 'runs'), model: (_provider, _signal, purpose) => ({ stats: { model: 'fixture', calls: 0, promptTokens: 0, outputTokens: 0 }, complete: async (messages, stage) => {
    if (purpose === 'verification' || purpose === 'impact-verification') return verdict(messages, stage)
    if (purpose === 'impact') {
      if (failImpact) throw new Error('sensitive-provider-response')
      const context = await collectImpactContext(f.root, await collectGitContext(f.root, f.base, f.head, undefined, 'direct'))
      return { content: JSON.stringify(data(context)), usage }
    }
    const payload = JSON.parse(messages.at(-1)!.content)
    fileCalls++
    const ids = payload.evidence.filter((e: { changed: boolean }) => e.changed).map((e: { id: string }) => e.id)
    return { content: JSON.stringify({ summary: { text: 'Изменён контракт.', evidenceIds: ids }, userNote: '', risks: [], checks: [{ text: 'Проверить файл.', evidenceIds: ids, steps: ['Открыть файл.'], expected: 'Изменение присутствует.' }] }), usage }
  } }) })
  try {
    service.start(); const queued = await service.create({ projectId: 'fixture', version: '1.0', baseRef: f.base, headRef: f.head, provider: 'local' }, { root: f.root, name: 'Fixture' })
    const run = await done(service, queued.id)
    assert.equal(run.impact?.state, 'complete'); assert.equal(run.coverage, 'complete')
    for (const check of run.files.flatMap((file) => file.checks)) service.update(run.id, { checkId: check.id, status: 'passed', note: 'Existing note.' })
    assert.equal(service.update(run.id, { reviewed: true }).state, 'awaiting_checks')
    assert.equal(service.update(run.id, { checkId: run.impact!.checks[0].id, status: 'passed' }).state, 'ready')
    const artifacts = service.artifacts(run.id)
    assert.match(artifacts['changelog.md'], /Влияние на связанные файлы/); assert.match(artifacts['test-plan.md'], /Связанные файлы/)
    assert.equal(JSON.parse(artifacts['readiness.json']).impact.state, 'complete')
    const previousCalls = fileCalls
    failImpact = true; service.checkImpact(run.id)
    const failed = await done(service, run.id)
    assert.equal(fileCalls, previousCalls); assert.equal(failed.impact!.state, 'failed'); assert.equal(failed.coverage, 'partial')
    assert.ok(!JSON.stringify(failed).includes('sensitive-provider-response'))
    assert.equal(service.update(run.id, { reviewed: true }).state, 'awaiting_checks')
    assert.equal(failed.files[0].checks[0].note, 'Existing note.')
    failImpact = false; service.checkImpact(run.id)
    const repaired = await done(service, run.id)
    assert.equal(repaired.coverage, 'complete'); assert.equal(fileCalls, previousCalls)
    assert.equal(repaired.impact!.checks[0].status, 'pending')
    assert.ok(releaseChecks(repaired).some((check) => check.note === 'Existing note.'))
    assert.equal(JSON.parse(readFileSync(join(f.root, 'runs', run.id, 'run.json'), 'utf8')).impact.state, 'complete')
  } finally { await service.stop(); f.close() }
})
