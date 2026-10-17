import './network-config'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { groundedAgentConfig } from '../src/rag-grounded-config'
import { demoAgentIds } from '../src/rag-demo-config'
import { ragQuestions, type RagQuestion } from '../src/rag-questions'
import { additionalRagQuestions } from '../src/rag-day23-questions'
import type { RagRunResult } from '../src/rag-report-store'

const args = process.argv.slice(2)
if (args.some((argument) => argument !== '--extended')) throw new Error('Поддерживается только --extended (два вопроса вне базы).')
const base = 'http://127.0.0.1:8787'
async function request<T>(path: string, body?: unknown, method = 'GET'): Promise<T> {
  const response = await fetch(`${base}${path}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
  return data as T
}
const { index } = await request<{ index: { id: string } | null }>('/api/rag/index')
if (!index) throw new Error('Индекс пуст. Выполните npm run rag:index.')
const agentId = demoAgentIds.improved
const config = groundedAgentConfig(index.id)
const { agents } = await request<{ agents: Array<{ id: string }> }>('/api/agents')
const exists = agents.some((agent) => agent.id === agentId)
await request(exists ? `/api/agents/${agentId}` : '/api/agents', exists ? { config } : { id: agentId, config }, exists ? 'PUT' : 'POST')
const questions = args.includes('--extended') ? [...ragQuestions, ...additionalRagQuestions.filter((question) => !question.evidence.length)] : ragQuestions
type Row = { question: RagQuestion; answer?: RagRunResult; error?: string; checks?: { hasSources: boolean; hasCitations: boolean; literalQuotes: boolean; semanticSupport: boolean; clarification: boolean; meetsContract: boolean } }
const rows: Row[] = []
console.log(`Day 24: обычный агент ${agentId}; индекс ${index.id}; ${questions.length} вопросов. Вопросы, фрагменты и ответы отправляются в DeepSeek для генерации и проверки.`)
for (const question of questions) {
  const row: Row = { question }
  rows.push(row)
  try {
    const answer = await request<RagRunResult>(`/api/agents/${agentId}/run`, { input: question.question, conversationId: crypto.randomUUID() }, 'POST')
    row.answer = answer
    const grounding = answer.rag?.grounding
    if (!grounding || answer.rag?.indexRunId !== index.id) throw new Error('Ответ без grounding или от другого индекса.')
    const hasSources = grounding.sources.length > 0
    const hasCitations = grounding.citations.length > 0
    const literalQuotes = hasCitations && grounding.citations.every((citation) => answer.rag!.sources.some((source) => source.chunkId === citation.chunkId && source.source === citation.source && source.section === citation.section && source.text.includes(citation.quote)))
    const semanticSupport = grounding.status === 'answered' && grounding.verification.status === 'passed' && grounding.claims.length > 0
      && grounding.verification.judgments.length === grounding.claims.length && grounding.verification.judgments.every((item) => item.supported)
    const clarification = grounding.status === 'unknown' && grounding.answer.includes('Не знаю') && Boolean(grounding.clarification)
    const meetsContract = question.evidence.length ? grounding.status === 'answered' && hasSources && hasCitations && literalQuotes && semanticSupport
      : grounding.status === 'unknown' && !hasSources && !hasCitations && clarification
    row.checks = { hasSources, hasCitations, literalQuotes, semanticSupport, clarification, meetsContract }
    console.log(`${question.id}: ${grounding.status}; источники ${grounding.sources.length}; цитаты ${grounding.citations.length}; смысл ${semanticSupport ? 'поддержан по оценке LLM' : 'не применяется'}; проверка ${meetsContract ? 'OK' : 'FAIL'}; ${answer.totalTokens} токенов`)
  } catch (error) { row.error = String(error); console.error(`${question.id}: ${row.error}`) }
}
const positives = rows.filter((row) => row.question.evidence.length)
const negatives = rows.filter((row) => !row.question.evidence.length)
const summary = { questions: rows.length, answeredWithoutErrors: rows.filter((row) => !row.error).length,
  positiveQuestions: positives.length, withSources: positives.filter((row) => row.checks?.hasSources).length,
  withCitations: positives.filter((row) => row.checks?.hasCitations).length, literalQuotes: positives.filter((row) => row.checks?.literalQuotes).length,
  semanticSupportByLlm: positives.filter((row) => row.checks?.semanticSupport).length,
  negativeQuestions: negatives.length, correctAbstentions: negatives.filter((row) => row.checks?.meetsContract).length,
  totalTokens: rows.reduce((sum, row) => sum + (row.answer?.totalTokens ?? 0), 0) }
const path = resolve(`data/rag-day24/${crypto.randomUUID()}.json`)
await mkdir(resolve('data/rag-day24'), { recursive: true })
await writeFile(path, JSON.stringify({ createdAt: new Date().toISOString(), index, agentId, config, summary, rows }, null, 2), { flag: 'wx' })
console.log(JSON.stringify(summary, null, 2)); console.log(`Отчёт: ${path}`)
if (rows.some((row) => row.error || !row.checks?.meetsContract)) process.exitCode = 1
