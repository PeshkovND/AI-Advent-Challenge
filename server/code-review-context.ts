import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chunkDocuments, documentFromText, type DocumentChunk } from './rag-indexer'
import { publicProjectPath } from './project-workspace'

const execute = promisify(execFile)
export const reviewLimits = { files: 30, patchBytes: 10000, contentBytes: 4000, blobBytes: 128000, corpusBytes: 4_000_000, documents: 400 }
export function bytePrefix(text: string, limit: number) {
  let result = '', size = 0
  for (const character of text) {
    size += Buffer.byteLength(character)
    if (size > limit) break
    result += character
  }
  return result
}
export function reviewPath(path: string) {
  const publicPath = publicProjectPath(path) || /^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(path) && publicProjectPath(path.slice(1))
  return publicPath && !/(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path)
    && /\.(?:[cm]?[jt]sx?|md|markdown|txt|css|html|json|ya?ml|sql|graphql|prisma|py|swift|go|rs|sh|pbxproj|xcconfig|plist|entitlements|xcscheme|xcworkspacedata)$/i.test(path)
}
export const isReviewDocumentation = (path: string) => /(?:^|\/)(?:readme[^/]*|docs\/.*|api\/.*|schemas?\/.*)$/i.test(path)

export class ReviewRepository {
  constructor(readonly root: string, readonly signal?: AbortSignal) {}
  async git(args: string[], maxBuffer = 8 * 1024 * 1024) {
    const { stdout } = await execute('git', ['--no-optional-locks', '-C', this.root, ...args], {
      encoding: 'utf8', maxBuffer, timeout: 15000, signal: this.signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C' },
    })
    return stdout
  }
  async commit(ref: string) {
    // --end-of-options prevents a user-supplied ref from becoming a Git option.
    return (await this.git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim()
  }
  async tree(commit: string) {
    return (await this.git(['ls-tree', '-rlz', commit])).split('\0').filter(Boolean).map((entry) => {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(entry)
      if (!match) throw new Error('Некорректный результат git ls-tree.')
      return { mode: match[1], type: match[2], oid: match[3], size: Number(match[4]), path: match[5] }
    })
  }
  async text(entry: Awaited<ReturnType<ReviewRepository['tree']>>[number]) {
    if (!/^100(?:644|755)$/.test(entry.mode) || entry.type !== 'blob' || entry.size > reviewLimits.blobBytes) return null
    const text = await this.git(['cat-file', 'blob', entry.oid], reviewLimits.blobBytes + 1024)
    return text.includes('\0') || text.includes('\uFFFD') ? null : text
  }
}

export type ReviewFile = {
  path: string; status: string; patch: string; patchTruncated: boolean
  content: string; contentTruncated: boolean
}
export type ReviewContext = {
  base: string; head: string; mergeBase: string; files: ReviewFile[]
  skipped: Array<{ path: string; reason: string }>; totalFiles: number
  corpus: DocumentChunk[]; corpusDocuments: number; corpusTruncated: boolean
}

/** Read immutable Git blobs. Never check out or execute code from the PR. */
export async function collectReviewContext(root: string, baseRef: string, headRef: string, signal?: AbortSignal): Promise<ReviewContext> {
  const repository = new ReviewRepository(root, signal)
  const base = await repository.commit(baseRef), head = await repository.commit(headRef)
  const mergeBase = (await repository.git(['merge-base', base, head])).trim()
  const changes = (await repository.git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', mergeBase, head, '--'])).split('\0')
  const baseTree = await repository.tree(mergeBase), headTree = await repository.tree(head)
  const before = new Map(baseTree.map((entry) => [entry.path, entry])), after = new Map(headTree.map((entry) => [entry.path, entry]))
  const context: ReviewContext = { base, head, mergeBase, files: [], skipped: [], totalFiles: 0, corpus: [], corpusDocuments: 0, corpusTruncated: false }
  for (let index = 0; index + 1 < changes.length; index += 2) {
    const status = changes[index], path = changes[index + 1]
    context.totalFiles++
    const skip = (reason: string) => context.skipped.push({ path, reason })
    if (!reviewPath(path)) { skip('Закрытый путь, lock-файл или неподдерживаемый формат'); continue }
    if (context.files.length >= reviewLimits.files) { skip('Лимит файлов за один запуск'); continue }
    const entry = (status === 'D' ? before : after).get(path)
    if (!entry) { skip('Git-объект недоступен'); continue }
    const text = await repository.text(entry)
    if (text === null) { skip('Бинарный, слишком большой файл, симлинк или submodule'); continue }
    const patch = await repository.git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3', mergeBase, head, '--', path])
    const bounded = bytePrefix(patch, reviewLimits.patchBytes)
    // Keep complete lines so locations cannot reference a partially transmitted line.
    const boundedPatch = bounded.length < patch.length ? bounded.slice(0, bounded.lastIndexOf('\n') + 1) : bounded
    context.files.push({ path, status, patch: boundedPatch, patchTruncated: boundedPatch !== patch,
      content: bytePrefix(text, reviewLimits.contentBytes), contentTruncated: Buffer.byteLength(text) > reviewLimits.contentBytes })
  }
  // The trusted baseline supplies docs and code, including unchanged dependencies.
  const candidates = baseTree.filter((entry) => reviewPath(entry.path)).sort((a, b) => Number(isReviewDocumentation(b.path)) - Number(isReviewDocumentation(a.path)) || a.path.localeCompare(b.path))
  let bytes = 0
  const documents = []
  for (const entry of candidates) {
    signal?.throwIfAborted()
    if (documents.length >= reviewLimits.documents || bytes + entry.size > reviewLimits.corpusBytes) { context.corpusTruncated = true; continue }
    const text = await repository.text(entry)
    if (text === null) { context.corpusTruncated = true; continue }
    bytes += entry.size
    documents.push(documentFromText(entry.path, text))
  }
  context.corpusDocuments = documents.length
  context.corpus = chunkDocuments(documents, 'structured', { chunkSize: 140, overlap: 25 })
  return context
}

const terms = (text: string) => text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) || []
export type ReviewSource = { id: string; path: string; kind: 'documentation' | 'code'; text: string; score: number }

/** TF-IDF retrieval with separate docs/code slots; no model server needed on CI. */
export function retrieveReviewSources(file: ReviewFile, corpus: DocumentChunk[]): ReviewSource[] {
  const query = new Set(terms(file.path + '\n' + file.patch))
  const frequency = new Map<string, number>()
  const tokens = corpus.map((chunk) => new Set(terms(chunk.source + '\n' + chunk.text)))
  for (const words of tokens) for (const word of words) if (query.has(word)) frequency.set(word, (frequency.get(word) || 0) + 1)
  const ranked = corpus.map((chunk, index) => ({ id: chunk.chunk_id, path: chunk.source,
    kind: isReviewDocumentation(chunk.source) ? 'documentation' as const : 'code' as const,
    text: bytePrefix(chunk.text, 1800),
    score: [...query].reduce((score, word) => score + (tokens[index].has(word) ? Math.log(1 + corpus.length / (frequency.get(word) || 1)) : 0), 0) / Math.sqrt(tokens[index].size || 1),
  })).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return [...ranked.filter(({ kind }) => kind === 'documentation').slice(0, 2), ...ranked.filter(({ kind }) => kind === 'code').slice(0, 2)]
}
