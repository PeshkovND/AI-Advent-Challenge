import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

type MessageRole = 'user' | 'assistant'
type Page = 'chat' | 'compare' | 'reasoning' | 'temperature' | 'models' | 'agents'

type ChatMessage = {
  id: string
  role: MessageRole
  content: string
}
type StopSequenceField = { id: string; value: string }
type PromptMessage = { role: 'system' | 'user'; content: string }

type ChatStreamChunk = { content?: string; error?: string }
type ComparisonSide = { content: string; tokens?: number }
type ComparisonResult = {
  prompt: string
  unconstrained: ComparisonSide
  constrained: ComparisonSide
  controls: { format?: string; maxTokens?: number; stopSequences?: string[]; responseFormat?: 'json_object'; jsonExample?: string }
}
type ReasoningExpert = { id: string; title: string; content: string; tokens?: number }
type ReasoningPromptBundle = {
  direct: PromptMessage[]
  stepByStep: PromptMessage[]
  promptEngineer: PromptMessage[]
  promptBased: PromptMessage[]
  experts: Array<{ id: string; title: string; messages: PromptMessage[] }>
  council: PromptMessage[]
}
type ReasoningResult = {
  task: string
  direct: ComparisonSide
  stepByStep: ComparisonSide
  generatedPrompt: string
  promptBased: ComparisonSide
  experts: ReasoningExpert[]
  council: ComparisonSide
  prompts: ReasoningPromptBundle
}
type TemperatureSide = { temperature: number; content: string; tokens?: number }
type TemperatureResult = { prompt: string; results: TemperatureSide[] }
type ModelSide = {
  id: string
  tier: string
  name: string
  model: string
  provider: 'deepseek' | 'huggingface'
  link: string
  durationMs: number
  content?: string
  tokens?: number
  promptTokens?: number
  totalTokens?: number
  costUsd?: number
  costLabel: string
  error?: string
}
type ModelsResult = { prompt: string; results: ModelSide[] }
type ApiError = { error?: string }
type AgentProvider = 'deepseek' | 'huggingface'
type AgentConfig = {
  name?: string
  provider: AgentProvider
  model: string
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
  inputPolicy?: { maxCharacters?: number }
  outputPolicy?: { maxCharacters?: number; format?: 'text' | 'json'; stopSequences?: string[] }
}
type AgentSummary = { id: string; config: AgentConfig; createdAt?: string }
type AgentsListResult = { agents: AgentSummary[]; count: number }
type AgentStreamChunk = { content?: string; error?: string; done?: boolean; result?: { durationMs?: number; tokens?: number } }
type AgentModelOption = { value: string; label: string }

const agentModelOptions: Record<AgentProvider, AgentModelOption[]> = {
  deepseek: [
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  ],
  huggingface: [
    { value: 'google/gemma-3-4b-it:deepinfra', label: 'Gemma 3 4B Instruct · DeepInfra' },
  ],
}

const initialMessage: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content: 'Привет! Я ваш AI-помощник на базе DeepSeek. Задайте вопрос — я помогу разобраться в коде, спланировать функцию или найти решение.',
}

const examplePrompts = [
  'Объясни, зачем разделять клиентскую и серверную части приложения.',
  'Составь план изучения React для iOS-разработчика.',
  'Опиши, как работает потоковая выдача ответа от AI.',
]
const exampleReasoningTasks = [
  'У вас есть 8 монет, одна фальшивая и легче остальных. За сколько взвешиваний на чашечных весах можно гарантированно найти фальшивую монету?',
  'Есть массив из 10 чисел, в котором все элементы встречаются дважды, кроме одного. Как найти уникальный элемент за O(n) времени и O(1) дополнительной памяти?',
  'В команде 5 разработчиков. Каждый должен познакомиться с каждым один раз. Сколько всего знакомств произойдёт? Объясните формулу.',
]
const exampleTemperaturePrompts = [
  'Объясни простыми словами третий закон Ньютона и приведи один пример из повседневной жизни.',
  'Объясни простыми словами, зачем приложению разделение на клиентскую и серверную части.',
  'Предложи идею небольшого проекта на React для разработчика, который знает Swift.',
]
const exampleModelPrompts = [
  'Сара хотела перемножить двузначное число и трёхзначное число, но вместо знака умножения просто записала двузначное число слева от трёхзначного и получила пятизначное число. Получившееся число ровно в 9 раз больше произведения, которое Сара должна была получить. Чему равна сумма этих двух чисел?',
  'Почему важно разделять клиентскую и серверную части приложения? Объясни на простом примере.',
  'Я iOS-разработчик и хочу начать изучать React. С чего лучше начать и почему?',
]
const defaultFormatInstruction = 'Первая строка начинается с "КРАТКО:", затем ровно 3 строки, начинающиеся с "- ". Каждый пункт — не более 8 слов.'
const defaultJsonExample = '{\n  "summary": "Краткое резюме",\n  "items": ["Пункт 1", "Пункт 2"]\n}'
const createStopSequenceField = (value = ''): StopSequenceField => ({ id: crypto.randomUUID(), value })

