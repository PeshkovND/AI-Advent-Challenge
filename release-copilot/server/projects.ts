import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { z } from 'zod'
import type { FolderListing, Project } from '../src/project-types'

export class ProjectError extends Error { constructor(message: string, readonly status = 400) { super(message) } }
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
const schema = z.object({ defaultProjectId: id.nullable(), projects: z.array(z.object({ id, name: z.string().trim().min(1).max(80), root: z.string().min(1) }).strict()).max(2000) }).strict()

export class Projects {
  constructor(private readonly options: { configPath?: string } = {}) {}
  private get path() { return this.options.configPath || resolve(process.cwd(), 'data/projects.json') }
  list(): { defaultProjectId: string | null; projects: Project[] } {
    try {
      const config = schema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      if (new Set(config.projects.map((project) => project.id)).size !== config.projects.length || config.defaultProjectId && !config.projects.some((project) => project.id === config.defaultProjectId)) throw new Error()
      return config
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { defaultProjectId: null, projects: [] }
      throw new ProjectError('Не удалось прочитать список проектов.', 503)
    }
  }
  private directory(path: string) {
    try {
      const expanded = path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path
      const root = realpathSync(resolve(expanded))
      if (!statSync(root).isDirectory()) throw new Error()
      return root
    } catch { throw new ProjectError('Папка не найдена или недоступна.', 404) }
  }
  folders(path = homedir()): FolderListing {
    const root = this.directory(path)
    try {
      const directories = readdirSync(root, { withFileTypes: true }).filter((entry) => {
        if (entry.name.startsWith('.')) return false
        if (entry.isDirectory()) return true
        try { return entry.isSymbolicLink() && statSync(resolve(root, entry.name)).isDirectory() } catch { return false }
      }).map((entry) => entry.name).sort((a, b) => a.localeCompare(b))
      return { path: root, home: homedir(), parent: dirname(root) === root ? null : dirname(root), directories: directories.slice(0, 2000), truncated: directories.length > 2000 }
    } catch { throw new ProjectError('Нет доступа к содержимому папки.', 403) }
  }
  get(id: string) {
    const project = this.list().projects.find((project) => project.id === id)
    if (!project) throw new ProjectError('Проект не найден. Откройте его папку.', 404)
    return { ...project, root: this.directory(project.root) }
  }
  open(path: string) {
    const root = this.directory(path); this.folders(root)
    const config = this.list()
    let project = config.projects.find((project) => project.root === root)
    if (!project) {
      if (config.projects.length >= 2000) throw new ProjectError('Достигнут лимит сохранённых проектов.')
      project = { id: `p-${createHash('sha256').update(root).digest('hex').slice(0, 24)}`, name: (basename(root) || root).slice(0, 80), root }
      config.projects.push(project)
    }
    config.defaultProjectId = project.id
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeFileSync(`${this.path}.tmp`, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); renameSync(`${this.path}.tmp`, this.path)
    return { ...config, project }
  }
}
