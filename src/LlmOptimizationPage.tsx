import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { summarizeJudgeReviews, summarizeOptimization, type OptimizationProgress, type OptimizationReport, type OptimizationSample, type OptimizationSummary, type OptimizationStatus } from './llm-optimization'
import './llm-optimization.css'

const sides = [
  { id: 'baseline', title: 'До оптимизации' },
  { id: 'optimized', title: 'После оптимизации' },
] as const
const seconds = (value?: number) => value === undefined ? '—' : `${(value / 1000).toFixed(2)} с`
const memory = (value?: number) => value === undefined ? '—' : `${(value / 1024 ** 3).toFixed(2)} ГиБ`
const speed = (value?: number) => value === undefined ? '—' : `${value.toFixed(1)} ток/с`
const grade = (value?: number) => value === undefined ? '—' : `${value.toFixed(1)}/10`

async function readReportStream(response: Response, onReport: (report: OptimizationReport) => void, onProgress?: (progress: OptimizationProgress) => void, onCaseError?: (caseId: string, error: string) => void) {
  if (!response.ok) { const data = await response.json(); throw new Error(data.error || `HTTP ${response.status}`) }
  if (!response.body) throw new Error('Пустой поток результатов.')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', latest: OptimizationReport | undefined
  const consume = (line: string) => {
    if (!line.trim()) return
    const data = JSON.parse(line)
    if (data.error) throw new Error(data.error)
    if (data.report) { latest = data.report; onReport(data.report) }
    if (data.progress) onProgress?.(data.progress)
    if (data.caseError) onCaseError?.(data.caseError.caseId, data.caseError.error)
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1) }
      if (done) { consume(buffer); break }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return latest
}

function SummaryCard({ title, summary, heavySummary, judged, profile }: { title: string; summary?: OptimizationSummary; heavySummary?: OptimizationSummary; judged: ReturnType<typeof summarizeJudgeReviews>; profile?: OptimizationReport['profiles'][number] }) {
  return <article className="optimization-summary-card">
    <h2>{title}</h2>
    <p className="optimization-model">{profile?.model || 'Локальная модель'}</p>
    {profile && <p className="optimization-settings">temperature {profile.temperature} · ответ {profile.maxTokens} · контекст {profile.adaptiveContext ? 'до ' : ''}{profile.context}{profile.adaptiveContext ? ' (по длине входа)' : ''}{profile.topP === undefined ? '' : ` · top_p ${profile.topP}`}</p>}
    <dl className="optimization-summary-metrics">
      <div><dt>Оценка DeepSeek</dt><dd>{grade(judged.meanScore)}</dd></div>
      <div><dt>Время ответа</dt><dd>{seconds(summary?.medianMs)}</dd></div>
      <div><dt>Время сложных вопросов</dt><dd>{seconds(heavySummary?.medianMs)}</dd></div>
      <div><dt>Скорость генерации</dt><dd>{speed(summary?.meanTokensPerSecond)}</dd></div>
      <div><dt>Память модели</dt><dd>{memory(summary?.maxMemoryBytes)}</dd></div>
    </dl>
  </article>
}

