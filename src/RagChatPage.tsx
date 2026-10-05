import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ragChatAgentConfig, ragChatAgentId } from './rag-chat-config'
import type { DialogueMemoryState, RagChatConversation, RagChatMessage, RetrievalDecision } from './rag-chat-types'
import type { RagGrounding, RagResult } from './rag-types'

type History = { messages: RagChatMessage[]; dialogueMemory: DialogueMemoryState; conversationTokens: number }
type Answer = { output: string; rag?: RagResult; dialogueMemory: DialogueMemoryState; resolvedQuestion: string }
const activeConversationKey = 'deepchat-day25-conversation'
const initialMemory = (): DialogueMemoryState => ({ turn: 0, clarifications: [], constraints: [], terms: [] })
async function request<T>(path: string, body?: unknown, method = 'GET'): Promise<T> {
  const response = await fetch(path, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
  return data as T
}
function storedConversation() {
  try { return localStorage.getItem(activeConversationKey) ?? crypto.randomUUID() }
  catch { return crypto.randomUUID() }
}
function rememberConversation(id: string) {
  try { localStorage.setItem(activeConversationKey, id) } catch { /* Server history still works without local storage. */ }
}

export default function RagChatPage() {
  const [conversationId, setConversationId] = useState(storedConversation)
  const [conversations, setConversations] = useState<RagChatConversation[]>([])
  const [messages, setMessages] = useState<RagChatMessage[]>([])
  const [memory, setMemory] = useState(initialMemory)
  const [input, setInput] = useState('')
  const [pendingInput, setPendingInput] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [ready, setReady] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        const { agents } = await request<{ agents: Array<{ id: string; config: ReturnType<typeof ragChatAgentConfig> }> }>('/api/agents')
        const existing = agents.find((agent) => agent.id === ragChatAgentId)
        if (cancelled) return
        if (!existing) {
          const { index } = await request<{ index: { id: string } | null }>('/api/rag/index')
          if (!index) throw new Error('Локальный индекс пуст. Сначала выполните npm run rag:index.')
          try { await request('/api/agents', { id: ragChatAgentId, config: ragChatAgentConfig(index.id) }, 'POST') }
          catch (cause) {
            // Another tab (or React's development remount) may have created the same agent.
            const agent = await request<{ config: ReturnType<typeof ragChatAgentConfig> }>(`/api/agents/${ragChatAgentId}`)
            if (!agent.config.dialogueMemory?.enabled || !agent.config.rag?.grounding?.enabled) throw cause
          }
        } else if (!existing.config.dialogueMemory?.enabled || !existing.config.rag?.grounding?.enabled) {
          throw new Error('У агента day25-rag-chat выключены память или проверяемые цитаты. Проверьте его конфигурацию на странице «Агенты».')
        }
        if (!cancelled) setReady(true)
      } catch (cause) { if (!cancelled) { setError(String(cause)); setLoading(false) } }
    }
    void init()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    setLoading(true)
    setError(undefined)
    rememberConversation(conversationId)
    Promise.all([
      request<History>(`/api/agents/${ragChatAgentId}/history?conversationId=${encodeURIComponent(conversationId)}`),
      request<{ conversations: RagChatConversation[] }>(`/api/agents/${ragChatAgentId}/conversations`),
    ]).then(([history, list]) => {
      if (cancelled) return
      setMessages(history.messages)
      setMemory(history.dialogueMemory)
      setConversations(list.conversations)
    }).catch((cause) => { if (!cancelled) setError(String(cause)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [conversationId, ready])

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }) }, [messages, pendingInput, loading])

  function newChat() {
    if (busy) return
    setConversationId(crypto.randomUUID())
    setMessages([])
    setMemory(initialMemory())
    setInput('')
    setError(undefined)
    composer.current?.focus()
  }
  async function send(event: FormEvent) {
    event.preventDefault()
    const text = input.trim()
    if (!text || busy || loading || !ready) return
    setBusy(true)
    setPendingInput(text)
    setInput('')
    setError(undefined)
    try {
      // The ordinary agent API owns both history and task memory; never resend client history.
      await request<Answer>(`/api/agents/${ragChatAgentId}/run`, { input: text, conversationId }, 'POST')
      const [history, list] = await Promise.all([
        request<History>(`/api/agents/${ragChatAgentId}/history?conversationId=${encodeURIComponent(conversationId)}`),
        request<{ conversations: RagChatConversation[] }>(`/api/agents/${ragChatAgentId}/conversations`),
      ])
      setMessages(history.messages)
      setMemory(history.dialogueMemory)
      setConversations(list.conversations)
    } catch (cause) {
      setError(String(cause))
      setInput(text)
      // A lost HTTP response may still have committed a turn. Re-read server truth before retry.
      try {
        const history = await request<History>(`/api/agents/${ragChatAgentId}/history?conversationId=${encodeURIComponent(conversationId)}`)
        setMessages(history.messages); setMemory(history.dialogueMemory)
        if (history.messages.length > messages.length) { setInput(''); setError('Ответ сохранён на сервере, но обновление страницы завершилось с ошибкой. История восстановлена.') }
      } catch { /* Keep the visible error and original question. */ }
    } finally { setPendingInput(undefined); setBusy(false); composer.current?.focus() }
  }
  function enter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }
  const examples = [
    { title: 'План демонстрации RAG', text: 'Моя цель — подготовить пятиминутную демонстрацию локального RAG для новичков. Без новых библиотек и внешних векторных баз. Отвечай кратко. Какие две стратегии разбиения документов уже есть в проекте?' },
    { title: 'Надёжные фоновые задачи', text: 'Моя цель — составить чек-лист надёжности фоновых задач этого проекта. Новые зависимости запрещены, календарь используем только для чтения. Как сохраняются задачи и предотвращается их двойной запуск?' },
  ]
  return <section className="rag-chat-page" aria-label="Чат с RAG и памятью">
    <aside className="rag-chat-history" aria-label="Сохранённые диалоги">
      <button className="rag-chat-new" onClick={newChat} disabled={busy || loading}>＋ Новый чат</button>
      <p>Диалоги</p>
      <div className="rag-chat-history-list">{conversations.map((conversation) => <button key={conversation.id} className={conversation.id === conversationId ? 'active' : ''} disabled={busy || loading} onClick={() => { setInput(''); setConversationId(conversation.id) }} title={conversation.title}>{conversation.title}</button>)}</div>
      <span className="rag-chat-history-note">История и память сохраняются на сервере. Новый чат начинает отдельный диалог.</span>
    </aside>
    <div className="rag-chat-workspace">
      <header className="rag-chat-header"><div><strong>RAG-чат <span>Day 25</span></strong><small>DeepSeek · локальные документы · память задачи</small></div>
        <div className="rag-chat-header-actions"><button className="rag-chat-mobile-new" onClick={newChat} disabled={busy || loading} aria-label="Новый чат">＋</button><MemoryView memory={memory} /></div>
      </header>
      <div className="rag-chat-scroll">
        <div className="rag-chat-thread">
          {loading && <p className="rag-chat-loading" role="status">Загрузка диалога…</p>}
          {!loading && !messages.length && !pendingInput && <div className="rag-chat-empty"><div className="rag-chat-mark">⌕</div><h1>С чего начнём?</h1><p>Обсудим проект или общий вопрос.<br />Я сохраню цель разговора, а когда нужны документы — найду их и покажу источники.</p><div className="rag-chat-examples">{examples.map((example) => <button key={example.title} disabled={!ready} onClick={() => { setInput(example.text); composer.current?.focus() }}><strong>{example.title}</strong><span>Подставить первый вопрос ↗</span></button>)}</div></div>}
          {messages.filter((message) => message.role !== 'system').map((message, index) => <ChatMessage key={`${conversationId}-${index}`} message={message} />)}
          {pendingInput && <><ChatMessage message={{ role: 'user', content: pendingInput }} /><div className="rag-chat-thinking" role="status"><span className="rag-chat-avatar">D</span><span>Учитываю диалог и готовлю ответ…</span></div></>}
          <div ref={bottom} />
        </div>
      </div>
      <div className="rag-chat-composer-area">{error && <p className="rag-chat-error" role="alert">{error}</p>}<form className="rag-chat-composer" onSubmit={(event) => void send(event)}><textarea ref={composer} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={enter} placeholder="Спросите о проекте…" aria-label="Сообщение" rows={2} maxLength={8000} disabled={busy || loading || !ready} /><button type="submit" aria-label="Отправить сообщение" disabled={!input.trim() || busy || loading || !ready}>↑</button></form><p>Enter — отправить · Shift+Enter — новая строка. Факты проверяются по цитатам; проверка смысла может ошибаться.</p></div>
    </div>
  </section>
}

