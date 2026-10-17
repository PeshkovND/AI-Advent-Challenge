import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { demoQuestions } from './rag-demo-config'
import type { RagEvidence } from './rag-questions'
import { type LocalRagAnswer, type LocalRagComparison, type LocalRagSnapshot, type LocalRagStatus } from './local-rag-types'
import './local-rag.css'

const storageKey = 'deepchat-day28-rag-demo-v2'
const seconds = (value: number | null) => value === null ? '—' : (value / 1000).toFixed(2) + ' с'
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
  return data as T
}
function compatible(value: unknown): value is LocalRagSnapshot {
  if (!value || typeof value !== 'object') return false
  const saved = value as LocalRagSnapshot
  return saved.version === 2 && typeof saved.indexRunId === 'string' && Boolean(saved.results && typeof saved.results === 'object')
}
function improvedOnly(snapshot: LocalRagSnapshot): LocalRagSnapshot {
  return { ...snapshot, results: Object.fromEntries(Object.entries(snapshot.results).flatMap(([id, result]) =>
    result.improved || result.errors?.improved ? [[id, {
      ...(result.improved ? { improved: result.improved } : {}),
      ...(result.errors?.improved ? { errors: { improved: result.errors.improved } } : {}),
    }]] : [])) }
}

export default function LocalRagPage() {
  const [status, setStatus] = useState<LocalRagStatus>()
  const [snapshot, setSnapshot] = useState<LocalRagSnapshot | null>(() => {
    try { const saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); return compatible(saved) ? improvedOnly(saved) : null } catch { return null }
  })
  const [cloud, setCloud] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [storageWarning, setStorageWarning] = useState('')
  const abort = useRef<AbortController | null>(null)
  const results = snapshot?.results || {}
  const ready = Boolean(status?.localReady && status.index?.strategies.includes('structured'))
  const processed = demoQuestions.filter((question) => results[question.id]?.improved || results[question.id]?.errors?.improved).length

  async function refresh() {
    try { setStatus(await request<LocalRagStatus>('/api/local-rag/status')) } catch (cause) { setError(String(cause)) }
  }
  useEffect(() => { void refresh(); return () => abort.current?.abort() }, [])
  function persist(next: LocalRagSnapshot) {
    setSnapshot(next)
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setStorageWarning('') }
    catch { setStorageWarning('Не удалось сохранить результаты в браузере. Скачайте JSON до обновления страницы.') }
  }
  async function loadReport() {
    setError('')
    try {
      const saved = await request<unknown>('/api/local-rag/report')
      if (!compatible(saved)) throw new Error('Отчёта для этих 11 вопросов пока нет. Выполните npm run rag:local:evaluate.')
      persist(improvedOnly(saved))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  async function runAll() {
    if (abort.current || !ready || !status?.index) return
    const controller = new AbortController(); abort.current = controller
    setBusy(true); setError('')
    let next: LocalRagSnapshot = { version: 2, createdAt: new Date().toISOString(), indexRunId: status.index.id, includeCloud: cloud, results: {} }
    persist(next)
    try {
      for (const question of demoQuestions) {
        controller.signal.throwIfAborted()
        setProgress(question.id)
        try {
          const comparison = await request<LocalRagComparison>('/api/local-rag/compare', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ question: question.question, includeCloud: cloud, mode: 'improved', indexRunId: next.indexRunId }),
          })
          if (comparison.indexRunId !== next.indexRunId) throw new Error('Получен другой индекс.')
          next = { ...next, results: { ...next.results, [question.id]: { improved: comparison } } }
        } catch (cause) {
          controller.signal.throwIfAborted()
          next = { ...next, results: { ...next.results, [question.id]: { errors: { improved: String(cause) } } } }
        }
        persist(next)
      }
    } catch (cause) { setError(controller.signal.aborted ? 'Прогон остановлен. Полученные ответы сохранены.' : String(cause)) }
    finally { abort.current = null; setBusy(false); setProgress(null) }
  }
  function downloadResults() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...snapshot, questions: demoQuestions }, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'day-28-rag-comparison.json'; link.click(); URL.revokeObjectURL(url)
  }
  const stale = snapshot && status?.index && snapshot.indexRunId !== status.index.id
  return <div className="page-view rag-page local-rag-page">
    <header className="page-header"><div><p className="eyebrow">День 28 · локальная LLM + RAG</p><h1>Локальная и облачная модели</h1><p className="header-description">Улучшенный RAG для двух моделей. Те же 11 вопросов, ожидаемые ответы и время под каждым ответом.</p></div></header>
    {(error || status?.error) && <div className="error-message" role="alert">{error || status?.error}</div>}
    {storageWarning && <p className="rag-warning" role="alert">{storageWarning}</p>}
    {stale && <p className="rag-warning">Сохранённые ответы получены с другим индексом. Новый прогон использует текущий индекс.</p>}
    <section className="rag-panel">
      <div className="section-heading"><div><span className="step-number">01</span><div><p className="eyebrow">Модели</p><h2>Две модели с улучшенным RAG</h2></div></div></div>
      <div className="rag-agent-pair local-rag-model-pair">
        <div><strong>{status?.localModel || 'Ollama'}</strong><span>Локальная модель · улучшенный RAG</span></div>
        <div><strong>{status?.cloudModel || 'DeepSeek'}</strong><span>Облачная модель · улучшенный RAG</span></div>
      </div>
      <label className="local-rag-cloud-toggle"><input type="checkbox" checked={cloud} disabled={busy || !status?.cloudAvailable} onChange={(event) => setCloud(event.target.checked)} /> Сравнить также с {status?.cloudModel || 'DeepSeek'}</label>
      <p className="rag-note">{cloud ? 'Вопросы, найденные фрагменты и ответы для проверки отправляются в DeepSeek. Обе модели получают одни источники; поиск, rewrite и реранкинг выполняются локально.' : 'Все этапы выполняются локально, без облачных моделей и API-ключей.'}</p>
      <button className="secondary-button" disabled={busy} onClick={() => void refresh()}>Обновить доступность</button>
    </section>
    <section className="rag-panel">
      <div className="section-heading"><div><span className="step-number">02</span><div><p className="eyebrow">Контрольный набор</p><h2>{demoQuestions.length} вопросов · ожидаемое и фактическое</h2></div></div><span className="same-prompt">{processed}/{demoQuestions.length} обработано</span></div>
      <div className="rag-toolbar">
        <button className="compare-button" disabled={!ready || busy} onClick={() => void runAll()}>{busy ? 'Вопрос ' + (progress || '…') + '/11…' : Object.keys(results).length ? 'Запустить все 11 заново' : 'Получить ответы на все 11 вопросов'} <span>→</span></button>
        {busy && <button className="secondary-button" onClick={() => abort.current?.abort()}>Остановить</button>}
        <button className="secondary-button" disabled={busy || !Object.keys(results).length} onClick={downloadResults}>Скачать результаты JSON</button>
        <button className="secondary-button" disabled={busy} onClick={() => void loadReport()}>Загрузить контрольный отчёт</button>
        <button className="clear-context-button" disabled={busy || !snapshot} onClick={() => persist({ version: 2, createdAt: new Date().toISOString(), indexRunId: status?.index?.id || snapshot!.indexRunId, includeCloud: cloud, results: {} })}>Очистить результаты</button>
      </div>
      {snapshot && Object.keys(results).length > 0 && <p className="rag-note">Результаты от {new Date(snapshot.createdAt).toLocaleString('ru-RU')} сохраняются после обновления страницы. Вопросы независимы, история не добавляется в контекст.</p>}
      <div className="rag-question-list">{demoQuestions.map((item) => {
        const comparison = results[item.id]?.improved, requestError = results[item.id]?.errors?.improved
        const answered = Number(Boolean(comparison?.local)) + Number(Boolean(comparison?.cloud))
        return <article className="rag-question-card" key={item.id}>
          <div className="rag-question-heading"><h3>{item.id}. {item.question}</h3><small>{progress === item.id ? 'Выполняется…' : requestError || comparison?.local.error || comparison?.cloud?.error ? 'Есть ошибка' : answered ? 'Ответы: ' + answered + '/2' : 'Ожидает запуска'}</small></div>
          <div className="rag-comparison-grid rag-unified-grid local-rag-comparison-grid">
            <div className="rag-expected"><h4>Ожидаемый результат</h4><p>{item.expected}</p><strong>Ожидаемые источники</strong><div className="rag-source-tags">{item.sources.length ? item.sources.map((source) => <code key={source}>{source}</code>) : <span>Нет подтверждённых источников в базе.</span>}</div></div>
            <Answer title="Улучшенный RAG · локальная модель" result={comparison} provider="local" error={requestError} evidence={item.evidence} />
            <Answer title="Улучшенный RAG · облачная модель" result={comparison} provider="cloud" error={requestError} evidence={item.evidence} emptyMessage={status?.cloudAvailable ? cloud ? 'Ответ появится после запуска.' : 'Включите сравнение с облачной моделью и запустите вопросы.' : 'Для облачной модели настройте ключ DeepSeek.'} />
          </div>
        </article>
      })}</div>
    </section>
  </div>
}

