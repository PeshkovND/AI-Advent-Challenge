import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ragQuestions, type RagEvidence } from './rag-questions'

type RagSource = { source: string; title: string; section: string; chunkId: string; strategy: 'fixed' | 'structured'; score: number; text: string }
type RunResult = { output: string; durationMs: number; model: string; promptTokens?: number; rag?: { indexRunId: string; sources: RagSource[] } }
type AgentSummary = { id: string; config: { name?: string; model: string; provider: string; temperature?: number; systemPrompt?: string; rag?: { enabled: boolean; strategy: string; topK: number } } }
type Mode = 'without' | 'structured' | 'fixed'
type Comparison = Partial<Record<Mode, RunResult>> & { errors?: Partial<Record<Mode, string>> }

const model = 'deepseek-v4-flash'
const agentIds: Record<Mode, string> = { without: 'day22-without-rag', structured: 'day22-with-rag', fixed: 'day22-with-rag-fixed' }
const modes: Mode[] = ['without', 'structured', 'fixed']
const commonConfig = {
  provider: 'deepseek', model, temperature: 0,
  systemPrompt: 'Отвечай кратко и по существу, используя доступные сведения и общие знания. Если вопрос касается конкретного проекта, а сведений о его реализации нет, всё равно объясни типичный подход, но явно отдели его от неподтверждённых деталей этого проекта. Не выдавай предположения за факты.',
}

async function readError(response: Response) {
  try { return ((await response.json()) as { error?: string }).error || `HTTP ${response.status}` } catch { return `HTTP ${response.status}` }
}

