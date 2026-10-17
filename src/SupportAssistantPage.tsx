import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SupportCatalog, SupportTicketDetails, SupportProvider, SupportStatus, SupportTicketRecord, SupportTicketStatus } from './support-types'
import './chat.css'
import './support-assistant.css'

async function read<T>(response: Response): Promise<T> {
  let data
  try { data = await response.json() } catch { throw new Error('Сервер прервал ответ. Данные тикета могли сохраниться — обновите его перед повтором.') }
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос.')
  return data as T
}
const labels: Record<SupportTicketStatus, string> = { open: 'Новое', in_progress: 'В работе', pending: 'Ожидает вашего ответа', escalated: 'Нужен оператор', resolved: 'Решено' }
const categories = { auth: 'Авторизация', profile: 'Профиль', features: 'Функции приложения', billing: 'Покупки и Pro', integrations: 'Интеграции', general: 'Общий вопрос' }
function TicketContext({ ticket }: { ticket?: SupportTicketRecord }) {
  if (!ticket) return <p>Выберите обращение, чтобы увидеть его сведения.</p>
  const fields = { device: 'Устройство', osVersion: 'Версия ОС', appVersion: 'Версия MyFamily', triedSteps: 'Уже пробовали' }
  return <><dl><div><dt>Категория</dt><dd>{categories[ticket.category]}</dd></div>
    {ticket.errorCode && <div><dt>Код ошибки</dt><dd>{ticket.errorCode}</dd></div>}
    {Object.entries(fields).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{ticket.details?.[key as keyof SupportTicketDetails] || 'Не указано'}</dd></div>)}
  </dl><p>Сведения со слов автора. Ассистент учитывает описание и переписку этого тикета.</p></>
}
const shortId = (id: string) => id.startsWith('TCK-') && id.length > 20 ? `TCK-${id.slice(4, 12).toUpperCase()}` : id
const time = (value: string) => new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const active = (ticket?: SupportTicketRecord) => !ticket?.deletedAt && (ticket?.job?.state === 'queued' || ticket?.job?.state === 'running')
const selectionKey = 'deepchat-support-ticket-selection'

