import { useEffect, useRef, useState } from 'react'
import FolderPicker from './FolderPicker'
import Evidence from './ReleaseEvidence'
import ReleaseImpactPanel from './ReleaseImpactPanel'
import { releaseChecks, releaseRiskId } from './release-types'
import type { Project } from './project-types'
import type { ReleaseCheck, ReleaseProvider, ReleaseRepositoryInfo, ReleaseRun, ReleaseState } from './release-types'
import './release.css'

type Summary = Pick<ReleaseRun, 'id' | 'version' | 'state' | 'base' | 'head' | 'createdAt' | 'projectName' | 'coverage'>
const states: Record<ReleaseState, string> = { queued: 'В очереди', collecting: 'Сбор данных', analyzing: 'AI-анализ', awaiting_checks: 'Ручная проверка', ready: 'Пакет готов', failed: 'Ошибка', cancelled: 'Отменён' }
const inProgress = (run?: ReleaseRun) => Boolean(run && ['queued', 'collecting', 'analyzing'].includes(run.state))
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос.')
  return data
}
const json = (data: unknown, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })

export default function ReleasePage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [repository, setRepository] = useState<ReleaseRepositoryInfo>()
  const [folderPicker, setFolderPicker] = useState(false)
  const [models, setModels] = useState<{ localModel: string; cloudModel: string; cloudAvailable: boolean }>()
  const [baseRef, setBaseRef] = useState('HEAD~1')
  const [headRef, setHeadRef] = useState('HEAD')
  const [version, setVersion] = useState('')
  const [provider, setProvider] = useState<ReleaseProvider>('local')
  const [history, setHistory] = useState<Summary[]>([])
  const [run, setRun] = useState<ReleaseRun>()
  const [tab, setTab] = useState<'changes' | 'impact' | 'checks' | 'materials'>('changes')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadingRepo, setLoadingRepo] = useState(false)
  const projectRef = useRef(projectId); projectRef.current = projectId
  const selectedRef = useRef('')
  const busyRef = useRef(false)

  useEffect(() => {
    const abort = new AbortController()
    void Promise.all([api<{ projects: Project[]; defaultProjectId: string | null }>('releases/projects', { signal: abort.signal }), api<NonNullable<typeof models>>('releases/status', { signal: abort.signal })]).then(([catalog, settings]) => {
      if (abort.signal.aborted) return
      setProjects(catalog.projects); setProjectId(catalog.defaultProjectId || ''); setModels(settings)
    }).catch((err) => { if (!abort.signal.aborted) setError(err.message) })
    return () => abort.abort()
  }, [])

  useEffect(() => {
    if (!projectId) return
    const abort = new AbortController()
    selectedRef.current = ''; setRun(undefined); setRepository(undefined); setHistory([]); setError(''); setLoadingRepo(true)
    void api<ReleaseRepositoryInfo>(`releases/repository?projectId=${encodeURIComponent(projectId)}`, { signal: abort.signal }).then((data) => {
      if (!abort.signal.aborted) { setRepository(data); setBaseRef(data.suggestedBase); setHeadRef('HEAD') }
    }).catch((err) => { if (!abort.signal.aborted) setError(err.message) }).finally(() => { if (!abort.signal.aborted) setLoadingRepo(false) })
    void api<Summary[]>(`releases/runs?projectId=${encodeURIComponent(projectId)}`, { signal: abort.signal }).then(async (data) => {
      if (abort.signal.aborted) return
      setHistory(data)
      let saved: string | null = null
      try { saved = localStorage.getItem(`release-run:${projectId}`) } catch { /* Use server history. */ }
      const id = data.some((item) => item.id === saved) ? saved : data[0]?.id
      if (id && !selectedRef.current) {
        selectedRef.current = id
        const result = await api<ReleaseRun>(`releases/runs/${id}`, { signal: abort.signal })
        if (!abort.signal.aborted && selectedRef.current === id) setRun(result)
      }
    }).catch((err) => { if (!abort.signal.aborted) setError(err.message) })
    return () => abort.abort()
  }, [projectId])

  useEffect(() => {
    if (!run || !inProgress(run)) return
    const abort = new AbortController(), id = run.id
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await api<ReleaseRun>(`releases/runs/${id}`, { signal: abort.signal })
        if (abort.signal.aborted || selectedRef.current !== id) return
        setRun(result); setHistory((items) => items.map((item) => item.id === id ? result : item))
        if (inProgress(result)) timer = setTimeout(() => void poll(), 2000)
      } catch (err) { if (!abort.signal.aborted) { setError(err instanceof Error ? err.message : 'Нет связи с сервером.'); timer = setTimeout(() => void poll(), 5000) } }
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => { abort.abort(); clearTimeout(timer) }
  }, [run?.id, run?.state])

  function accept(result: ReleaseRun) {
    if (result.projectId !== projectRef.current) return
    selectedRef.current = result.id; setRun(result)
    setHistory((items) => [result, ...items.filter((item) => item.id !== result.id)])
    try { localStorage.setItem(`release-run:${result.projectId}`, result.id) } catch { /* Server history remains available. */ }
  }
  async function action(work: () => Promise<ReleaseRun>) {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError('')
    try { accept(await work()) }
    catch (err) { setError(err instanceof Error ? err.message : 'Ошибка запроса.') }
    finally { busyRef.current = false; setBusy(false) }
  }
  async function select(id: string) {
    selectedRef.current = id
    try { const result = await api<ReleaseRun>(`releases/runs/${id}`); if (selectedRef.current === id) accept(result) }
    catch (err) { setError(err instanceof Error ? err.message : 'Не удалось открыть запуск.') }
  }
  const checks = run ? releaseChecks(run) : []
  const riskReviews = new Map(run?.impact?.riskReviews.map((review) => [review.riskId, review]) || [])
  const passed = checks.filter((check) => check.status === 'passed').length
  const risks = run?.files.reduce((total, file) => total + file.risks.filter((_risk, index) => riskReviews.get(releaseRiskId(file.path, index))?.verdict !== 'dismissed').length, 0) || 0
  const hasMaterials = run && ['awaiting_checks', 'ready'].includes(run.state)
  const limitations = run ? [...run.skipped.map((item) => `${item.path}: ${item.reason}`), ...run.fileErrors.map((item) => `${item.path}: ${item.error}`), ...run.files.filter((file) => file.limited).map((file) => `${file.path}: ограничен diff или контекст файла`), ...(run.corpusLimited ? ['Корпус документации и кода ограничен лимитами.'] : []), ...(run.impact?.error ? [run.impact.error] : [])] : []

  return <div className="release-page">
    <header className="release-header"><div><span className="release-eyebrow">RELEASE COPILOT</span><h1>Подготовка релиза</h1><p>От изменений в Git до понятного плана выпуска.</p></div><span className="release-local-label">Локальное рабочее место</span></header>
    <div className="release-layout">
      <aside className="release-setup">
        <form className="release-card" onSubmit={(event) => { event.preventDefault(); setTab('changes'); void action(() => api('releases/runs', json({ projectId, baseRef, headRef, version, provider }))) }}>
          <div className="release-card-heading"><h2>Новый релиз</h2><span>01</span></div>
          <label>Проект<select value={projectId} disabled={busy} onChange={(event) => setProjectId(event.target.value)}>{!projects.length && <option value="">Откройте папку проекта</option>}{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <button type="button" className="release-text-button" disabled={busy} onClick={() => setFolderPicker(true)}>＋ Открыть папку проекта</button>
          <label>Версия<input required maxLength={80} value={version} onChange={(event) => setVersion(event.target.value)} placeholder="Например, 1.4.0" /></label>
          <div className="release-range"><label>От<input required list="release-refs" maxLength={200} value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="Тег или commit" /></label><span aria-hidden="true">→</span><label>До<input required list="release-refs" maxLength={200} value={headRef} onChange={(event) => setHeadRef(event.target.value)} placeholder="Ветка или commit" /></label></div>
          <datalist id="release-refs">{repository?.refs.map((value) => <option value={value} key={value} />)}</datalist>
          <small>Сравниваются два commit. Ветки и теги читаются локально, без fetch.{repository?.dirty ? ' Есть незакоммиченные изменения — они не попадут в анализ.' : ''}{repository?.refsTruncated ? ' Подсказки ограничены; можно ввести ref вручную.' : ''}</small>
          <label>AI-модель<select value={provider} onChange={(event) => setProvider(event.target.value as ReleaseProvider)}><option value="local">Ollama · {models?.localModel || 'локальная модель'}</option><option value="cloud" disabled={!models?.cloudAvailable}>DeepSeek · {models?.cloudModel || 'ключ не настроен'}</option></select></label>
          {provider === 'cloud' && <p className="release-warning">Diff и найденные фрагменты кода и документации будут отправлены в DeepSeek.</p>}
          <button className="release-primary" disabled={busy || loadingRepo || !repository || !version.trim()}>{busy ? 'Сохраняем…' : loadingRepo ? 'Читаем Git…' : 'Подготовить релиз ↗'}</button>
          <small>Анализ продолжится, если закрыть страницу. Для локальной модели запустите Ollama.</small>
        </form>
        <section className="release-card release-history"><div className="release-card-heading"><h2>История запусков</h2><span>{history.length}</span></div>{!history.length && <p>Здесь появятся сохранённые релизы.</p>}{history.map((item) => <button disabled={busy} key={item.id} className={run?.id === item.id ? 'selected' : ''} onClick={() => void select(item.id)}><strong>{item.version}</strong><span>{states[item.state]}</span><small>{new Date(item.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · {item.base.slice(0, 7)} → {item.head.slice(0, 7)}</small></button>)}</section>
      </aside>
      <main className="release-workspace">
        {error && <p className="release-error" role="alert">{error}</p>}
        {!run ? <section className="release-card release-empty"><div className="release-empty-icon">↗</div><span className="release-eyebrow">ПОДГОТОВЬТЕ ПЕРВЫЙ РЕЛИЗ</span><h2>Изменения становятся планом</h2><p>Выберите проект, версию и диапазон Git. AI разберёт код, найдёт контекст в документации и подготовит материалы для проверки.</p><div className="release-empty-steps"><span>01 <b>Сводка изменений</b></span><span>02 <b>Риски и проверки</b></span><span>03 <b>Материалы релиза</b></span></div></section> : <>
          <section className="release-card release-run-header"><div><span className={`release-badge ${run.state}`}>{states[run.state]}</span><h2>{run.projectName} <span>/</span> {run.version}</h2><p className="release-shas" title={`${run.base} → ${run.head}`}>{run.base.slice(0, 12)} → {run.head.slice(0, 12)}</p></div><div className="release-run-actions">{inProgress(run) && <button disabled={busy} onClick={() => void action(() => api(`releases/runs/${run.id}/cancel`, json({})))}>Отменить</button>}{['failed', 'cancelled', 'awaiting_checks'].includes(run.state) && <button disabled={busy} onClick={() => void action(() => api(`releases/runs/${run.id}/retry`, json({})))}>Повторить анализ</button>}{hasMaterials && <a className="release-primary" href={`/api/releases/runs/${run.id}/artifacts/bundle.zip`} download>Скачать ZIP ↓</a>}</div></section>
          <section className="release-card release-progress" aria-live="polite"><div><span className={inProgress(run) ? 'release-dot working' : 'release-dot'} />{run.progress}</div>{inProgress(run) && <progress max={run.totalFiles || 1} value={run.files.length + run.fileErrors.length} />}{run.error && <p className="release-error">{run.error}</p>}<small>{run.state === 'queued' || run.state === 'collecting' ? 'Подготовка источников' : run.model || 'Модель ещё не вызвана'} · {inProgress(run) ? 'Анализ и смысловая проверка' : `${run.metrics.calls} вызовов · ${run.metrics.promptTokens + run.metrics.outputTokens} токенов`} · {((run.metrics.durationMs + (inProgress(run) ? Math.max(0, Date.now() - Date.parse(run.updatedAt)) : 0)) / 1000).toFixed(0)} с</small></section>
          <div className="release-metrics"><div><strong>{run.files.length}<small>/{run.totalFiles}</small></strong><span>файлов разобрано</span></div><div><strong>{risks}</strong><span>потенциальных рисков</span></div><div><strong>{passed}<small>/{checks.length}</small></strong><span>проверок пройдено</span></div><div><strong>{run.coverage === 'pending' ? '…' : run.coverage === 'complete' ? 'Полное' : 'Частичное'}</strong><span>покрытие анализа</span></div></div>
          {limitations.length > 0 && <details className="release-card release-limitations" open={run.coverage === 'partial'}><summary>Ограничения и пропуски · {limitations.length}</summary><ul>{limitations.map((text, index) => <li key={index}>{text}</li>)}</ul><p>При неполном покрытии пакет можно скачать как черновик. Статус «Пакет готов» недоступен.</p></details>}
          <div className="release-tabs" role="tablist" aria-label="Материалы релиза">{([['changes', 'Изменения'], ['impact', 'Связи файлов'], ['checks', `Проверки · ${passed}/${checks.length}`], ['materials', 'Материалы']] as const).map(([id, label]) => <button key={id} id={`release-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="release-panel" onClick={() => setTab(id)}>{label}</button>)}</div>
          <div id="release-panel" role="tabpanel" aria-labelledby={`release-tab-${tab}`}>
            {tab === 'changes' && <><p className="release-caption">Интерпретация AI. Ссылки ведут к зафиксированным исходникам; смысл выводов требует проверки.</p>{run.files.map((file) => <section className="release-card release-file" key={file.path}><div className="release-file-path"><span>{file.status}</span><code>{file.path}</code></div><h3>{file.summary.text}</h3><small>Источники: {file.summary.evidenceIds.join(', ')}</small>{file.userNote && <p className="release-user-note">В описание версии: {file.userNote}</p>}{file.risks.map((risk, index) => <div className={`release-risk ${risk.severity} ${riskReviews.get(releaseRiskId(file.path, index))?.verdict || ''}`} key={index}><span>{risk.severity === 'high' ? 'Высокий' : risk.severity === 'medium' ? 'Средний' : 'Низкий'} риск · предположение AI</span><p>{risk.text}</p><small>Источники: {risk.evidenceIds.join(', ')}</small>{riskReviews.has(releaseRiskId(file.path, index)) && <p className="release-impact-note"><b>{riskReviews.get(releaseRiskId(file.path, index))!.verdict === 'dismissed' ? 'Гипотеза снята' : riskReviews.get(releaseRiskId(file.path, index))!.verdict === 'confirmed' ? 'Риск подтверждается связанным кодом' : 'Нужна ручная оценка'}:</b> {riskReviews.get(releaseRiskId(file.path, index))!.reason}</p>}</div>)}<Evidence file={file} /> </section>)}{!run.files.length && <p className="release-card">{inProgress(run) ? 'Первые результаты появятся после анализа файла.' : 'Результатов анализа пока нет.'}</p>}</>}
            {tab === 'impact' && <ReleaseImpactPanel run={run} canStart={Boolean(hasMaterials && !busy)} onStart={() => void action(() => api(`releases/runs/${run.id}/impact`, json({})))} />}
            {tab === 'checks' && <><p className="release-caption">Выполните шаги в приложении и сохраните фактический результат. Создание сценария не означает его прохождение.</p>{run.files.map((file) => file.checks.map((check) => <CheckCard key={check.id} check={check} path={file.path} disabled={!hasMaterials || busy} onSave={(status, note) => void action(() => api(`releases/runs/${run.id}`, json({ checkId: check.id, status, note }, 'PATCH')))} />))}{run.impact?.checks.map((check) => <CheckCard key={check.id} check={check} path="Связанные файлы" disabled={!hasMaterials || busy} onSave={(status, note) => void action(() => api(`releases/runs/${run.id}`, json({ checkId: check.id, status, note }, 'PATCH')))} />)}{!checks.length && <p className="release-card">Сценарии появятся после AI-анализа.</p>}</>}
            {tab === 'materials' && <section className="release-card release-materials"><h3>Пакет релиза</h3><p>Четыре файла сохраняются на сервере. Их можно скачать отдельно или одним ZIP-архивом.</p>{hasMaterials ? <><div className="release-downloads">{[['release-notes.md', 'Что нового', 'Черновик для пользователей'], ['changelog.md', 'Changelog', 'Изменения, риски и цитаты'], ['test-plan.md', 'План проверок', 'Шаги и сохранённые результаты'], ['readiness.json', 'Готовность', 'SHA, покрытие и статусы']].map(([name, title, description]) => <a key={name} href={`/api/releases/runs/${run.id}/artifacts/${name}`} download><strong>{title} ↓</strong><span>{description}</span><code>{name}</code></a>)}</div><h3>Черновик «Что нового»</h3>{run.files.some((file) => file.userNote) ? <ul>{run.files.filter((file) => file.userNote).map((file) => <li key={file.path}>{file.userNote}</li>)}</ul> : <p>Пользовательские изменения не выделены. Проверьте внутренний changelog.</p>}<label className="release-review-confirm"><input type="checkbox" checked={run.reviewed} disabled={busy} onChange={(event) => void action(() => api(`releases/runs/${run.id}`, json({ reviewed: event.target.checked }, 'PATCH')))} /><span>Я проверил выводы AI, риски и тексты релиза.</span></label><p className="release-caption">Пакет будет готов после подтверждения анализа и прохождения всех проверок при полном покрытии. Публикацию приложения вы выполняете отдельно.</p></> : <p>Дождитесь завершения анализа, чтобы скачать материалы.</p>}</section>}
          </div>
        </>}
      </main>
    </div>
    {folderPicker && <FolderPicker initialPath={projects.find((project) => project.id === projectId)?.root} onClose={() => setFolderPicker(false)} onOpen={(result) => { setProjects(result.projects); setProjectId(result.project.id); setFolderPicker(false) }} />}
  </div>
}

function CheckCard({ check, path, disabled, onSave }: { check: ReleaseCheck; path: string; disabled: boolean; onSave: (status: ReleaseCheck['status'], note: string) => void }) {
  const [note, setNote] = useState(check.note)
  const [status, setStatus] = useState(check.status)
  useEffect(() => { setNote(check.note); setStatus(check.status) }, [check.note, check.status])
  return <section className="release-card release-check"><small>{path}</small><h3>{check.text}</h3><ol>{check.steps.map((step, index) => <li key={index}>{step}</li>)}</ol><p><b>Ожидается:</b> {check.expected}</p><label>Результат<select disabled={disabled} value={status} onChange={(event) => setStatus(event.target.value as ReleaseCheck['status'])}><option value="pending">Не проверено</option><option value="passed">Пройдено</option><option value="failed">Не пройдено</option></select></label><label>Фактический результат<textarea disabled={disabled} maxLength={2000} rows={2} value={note} placeholder="Что произошло при проверке" onChange={(event) => setNote(event.target.value)} /></label><button disabled={disabled || note === check.note && status === check.status} onClick={() => onSave(status, note)}>Сохранить результат</button><small>Сохранено: {check.status === 'passed' ? 'пройдено' : check.status === 'failed' ? 'не пройдено' : 'не проверено'} · источники: {check.evidenceIds.join(', ')}</small></section>
}
