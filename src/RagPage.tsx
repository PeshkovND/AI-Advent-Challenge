import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ragQuestions, type RagEvidence } from './rag-questions'
import { demoModes, demoAgentIds, demoLabels, demoAgentConfig, restoreDemoReport, type DemoSnapshot } from './rag-demo-config'
import { listRagReports, loadDemoSnapshot, saveDemoSnapshot, type RagRunResult } from './rag-report-store'
import { parseRagReport } from './rag-report-import'

type AgentSummary = { id: string; config: Record<string, unknown> }
type IndexInfo = { id: string; strategies: string[] }
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error || `HTTP ${response.status}`)
  }
  return response.status === 204 ? undefined as T : await response.json() as T
}
const post = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
function sameConfig(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  const meaningful = (config: Record<string, unknown>): unknown[] => Object.entries(config).filter(([key, value]) => key !== 'name' && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value && typeof value === 'object' && !Array.isArray(value) ? meaningful(value as Record<string, unknown>) : value])
  return JSON.stringify(meaningful(actual)) === JSON.stringify(meaningful(expected))
}

export default function RagPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [index, setIndex] = useState<IndexInfo | null>(null)
  const [snapshot, setSnapshot] = useState<DemoSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [progressId, setProgressId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [storageWarning, setStorageWarning] = useState<string | null>(null)
  const results = snapshot?.results ?? {}
  const allAgentsExist = demoModes.every((mode) => agents.some((agent) => agent.id === demoAgentIds[mode]))
  const agentsReady = Boolean(index?.strategies.includes('fixed') && index.strategies.includes('structured') && demoModes.every((mode) => {
    const agent = agents.find((item) => item.id === demoAgentIds[mode])
    return agent && sameConfig(agent.config, demoAgentConfig(mode, index.id))
  }))

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const saved = await loadDemoSnapshot()
        const restored = saved ?? restoreDemoReport((await listRagReports()).flatMap((report) => {
          try { return [parseRagReport(JSON.stringify(report))] } catch { return [] }
        }))
        if (active && restored) setSnapshot(restored)
        if (!saved && restored) await saveDemoSnapshot(restored)
      } catch { if (active) setStorageWarning('Хранилище браузера недоступно. Сохраните результаты в JSON до обновления страницы.') }
      finally { if (active) setLoading(false) }
    })()
    void refresh().catch((cause) => { if (active) setError(String(cause)) })
    return () => { active = false }
  }, [])

  async function refresh() {
    const [agentData, indexData] = await Promise.all([request<{ agents: AgentSummary[] }>('/api/agents'), request<{ index: IndexInfo | null }>('/api/rag/index')])
    setAgents(agentData.agents); setIndex(indexData.index)
  }
  async function persist(next: DemoSnapshot) {
    setSnapshot(next)
    try { await saveDemoSnapshot(next); setStorageWarning(null) }
    catch { setStorageWarning('Не удалось сохранить результаты в браузере. Скачайте JSON до обновления страницы.') }
  }
  async function createAgents() {
    if (!index || busy || loading) return
    setBusy(true); setError(null)
    try {
      const current = await request<{ agents: AgentSummary[] }>('/api/agents')
      for (const mode of demoModes) {
        const id = demoAgentIds[mode], config = demoAgentConfig(mode, index.id)
        const exists = current.agents.some((agent) => agent.id === id)
        await request(exists ? `/api/agents/${id}` : '/api/agents', post(exists ? { config } : { id, config }, exists ? 'PUT' : 'POST'))
      }
      await refresh()
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }
  async function runAll() {
    if (!agentsReady || !index || busy || loading) return
    setBusy(true); setError(null)
    let next: DemoSnapshot = { createdAt: new Date().toISOString(), indexRunId: index.id, results: {} }
    try {
      const current = await request<{ agents: AgentSummary[] }>('/api/agents')
      if (!demoModes.every((mode) => { const agent = current.agents.find((item) => item.id === demoAgentIds[mode]); return agent && sameConfig(agent.config, demoAgentConfig(mode, index.id)) })) throw new Error('Конфигурации агентов изменились. Обновите агентов перед запуском.')
      await persist(next)
      for (const question of ragQuestions) {
        setProgressId(question.id)
        const conversationId = crypto.randomUUID()
        const outcomes = await Promise.allSettled(demoModes.map(async (mode) => {
          const answer = await request<RagRunResult>(`/api/agents/${demoAgentIds[mode]}/run`, post({ input: question.question, conversationId }))
          if (mode !== 'without' && answer.rag?.indexRunId !== index.id) throw new Error('Ответ получен с другим индексом; сравнение недостоверно.')
          return answer
        }))
        const comparison: DemoSnapshot['results'][number] = {}
        outcomes.forEach((outcome, i) => {
          if (outcome.status === 'fulfilled') comparison[demoModes[i]] = outcome.value
          else (comparison.errors ??= {})[demoModes[i]] = String(outcome.reason)
        })
        next = { ...next, results: { ...next.results, [question.id]: comparison } }
        await persist(next)
      }
    } catch (cause) { setError(String(cause)) }
    finally { setProgressId(null); setBusy(false) }
  }
  async function clearAgents() {
    if (!allAgentsExist || busy || loading || !window.confirm('Очистить историю четырёх агентов сравнения и результаты на странице? Конфигурации, индекс и прежние отчёты Day 23 сохранятся.')) return
    setBusy(true); setError(null)
    try {
      const outcomes = await Promise.allSettled(demoModes.map((mode) => request(`/api/agents/${demoAgentIds[mode]}/history/all`, { method: 'DELETE' })))
      const failures = outcomes.filter((outcome) => outcome.status === 'rejected')
      if (failures.length) throw new Error(failures.map((failure) => String(failure.reason)).join(' · '))
      await persist({ createdAt: new Date().toISOString(), results: {} })
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }
  function downloadResults() {
    const report = { generatedAt: snapshot?.createdAt, indexRunId: snapshot?.indexRunId, agents: demoAgentIds, questions: ragQuestions.map((item) => ({ ...item, result: results[item.id] ?? null })) }
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'rag-comparison.json'; link.click(); URL.revokeObjectURL(url)
  }
  const processed = ragQuestions.filter((question) => results[question.id]).length
  return <div className="page-view rag-page">
    <header className="page-header"><div><p className="eyebrow">Дни 22–23 · сравнение RAG</p><h1>Ответ с документами и без них</h1><p className="header-description">Один вопрос и одна модель: без RAG, structured, fixed и улучшенный RAG с rewrite и реранкингом.</p></div></header>
    {error && <div className="error-message" role="alert">{error}</div>}
    {storageWarning && <p className="rag-warning" role="alert">{storageWarning}</p>}
    <section className="rag-panel"><div className="section-heading"><div><span className="step-number">01</span><div><p className="eyebrow">Агенты</p><h2>Четыре режима для сравнения</h2></div></div></div>
      <div className="rag-agent-pair rag-agent-four">{demoModes.map((mode) => <div key={mode}><strong>{demoLabels[mode]}</strong><span>{mode === 'improved' ? 'Structured · rewrite · реранкинг · 20 → 4' : mode === 'without' ? 'Поиск выключен' : `${mode} · top 4`}</span></div>)}</div>
      <button className="compare-button" type="button" disabled={busy || loading || !index || agentsReady} onClick={() => void createAgents()}>{agentsReady ? 'Агенты готовы' : 'Создать или обновить агентов'} <span>→</span></button>
      {!index && <p className="rag-note">Для запуска нужен локальный индекс: npm run rag:index.</p>}
      <p className="rag-note">Обычные агенты · deepseek-v4-flash · одинаковый промпт · temperature 0. У улучшенного RAG порог релевантности 2/3; параметры заданы в конфигурации агента.</p>
    </section>
    <section className="rag-panel"><div className="section-heading"><div><span className="step-number">02</span><div><p className="eyebrow">Контрольный набор</p><h2>10 вопросов · ожидаемое и фактическое</h2></div></div><span className="same-prompt">{processed}/10 обработано</span></div>
      <p className="rag-note">При запуске вопросы и найденные фрагменты отправляются в DeepSeek. Улучшенный RAG делает дополнительные вызовы для rewrite и реранкинга.</p>
      <div className="rag-toolbar"><button className="compare-button" type="button" disabled={!agentsReady || busy || loading} onClick={() => void runAll()}>{busy ? `Вопрос ${progressId ?? '…'} из 10…` : Object.keys(results).length ? 'Запустить все 10 заново' : 'Получить ответы на все 10 вопросов'} <span>→</span></button><button className="secondary-button" type="button" disabled={busy || loading || !Object.keys(results).length} onClick={downloadResults}>Скачать результаты JSON</button><button className="clear-context-button" type="button" disabled={busy || loading || !allAgentsExist} onClick={() => void clearAgents()}>Очистить тесты агентов</button></div>
      {snapshot && Object.keys(results).length > 0 && <p className="rag-note">Сохранены результаты от {new Date(snapshot.createdAt).toLocaleString('ru-RU')}. Они сохраняются после обновления страницы. Недостающие ответы можно получить новым прогоном.</p>}
      <div className="rag-question-list">{ragQuestions.map((item) => {
        const comparison = results[item.id], answered = demoModes.filter((mode) => comparison?.[mode]).length
        return <article className="rag-question-card" key={item.id}>
          <div className="rag-question-heading"><h3>{item.id}. {item.question}</h3><small>{progressId === item.id ? 'Выполняется…' : comparison?.errors && Object.keys(comparison.errors).length ? 'Есть ошибка' : answered ? `Ответы: ${answered}/4` : 'Ожидает запуска'}</small></div>
          <div className="rag-comparison-grid rag-unified-grid">
            <div className="rag-expected"><h4>Ожидаемый результат</h4><p>{item.expected}</p><strong>Ожидаемые источники</strong><div className="rag-source-tags">{item.sources.map((source) => <code key={source}>{source}</code>)}</div></div>
            {demoModes.map((mode) => <RagAnswer key={mode} title={demoLabels[mode]} result={comparison?.[mode]} error={comparison?.errors?.[mode]} evidence={mode === 'without' ? undefined : item.evidence} />)}
          </div>
        </article>
      })}</div>
    </section>
  </div>
}

function RagAnswer({ title, result, error, evidence }: { title: string; result?: RagRunResult; error?: string; evidence?: RagEvidence[] }) {
  const sources = result?.rag?.sources
  const hits = evidence && sources ? evidence.filter((item) => sources.some((source) => [item, ...(item.alternatives ?? [])].some((candidate) => source.source === candidate.source && source.text.includes(candidate.quote)))).length : null
  return <div className="rag-answer"><h4>{title}</h4>{result ? <>
    <small>{result.model} · {(result.durationMs / 1000).toFixed(1)} с · всего {result.totalTokens} токенов</small>
    {hits !== null && <small className={hits === evidence?.length ? 'rag-evidence-hit' : 'rag-evidence-miss'}>Контрольные фрагменты: {hits}/{evidence?.length}</small>}
    <div className="rag-answer-text"><ReactMarkdown remarkPlugins={[remarkGfm]}>{result.output}</ReactMarkdown></div>
    {result.rag && <details><summary>Найденные источники ({result.rag.sources.length})</summary><div className="rag-sources">{result.rag.sources.map((source, i) => <div key={source.chunkId}><strong>[{i + 1}] {source.source} · {source.section}</strong><small>score {source.score.toFixed(3)} · {source.chunkId}</small><p>{source.text}</p></div>)}</div></details>}
  </> : <p className={error ? 'rag-answer-error' : 'rag-answer-empty'}>{error ?? 'Ответ появится после запуска.'}</p>}</div>
}
