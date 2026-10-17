import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { documentFromText, type SourceDocument } from './rag-indexer'
import { SupportError } from './support-errors'

export const supportChunking = { chunkSize: 200, overlap: 40 }
export function collectSupportDocuments(root: string, knowledgeDirectory = 'support/knowledge'): SourceDocument[] {
  const base = resolve(root, knowledgeDirectory), documents: SourceDocument[] = []
  let total = 0
  const visit = (path: string) => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new SupportError('Символические ссылки в базе знаний не поддерживаются.')
    if (stat.isDirectory()) { for (const name of readdirSync(path).sort()) visit(resolve(path, name)); return }
    if (!stat.isFile() || !/\.(md|txt)$/i.test(path)) return
    total += stat.size
    if (stat.size > 1024 * 1024 || total > 4 * 1024 * 1024) throw new SupportError('База знаний превышает лимит размера.')
    const document = documentFromText(relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8'))
    if (document.text) documents.push(document)
  }
  try { visit(base) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new SupportError('Каталог базы знаний недоступен. Проверьте SUPPORT_KNOWLEDGE_PATH.', 503)
  }
  return documents
}
export const supportFingerprint = (documents: SourceDocument[], model: string, profile: string) => createHash('sha256').update(JSON.stringify({ version: 1, model, profile, chunking: supportChunking, documents })).digest('hex')
