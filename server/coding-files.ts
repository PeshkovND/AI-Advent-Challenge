import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FileChange } from '../src/coding-types'
import { publicProjectPath } from './project-workspace'

const maxFileBytes = 64 * 1024
const textExtension = /(?:\.(?:swift|ts|tsx|js|jsx|mjs|cjs|json|md|txt|yaml|yml|toml|xml|html|css|scss|sql|graphql|prisma|py|sh|xcconfig|pbxproj|plist)|(?:^|\/)(?:Makefile|Dockerfile|LICENSE))$/i
export class CodingError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

/** All tool paths are relative to one canonical project. Never follow symlinks. */
export class CodingFiles {
  readonly root: string
  readonly reads = new Map<string, string>()
  readonly edits = new Map<string, { before: string | null; after: string }>()
  constructor(root: string) { this.root = realpathSync(root) }

  path(path: string) {
    if (!path || path.length > 1024 || isAbsolute(path) || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)
      || path.split('/').some((part) => !part || part === '.' || part === '..') || !publicProjectPath(path) || !textExtension.test(path)) {
      throw new CodingError('Недопустимый путь: нужен обычный текстовый файл внутри проекта.')
    }
    let current = this.root
    for (const [index, part] of path.split('/').entries()) {
      current = join(current, part)
      try {
        const stat = lstatSync(current)
        if (stat.isSymbolicLink() || (index < path.split('/').length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new CodingError('Symlink и специальные файлы недоступны.')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return resolve(this.root, path)
  }

  disk(path: string): string | null {
    const target = this.path(path)
    let descriptor: number
    try { descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    try {
      const stat = fstatSync(descriptor)
      if (!stat.isFile() || stat.size > maxFileBytes) throw new CodingError('Лимит текстового файла — 64 КиБ.')
      const bytes = readFileSync(descriptor)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (text.includes('\0')) throw new CodingError('Бинарный файл недоступен.')
      return text
    } finally { closeSync(descriptor) }
  }

  list(prefix = '', offset = 0) {
    if (prefix && (prefix.startsWith('/') || prefix.includes('..') || prefix.includes('\\') || !publicProjectPath(prefix))) throw new CodingError('Недопустимый префикс.')
    let candidates: string[]
    try {
      // Includes new, non-ignored files; no shell, hooks or external diff drivers.
      candidates = execFileSync('git', ['--no-optional-locks', '-C', this.root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 }).split('\0')
    } catch (error) {
      if (!(error as { stderr?: string }).stderr?.includes('not a git repository') && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CodingError('Не удалось получить список Git-файлов.')
      candidates = []
      let visited = 0
      const walk = (directory: string, relative = '') => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (++visited > 20000) throw new CodingError('Слишком много файлов; выберите меньший корень проекта.')
          const path = relative ? `${relative}/${entry.name}` : entry.name
          if (!publicProjectPath(path) || entry.isSymbolicLink()) continue
          if (entry.isDirectory()) walk(join(directory, entry.name), path)
          else if (entry.isFile()) candidates.push(path)
        }
      }
      walk(this.root)
    }
    const files = [...new Set([...candidates, ...this.edits.keys()])].filter((path) => {
      if (!path.startsWith(prefix)) return false
      try { const target = this.path(path); return this.edits.has(path) || existsSync(target) && lstatSync(target).size <= maxFileBytes } catch { return false }
    }).sort()
    const page: string[] = []
    let bytes = 0
    for (const path of files.slice(offset, offset + 100)) {
      if (bytes + Buffer.byteLength(path) > 12000) break
      page.push(path); bytes += Buffer.byteLength(path)
    }
    const nextOffset = offset + page.length
    return { files: page, total: files.length, truncated: nextOffset < files.length, nextOffset: nextOffset < files.length ? nextOffset : null }
  }

  read(path: string) {
    const text = this.disk(path)
    if (text === null) {
      const pending = this.edits.get(path)
      if (pending?.before === null) return { path, content: pending.after }
      throw new CodingError('Файл не найден.')
    }
    if (this.reads.has(path) && this.reads.get(path) !== text) throw new CodingError('Файл изменился во время задачи; запустите её заново.', 409)
    this.reads.set(path, text)
    const content = this.edits.get(path)?.after ?? text
    return { path, content }
  }

  search(query: string, prefix = '', offset = 0) {
    if (!query || query.length > 200) throw new CodingError('Поисковая строка: 1–200 символов.')
    const files: string[] = []
    for (let page = 0; ;) {
      const result = this.list(prefix, page); files.push(...result.files)
      if (!result.truncated) break
      page = result.nextOffset!
    }
    const matches: Array<{ path: string; line: number; text: string }> = []
    let scannedBytes = 0, scannedFiles = 0, limited = false
    for (const path of files) {
      let content: string | null
      try { content = this.edits.get(path)?.after ?? this.disk(path) } catch { continue }
      if (content === null) continue
      scannedBytes += Buffer.byteLength(content)
      if (scannedBytes > 8 * 1024 * 1024) { limited = true; break }
      scannedFiles++
      content.split('\n').forEach((text, index) => { if (text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) matches.push({ path, line: index + 1, text: text.slice(0, 400) }) })
    }
    const page: typeof matches = []
    let bytes = 0
    for (const match of matches.slice(offset, offset + 50)) {
      const size = Buffer.byteLength(JSON.stringify(match))
      if (bytes + size > 12000) break
      page.push(match); bytes += size
    }
    const nextOffset = offset + page.length
    return { query, matches: page, total: matches.length, scannedFiles, truncated: limited || nextOffset < matches.length, scanLimited: limited, nextOffset: nextOffset < matches.length ? nextOffset : null }
  }

  propose(path: string, content: string) {
    if (Buffer.byteLength(content) > maxFileBytes || content.includes('\0') || Buffer.from(content).toString('utf8') !== content) throw new CodingError('Нужен корректный UTF-8 текст до 64 КиБ.')
    const before = this.disk(path)
    if (before !== null && (!this.reads.has(path) || this.reads.get(path) !== before)) throw new CodingError('Перед изменением прочитайте текущий файл целиком.')
    if (!this.edits.has(path) && this.edits.size >= 12) throw new CodingError('Не более 12 изменённых файлов за задачу.')
    const previous = this.edits.get(path)
    if (before === content) this.edits.delete(path)
    else this.edits.set(path, { before, after: content })
    if ([...this.edits.values()].reduce((n, edit) => n + Buffer.byteLength(edit.after), 0) > 256 * 1024) {
      if (previous) this.edits.set(path, previous); else this.edits.delete(path)
      throw new CodingError('Общий размер изменений превышает 256 КиБ.')
    }
    return { path, staged: before !== content, operation: before === null ? 'create' : 'modify', bytes: Buffer.byteLength(content), savedToProject: false }
  }

  changes(): FileChange[] {
    return [...this.edits].map(([path, edit]) => ({ path, ...edit, diff: fileDiff(path, edit.before, edit.after) }))
  }

  /** Validate every preimage before the first write; restore earlier files on failure. */
  apply(changes: FileChange[], signal?: AbortSignal) {
    signal?.throwIfAborted()
    for (const [path, content] of this.reads) if (this.disk(path) !== content) throw new CodingError(`Изменился источник ${path}. Повторите задачу.`, 409)
    for (const change of changes) if (this.disk(change.path) !== change.before) throw new CodingError(`Конфликт в ${change.path}: файл изменился после подготовки diff.`, 409)
    const saved: FileChange[] = []
    try {
      for (const change of changes) {
        signal?.throwIfAborted()
        // Recheck immediately before replace as well as before the whole batch.
        if (this.disk(change.path) !== change.before) throw new CodingError(`Конфликт в ${change.path}.`, 409)
        this.replace(change.path, change.after)
        saved.push(change)
      }
    } catch (error) {
      const failures: string[] = []
      for (const change of saved.reverse()) {
        try {
          if (this.disk(change.path) !== change.after) { failures.push(change.path); continue }
          if (change.before === null) rmSync(this.path(change.path))
          else this.replace(change.path, change.before)
        } catch { failures.push(change.path) }
      }
      if (failures.length) throw new CodingError(`Не удалось откатить: ${failures.join(', ')}. Проверьте файлы вручную.`, 500)
      throw error
    }
  }

  private replace(path: string, text: string) {
    const target = this.path(path)
    mkdirSync(dirname(target), { recursive: true })
    this.path(path)
    const temporary = join(dirname(target), `.coding-${randomUUID()}.tmp`)
    try {
      const mode = existsSync(target) ? lstatSync(target).mode & 0o777 : 0o644
      writeFileSync(temporary, text, { flag: 'wx', mode })
      renameSync(temporary, target)
    } finally { rmSync(temporary, { force: true }) }
  }
}

export function fileDiff(path: string, before: string | null, after: string) {
  const directory = mkdtempSync(join(tmpdir(), 'coding-diff-'))
  const left = join(directory, 'before'), right = join(directory, 'after')
  try {
    if (before !== null) writeFileSync(left, before)
    writeFileSync(right, after)
    let diff: string
    try { diff = execFileSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--text', '--', before === null ? '/dev/null' : left, right], { encoding: 'utf8', maxBuffer: 1024 * 1024 }) }
    catch (error) { if ((error as { status: number }).status !== 1) throw error; diff = String((error as { stdout: string }).stdout) }
    let inHunk = false
    return diff.split('\n').map((line) => {
      if (line.startsWith('@@')) inHunk = true
      if (inHunk) return line
      return line.startsWith('diff --git ') ? `diff --git a/${path} b/${path}`
        : line.startsWith('--- ') ? before === null ? '--- /dev/null' : `--- a/${path}`
        : line.startsWith('+++ ') ? `+++ b/${path}` : line
    }).join('\n')
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
