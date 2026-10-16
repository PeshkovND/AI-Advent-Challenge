import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { DeveloperAssistant, DeveloperError } from './developer-assistant'
import type { DeveloperFolderListing, DeveloperProject } from '../src/developer-types'

export const developerAppRoot = fileURLToPath(new URL('../', import.meta.url))
const projectId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
const configSchema = z.object({ defaultProjectId: projectId.default('current'), projects: z.array(z.object({
  id: projectId.refine((id) => id !== 'current', 'ID current зарезервирован'), name: z.string().trim().min(1).max(80), root: z.string().trim().min(1),
}).strict()).max(2000) }).strict()

/** Folder selection registers a canonical local root; questions continue to use stable IDs. */
export class DeveloperProjects {
  private readonly services = new Map<string, DeveloperAssistant>()
  constructor(private readonly options: { appRoot?: string; configPath?: string; create?: (root: string, dataDirectory: string) => DeveloperAssistant } = {}) {}
  private get appRoot() { return this.options.appRoot || developerAppRoot }
  private get configPath() { return this.options.configPath || resolve(this.appRoot, 'data/developer-projects.json') }
  private entries() {
    let config: z.infer<typeof configSchema> = { defaultProjectId: 'current', projects: [] }
    try { config = configSchema.parse(JSON.parse(readFileSync(this.configPath, 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DeveloperError('Некорректный локальный файл developer-projects.json.', 503) }
    const entries = [{ id: 'current', name: 'DeepChat', root: this.appRoot }, ...config.projects]
    if (new Set(entries.map(({ id }) => id)).size !== entries.length || !entries.some(({ id }) => id === config.defaultProjectId)) throw new DeveloperError('Повторный или неизвестный ID проекта в конфигурации.', 503)
    return { defaultProjectId: config.defaultProjectId, entries }
  }
  list(): { defaultProjectId: string; projects: DeveloperProject[] } {
    const { defaultProjectId, entries } = this.entries()
    return { defaultProjectId, projects: entries.map(({ id, name, root }) => ({ id, name, root: resolve(this.appRoot, root) })) }
  }
  private directory(path: string) {
    try {
      const expanded = path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path
      const root = realpathSync(resolve(this.appRoot, expanded))
      if (!statSync(root).isDirectory()) throw new DeveloperError('Выберите папку, а не файл.')
      return root
    } catch (error) {
      if (error instanceof DeveloperError) throw error
      const code = (error as NodeJS.ErrnoException).code
      throw new DeveloperError(code === 'EACCES' || code === 'EPERM' ? 'Нет доступа к этой папке.' : 'Папка не найдена.', code === 'EACCES' || code === 'EPERM' ? 403 : 404)
    }
  }
  folders(path = homedir()): DeveloperFolderListing {
    const root = this.directory(path)
    try {
      const directories = readdirSync(root, { withFileTypes: true }).filter((entry) => {
        if (entry.name.startsWith('.')) return false
        if (entry.isDirectory()) return true
        try { return entry.isSymbolicLink() && statSync(resolve(root, entry.name)).isDirectory() } catch { return false }
      }).map(({ name }) => name).sort((a, b) => a.localeCompare(b))
      return { path: root, parent: dirname(root) === root ? null : dirname(root), home: homedir(), directories: directories.slice(0, 2000), truncated: directories.length > 2000 }
    } catch { throw new DeveloperError('Не удалось прочитать папку. Проверьте права доступа.', 403) }
  }
  open(path: string): { project: DeveloperProject; projects: DeveloperProject[]; defaultProjectId: string } {
    const root = this.directory(path)
    // Check readability before persisting a recent project. No files in the selected root are changed.
    this.folders(root)
    const config = this.entries()
    let entry = config.entries.find((item) => {
      try { return realpathSync(resolve(this.appRoot, item.root)) === root } catch { return false }
    })
    if (!entry) {
      if (config.entries.length > 2000) throw new DeveloperError('Достигнут лимит сохранённых проектов.')
      entry = { id: `p-${createHash('sha256').update(root).digest('hex').slice(0, 24)}`, name: (basename(root) || root).slice(0, 80), root }
      config.entries.push(entry)
    }
    const next = configSchema.parse({ defaultProjectId: entry.id, projects: config.entries.filter(({ id }) => id !== 'current') })
    mkdirSync(dirname(this.configPath), { recursive: true })
    const temporary = `${this.configPath}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, this.configPath)
    return { ...this.list(), project: { id: entry.id, name: entry.name, root } }
  }
  get(id = 'current') {
    const entry = this.entries().entries.find((entry) => entry.id === id)
    if (!entry) throw new DeveloperError('Неизвестный проект. Выберите ID из /api/developer/projects.', 404)
    let root: string
    try { root = realpathSync(resolve(this.appRoot, entry.root)); if (!statSync(root).isDirectory()) throw new Error() }
    catch { throw new DeveloperError(`Каталог проекта ${entry.name} недоступен. Проверьте локальную конфигурацию.`, 503) }
    const key = `${id}:${root}`
    let service = this.services.get(key)
    if (!service) {
      const directory = root === realpathSync(this.appRoot) ? resolve(this.appRoot, 'data')
        : resolve(this.appRoot, 'data/developer-projects', createHash('sha256').update(root).digest('hex').slice(0, 16))
      service = this.options.create?.(root, directory) || new DeveloperAssistant({ root, dataDirectory: directory })
      this.services.set(key, service)
    }
    return service
  }
}

export function parseDeveloperArguments(args: string[]) {
  let project = 'current', local = false, cloud = false, index = false, cases: string | undefined
  let command = ''
  for (let position = 0; position < args.length; position++) {
    const argument = args[position]
    if (argument === '--project' || argument === '--cases') {
      const value = args[++position]
      if (!value || value.startsWith('--')) throw new DeveloperError(`После ${argument} нужно значение.`)
      if (argument === '--project') { if (!projectId.safeParse(value).success) throw new DeveloperError('Укажите зарегистрированный ID проекта.'); project = value }
      else cases = value
    } else if (argument === '--local') local = true
    else if (argument === '--cloud') cloud = true
    else if (argument === '--index') index = true
    else if (argument.startsWith('--')) throw new DeveloperError(`Неизвестный параметр ${argument}.`)
    else { command = args.slice(position).join(' '); break }
  }
  if (local && cloud) throw new DeveloperError('Выберите --local или --cloud.')
  return { project, local, cloud, index, cases, command }
}
