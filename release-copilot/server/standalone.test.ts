import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { modelClient, ModelRequestError } from './model-client'
import { Projects } from './projects'

test('standalone Ollama transport enforces per-claim verification and records actual token usage', async () => {
  const requests: Array<{ model: string; format: { properties: { items?: { required: string[] } } }; messages: unknown[] }> = []
  const request: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body)
    const content = body.format.properties?.items ? { items: { '1': { supported: true, reason: 'Есть цитата.' }, '2': { supported: false, reason: 'Нет доказательства.' } } } : { value: 'analysis' }
    return new Response(JSON.stringify({ message: { content: JSON.stringify(content) }, prompt_eval_count: 100, eval_count: 20 }))
  }
  const client = modelClient('local', undefined, request, { localModel: 'fixture-local', jsonSchema: { type: 'object', properties: { value: { type: 'string' } } } })
  await client.complete([{ role: 'user', content: 'fixture' }], 'rewrite')
  const verified = await client.complete([{ role: 'system', content: 'Проверь. Верни только JSON: array' }, { role: 'user', content: JSON.stringify({ claims: [{ claimId: 1 }, { claimId: 2 }] }) }], 'verify')
  assert.deepEqual(requests[1].format.properties.items!.required, ['1', '2'])
  assert.equal(JSON.parse(verified.content).items[1].supported, false)
  assert.equal(client.stats.calls, 2); assert.equal(client.stats.promptTokens, 200); assert.equal(client.stats.outputTokens, 40)
  assert.equal(requests[0].model, 'fixture-local')
})

test('standalone cloud transport sends only explicit prompts and does not expose provider errors', async () => {
  const original = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fixture-key'
  try {
    const request: typeof fetch = async (url, init) => {
      assert.equal(String(url), 'https://api.deepseek.com/chat/completions')
      assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer fixture-key')
      assert.deepEqual(JSON.parse(String(init!.body)).messages, [{ role: 'user', content: 'explicit fixture' }])
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }))
    }
    const client = modelClient('cloud', undefined, request)
    await client.complete([{ role: 'user', content: 'explicit fixture' }], 'rewrite')
    assert.equal(client.stats.promptTokens, 7)
    const failing = modelClient('cloud', undefined, async () => new Response(JSON.stringify({ error: { message: 'sensitive-provider-response' } }), { status: 500 }))
    await assert.rejects(failing.complete([{ role: 'user', content: 'fixture' }], 'rewrite'), (error: Error) => !error.message.includes('sensitive-provider-response'))
  } finally { if (original === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = original }
})

test('cloud receives the full schema and full input beyond the local context budget', async () => {
  const original = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fixture-key'
  try {
    const schema = { type: 'object', properties: { title: { type: 'string', maxLength: 900 } }, required: ['title'], additionalProperties: false }
    const text = 'full file\n'.repeat(20000) + 'END_OF_FILE'
    const messages = [{ role: 'user' as const, content: text }]
    let sent = 0
    const request: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init!.body)); sent++
      assert.equal(body.messages[0].content, text)
      assert.deepEqual(JSON.parse(body.messages[1].content.split('\n').slice(1).join('\n')), schema)
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"done"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11000, completion_tokens: 5 } }))
    }
    await modelClient('cloud', undefined, request, { jsonSchema: schema }).complete(messages, 'rewrite')
    assert.equal(sent, 1)
    await assert.rejects(modelClient('local', undefined, request).complete(messages, 'rewrite'), ModelRequestError)
    assert.equal(sent, 1)
    const truncated = modelClient('cloud', undefined, async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"title":' }, finish_reason: 'length' }], usage: { prompt_tokens: 17, completion_tokens: 4 } })))
    await assert.rejects(truncated.complete([{ role: 'user', content: 'fixture' }], 'rewrite'), /RELEASE_MAX_TOKENS/)
    assert.equal(truncated.stats.promptTokens, 17); assert.equal(truncated.stats.outputTokens, 4)
  } finally { if (original === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = original }
})

test('standalone project catalog starts empty, preserves selected roots and survives reloading', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-projects-'))
  try {
    const configPath = join(root, 'data/projects.json'), projectRoot = join(root, 'target'); mkdirSync(projectRoot)
    const projects = new Projects({ configPath })
    assert.deepEqual(projects.list(), { defaultProjectId: null, projects: [] })
    const opened = projects.open(projectRoot)
    assert.equal(projects.open(projectRoot).project.id, opened.project.id)
    assert.equal(new Projects({ configPath }).get(opened.project.id).root, realpathSync(projectRoot))
    assert.equal(projects.list().projects.length, 1)
    assert.throws(() => projects.get('invented'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('migration preserves IDs, snapshots and existing data without importing credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-migration-'))
  try {
    const legacy = join(root, 'old'), app = join(root, 'new'), id = '12345678-1234-1234-1234-123456789abc'
    mkdirSync(join(legacy, 'target'), { recursive: true }); mkdirSync(join(legacy, 'data/release-runs', id), { recursive: true }); mkdirSync(join(app, 'scripts'), { recursive: true })
    writeFileSync(join(legacy, 'data/developer-projects.json'), JSON.stringify({ defaultProjectId: 'myfamily', projects: [{ id: 'myfamily', name: 'MyFamily', root: 'target' }] }))
    writeFileSync(join(legacy, 'data/release-runs', id, 'run.json'), JSON.stringify({ id, state: 'ready' }))
    writeFileSync(join(legacy, '.env'), 'DEEPSEEK_API_KEY=fixture-secret\n')
    const script = join(app, 'scripts/import-deepchat-data.mjs')
    writeFileSync(script, readFileSync(fileURLToPath(new URL('../scripts/import-deepchat-data.mjs', import.meta.url))))
    execFileSync(process.execPath, [script, '--from', legacy])
    const config = JSON.parse(readFileSync(join(app, 'data/projects.json'), 'utf8'))
    assert.equal(config.defaultProjectId, 'myfamily'); assert.equal(config.projects[0].root, realpathSync(resolve(legacy, 'target')))
    const run = join(app, 'data/release-runs', id, 'run.json')
    assert.equal(JSON.parse(readFileSync(run, 'utf8')).id, id); assert.equal(existsSync(join(app, '.env')), false)
    writeFileSync(run, '{"state":"newer-local-result"}')
    execFileSync(process.execPath, [script, '--from', legacy])
    assert.equal(JSON.parse(readFileSync(run, 'utf8')).state, 'newer-local-result')
    assert.equal(existsSync(join(legacy, 'data/release-runs', id, 'run.json')), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
