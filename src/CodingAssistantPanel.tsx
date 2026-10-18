import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CodingRun } from './coding-types'
import type { DeveloperProject } from './developer-types'

async function response<T>(request: Promise<Response>) {
  const res = await request, body = await res.json()
  if (!res.ok) throw new Error(body.error || 'Ошибка файловой задачи.')
  return body as T
}
const historyKey = 'deepchat-coding-day34'
function activityLabel(step?: string) {
  const [tool, detail] = (step || '').split(' · ')
  const file = detail?.split(' → ')[0].split('/').pop()
  switch (tool) {
    case 'list_files': return 'Изучает структуру проекта'
    case 'search_files': return detail ? `Ищет «${detail}»` : 'Ищет по файлам'
    case 'read_file': return file ? `Читает ${file}` : 'Читает файл'
    case 'write_file': return file ? `Готовит ${file}` : 'Готовит файл'
    case 'replace_text': return file ? `Редактирует ${file}` : 'Готовит изменения'
    case 'get_diff': return 'Проверяет diff'
    case 'review_changes': return 'Проверяет результат'
    case 'checkpoint': return 'Обновляет план работы'
    case 'invalid_model_response': return 'Уточняет следующее действие'
    default: return 'Работает над задачей…'
  }
}
export default function CodingAssistantPanel({ projectId, projects, onSelect, onFolder, onKnowledge }: {
  projectId: string; projects: DeveloperProject[]; onSelect: (id: string) => void; onFolder: () => void; onKnowledge: () => void
}) {
  const [runs, setRuns] = useState<CodingRun[]>(() => {
    try { return JSON.parse(localStorage.getItem(historyKey) || '[]').filter((run: CodingRun) => run.id && run.projectId && Array.isArray(run.changes) && Array.isArray(run.steps)) } catch { return [] }
  })
  const [goal, setGoal] = useState('')
  const [provider, setProvider] = useState<'local' | 'cloud'>('cloud')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState('')
  const [liveSteps, setLiveSteps] = useState<string[]>([])
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const visible = runs.filter((run) => run.projectId === projectId)
  const project = projects.find(({ id }) => id === projectId)
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => { setGoal(''); setError('') }, [projectId])
  useEffect(() => { try { localStorage.setItem(historyKey, JSON.stringify(runs.slice(-20))) } catch { /* Tasks are also stored on the server. */ } }, [runs])
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }) }, [runs, pending])
  async function execute(id?: string) {
    if (controller.current || !id && !goal.trim()) return
    const abort = new AbortController(); controller.current = abort
    const input = goal.trim()
    setBusy(true); setError(''); setLiveSteps([]); setPending(id ? 'Применение подготовленных изменений…' : input)
    if (!id) setGoal('')
    try {
      const request = fetch(id ? `/api/developer/tasks/${id}/apply` : '/api/developer/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(!id ? { Accept: 'text/event-stream' } : {}) }, signal: abort.signal,
        body: JSON.stringify(id ? { projectId } : { projectId, goal: input, provider, ...(visible.length ? { previousRunId: visible[visible.length - 1].id } : {}) }),
      })
      let run: CodingRun
      if (id) run = await response<CodingRun>(request)
      else {
        const res = await request
        if (!res.ok || !res.body) throw new Error((await res.json()).error || 'Сервер не вернул поток задачи.')
        const reader = res.body.getReader(), decoder = new TextDecoder()
        let buffer = '', completed: CodingRun | undefined
        try {
          for (;;) {
            const { value, done } = await reader.read()
            buffer += decoder.decode(value, { stream: !done })
            let end: number
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
              const event = frame.split('\n').find((line) => line.startsWith('event: '))?.slice(7)
              const payload = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
              if (!payload) continue
              const data = JSON.parse(payload)
              if (event === 'error') throw new Error(data.error)
              if (event === 'result') completed = data as CodingRun
              if (event === 'step') setLiveSteps((items) => [...items, `${data.tool}${data.path ? ` · ${data.path}` : data.query ? ` · ${data.query}` : ''}${data.error ? ` → ${data.error}` : ''}`])
            }
            if (done) break
          }
        } finally { reader.releaseLock() }
        if (!completed) throw new Error('Поток прерван до результата. Файлы проекта не изменены.')
        run = completed
      }
      setRuns((items) => id ? items.map((item) => item.id === id ? run : item) : [...items, run].slice(-20))
    } catch (err) {
      setError(abort.signal.aborted ? id ? 'Ответ прерван. Обновите статус задачи: применение могло завершиться.' : 'Задача остановлена. Файлы проекта не изменены.' : err instanceof Error ? err.message : String(err))
      if (!id) setGoal(input)
    } finally { controller.current = null; setBusy(false); setPending('') }
  }
  async function refreshRun(id: string) {
    try {
      const run = await response<CodingRun>(fetch(`/api/developer/tasks/${id}?projectId=${encodeURIComponent(projectId)}`))
      setRuns((items) => items.map((item) => item.id === id ? { ...run, projectId } : item)); setError('')
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }
  function download(run: CodingRun) {
    const url = URL.createObjectURL(new Blob([run.changes.map(({ diff }) => diff).join('\n')], { type: 'text/x-diff;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `task-${run.id}.patch`; link.click(); URL.revokeObjectURL(url)
  }
  return <section className="rag-chat-page developer-page coding-page" aria-label="Кодинг-ассистент">
    <aside className="rag-chat-history developer-context">
      <button className="rag-chat-new" disabled={busy} onClick={() => setRuns((items) => items.filter((run) => run.projectId !== projectId))}>＋ Новая беседа</button>
      <h2>Файлы проекта</h2><strong>{project?.name || 'Проект'}</strong><small className="developer-root">{project?.root}</small>
      <p className="developer-index-state ready">● Прямой доступ к актуальным файлам</p>
      <p>Задайте цель. Ассистент сам найдёт и прочитает нужные файлы, подготовит правки и проверит diff.</p>
      <div className="developer-mcp-badge">Инструменты файлов<small>список · поиск · чтение · создание · замена · diff</small></div>
      <span className="rag-chat-history-note">Индекс не требуется. Правки сохраняются после «Применить изменения». История задач и diff доступны после перезапуска сервера.</span>
      <button className="developer-index-button" disabled={busy} onClick={onKnowledge}>Вопросы по документации · RAG</button>
    </aside>
    <div className="rag-chat-workspace">
      <header className="rag-chat-header"><div><strong>Кодинг-ассистент <span>Day 34</span></strong><small>Исследует проект и готовит изменения файлов</small></div><div className="developer-header-actions">
        <button disabled={busy} onClick={onFolder}>▱ Открыть папку</button>
        <button disabled={busy} onClick={() => setRuns((items) => items.filter((run) => run.projectId !== projectId))}>Новая беседа</button>
        <button disabled={busy} onClick={onKnowledge}>Документация · RAG</button>
        <select aria-label="Проект ассистента" disabled={busy || !projects.length} value={projectId} onChange={(event) => onSelect(event.target.value)}>{projects.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}</select>
        <select aria-label="Модель ассистента" disabled={busy} value={provider} onChange={(event) => setProvider(event.target.value as 'local' | 'cloud')}><option value="cloud">DeepSeek · облако</option><option value="local">Ollama · локально</option></select>
      </div></header>
      <div className="rag-chat-scroll"><div className="rag-chat-thread">
        {!visible.length && !pending && <div className="rag-chat-empty"><div className="rag-chat-mark">⌘</div><h1>Над чем поработаем в {project?.name || 'проекте'}?</h1><p>Опишите результат — ассистент выберет файлы и инструменты.</p><div className="rag-chat-examples">{[
          'Найди определения и все использования AuthService. Объясни поток авторизации со ссылками на файлы и строки.',
          'Сверь документацию клиентского API с кодом авторизации и обнови найденные расхождения.',
          'Исследуй архитектуру проекта и создай ADR о текущем подходе к внедрению зависимостей.',
          'Проверь, соответствуют ли реализации API описанным в документации инвариантам. Подготовь список расхождений.',
        ].map((text) => <button key={text} onClick={() => setGoal(text)}><strong>{text}</strong></button>)}</div></div>}
        {visible.map((run) => <div key={run.id}><div className="rag-chat-user"><p>{run.goal}</p></div><article className="rag-chat-assistant"><span className="rag-chat-avatar">D</span><div className="rag-chat-answer">
          <div className="rag-chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{run.answer}</ReactMarkdown></div>
          <small className="developer-answer-meta">{run.model} · {(run.durationMs / 1000).toFixed(1)} сек. · Прочитано файлов: {run.readFiles.length} · {run.status === 'applied' ? 'Изменения сохранены' : run.status === 'preview' ? 'Diff подготовлен' : 'Анализ завершён'}</small>
          {run.changes.length > 0 && <div className="coding-changes"><strong>Изменённые файлы · {run.changes.length}</strong>{run.changes.map(({ path, diff }) => <details key={path} open><summary>{path}</summary><pre>{diff}</pre></details>)}
            <div className="coding-actions"><button disabled={busy || run.status !== 'preview'} onClick={() => void execute(run.id)}>{run.status === 'applied' ? '✓ Сохранено' : 'Применить изменения'}</button><button onClick={() => download(run)}>Скачать diff</button><button disabled={busy} onClick={() => void refreshRun(run.id)}>Обновить статус</button></div>
          </div>}
          <details className="developer-receipts"><summary>Действия ассистента · {run.steps.length}</summary>{run.steps.map((step, index) => <section key={index}><strong>{index + 1}. {step.tool}</strong><pre>{JSON.stringify({ arguments: step.arguments, result: step.result }, null, 2)}</pre></section>)}</details>
          <small className="developer-answer-meta">Задача {run.id}</small>
        </div></article></div>)}
        {pending && <div className="coding-pending"><p>{pending}</p>
          <details className="coding-activity">
            <summary>
              <span className="coding-activity-spinner" aria-hidden="true" />
              <span className="coding-activity-label" role="status" aria-live="polite">{activityLabel(liveSteps[liveSteps.length - 1])}</span>
              {liveSteps.length > 0 && <span className="coding-activity-count">Шагов: {liveSteps.length}</span>}
              <svg className="coding-activity-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg>
            </summary>
            {liveSteps.length > 0 ? <ol className="coding-live-steps">{liveSteps.map((step, index) => <li key={index}>{step}</li>)}</ol>
              : <p className="coding-activity-empty">Ожидаем первое действие…</p>}
          </details>
        </div>}<div ref={bottom} />
      </div></div>
      <div className="rag-chat-composer-area">{error && <p className="rag-chat-error" role="alert">{error}</p>}
        <form className="rag-chat-composer" onSubmit={(event) => { event.preventDefault(); void execute() }}><textarea aria-label="Задача для кодинг-ассистента" placeholder="Опишите цель: что найти, проверить или изменить в проекте?" maxLength={4000} rows={2} disabled={busy} value={goal} onChange={(event) => setGoal(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />{busy ? <button type="button" aria-label="Остановить задачу" onClick={() => controller.current?.abort()}>■</button> : <button type="submit" aria-label="Выполнить задачу" disabled={!goal.trim() || !projects.length}>↑</button>}</form>
        <p>{provider === 'cloud' ? 'DeepSeek · выбранное содержимое файлов отправляется в облако' : 'Ollama · локальная обработка'} · Enter — выполнить</p>
      </div>
    </div>
  </section>
}
