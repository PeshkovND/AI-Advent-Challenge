import './network-config'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ragChatAgentConfig, ragChatAgentId } from '../src/rag-chat-config'
import { ragChatScenarios } from '../src/rag-chat-scenarios'
import type { DialogueMemoryState, RagChatMessage, RetrievalDecision } from '../src/rag-chat-types'
import type { RagGrounding, RagResult } from '../src/rag-types'

const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--scenario' || !ragChatScenarios.some((scenario) => scenario.id === args[1]))) throw new Error('Параметры: --scenario rag-demo|scheduler-review; по умолчанию оба сценария.')
const scenarios = args.length ? ragChatScenarios.filter((scenario) => scenario.id === args[1]) : ragChatScenarios
async function request<T>(path: string, body?: unknown, method = 'GET'): Promise<T> {
  const response = await fetch(`http://127.0.0.1:8787${path}`, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(360_000) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
  return data as T
}
type Answer = { output: string; rag?: RagResult; grounding?: RagGrounding; retrieval?: RetrievalDecision; dialogueMemory: DialogueMemoryState; resolvedQuestion: string; totalTokens: number }
type Row = { scenario: string; turn: number; input: string; expected: string; expectedSources: string[]; answer?: Answer; error?: string; checks?: Record<string, boolean> }
const { index } = await request<{ index: { id: string } | null }>('/api/rag/index')
if (!index) throw new Error('Локальный индекс пуст.')
const config = ragChatAgentConfig(index.id)
const { agents } = await request<{ agents: Array<{ id: string; config: typeof config }> }>('/api/agents')
const existing = agents.find((agent) => agent.id === ragChatAgentId)
if (!existing) await request('/api/agents', { id: ragChatAgentId, config }, 'POST')
else if (JSON.stringify(existing.config) !== JSON.stringify(config)) {
  // Never silently change a configured chat or move its old conversations to another index.
  if (!existing.config.dialogueMemory?.enabled || !existing.config.rag?.grounding?.enabled || existing.config.rag.indexRunId !== index.id) throw new Error('Агент чата имеет несовместимый конфиг. Проверьте его перед прогоном.')
}
const id = crypto.randomUUID()
const path = resolve(`data/rag-day25/${id}.json`)
await mkdir(resolve('data/rag-day25'), { recursive: true })
const rows: Row[] = []
const conversations: Array<{ scenario: string; conversationId: string }> = []
async function save(completed = false) {
  await writeFile(path, JSON.stringify({ id, createdAt, completed, index, agentId: ragChatAgentId, config: existing?.config ?? config, conversations, summary: {
    turns: rows.length, errors: rows.filter((row) => row.error).length,
    answered: rows.filter((row) => (row.answer?.grounding ?? row.answer?.rag?.grounding)?.status === 'answered').length,
    goalPreserved: rows.filter((row) => row.checks?.goalPreserved).length,
    withSources: rows.filter((row) => (row.answer?.grounding ?? row.answer?.rag?.grounding)?.sources.length).length,
    literalQuotes: rows.filter((row) => row.checks?.literalQuotes).length,
    checksPassed: rows.filter((row) => row.checks && Object.values(row.checks).every(Boolean)).length,
    totalTokens: rows.reduce((sum, row) => sum + (row.answer?.totalTokens ?? 0), 0),
  }, rows }, null, 2))
}
const createdAt = new Date().toISOString()
console.log(`Day 25: ${scenarios.length} сценария по 12 вопросов. Обычный API агента ${ragChatAgentId}; индекс ${index.id}. Отчёт: ${path}`)
for (const scenario of scenarios) {
  const conversationId = `day25-${scenario.id}-${crypto.randomUUID()}`
  conversations.push({ scenario: scenario.id, conversationId })
  console.log(`Сценарий: ${scenario.title}; conversationId=${conversationId}`)
  for (const [offset, turn] of scenario.turns.entries()) {
    const row: Row = { scenario: scenario.id, turn: offset + 1, input: turn.input, expected: turn.expected, expectedSources: turn.sources }
    rows.push(row)
    try {
      const answer = await request<Answer>(`/api/agents/${ragChatAgentId}/run`, { input: turn.input, conversationId }, 'POST')
      row.answer = answer
      const { messages, dialogueMemory } = await request<{ messages: RagChatMessage[]; dialogueMemory: DialogueMemoryState }>(`/api/agents/${ragChatAgentId}/history?conversationId=${conversationId}`)
      const grounding = answer.grounding ?? answer.rag?.grounding
      const facts = [answer.dialogueMemory.goal, ...answer.dialogueMemory.clarifications, ...answer.dialogueMemory.constraints, ...answer.dialogueMemory.terms].filter((item) => item !== undefined)
      const users = messages.filter((message) => message.role === 'user')
      const constraintText = answer.dialogueMemory.constraints.map((item) => item.text.toLowerCase()).join('\n')
      const acknowledgement = turn.preferencesOnly && answer.retrieval?.policy === 'auto'
      row.checks = {
        historySaved: messages.length === (offset + 1) * 2 && JSON.stringify(dialogueMemory) === JSON.stringify(answer.dialogueMemory),
        appropriateRetrieval: answer.retrieval?.policy === 'auto'
          ? acknowledgement ? answer.retrieval.route === 'preferences' && !answer.retrieval.searched && !answer.rag : turn.dialogueOnly ? answer.retrieval.route === 'dialogue' && !answer.retrieval.searched && !answer.rag : answer.retrieval.route === 'documents' && answer.retrieval.searched && Boolean(answer.rag?.trace)
          : Boolean(answer.rag?.trace && answer.resolvedQuestion),
        goalPreserved: Boolean(answer.dialogueMemory.goal?.text.toLowerCase().includes(scenario.goal)),
        memoryProvenance: facts.every((item) => users[item.userTurn - 1]?.content.includes(item.quote)),
        refinementsPreserved: (turn.memoryTerms ?? []).every((term) => facts.some((item) => item.text.toLowerCase().includes(term.toLowerCase()))),
        supersededConstraintsRemoved: (turn.absentConstraints ?? []).every((constraint) => !constraintText.includes(constraint)),
        sourcesAppropriate: acknowledgement ? !grounding : Boolean(grounding?.sources.length && grounding.citations.length),
        correctSourceKind: acknowledgement ? !grounding : Boolean(grounding?.citations.some((citation) => turn.dialogueOnly || turn.preferencesOnly ? citation.kind === 'dialogue' : citation.kind !== 'dialogue')),
        literalQuotes: acknowledgement ? !grounding : Boolean(grounding?.citations.length && grounding.citations.every((citation) => citation.kind === 'dialogue'
          ? users[Number(citation.chunkId.match(/^dialogue-user-(\d+)/)?.[1]) - 1]?.content.includes(citation.quote)
          : answer.rag?.sources.some((source) => source.chunkId === citation.chunkId && source.source === citation.source && source.text.includes(citation.quote)))),
        semanticSupportByLlm: acknowledgement ? !/не знаю/i.test(answer.output) : Boolean(grounding?.status === 'answered' && grounding.verification.status === 'passed' && grounding.verification.judgments.length === grounding.claims.length && grounding.verification.judgments.every((item) => item.supported)),
        taskCheckByLlm: acknowledgement ? Boolean(answer.output.trim()) : Boolean(grounding?.verification.taskCheck?.goalAligned && grounding.verification.taskCheck?.constraintsRespected && grounding.verification.taskCheck?.answersQuestion),
      }
      const failed = Object.entries(row.checks).filter(([, passed]) => !passed).map(([name]) => name)
      console.log(`${scenario.id} ${offset + 1}/12: ${grounding?.status}; ${grounding?.citations.length ?? 0} цитат; ${failed.length ? `FAIL ${failed.join(', ')}` : 'OK'}; ${answer.totalTokens} токенов`)
    } catch (cause) {
      row.error = String(cause)
      console.error(`${scenario.id} ${offset + 1}/12: ${row.error}`)
      // Continuing would test a different conversation than the specified scenario.
      await save(); break
    }
    await save()
  }
}
await save(rows.length === scenarios.reduce((sum, scenario) => sum + scenario.turns.length, 0) && rows.every((row) => !row.error))
console.log(`Готово. Полные ответы, ожидания, память, цитаты и проверки: ${path}`)
if (rows.some((row) => row.error || !row.checks || Object.values(row.checks).some((passed) => !passed))) process.exitCode = 1
