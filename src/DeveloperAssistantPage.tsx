import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import DeveloperFolderPicker from './DeveloperFolderPicker'
import type { DeveloperAnswer, DeveloperProject, DeveloperProvider, DeveloperStatus } from './developer-types'
import './chat.css'
import './developer-assistant.css'

type Message = { input: string; result: DeveloperAnswer }
const storageKey = 'deepchat-developer-day31'
function limitHistory(messages: Message[]) {
  const counts = new Map<string, number>()
  return messages.slice().reverse().filter(({ result }) => {
    const id = result.projectId || 'current', count = (counts.get(id) || 0) + 1
    counts.set(id, count); return count <= 20
  }).reverse()
}
async function readResponse<T>(response: Response): Promise<T> {
  let data
  try { data = await response.json() } catch { throw new Error('Сервер прервал ответ. Повторите запрос.') }
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос.')
  return data as T
}
export default function DeveloperAssistantPage() {
  const [status, setStatus] = useState<DeveloperStatus>()
  const [projects, setProjects] = useState<DeveloperProject[]>([])
  const [projectId, setProjectId] = useState('current')
  const [folderPicker, setFolderPicker] = useState(false)
  const activeProject = useRef(projectId)
  activeProject.current = projectId
  const [messages, setMessages] = useState<Message[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem(storageKey) || '[]'); return Array.isArray(saved) ? limitHistory(saved.filter((item) => typeof item?.input === 'string' && typeof item?.result?.answer === 'string' && Array.isArray(item.result.grounding?.citations) && Array.isArray(item.result.context?.receipts))) : [] } catch { return [] }
  })
  const [input, setInput] = useState('')
  const [provider, setProvider] = useState<DeveloperProvider>('cloud')
  const [busy, setBusy] = useState<'index' | 'help' | null>(null)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const composer = useRef<HTMLTextAreaElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  function selectProject(id: string) {
    setProjectId(id)
    try { localStorage.setItem('deepchat-developer-project', id) } catch { /* Selection works without storage. */ }
  }
  async function refresh() {
    const requestedProject = projectId
    try { const data = await readResponse<DeveloperStatus>(await fetch(`/api/developer/status?projectId=${encodeURIComponent(requestedProject)}`)); if (mounted.current && activeProject.current === requestedProject) setStatus(data) }
    catch (err) { if (mounted.current && activeProject.current === requestedProject) setError(err instanceof Error ? err.message : String(err)) }
  }
  useEffect(() => {
    mounted.current = true
    const abort = new AbortController()
    void fetch('/api/developer/projects', { signal: abort.signal }).then(readResponse<{ projects: DeveloperProject[]; defaultProjectId: string }>).then((data) => {
      if (!mounted.current) return
      let saved: string | null = null
      try { saved = localStorage.getItem('deepchat-developer-project') } catch { /* Use server default. */ }
      setProjects(data.projects); setProjectId(data.projects.some(({ id }) => id === saved) ? saved! : data.defaultProjectId)
    }).catch((err) => { if (mounted.current && !abort.signal.aborted) setError(err instanceof Error ? err.message : String(err)) })
    return () => { mounted.current = false; abort.abort(); controller.current?.abort() }
  }, [])
  useEffect(() => { if (projects.length) { setStatus(undefined); setError(''); setNotice(''); setInput(''); void refresh() } }, [projectId, projects.length])
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(limitHistory(messages))) } catch { /* Chat works without storage. */ } }, [messages])
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, pending])
  const visibleMessages = messages.filter(({ result }) => (result.projectId || 'current') === projectId)
  const indexReady = Boolean(status?.projectId === projectId && status.index && !status.stale)
  async function run(operation: 'index' | 'help', text = input) {
    if (controller.current || operation === 'help' && !text.trim()) return
    const abort = new AbortController(); controller.current = abort
    setBusy(operation); setError(''); setNotice('')
    if (operation === 'help') { setPending(text.trim()); setInput('') }
    try {
      const response = await fetch(`/api/developer/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(operation === 'index' ? { projectId } : { input: text.trim(), provider, projectId }), signal: abort.signal })
      if (operation === 'index') {
        const result = await readResponse<{ index: { sourceCount: number; chunkCount: number } }>(response)
        if (mounted.current) setNotice(`Индекс готов: ${result.index.sourceCount} документов, ${result.index.chunkCount} чанков.`)
      } else {
        const result = await readResponse<DeveloperAnswer>(response)
        if (mounted.current) setMessages((items) => limitHistory([...items, { input: text.trim(), result }]))
      }
    } catch (err) {
      if (mounted.current) { setError(abort.signal.aborted ? 'Запрос остановлен.' : err instanceof Error ? err.message : String(err)); if (operation === 'help') setInput(text) }
    } finally { controller.current = null; if (mounted.current) { setBusy(null); setPending(''); await refresh() } }
  }
  return <section className="rag-chat-page developer-page" aria-label="Ассистент разработчика">
    <aside className="rag-chat-history developer-context">
      <button className="rag-chat-new" onClick={() => { setMessages((items) => items.filter(({ result }) => (result.projectId || 'current') !== projectId)); setError(''); setNotice('') }} disabled={Boolean(busy)}>＋ Очистить историю</button>
      <h2>Контекст проекта</h2><strong>{status?.project || 'Project'}</strong>
      <small className="developer-root">{projects.find(({ id }) => id === projectId)?.root}</small>
      <p className={`developer-index-state${indexReady ? ' ready' : ''}`}>{indexReady ? '● Индекс актуален' : status?.stale ? '● Нужно обновить индекс' : '○ Индекс не создан'}</p>
      {status?.index && <small>{status.index.sourceCount} документов · {status.index.chunkCount} чанков<br />{new Date(status.index.createdAt).toLocaleString('ru-RU')}</small>}
      <button className="developer-index-button" disabled={Boolean(busy)} onClick={() => void run('index')}>{busy === 'index' ? 'Индексация…' : status?.index ? 'Обновить индекс' : 'Индексировать'}</button>
      <details className="developer-documents"><summary>Документы · {status?.documents.length || 0}</summary><ul>{status?.documents.map((path) => <li key={path}>{path}</li>)}</ul></details>
      <div className="developer-mcp-badge">MCP · Git-контекст<small>текущая ветка · список веток · файлы · изменения</small></div>
      <span className="rag-chat-history-note">Каждый вопрос независим. Последние 20 ответов каждого проекта сохраняются в браузере. Контекст фиксируется на момент запроса.</span>
    </aside>
    <div className="rag-chat-workspace">
      <header className="rag-chat-header"><div><strong>Ассистент разработчика <span>Day 31</span></strong><small>{status?.project || 'Документация проекта'} + текущий Git-контекст</small></div><div className="developer-header-actions"><button disabled={Boolean(busy)} onClick={() => setFolderPicker(true)}>▱ Открыть папку</button><select aria-label="Проект ассистента" value={projectId} disabled={Boolean(busy) || !projects.length} onChange={(event) => selectProject(event.target.value)}>{projects.map(({ id, name, root }) => <option key={id} value={id} title={root}>{name}</option>)}</select><select aria-label="Модель ассистента" value={provider} disabled={Boolean(busy)} onChange={(event) => setProvider(event.target.value as DeveloperProvider)}><option value="cloud">DeepSeek · облако</option><option value="local">Ollama · локально</option></select><button onClick={() => void refresh()} disabled={Boolean(busy)} aria-label="Обновить состояние">↻</button></div></header>
      <div className="rag-chat-scroll"><div className="rag-chat-thread">
        {!visibleMessages.length && !pending && <div className="rag-chat-empty"><div className="rag-chat-mark">⌘</div><h1>Разберёмся в {projects.find(({ id }) => id === projectId)?.name || 'проекте'}</h1><p>Задайте вопрос через <code>/help</code>.<br />Ответ опирается на документацию, цитаты и MCP.</p><div className="rag-chat-examples">{['/help', '/help Какие модули есть в проекте и за что отвечают?', '/help Какие есть локальные и удалённые ветки в репозитории?', '/help Какая сейчас ветка и какие файлы изменены?', '/help Как устроена авторизация и какие API она использует?'].map((example) => <button key={example} onClick={() => { setInput(example); composer.current?.focus() }}><strong>{example}</strong></button>)}</div></div>}
        {visibleMessages.map(({ input: question, result }, index) => <div key={index}><div className="rag-chat-user"><p>{question}</p></div><article className="rag-chat-assistant"><span className="rag-chat-avatar">D</span><div className="rag-chat-answer"><div className="rag-chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{result.answer}</ReactMarkdown></div><small className="developer-answer-meta">{result.model} · {(result.durationMs / 1000).toFixed(1)} сек. · {result.grounding.verification.method === 'tool-data' ? 'Данные MCP · точные имена' : result.grounding.status === 'answered' ? result.grounding.verification.taskCheck?.answersQuestion ? 'Ответ и цитаты проверены' : 'Цитаты проверены' : 'Недостаточно подтверждений'}</small>
          {result.grounding.citations.length > 0 && <details className="rag-chat-sources"><summary>Источники · {result.grounding.citations.length}</summary><div>{result.grounding.citations.map((citation) => <section key={citation.id}><strong>[{citation.id}] {citation.source}</strong><small>{citation.section}</small><blockquote>{citation.quote}</blockquote></section>)}</div></details>}
          <details className="developer-receipts"><summary>MCP · {new Date(result.context.capturedAt).toLocaleString('ru-RU')}</summary>{result.context.receipts.map((receipt) => <section key={receipt.name}><strong>{receipt.name}</strong><pre>{JSON.stringify(receipt.result, null, 2)}</pre></section>)}</details>
        </div></article></div>)}
        {pending && <><div className="rag-chat-user"><p>{pending}</p></div><p className="rag-chat-thinking" role="status">MCP-контекст → поиск документов → ответ и проверка цитат…</p></>}<div ref={bottom} />
      </div></div>
      <div className="rag-chat-composer-area">
        {!indexReady && <p className="developer-notice">{status?.stale ? 'Документация изменилась. Обновите индекс.' : 'Постройте индекс документации, чтобы начать.'} <button disabled={Boolean(busy)} onClick={() => void run('index')}>{busy === 'index' ? 'Индексация…' : 'Индексировать'}</button></p>}
        {provider === 'cloud' && !status?.cloudAvailable && <p className="developer-notice">Для DeepSeek нужен DEEPSEEK_API_KEY. Можно выбрать Ollama.</p>}
        {error && <p className="rag-chat-error" role="alert">{error}</p>}{notice && <p className="developer-notice" role="status">{notice}</p>}
        <form className="rag-chat-composer" onSubmit={(event) => { event.preventDefault(); void run('help') }}><textarea ref={composer} aria-label="Вопрос о проекте" placeholder="/help Как устроен проект?" value={input} maxLength={4000} disabled={Boolean(busy)} rows={2} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />{busy ? <button type="button" aria-label="Остановить запрос" onClick={() => controller.current?.abort()}>■</button> : <button type="submit" aria-label="Отправить вопрос" disabled={!input.trim() || !indexReady || provider === 'cloud' && !status?.cloudAvailable}>↑</button>}</form>
        <p>{provider === 'local' ? 'Ollama · локальная обработка' : 'DeepSeek · фрагменты документов и Git-контекст отправляются в облако'} · Enter — отправить</p>
      </div>
    </div>
    {folderPicker && <DeveloperFolderPicker initialPath={projects.find(({ id }) => id === projectId)?.root} onClose={() => setFolderPicker(false)} onOpen={(result) => { setProjects(result.projects); selectProject(result.project.id); setFolderPicker(false); if (result.project.id === projectId) void refresh() }} />}
  </section>
}