function App() {
  const [activePage, setActivePage] = useState<Page>('chat')

  return (
    <div className="day-app">
      <aside className="day-sidebar">
        <div className="brand">
          <div className="brand-mark">D</div>
          <div><strong>DeepChat</strong><span>React + DeepSeek</span></div>
        </div>

        <nav className="page-nav" aria-label="Разделы приложения">
          <button className={`page-nav-button ${activePage === 'chat' ? 'active' : ''}`} onClick={() => setActivePage('chat')}>
            <span>⌁</span> Чат
          </button>
          <button className={`page-nav-button ${activePage === 'compare' ? 'active' : ''}`} onClick={() => setActivePage('compare')}>
            <span>↔</span> Сравнение
          </button>
          <button className={`page-nav-button ${activePage === 'reasoning' ? 'active' : ''}`} onClick={() => setActivePage('reasoning')}>
            <span>✦</span> Способы решения
          </button>
          <button className={`page-nav-button ${activePage === 'temperature' ? 'active' : ''}`} onClick={() => setActivePage('temperature')}>
            <span>◌</span> Температура
          </button>
          <button className={`page-nav-button ${activePage === 'models' ? 'active' : ''}`} onClick={() => setActivePage('models')}>
            <span>◈</span> Модели
          </button>
          <button className={`page-nav-button ${activePage === 'agents' ? 'active' : ''}`} onClick={() => setActivePage('agents')}>
            <span>♙</span> Агенты
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="connection-status"><span className="status-dot" /> API подключён</div>
          <p>Ключ API хранится только на сервере.</p>
        </div>
      </aside>

      <main className="day-main">
        {activePage === 'chat' ? <ChatPage /> : activePage === 'compare' ? <ComparePage /> : activePage === 'reasoning' ? <ReasoningPage /> : activePage === 'temperature' ? <TemperaturePage /> : activePage === 'models' ? <ModelsPage /> : <AgentsPage />}
      </main>
    </div>
  )
}

function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([initialMessage])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, isLoading])

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault()
    const content = input.trim()
    if (!content || isLoading) return

    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content }
    const assistantMessageId = crypto.randomUUID()
    setMessages((current) => [...current, userMessage, { id: assistantMessageId, role: 'assistant', content: '' }])
    setInput('')
    setError(null)
    setIsLoading(true)
    setStreamingMessageId(assistantMessageId)

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...messages, userMessage].map(({ role, content: messageContent }) => ({ role, content: messageContent })) }),
      })
      if (!response.ok) throw new Error(((await response.json()) as ChatStreamChunk).error || 'Не удалось получить ответ.')
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
          if (payload === '[DONE]') { streamFinished = true; break }
          const chunk = JSON.parse(payload) as ChatStreamChunk
          if (chunk.error) throw new Error(chunk.error)
          if (chunk.content) setMessages((current) => current.map((message) => message.id === assistantMessageId ? { ...message, content: message.content + chunk.content } : message))
        }
        if (done) break
      }
    } catch (requestError) {
      setMessages((current) => current.filter(({ id }) => id !== assistantMessageId))
      setError(requestError instanceof Error ? requestError.message : 'Произошла неизвестная ошибка.')
    } finally {
      setIsLoading(false)
      setStreamingMessageId(null)
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage() }
  }

  function startNewChat() {
    setMessages([initialMessage]); setInput(''); setError(null); setStreamingMessageId(null)
  }

  return (
    <div className="page-view chat-page">
      <header className="chat-header">
        <div><p className="eyebrow">Личный помощник</p><h1>Чат с DeepSeek</h1><p className="header-description">Запрос принимает агент default и возвращает ответ с потоковой выдачей.</p></div>
        <div className="model-badge"><span className="pulse-dot" /> Agent default · DeepSeek V4 Flash</div>
      </header>
      <section className="messages-area" aria-label="История сообщений">
        <div className="messages-list">
          {messages.map((message) => <article className={`single-message ${message.role}`} key={message.id}>
            <div className={`message-avatar ${message.role}`}>{message.role === 'assistant' ? 'D' : 'Вы'}</div>
            <div className="message-content"><div className="message-author">{message.role === 'assistant' ? 'DeepSeek' : 'Вы'}</div><div className={`message-bubble ${message.id === streamingMessageId && !message.content ? 'typing' : ''}`}>{message.id === streamingMessageId && !message.content ? <><span /><span /><span /></> : <MarkdownContent content={message.content} />}</div></div>
          </article>)}
          <div ref={messagesEndRef} />
        </div>
      </section>
      <div className="composer-wrapper">
        {error && <div className="error-message" role="alert">{error}</div>}
        <form className="composer" onSubmit={sendMessage}>
          <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKeyDown} placeholder="Напишите сообщение..." rows={1} aria-label="Сообщение для DeepSeek" disabled={isLoading} />
          <button className="send-button" type="submit" disabled={isLoading || !input.trim()} aria-label="Отправить сообщение">↑</button>
        </form>
        <p className="composer-hint">Enter — отправить · Shift + Enter — новая строка</p>
      </div>
      <button className="reset-chat-button" onClick={startNewChat}>＋ Новый чат</button>
    </div>
  )
}

