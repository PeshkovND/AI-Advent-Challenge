import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type ChunkingStrategy = 'fixed' | 'structured'
export type EmbeddingProfile = 'plain' | 'nomic-retrieval-v1' | 'nomic-retrieval-metadata-v1'

export type DocumentSection = {
  title: string
  start: number
  end: number
}

export type SourceDocument = {
  source: string
  title: string
  text: string
  sections: DocumentSection[]
}

export type ChunkMetadata = {
  source: string
  title: string
  section: string
  chunk_id: string
  strategy: ChunkingStrategy
  ordinal: number
  characterCount: number
}

export type DocumentChunk = ChunkMetadata & {
  text: string
}

export type EmbeddedChunk = DocumentChunk & {
  embedding: number[]
}

export type ChunkingOptions = {
  chunkSize?: number
  overlap?: number
}

export type RagIndexRun = {
  id: string
  createdAt: string
  model: string
  embeddingProfile: EmbeddingProfile
  sourceCount: number
  chunkCount: number
  vectorDimensions: number
  strategies: ChunkingStrategy[]
}

export type RagSearchResult = {
  chunk: DocumentChunk
  score: number
}

const supportedExtensions = new Set(['.md', '.ts', '.tsx', '.js', '.jsx', '.css', '.pdf'])
const evaluationSources = new Set(['docs/day-22.md', 'docs/day-23.md', 'docs/day-24.md', 'docs/day-25.md', 'src/rag-questions.ts', 'src/rag-day23-questions.ts', 'src/rag-chat-scenarios.ts', 'server/rag-check-questions.ts', 'server/rag-evaluate.ts', 'server/rag-grounding-evaluate.ts', 'server/rag-chat-evaluate.ts', 'server/rag-chat-task-probe.ts', 'server/rag-chat-preferences-evaluate.ts'])
const defaultChunkSize = 200
const defaultOverlap = 40

function normalizeText(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[ \t]+\n/g, '\n').trim()
}

function titleFromPath(filePath: string) {
  return basename(filePath, extname(filePath)).replace(/[-_]/g, ' ')
}

/** Converts a Markdown, source-code or PDF file into indexable text and section offsets. */
export function documentFromText(source: string, rawText: string): SourceDocument {
  const text = normalizeText(rawText)
  const extension = extname(source).toLowerCase()
  const initialTitle = titleFromPath(source)
  if (extension !== '.md') {
    return { source, title: initialTitle, text, sections: [{ title: initialTitle, start: 0, end: text.length }] }
  }

  const headings = [...text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)]
  const title = headings[0]?.[1]?.trim() || initialTitle
  if (headings.length === 0) return { source, title, text, sections: [{ title, start: 0, end: text.length }] }

  const sections: DocumentSection[] = []
  if (headings[0].index! > 0) sections.push({ title, start: 0, end: headings[0].index! })
  headings.forEach((heading, index) => {
    const start = heading.index ?? 0
    const end = index + 1 < headings.length ? headings[index + 1].index ?? text.length : text.length
    sections.push({ title: heading[1].trim(), start, end })
  })
  return { source, title, text, sections }
}

function readPdf(filePath: string) {
  try {
    return execFileSync('pdftotext', [filePath, '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    throw new Error(`Не удалось извлечь текст из ${filePath}. Установите утилиту pdftotext или исключите PDF из корпуса.`)
  }
}

export function readSourceDocument(root: string, filePath: string) {
  const extension = extname(filePath).toLowerCase()
  if (!supportedExtensions.has(extension)) throw new Error(`Неподдерживаемый тип документа: ${filePath}`)
  const rawText = extension === '.pdf' ? readPdf(filePath) : readFileSync(filePath, 'utf8')
  return documentFromText(relative(root, filePath), rawText)
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? listFiles(path) : supportedExtensions.has(extname(entry.name).toLowerCase()) ? [path] : []
  })
}

/** The default corpus is the course notes and application code already present in this repository. */
export function collectProjectDocuments(root = process.cwd()) {
  const candidates = [resolve(root, 'README.md'), ...listFiles(resolve(root, 'docs')), ...listFiles(resolve(root, 'server')), ...listFiles(resolve(root, 'src'))]
  return candidates.filter((filePath) => existsSync(filePath) && !evaluationSources.has(relative(root, filePath)) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath)).sort().map((filePath) => readSourceDocument(root, filePath))
}

