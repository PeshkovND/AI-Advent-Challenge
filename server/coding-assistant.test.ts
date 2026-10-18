import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import express from 'express'
import { CodingAssistant } from './coding-assistant'
import { CodingFiles } from './coding-files'
import { DeveloperAssistant } from './developer-assistant'
import { createDeveloperRouter } from './developer-router'
import { modelClient } from './local-rag-service'
import type { RagCompletion } from './rag-retrieval'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'coding-assistant-')), root = join(directory, 'project')
  mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'README.md'), '# Project\n\nAPI pending.\n')
  writeFileSync(join(root, 'src/api.ts'), 'export function refresh() { return "/auth/refresh-token" }\n')
  writeFileSync(join(root, 'src/client.ts'), 'import { refresh } from "./api"\nrefresh()\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-b', 'main'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture')
  return { root, directory, git, close: () => rmSync(directory, { recursive: true, force: true }) }
}
function assistant(root: string, directory: string, replies: unknown[], maxTurns?: number) {
  let index = 0
  const complete: RagCompletion = async (messages) => ({ content: JSON.stringify(messages[0].content.startsWith('Проверь подготовленные изменения') ? { passed: true, goalChecks: [{ requirement: 'Выполнить цель', satisfied: true }], findings: [] } : replies[index++ % replies.length]), usage: { inputTokens: 1, promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
  return new CodingAssistant({ root, directory: join(directory, 'runs'), maxTurns, model: () => ({ complete, model: 'fixture' }) })
}
const reads = { actions: [{ tool: 'search_files', query: 'refresh' }, { tool: 'read_file', path: 'src/api.ts' }, { tool: 'read_file', path: 'src/client.ts' }, { tool: 'read_file', path: 'README.md' }] }
const edits = { actions: [{ tool: 'replace_text', path: 'README.md', oldText: 'API pending.', newText: 'refresh uses /auth/refresh-token (src/api.ts, src/client.ts).' }, { tool: 'write_file', path: 'docs/api.md', content: '# API\n\nrefresh: /auth/refresh-token. Source: src/api.ts.\n' }, { tool: 'get_diff' }] }
const done = { done: true, answer: 'Исследованы API и клиент. Подготовлены README и docs/api.md.' }

test('local coding transport enforces the action schema with an independent context budget', async () => {
  let body: Record<string, unknown> = {}
  const request: typeof fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ message: { content: '{"done":true,"answer":"Готово"}' }, done_reason: 'stop' }), { status: 200 })
  }
  const schema = { type: 'object', properties: { done: { const: true }, answer: { type: 'string' } }, required: ['done', 'answer'], additionalProperties: false }
  const client = modelClient('local', undefined, request, { context: 65536, jsonSchema: schema })
  const result = await client.complete([{ role: 'user', content: 'JSON: выполни файловую задачу' }], 'rewrite')
  assert.equal(JSON.parse(result.content).done, true)
  assert.deepEqual(body.format, schema)
  assert.equal((body.options as { num_ctx: number }).num_ctx, 65536)
})

test('goal → autonomous multi-file search/read → durable preview → valid patch → apply → idempotent reapply', async () => {
  const f = fixture()
  try {
    const agent = assistant(f.root, f.directory, [reads, edits, done])
    const run = await agent.run('Обнови документацию на основе текущего API.', 'local')
    assert.equal(run.status, 'preview'); assert.equal(run.readFiles.length, 3); assert.equal(run.changes.length, 2)
    assert.equal(readFileSync(join(f.root, 'README.md'), 'utf8'), '# Project\n\nAPI pending.\n')
    const patch = join(f.directory, 'result.patch')
    writeFileSync(patch, run.changes.map(({ diff }) => diff).join('\n'))
    f.git('apply', '--check', patch)
    const restored = assistant(f.root, f.directory, [done])
    assert.equal(restored.get(run.id).changes.length, 2)
    assert.equal((await restored.apply(run.id)).status, 'applied')
    assert.match(readFileSync(join(f.root, 'docs/api.md'), 'utf8'), /refresh-token/)
    assert.equal((await restored.apply(run.id)).status, 'applied')
    const repeat = await assistant(f.root, f.directory, [reads, { done: true, answer: 'Документация актуальна.' }]).run('Обнови документацию на основе текущего API.', 'local')
    assert.equal(repeat.changes.length, 0)
  } finally { f.close() }
})