function ComparePage() {
  const [prompt, setPrompt] = useState(examplePrompts[0])
  const [result, setResult] = useState<ComparisonResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formatEnabled, setFormatEnabled] = useState(true)
  const [formatInstruction, setFormatInstruction] = useState(defaultFormatInstruction)
  const [lengthEnabled, setLengthEnabled] = useState(true)
  const [maxTokens, setMaxTokens] = useState('120')
  const [stopEnabled, setStopEnabled] = useState(true)
  const [stopSequences, setStopSequences] = useState<StopSequenceField[]>([createStopSequenceField('<END>')])
  const [responseFormatEnabled, setResponseFormatEnabled] = useState(false)
  const [jsonExample, setJsonExample] = useState(defaultJsonExample)

  async function compareResponses(event: FormEvent) {
    event.preventDefault()
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt || isLoading) return
    setIsLoading(true); setError(null); setResult(null)
    const parsedMaxTokens = Number(maxTokens)
    const stopSequenceValues = stopSequences.map(({ value }) => value.trim()).filter(Boolean)
    const controls = {
      ...(formatEnabled && formatInstruction.trim() ? { format: formatInstruction.trim() } : {}),
      ...(lengthEnabled && Number.isFinite(parsedMaxTokens) ? { maxTokens: Math.min(Math.max(Math.floor(parsedMaxTokens), 16), 1000) } : {}),
      ...(stopEnabled && stopSequenceValues.length ? { stopSequences: stopSequenceValues } : {}),
      ...(responseFormatEnabled ? { responseFormat: 'json_object' as const, ...(jsonExample.trim() ? { jsonExample: jsonExample.trim() } : {}) } : {}),
    }
    try {
      const response = await fetch('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: trimmedPrompt, controls }) })
      const data = (await response.json()) as ComparisonResult & ApiError
      if (!response.ok || !data.unconstrained || !data.constrained) throw new Error(data.error || 'Не удалось получить сравнение.')
      setResult(data)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Произошла неизвестная ошибка.') }
    finally { setIsLoading(false) }
  }

  return (
    <div className="page-view compare-page">
      <header className="page-header">
        <div><p className="eyebrow">Эксперимент с API</p><h1>Один запрос. Два уровня контроля.</h1><p className="header-description">Сравните свободный ответ с ответом, где вы сами задали формат, длину, stop-условие или JSON-режим.</p></div>
        <div className="model-badge"><span className="pulse-dot" /> DeepSeek V4 Flash</div>
      </header>

      <section className="prompt-panel"><div className="section-heading"><div><span className="step-number">01</span><div><p className="eyebrow">Одинаковый запрос</p><h2>Что спросим у модели?</h2></div></div><span className="request-label">2 API-запроса</span></div>
        <form onSubmit={compareResponses}><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Введите один и тот же запрос для обоих режимов..." rows={3} aria-label="Запрос для сравнения" /><div className="prompt-actions"><div className="example-prompts">{examplePrompts.map((example) => <button type="button" key={example} onClick={() => setPrompt(example)}>{example}</button>)}</div><button className="compare-button" type="submit" disabled={isLoading || !prompt.trim()}>{isLoading ? 'Сравниваем...' : 'Сравнить ответы'} <span>→</span></button></div></form>
      </section>

      <section className="controls-panel"><div className="section-heading compact"><div><span className="step-number">02</span><div><p className="eyebrow">Настройка контроля</p><h2>Выберите, какие параметры применить</h2></div></div><span className="request-label">Можно включить часть</span></div>
        <div className="settings-grid">
          <label className={`setting-card ${formatEnabled ? 'enabled' : ''}`}><div className="setting-title"><input type="radio" name="response-mode" checked={formatEnabled} onChange={() => { setFormatEnabled(true); setResponseFormatEnabled(false) }} /><span className="control-icon purple">⌘</span><div><strong>Формат ответа</strong><small>Явная инструкция модели</small></div></div><textarea value={formatInstruction} onChange={(event) => setFormatInstruction(event.target.value)} disabled={!formatEnabled} rows={3} aria-label="Инструкция формата ответа" /></label>
          <label className={`setting-card ${responseFormatEnabled ? 'enabled' : ''}`}><div className="setting-title"><input type="radio" name="response-mode" checked={responseFormatEnabled} onChange={() => { setResponseFormatEnabled(true); setFormatEnabled(false) }} /><span className="control-icon orange">{'{}'}</span><div><strong>JSON-формат</strong><small>response_format</small></div></div><p className="setting-help">Только валидный JSON-объект</p><textarea className="json-example-input" value={jsonExample} onChange={(event) => setJsonExample(event.target.value)} disabled={!responseFormatEnabled} rows={3} aria-label="Пример структуры JSON" /></label>
          <label className={`setting-card ${lengthEnabled ? 'enabled' : ''}`}><div className="setting-title"><input type="checkbox" checked={lengthEnabled} onChange={(event) => setLengthEnabled(event.target.checked)} /><span className="control-icon blue">↕</span><div><strong>Ограничение длины</strong><small>Максимум токенов</small></div></div><div className="number-input"><input type="number" min={16} max={1000} step={1} value={maxTokens} onChange={(event) => setMaxTokens(event.target.value.replace(/^0+(?=\d)/, ''))} disabled={!lengthEnabled} /><span>tokens</span></div></label>
          <div className={`setting-card ${stopEnabled ? 'enabled' : ''}`}><div className="setting-title"><input type="checkbox" checked={stopEnabled} onChange={(event) => setStopEnabled(event.target.checked)} /><span className="control-icon green">■</span><div><strong>Условие завершения</strong><small>До 16 последовательностей</small></div></div><div className="stop-list">{stopSequences.map((sequence, index) => <div className="stop-row" key={sequence.id}><input className="stop-input" value={sequence.value} onChange={(event) => setStopSequences((current) => current.map((item) => item.id === sequence.id ? { ...item, value: event.target.value } : item))} disabled={!stopEnabled} placeholder={index === 0 ? 'Например: Конец ответа' : 'Stop-последовательность'} aria-label={`Stop-последовательность ${index + 1}`} /><button className="stop-remove" type="button" onClick={() => setStopSequences((current) => current.filter((item) => item.id !== sequence.id))} disabled={!stopEnabled} aria-label={`Удалить stop-последовательность ${index + 1}`}>×</button></div>)}<button className="stop-add" type="button" onClick={() => setStopSequences((current) => [...current, createStopSequenceField()])} disabled={!stopEnabled || stopSequences.length >= 16} aria-label="Добавить stop-последовательность" title="Добавить stop-последовательность">＋</button></div></div>
        </div>
      </section>

      {error && <div className="error-message" role="alert">{error}</div>}
      <section className="results-section"><div className="results-heading"><div><span className="step-number">03</span><div><p className="eyebrow">Результат</p><h2>Сравнение ответов</h2></div></div>{result && <span className="same-prompt">Один prompt · 2 запроса</span>}</div>
        {!result && !isLoading && <div className="empty-result"><div className="empty-icon">↔</div><h3>Здесь появятся два ответа</h3><p>Введите запрос выше и нажмите «Сравнить ответы», чтобы увидеть разницу в уровне контроля.</p></div>}
        {isLoading && <div className="loading-result"><span className="loading-spinner" /> DeepSeek готовит оба ответа...</div>}
        {result && <div className="results-grid"><ResponseCard title="Без ограничений" subtitle="Только исходный prompt" variant="free" side={result.unconstrained} /><ResponseCard title="С выбранными параметрами" subtitle="Только включённые настройки" variant="controlled" side={result.constrained} /></div>}
      </section>
      {result && <p className="experiment-note">Ограничения применялись только ко второму запросу. {result.controls.responseFormat ? 'JSON-режим включён.' : 'JSON-режим отключён.'} {result.controls.stopSequences?.length ? <>Stop-последовательности <code>{result.controls.stopSequences.join(' · ')}</code> останавливают генерацию.</> : 'Stop-последовательности отключены.'}</p>}
    </div>
  )
}

