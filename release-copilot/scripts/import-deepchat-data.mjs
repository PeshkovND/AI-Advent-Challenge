import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const index = process.argv.indexOf('--from'), source = process.argv[index + 1]
if (index < 0 || !source || source.startsWith('--')) throw new Error('Использование: npm run import:deepchat -- --from /путь/к/DeepChat')
const legacyRoot = realpathSync(resolve(source)), dataRoot = resolve(appRoot, 'data')
const sourceConfig = resolve(legacyRoot, 'data/developer-projects.json'), targetConfig = resolve(dataRoot, 'projects.json')
const config = existsSync(sourceConfig) ? JSON.parse(readFileSync(sourceConfig, 'utf8')) : { projects: [], defaultProjectId: null }
const next = existsSync(targetConfig) ? JSON.parse(readFileSync(targetConfig, 'utf8')) : { projects: [], defaultProjectId: null }
const entries = [...config.projects]
if (config.defaultProjectId === 'current') entries.push({ id: 'current', name: 'DeepChat', root: legacyRoot })
for (const project of entries) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(project.id) || typeof project.name !== 'string' || typeof project.root !== 'string') throw new Error('Некорректный список исходных проектов.')
  const imported = { ...project, root: realpathSync(resolve(legacyRoot, project.root)) }
  const existing = next.projects.find((item) => item.id === project.id)
  if (existing && existing.root !== imported.root) throw new Error('ID проекта занят другим каталогом. Импорт остановлен без перезаписи.')
  if (!existing) next.projects.push(imported)
}
if (!next.defaultProjectId) next.defaultProjectId = next.projects.some((item) => item.id === config.defaultProjectId) ? config.defaultProjectId : next.projects[0]?.id || null
mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
writeFileSync(`${targetConfig}.tmp`, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); renameSync(`${targetConfig}.tmp`, targetConfig)
let copied = 0
const runs = resolve(legacyRoot, 'data/release-runs'), targetRuns = resolve(dataRoot, 'release-runs')
if (existsSync(runs)) for (const entry of readdirSync(runs, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry.name) || existsSync(resolve(targetRuns, entry.name))) continue
  cpSync(resolve(runs, entry.name), resolve(targetRuns, entry.name), { recursive: true, force: false, errorOnExist: true }); copied++
}
console.log(`Импортировано запусков: ${copied}. Проектов в отдельном приложении: ${next.projects.length}. Исходные данные сохранены.`)
