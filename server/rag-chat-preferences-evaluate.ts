import './network-config'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ragChatAgentId } from '../src/rag-chat-config'
import type { DialogueIntent, RagChatMessage, DialogueMemoryState, RetrievalDecision } from '../src/rag-chat-types'
import type { RagResult, RagGrounding } from '../src/rag-types'
import assert from 'node:assert/strict'

// These are test assertions ONLY, never a memory/runtime contract or an agent input.
type ExpectedPresentation = { format?: 'numbered' | 'bullets' | 'paragraphs' | 'table'; maxWords?: number; maxItems?: number; itemCount?: number; language?: string }
function isEnglishAnswer(body: string) {
  // Literal code samples and commands retain their source spelling; check the prose.
  return !/[А-Яа-яЁё]/.test(body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, ''))
}
assert.equal(isEnglishAnswer('Run `rag:search -- "Как устроен поиск?"`.'), true)
assert.equal(isEnglishAnswer('Текст ответа по-русски, хотя `code` на английском.'), false)
function presentationMatches(body: string, expected: ExpectedPresentation = {}) {
  const numbered = body.match(/^\d+\.\s+/gm)?.length ?? 0
  const bullets = body.match(/^[-*+]\s+/gm)?.length ?? 0
  const count = numbered || bullets
  return (!expected.maxWords || body.replace(/\[\d+\]/g, '').split(/\s+/).filter(Boolean).length <= expected.maxWords)
    && (!expected.maxItems || count <= expected.maxItems) && (!expected.itemCount || count === expected.itemCount)
    && (expected.format !== 'numbered' || numbered > 0) && (expected.format !== 'bullets' || bullets > 0 && !numbered)
    && (expected.format !== 'paragraphs' || !count && !/^\s*\|/m.test(body)) && (expected.format !== 'table' || /^\s*\|/m.test(body))
}
type Turn = { input: string; route: DialogueIntent; preferences?: ExpectedPresentation; status?: 'answered' | 'unknown'; goal?: string; term?: string; absentConstraint?: string; requiredConstraints?: string[]; forbiddenWord?: string }
// Expectations stay outside the indexed corpus and are never sent to the agent.
const scenarios: Array<{ id: string; turns: Turn[] }> = [
  { id: 'rag-preferences', turns: [
    { input: 'Привет!', route: 'conversation' },
    { input: 'Отвечай нумерованным списком', route: 'preferences', preferences: { format: 'numbered' } },
    { input: 'Моя цель — подготовить пятиминутную демонстрацию локального RAG для новичков. Новые библиотеки и внешние векторные базы запрещены. Какие две стратегии разбиения документов есть в проекте?', route: 'documents', status: 'answered', preferences: { format: 'numbered' }, goal: 'демонстрац' },
    { input: 'А в чём различие этих стратегий? В этом ответе ровно два пункта.', route: 'documents', status: 'answered', preferences: { format: 'numbered', itemCount: 2 }, goal: 'демонстрац' },
    { input: 'Теперь отвечай обычным текстом, без списков, не более 40 слов.', route: 'preferences', preferences: { format: 'paragraphs', maxWords: 40 }, goal: 'демонстрац' },
    { input: 'А где хранится локальный RAG-индекс?', route: 'documents', status: 'answered', preferences: { format: 'paragraphs', maxWords: 40 }, goal: 'демонстрац' },
    { input: 'Напомни мою исходную цель и действующие ограничения.', route: 'dialogue', status: 'answered', preferences: { format: 'paragraphs', maxWords: 40 }, goal: 'демонстрац' },
    { input: 'Есть ли в проекте возможность генерации картинок?', route: 'documents', status: 'unknown', preferences: { format: 'paragraphs', maxWords: 40 }, goal: 'демонстрац' },
  ] },
  { id: 'scheduler-preferences', turns: [
    { input: 'Моя цель — проверить надёжность фоновых задач проекта. Календарь только для чтения. Отвечай кратко на русском языке. Как предотвращается двойной запуск задачи?', route: 'documents', status: 'answered', goal: 'надёжност' },
    { input: 'Отвечай нумерованным списком, не больше трёх пунктов.', route: 'preferences', preferences: { format: 'numbered', maxItems: 3 }, goal: 'надёжност' },
    { input: 'Что происходит с пропущенными запусками после перезапуска сервера?', route: 'documents', status: 'answered', preferences: { format: 'numbered', maxItems: 3 }, goal: 'надёжност' },
    { input: 'Только для текущего ответа используй маркированный список: что означает RAG в целом, без привязки к проекту?', route: 'general', preferences: { format: 'bullets', maxItems: 3 }, goal: 'надёжност' },
    { input: 'Отменяю ограничение на число пунктов. Теперь отвечай на английском.', route: 'preferences', preferences: { format: 'numbered' }, goal: 'надёжност', absentConstraint: 'трёх' },
    { input: 'Where is the local RAG index stored in this project?', route: 'documents', status: 'answered', preferences: { format: 'numbered' }, goal: 'надёжност' },
    { input: 'Теперь снова по-русски. Зафиксируй: сводка — результат фонового агента, подтверждённый MCP receipt. Подтверди настройки.', route: 'preferences', preferences: { format: 'numbered' }, goal: 'надёжност', term: 'сводка' },
    { input: 'Напомни исходную цель, ограничение на календарь и наше определение сводки.', route: 'dialogue', status: 'answered', preferences: { format: 'numbered' }, goal: 'надёжност', term: 'сводка' },
    { input: 'Now answer in English, using a numbered list with no more than one item.', route: 'preferences', preferences: { format: 'numbered', maxItems: 1, language: 'English' }, goal: 'надёжност' },
    { input: 'Is image generation supported in this project?', route: 'documents', status: 'unknown', preferences: { format: 'numbered', maxItems: 1, language: 'English' }, goal: 'надёжност' },
  ] },
  { id: 'preference-retention', turns: [
    { input: 'Отвечай кратко на английском, нумерованным списком.', route: 'preferences', preferences: { format: 'numbered', language: 'English' }, requiredConstraints: ['кратк|brief|concise', 'англий|english', 'нумер|numbered'] },
    { input: 'Дополнительно: теперь не более одного пункта в каждом ответе.', route: 'preferences', preferences: { format: 'numbered', maxItems: 1, language: 'English' }, requiredConstraints: ['кратк|brief|concise', 'англий|english', 'нумер|numbered', 'один|одного|one|1'] },
    { input: 'Что означает RAG в общем, без привязки к нашему проекту?', route: 'general', preferences: { format: 'numbered', maxItems: 1, language: 'English' }, requiredConstraints: ['кратк|brief|concise', 'англий|english', 'нумер|numbered', 'один|одного|one|1'] },
  ] },
]
const brevityProbe: Array<{ id: string; turns: Turn[] }> = [{ id: 'brevity-schema-probe', turns: [
  { input: 'Мне нужно приготовить демонстрацию локального rag для новичков. Нельзя использовать новые библиотеки и векторные БД, какие две стратегии разбиения документов есть в нашем проекте? Отвечай кратко', route: 'documents', status: 'answered', goal: 'демонстрац', requiredConstraints: ['кратк|brief|concise', 'нов.*библиотек', 'векторн.*(бд|баз)'] },
  { input: 'А чем эти две стратегии отличаются?', route: 'documents', status: 'answered', goal: 'демонстрац', requiredConstraints: ['кратк|brief|concise', 'нов.*библиотек', 'векторн.*(бд|баз)'] },
] }]
const flexibleScenarios: Array<{ id: string; turns: Turn[] }> = [
  { id: 'free-layout', turns: [
    { input: 'Моя цель — показать локальный RAG новичку. Не используй слово «очевидно». Объясняй для новичка. Постоянный формат: сначала суть одним предложением, затем таблица с двумя столбцами «Стратегия» и «Граница чанка». Какие две стратегии разбиения документов есть в нашем проекте?', route: 'documents', status: 'answered', preferences: { format: 'table' }, goal: 'rag', requiredConstraints: ['очевидно', 'нович', 'таблиц'], forbiddenWord: 'очевидно' },
    { input: 'Только для этого ответа вместо таблицы используй маркированный список, по одной короткой строке на пункт. Где хранится локальный индекс?', route: 'documents', status: 'answered', preferences: { format: 'bullets' }, goal: 'rag', requiredConstraints: ['очевидно', 'таблиц'], forbiddenWord: 'очевидно' },
    { input: 'Теперь замени постоянное правило про таблицу: отвечай двумя короткими абзацами без списка. Остальные пожелания оставь. Чем fixed отличается от structured?', route: 'documents', status: 'answered', preferences: { format: 'paragraphs' }, goal: 'rag', absentConstraint: 'таблиц', requiredConstraints: ['очевидно', 'нович', 'абзац'], forbiddenWord: 'очевидно' },
    { input: 'Напомни цель и мои текущие пожелания. Само запрещённое слово можешь процитировать только в этом ответе.', route: 'dialogue', status: 'answered', preferences: { format: 'paragraphs' }, goal: 'rag', requiredConstraints: ['очевидно', 'нович', 'абзац'] },
    { input: 'Для всех следующих ответов одновременно давай ровно два пункта и ровно три пункта.', route: 'clarification', goal: 'rag', requiredConstraints: ['очевидно', 'абзац'] },
  ] },
  { id: 'free-language', turns: [
    { input: 'Зафиксируй цель: разобраться, как работает локальный поиск. Отвечай на английском; начинай информационные ответы с метафоры; без эмодзи.', route: 'preferences', preferences: { language: 'English' }, goal: 'поиск', requiredConstraints: ['англий|english', 'метафор|metaphor', 'эмодзи|emoji'] },
    { input: 'Объясни в общем, что такое RAG, без привязки к проекту. Только сейчас ответь по-русски двумя предложениями.', route: 'general', goal: 'поиск', requiredConstraints: ['англий|english', 'метафор|metaphor', 'эмодзи|emoji'] },
    { input: 'Теперь отмени только правило про метафору. Остальные пожелания и цель оставь.', route: 'preferences', preferences: { language: 'English' }, goal: 'поиск', absentConstraint: 'метафор', requiredConstraints: ['англий|english', 'эмодзи|emoji'] },
    { input: 'Как осуществляется поиск по локальному индексу в этом проекте?', route: 'documents', status: 'answered', preferences: { language: 'English' }, goal: 'поиск', requiredConstraints: ['англий|english', 'эмодзи|emoji'] },
    { input: 'Напомни цель разговора и мои действующие пожелания.', route: 'dialogue', status: 'answered', preferences: { language: 'English' }, goal: 'поиск', requiredConstraints: ['англий|english', 'эмодзи|emoji'] },
  ] },
]
type Answer = { output: string; error?: string; rag?: RagResult; grounding?: RagGrounding; dialogueMemory?: DialogueMemoryState; replyInstructions?: Array<{ text: string }>; retrieval?: RetrievalDecision; totalTokens?: number }
type Row = { scenario: string; step: number; input: string; answer?: Answer; error?: string; checks?: Record<string, boolean> }
type Report = { id: string; calls: number; conversations: Record<string, string>; rows: Row[]; totalTokens: number; mode?: 'flexible' | 'brevity' | 'legacy' }
const args = process.argv.slice(2)
const probe = args.length === 1 && args[0] === '--probe-brevity'
const flexible = args.length === 1 && args[0] === '--flexible'
const extraTwo = args.length === 3 && args[2] === '--extra-two-approved'
const resume = (args.length === 2 || extraTwo) && args[0] === '--resume' && /^data\/rag-day25\/preferences-[\w-]+\.json$/.test(args[1])
if (args.length && !probe && !resume && !flexible) throw new Error('Параметры: --flexible (до 12 сообщений), --probe-brevity или --resume data/rag-day25/preferences-<uuid>.json')
const report: Report = resume ? JSON.parse(await readFile(resolve(args[1]), 'utf8')) : { id: crypto.randomUUID(), calls: 0, conversations: {}, rows: [], totalTokens: 0, mode: flexible ? 'flexible' : probe ? 'brevity' : 'legacy' }
const path = resume ? args[1] : `data/rag-day25/preferences-${report.id}.json`
if (extraTwo && report.mode !== 'flexible') throw new Error('Дополнительные два сообщения разрешены только для прежнего flexible-прогона.')
const maxCalls = report.mode === 'flexible' ? extraTwo ? 14 : 12 : report.mode === 'brevity' ? 2 : 20
const base = `http://127.0.0.1:8787/api/agents/${ragChatAgentId}`
await mkdir(resolve('data/rag-day25'), { recursive: true })
const save = () => writeFile(resolve(path), JSON.stringify(report, null, 2))
// Recheck stored output locally after fixing a false-positive language assertion.
// This never rewrites model output or submits a repeat paid message.
if (resume) {
  for (const row of report.rows) {
    if (!row.answer || row.checks?.language !== false) continue
    const grounding = row.answer.grounding ?? row.answer.rag?.grounding
    const body = grounding ? [grounding.answer, grounding.clarification].filter(Boolean).join('\n\n') : row.answer.output
    row.checks.language = isEnglishAnswer(body)
    if (Object.values(row.checks).every(Boolean)) delete row.error
  }
  await save()
}
async function history(conversationId: string) {
  const response = await fetch(`${base}/history?conversationId=${conversationId}`)
  if (!response.ok) throw new Error(`История: HTTP ${response.status}`)
  return await response.json() as { messages: RagChatMessage[]; count: number }
}
for (const scenario of report.mode === 'flexible' ? flexibleScenarios : report.mode === 'brevity' ? brevityProbe : scenarios) {
  const conversationId = report.conversations[scenario.id] ??= `day25-${scenario.id}-${crypto.randomUUID()}`
  for (const [offset, turn] of scenario.turns.entries()) {
    if (report.rows.some((row) => row.scenario === scenario.id && row.step === offset + 1 && row.checks && Object.values(row.checks).every(Boolean))) continue
    if (report.calls >= maxCalls) throw new Error(`Достигнут согласованный предел ${maxCalls} сообщений. Дополнительные вызовы требуют нового разрешения.`)
    const before = await history(conversationId)
    const row: Row = { scenario: scenario.id, step: offset + 1, input: turn.input }
    report.rows.push(row); report.calls++; await save() // Reserve the call even if the request or process fails.
    try {
      const response = await fetch(`${base}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: turn.input, conversationId }), signal: AbortSignal.timeout(360_000) })
      const answer = await response.json() as Answer
      row.answer = answer
      report.totalTokens += answer.totalTokens ?? 0
      if (!response.ok) throw new Error(answer.error ?? `HTTP ${response.status}`)
      const after = await history(conversationId)
      const grounding = answer.grounding ?? answer.rag?.grounding
      const body = grounding ? [grounding.answer, grounding.clarification].filter(Boolean).join('\n\n') : answer.output
      const memory = answer.dialogueMemory!
      const users = after.messages.filter((message) => message.role === 'user')
      row.checks = {
        route: answer.retrieval?.route === turn.route,
        search: answer.retrieval?.searched === (turn.route === 'documents'),
        saved: after.count === before.count + 2 && JSON.stringify(after.messages[after.count - 1].dialogueMemory) === JSON.stringify(memory),
        format: presentationMatches(body, turn.preferences),
        language: turn.preferences?.language !== 'English' || isEnglishAnswer(body),
        status: turn.status ? grounding?.status === turn.status : !grounding && !/не знаю|(?:do not|don't) know/i.test(answer.output),
        support: grounding?.status !== 'answered' || grounding.verification.status === 'passed' && Boolean(grounding.verification.taskCheck?.constraintsRespected),
        goal: !turn.goal || Boolean(memory.goal?.text.toLowerCase().includes(turn.goal)),
        term: !turn.term || memory.terms.some((item) => item.text.toLowerCase().includes(turn.term!)),
        cancellation: !turn.absentConstraint || !memory.constraints.some((item) => item.text.toLowerCase().includes(turn.absentConstraint!)),
        independentSettings: (turn.requiredConstraints ?? []).every((pattern) => memory.constraints.some((item) => new RegExp(pattern, 'i').test(item.text))),
        forbiddenWord: !turn.forbiddenWord || !body.toLowerCase().includes(turn.forbiddenWord.toLowerCase()),
        literalQuotes: !grounding || grounding.status === 'unknown' ? !grounding?.citations.length : grounding.citations.length > 0 && grounding.citations.every((citation) => citation.kind === 'dialogue' ? users[Number(citation.chunkId.match(/^dialogue-user-(\d+)/)?.[1]) - 1]?.content.includes(citation.quote) : answer.rag?.sources.some((source) => source.chunkId === citation.chunkId && source.text.includes(citation.quote))),
      }
      console.log(JSON.stringify({ call: report.calls, scenario: scenario.id, step: offset + 1, output: body, constraints: memory.constraints.map((item) => item.text), currentInstructions: answer.replyInstructions, route: answer.retrieval, checks: row.checks }))
      await save()
      if (Object.values(row.checks).some((passed) => !passed)) throw new Error('Проверка ответа не пройдена: исправьте причину и продолжите с --resume.')
    } catch (error) { row.error = String(error); await save(); console.error(JSON.stringify({ report: path, calls: report.calls, error: row.error })); process.exitCode = 1; process.exit() }
  }
}
console.log(JSON.stringify({ report: path, calls: report.calls, totalTokens: report.totalTokens, completed: true }))
