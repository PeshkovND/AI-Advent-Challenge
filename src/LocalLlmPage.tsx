import { useEffect, useRef, useState, type FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './local-llm.css'
import { selectLocalContext } from './local-llm-context'

type Message = { role: 'user' | 'assistant'; content: string; failed?: boolean }
type Status = { model: string; context: number; maxTokens: number; ready: boolean; error?: string; limits?: { requestsPerMinute: number; maxConcurrentRequests: number; timeoutMs: number; maxBodyBytes: number; maxQueueSize: number; queueTimeoutMs: number } }
const historyKey = 'deepchat-local-llm-history-v1'
function restoreHistory(storageKey: string): Message[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '[]')
    return Array.isArray(value) ? value.filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').map((m) => ({ role: m.role, content: m.content, failed: Boolean(m.failed) })) : []
  } catch { return [] }
}
export default function LocalLlmPage({ apiKey, privateService = false, onUnauthorized }: { apiKey?: string; privateService?: boolean; onUnauthorized?: () => void } = {}) {
  const storageKey = privateService ? 'deepchat-private-llm-history-v1' : historyKey
  const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  const [status, setStatus] = useState<Status>()
  const [messages, setMessages] = useState<Message[]>(() => restoreHistory(storageKey))
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [contextInfo, setContextInfo] = useState('')
  const [queuePosition, setQueuePosition] = useState<number | null>(null)
  useEffect(() => { if (!busy) { try { localStorage.setItem(storageKey, JSON.stringify(messages)) } catch { setNotice('Не удалось сохранить историю в браузере. Текущий диалог остаётся доступен до закрытия страницы.') } } }, [messages, busy, storageKey])
  const controller = useRef<AbortController | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  async function refresh() {
    try {
      const response = await fetch('/api/local-llm/status', { headers: authHeaders })
      if (response.status === 401) { onUnauthorized?.(); return }
      setStatus(await response.json()); setError('')
    }
    catch { setError('Не удалось подключиться к серверу приложения.') }
  }
  useEffect(() => { void refresh(); return () => controller.current?.abort() }, [apiKey])
  useEffect(() => { const panel = scroll.current; if (panel) panel.scrollTop = panel.scrollHeight }, [messages])
  async function send(event: FormEvent) {
    event.preventDefault()
    const prompt = input.trim()
    if (!prompt || controller.current) return
    const history = messages.filter((m) => !m.failed && m.content.trim()).map(({ role, content }) => ({ role, content }))
    let selected: ReturnType<typeof selectLocalContext>
    try { selected = selectLocalContext([...history, { role: 'user' as const, content: prompt }], status?.context || 32768, status?.maxTokens || 4096) }
    catch (err) { setError(err instanceof Error ? err.message : 'Вопрос слишком большой.'); return }
    const request = selected.messages
    setContextInfo(`В модель отправлено ${request.length} сообщений; вне окна: ${selected.dropped}. Консервативная оценка входа: ${selected.estimatedTokens} / ${selected.budget}.`)
    const index = messages.length + 1
    setMessages([...messages, { role: 'user', content: prompt }, { role: 'assistant', content: '' }])
    setInput(''); setBusy(true); setError(''); setNotice(''); setQueuePosition(null)
    const abort = new AbortController(); controller.current = abort
    let answer = '', completed = false
    try {
      const response = await fetch('/api/local-llm/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders }, body: JSON.stringify({ messages: request }), signal: abort.signal })
      if (response.status === 401) { onUnauthorized?.(); throw new Error('Ключ доступа недействителен.') }
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Ошибка локального запроса.') }
      if (!response.body) throw new Error('Пустой поток ответа.')
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = ''
      const consume = (line: string) => {
        if (!line.trim()) return
        const chunk = JSON.parse(line)
        if (chunk.error) throw new Error(chunk.error)
        if (chunk.queueInfo) setQueuePosition(chunk.queueInfo.state === 'queued' ? chunk.queueInfo.position : null)
        answer += chunk.message?.content || ''
        setMessages((items) => items.map((m, i) => i === index ? { ...m, content: answer } : m))
        if (chunk.done) {
          completed = true
          if (chunk.done_reason === 'length') setNotice('Достигнут лимит ответа. Частичный текст сохранён; можно задать следующий вопрос.')
        }
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
      if (!completed) throw new Error('Ответ прервался. Попробуйте снова.')
      if (!answer.trim()) throw new Error('Модель вернула пустой ответ.')
    } catch (err) {
      const text = abort.signal.aborted ? 'Запрос остановлен.' : err instanceof Error ? err.message : 'Ошибка запроса.'
      setError(text)
      setMessages((items) => items.map((m, i) => i === index || i === index - 1 ? { ...m, failed: true } : m))
    } finally { controller.current = null; setBusy(false); setQueuePosition(null) }
  }
  function clearChat() {
    setMessages([]); setInput(''); setError(''); setNotice(''); setContextInfo('')
    composer.current?.focus()
  }
  const title = messages.find((message) => message.role === 'user')?.content || 'Текущий диалог'
  const examples = [
    { title: 'Разобраться в сложном', prompt: 'Объясни разницу между процессом и потоком в ОС. Приведи понятный пример.' },
    { title: 'Написать код', prompt: 'Напиши TypeScript-функцию, которая удаляет дубликаты объектов по id и сохраняет первое вхождение. Объясни сложность.' },
  ]
  return <section className="rag-chat-page local-llm-page" aria-label="Чат с локальной моделью">
    <aside className="rag-chat-history" aria-label="Локальная история">
      <button className="rag-chat-new" onClick={clearChat} disabled={busy}>＋ Очистить чат</button>
      <p>Текущий диалог</p>
      <div className="rag-chat-history-list"><div className="rag-chat-history-row active"><span className="local-llm-history-title" title={title}>{title}</span></div></div>
      <div className="local-llm-device"><span className={`local-llm-status-dot${status?.ready ? ' ready' : ''}`} /><div><strong>{privateService ? 'На домашнем сервере' : 'На вашем Mac'}</strong><small>{status?.ready ? 'Ollama подключена' : 'Проверить подключение'}</small></div></div>
      <span className="rag-chat-history-note">История сохраняется в этом браузере. В контексте остаются последние сообщения.</span>
    </aside>
    <div className="rag-chat-workspace">
      <header className="rag-chat-header"><div><strong>{privateService ? 'Приватная LLM' : 'Локальная LLM'} <span>Day {privateService ? '30' : '27'}</span></strong><small>{status?.model || 'Ollama'} · {status ? `${Math.round(status.context / 1024)}K контекста` : 'Подключение…'} · без облака</small></div>
        <div className="rag-chat-header-actions">
          {privateService && <button className="private-llm-logout" onClick={onUnauthorized} disabled={busy}>Выйти</button>}
          <button className="local-llm-refresh" onClick={() => void refresh()} disabled={busy} aria-label="Проверить подключение" title="Проверить подключение">↻</button>
          <button className="rag-chat-mobile-new" onClick={clearChat} disabled={busy} aria-label="Очистить чат" title="Очистить чат">＋</button>
          <details className="rag-chat-memory"><summary>{privateService ? 'Лимиты' : 'Контекст'} <span>{status ? `${Math.round(status.context / 1024)}K` : '…'}</span></summary><div><h2>Память диалога</h2><section><h3>Скользящее окно</h3><p>Модель получает последние сообщения. Старые остаются в истории, но могут не входить в контекст.</p></section><section><h3>Последний запрос</h3><p>{contextInfo || 'Задайте вопрос, чтобы увидеть размер контекста.'}</p></section>{status?.limits && <section><h3>Ограничения сервиса</h3><p>{status.limits.requestsPerMinute} запросов в минуту · {status.limits.maxConcurrentRequests} генерация одновременно · до {status.limits.maxQueueSize} запросов в очереди · ожидание до {status.limits.queueTimeoutMs / 1000} сек. · до {status.limits.timeoutMs / 1000} сек. на ответ · до {status.limits.maxBodyBytes / 1024 / 1024} МБ на запрос.</p></section>}<p>Для ответа зарезервировано {status?.maxTokens || 4096} токенов. Размер входа оценивается с запасом.</p></div></details>
        </div>
      </header>
      <div className="rag-chat-scroll" ref={scroll}><div className="rag-chat-thread">
        {!messages.length && <div className="rag-chat-empty"><div className="rag-chat-mark">◎</div><h1>С чего начнём?</h1><p>Обсудим идею, разберём задачу или напишем код.<br />Модель работает {privateService ? 'на домашнем сервере' : 'на вашем Mac'}, а история остаётся в браузере.</p><div className="rag-chat-examples">{examples.map((example) => <button key={example.title} onClick={() => { setInput(example.prompt); composer.current?.focus() }}><strong>{example.title}</strong><span>{example.prompt}</span></button>)}</div></div>}
        {messages.map((message, index) => message.role === 'user' ? <div className="rag-chat-user" key={index}><p>{message.content}</p></div> : <article className="rag-chat-assistant" key={index}><span className="rag-chat-avatar" aria-label="Локальная модель">L</span><div className="rag-chat-answer"><div className="rag-chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content || (busy && index === messages.length - 1 ? queuePosition !== null ? `Ожидание в очереди · позиция ${queuePosition}` : 'Модель отвечает…' : 'Ответ не получен.')}</ReactMarkdown></div>{message.failed && <small className="local-llm-message-note">Ответ не завершён</small>}</div></article>)}
        <div ref={bottom} />
      </div></div>
      <div className="rag-chat-composer-area">
        {status?.error && <p className="rag-chat-error" role="alert">{status.error}</p>}
        {error && <p className="rag-chat-error" role="alert">{error}</p>}
        {notice && <p className="local-llm-notice" role="status">{notice}</p>}
        <form className="rag-chat-composer" onSubmit={(event) => void send(event)}><textarea ref={composer} aria-label="Сообщение локальной модели" value={input} onChange={(event) => setInput(event.target.value)} disabled={busy} placeholder="Спросите локальную модель…" rows={2} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />{busy ? <button type="button" aria-label={queuePosition !== null ? "Отменить ожидание" : "Остановить генерацию"} title={queuePosition !== null ? "Отменить ожидание" : "Остановить генерацию"} onClick={() => controller.current?.abort()}>■</button> : <button type="submit" aria-label="Отправить сообщение" title="Отправить сообщение" disabled={!input.trim() || !status?.ready}>↑</button>}</form>
        <p>Enter — отправить · Shift+Enter — новая строка. Ответы локальной модели могут содержать ошибки.</p>
      </div>
    </div>
  </section>
}