function makeChunk(document: SourceDocument, strategy: ChunkingStrategy, ordinal: number, section: string, text: string) {
  const normalized = text.trim()
  const stableKey = `${strategy}:${document.source}:${ordinal}:${normalized}`
  const chunk_id = `${strategy}-${createHash('sha256').update(stableKey).digest('hex').slice(0, 16)}`
  return {
    source: document.source,
    title: document.title,
    section,
    chunk_id,
    strategy,
    ordinal,
    characterCount: normalized.length,
    text: normalized,
  } satisfies DocumentChunk
}

function sectionAt(document: SourceDocument, position: number) {
  return document.sections.find((section) => position >= section.start && position < section.end)?.title ?? document.title
}

type WordSpan = { start: number; end: number }

function wordsIn(text: string): WordSpan[] {
  return [...text.matchAll(/\S+/g)].map((match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }))
}

function splitText(document: SourceDocument, strategy: ChunkingStrategy, text: string, offset: number, startOrdinal: number, options: Required<ChunkingOptions>, sectionForPosition: (position: number) => string) {
  const words = wordsIn(text)
  const chunks: DocumentChunk[] = []
  let startWord = 0
  while (startWord < words.length) {
    const endWord = Math.min(startWord + options.chunkSize, words.length)
    const part = text.slice(words[startWord].start, words[endWord - 1].end)
    chunks.push(makeChunk(document, strategy, startOrdinal + chunks.length, sectionForPosition(offset + words[startWord].start), part))
    if (endWord >= words.length) break
    startWord = Math.max(endWord - options.overlap, startWord + 1)
  }
  return chunks
}

export function chunkFixed(document: SourceDocument, overrides: ChunkingOptions = {}) {
  const options = { chunkSize: overrides.chunkSize ?? defaultChunkSize, overlap: overrides.overlap ?? defaultOverlap }
  validateChunkingOptions(options)
  return splitText(document, 'fixed', document.text, 0, 0, options, (position) => sectionAt(document, position))
}

export function chunkStructured(document: SourceDocument, overrides: ChunkingOptions = {}) {
  const options = { chunkSize: overrides.chunkSize ?? defaultChunkSize, overlap: overrides.overlap ?? defaultOverlap }
  validateChunkingOptions(options)
  const chunks: DocumentChunk[] = []
  for (const section of document.sections) {
    const text = document.text.slice(section.start, section.end)
    chunks.push(...splitText(document, 'structured', text, section.start, chunks.length, options, () => section.title))
  }
  return chunks
}

function validateChunkingOptions(options: Required<ChunkingOptions>) {
  if (!Number.isInteger(options.chunkSize) || options.chunkSize < 10) throw new Error('Размер чанка должен быть целым числом не меньше 10 слов.')
  if (!Number.isInteger(options.overlap) || options.overlap < 0 || options.overlap >= options.chunkSize) throw new Error('Overlap в словах должен быть неотрицательным и меньше размера чанка.')
}

export function chunkDocuments(documents: SourceDocument[], strategy: ChunkingStrategy, options: ChunkingOptions = {}) {
  return documents.flatMap((document) => strategy === 'fixed' ? chunkFixed(document, options) : chunkStructured(document, options))
}

type OllamaEmbedResponse = { embeddings?: unknown }

export class OllamaEmbeddingClient {
  readonly baseUrl: string
  readonly model: string
  readonly embeddingProfile: EmbeddingProfile

