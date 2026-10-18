import { collectDeveloperDocuments, developerChunking } from './developer-corpus'
import { chunkDocuments } from './rag-indexer'

/** Current documentation remains searchable without Ollama or an up-to-date vector index. */
export function searchCurrentDocuments(root: string, query: string, reason = 'Индекс не создан') {
  const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_/-]+/gu) || [])]
  const chunks = chunkDocuments(collectDeveloperDocuments(root), 'structured', developerChunking)
  const ranked = chunks.map((chunk) => {
    const text = `${chunk.source} ${chunk.section} ${chunk.text}`.toLocaleLowerCase()
    return { chunk, score: terms.filter((term) => text.includes(term)).length }
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score)
  return { method: 'text', reason, total: ranked.length, truncated: ranked.length > 4,
    sources: ranked.slice(0, 4).map(({ chunk }) => ({ source: chunk.source, section: chunk.section, text: chunk.text.slice(0, 2400), truncated: chunk.text.length > 2400 })),
    note: 'Поиск по актуальным документам. Если совпадений мало, уточни ключевые слова или используй list_files/search_files/read_file. Номера строк подтверждай search_files.' }
}