function ChatMessage({ message }: { message: RagChatMessage }) {
  if (message.role === 'user') return <div className="rag-chat-user"><p>{message.content}</p></div>
  const grounding = message.grounding
  return <article className="rag-chat-assistant"><span className="rag-chat-avatar" aria-label="Ассистент">D</span><div className="rag-chat-answer"><div className="rag-chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{grounding ? [grounding.answer, grounding.clarification].filter(Boolean).join('\n\n') : message.content}</ReactMarkdown></div><SourcesView grounding={grounding} retrieval={message.retrieval} />
    {message.searchQuery && <details className="rag-chat-query"><summary>Поисковый запрос</summary><p>{message.searchQuery}</p></details>}
  </div></article>
}
function SourcesView({ grounding, retrieval }: { grounding?: RagGrounding; retrieval?: RetrievalDecision }) {
  if (retrieval && !retrieval.searched && (retrieval.route === 'conversation' || retrieval.route === 'general')) return <div className="rag-chat-no-sources" title={retrieval.reason}>Без поиска по документам · {retrieval.route === 'conversation' ? 'обычный разговор' : 'ответ из общих знаний'}</div>
  if (!grounding?.citations.length) return <div className="rag-chat-no-sources">Источники: {grounding?.status === 'unknown' ? 'подтверждение не найдено — нужен уточняющий вопрос.' : 'для этого сохранённого ответа нет проверенных цитат.'}</div>
  const sources = grounding.sources.filter((source, index, all) => all.findIndex((item) => item.source === source.source) === index)
  return <div><div className="rag-chat-source-labels" aria-label="Использованные источники">{sources.map((source) => <span key={source.source} title={`${source.source} · ${source.section} · ${source.chunkId}`}>{source.source}</span>)}</div><details className="rag-chat-sources"><summary>Источники и цитаты · {grounding.sources.length}<span>Показать подтверждения</span></summary><div>{grounding.citations.map((citation) => <section key={citation.id}><strong>[{citation.id}] {citation.source}</strong><small>{citation.kind === 'dialogue' ? 'Слова пользователя, не документация проекта' : citation.section} · {citation.chunkId}</small><blockquote>{citation.quote}</blockquote></section>)}</div></details></div>
}
function MemoryView({ memory }: { memory: DialogueMemoryState }) {
  return <details className="rag-chat-memory"><summary>Память задачи <span>{memory.turn}</span></summary><div><h2>Что зафиксировано</h2><MemoryGroup title="Цель" items={memory.goal ? [memory.goal] : []} /><MemoryGroup title="Уточнения" items={memory.clarifications} /><MemoryGroup title="Ограничения" items={memory.constraints} /><MemoryGroup title="Термины" items={memory.terms} /><p>Это сведения пользователя, а не доказательства фактов о проекте.</p></div></details>
}
function MemoryGroup({ title, items }: { title: string; items: Array<{ text: string; quote: string; userTurn: number }> }) {
  return <section><h3>{title}</h3>{items.length ? <ul>{items.map((item, index) => <li key={index} title={`Сообщение №${item.userTurn}: ${item.quote}`}>{item.text}<small>сообщение №{item.userTurn}</small></li>)}</ul> : <span>Пока не задано</span>}</section>
}
