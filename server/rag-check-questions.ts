import { ragQuestions, type RagEvidence } from '../src/rag-questions'
import { OllamaEmbeddingClient, RagIndexStore, type ChunkingStrategy, type RagSearchResult } from './rag-indexer'

const args = process.argv.slice(2)
const databaseOption = args.indexOf('--database')
if (databaseOption >= 0 && !args[databaseOption + 1]) throw new Error('Укажите путь после --database.')
if (args.some((arg, index) => arg.startsWith('--') && (arg !== '--database' || index !== databaseOption))) throw new Error('Допустим только параметр --database.')
const store = new RagIndexStore(databaseOption >= 0 ? args[databaseOption + 1] : undefined)

function evidenceRank(results: RagSearchResult[], evidence: RagEvidence) {
  const acceptable = [evidence, ...(evidence.alternatives ?? [])]
  const index = results.findIndex(({ chunk }) => acceptable.some((candidate) => chunk.source === candidate.source && chunk.text.includes(candidate.quote)))
  return index < 0 ? null : index + 1
}

try {
  const run = store.latestRun()
  if (!run) throw new Error('Индекс ещё не создан.')
  const client = new OllamaEmbeddingClient(undefined, run.model)
  const vectors = await client.embedQueries(ragQuestions.map((item) => item.question), run.embeddingProfile)
  const strategies: ChunkingStrategy[] = ['fixed', 'structured'].filter((strategy): strategy is ChunkingStrategy => run.strategies.includes(strategy as ChunkingStrategy))
  console.log(`Индекс: ${run.model}; профиль: ${run.embeddingProfile}; topK: 4`)
  for (const strategy of strategies) {
    let found = 0
    console.log(`\n${strategy}:`)
    for (const [index, item] of ragQuestions.entries()) {
      const results = store.search(vectors[index], run.chunkCount, strategy)
      const ranks = item.evidence.map((evidence) => evidenceRank(results, evidence))
      if (ranks.some((rank) => rank === null)) throw new Error(`Контрольный фрагмент для вопроса ${item.id} отсутствует в индексе ${strategy}.`)
      const hit = ranks.every((rank) => rank !== null && rank <= 4)
      if (hit) found += 1
      console.log(`${hit ? '✓' : '✗'} ${item.id}. позиции фрагментов: ${ranks.join(', ')}`)
    }
    console.log(`Все фрагменты с ответом в top 4: ${found}/${ragQuestions.length}`)
  }
} finally {
  store.close()
}