  constructor(baseUrl = process.env.OLLAMA_BASE_URL?.trim() || 'http://127.0.0.1:11434', model = process.env.OLLAMA_EMBED_MODEL?.trim() || 'nomic-embed-text-v2-moe') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.model = model
    this.embeddingProfile = model.startsWith('nomic-embed-text') ? 'nomic-retrieval-metadata-v1' : 'plain'
  }

  async embed(texts: string[], signal?: AbortSignal) {
    if (texts.length === 0) return []
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      })
    } catch (error) {
      throw new Error(`Ollama недоступен по ${this.baseUrl}. Запустите Ollama и выполните \`ollama pull ${this.model}\`. ${error instanceof Error ? error.message : ''}`.trim())
    }
    if (!response.ok) throw new Error(`Ollama вернул ${response.status}: ${(await response.text()).slice(0, 500)}`)
    const payload = await response.json() as OllamaEmbedResponse
    if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length || !payload.embeddings.every((vector) => Array.isArray(vector) && vector.every((item) => typeof item === 'number' && Number.isFinite(item)))) {
      throw new Error('Ollama вернул некорректные эмбеддинги.')
    }
    const embeddings = payload.embeddings as number[][]
    const dimensions = embeddings[0]?.length ?? 0
    if (!dimensions || embeddings.some((vector) => vector.length !== dimensions)) throw new Error('Размерности эмбеддингов Ollama не совпадают.')
    return embeddings
  }

  async embedQueries(questions: string[], profile = this.embeddingProfile, signal?: AbortSignal) {
    return this.embed(questions.map((question) => profile === 'plain' ? question : `search_query: ${question}`), signal)
  }

  async embedQuery(question: string, profile = this.embeddingProfile) {
    return this.embedQueries([question], profile)
  }

  async embedChunks(chunks: DocumentChunk[], batchSize = 24): Promise<EmbeddedChunk[]> {
    const result: EmbeddedChunk[] = []
    for (let index = 0; index < chunks.length; index += batchSize) {
      const batch = chunks.slice(index, index + batchSize)
      const embeddings = await this.embed(batch.map((chunk) => {
        if (this.embeddingProfile === 'plain') return chunk.text
        if (this.embeddingProfile === 'nomic-retrieval-v1') return `search_document: ${chunk.text}`
        return `search_document: ${chunk.title}\n${chunk.section}\n${chunk.text}`
      }))
      result.push(...batch.map((chunk, item) => ({ ...chunk, embedding: embeddings[item] })))
    }
    return result
  }
}

function parseJson(value: unknown) {
  return typeof value === 'string' ? JSON.parse(value) : undefined
}

export class RagIndexStore {
  private readonly database: DatabaseSync