function ReasoningPage() {
  const [task, setTask] = useState(exampleReasoningTasks[0])
  const [result, setResult] = useState<ReasoningResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function solveTask(event: FormEvent) {
    event.preventDefault()
    const trimmedTask = task.trim()
    if (!trimmedTask || isLoading) return
    setIsLoading(true); setError(null); setResult(null)

    try {
      const response = await fetch('/api/reasoning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: trimmedTask }),
      })
      const data = (await response.json()) as ReasoningResult & ApiError
      if (!response.ok || !data.direct || !data.stepByStep || !data.promptBased || !data.council || !data.prompts) {
        throw new Error(data.error || 'Не удалось получить варианты решения.')
      }
      setResult(data)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Произошла неизвестная ошибка.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="page-view reasoning-page">
      <header className="page-header">
        <div><p className="eyebrow">Способы рассуждения</p><h1>Одна задача. Четыре решения.</h1><p className="header-description">Сравните прямой ответ, пошаговый подход, решение через подготовленный промпт и группу экспертов.</p></div>
        <div className="model-badge"><span className="pulse-dot" /> DeepSeek V4 Flash</div>
      </header>

      <section className="prompt-panel reasoning-prompt-panel"><div className="section-heading"><div><span className="step-number">01</span><div><p className="eyebrow">Одна задача</p><h2>Что решаем?</h2></div></div><span className="request-label">Несколько API-запросов</span></div>
        <form onSubmit={solveTask}><textarea value={task} onChange={(event) => setTask(event.target.value)} placeholder="Введите логическую, алгоритмическую или аналитическую задачу..." rows={4} aria-label="Задача для сравнения способов решения" /><div className="prompt-actions"><div className="example-prompts">{exampleReasoningTasks.map((example) => <button type="button" key={example} onClick={() => setTask(example)}>{example}</button>)}</div><button className="compare-button" type="submit" disabled={isLoading || !task.trim()}>{isLoading ? 'Получаем решения...' : 'Решить четырьмя способами'} <span>→</span></button></div></form>
      </section>

      {error && <div className="error-message" role="alert">{error}</div>}
      <section className="results-section reasoning-results"><div className="results-heading"><div><span className="step-number">02</span><div><p className="eyebrow">Результат</p><h2>Решения одной задачи</h2></div></div>{result && <span className="same-prompt">Одна задача · 4 подхода</span>}</div>
        {!result && !isLoading && <div className="empty-result"><div className="empty-icon">✦</div><h3>Здесь появятся решения</h3><p>Введите одну задачу и получите четыре варианта рассуждения для сравнения точности и качества ответа.</p></div>}
        {isLoading && <div className="loading-result"><span className="loading-spinner" /> DeepSeek готовит решения и сравнение...</div>}
        {result && <>
          <div className="reasoning-methods-grid">
            <ReasoningCard marker="A" title="Прямой ответ" subtitle="Только исходная задача" side={result.direct} prompt={result.prompts.direct} />
            <ReasoningCard marker="B" title="Пошаговое решение" subtitle="Инструкция «решай пошагово»" side={result.stepByStep} variant="controlled" prompt={result.prompts.stepByStep} />
            <ReasoningCard marker="C" title="Через свой промпт" subtitle="Сначала prompt engineer" side={result.promptBased} variant="controlled" prompt={result.prompts.promptBased} />
            <article className="reasoning-method-card experts-method"><div className="reasoning-card-header"><div><span className="response-marker controlled-marker">D</span><div><h3>Группа экспертов</h3><p>Три независимые точки зрения</p></div></div></div><div className="expert-grid">{result.experts.map((expert) => <div className="expert-card" key={expert.id}><div className="expert-card-heading"><strong>{expert.title}</strong>{expert.tokens ? <span>{expert.tokens} tokens</span> : null}</div><div className="reasoning-content"><MarkdownContent content={expert.content} />{result.prompts.experts.find((prompt) => prompt.id === expert.id) && <PromptDetails messages={result.prompts.experts.find((prompt) => prompt.id === expert.id)?.messages ?? []} label="Показать prompt эксперта" />}</div></div>)}</div><div className="council-prompt"><PromptDetails messages={result.prompts.council} label="Показать prompt председателя" /></div></article>
          </div>
          <article className="council-summary"><div className="evaluation-heading"><div><span className="step-number">03</span><div><p className="eyebrow">Итог совета</p><h2>Общее решение экспертов</h2></div></div><span className="response-status">На основе трёх мнений</span></div><div className="reasoning-content"><MarkdownContent content={result.council.content} /></div></article>
        </>}
      </section>
    </div>
  )
}

function AgentsPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState('default')
  const [agentId, setAgentId] = useState('')
  const [agentName, setAgentName] = useState('')
  const [provider, setProvider] = useState<AgentProvider>('deepseek')
  const [model, setModel] = useState('deepseek-v4-flash')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [temperature, setTemperature] = useState('0.7')
  const [maxTokens, setMaxTokens] = useState('')
  const [outputFormat, setOutputFormat] = useState<'text' | 'json'>('text')
  const [stopSequenceFields, setStopSequenceFields] = useState<StopSequenceField[]>([])
  const [input, setInput] = useState('')
  const [answer, setAnswer] = useState('')
  const [runMeta, setRunMeta] = useState<{ durationMs?: number; tokens?: number } | null>(null)
  const [isLoadingAgents, setIsLoadingAgents] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadAgents()
  }, [])

  async function loadAgents() {
    setIsLoadingAgents(true)
    try {
      const response = await fetch('/api/agents')
      const data = (await response.json()) as AgentsListResult & ApiError
      if (!response.ok || !Array.isArray(data.agents)) throw new Error(data.error || 'Не удалось загрузить агентов.')
      setAgents(data.agents)
      if (data.agents.length > 0 && !data.agents.some((agent) => agent.id === selectedAgentId)) setSelectedAgentId(data.agents[0].id)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить агентов.')
    } finally {
      setIsLoadingAgents(false)
    }
  }

  async function createAgent(event: FormEvent) {
    event.preventDefault()
    const trimmedId = agentId.trim().toLowerCase()
    if (!trimmedId || isCreating) return

    setIsCreating(true)
    setError(null)
    try {
      const numericTemperature = Number(temperature)
      const numericMaxTokens = Number(maxTokens)
      const stopSequenceValues = stopSequenceFields.map(({ value }) => value.trim()).filter(Boolean)
      const config: AgentConfig = {
        name: agentName.trim() || undefined,
        provider,
        model: model.trim(),
        systemPrompt: systemPrompt.trim() || undefined,
        temperature: Number.isFinite(numericTemperature) ? Math.min(Math.max(numericTemperature, 0), 2) : undefined,
        maxTokens: maxTokens.trim() && Number.isFinite(numericMaxTokens) ? Math.max(1, Math.floor(numericMaxTokens)) : undefined,
        outputPolicy: outputFormat === 'json' || stopSequenceValues.length > 0 ? {
          ...(outputFormat === 'json' ? { format: 'json' as const } : {}),
          ...(stopSequenceValues.length > 0 ? { stopSequences: stopSequenceValues } : {}),
        } : undefined,
      }
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: trimmedId, config }),
      })
      const data = (await response.json()) as AgentSummary & ApiError
      if (!response.ok || !data.id) throw new Error(data.error || 'Не удалось создать агента.')
      setAgents((current) => [...current, data])
      setSelectedAgentId(data.id)
      setAgentId('')
      setAgentName('')
      setSystemPrompt('')
      setError(null)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось создать агента.')
    } finally {
      setIsCreating(false)
    }
  }

  async function runAgent(event: FormEvent) {
    event.preventDefault()
    const trimmedInput = input.trim()
    if (!trimmedInput || isRunning || !selectedAgentId) return

    setIsRunning(true)
    setError(null)
    setAnswer('')
    setRunMeta(null)

    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(selectedAgentId)}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: trimmedInput }),
      })
      if (!response.ok) {
        const data = (await response.json()) as ApiError
        throw new Error(data.error || 'Не удалось получить ответ агента.')
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
          if (payload === '[DONE]') { streamFinished = true; break }
          const chunk = JSON.parse(payload) as AgentStreamChunk
          if (chunk.error) throw new Error(chunk.error)
          if (chunk.content) setAnswer((current) => current + chunk.content)
          if (chunk.done && chunk.result) setRunMeta(chunk.result)
        }
        if (done) break
      }
    } catch (requestError) {
      setAnswer('')
      setError(requestError instanceof Error ? requestError.message : 'Не удалось получить ответ агента.')
    } finally {
      setIsRunning(false)
    }
  }

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId)

  return (
    <div className="page-view agents-page">
      <header className="page-header">
        <div><p className="eyebrow">Agent service</p><h1>Создайте агента и отправьте ему запрос</h1><p className="header-description">Каждый агент получает собственную конфигурацию, а все агенты работают внутри одного серверного приложения.</p></div>
        <div className="model-badge"><span className="pulse-dot" /> {agents.length} {pluralizeAgents(agents.length)}</div>
      </header>

      {error && <div className="error-message" role="alert">{error}</div>}

      <div className="agents-layout">
        <section className="agent-create-panel">
          <div className="section-heading"><div><span className="step-number">01</span><div><p className="eyebrow">Новая сущность</p><h2>Конфигурация агента</h2></div></div></div>
          <form className="agent-form" onSubmit={createAgent}>
            <label>Идентификатор<input value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="например, react-helper" /></label>
            <label>Название<input value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="Помощник по React" /></label>
            <div className="agent-form-row">
              <label>Провайдер<select value={provider} onChange={(event) => { const nextProvider = event.target.value as AgentProvider; setProvider(nextProvider); setModel(agentModelOptions[nextProvider][0].value) }}><option value="deepseek">DeepSeek</option><option value="huggingface">Hugging Face</option></select></label>
              <label>Модель<select value={model} onChange={(event) => setModel(event.target.value)}>{agentModelOptions[provider].map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
            </div>
            <label>Системный промпт<textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} placeholder="Например: отвечай кратко и с примерами..." rows={3} /></label>
            <div className="agent-form-row">
              <label>Температура<input type="number" min="0" max="2" step="0.1" value={temperature} onChange={(event) => setTemperature(event.target.value)} /></label>
              <label>Максимум токенов <span className="field-optional">необязательно</span><input type="number" min="1" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} placeholder="без лимита" /></label>
            </div>
            <label>Формат ответа<select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value as 'text' | 'json')}><option value="text">Обычный текст</option><option value="json">JSON</option></select></label>
            <div className="agent-stop-section"><div className="agent-field-heading"><span>Stop sequence</span><small>Необязательно</small></div><div className="stop-list">{stopSequenceFields.map((sequence, index) => <div className="stop-row" key={sequence.id}><input className="stop-input" value={sequence.value} onChange={(event) => setStopSequenceFields((current) => current.map((item) => item.id === sequence.id ? { ...item, value: event.target.value } : item))} placeholder={index === 0 ? 'Например: <END>' : 'Следующая последовательность'} aria-label={`Stop sequence ${index + 1}`} /><button className="stop-remove" type="button" onClick={() => setStopSequenceFields((current) => current.filter((item) => item.id !== sequence.id))} aria-label={`Удалить stop sequence ${index + 1}`}>×</button></div>)}<button className="stop-add" type="button" onClick={() => setStopSequenceFields((current) => [...current, createStopSequenceField()])} aria-label="Добавить stop sequence" title="Добавить stop sequence">＋</button></div></div>
            <button className="compare-button" type="submit" disabled={isCreating || !agentId.trim()}>{isCreating ? 'Создаём...' : 'Создать агента'} <span>→</span></button>
          </form>
        </section>

        <section className="agent-run-panel">
          <div className="section-heading"><div><span className="step-number">02</span><div><p className="eyebrow">Запуск</p><h2>Сообщение агенту</h2></div></div></div>
          <div className="agent-picker">
            <label>Выберите агента<select value={selectedAgentId} onChange={(event) => { setSelectedAgentId(event.target.value); setAnswer(''); setRunMeta(null) }} disabled={isLoadingAgents || agents.length === 0}>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.config.name || agent.id} · {agent.id}</option>)}</select></label>
            {selectedAgent && <div className="agent-config-summary"><strong>{selectedAgent.id}</strong><span>{selectedAgent.config.provider} · {selectedAgent.config.model}</span><span>temperature {selectedAgent.config.temperature ?? 'по умолчанию'}</span></div>}
            {selectedAgent && <AgentConfigDetails config={selectedAgent.config} />}
          </div>
          <form className="agent-message-form" onSubmit={runAgent}>
            <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Напишите сообщение выбранному агенту..." rows={5} disabled={isRunning || agents.length === 0} />
            <button className="compare-button" type="submit" disabled={isRunning || !input.trim() || agents.length === 0}>{isRunning ? 'Агент отвечает...' : 'Отправить сообщение'} <span>→</span></button>
          </form>
          <div className="agent-answer"><div className="agent-answer-heading"><div><p className="eyebrow">Ответ агента</p><h3>{selectedAgent?.config.name || selectedAgent?.id || 'Агент не выбран'}</h3></div>{runMeta && <span className="response-status">{runMeta.durationMs ?? '—'} мс · {runMeta.tokens ?? '—'} tokens</span>}</div>{answer ? <div className="reasoning-content"><MarkdownContent content={answer} /></div> : <div className="agent-empty">{isRunning ? <><span className="loading-spinner" /> Получаем потоковый ответ...</> : 'Здесь появится ответ выбранного агента.'}</div>}</div>
        </section>
      </div>

      <section className="results-section agent-list-section"><div className="results-heading"><div><span className="step-number">03</span><div><p className="eyebrow">Реестр</p><h2>Созданные агенты</h2></div></div><span className="same-prompt">{agents.length} {pluralizeAgents(agents.length)}</span></div><div className="agent-list">{agents.map((agent) => <button className={`agent-list-item ${agent.id === selectedAgentId ? 'active' : ''}`} type="button" key={agent.id} onClick={() => setSelectedAgentId(agent.id)}><span className="agent-list-icon">{agent.id === 'default' ? 'D' : 'A'}</span><span><strong>{agent.config.name || agent.id}</strong><small>{agent.id} · {agent.config.provider} · {agent.config.model}</small></span><span className="agent-list-arrow">→</span></button>)}</div></section>
    </div>
  )
}