test('read-only usage inventory spans source files and does not create changes', async () => {
  const f = fixture()
  try {
    const run = await assistant(f.root, f.directory, [reads, { done: true, answer: 'refresh определён в src/api.ts:1, вызывается в src/client.ts:2.' }]).run('Найди все места использования API refresh.', 'local')
    const search = run.steps.find(({ tool }) => tool === 'search_files')!
    assert.equal(search.result.total, 3); assert.equal(run.readFiles.length, 3)
    assert.equal(run.status, 'completed'); assert.deepEqual(run.changes, [])
    assert.equal(f.git('status', '--porcelain'), '')
  } finally { f.close() }
})

test('independent review returns factual errors to the writer before a preview can be released', async () => {
  const f = fixture()
  try {
    let index = 0, reviews = 0
    const replies = [reads, edits, done,
      { actions: [{ tool: 'read_file', path: 'README.md' }, { tool: 'replace_text', path: 'README.md', oldText: 'refresh uses', newText: 'The client refresh uses' }, { tool: 'get_diff' }] }, done]
    const complete: RagCompletion = async (messages) => {
      const review = messages[0].content.startsWith('Проверь подготовленные изменения')
      if (review) assert.ok(JSON.parse(messages[1].content).sources.some((source: { path: string }) => source.path === 'src/api.ts'))
      const value = review ? ++reviews === 1 ? { passed: false, goalChecks: [{ requirement: 'Описание клиента', satisfied: false }], findings: [{ path: 'README.md', message: 'Уточните описание клиента на основе src/client.ts.' }] } : { passed: true, goalChecks: [{ requirement: 'Описание клиента', satisfied: true }], findings: [] } : replies[index++]
      return { content: JSON.stringify(value), usage: { inputTokens: 1, promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    }
    const agent = new CodingAssistant({ root: f.root, directory: join(f.directory, 'runs'), model: () => ({ complete, model: 'fixture' }) })
    const run = await agent.run('Обнови документацию API.', 'local')
    assert.equal(reviews, 2); assert.match(run.changes.find(({ path }) => path === 'README.md')!.after, /The client/)
    assert.equal(run.steps.filter(({ tool }) => tool === 'review_changes').length, 2)
    assert.match(readFileSync(join(f.root, 'README.md'), 'utf8'), /API pending/)
  } finally { f.close() }
})

test('an unmet goal check overrides a positive verdict and returns the answer for completion', async () => {
  const f = fixture()
  try {
    let index = 0, reviews = 0
    const replies = [reads, { done: true, answer: 'Найдено определение refresh.' }, { done: true, answer: 'refresh определён в src/api.ts:1 и вызывается в src/client.ts:2.' }]
    const complete: RagCompletion = async (messages) => {
      const review = messages[0].content.startsWith('Проверь подготовленные изменения')
      const value = review ? { passed: true, goalChecks: [{ requirement: 'Указать определение и место вызова', satisfied: ++reviews > 1 }], findings: [] } : replies[index++]
      return { content: JSON.stringify(value), usage: { inputTokens: 1, promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    }
    const agent = new CodingAssistant({ root: f.root, directory: join(f.directory, 'runs'), model: () => ({ complete, model: 'fixture' }) })
    const run = await agent.run('Найди определение refresh и место его вызова.', 'local')
    assert.equal(reviews, 2); assert.match(run.answer, /src\/client.ts:2/)
    assert.equal(run.steps.find(({ tool }) => tool === 'review_changes')!.result.passed, false)
    assert.equal(run.changes.length, 0)
  } finally { f.close() }
})

test('follow-up tasks refine the pending virtual changes and apply the complete result', async () => {
  const f = fixture()
  try {
    const run = await assistant(f.root, f.directory, [reads, edits, done]).run('Обнови документацию API.', 'local')
    const followup = assistant(f.root, f.directory, [
      { actions: [{ tool: 'read_file', path: 'docs/api.md' }, { tool: 'replace_text', path: 'docs/api.md', oldText: '# API', newText: '# Client API' }, { tool: 'get_diff' }] }, done,
    ])
    const refined = await followup.run('Уточни заголовок руководства.', 'local', undefined, run.id)
    assert.equal(refined.changes.length, 2)
    assert.match(refined.changes.find(({ path }) => path === 'docs/api.md')!.after, /Client API/)
    assert.match(readFileSync(join(f.root, 'README.md'), 'utf8'), /API pending/)
    await followup.apply(refined.id)
    assert.match(readFileSync(join(f.root, 'docs/api.md'), 'utf8'), /Client API/)
    await assert.rejects(followup.apply(run.id), /Изменился источник|Конфликт/)
  } finally { f.close() }
})

test('long diff must be read completely before finish; text replacement requires a unique match', async () => {
  const f = fixture()
  try {
    const content = '# Notes\n' + 'Long API explanation.\n'.repeat(250)
    const agent = assistant(f.root, f.directory, [
      { actions: [{ tool: 'read_file', path: 'README.md' }, { tool: 'replace_text', path: 'README.md', oldText: 'missing', newText: 'x' }, { tool: 'write_file', path: 'docs/long.md', content }, { tool: 'get_diff' }] },
      done,
      { actions: [{ tool: 'get_diff', offset: 4000 }] }, done,
    ])
    const run = await agent.run('Создай подробный документ.', 'local')
    assert.match(String(run.steps[2].result.error), /ровно один/)
    const pages = run.steps.filter(({ tool }) => tool === 'get_diff')
    assert.equal(pages.length, 2); assert.equal(pages[0].result.truncated, true); assert.equal(pages[1].result.truncated, false)
    assert.equal(run.status, 'preview')
  } finally { f.close() }
})

test('a write failure rolls back earlier files while preserving the original permissions', () => {
  const f = fixture()
  try {
    const files = new CodingFiles(f.root)
    chmodSync(join(f.root, 'README.md'), 0o640)
    files.read('README.md'); files.propose('README.md', '# Updated\n'); files.propose('docs/new.md', '# New\n')
    const changes = files.changes()
    // Force the second atomic rename to fail after the first file was written.
    const original = files.disk.bind(files)
    let secondChecks = 0
    files.disk = (path) => {
      const result = original(path)
      if (path === 'docs/new.md' && ++secondChecks === 2) mkdirSync(join(f.root, 'docs/new.md'))
      return result
    }
    assert.throws(() => files.apply(changes))
    assert.match(readFileSync(join(f.root, 'README.md'), 'utf8'), /API pending/)
    assert.equal(statSync(join(f.root, 'README.md')).mode & 0o777, 0o640)
  } finally { f.close() }
})

test('changed source or destination rejects the whole apply without partial writes', async () => {
  for (const path of ['src/api.ts', 'README.md', 'docs/api.md']) {
    const f = fixture()
    try {
      const agent = assistant(f.root, f.directory, [reads, edits, done])
      const run = await agent.run('Обнови документацию API.', 'local')
      writeFileSync(join(f.root, path), 'User changes\n')
      await assert.rejects(agent.apply(run.id), /Изменился источник|Конфликт/)
      assert.equal(readFileSync(join(f.root, path), 'utf8'), 'User changes\n')
      if (path !== 'README.md') assert.match(readFileSync(join(f.root, 'README.md'), 'utf8'), /API pending/)
      assert.equal(agent.get(run.id).status, 'preview')
    } finally { f.close() }
  }
})

test('filesystem boundary blocks traversal, symlinks, secrets and binary files; respects gitignore and new files', () => {
  const f = fixture()
  try {
    const files = new CodingFiles(f.root)
    writeFileSync(join(f.root, '.env'), 'SECRET=1'); writeFileSync(join(f.root, '.gitignore'), 'ignored.ts\n')
    writeFileSync(join(f.root, 'ignored.ts'), 'hidden'); writeFileSync(join(f.root, 'new.ts'), 'new file')
    writeFileSync(join(f.root, 'binary.ts'), Buffer.from([0xff, 0x00]))
    symlinkSync(join(f.root, 'src/api.ts'), join(f.root, 'link.ts'))
    symlinkSync(join(f.root, 'src'), join(f.root, 'linked'))
    for (const path of ['../escape.md', '/tmp/escape.md', '.git/config', '.env', 'src/../../escape.md', 'src\\api.ts', 'link.ts', 'linked/api.ts', 'secrets.json']) {
      assert.throws(() => files.disk(path)); assert.throws(() => files.propose(path, 'bad'))
    }
    assert.throws(() => files.disk('binary.ts'))
    const list = files.list(); assert.ok(list.files.includes('new.ts')); assert.ok(!list.files.includes('ignored.ts')); assert.ok(!list.files.includes('link.ts'))
    files.propose('docs/new.md', 'pending refresh')
    assert.ok(files.list().files.includes('docs/new.md')); assert.equal(files.read('docs/new.md').content, 'pending refresh')
    assert.equal(files.search('pending refresh').total, 1)
    assert.throws(() => files.propose('src/api.ts', 'overwrite'), /прочитайте/)
  } finally { f.close() }
})

test('search pagination reports truncation and exact line locations', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'src/many.ts'), 'refresh\n'.repeat(65))
    const files = new CodingFiles(f.root), first = files.search('refresh'), second = files.search('refresh', '', 50)
    assert.equal(first.matches.length, 50); assert.equal(first.truncated, true); assert.equal(first.total, 68)
    assert.equal(second.matches.length, 18); assert.equal(second.truncated, false)
    assert.equal(first.matches[0].line, 1)
  } finally { f.close() }
})