function AnswerCard({ title, sample, pending }: { title: string; sample?: OptimizationSample; pending?: boolean }) {
  const answer = sample?.answer
  return <article className="optimization-answer-card">
    <h3>{title}</h3>
    {sample?.error ? <p className="optimization-error">{sample.error}</p>
      : answer ? <div className="optimization-answer-text"><ReactMarkdown remarkPlugins={[remarkGfm]}>{answer.content}</ReactMarkdown></div>
        : <p className="optimization-empty">{pending ? 'Модель отвечает…' : 'Ответ появится после запуска.'}</p>}
    {answer && <p className="optimization-answer-metrics">
      {seconds(answer.metrics.wallMs)} · {speed(answer.metrics.tokensPerSecond)} · {memory(answer.metrics.modelMemoryBytes)}{answer.metrics.outputTokens === undefined ? '' : ` · ${answer.metrics.outputTokens} токенов`}{answer.metrics.loadedContext === undefined ? '' : ` · контекст ${answer.metrics.loadedContext}`}
    </p>}
    {sample?.reviewError && <p className="optimization-error">Проверка DeepSeek: {sample.reviewError}</p>}
    {sample?.review ? <div className="optimization-review">
      <p className={`optimization-answer-check ${sample.review.verdict === 'correct' ? 'passed' : 'failed'}`}>DeepSeek: {grade(sample.review.score)} · {{ correct: 'корректный ответ', partial: 'есть ошибки или пропуски', incorrect: 'неверный ответ' }[sample.review.verdict]}</p>
      <p className="optimization-review-rationale">{sample.review.rationale}</p>
      <details><summary>Разбор оценки</summary>
        <p>Точность {sample.review.accuracy}/5 · полнота {sample.review.completeness}/5 · опора на материалы {sample.review.grounding}/5 · ссылки {sample.review.citations}/5</p>
        {sample.review.errors.length > 0 && <><p>Ошибки:</p><ul>{sample.review.errors.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
        {sample.review.omissions.length > 0 && <><p>Пропуски:</p><ul>{sample.review.omissions.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
        <p>Агент: {sample.review.model}</p>
      </details>
    </div> : answer && <p className="optimization-note">{pending ? 'Оценка DeepSeek ожидается…' : 'Оценка DeepSeek ещё не получена.'}</p>}
    {answer && answer.doneReason !== 'stop' && <p className="optimization-error">Ответ не завершён.</p>}
  </article>
}

function ComparisonConclusion({ before, after, heavyBefore, heavyAfter, beforeGrade, afterGrade }: { before?: OptimizationSummary; after?: OptimizationSummary; heavyBefore?: OptimizationSummary; heavyAfter?: OptimizationSummary; beforeGrade?: number; afterGrade?: number }) {
  const notes: string[] = []
  if (beforeGrade !== undefined && afterGrade !== undefined) notes.push(`Оценка DeepSeek: ${grade(beforeGrade)} → ${grade(afterGrade)}.`)
  if (heavyBefore?.medianMs && heavyAfter?.medianMs) {
    const change = (heavyAfter.medianMs / heavyBefore.medianMs - 1) * 100
    notes.push(`Время сложных вопросов ${change <= 0 ? 'сократилось' : 'увеличилось'} на ${Math.abs(change).toFixed(0)}%.`)
  }
  if (before?.maxMemoryBytes && after?.maxMemoryBytes) {
    const change = (after.maxMemoryBytes / before.maxMemoryBytes - 1) * 100
    notes.push(`Память модели ${change <= 0 ? 'уменьшилась' : 'увеличилась'} на ${Math.abs(change).toFixed(0)}%.`)
  }
  if (before?.medianMs && after?.medianMs) {
    const change = (after.medianMs / before.medianMs - 1) * 100
    notes.push(`Время ответа ${change <= 0 ? 'сократилось' : 'увеличилось'} на ${Math.abs(change).toFixed(0)}%.`)
  }
  return notes.length ? <p className="optimization-conclusion">{notes.join(' ')}</p> : null
}

export default function LlmOptimizationPage() {
  const [report, setReport] = useState<OptimizationReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<OptimizationStatus>()
  const [busy, setBusy] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [progress, setProgress] = useState<OptimizationProgress>()
  const [notice, setNotice] = useState('')
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({})
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    void fetch('/api/llm-optimization/status', { signal: abort.signal }).then((response) => response.json()).then(setStatus).catch(() => {})
    void fetch('/api/llm-optimization/report', { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Не удалось загрузить результаты сравнения.')
        return await response.json() as OptimizationReport | null
      })
      .then(setReport)
      .catch((err) => { if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => { abort.abort(); controller.current?.abort() }
  }, [])
  async function runCases(ids: string[]) {
    if (controller.current || !status?.ready) return
    const abort = new AbortController(); controller.current = abort
    setBusy(true); setError(''); setNotice('')
    setProgress({ generatingCaseId: ids[0], reviewingCaseIds: [], reviewed: 0, reviewTotal: status?.judgeReady ? ids.length : 0, concurrency: status?.judgeConcurrency || 3 })
    setRequestErrors((items) => Object.fromEntries(Object.entries(items).filter(([id]) => !ids.includes(id))))
    try {
      const response = await fetch('/api/llm-optimization/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseIds: ids }), signal: abort.signal })
      await readReportStream(response, setReport, setProgress, (caseId, message) => setRequestErrors((items) => ({ ...items, [caseId]: message })))
    } catch (err) { setNotice(abort.signal.aborted ? 'Прогон остановлен. Завершённые ответы сохранены.' : String(err)) }
    finally { controller.current = null; setBusy(false); setProgress(undefined) }
  }
  async function reviewAnswers(caseId?: string) {
    if (controller.current || !status?.judgeReady) return
    const abort = new AbortController(); controller.current = abort
    setBusy(true); setReviewing(true); setError(''); setNotice('')
    setProgress({ reviewingCaseIds: caseId ? [caseId] : [], reviewed: 0, reviewTotal: caseId ? 1 : pairedCases.length, concurrency: status?.judgeConcurrency || 3 })
    try {
      const response = await fetch('/api/llm-optimization/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(caseId ? { caseId } : {}), signal: abort.signal })
      await readReportStream(response, setReport, setProgress)
    } catch (err) { setNotice(abort.signal.aborted ? 'Проверка остановлена. Завершённые оценки сохранены.' : String(err)) }
    finally { controller.current = null; setBusy(false); setReviewing(false); setProgress(undefined) }
  }
  async function clearResults() {
    if (controller.current) return
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/llm-optimization/report', { method: 'DELETE' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Не удалось очистить результаты.')
      setReport(data); setRequestErrors({}); setNotice('')
    } catch (err) { setError(String(err)) }
    finally { setBusy(false) }
  }
  function exportResults() {
    if (!report) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'day-29-heavy-comparison.json'; link.click(); URL.revokeObjectURL(url)
  }
  const pairedCases = report?.cases.filter((test) => sides.every((side) => report.samples.some((item) => item.caseId === test.id && item.profileId === side.id && item.answer?.doneReason === 'stop'))) || []
  const summaries = report ? summarizeOptimization(report.samples.filter((item) => pairedCases.some((test) => test.id === item.caseId)), report.profiles) : []
  const before = summaries.find((item) => item.profileId === 'baseline')
  const after = summaries.find((item) => item.profileId === 'optimized')
  const heavyIds = new Set(report?.cases.slice(6).map((item) => item.id))
  const heavySummaries = report ? summarizeOptimization(report.samples.filter((item) => heavyIds.has(item.caseId) && pairedCases.some((test) => test.id === item.caseId)), report.profiles) : []
  const judgedPairs = report?.cases.filter((test) => sides.every((side) => report.samples.some((sample) => sample.caseId === test.id && sample.profileId === side.id && sample.review))) || []
  const judgedBefore = summarizeJudgeReviews(report?.samples.filter((sample) => sample.profileId === 'baseline' && judgedPairs.some((test) => test.id === sample.caseId)) || [])
  const judgedAfter = summarizeJudgeReviews(report?.samples.filter((sample) => sample.profileId === 'optimized' && judgedPairs.some((test) => test.id === sample.caseId)) || [])

  return <section className="page-view optimization-page">
    <header className="page-header">
      <div>
        <p className="eyebrow">День 29</p>
        <h1>До и после оптимизации</h1>
        <p className="header-description">Задача: краткие ответы по документации DeepChat с точными фактами и ссылками на источники.</p>
      </div>
    </header>
    {loading && <p className="optimization-empty" role="status">Загружаем результаты…</p>}
    {error && <p className="optimization-error" role="alert">{error}</p>}
    {notice && <p className="optimization-note" role="status">{notice}</p>}
    {status?.error && <p className="optimization-error">{status.error}</p>}
    {!loading && !error && !report && <p className="optimization-empty">Результаты сравнения ещё не сохранены.</p>}
    {report && <>
      <div className="optimization-toolbar">
        <button className="optimization-primary" disabled={loading || busy || !status?.ready} onClick={() => void runCases(report.cases.map((item) => item.id))}>{busy ? progress?.generatingCaseId ? `Вопрос ${report.cases.findIndex((item) => item.id === progress.generatingCaseId) + 1}/${report.cases.length}…` : 'Выполняется…' : `Запустить все ${report.cases.length} вопросов`}</button>
        <button disabled={busy || !status?.judgeReady || !pairedCases.length} onClick={() => void reviewAnswers()}>{reviewing ? 'DeepSeek проверяет…' : 'Проверить ответы DeepSeek'}</button>
        {busy && <button onClick={() => controller.current?.abort()}>Остановить</button>}
        <button disabled={busy || !report.samples.length} onClick={exportResults}>Скачать JSON</button>
        <button disabled={busy || !report.samples.length} onClick={() => void clearResults()}>Очистить результаты</button>
      </div>
      <p className="optimization-note">Агент проверки: {status?.judgeModel || 'DeepSeek Pro'}, до {status?.judgeConcurrency || 3} пар одновременно. В DeepSeek передаются вопрос, материалы и оба ответа. Готовые пары проверяются параллельно с получением следующих ответов; сохранённые ответы можно проверить отдельно.{status?.judgeReady ? '' : ' Для запуска настройте DEEPSEEK_API_KEY на сервере.'}</p>
      {busy && progress && <p className="optimization-note" role="status">{progress.generatingCaseId ? `Локальная модель: вопрос ${report.cases.findIndex((item) => item.id === progress.generatingCaseId) + 1}/${report.cases.length}. ` : ''}{progress.reviewTotal > 0 ? `DeepSeek: завершено ${progress.reviewed}/${progress.reviewTotal}, проверяется ${progress.reviewingCaseIds.length}.` : ''}</p>}
      <div className="optimization-pair optimization-summary">
        {sides.map((side) => <SummaryCard key={side.id} title={side.title}
          summary={side.id === 'baseline' ? before : after}
          heavySummary={heavySummaries.find((item) => item.profileId === side.id)}
          judged={side.id === 'baseline' ? judgedBefore : judgedAfter}
          profile={report.profiles.find((item) => item.id === side.id)} />)}
      </div>
      <ComparisonConclusion before={before} after={after} beforeGrade={judgedBefore.meanScore} afterGrade={judgedAfter.meanScore} heavyBefore={heavySummaries.find((item) => item.profileId === 'baseline')} heavyAfter={heavySummaries.find((item) => item.profileId === 'optimized')} />
      <p className="optimization-note">Сводка по {pairedCases.length} полным парам ответов: время — медиана, скорость — средняя, память — максимум снимков Ollama. Ответы сохраняются после каждого запроса.</p>
      <p className="optimization-note">DeepSeek оценил {judgedPairs.length} пар ответов вслепую по одинаковой рубрике. Итог /10: точность 50%, полнота 30%, опора на материалы 20%. Ссылки оцениваются отдельно. Время и память относятся только к локальной модели.</p>
      {!report.finishedAt && <p className="optimization-note">Показаны результаты незавершённого прогона.</p>}
      <div className="optimization-results">
        {report.cases.map((item, index) => <section className="optimization-question" key={item.id}>
          <h2><span>{String(index + 1).padStart(2, '0')}</span>{item.question}</h2>
          <div className="optimization-question-actions"><span>{index >= 6 ? 'Сложный вопрос' : 'Контрольный вопрос'}</span><div className="optimization-question-buttons"><button disabled={busy || !status?.ready} onClick={() => void runCases([item.id])}>{progress?.generatingCaseId === item.id ? 'Выполняется…' : 'Получить ответы'}</button><button disabled={busy || !status?.judgeReady || !report.samples.some((sample) => sample.caseId === item.id && sample.profileId === 'baseline' && sample.answer) || !report.samples.some((sample) => sample.caseId === item.id && sample.profileId === 'optimized' && sample.answer)} onClick={() => void reviewAnswers(item.id)}>{progress?.reviewingCaseIds.includes(item.id) ? 'Проверяется…' : 'Проверить DeepSeek'}</button></div></div>
          {requestErrors[item.id] && <p className="optimization-error" role="alert">{requestErrors[item.id]}</p>}
          <div className="optimization-pair">
            {sides.map((side) => {
              const sample = report.samples.filter((value) => value.caseId === item.id && value.profileId === side.id)
                .sort((a, b) => a.repetition - b.repetition)[0]
              return <AnswerCard key={side.id} title={side.title} sample={sample} pending={progress?.generatingCaseId === item.id || progress?.reviewingCaseIds.includes(item.id)} />
            })}
          </div>
        </section>)}
      </div>
    </>}
  </section>
}
