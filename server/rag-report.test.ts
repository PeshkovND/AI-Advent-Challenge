import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRagReport } from '../src/rag-report-import'
import { reportStats } from '../src/rag-evaluation'
import { demoAgentConfig, demoQuestions, demoModes, demoAgentIds, restoreDemoReport } from '../src/rag-demo-config'
import { ragQuestions } from '../src/rag-questions'
import { ragAbstentionQuestion } from '../src/rag-day23-questions'
import { parseGroundedAnswer } from './rag-grounding'

const fixture = () => ({
  id: '1b424b2f-eb9d-4741-b863-fede94c2125c', createdAt: '2026-10-03T12:00:00.000Z', completed: true,
  settings: { strategy: 'structured', candidateTopK: 20, topK: 4, minRelevance: 2 },
  index: { id: 'frozen-index', model: 'test', embeddingProfile: 'plain' }, modes: ['baseline', 'full'],
  questions: [{ id: 1, question: 'Question', expected: 'Answer', sources: ['source.md'], evidence: [{ source: 'source.md', quote: 'Answer' }] }],
  results: { 1: { answers: { full: { output: 'Actual answer', durationMs: 100, model: 'test', totalTokens: 10, rag: { indexRunId: 'frozen-index', sources: [{ source: 'source.md', title: 'Title', section: 'Section', chunkId: 'chunk', strategy: 'structured', score: 0.5, text: 'Answer' }] } } }, errors: {}, grades: {} } },
})
test('generated reports can be imported without transmitting or regenerating answers', () => {
  const report = parseRagReport(JSON.stringify({ ...fixture(), generatedAnswers: true }))
  assert.equal(report.results[1].answers.full?.output, 'Actual answer')
  assert.equal(report.index.id, 'frozen-index')
})
test('report import preserves grounding and literal citations without replacing old answers', () => {
  const parsed = parseGroundedAnswer(JSON.stringify({ status: 'answered', claims: [{ text: 'Answer', citations: [{ chunkId: 'chunk', quote: 'Exact literal answer.' }] }] }),
    [{ source: 'source.md', title: 'Title', section: 'Section', chunkId: 'chunk', strategy: 'structured', score: 0.5, text: 'Exact literal answer.' }])
  if (parsed.status !== 'answered') throw new Error('Expected answer')
  const saved = fixture()
  const rag = { ...saved.results[1].answers.full.rag, grounding: { ...parsed, answer: 'Answer [1]', sources: [{ source: 'source.md', section: 'Section', chunkId: 'chunk' }],
    verification: { status: 'passed', attempts: 1, judgments: [{ claimId: 1, supported: true, reason: 'Supported.' }] },
    usage: { inputTokens: 0, promptTokens: 10, completionTokens: 5, totalTokens: 15 } } }
  const report = parseRagReport(JSON.stringify({ ...saved, results: { 1: { ...saved.results[1], answers: { full: { ...saved.results[1].answers.full, rag } } } } }))
  assert.equal(report.results[1].answers.full?.rag?.grounding?.citations[0].quote, 'Exact literal answer.')
  assert.equal(report.results[1].answers.full?.output, 'Actual answer')
})
test('report import rejects retrieval-only probes and malformed nested fields', () => {
  assert.throws(() => parseRagReport(JSON.stringify({ ...fixture(), generatedAnswers: false })), /без ответов/)
  const invalid = fixture(); invalid.results[1].answers.full.rag.sources[0].score = 'invalid' as unknown as number
  assert.throws(() => parseRagReport(JSON.stringify(invalid)), /формат/)
})
test('evidence coverage is not counted as correct answer quality', () => {
  const report = parseRagReport(JSON.stringify(fixture()))
  const stats = reportStats(report, 'full')
  assert.equal(stats.evidencePassed, 1)
  assert.equal(stats.full, 0)
  report.results[1].grades.full = 'partial'
  assert.equal(reportStats(report, 'full').partial, 1)
  assert.equal(reportStats(report, 'baseline').evidenceQuestions, 1)
  assert.equal(reportStats(report, 'baseline').evidencePassed, 0)
})