test('patch preserves hunk lines resembling headers and Unicode paths with spaces', () => {
  const f = fixture()
  try {
    const path = 'docs/пример файла.md'
    writeFileSync(join(f.root, path), '-- old header-like text\n')
    f.git('add', path)
    const files = new CodingFiles(f.root); files.read(path); files.propose(path, '++ new header-like text\n')
    const patch = join(f.directory, 'headers.patch'); writeFileSync(patch, files.changes()[0].diff)
    f.git('apply', '--check', patch)
    f.git('apply', patch)
    assert.equal(readFileSync(join(f.root, path), 'utf8'), '++ new header-like text\n')
  } finally { f.close() }
})

test('tool errors are returned to the planner; unread replacement is refused and limit/abort never writes', async () => {
  const f = fixture()
  try {
    const agent = assistant(f.root, f.directory, [
      { actions: [{ tool: 'replace_text', path: 'README.md', oldText: 'pending', newText: 'changed' }] },
      { done: true, answer: 'Не удалось изменить непрочитанный файл.' },
    ])
    const run = await agent.run('Измени README.', 'local')
    assert.match(String(run.steps[1].result.error), /прочитайте/); assert.equal(run.changes.length, 0)
    await assert.rejects(assistant(f.root, f.directory, [{ notATool: true }], 2).run('Измени файл.', 'local'), /лимит шагов/)
    const abort = new AbortController(); abort.abort()
    await assert.rejects(agent.run('Измени файл.', 'local', abort.signal), /abort/i)
    assert.equal(f.git('status', '--porcelain'), '')
  } finally { f.close() }
})