export default function SupportAssistantPage() {
  const [catalog, setCatalog] = useState<SupportCatalog>()
  const [status, setStatus] = useState<SupportStatus>()
  const [ticketId, setTicketId] = useState('')
  const [ticket, setTicket] = useState<SupportTicketRecord>()
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('all')
  const [provider, setProvider] = useState<SupportProvider>('local')
  const providerChosen = useRef(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [indexing, setIndexing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('general')
  const [errorCode, setErrorCode] = useState('')
  const [details, setDetails] = useState<SupportTicketDetails>({})
  const [createError, setCreateError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SupportTicketRecord>()
  const [deleteError, setDeleteError] = useState('')
  const [reload, setReload] = useState(0)
  const mounted = useRef(true)
  const selected = useRef({ ticketId }); selected.current = { ticketId }
  const request = useRef<{ key: string; id: string } | undefined>(undefined)
  const posting = useRef(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const deleteDialog = useRef<HTMLDialogElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const ready = Boolean(status?.index && !status.stale)
  const processing = active(ticket)
  const ownTickets = catalog?.tickets.filter((item) => !item.deletedAt) || []
  const deletedTickets = catalog?.tickets.filter((item) => item.deletedAt) || []
  const visibleTickets = filter === 'deleted' ? deletedTickets : ownTickets.filter((item) => filter === 'all' || item.status === filter)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    const abort = new AbortController()
    let fetching = false
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden' || fetching) return
      fetching = true
      void fetch('/api/support/catalog?includeDeleted=true', { signal: abort.signal }).then(read<SupportCatalog>).then((data) => { if (!abort.signal.aborted) setCatalog(data) })
        .catch(() => { /* The explicit refresh and selected-ticket request show actionable errors. */ }).finally(() => { fetching = false })
    }, 10000)
    return () => { abort.abort(); clearInterval(timer) }
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    void fetch('/api/support/status', { signal: abort.signal }).then(read<SupportStatus>).then((data) => {
      if (abort.signal.aborted) return
      setStatus(data)
      if (!providerChosen.current) { setProvider('local'); providerChosen.current = true }
    }).catch((err) => { if (!abort.signal.aborted) setError(err.message) })
    void fetch('/api/support/catalog?includeDeleted=true', { signal: abort.signal }).then(read<SupportCatalog>).then((data) => {
      if (abort.signal.aborted) return
      setCatalog(data)
      const current = selected.current
      if (!current.ticketId) {
        let saved: { ticketId?: string } = {}
        try { saved = JSON.parse(sessionStorage.getItem(selectionKey) || '{}') } catch { /* Use first ticket. */ }
        setTicketId(data.tickets.find((item) => item.id === saved.ticketId && !item.deletedAt)?.id || data.tickets.find((item) => !item.deletedAt)?.id || '')
      }
    }).catch((err) => { if (!abort.signal.aborted) setError(err.message) })
    return () => abort.abort()
  }, [reload])
  useEffect(() => {
    if (!catalog) return
    try { sessionStorage.setItem(selectionKey, JSON.stringify({ ticketId })) } catch { /* Selection works without browser storage. */ }
  }, [ticketId, catalog])
  useEffect(() => {
    setTicket(undefined); setInput(''); setError(''); request.current = undefined
  }, [ticketId])
  useEffect(() => {
    if (!ticketId) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let first = true
    const poll = async () => {
      let interval = 10000
      try {
        if (first) setLoading(true)
        const data = await read<SupportTicketRecord>(await fetch(`/api/support/tickets/${encodeURIComponent(ticketId)}?includeDeleted=true`, { signal: abort.signal }))
        if (abort.signal.aborted) return
        setTicket((previous) => previous?.revision === data.revision && previous.job?.state === data.job?.state ? previous : data)
        interval = active(data) ? 2000 : 10000
        setCatalog((previous) => previous ? { ...previous, tickets: previous.tickets.map((item) => item.id === data.id ? { ...item, status: data.status, updatedAt: data.updatedAt, deletedAt: data.deletedAt } : item) } : previous)
      } catch (err) { if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err)) }
      finally { first = false; if (!abort.signal.aborted) { setLoading(false); timer = setTimeout(() => void poll(), interval) } }
    }
    void poll()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [ticketId, reload])
  useEffect(() => {
    if (createOpen) dialog.current?.showModal()
    else dialog.current?.close()
  }, [createOpen])
  useEffect(() => {
    if (deleteTarget) deleteDialog.current?.showModal()
    else deleteDialog.current?.close()
  }, [deleteTarget])
  useEffect(() => { if (ticket?.messages.length) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [ticket?.id, ticket?.messages.length])

  function selectFilter(value: string) {
    setFilter(value)
    const records = value === 'deleted' ? deletedTickets : ownTickets.filter((item) => value === 'all' || item.status === value)
    if (!records.some(({ id }) => id === ticketId)) setTicketId(records[0]?.id || '')
  }
  function openCreate() { request.current = undefined; setTitle(''); setDescription(''); setDetails({}); setErrorCode(''); setCategory('general'); setCreateError(''); setCreateOpen(true) }
  function requestId(key: string) {
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    return request.current.id
  }
  async function mutate(operation: 'create' | 'message' | 'retry' | 'status', nextStatus?: string) {
    if (posting.current || !catalog) return
    posting.current = true; setBusy(true); setError(''); setCreateError(''); setNotice('')
    const selection = { ...selected.current }
    const payload = operation === 'create' ? { title: title.trim(), description: description.trim(), category, details: Object.fromEntries(Object.entries(details).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value)), ...(errorCode.trim() ? { errorCode: errorCode.trim() } : {}), provider }
      : operation === 'message' ? { input: input.trim(), provider }
      : operation === 'retry' ? { provider } : { status: nextStatus, revision: ticket?.revision }
    const body = operation === 'status' ? payload : { ...payload, requestId: requestId(JSON.stringify({ operation, ticketId, ...payload })) }
    const path = operation === 'create' ? '/api/support/tickets' : `/api/support/tickets/${encodeURIComponent(ticketId)}/${operation === 'message' ? 'messages' : operation}`
    try {
      const response = await fetch(path, { method: operation === 'status' ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = operation === 'status' ? await read<SupportTicketRecord>(response) : (await read<{ ticket: SupportTicketRecord }>(response)).ticket
      if (!mounted.current) return
      request.current = undefined
      if (operation === 'create') {
        setCreateOpen(false); setFilter('all'); setTicketId(data.id); setTicket(data)
      } else if (selected.current.ticketId === selection.ticketId) {
        setTicket(data)
        if (operation === 'message') setInput('')
      }
      setReload((value) => value + 1)
    } catch (err) {
      if (mounted.current) {
        const message = err instanceof Error ? err.message : String(err)
        if (operation === 'create') setCreateError(message)
        else setError(message)
      }
    } finally { posting.current = false; if (mounted.current) setBusy(false) }
  }
  async function index() {
    if (indexing) return
    setIndexing(true); setError(''); setNotice('')
    try {
      const result = await read<{ index: { sourceCount: number; chunkCount: number } }>(await fetch('/api/support/index', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))
      if (mounted.current) { setNotice(`База знаний готова: ${result.index.sourceCount} документа, ${result.index.chunkCount} фрагментов.`); setReload((value) => value + 1) }
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : String(err)) }
    finally { if (mounted.current) setIndexing(false) }
  }
  async function lifecycle(operation: 'remove' | 'restore', target: SupportTicketRecord) {
    if (posting.current) return
    posting.current = true; setBusy(true); setError(''); setDeleteError(''); setNotice('')
    try {
      const response = await fetch(`/api/support/tickets/${encodeURIComponent(target.id)}${operation === 'restore' ? '/restore' : ''}`, {
        method: operation === 'remove' ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: target.revision }),
      })
      const data = await read<SupportTicketRecord>(response)
      if (!mounted.current) return
      setCatalog((previous) => previous ? { ...previous, tickets: previous.tickets.map((item) => item.id === data.id ? { ...item, status: data.status, updatedAt: data.updatedAt, deletedAt: data.deletedAt } : item) } : previous)
      setDeleteTarget(undefined); setFilter('all')
      if (operation === 'remove') {
        if (selected.current.ticketId === target.id) setTicketId(ownTickets.find(({ id }) => id !== target.id)?.id || '')
        setNotice('Тикет удалён. Его можно восстановить в разделе «Удалённые».')
      } else { setTicketId(data.id); setTicket(data); setNotice('Тикет восстановлен. Переписка сохранена.') }
      setReload((value) => value + 1)
    } catch (err) {
      if (!mounted.current) return
      const message = err instanceof Error ? err.message : String(err)
      if (operation === 'remove') setDeleteError(message)
      else setError(message)
      setReload((value) => value + 1)
    } finally { posting.current = false; if (mounted.current) setBusy(false) }
  }

  return <section className="rag-chat-page support-page" aria-label="Поддержка и тикеты">
    <aside className="support-sidebar">
      <div className="support-brand"><span>◉</span><div><strong>{catalog?.product || 'Поддержка'}</strong><small>Поддержка пользователей</small></div></div>

      <button className="support-create-button" disabled={!catalog || busy} onClick={openCreate}>＋ Создать тикет</button>
      <div className="support-ticket-heading"><span>Все обращения</span><small>{ownTickets.length}</small></div>
      <select aria-label="Фильтр тикетов по статусу" value={filter} onChange={(event) => selectFilter(event.target.value)}><option value="all">Все статусы</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="deleted">Удалённые ({deletedTickets.length})</option></select>
      <div className="support-ticket-list" role="group" aria-label="Тикеты">
        {!visibleTickets.length && <p className="support-list-empty">{filter === 'deleted' ? 'Удалённых тикетов нет.' : ownTickets.length ? 'Нет обращений с этим статусом.' : 'Опишите проблему в новом тикете.'}</p>}
        {visibleTickets.map((item) => <button key={item.id} className={ticketId === item.id ? 'selected' : ''} onClick={() => setTicketId(item.id)}><small>{shortId(item.id)}{item.updatedAt && <span> · {time(item.updatedAt)}</span>}</small><strong>{item.title}</strong><span className={`support-ticket-state state-${item.deletedAt ? 'deleted' : item.status}`}>{item.deletedAt ? 'Удалён' : labels[item.status]}</span></button>)}
      </div>
      <div className="support-account"><h2>Контекст тикета</h2><TicketContext ticket={ticket} /></div>
      <div className="support-knowledge"><h2>База знаний</h2><p className={ready ? 'ready' : ''}>{ready ? '● Индекс актуален' : status?.stale ? '● Требуется обновление' : '○ Индекс не создан'}</p><small>{status?.index ? `Документов: ${status.index.sourceCount} · фрагментов: ${status.index.chunkCount}` : 'FAQ · документация продукта'}</small><button disabled={indexing || processing} onClick={() => void index()}>{indexing ? 'Индексируем…' : 'Обновить базу знаний'}</button></div>
    </aside>
    <div className="rag-chat-workspace">
      <header className="rag-chat-header support-header"><div><strong>{ticket?.title || 'Все обращения'} <span>Day 33</span></strong><small>{ticket ? `${catalog?.product || 'Поддержка'} · ${shortId(ticket.id)}` : 'Создайте тикет — ассистент найдёт решение и ответит в нём'}</small></div><div className="support-header-actions"><select aria-label="Модель поддержки" value={provider} disabled={busy} onChange={(event) => { providerChosen.current = true; setProvider(event.target.value as SupportProvider) }}><option value="local">Ollama · локально</option><option value="cloud" disabled={!status?.cloudAvailable}>DeepSeek · облако</option></select><button aria-label="Обновить тикеты" title="Обновить" onClick={() => { setError(''); setReload((value) => value + 1) }}>↻</button></div></header>
      {ticket && <div className="support-ticket-toolbar">
        <span className={`support-ticket-state state-${ticket.deletedAt ? 'deleted' : ticket.status}`}>{ticket.deletedAt ? 'Удалён' : labels[ticket.status]}</span>
        <span>{ticket.deletedAt ? 'Удалён ' + time(ticket.deletedAt) : 'Создан ' + time(ticket.createdAt)}</span>
        {ticket.deletedAt ? <button className="support-restore-button" disabled={busy} onClick={() => void lifecycle('restore', ticket)}>Восстановить тикет</button> : <>
          <label>Статус <select aria-label="Статус тикета" value={ticket.status} disabled={busy || processing} onChange={(event) => void mutate('status', event.target.value)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value} disabled={value === 'in_progress'}>{label}</option>)}</select></label>
          {ticket.status !== 'resolved' && <button disabled={busy || processing} onClick={() => void mutate('status', 'resolved')}>✓ Отметить решённым</button>}
          <button className="support-delete-button" disabled={busy} onClick={() => { setDeleteError(''); setDeleteTarget(ticket) }}>Удалить тикет</button>
        </>}
      </div>}
      <div className="rag-chat-scroll"><div className="rag-chat-thread">
        {!ticket && (loading ? <p className="rag-chat-loading" role="status">Загружаем переписку…</p> : <div className="rag-chat-empty support-empty"><div className="rag-chat-mark">◉</div><span className="support-eyebrow">ПОДДЕРЖКА В ОДНОМ ТИКЕТЕ</span><h1>Опишите проблему.<br />Продолжим здесь.</h1><p>Ассистент изучит документацию и описание тикета,<br />запишет решение и ответит на уточнения.</p><button className="support-empty-create" disabled={!catalog} onClick={openCreate}>＋ Создать первое обращение</button><div className="support-flow"><span>Создание тикета</span><span>→</span><span>Ответ ассистента</span><span>→</span><span>Уточнения и решение</span></div></div>)}
        {ticket && <><details className="support-description"><summary>Исходная проблема · {categories[ticket.category]}{ticket.errorCode ? ` · ${ticket.errorCode}` : ''}</summary><p>{ticket.description}</p></details>
          {ticket.messages.map((message) => message.author === 'user' ? <div className="support-user-message" key={message.id}><small>Автор обращения · {time(message.createdAt)}</small><div className="rag-chat-user"><p>{message.body}</p></div></div> : <article className="rag-chat-assistant" key={message.id}><span className="rag-chat-avatar">S</span><div className="rag-chat-answer"><small className="support-message-author">{message.reply ? 'AI-ассистент' : 'Поддержка'} · {time(message.createdAt)}</small>{message.reply && <span className={`support-answer-state ${message.reply.outcome}`}>{message.reply.outcome === 'answered' ? 'Ответ с проверенными цитатами' : 'Нужна помощь оператора'}</span>}<div className="rag-chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null }}>{message.body}</ReactMarkdown>{message.reply?.clarification && <p>{message.reply.clarification}</p>}</div>{message.reply && <small className="support-answer-meta">{message.reply.model} · {(message.reply.durationMs / 1000).toFixed(1)} сек.</small>}{Boolean(message.reply?.citations.length) && <details className="rag-chat-sources"><summary>Источники · {message.reply!.citations.length}</summary><div>{message.reply!.citations.map((citation) => <section key={citation.id}><strong>[{citation.id}] {citation.source.startsWith('mcp://') ? 'MCP · Контекст тикета' : citation.source.split('/').pop()}</strong><small>{citation.section}</small><blockquote>{citation.quote}</blockquote></section>)}</div></details>}</div></article>)}
          {processing && <p className="rag-chat-thinking support-ticket-thinking" role="status"><span className="support-pulse" />{ticket.job?.state === 'queued' ? 'Тикет в очереди. Ассистент ответит здесь автоматически…' : 'Ассистент изучает проблему и проверяет решение…'}<small>Можно закрыть страницу — ответ сохранится в тикете.</small></p>}
          {!ticket.deletedAt && ticket.job?.state === 'failed' && <div className="support-job-error" role="alert"><strong>Ассистенту не удалось ответить</strong><p>{ticket.job.error}</p><button disabled={busy} onClick={() => void mutate('retry')}>Повторить ответ</button></div>}
          {!ticket.deletedAt && ticket.status === 'escalated' && ticket.job?.state !== 'failed' && <p className="support-escalation">Нужна помощь оператора. Можно дополнить обращение — ассистент проверит новые сведения.</p>}
        </>}<div ref={bottom} />
      </div></div>
      <div className="rag-chat-composer-area">{error && <p className="rag-chat-error" role="alert">{error}</p>}{notice && <p className="support-notice" role="status">{notice}</p>}{!ready && <p className="support-notice">Для поиска решения подготовьте базу знаний в панели слева.</p>}{provider === 'cloud' && <p className="support-notice">В DeepSeek отправляются вопрос, контекст выбранного тикета и фрагменты документации.</p>}
        {ticket && !ticket.deletedAt && <><form className="rag-chat-composer" onSubmit={(event) => { event.preventDefault(); void mutate('message') }}><textarea ref={composer} aria-label="Сообщение в тикет" placeholder={processing ? 'Дождитесь ответа ассистента…' : ticket.status === 'resolved' ? 'Уточните вопрос — тикет откроется снова…' : 'Задайте уточняющий вопрос или опишите результат…'} value={input} maxLength={4000} rows={2} disabled={busy || processing} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} /><button type="submit" aria-label="Отправить сообщение в тикет" disabled={!input.trim() || busy || processing}>↑</button></form><p>{ticket.status === 'resolved' ? 'Новое сообщение снова откроет тикет.' : 'Сообщения и ответы сохраняются в тикете.'} Enter — отправить · Не передавайте пароли.</p></>}
      </div>
    </div>
    <dialog ref={deleteDialog} className="support-create-dialog support-delete-dialog" aria-labelledby="support-delete-title" onCancel={(event) => { if (busy) event.preventDefault(); else setDeleteTarget(undefined) }} onClose={() => setDeleteTarget(undefined)}>
      <form onSubmit={(event) => { event.preventDefault(); if (deleteTarget) void lifecycle('remove', deleteTarget) }}>
        <header><div><span>УДАЛЕНИЕ ОБРАЩЕНИЯ</span><h2 id="support-delete-title">Удалить тикет?</h2></div><button type="button" aria-label="Отменить удаление" disabled={busy} onClick={() => setDeleteTarget(undefined)}>×</button></header>
        <p>Тикет «{deleteTarget?.title}» будет перемещён в раздел «Удалённые». Его можно восстановить вместе с перепиской.</p>
        {active(deleteTarget) && <p>Текущий ответ ассистента будет остановлен.</p>}
        {deleteError && <p className="rag-chat-error" role="alert">{deleteError} Закройте окно и повторите действие после обновления тикета.</p>}
        <footer><button type="button" disabled={busy} onClick={() => setDeleteTarget(undefined)}>Отмена</button><button className="support-delete-confirm" type="submit" disabled={busy}>{busy ? 'Удаляем…' : 'Удалить'}</button></footer>
      </form>
    </dialog>
    <dialog ref={dialog} className="support-create-dialog" onCancel={(event) => { if (busy) event.preventDefault(); else setCreateOpen(false) }} onClose={() => setCreateOpen(false)}><form onSubmit={(event) => { event.preventDefault(); void mutate('create') }}><header><div><span>НОВОЕ ОБРАЩЕНИЕ</span><h2>С чем нужна помощь?</h2></div><button type="button" aria-label="Закрыть создание тикета" disabled={busy} onClick={() => setCreateOpen(false)}>×</button></header><p>После создания ассистент изучит проблему и ответит прямо в тикете.</p><label htmlFor="support-new-title">Тема</label><input id="support-new-title" autoFocus placeholder="Например, не получается войти в аккаунт" minLength={3} maxLength={160} required value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} /><label htmlFor="support-new-description">Описание проблемы</label><textarea id="support-new-description" placeholder="Что произошло, какую ошибку видите и что уже пробовали?" rows={5} minLength={10} maxLength={1200} required value={description} disabled={busy} onChange={(event) => setDescription(event.target.value)} /><small>{description.length}/1200 · Не указывайте пароли и коды подтверждения.</small><div className="support-create-fields"><label>Категория<select aria-label="Категория нового тикета" value={category} disabled={busy} onChange={(event) => setCategory(event.target.value)}><option value="general">Общий вопрос</option><option value="auth">Авторизация</option><option value="profile">Профиль</option><option value="features">Функции приложения</option><option value="billing">{catalog?.product === 'MyFamily' ? 'Покупки и Pro' : 'Оплата и тарифы'}</option>{catalog?.product !== 'MyFamily' && <option value="integrations">Интеграции</option>}</select></label><label>Код ошибки · необязательно<input aria-label="Код ошибки нового тикета" placeholder="Если отображается в приложении" maxLength={64} pattern="[A-Z0-9_]+" value={errorCode} disabled={busy} onChange={(event) => setErrorCode(event.target.value.toUpperCase())} /></label></div><details className="support-optional-details"><summary>Устройство и выполненные шаги · необязательно</summary><div className="support-create-fields">{([{ key: 'device', label: 'Устройство', placeholder: 'Например, iPhone 15', max: 120 }, { key: 'osVersion', label: 'Версия ОС', placeholder: 'Например, iOS 18.5', max: 80 }, { key: 'appVersion', label: 'Версия MyFamily', placeholder: 'Если известна', max: 80 }] as const).map(({ key, label, placeholder, max }) => <label key={key}>{label}<input aria-label={label} placeholder={placeholder} maxLength={max} value={details[key] || ''} disabled={busy} onChange={(event) => setDetails((current) => ({ ...current, [key]: event.target.value }))} /></label>)}</div><label>Что уже пробовали<textarea aria-label="Что уже пробовали" rows={2} maxLength={600} value={details.triedSteps || ''} disabled={busy} onChange={(event) => setDetails((current) => ({ ...current, triedSteps: event.target.value }))} /></label><small>Это сведения со слов автора, их можно дополнить в переписке.</small></details><div className="support-create-model">Ответит {provider === 'cloud' ? 'DeepSeek · вопрос и контекст отправятся в облако' : 'Ollama · локальная обработка'}</div>{createError && <p className="rag-chat-error" role="alert">{createError}</p>}<footer><button type="button" disabled={busy} onClick={() => setCreateOpen(false)}>Отмена</button><button className="support-create-submit" type="submit" disabled={busy || title.trim().length < 3 || description.trim().length < 10}>{busy ? 'Создаём тикет…' : 'Создать тикет и найти решение'}</button></footer></form></dialog>
  </section>
}
