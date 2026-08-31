import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react'

type MessageRole = 'user' | 'assistant'

type ChatMessage = {
  id: string
  role: MessageRole
  content: string
}

type ChatStreamChunk = {
  content?: string
  error?: string
}

const starterPrompts = [
  'Объясни простыми словами, как работает React',
  'Помоги спланировать iOS-приложение',
  'Напиши пример TypeScript-компонента',
]

const initialMessage: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content:
    'Привет! Я ваш AI-помощник на базе DeepSeek. Задайте вопрос — я помогу разобраться в коде, спланировать функцию или найти решение.',
}

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([initialMessage])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault()

    const content = input.trim()
    if (!content || isLoading) return

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
    }
    const assistantMessageId = crypto.randomUUID()

    setMessages((currentMessages) => [
      ...currentMessages,
      userMessage,
      { id: assistantMessageId, role: 'assistant', content: '' },
    ])
    setInput('')
    setError(null)
    setIsLoading(true)
    setStreamingMessageId(assistantMessageId)

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMessage].map(({ role, content: messageContent }) => ({
            role,
            content: messageContent,
          })),
        }),
      })

      if (!response.ok) {
        const data = (await response.json()) as ChatStreamChunk
        throw new Error(data.error || 'Не удалось получить ответ.')
      }

      if (!response.body) throw new Error('Браузер не поддерживает потоковый ответ.')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let streamFinished = false

      while (!streamFinished) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue

          const payload = line.slice(6).trim()
          if (payload === '[DONE]') {
            streamFinished = true
            break
          }

          const chunk = JSON.parse(payload) as ChatStreamChunk
          if (chunk.error) throw new Error(chunk.error)
          if (!chunk.content) continue

          setMessages((currentMessages) =>
            currentMessages.map((message) =>
              message.id === assistantMessageId
                ? { ...message, content: message.content + chunk.content }
                : message,
            ),
          )
        }

        if (done) break
      }
    } catch (requestError) {
      setMessages((currentMessages) => currentMessages.filter(({ id }) => id !== assistantMessageId))
      setError(requestError instanceof Error ? requestError.message : 'Произошла неизвестная ошибка.')
    } finally {
      setIsLoading(false)
      setStreamingMessageId(null)
    }
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  function startNewChat() {
    setMessages([initialMessage])
    setInput('')
    setError(null)
    setStreamingMessageId(null)
  }

  return (
    <div className="chat-app">
      <aside className="chat-sidebar">
        <div className="brand">
          <div className="brand-mark">D</div>
          <div>
            <strong>DeepChat</strong>
            <span>React + DeepSeek</span>
          </div>
        </div>

        <button className="new-chat-button" onClick={startNewChat}>
          <span aria-hidden="true">＋</span> Новый чат
        </button>

        <div className="sidebar-caption">Возможности</div>
        <div className="feature-list">
          <div><span className="feature-icon">✦</span> Умные ответы</div>
          <div><span className="feature-icon">⌁</span> Контекст диалога</div>
          <div><span className="feature-icon">✓</span> TypeScript-ready</div>
        </div>

        <div className="sidebar-bottom">
          <div className="connection-status">
            <span className="status-dot" />
            <span>Сервер готов</span>
          </div>
          <p>Ключ API хранится только на сервере.</p>
        </div>
      </aside>

      <main className="chat-main">
        <header className="chat-header">
          <div>
            <p className="eyebrow">Личный помощник</p>
            <h1>Чат с DeepSeek</h1>
          </div>
          <div className="model-badge"><span className="pulse-dot" /> DeepSeek V4 Flash</div>
        </header>

        <section className="messages-area" aria-label="История сообщений">
          <div className="messages-list">
            {messages.map((message) => (
              <article className={`message-row ${message.role}`} key={message.id}>
                <div className={`message-avatar ${message.role}`} aria-hidden="true">
                  {message.role === 'assistant' ? 'D' : 'Вы'}
                </div>
                <div className="message-content">
                  <div className="message-author">{message.role === 'assistant' ? 'DeepSeek' : 'Вы'}</div>
                  <div className={`message-bubble ${message.id === streamingMessageId && !message.content ? 'typing' : ''}`}>
                    {message.id === streamingMessageId && !message.content ? (
                      <><span /><span /><span /></>
                    ) : message.content}
                  </div>
                </div>
              </article>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </section>

        <div className="composer-wrapper">
          {messages.length === 1 && (
            <div className="starter-prompts">
              {starterPrompts.map((prompt) => (
                <button key={prompt} onClick={() => setInput(prompt)}>{prompt}</button>
              ))}
            </div>
          )}

          {error && <div className="error-message" role="alert">{error}</div>}

          <form className="composer" onSubmit={sendMessage}>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Напишите сообщение..."
              rows={1}
              aria-label="Сообщение для DeepSeek"
              disabled={isLoading}
            />
            <button className="send-button" type="submit" disabled={isLoading || !input.trim()} aria-label="Отправить сообщение">
              ↑
            </button>
          </form>
          <p className="composer-hint">Enter — отправить · Shift + Enter — новая строка</p>
        </div>
      </main>
    </div>
  )
}

export default App