test('per-project HTTP tasks accept goals, reject foreign origins, preserve previews and apply server-side snapshots', async () => {
  const f = fixture(), app = express()
  const agent = assistant(f.root, f.directory, [reads, edits, done])
  app.use(express.json()); app.use('/api/developer', createDeveloperRouter(new DeveloperAssistant({ root: f.root, dataDirectory: join(f.directory, 'data'), coding: agent })))
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/developer`
  const post = (path: string, body: unknown, origin?: string) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) })
  try {
    assert.equal((await post('/tasks', { goal: 'Update API' }, 'https://foreign.test')).status, 403)
    assert.equal((await post('/tasks', { goal: 'Update API', root: '/tmp' })).status, 400)
    const response = await post('/tasks', { goal: 'Update API', provider: 'local' }); assert.equal(response.status, 200)
    const run = await response.json(); assert.equal(run.projectId, 'current'); assert.equal(run.status, 'preview')
    assert.equal((await fetch(`${base}/tasks/${run.id}`)).status, 200)
    const streamed = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ goal: 'Update API', provider: 'local' }) })
    assert.match(streamed.headers.get('content-type') || '', /text\/event-stream/)
    const events = await streamed.text()
    assert.match(events, /event: step/); assert.match(events, /event: result/); assert.match(events, /"status":"preview"/)
    assert.equal((await post(`/tasks/${run.id}/apply`, { changes: [] })).status, 400)
    const applied = await post(`/tasks/${run.id}/apply`, {}); assert.equal(applied.status, 200)
    assert.equal((await applied.json()).status, 'applied')
    assert.equal((await fetch(`${base}/tasks/${run.id}?projectId=other`)).status, 404)
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); f.close() }
})