function AgentConfigDetails({ config }: { config: AgentConfig }) {
  const outputFormat = config.outputPolicy?.format === 'json' ? 'JSON' : 'Обычный текст'
  const stopSequences = config.outputPolicy?.stopSequences?.length ? config.outputPolicy.stopSequences.join(' · ') : 'не заданы'
  return <div className="agent-config-details"><div className="agent-config-details-heading"><span>Параметры выбранного агента</span><small>Текущая конфигурация</small></div><div className="agent-config-details-grid"><div><small>Название</small><strong>{config.name || 'не задано'}</strong></div><div><small>Temperature</small><strong>{config.temperature ?? 'по умолчанию'}</strong></div><div><small>Максимум токенов</small><strong>{config.maxTokens ?? 'без лимита'}</strong></div><div><small>Формат ответа</small><strong>{outputFormat}</strong></div><div><small>Лимит входа</small><strong>{config.inputPolicy?.maxCharacters ? `${config.inputPolicy.maxCharacters} символов` : 'без лимита'}</strong></div><div><small>Stop-последовательности</small><strong>{stopSequences}</strong></div><div className="agent-config-details-wide"><small>Системный промпт</small><strong>{config.systemPrompt || 'не задан'}</strong></div></div></div>
}

function pluralizeAgents(count: number) {
  if (count % 10 === 1 && count % 100 !== 11) return 'агент'
  if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) return 'агента'
  return 'агентов'
}

