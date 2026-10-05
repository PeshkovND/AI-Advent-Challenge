import './network-config'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ragChatScenarios } from '../src/rag-chat-scenarios'
import { ragChatAgentId } from '../src/rag-chat-config'
import type { DialogueMemoryState } from '../src/rag-chat-types'
import type { RagGrounding, RagResult } from '../src/rag-types'

const reportPath = process.argv[2]
if (!reportPath || process.argv.length !== 3) throw new Error('Передайте путь к отчёту двух сценариев Day 25.')
const previous = JSON.parse(await readFile(resolve(reportPath), 'utf8')) as { agentId: string; conversations: Array<{ scenario: string; conversationId: string }> }
if (previous.agentId !== ragChatAgentId) throw new Error('Это не отчёт RAG-чата Day 25.')
const conversationId = previous.conversations.find((item) => item.scenario === 'scheduler-review')?.conversationId
if (!conversationId || !/^[\w-]{1,120}$/.test(conversationId)) throw new Error('В отчёте нет корректного диалога фоновых задач.')
const scenario = ragChatScenarios.find((item) => item.id === 'scheduler-review')!
type Answer = { output: string; rag?: RagResult; grounding?: RagGrounding; dialogueMemory: DialogueMemoryState; totalTokens: number }
const rows: Array<{ question: string; expected: string; answer: Answer; passed: boolean }> = []
for (const [index, turn] of scenario.turns.slice(-2).entries()) {
  const response = await fetch(`http://127.0.0.1:8787/api/agents/${ragChatAgentId}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: turn.input, conversationId }), signal: AbortSignal.timeout(360_000) })
  const answer = await response.json() as Answer & { error?: string }
  if (!response.ok) throw new Error(answer.error ?? `HTTP ${response.status}`)
  const grounding = answer.grounding ?? answer.rag?.grounding
  if (!grounding) throw new Error('Для вопроса сценария ожидается ответ с проверяемыми цитатами.')
  const task = grounding.verification.taskCheck
  const passed = grounding.status === 'answered' && Boolean(task?.goalAligned && task.constraintsRespected && task.answersQuestion)
    && Boolean(grounding.citations.length) && Boolean(answer.dialogueMemory.goal?.text.toLowerCase().includes(scenario.goal))
    && (index !== 0 || grounding.claims.length === 3)
  rows.push({ question: turn.input, expected: turn.expected, answer, passed })
  console.log(`${index + 1}/2: ${grounding.status}; ${grounding.claims.length} пунктов; цель: ${answer.dialogueMemory.goal?.text}; taskCheck: ${JSON.stringify(task)}; ${passed ? 'OK' : 'FAIL'}`)
}
const path = resolve(`data/rag-day25/task-probe-${crypto.randomUUID()}.json`)
await writeFile(path, JSON.stringify({ createdAt: new Date().toISOString(), reportPath, conversationId, rows, totalTokens: rows.reduce((sum, row) => sum + row.answer.totalTokens, 0) }, null, 2), { flag: 'wx' })
console.log(`Отчёт двух дополнительных проверок: ${path}`)
if (rows.some((row) => !row.passed)) process.exitCode = 1