test('simple demo uses four normal agents, grounding in all RAG modes and enhanced retrieval only in the fourth', () => {
  assert.equal(new Set(Object.values(demoAgentIds)).size, 4)
  const configs = demoModes.map((mode) => demoAgentConfig(mode, 'same-index'))
  assert.ok(configs.every((config) => config.model === configs[0].model && config.systemPrompt === configs[0].systemPrompt && config.temperature === 0))
  assert.equal(configs[0].rag, undefined)
  for (const config of configs.slice(1)) {
    assert.equal(config.rag?.indexRunId, 'same-index')
    assert.equal(config.rag?.grounding?.enabled, true)
  }
  const improved = demoAgentConfig('improved', 'same-index').rag
  assert.equal(improved?.queryRewrite, true)
  assert.equal(improved?.rerank?.minRelevance, 2)
  assert.equal(improved?.candidateTopK, 20)
  assert.equal(improved?.grounding?.enabled, true)
  for (const mode of ['structured', 'fixed'] as const) {
    const basic = demoAgentConfig(mode, 'same-index').rag!
    assert.equal(basic.strategy, mode)
    assert.equal(basic.topK, 4)
    assert.equal(basic.queryRewrite, undefined)
    assert.equal(basic.rerank, undefined)
    assert.equal(basic.minSimilarity, undefined)
    assert.equal(basic.candidateTopK, undefined)
  }
})

test('demo appends an abstention question without replacing the ten original questions or injecting an answer', () => {
  assert.equal(ragQuestions.length, 10)
  assert.equal(demoQuestions.length, 11)
  assert.deepEqual(demoQuestions.slice(0, 10), ragQuestions)
  assert.equal(new Set(demoQuestions.map((question) => question.id)).size, 11)
  const question = demoQuestions[10]
  assert.equal(question.id, 11)
  assert.equal(question.question, ragAbstentionQuestion.question)
  assert.deepEqual(question.sources, [])
  assert.deepEqual(question.evidence, [])
  assert.ok(question.expected.includes('Не знаю'))
  assert.ok(question.expected.includes('уточнение'))
  for (const mode of demoModes) assert.ok(!demoAgentConfig(mode, 'index').systemPrompt.includes('Redis'))
})

test('simple demo restores the fullest compatible report without inventing plain or fixed answers', () => {
  const full = parseRagReport(JSON.stringify(fixture()))
  full.questions = ragQuestions.slice(0, 2)
  const answer = full.results[1].answers.full!
  full.results[1].answers.baseline = { ...answer, output: 'Saved baseline' }
  full.results[2] = structuredClone(full.results[1])
  const newer = structuredClone(full)
  newer.createdAt = '2026-10-03T13:00:00.000Z'
  newer.questions = [ragQuestions[0]]
  newer.results[1].answers.full!.output = 'Newer partial run'
  const restored = restoreDemoReport([newer, full])!
  assert.deepEqual(Object.keys(restored.results), ['1', '2'])
  assert.equal(restored.results[1].structured?.output, 'Saved baseline')
  assert.equal(restored.results[1].improved?.output, 'Actual answer')
  assert.equal(restored.results[1].without, undefined)
  assert.equal(restored.results[1].fixed, undefined)
  assert.equal(full.results[1].answers.full?.output, 'Actual answer')
})

test('simple demo does not restore incompatible strategy, stale question IDs or another index', () => {
  const report = parseRagReport(JSON.stringify(fixture()))
  report.questions = [ragQuestions[0]]
  report.results[1].answers.baseline = structuredClone(report.results[1].answers.full)
  assert.ok(restoreDemoReport([report]))
  report.settings.strategy = 'fixed'
  assert.equal(restoreDemoReport([report]), undefined)
  report.settings.strategy = 'structured'
  report.questions = [{ ...ragQuestions[0], question: 'Different question with same ID' }]
  assert.equal(restoreDemoReport([report]), undefined)
  report.questions = [ragQuestions[0]]
  report.results[1].answers.full!.rag!.indexRunId = 'other-index'
  assert.equal(restoreDemoReport([report]), undefined)
})