function Answer({ title, result, provider, error, evidence, emptyMessage }: { title: string; result?: LocalRagComparison; provider: 'local' | 'cloud'; error?: string; evidence?: RagEvidence[]; emptyMessage?: string }) {
  const answer: LocalRagAnswer | undefined = result?.[provider]
  const sources = result?.rag?.sources
  const hits = evidence?.length && sources ? evidence.filter((item) => sources.some((source) => [item, ...(item.alternatives || [])].some((candidate) => source.source === candidate.source && source.text.includes(candidate.quote)))).length : null
  return <div className="rag-answer"><h4>{title}</h4>{answer ? <>
    <small>{answer.model} · всего {answer.promptTokens + answer.outputTokens} токенов · {answer.calls} LLM-вызовов</small>
    {answer.grounding && <small>{answer.grounding.status === 'answered' ? 'Цитаты дословные · смысл проверен LLM' : 'Не знаю · требуется уточнение'}</small>}
    {hits !== null && <small className={hits === evidence?.length ? 'rag-evidence-hit' : 'rag-evidence-miss'}>Контрольные фрагменты: {hits}/{evidence?.length}</small>}
    {answer.error ? <p className="rag-answer-error">{answer.error}</p> : <div className="rag-answer-text"><ReactMarkdown remarkPlugins={[remarkGfm]}>{answer.output || ''}</ReactMarkdown></div>}
    <p className="local-rag-answer-time">Время ответа: <strong>{seconds(answer.durationMs)}</strong></p>
    {result?.rag && <details><summary>Найденные источники ({result.rag.sources.length})</summary><div className="rag-sources">{result.rag.sources.map((source, index) => <div key={source.chunkId}><strong>[{index + 1}] {source.source} · {source.section}</strong><small>score {source.score.toFixed(3)} · {source.chunkId}</small><p>{source.text}</p></div>)}</div></details>}
  </> : <p className={error ? 'rag-answer-error' : 'rag-answer-empty'}>{error || emptyMessage || 'Ответ появится после запуска.'}</p>}</div>
}
