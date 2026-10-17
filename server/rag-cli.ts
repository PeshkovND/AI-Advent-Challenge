import { chunkDocuments, collectProjectDocuments, type ChunkingStrategy, OllamaEmbeddingClient, RagIndexStore } from './rag-indexer'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

type CliOptions = {
  root: string
  database?: string
  strategy: 'all' | ChunkingStrategy
  chunkSize?: number
  overlap?: number
}

function parseOptions(args: string[]) {
  const options: CliOptions = { root: process.cwd(), strategy: 'all' }
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    const next = args[index + 1]
    if (value === '--root' && next) { options.root = next; index += 1 }
    else if (value === '--database' && next) { options.database = next; index += 1 }
    else if (value === '--strategy' && (next === 'all' || next === 'fixed' || next === 'structured')) { options.strategy = next; index += 1 }
    else if (value === '--chunk-size' && next) { options.chunkSize = Number(next); index += 1 }
    else if (value === '--overlap' && next) { options.overlap = Number(next); index += 1 }
    else if (value.startsWith('--')) throw new Error(`Неизвестный или неполный параметр: ${value}`)
  }
  return options
}

function printHelp() {
  console.log(`Использование:
  npm run rag:index [-- --strategy all|fixed|structured] [--chunk-size 200] [--overlap 40] [--database путь]
  npm run rag:stats [-- --database путь]
  npm run rag:search -- "текст запроса" [--strategy fixed|structured] [--database путь]
  npm run rag:demo

По умолчанию индексируются README.md, docs/, server/ и src/, кроме проверочных материалов Day 22.`)
}

async function index(args: string[]) {
  const options = parseOptions(args)
  const documents = collectProjectDocuments(options.root)
  const strategies: ChunkingStrategy[] = options.strategy === 'all' ? ['fixed', 'structured'] : [options.strategy]
  const chunks = strategies.flatMap((strategy) => chunkDocuments(documents, strategy, { chunkSize: options.chunkSize, overlap: options.overlap }))
  const ollama = new OllamaEmbeddingClient()
  console.log(`Документов: ${documents.length}; чанков: ${chunks.length}; модель: ${ollama.model}. Генерируются эмбеддинги…`)
  const embedded = await ollama.embedChunks(chunks)
  const store = new RagIndexStore(options.database)
  try {
    const run = store.saveIndex(embedded, documents.length, ollama.model, strategies, ollama.embeddingProfile)
    const byStrategy = Object.fromEntries(strategies.map((strategy) => [strategy, chunks.filter((chunk) => chunk.strategy === strategy).length]))
    console.log(JSON.stringify({ status: 'ok', run, chunksByStrategy: byStrategy }, null, 2))
  } finally { store.close() }
}

function stats(args: string[]) {
  const options = parseOptions(args)
  const store = new RagIndexStore(options.database)
  try { console.log(JSON.stringify(store.latestRun() ?? { status: 'empty' }, null, 2)) } finally { store.close() }
}

async function search(args: string[]) {
  const optionArgs: string[] = []
  const queryParts: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--') continue
    if (['--root', '--database', '--strategy', '--chunk-size', '--overlap'].includes(value)) {
      optionArgs.push(value)
      if (args[index + 1] === undefined) throw new Error(`Не задано значение для ${value}.`)
      optionArgs.push(args[index + 1])
      index += 1
    } else if (value.startsWith('--')) {
      throw new Error(`Неизвестный параметр: ${value}`)
    } else {
      queryParts.push(value)
    }
  }
  const query = queryParts.join(' ')
  if (!query.trim()) throw new Error('Передайте текст запроса после `--`.')
  const options = parseOptions(optionArgs)
  const store = new RagIndexStore(options.database)
  try {
    const run = store.latestRun()
    if (!run) throw new Error('Индекс ещё не создан.')
    const [embedding] = await new OllamaEmbeddingClient(undefined, run.model).embedQuery(query, run.embeddingProfile)
    const strategy = options.strategy === 'all' ? undefined : options.strategy
    console.log(JSON.stringify(store.search(embedding, 5, strategy).map(({ chunk, score }) => ({ score: Number(score.toFixed(4)), metadata: { source: chunk.source, title: chunk.title, section: chunk.section, chunk_id: chunk.chunk_id, strategy: chunk.strategy }, text: chunk.text })), null, 2))
  } finally { store.close() }
}

async function demo() {
  const terminal = createInterface({ input: stdin, output: stdout })
  const printCommand = (command: string) => console.log(`\n$ ${command}`)
  console.log('\nRAG Day 21 — локальный индекс документов')
  console.log('Ollama используется только на этом компьютере.')
  console.log('Перед выполнением меню выводит эквивалентную команду в терминал.\n')
  try {
    let active = true
    while (active) {
      console.log('1. Показать состояние индекса')
      console.log('2. Найти документы по запросу')
      console.log('3. Сравнить fixed и structured на запросе')
      console.log('4. Пересобрать индекс')
      console.log('0. Выйти')
      const choice = (await terminal.question('\nВыберите действие: ')).trim()
      if (choice === '1') {
        printCommand('npm run rag:stats')
        stats([])
      } else if (choice === '2') {
        const query = (await terminal.question('Запрос: ')).trim()
        if (query) {
          printCommand(`npm run rag:search -- ${JSON.stringify(query)}`)
          await search([query])
        }
      } else if (choice === '3') {
        const query = (await terminal.question('Запрос: ')).trim()
        if (query) {
          printCommand(`npm run rag:search -- --strategy fixed ${JSON.stringify(query)}`)
          console.log('\n--- fixed ---')
          await search(['--strategy', 'fixed', query])
          printCommand(`npm run rag:search -- --strategy structured ${JSON.stringify(query)}`)
          console.log('\n--- structured ---')
          await search(['--strategy', 'structured', query])
        }
      } else if (choice === '4') {
        const confirmation = (await terminal.question('Пересобрать все embeddings? Это займёт несколько минут. [y/N]: ')).trim().toLowerCase()
        if (confirmation === 'y' || confirmation === 'yes' || confirmation === 'д') {
          printCommand('npm run rag:index')
          await index([])
        }
        else console.log('Пересборка отменена.')
      } else if (choice === '0') {
        active = false
      } else {
        console.log('Введите число от 0 до 4.')
      }
      if (active) console.log('')
    }
  } finally {
    terminal.close()
  }
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2)
  if (command === 'index') return index(args)
  if (command === 'stats') return stats(args)
  if (command === 'search') return search(args)
  if (command === 'demo') return demo()
  printHelp()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
