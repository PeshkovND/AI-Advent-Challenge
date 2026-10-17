import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chunkFixed, chunkStructured, collectProjectDocuments, documentFromText, OllamaEmbeddingClient, RagIndexStore } from './rag-indexer'

test('project corpus excludes control questions and their answer key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rag-corpus-'))
  try {
    for (const folder of ['docs', 'server', 'src']) mkdirSync(join(directory, folder))
    for (const source of ['docs/day-21.md', 'docs/day-22.md', 'docs/day-23.md', 'docs/day-24.md', 'server/rag-check-questions.ts', 'server/rag-evaluate.ts', 'server/rag-grounding-evaluate.ts', 'server/rag-retrieval.test.ts', 'src/example.spec.tsx', 'src/rag-questions.ts', 'src/rag-day23-questions.ts', 'src/App.tsx']) {
      writeFileSync(join(directory, source), 'Test document')
    }
    assert.deepEqual(collectProjectDocuments(directory).map((document) => document.source), ['docs/day-21.md', 'src/App.tsx'])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('fixed chunks keep required metadata and overlap', () => {
  const document = documentFromText('docs/example.md', '# Example\n\n' + Array.from({ length: 100 }, (_, index) => `word${index}`).join(' '))
  const chunks = chunkFixed(document, { chunkSize: 12, overlap: 2 })

  assert.ok(chunks.length > 2)
  assert.ok(chunks.every((chunk) => chunk.strategy === 'fixed' && chunk.source === 'docs/example.md' && chunk.title === 'Example' && chunk.section && chunk.chunk_id && chunk.characterCount === chunk.text.length))
  assert.ok(chunks.every((chunk) => (chunk.text.match(/\S+/g) ?? []).length <= 12))
  const overlapWords = (chunks[0].text.match(/\S+/g) ?? []).slice(-2)
  assert.ok(overlapWords.every((word) => chunks[1].text.includes(word)))
})

test('structured chunks preserve Markdown heading as section metadata', () => {
  const document = documentFromText('docs/rag.md', '# RAG\n\nIntroduction.\n\n## Chunking\n\n' + 'Structured content. '.repeat(20) + '\n\n## Embeddings\n\n' + 'Vector content. '.repeat(20))
  const chunks = chunkStructured(document, { chunkSize: 12, overlap: 2 })

  assert.ok(chunks.some((chunk) => chunk.section === 'Chunking'))
  assert.ok(chunks.some((chunk) => chunk.section === 'Embeddings'))
  assert.ok(chunks.every((chunk) => chunk.strategy === 'structured'))
})

test('SQLite store saves metadata, vectors and supports cosine search', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rag-index-'))
  const store = new RagIndexStore(join(directory, 'index.sqlite'))
  try {
  const document = documentFromText('README.md', '# Guide\n\nUseful text about embeddings.')
    const [chunk] = chunkFixed(document, { chunkSize: 10, overlap: 0 })
    const run = store.saveIndex([{ ...chunk, embedding: [1, 0, 0] }], 1, 'test-model', ['fixed'], 'plain')
    assert.equal(store.latestRun()?.id, run.id)
    assert.equal(store.latestRun()?.vectorDimensions, 3)
    assert.equal(store.latestRun()?.embeddingProfile, 'plain')
    const [result] = store.search([1, 0, 0])
    assert.equal(result.chunk.chunk_id, chunk.chunk_id)
    assert.equal(result.score, 1)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('existing indexes are marked plain when embedding profile is added', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rag-legacy-'))
  const path = join(directory, 'index.sqlite')
  const legacy = new DatabaseSync(path)
  legacy.exec(`CREATE TABLE rag_index_runs (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, model TEXT NOT NULL,
    source_count INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
    vector_dimensions INTEGER NOT NULL, strategies_json TEXT NOT NULL
  );
  INSERT INTO rag_index_runs VALUES ('old', '2026-01-01T00:00:00.000Z', 'nomic-embed-text', 1, 1, 768, '["fixed"]');`)
  legacy.close()
  const store = new RagIndexStore(path)
  try { assert.equal(store.latestRun()?.embeddingProfile, 'plain') }
  finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('pinned search keeps using the selected index after a new run is saved', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rag-pinned-'))
  const store = new RagIndexStore(join(directory, 'index.sqlite'))
  try {
    const [chunk] = chunkFixed(documentFromText('old.md', 'Old corpus'))
    const old = store.saveIndex([{ ...chunk, embedding: [1, 0] }], 1, 'old-model', ['fixed'], 'plain')
    const [next] = chunkFixed(documentFromText('new.md', 'New corpus'))
    store.saveIndex([{ ...next, embedding: [0, 1, 0] }], 1, 'new-model', ['fixed'], 'plain')
    assert.equal(store.getRun(old.id)?.model, 'old-model')
    assert.equal(store.search([1, 0], 4, 'fixed', old.id)[0].chunk.source, 'old.md')
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('Ollama client accepts a batched API response', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/api/embed')
    let body = ''
    request.on('data', (part) => { body += part })
    request.on('end', () => {
      assert.deepEqual(JSON.parse(body), { model: 'test-model', input: ['one', 'two'] })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ embeddings: [[1, 0], [0, 1]] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    const client = new OllamaEmbeddingClient(`http://127.0.0.1:${address.port}`, 'test-model')
    assert.deepEqual(await client.embed(['one', 'two']), [[1, 0], [0, 1]])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('Nomic retrieval prefixes documents and questions but preserves legacy plain queries', async () => {
  const inputs: string[][] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (part) => { body += part })
    request.on('end', () => {
      const payload = JSON.parse(body) as { input: string[] }
      inputs.push(payload.input)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ embeddings: payload.input.map(() => [1, 0]) }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    const client = new OllamaEmbeddingClient(`http://127.0.0.1:${address.port}`, 'nomic-embed-text-v2-moe')
    const [chunk] = chunkFixed(documentFromText('docs/example.md', '# Example\n\nA useful passage.'))
    await client.embedQuery('Question?')
    await client.embedChunks([chunk])
    await client.embedQueries(['Old question?'], 'plain')
    assert.deepEqual(inputs, [['search_query: Question?'], [`search_document: ${chunk.title}\n${chunk.section}\n${chunk.text}`], ['Old question?']])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