export default function RagPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [results, setResults] = useState<Record<number, Comparison>>({})
  const [busy, setBusy] = useState(false)
  const [progressId, setProgressId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const plainAgent = agents.find((agent) => agent.id === agentIds.without)
  const structuredAgent = agents.find((agent) => agent.id === agentIds.structured)
  const fixedAgent = agents.find((agent) => agent.id === agentIds.fixed)
  const agentReady = (agent: AgentSummary | undefined, strategy?: 'structured' | 'fixed') => Boolean(agent
    && agent.config.provider === commonConfig.provider
    && agent.config.model === model
    && agent.config.temperature === 0
    && agent.config.systemPrompt === commonConfig.systemPrompt
    && (strategy
      ? agent.config.rag?.enabled && agent.config.rag.strategy === strategy && agent.config.rag.topK === 4
      : !agent.config.rag?.enabled))
  const agentsReady = agentReady(plainAgent) && agentReady(structuredAgent, 'structured') && agentReady(fixedAgent, 'fixed')

  useEffect(() => { void loadAgents() }, [])

  async function loadAgents() {
    try {
      const response = await fetch('/api/agents')
      if (!response.ok) throw new Error(await readError(response))
      const data = await response.json() as { agents: AgentSummary[] }
      setAgents(data.agents)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось загрузить агентов.') }
  }

  async function createAgents() {
    setBusy(true)
    setError(null)
    try {
      for (const [id, config] of [
        [agentIds.without, { ...commonConfig, name: 'Day 22 · без RAG' }],
        [agentIds.structured, { ...commonConfig, name: 'Day 22 · RAG structured', rag: { enabled: true, strategy: 'structured', topK: 4 } }],
        [agentIds.fixed, { ...commonConfig, name: 'Day 22 · RAG fixed', rag: { enabled: true, strategy: 'fixed', topK: 4 } }],
      ] as const) {
        const existing = agents.some((agent) => agent.id === id)
        const response = await fetch(existing ? `/api/agents/${id}` : '/api/agents', {
          method: existing ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(existing ? { config } : { id, config }),
        })
        if (!response.ok) throw new Error(await readError(response))
      }
      setResults({})
      await loadAgents()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось создать или обновить агентов.') }
    finally { setBusy(false) }
  }

  async function runOne(input: string): Promise<Comparison> {
    const conversationId = crypto.randomUUID()
    const ask = async (agentId: string): Promise<RunResult> => {
      const response = await fetch(`/api/agents/${agentId}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, conversationId }),
      })
      if (!response.ok) throw new Error(`${agentId}: ${await readError(response)}`)
      return await response.json() as RunResult
    }
    const outcomes = await Promise.allSettled(modes.map((mode) => ask(agentIds[mode])))
    const comparison: Comparison = {}
    outcomes.forEach((outcome, index) => {
      const mode = modes[index]
      if (outcome.status === 'fulfilled') comparison[mode] = outcome.value
      else (comparison.errors ??= {})[mode] = String(outcome.reason)
    })
    return comparison
  }

  async function runAll() {
    if (!agentsReady || busy) return
    setBusy(true)
    setError(null)
    setResults({})
    try {
      for (const item of ragQuestions) {
        setProgressId(item.id)
        try {
          const result = await runOne(item.question)
          setResults((current) => ({ ...current, [item.id]: result }))
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'Не удалось получить ответы.'
          setResults((current) => ({ ...current, [item.id]: { errors: { without: message, structured: message, fixed: message } } }))
        }
      }
    } finally { setProgressId(null); setBusy(false) }
  }

  async function clearAgents() {
    if (!plainAgent || !structuredAgent || !fixedAgent || busy || !window.confirm('Очистить историю трёх агентов Day 22 и результаты на странице? Конфигурации агентов и RAG-индекс сохранятся.')) return
    setBusy(true)
    setError(null)
    try {
      const responses = await Promise.all(modes.map(async (mode) => {
        const id = agentIds[mode]
        const response = await fetch(`/api/agents/${id}/history/all`, { method: 'DELETE' })
        return response.ok ? null : `${id}: ${await readError(response)}`
      }))
      const failures = responses.filter((message): message is string => message !== null)
      if (failures.length) throw new Error(failures.join(' · '))
      setResults({})
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось очистить агентов.') }
    finally { setBusy(false) }
  }

  function downloadResults() {
    const report = ragQuestions.map((item) => ({ ...item, result: results[item.id] ?? null }))
    const blob = new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), agents: agentIds, model, questions: report }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'day-22-rag-comparison.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  return <div className="page-view rag-page">
    <header className="page-header"><div><p className="eyebrow">День 22 · первый RAG-запрос</p><h1>Ответ с документами и без них</h1><p className="header-description">Три обычных агента с одной моделью и одинаковыми настройками: без RAG, с RAG structured и с RAG fixed. Все получают вопрос через стандартный маршрут агента.</p></div></header>
    {error && <div className="error-message" role="alert">{error}</div>}
    <section className="rag-panel"><div className="section-heading"><div><span className="step-number">01</span><div><p className="eyebrow">Агенты</p><h2>Три режима для сравнения</h2></div></div></div>
      <div className="rag-agent-pair"><div><strong>{agentIds.without}</strong><span>RAG выключен · {plainAgent?.config.model ?? model}</span></div><div><strong>{agentIds.structured}</strong><span>RAG · structured · top 4 · {structuredAgent?.config.model ?? model}</span></div><div><strong>{agentIds.fixed}</strong><span>RAG · fixed · top 4 · {fixedAgent?.config.model ?? model}</span></div></div>
      <button className="compare-button" type="button" disabled={busy || agentsReady} onClick={() => void createAgents()}>{agentsReady ? 'Агенты готовы' : 'Создать или обновить агентов через /api/agents'} <span>→</span></button>
      {modes.some((mode) => { const agent = agents.find((item) => item.id === agentIds[mode]); return agent && !agentReady(agent, mode === 'without' ? undefined : mode) }) && <p className="rag-note">Нажмите кнопку выше, чтобы обновить конфигурации существующих агентов Day 22. Их история при этом сохранится.</p>}
    </section>
    <section className="rag-panel"><div className="section-heading"><div><span className="step-number">02</span><div><p className="eyebrow">Контрольный набор</p><h2>10 вопросов · ожидаемое и фактическое</h2></div></div><span className="same-prompt">{Object.keys(results).length}/10 обработано</span></div>
      <p className="rag-note">При запуске вопросы отправляются в DeepSeek API; для ответов с RAG туда также передаются найденные фрагменты документов.</p>
      <div className="rag-toolbar"><button className="compare-button" type="button" disabled={!agentsReady || busy} onClick={() => void runAll()}>{busy ? `Вопрос ${progressId} из ${ragQuestions.length}…` : Object.keys(results).length ? 'Запустить все 10 заново' : 'Получить ответы на все 10 вопросов'} <span>→</span></button><button className="secondary-button" type="button" disabled={busy || Object.keys(results).length === 0} onClick={downloadResults}>Скачать результаты JSON</button><button className="clear-context-button" type="button" disabled={busy || !plainAgent || !structuredAgent || !fixedAgent} onClick={() => void clearAgents()}>Очистить тесты агентов</button></div>
      <div className="rag-question-list">{ragQuestions.map((item) => {
        const comparison = results[item.id]
        return <article className="rag-question-card" key={item.id}>
          <div className="rag-question-heading"><h3>{item.id}. {item.question}</h3><small>{progressId === item.id ? 'Выполняется…' : comparison?.errors ? 'Есть ошибка' : comparison ? 'Ответы получены' : 'Ожидает запуска'}</small></div>
          <div className="rag-comparison-grid">
            <div className="rag-expected"><h4>Ожидаемый результат</h4><p>{item.expected}</p><strong>Ожидаемые источники</strong><div className="rag-source-tags">{item.sources.length ? item.sources.map((source) => <code key={source}>{source}</code>) : 'Не требуются'}</div><details className="rag-expected-evidence"><summary>Фрагменты с ответом</summary><ul>{item.evidence.map((evidence) => <li key={`${evidence.source}:${evidence.quote}`}><code>{evidence.source}</code> — {evidence.quote}{evidence.alternatives?.map((alternative) => <span key={`${alternative.source}:${alternative.quote}`}><br />или <code>{alternative.source}</code> — {alternative.quote}</span>)}</li>)}</ul></details></div>
            <RagAnswer title="Без RAG" result={comparison?.without} error={comparison?.errors?.without} />
            <RagAnswer title="RAG · structured" result={comparison?.structured} error={comparison?.errors?.structured} evidence={item.evidence} />
            <RagAnswer title="RAG · fixed" result={comparison?.fixed} error={comparison?.errors?.fixed} evidence={item.evidence} />
          </div>
        </article>
      })}</div>
    </section>
  </div>
}

function RagAnswer({ title, result, error, evidence }: { title: string; result?: RunResult; error?: string; evidence?: RagEvidence[] }) {
  const sources = result?.rag?.sources
  const evidenceCount = evidence && sources ? evidence.filter((item) => sources.some((source) => [item, ...(item.alternatives ?? [])].some((candidate) => source.source === candidate.source && source.text.includes(candidate.quote)))).length : null
  return <div className="rag-answer"><h4>{title}</h4>{result ? <><small>{result.model} · {result.durationMs} мс · prompt {result.promptTokens ?? '—'} токенов</small>{evidenceCount !== null && <small className={evidenceCount === evidence?.length ? 'rag-evidence-hit' : 'rag-evidence-miss'}>Контрольные фрагменты в поиске: {evidenceCount}/{evidence?.length}</small>}<div className="rag-answer-text"><ReactMarkdown remarkPlugins={[remarkGfm]}>{result.output}</ReactMarkdown></div>{result.rag && <details><summary>Найденные источники ({result.rag.sources.length})</summary><div className="rag-sources">{result.rag.sources.map((source, index) => <div key={source.chunkId}><strong>[{index + 1}] {source.source} · {source.section}</strong><small>score {source.score.toFixed(3)} · {source.chunkId}</small><p>{source.text}</p></div>)}</div></details>}</> : <p className={error ? 'rag-answer-error' : 'rag-answer-empty'}>{error ?? 'Ответ появится после запуска.'}</p>}</div>
}