  constructor(filePath = process.env.RAG_INDEX_PATH?.trim() || resolve(process.cwd(), 'data', 'rag-index.sqlite')) {
    mkdirSync(dirname(filePath), { recursive: true })
    this.database = new DatabaseSync(filePath)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS rag_index_runs (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, model TEXT NOT NULL,
        embedding_profile TEXT NOT NULL DEFAULT 'plain',
        source_count INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
        vector_dimensions INTEGER NOT NULL, strategies_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rag_document_chunks (
        run_id TEXT NOT NULL, chunk_id TEXT NOT NULL, strategy TEXT NOT NULL,
        source TEXT NOT NULL, title TEXT NOT NULL, section TEXT NOT NULL,
        ordinal INTEGER NOT NULL, character_count INTEGER NOT NULL, content TEXT NOT NULL,
        PRIMARY KEY (run_id, chunk_id), FOREIGN KEY (run_id) REFERENCES rag_index_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS rag_embeddings (
        run_id TEXT NOT NULL, chunk_id TEXT NOT NULL, dimensions INTEGER NOT NULL, vector_json TEXT NOT NULL,
        PRIMARY KEY (run_id, chunk_id), FOREIGN KEY (run_id, chunk_id) REFERENCES rag_document_chunks(run_id, chunk_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS rag_chunks_by_run_strategy ON rag_document_chunks(run_id, strategy);
    `)
    const columns = this.database.prepare('PRAGMA table_info(rag_index_runs)').all() as { name: string }[]
    if (!columns.some((column) => column.name === 'embedding_profile')) {
      this.database.exec("ALTER TABLE rag_index_runs ADD COLUMN embedding_profile TEXT NOT NULL DEFAULT 'plain'")
    }
  }

  saveIndex(chunks: EmbeddedChunk[], sourceCount: number, model: string, strategies: ChunkingStrategy[], embeddingProfile: EmbeddingProfile) {
    if (!chunks.length) throw new Error('Нельзя сохранить пустой индекс.')
    const dimensions = chunks[0].embedding.length
    if (!dimensions || chunks.some((chunk) => chunk.embedding.length !== dimensions)) throw new Error('У всех чанков должна быть одна размерность эмбеддинга.')
    const run: RagIndexRun = { id: randomUUID(), createdAt: new Date().toISOString(), model, embeddingProfile, sourceCount, chunkCount: chunks.length, vectorDimensions: dimensions, strategies }
    const insertRun = this.database.prepare('INSERT INTO rag_index_runs (id, created_at, model, embedding_profile, source_count, chunk_count, vector_dimensions, strategies_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const insertChunk = this.database.prepare('INSERT INTO rag_document_chunks (run_id, chunk_id, strategy, source, title, section, ordinal, character_count, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const insertEmbedding = this.database.prepare('INSERT INTO rag_embeddings (run_id, chunk_id, dimensions, vector_json) VALUES (?, ?, ?, ?)')
    this.database.exec('BEGIN')
    try {
      insertRun.run(run.id, run.createdAt, run.model, run.embeddingProfile, run.sourceCount, run.chunkCount, run.vectorDimensions, JSON.stringify(run.strategies))
      for (const chunk of chunks) {
        insertChunk.run(run.id, chunk.chunk_id, chunk.strategy, chunk.source, chunk.title, chunk.section, chunk.ordinal, chunk.characterCount, chunk.text)
        insertEmbedding.run(run.id, chunk.chunk_id, dimensions, JSON.stringify(chunk.embedding))
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return run
  }

  latestRun() {
    const row = this.database.prepare('SELECT * FROM rag_index_runs ORDER BY created_at DESC LIMIT 1').get() as Record<string, unknown> | undefined
    return this.readRun(row)
  }

  getRun(id: string) {
    return this.readRun(this.database.prepare('SELECT * FROM rag_index_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined)
  }

  private readRun(row: Record<string, unknown> | undefined) {
    if (!row) return undefined
    return {
      id: String(row.id), createdAt: String(row.created_at), model: String(row.model), embeddingProfile: String(row.embedding_profile) as EmbeddingProfile, sourceCount: Number(row.source_count), chunkCount: Number(row.chunk_count), vectorDimensions: Number(row.vector_dimensions), strategies: parseJson(row.strategies_json) as ChunkingStrategy[],
    } satisfies RagIndexRun
  }

  search(queryEmbedding: number[], limit = 5, strategy?: ChunkingStrategy, runId?: string) {
    const run = runId ? this.getRun(runId) : this.latestRun()
    if (!run) throw new Error('Индекс ещё не создан.')
    if (queryEmbedding.length !== run.vectorDimensions) throw new Error(`Размерность запроса (${queryEmbedding.length}) не совпадает с индексом (${run.vectorDimensions}).`)
    const rows = this.database.prepare(`SELECT chunks.*, embeddings.vector_json FROM rag_document_chunks chunks
      JOIN rag_embeddings embeddings ON embeddings.run_id = chunks.run_id AND embeddings.chunk_id = chunks.chunk_id
      WHERE chunks.run_id = ?${strategy ? ' AND chunks.strategy = ?' : ''}`).all(...(strategy ? [run.id, strategy] : [run.id])) as Record<string, unknown>[]
    return rows.map((row) => {
      const embedding = parseJson(row.vector_json) as number[]
      const chunk: DocumentChunk = {
        source: String(row.source), title: String(row.title), section: String(row.section), chunk_id: String(row.chunk_id), strategy: String(row.strategy) as ChunkingStrategy, ordinal: Number(row.ordinal), characterCount: Number(row.character_count), text: String(row.content),
      }
      return { chunk, score: cosineSimilarity(queryEmbedding, embedding) }
    }).sort((a, b) => b.score - a.score).slice(0, limit)
  }

  close() { this.database.close() }
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (left.length !== right.length || left.length === 0) throw new Error('Для cosine similarity нужны непустые векторы одинаковой размерности.')
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] ** 2
    rightNorm += right[index] ** 2
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0
}