function ModelsPage() {
  const [prompt, setPrompt] = useState(exampleModelPrompts[0])
  const [result, setResult] = useState<ModelsResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function compareModels(event: FormEvent) {
    event.preventDefault()
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt || isLoading) return

    setIsLoading(true)
    setError(null)
    setResult(null)

    try {
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmedPrompt }),
      })
      const data = (await response.json()) as ModelsResult & ApiError
      if (!response.ok || !Array.isArray(data.results) || data.results.length !== 3) {
        throw new Error(data.error || 'Не удалось получить ответы от моделей.')
      }
      setResult(data)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Произошла неизвестная ошибка.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="page-view models-page">
      <header className="page-header">
        <div><p className="eyebrow">Сравнение моделей</p><h1>Три модели. Один prompt.</h1><p className="header-description">Отправьте один и тот же запрос небольшой модели Hugging Face и двум моделям DeepSeek. Приложение покажет ответы, время, токены и стоимость.</p></div>
        <div className="model-badge"><span className="pulse-dot" /> DeepSeek + Hugging Face</div>
      </header>

      <section className="prompt-panel models-prompt-panel"><div className="section-heading"><div><span className="step-number">01</span><div><p className="eyebrow">Одинаковый запрос</p><h2>Что отправим моделям?</h2></div></div><span className="request-label">3 API-запроса</span></div>
        <form onSubmit={compareModels}><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Введите запрос для сравнения моделей..." rows={4} aria-label="Запрос для сравнения моделей" /><div className="prompt-actions"><div className="example-prompts">{exampleModelPrompts.map((example) => <button type="button" key={example} onClick={() => setPrompt(example)}>{example}</button>)}</div><button className="compare-button" type="submit" disabled={isLoading || !prompt.trim()}>{isLoading ? 'Получаем ответы...' : 'Сравнить модели'} <span>→</span></button></div></form>
      </section>

      {error && <div className="error-message" role="alert">{error}</div>}
      <section className="results-section models-results"><div className="results-heading"><div><span className="step-number">02</span><div><p className="eyebrow">Результат</p><h2>Ответы и метрики</h2></div></div>{result && <span className="same-prompt">Один prompt · 3 модели</span>}</div>
        {!result && !isLoading && <div className="empty-result"><div className="empty-icon">◈</div><h3>Здесь появятся ответы моделей</h3><p>Введите один запрос и запустите сравнение, чтобы увидеть результаты рядом.</p></div>}
        {isLoading && <div className="loading-result"><span className="loading-spinner" /> Модели готовят ответы...</div>}
        {result && <div className="models-results-grid">{result.results.map((side) => <ModelCard key={side.id} side={side} />)}</div>}
      </section>
    </div>
  )
}

function ModelCard({ side }: { side: ModelSide }) {
  const tokenValue = side.totalTokens ?? side.tokens
  const costValue = side.costUsd === undefined ? side.costLabel : `$${side.costUsd.toFixed(6)}`

  return <article className={`model-card ${side.provider} ${side.error ? 'has-error' : ''}`}><div className="model-card-header"><div><span className={`model-tier ${side.provider}`}>{side.tier}</span><div><h3>{side.name}</h3><a href={side.link} target="_blank" rel="noreferrer">{side.model}</a></div></div></div><div className="model-metrics"><div><small>Время</small><strong>{side.durationMs} мс</strong></div><div><small>Токены</small><strong>{tokenValue === undefined ? '—' : tokenValue}</strong></div><div><small>Стоимость</small><strong>{costValue}</strong></div></div><div className="response-content">{side.error ? <div className="model-error" role="alert">{side.error}</div> : <MarkdownContent content={side.content ?? ''} />}</div></article>
}

