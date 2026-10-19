import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'

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

export type ChunkingOptions = {
  chunkSize?: number
  overlap?: number
}

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
