import 'dotenv/config'
import './network-config'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { CodingAssistant } from './coding-assistant'
import { CodingFiles } from './coding-files'
import { DeveloperProjects, parseDeveloperArguments } from './developer-projects'
import type { CodingRun } from '../src/coding-types'

// Copy the selected project's visible text files. The live model writes only into this isolated copy.
const args = parseDeveloperArguments(process.argv.slice(2))
const selected = new DeveloperProjects().get(args.project)
const source = new CodingFiles(selected.root)
const directory = resolve('data/day-34-check')
mkdirSync(directory, { recursive: true })
const runDirectory = mkdtempSync(resolve(directory, 'run-')), root = resolve(runDirectory, 'project')
mkdirSync(root)
for (let offset = 0; ;) {
  const page = source.list('', offset)
  for (const path of page.files) {
    let content: string | null
    try { content = source.disk(path) } catch { continue }
    if (content === null) continue
    const target = resolve(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content)
  }
  if (!page.truncated) break
  offset = page.nextOffset!
}
const git = (...values: string[]) => execFileSync('git', ['-C', root, ...values], { encoding: 'utf8' })
git('init', '-b', 'day-34-check'); git('add', '.'); git('-c', 'user.name=Check', '-c', 'user.email=check@example.test', 'commit', '-m', 'Source snapshot')
const assistant = new CodingAssistant({ root, directory: resolve(runDirectory, 'runs') })
const provider = args.cloud ? 'cloud' : 'local'
const summary = (run: CodingRun) => ({ ...run, root: '<isolated-project-copy>', steps: run.steps.map((step) => ({ tool: step.tool,
  arguments: Object.fromEntries(Object.entries(step.arguments).map(([key, value]) => [key, ['content', 'oldText', 'newText'].includes(key) ? `<${String(value).length} chars>` : value])),
  result: step.tool === 'read_file' ? { path: step.result.path, bytes: Buffer.byteLength(String(step.result.content || '')), ...(step.result.error ? { error: step.result.error } : {}) } : step.result,
})) })
const report: Record<string, unknown> = { provider, sourceProject: args.project, createdAt: new Date().toISOString(), isolatedCopy: true }
const reportPath = resolve(directory, `latest-${args.project}-${provider}.json`)
function save() { writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n') }
const log = (step: { tool: string; arguments: Record<string, unknown>; result: Record<string, unknown> }) => console.log(step.tool, JSON.stringify(step.arguments).slice(0, 130), step.result.error || '', step.result.excerpt || '', String(step.result.note || '').slice(0, 300))
try {
  console.log('Scenario 1: API usage inventory')
  const inventory = await assistant.run('Найди определение AuthService и все места его использования в Swift-коде. Объясни роль сервиса в авторизации со ссылками на файлы и строки. Только анализ, без изменения файлов.', provider, undefined, undefined, log)
  report.inventory = summary(inventory); save()
  assert.ok(inventory.readFiles.length >= 3, 'Inventory must read at least 3 files')
  assert.equal(inventory.changes.length, 0)
  assert.ok(inventory.steps.some((step) => step.tool === 'search_files'))
  assert.match(inventory.answer, /AuthService/)
  assert.equal(git('status', '--porcelain'), '')
  console.log('Scenario 2: documentation from implementation')
  const goal = 'Исследуй реализацию авторизации и её HTTP-запросы. Выполни три результата: 1) дополни уже существующий справочник клиентского API отдельным разделом о фактическом поведении refreshToken при отсутствии credentials и ошибке обновления; 2) создай краткое отдельное руководство по потоку авторизации; 3) добавь ссылку на руководство в список документации в README. Подтверждай описание путями исходников. Если все три результата уже есть и соответствуют коду, оставь файлы без изменений. Swift-код сохраняй без изменений.'
  const documentation = await assistant.run(goal, provider, undefined, undefined, log)
  report.documentation = summary(documentation); save()
  assert.ok(documentation.readFiles.length >= 3, 'Documentation must read at least 3 files')
  assert.ok(documentation.changes.length >= 3, 'Documentation must update the API reference, create a guide and update README')
  assert.ok(documentation.changes.some((change) => change.path === 'project/docs/client-api.md'), 'Existing API reference must be updated')
  assert.ok(documentation.changes.some((change) => change.path === 'README.md'), 'README must link to the new guide')
  assert.ok(documentation.changes.some((change) => change.before === null), 'Must create a new file')
  assert.ok(documentation.changes.some((change) => change.before !== null), 'Must update an existing file')
  assert.ok(documentation.changes.every((change) => /\.md$/i.test(change.path)))
  assert.equal(git('status', '--porcelain'), '', 'Preview must not modify project files')
  const patch = resolve(runDirectory, 'myfamily.patch')
  writeFileSync(patch, documentation.changes.map(({ diff }) => diff).join('\n'))
  git('apply', '--check', patch)
  const applied = await assistant.apply(documentation.id)
  assert.equal(applied.status, 'applied')
  for (const change of documentation.changes) assert.equal(readFileSync(resolve(root, change.path), 'utf8'), change.after)
  report.apply = { status: applied.status, files: applied.changes.map(({ path }) => path), gitApplyCheck: true }
  save()
  console.log('Scenario 3: same goal after apply')
  const repeated = await assistant.run(goal, provider, undefined, undefined, log)
  report.repeated = summary(repeated); save()
  assert.equal(repeated.changes.length, 0, 'Repeated goal must recognize the applied documentation')
  report.passed = true; save()
  console.log(`PASS. Report: ${reportPath}\nPatch: ${patch}\nProject: ${root}`)
} catch (error) {
  report.passed = false; report.error = error instanceof Error ? error.message : String(error); save()
  console.error(report.error, `\nReport: ${reportPath}`); process.exitCode = 1
}