function TemperaturePage() {
  const [prompt, setPrompt] = useState(exampleTemperaturePrompts[0])
  const [result, setResult] = useState<TemperatureResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function runExperiment(event: FormEvent) {
    event.preventDefault()
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt || isLoading) return

    setIsLoading(true)
    setError(null)
    setResult(null)

    try {
      const response = await fetch('/api/temperature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmedPrompt }),
      })
      const data = (await response.json()) as TemperatureResult & ApiError
      if (!response.ok || !Array.isArray(data.results) || data.results.length !== 5) {
        throw new Error(data.error || 'Не удалось получить ответы для разных температур.')
      }
      setResult(data)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Произошла неизвестная ошибка.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="page-view temperature-page">
      <header className="page-header">
        <div><p className="eyebrow">Параметр генерации</p><h1>Один prompt. Пять температур.</h1><p className="header-description">Отправьте один и тот же запрос с temperature 0, 0.7, 1.2, 1.7 и 2.0, чтобы увидеть пять независимых ответов модели.</p></div>
        <div className="model-badge"><span className="pulse-dot" /> DeepSeek V4 Flash</div>
      </header>

      <section className="prompt-panel temperature-prompt-panel"><div className="section-heading"><div><span className="step-number">01</span><div><p className="eyebrow">Одинаковый запрос</p><h2>Что отправим модели?</h2></div></div><span className="request-label">5 API-запросов</span></div>
        <form onSubmit={runExperiment}><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Введите запрос для эксперимента..." rows={4} aria-label="Запрос для сравнения температур" /><div className="prompt-actions"><div className="example-prompts">{exampleTemperaturePrompts.map((example) => <button type="button" key={example} onClick={() => setPrompt(example)}>{example}</button>)}</div><button className="compare-button" type="submit" disabled={isLoading || !prompt.trim()}>{isLoading ? 'Получаем ответы...' : 'Запустить эксперимент'} <span>→</span></button></div></form>
      </section>

      {error && <div className="error-message" role="alert">{error}</div>}
      <section className="results-section temperature-results"><div className="results-heading"><div><span className="step-number">02</span><div><p className="eyebrow">Результат</p><h2>Ответы модели</h2></div></div>{result && <span className="same-prompt">Один prompt · 5 запросов</span>}</div>
        {!result && !isLoading && <div className="empty-result"><div className="empty-icon">◌</div><h3>Здесь появятся пять ответов</h3><p>Введите один запрос и запустите эксперимент, чтобы получить результаты при разных значениях temperature.</p></div>}
        {isLoading && <div className="loading-result"><span className="loading-spinner" /> DeepSeek готовит пять ответов...</div>}
        {result && <div className="temperature-results-grid">{result.results.map((side) => <TemperatureCard key={side.temperature} side={side} />)}</div>}
      </section>
    </div>
  )
}

function TemperatureCard({ side }: { side: TemperatureSide }) {
  return <article className={`temperature-card temperature-${String(side.temperature).replace('.', '-')}`}><div className="temperature-card-header"><div><span className="temperature-value">{side.temperature}</span><div><h3>Temperature = {side.temperature}</h3><p>{temperatureCaption(side.temperature)}</p></div></div><span className="response-status">{side.tokens ? `${side.tokens} tokens` : 'Ответ готов'}</span></div><div className="response-content"><MarkdownContent content={side.content} /></div></article>
}

function temperatureCaption(temperature: number) {
  if (temperature === 0) return 'Минимум случайности'
  if (temperature === 0.7) return 'Сбалансированная настройка'
  if (temperature === 1.2) return 'Больше вариативности'
  if (temperature === 1.7) return 'Высокая вариативность'
  return 'Максимальная вариативность'
}

function ReasoningCard({ marker, title, subtitle, side, variant = 'free', prompt }: { marker: string; title: string; subtitle: string; side: ComparisonSide; variant?: 'free' | 'controlled'; prompt: PromptMessage[] }) {
  return <article className={`reasoning-method-card ${variant}`}><div className="reasoning-card-header"><div><span className={`response-marker ${variant === 'controlled' ? 'controlled-marker' : ''}`}>{marker}</span><div><h3>{title}</h3><p>{subtitle}</p></div></div><span className="response-status">{side.tokens ? `${side.tokens} tokens` : 'Ответ готов'}</span></div><div className="reasoning-content"><MarkdownContent content={side.content} /><PromptDetails messages={prompt} label="Показать prompt" /></div></article>
}

function PromptDetails({ messages, label }: { messages: PromptMessage[]; label: string }) {
  return <details className="generated-prompt"><summary>{label}</summary><div className="prompt-messages">{messages.map((message, index) => <div className="prompt-message" key={`${message.role}-${index}`}><span className="prompt-message-label">{message.role === 'system' ? 'system prompt' : 'user prompt'}</span><pre><code>{message.content}</code></pre></div>)}</div></details>
}

function ResponseCard({ title, subtitle, variant, side }: { title: string; subtitle: string; variant: 'free' | 'controlled'; side: ComparisonSide }) {
  return <article className={`response-card ${variant}`}><div className="response-card-header"><div><span className="response-marker">{variant === 'free' ? 'A' : 'B'}</span><div><h3>{title}</h3><p>{subtitle}</p></div></div><span className="response-status">{side.tokens ? `${side.tokens} output tokens` : 'Ответ готов'}</span></div><div className="response-content"><ResponseContent content={side.content} /></div></article>
}

function ResponseContent({ content }: { content: string }) {
  const formattedJson = formatJson(content)
  if (formattedJson) return <pre className="json-content"><code>{formattedJson}</code></pre>
  return <MarkdownContent content={content} />
}

function formatJson(content: string) {
  const trimmedContent = content.trim()
  const fencedMatch = trimmedContent.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const jsonCandidate = fencedMatch?.[1] ?? trimmedContent

  try {
    return JSON.stringify(JSON.parse(jsonCandidate), null, 2)
  } catch {
    return null
  }
}

function MarkdownContent({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{normalizeMathDelimiters(content)}</ReactMarkdown>
}

function normalizeMathDelimiters(content: string) {
  return content
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, formula: string) => `$$${formula}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, formula: string) => `$${formula}$`)
}

export default App
