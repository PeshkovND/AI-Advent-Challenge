import { posix } from 'node:path'
import { GitRepository, isAnalyzablePath, type GitContext } from './git-context'
import { releaseEvidence } from './release-analysis'
import type { ReleaseEvidence, ReleaseRelation } from '../src/release-types'

type Source = { path: string; text: string }
export type ImpactContext = {
  files: string[]; scannedFiles: number; relations: ReleaseRelation[]; evidence: ReleaseEvidence[]
  documents: Array<{ path: string; commit: string; side: 'LEFT' | 'RIGHT'; lines: Array<{ id: string; line: number; text: string; changed: boolean }> }>
}

// Candidate relations, not compiler name resolution. Ignore comments and string
// literals so documentation and UI copy do not masquerade as executable references.
const codeOnly = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, (token) => token.replace(/[^\n]/g, ' '))
const identifiers = (text: string) => new Set(codeOnly(text).match(/[A-Za-z_$][\w$]*/g) || [])
function declarations(text: string) {
  const code = codeOnly(text), names = new Set<string>()
  for (const pattern of [
    /\b(?:class|struct|enum|protocol|interface|typealias|type|extension|func|function|def)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n{]+)?\s*(?:\{|=\s*(?:async\s*)?(?:\([^\n]*?\)|[\w$]+)\s*=>)/g,
  ]) for (const match of code.matchAll(pattern)) if (match[1].length > 2 && !['init', 'get', 'set', 'body', 'main', 'self'].includes(match[1])) names.add(match[1])
  return names
}
const isCode = (path: string) => isAnalyzablePath(path) && /\.(?:[cm]?[jt]sx?|swift|py|go|rs)$/i.test(path)

export function candidateRelations(sources: Source[]): Array<Omit<ReleaseRelation, 'versions'>> {
  const definitions = new Map<string, Set<string>>()
  const names = new Map(sources.map((source) => [source.path, identifiers(source.text)]))
  for (const source of sources) for (const name of declarations(source.text)) {
    if (!definitions.has(name)) definitions.set(name, new Set())
    definitions.get(name)!.add(source.path)
  }
  const edges = new Map<string, { from: string; to: string; symbols: Set<string> }>()
  const add = (from: string, to: string, symbol: string) => {
    if (from === to) return
    const key = JSON.stringify([from, to])
    if (!edges.has(key)) edges.set(key, { from, to, symbols: new Set() })
    edges.get(key)!.symbols.add(symbol)
  }
  for (const source of sources) {
    for (const name of names.get(source.path)!) {
      const providers = definitions.get(name)
      // A name declared in several files is ambiguous; do not guess its owner.
      if (providers?.size === 1) add(source.path, [...providers][0], name)
    }
    const imports = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)['"](\.[^'"]+)['"]/g
    const code = codeOnly(source.text)
    for (const match of source.text.matchAll(imports)) {
      if (code[match.index] !== source.text[match.index]) continue
      const target = posix.normalize(posix.join(posix.dirname(source.path), match[1]))
      const candidates = [target, ...['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'].map((suffix) => target + suffix)]
      const resolved = sources.find(({ path }) => candidates.includes(path))
      if (resolved) add(source.path, resolved.path, `import ${match[1]}`)
    }
  }
  return [...edges.values()].map(({ symbols, ...edge }) => ({ ...edge, symbols: [...symbols].sort() })).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
}

/** Search both frozen trees for direct consumers/providers of changed code.
 * Only allowlisted Git blobs are read; the working tree is never consulted. */
export async function collectImpactContext(root: string, context: GitContext, signal?: AbortSignal): Promise<ImpactContext> {
  const git = new GitRepository(root, signal), changed = new Set(context.files.map(({ path }) => path))
  const snapshots = new Map<'base' | 'head', Source[]>()
  for (const [version, commit] of [['base', context.base], ['head', context.head]] as const) {
    const sources: Source[] = []
    for (const entry of await git.tree(commit)) {
      signal?.throwIfAborted()
      if (!isCode(entry.path)) continue
      const text = await git.text(entry)
      if (text !== null) sources.push({ path: entry.path, text })
    }
    snapshots.set(version, sources)
  }
  const relations = new Map<string, ReleaseRelation>()
  for (const [version, sources] of snapshots) for (const relation of candidateRelations(sources)) {
    if (!changed.has(relation.from) && !changed.has(relation.to)) continue
    const key = JSON.stringify([relation.from, relation.to]), previous = relations.get(key)
    relations.set(key, { ...relation, symbols: [...new Set([...(previous?.symbols || []), ...relation.symbols])].sort(), versions: [...(previous?.versions || []), version] })
  }
  const files = [...new Set([...relations.values()].flatMap(({ from, to }) => [from, to]))].sort()
  const evidence: ReleaseEvidence[] = [], documents: ImpactContext['documents'] = []
  for (const [index, path] of files.entries()) {
    const change = context.files.find((file) => file.path === path)
    const changedLines = new Set(change ? releaseEvidence(change, [], context.base, context.head).filter(({ changed }) => changed).map(({ id }) => id) : [])
    for (const [version, side, commit, letter] of [['base', 'LEFT', context.base, 'L'], ['head', 'RIGHT', context.head, 'R']] as const) {
      const source = snapshots.get(version)!.find((file) => file.path === path)
      if (!source) continue
      const lines = source.text.split('\n').map((text, number) => {
        const line = number + 1, id = `F${index + 1}:${letter}${line}`, changed = changedLines.has(`${letter}${line}`)
        if (text.trim()) evidence.push({ id, path, line, quote: text, changed, commit, side })
        return { id, line, text, changed }
      })
      documents.push({ path, commit, side, lines })
    }
  }
  return { files, scannedFiles: new Set([...snapshots.values()].flat().map(({ path }) => path)).size, relations: [...relations.values()], evidence, documents }
}
