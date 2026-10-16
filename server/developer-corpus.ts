import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { documentFromText, type SourceDocument } from './rag-indexer'
import { publicProjectPath } from './project-workspace'

const textExtensions = new Set(['.md', '.markdown', '.txt', '.yaml', '.yml', '.sql', '.graphql', '.prisma'])
export const developerChunking = { chunkSize: 200, overlap: 40 }

export function collectDeveloperDocuments(root: string): SourceDocument[] {
  root = realpathSync(root)
  const files = new Set<string>()
  let total = 0
  const visit = (path: string, explicit = false) => {
    const source = relative(root, path).split('\\').join('/')
    if (!publicProjectPath(source)) return
    let stat
    try { stat = lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (stat.isSymbolicLink()) return
    if (realpathSync(path) !== path) return
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(resolve(path, entry))
      return
    }
    const extension = extname(path).toLowerCase()
    if (!stat.isFile() || !(explicit || textExtensions.has(extension) || extension === '.json' && /(?:api|schema|swagger)/i.test(source))) return
    if (stat.size > 1024 * 1024) throw new Error(`Документ ${source} превышает 1 МБ.`)
    if (!files.has(path)) { files.add(path); total += stat.size }
    if (total > 8 * 1024 * 1024) throw new Error('Корпус документации превышает 8 МБ.')
  }
  const roots = readdirSync(root).sort()
  for (const name of roots) {
    if (/^readme(?:\.(md|markdown|txt))?$/i.test(name) || /^(openapi|swagger)\.(json|ya?ml)$/i.test(name) || /\.schema\.json$/i.test(name)) visit(resolve(root, name), true)
    if (/^(docs|api|schemas|schema)$/i.test(name)) visit(resolve(root, name))
    if (/^project$/i.test(name) && lstatSync(resolve(root, name)).isDirectory()) {
      for (const entry of readdirSync(resolve(root, name)).sort()) if (/^docs$/i.test(entry)) visit(resolve(root, name, entry))
    }
  }
  return [...files].sort().map((path) => documentFromText(relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8'))).filter((document) => document.text)
}

export function developerFingerprint(documents: SourceDocument[], model: string, profile: string) {
  return createHash('sha256').update(JSON.stringify({ version: 1, model, profile, chunking: developerChunking,
    documents: documents.map(({ source, text }) => ({ source, text })),
  })).digest('hex')
}
