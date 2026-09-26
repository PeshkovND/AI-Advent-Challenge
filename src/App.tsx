import { FormEvent, KeyboardEvent, ReactNode, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

type MessageRole = 'user' | 'assistant'
type Page = 'chat' | 'compare' | 'reasoning' | 'temperature' | 'models' | 'agents' | 'context-demo' | 'context-comparison' | 'context-strategies' | 'context-branching' | 'memory-layers' | 'personalization' | 'task-state' | 'calendar-mcp' | 'scheduler'

type ChatMessage = {
  id: string
  role: MessageRole
  content: string
}
type McpToolTrace = { name: string; serverId: string; isError: boolean }
type SchedulerEvent = { id: string; createdAt: string; stage: string; message: string }
type SchedulerRun = { id: string; trigger: 'scheduled' | 'manual'; status: 'queued' | 'running' | 'success' | 'skipped' | 'error'; startedAt?: string; finishedAt?: string; decisionReason?: string; summary?: string; error?: string; events?: SchedulerEvent[] }
type SchedulerJob = { id: string; name: string; cron: string; timezone: string; instructionText: string; enabled: boolean; nextRunAt: string; lastRunAt?: string; latestRun?: SchedulerRun; runs: SchedulerRun[] }
type SchedulerState = { jobs: SchedulerJob[]; worker?: { last_heartbeat_at?: string; active_jobs_count?: number }; defaultTimeZone?: string }
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

function browserTimeZoneContext() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return timeZone ? { timeZone } : undefined
}

function submitTextareaOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
  event.preventDefault()
  event.currentTarget.form?.requestSubmit()
}
type AgentProvider = 'deepseek' | 'huggingface' | 'openrouter'
type AgentConfig = {
  name?: string
  provider: AgentProvider
  model: string
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
  inputPolicy?: { maxCharacters?: number }
  outputPolicy?: { maxCharacters?: number; format?: 'text' | 'json'; stopSequences?: string[] }
  contextStrategy?: { strategy: 'sliding' | 'facts' | 'branching' | 'summary'; windowSize?: number; summarizeAfterMessages?: number; facts?: Record<string, string[]> }
  memoryLayers?: { mode?: 'manual' | 'auto'; enabled?: boolean; shortTermLimit?: number; useWorking?: boolean; useLongTerm?: boolean; working?: ManualMemoryEntry[]; longTerm?: ManualMemoryEntry[]; autoInstructions?: string }
  personalization?: { activeProfileId?: string; profiles?: UserProfile[]; globalLongTerm?: ManualMemoryEntry[] }
  invariants?: { enabled?: boolean; items?: AgentInvariant[] }
  taskState?: AgentTaskState
  taskMachine?: boolean
  mcp?: { enabled: boolean; servers: string[]; toolAccess?: 'all' | 'read-only'; serverToolAccess?: Record<string, 'all' | 'read-only'> }
}
type AgentInvariant = { id: string; title: string; rule: string }
type InvariantField = AgentInvariant
type InvariantCheckInfo = { status: 'passed' | 'repaired' | 'blocked'; attempts: number; violatedInvariantIds: string[]; explanation?: string; safeDirection?: string }
type AgentSummary = { id: string; config: AgentConfig; createdAt?: string }
type AgentsListResult = { agents: AgentSummary[]; count: number }
type AgentTokenMetrics = { inputTokens: number; promptTokens: number; completionTokens: number; totalTokens: number }
type AgentTokenUsagePoint = AgentTokenMetrics & { turn: number; conversationTokens: number; summaryTokens?: number; strategyTokens?: number; strategyTokenMetrics?: AgentTokenMetrics }
type AgentContextInfo = { enabled: boolean; summary?: string; summarizedMessages: number; retainedMessages: number; estimatedFullPromptTokens: number; estimatedSentPromptTokens: number; estimatedSavedTokens: number; summaryTokens?: number }
type AgentContextCompression = { enabled?: boolean; summarizeAfterMessages?: number }
type AgentStreamChunk = { content?: string; error?: string; done?: boolean; result?: { durationMs?: number; tokens?: number; conversationTokens?: number; contextMessages?: number; tokenMetrics?: AgentTokenMetrics; context?: AgentContextInfo; invariantCheck?: InvariantCheckInfo } }
type AgentHistoryResult = { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; archived?: boolean }>; count: number; conversationTokens?: number }
type ManualMemoryEntry = { id: string; text: string; createdAt: string }
type UserProfile = { id: string; name: string; style?: string; format?: string; restrictions?: string }
type TaskStage = 'planning' | 'execution' | 'validation' | 'done'
type TaskStatus = 'active' | 'paused'
type AgentTaskState = { id?: string; task: string; stage: TaskStage; status: TaskStatus; currentStep: string; expectedAction: string; expectedActor?: 'agent' | 'user'; completedSteps?: string[]; updatedAt: string }
type TaskRunResult = MemoryRunResult & { taskState?: AgentTaskState; taskNotice?: string }
type TaskRunEvent = { type: 'message'; content: string; taskState?: AgentTaskState; invariantCheck?: InvariantCheckInfo } | { type: 'done'; taskState?: AgentTaskState; taskNotice?: string; invariantCheck?: InvariantCheckInfo } | { type: 'error'; error: string }
type AgentMemorySnapshot = { shortTerm: Array<{ role: 'user' | 'assistant'; content: string }>; working: ManualMemoryEntry[]; longTerm: ManualMemoryEntry[] }
type MemoryRunResult = { output: string; tokenMetrics: AgentTokenMetrics; memory?: AgentMemorySnapshot }
type ProfilePreview = { profileId: string; content?: string; error?: string; tokens?: number }
type AgentModelOption = { value: string; label: string }
type ContextDemoScenario = 'short' | 'long' | 'overflow'
type ContextDemoResponse = {
  id: string
  title: string
  description: string
  model: string
  input?: string
  historyMessages: number
  conversationTokens: number
  tokenHistory?: AgentTokenUsagePoint[]
  messages?: ContextDemoMessage[]
  context?: AgentContextInfo
  compression?: AgentContextCompression
  result?: { output: string; durationMs?: number; tokenMetrics?: AgentTokenMetrics; context?: AgentContextInfo }
  error?: string
}
type ContextDemoMessage = { role: 'user' | 'assistant'; content: string; archived?: boolean }
type ContextComparisonPreparation = { title: string; model: string; history: ContextDemoMessage[]; summarizeAfterMessages: number; input: string }
type ContextCompressionComparisonSide = { output: string; tokenMetrics: AgentTokenMetrics; totalTokensWithSummary: number; summaryTokens?: number; summary?: string; summarizedMessages?: number }
type ContextCompressionComparisonResult = { input: string; model: string; result: { withoutCompression: ContextCompressionComparisonSide; withCompression: ContextCompressionComparisonSide } }
type ContextStrategyName = 'sliding' | 'facts' | 'branching'
type ContextStrategyMessage = { id: string; role: 'user' | 'assistant'; content: string; createdAt: string; tokenMetrics?: AgentTokenMetrics }
type ContextStrategyFacts = { goal: string[]; constraints: string[]; preferences: string[]; decisions: string[]; agreements: string[]; open_questions: string[] }
type ContextStrategyFactsSnapshot = { userMessageId: string; values: ContextStrategyFacts; tokenMetrics?: AgentTokenMetrics; error?: string; createdAt: string }
type ContextStrategyBranch = { id: string; label: string; parentId?: string; checkpointMessageId?: string; messages: ContextStrategyMessage[] }
type ContextStrategyCheckpoint = { id: string; branchId: string; messageId: string; createdAt: string }
type ContextStrategyResult = { output: string; tokenMetrics: AgentTokenMetrics; factsUpdate?: AgentTokenMetrics; factsError?: string; branchId?: string }
type ContextStrategyTurn = { id: string; input: string; createdAt: string; results: Partial<Record<ContextStrategyName, ContextStrategyResult>> }
type ContextStrategyUsage = { promptTokens: number; completionTokens: number; totalTokens: number }
type ContextStrategyStats = { answers: ContextStrategyUsage; facts: ContextStrategyUsage; overall: ContextStrategyUsage; latest?: AgentTokenMetrics }
type AgentStrategyContext = {
  agentId: string
  configured: boolean
  strategy?: ContextStrategyName
  windowSize?: number
  facts?: ContextStrategyFacts
  factsSnapshots?: ContextStrategyFactsSnapshot[]
  branching: { activeBranchId: string; checkpoints: ContextStrategyCheckpoint[]; branches: ContextStrategyBranch[]; activeMessages: ContextStrategyMessage[] }
}
type AgentStrategyRunResult = { output: string; tokenMetrics: AgentTokenMetrics; strategyTokenMetrics?: AgentTokenMetrics; strategyError?: string }
type AgentStrategyHistory = { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; tokenHistory?: AgentTokenUsagePoint[] }
const calendarDemoAgentId = 'day17-mcp-agent'
const calendarDemoAgentConfig: AgentConfig = {
  name: 'Универсальный агент календаря, расписаний и Telegram',
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  systemPrompt: 'Ты полезный универсальный помощник календаря, расписаний и Telegram. Отвечай по-русски, а при необходимости самостоятельно используй доступные MCP-инструменты.',
  mcp: { enabled: true, servers: ['yandex-calendar', 'scheduler', 'telegram'] },
}

const agentModelOptions: Record<AgentProvider, AgentModelOption[]> = {
  deepseek: [
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  ],
  huggingface: [
    { value: 'google/gemma-3-4b-it:deepinfra', label: 'Gemma 3 4B Instruct · DeepInfra' },
  ],
  openrouter: [
    { value: 'liquid/lfm-2.5-2.6b:free', label: 'LFM2.5 2.6B · бесплатно' },
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
const contextStrategyPromptChoices = [
  'Мы готовим первый релиз мобильного приложения Habit Flow. Оно помогает студентам 18–24 лет выработать привычку уделять полезному занятию хотя бы 15 минут в день: чтению, языку, спорту или подготовке к экзаменам. Главная ценность — короткий ежедневный ритуал без сложного обучения.',
  'В MVP оставляем только три функции: список привычек, локальное напоминание в 19:00 по местному времени с возможностью выключить его и экран недельного прогресса с количеством выполненных дней и текущей серией.',
  'Пользователь может создать до пяти привычек, задать короткое название и выбрать один из нескольких нейтральных цветов. Другие настройки привычки, категории и теги в первый релиз не входят.',
  'Не делаем социальную ленту, лайки, соревнования, комментарии, общий рейтинг, чат с наставником, каталог курсов и AI-рекомендации. Не добавляй функции только ради эффектной демонстрации.',
  'Регистрации, аккаунтов, авторизации через Apple или Google и серверной базы не будет. Привычки, отметки и настройка напоминания хранятся только локально на устройстве.',
  'Не обещаем синхронизацию между устройствами, экспорт данных, резервное копирование или восстановление после удаления приложения. В описании нужно прямо сообщить, что удаление приложения может удалить локальные данные.',
  'Команда состоит из одного React-разработчика и одного дизайнера, до внутреннего теста есть ровно две недели. Используем знакомый React Native и не создаём новый бэкенд, платежи или внешние интеграции.',
  'Дизайнер успеет подготовить базовую навигацию, список привычек, создание привычки, отметку выполнения, недельный прогресс, настройки напоминания, пустые состояния и объяснение отказа в разрешении на уведомления.',
  'Первый тест проведём примерно с двадцатью приглашёнными студентами. Публикацию в App Store и Google Play, полноценную локализацию и расширенную аналитику переносим на следующий этап.',
  'Критерий успеха: через семь дней после установки не менее 30% новых участников должны открыть приложение минимум три раза. В интерфейсе и маркетинге нельзя обещать медицинский, терапевтический или образовательный эффект.',
  'Составь краткое ТЗ Habit Flow: цель, аудитория, функции MVP, исключённые функции, ограничения данных, ресурсы команды и метрику успеха.',
]
const contextStrategyAgents: Record<ContextStrategyName, { id: string; name: string }> = {
  sliding: { id: 'day10-comparison-sliding', name: 'Day 10 · Sliding Window' },
  facts: { id: 'day10-comparison-facts', name: 'Day 10 · Sticky Facts' },
  branching: { id: 'day10-comparison-branching', name: 'Day 10 · Branching' },
}
const branchingLabAgent = { id: 'day10-branching-lab', name: 'Day 10 · Branching Lab' }
const day10SystemPrompt = 'Веди предметный диалог: опирайся только на условия из сообщений и, если они есть, из карточки фактов. Не выдумывай недостающие детали. О механизмах хранения контекста не рассказывай, если пользователь прямо не спросил.'
const memoryLabAgent = { id: 'day11-memory-lab', name: 'Day 11 · Memory notebook' }
const memoryLabSystemPrompt = 'Ты помощник по планированию и принятию решений. Учитывай только релевантные записи рабочей и долговременной памяти. Текущий запрос пользователя важнее старых записей. Не упоминай устройство памяти, если тебя прямо не спросили.'
const personalizationLabAgent = { id: 'day12-personalized-assistant', name: 'Day 12 · Personalized assistant' }
const personalizationLabSystemPrompt = 'Ты полезный AI-помощник. Отвечай по существу, учитывай текущий вопрос и применяй активные настройки пользователя без упоминания внутреннего устройства профилей и памяти.'
const defaultProfiles: UserProfile[] = [
  { id: 'tournament-player', name: 'Кирилл · турнирный игрок Unmatched', style: 'Профессионально и предметно. Используй терминологию Unmatched: темп, позиционка, hand management, value, match-up и win condition.', format: 'Начинай с чёткого вердикта, затем давай разбор match-up, ключевые решения по ходам и риски. Оценивай планы с позиции турнирной игры.', restrictions: 'Не объясняй базовые правила без прямой просьбы. Не выдавай субъективные предпочтения за доказанный факт и отмечай, когда совет зависит от карты, колоды или формата турнира.' },
  { id: 'new-player', name: 'Саша · начинающий игрок Unmatched', style: 'Дружелюбно, спокойно и простыми словами. Новые термины сразу кратко объясняй на примере.', format: 'Сначала коротко скажи, что делать, затем дай 2–3 простых шага. Добавляй один пример хода или карты, если это поможет.', restrictions: 'Не перегружай продвинутыми комбинациями, вероятностями и длинными списками персонажей. Не предполагай знания колод, карт и турнирной меты.' },
]
const profileTestPrompts = [
  'Я играю в Unmatched за Алису против Медузы. Какой план на первые два хода будет самым надёжным?',
  'Как оценить match-up между Шерлоком Холмсом и Медузой: какой у каждого план на победу, ключевые риски и что важно учитывать на карте?',
]
const taskStateLabAgent = { id: 'day13-task-state-lab', name: 'Day 14 · Task state + invariants' }
const taskStateLabSystemPrompt = 'Ты iOS-архитектор и помощник по ведению задач. Продолжай работу с актуального этапа и текущего шага. Не повторяй уже пройденные объяснения, если они есть в истории или формальном состоянии. Отвечай только на то, что помогает выполнить ожидаемое действие. При смене этапа коротко сообщи о запуске следующего шага. Сервер сам сделает внутреннее продолжение и покажет его результат отдельным сообщением.'
const day13Profiles: UserProfile[] = [
  { id: 'ios-developer', name: 'Алекс · iOS-разработчик', style: 'Технически точно и прагматично. Используй Swift, SwiftUI, UIKit, Concurrency, MVVM и Apple Human Interface Guidelines только когда это уместно.', format: 'Сначала дай решение или архитектурный вывод, затем конкретные шаги, API и критерии проверки. Для кода объясняй границы ответственности и обработку ошибок.', restrictions: 'Не предлагай устаревшие iOS-подходы без причины. Отделяй подтверждённые требования от допущений и не выдавай псевдокод за готовую production-реализацию.' },
]
const day13Memory = { mode: 'auto' as const, enabled: true, shortTermLimit: 12, useWorking: true, useLongTerm: true, autoInstructions: 'Сохраняй в рабочую память требования текущей iOS-задачи, принятые архитектурные решения, API-контракты и незавершённые шаги. В долгосрочную память добавляй только устойчивые предпочтения по стеку или проектным правилам. Не сохраняй черновые ответы и временные детали задачи.' }
const day14Invariants: AgentInvariant[] = [
  { id: 'swiftui', title: 'UI-слой', rule: 'Использовать SwiftUI. Не предлагать Flutter, React Native или UIKit как реализацию интерфейса.' },
  { id: 'ios-16', title: 'Минимальная версия iOS', rule: 'Поддерживать только iOS 16 и новее.' },
  { id: 'mvvm', title: 'Архитектура', rule: 'Строить решение в архитектуре MVVM.' },
  { id: 'networking', title: 'Сетевой слой', rule: 'Использовать URLSession. Не предлагать сторонние сетевые SDK.' },
  { id: 'privacy', title: 'Данные', rule: 'Не отправлять персональные данные в аналитику.' },
]
const taskStageLabels: Record<TaskStage, { title: string; description: string }> = {
  planning: { title: 'Planning', description: 'Формулируем цель и план.' },
  execution: { title: 'Execution', description: 'Выполняем согласованный план.' },
  validation: { title: 'Validation', description: 'Проверяем результат и критерии.' },
  done: { title: 'Done', description: 'Задача завершена.' },
}
const defaultFormatInstruction = 'Первая строка начинается с "КРАТКО:", затем ровно 3 строки, начинающиеся с "- ". Каждый пункт — не более 8 слов.'
const defaultJsonExample = '{\n  "summary": "Краткое резюме",\n  "items": ["Пункт 1", "Пункт 2"]\n}'
const createStopSequenceField = (value = ''): StopSequenceField => ({ id: crypto.randomUUID(), value })
const createInvariantField = (): InvariantField => ({ id: `invariant-${crypto.randomUUID()}`, title: '', rule: '' })

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
          <button className={`page-nav-button ${activePage === 'context-demo' ? 'active' : ''}`} onClick={() => setActivePage('context-demo')}>
            <span>◫</span> Контекст
          </button>
          <button className={`page-nav-button ${activePage === 'context-comparison' ? 'active' : ''}`} onClick={() => setActivePage('context-comparison')}>
            <span>⇄</span> Сжатие
          </button>
          <button className={`page-nav-button ${activePage === 'context-strategies' ? 'active' : ''}`} onClick={() => setActivePage('context-strategies')}>
            <span>⑩</span> Стратегии
          </button>
          <button className={`page-nav-button ${activePage === 'context-branching' ? 'active' : ''}`} onClick={() => setActivePage('context-branching')}>
            <span>⑂</span> Ветки
          </button>
          <button className={`page-nav-button ${activePage === 'memory-layers' ? 'active' : ''}`} onClick={() => setActivePage('memory-layers')}>
            <span>◉</span> Память
          </button>
          <button className={`page-nav-button ${activePage === 'personalization' ? 'active' : ''}`} onClick={() => setActivePage('personalization')}>
            <span>◐</span> Профили
          </button>
          <button className={`page-nav-button ${activePage === 'task-state' ? 'active' : ''}`} onClick={() => setActivePage('task-state')}>
            <span>⑬</span> Состояние задачи
          </button>
          <button className={`page-nav-button ${activePage === 'calendar-mcp' ? 'active' : ''}`} onClick={() => setActivePage('calendar-mcp')}>
            <span>▣</span> Календарь
          </button>
          <button className={`page-nav-button ${activePage === 'scheduler' ? 'active' : ''}`} onClick={() => setActivePage('scheduler')}>
            <span>⑱</span> Сводки
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="connection-status"><span className="status-dot" /> API подключён</div>
          <p>Ключ API хранится только на сервере.</p>
        </div>
      </aside>

      <main className="day-main">
        {activePage === 'chat' ? <ChatPage /> : activePage === 'compare' ? <ComparePage /> : activePage === 'reasoning' ? <ReasoningPage /> : activePage === 'temperature' ? <TemperaturePage /> : activePage === 'models' ? <ModelsPage /> : activePage === 'agents' ? <AgentsPage /> : activePage === 'context-demo' ? <ContextDemoPage /> : activePage === 'context-comparison' ? <ContextCompressionComparisonPage /> : activePage === 'context-strategies' ? <ContextStrategiesPage /> : activePage === 'context-branching' ? <ContextBranchingPage /> : activePage === 'memory-layers' ? <MemoryLayersPage /> : activePage === 'personalization' ? <PersonalizationPage /> : activePage === 'task-state' ? <TaskStatePage /> : activePage === 'calendar-mcp' ? <CalendarMcpPage /> : <SchedulerPage />}
      </main>
    </div>
  )
}

function CalendarAgentChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([{ id: 'calendar-welcome', role: 'assistant', content: 'Привет! Я отвечаю на обычные вопросы и умею работать с вашим Яндекс Календарём. Например: «Найди свободный час на следующей неделе и создай встречу». ' }])
  const conversationId = useRef(crypto.randomUUID())
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    const content = input.trim()
    if (!content || isLoading) return
    const nextMessages = [...messages, { id: crypto.randomUUID(), role: 'user' as const, content }]
    setMessages(nextMessages)
    setInput('')
    setError(null)
    setIsLoading(true)
    try {
      const response = await fetch(`/api/agents/${calendarDemoAgentId}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: content, conversationId: conversationId.current, clientContext: browserTimeZoneContext() }) })
      const data = await response.json() as { output?: string; mcpToolCalls?: McpToolTrace[] } & ApiError
      const output = data.output
      if (!response.ok || !output) throw new Error(data.error || 'Агент не смог подготовить ответ.')
      const trace = data.mcpToolCalls?.length
        ? `\n\n---\n*MCP-цепочка: ${data.mcpToolCalls.map((tool, index) => `${index + 1}. \`${tool.serverId}.${tool.name}\` ${tool.isError ? '✗' : '✓'}`).join(' → ')}*`
        : ''
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: `${output}${trace}` }])
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось отправить сообщение.')
    } finally { setIsLoading(false) }
  }

  return <section className="calendar-chat-panel">
    <header className="calendar-chat-header"><h1>Календарь и Telegram</h1><p>Спросите о событиях, попросите изменить их или прислать сводку в Telegram.</p></header>
    <div className="calendar-chat-messages">{messages.map((message) => <div key={message.id} className={`calendar-chat-message ${message.role}`}><small>{message.role === 'user' ? 'Вы' : 'Агент календаря'}</small><MarkdownContent content={message.content} /></div>)}{isLoading && <div className="calendar-chat-message assistant"><small>Агент календаря</small>Думаю</div>}</div>
    {error && <div className="error-message" role="alert">{error}</div>}
    <form className="calendar-chat-composer" onSubmit={sendMessage}><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={submitTextareaOnEnter} placeholder="Например: Найди свободный час на следующей неделе и создай встречу" rows={2} /><button className="compare-button" type="submit" disabled={isLoading || !input.trim()}>Отправить <span>→</span></button></form>
  </section>
}

function CalendarMcpPage() {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function prepareDemo() {
      const existing = await fetch(`/api/agents/${calendarDemoAgentId}`)
      if (existing.status === 404) {
        const created = await fetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: calendarDemoAgentId, config: calendarDemoAgentConfig }) })
        if (!created.ok) {
          const data = await created.json() as ApiError
          throw new Error(data.error || 'Не удалось создать демонстрационного MCP-агента.')
        }
      } else if (!existing.ok) {
        const data = await existing.json() as ApiError
        throw new Error(data.error || 'Не удалось проверить демонстрационного агента.')
      }
    }
    void prepareDemo().catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : 'Не удалось подготовить MCP-демонстрацию.'))
  }, [])
  return <div className="page-view calendar-mcp-page">
    {error && <div className="error-message" role="alert">{error}</div>}
    <CalendarAgentChat />
  </div>
}

function formatScheduleTime(value?: string, timeZone?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  try {
    return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone, timeZoneName: 'short' }).format(date)
  } catch { return value }
}

function SchedulerAssistantChat({ onTasksChanged }: { onTasksChanged: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([{ id: 'scheduler-welcome', role: 'assistant', content: 'Я работаю с календарём, расписаниями и Telegram. Могу создать событие, прислать сводку или настроить её регулярную отправку.' }])
  const conversationId = useRef(crypto.randomUUID())
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    const content = input.trim()
    if (!content || isLoading) return
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content }])
    setInput('')
    setError(null)
    setIsLoading(true)
    try {
      const response = await fetch(`/api/agents/${calendarDemoAgentId}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: content, conversationId: conversationId.current, clientContext: browserTimeZoneContext() }) })
      const data = await response.json() as { output?: string; mcpToolCalls?: McpToolTrace[] } & ApiError
      if (!response.ok || !data.output) throw new Error(data.error || 'Агент не смог подготовить ответ.')
      const trace = data.mcpToolCalls?.length ? `\n\n*MCP-цепочка: ${data.mcpToolCalls.map((tool, index) => `${index + 1}. \`${tool.serverId}.${tool.name}\` ${tool.isError ? '✗' : '✓'}`).join(' → ')}*` : ''
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: `${data.output}${trace}` }])
      onTasksChanged()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось отправить сообщение.')
    } finally { setIsLoading(false) }
  }

  return <section className="scheduler-chat">
    <div className="scheduler-chat-messages">{messages.map((message) => <div key={message.id} className={`calendar-chat-message ${message.role}`}><small>{message.role === 'user' ? 'Вы' : 'Агент календаря и расписаний'}</small><MarkdownContent content={message.content} /></div>)}{isLoading && <div className="calendar-chat-message assistant"><small>Агент календаря и расписаний</small>Думаю</div>}</div>
    {error && <div className="error-message" role="alert">{error}</div>}
    <form className="calendar-chat-composer" onSubmit={sendMessage}><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={submitTextareaOnEnter} placeholder="Например: Создай встречу завтра в 15:00 или ежедневную сводку в 9:00" rows={2} /><button className="compare-button" type="submit" disabled={isLoading || !input.trim()}>Отправить <span>→</span></button></form>
  </section>
}

function SchedulerPage() {
  const [state, setState] = useState<SchedulerState>({ jobs: [] })
  const [error, setError] = useState<string | null>(null)
  const [busyJobId, setBusyJobId] = useState<string | null>(null)

  const load = async () => {
    try {
      const response = await fetch('/api/scheduler/jobs')
      const data = await response.json() as SchedulerState & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось получить задачи.')
      setState(data)
      setError(null)
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Не удалось получить задачи.') }
  }

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 5_000)
    return () => window.clearInterval(timer)
  }, [])

  async function runNow(jobId: string) {
    setBusyJobId(jobId)
    try {
      const response = await fetch(`/api/scheduler/jobs/${jobId}/run`, { method: 'POST' })
      const data = await response.json().catch(() => ({})) as ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось поставить запуск в очередь.')
      await load()
    } catch (runError) { setError(runError instanceof Error ? runError.message : 'Не удалось поставить запуск в очередь.') } finally { setBusyJobId(null) }
  }

  async function remove(job: SchedulerJob) {
    if (!window.confirm(`Удалить задачу «${job.name}» и её журнал запусков?`)) return
    setBusyJobId(job.id)
    try {
      const response = await fetch(`/api/scheduler/jobs/${job.id}`, { method: 'DELETE' })
      if (!response.ok) {
        const data = await response.json() as ApiError
        throw new Error(data.error || 'Не удалось удалить задачу.')
      }
      await load()
    } catch (removeError) { setError(removeError instanceof Error ? removeError.message : 'Не удалось удалить задачу.') } finally { setBusyJobId(null) }
  }

  const lastHeartbeat = state.worker?.last_heartbeat_at
  const workerOnline = !error && Boolean(lastHeartbeat && Date.now() - Date.parse(lastHeartbeat) < 90_000)

  return <div className="page-view scheduler-page">
    <header className="scheduler-page-header">
      <div><span className="eyebrow">ДЕНЬ 18 · ПЛАНИРОВЩИК</span><h1>Календарь и сводки</h1><p>Создавайте события и регулярные сводки в одном чате. Новые задачи используют часовой пояс браузера; пояс из сообщения имеет приоритет.</p></div>
      <div className={`scheduler-heartbeat ${workerOnline ? 'online' : ''}`}>{workerOnline ? 'Планировщик работает' : 'Нет связи с планировщиком'}</div>
    </header>
    <SchedulerAssistantChat onTasksChanged={() => void load()} />
    {error && <div className="error-message" role="alert">{error}</div>}
    <section className="scheduler-dashboard">
      <header><h2>Задачи</h2><button className="secondary-button" type="button" onClick={() => void load()}>Обновить</button></header>
      {state.jobs.length === 0 ? <p className="scheduler-empty">Задач пока нет. Создайте первую в чате выше.</p> : <div className="scheduler-jobs">
        {state.jobs.map((job) => <article className="scheduler-job" key={job.id}>
          <header><div><h3>{job.name}</h3><p>Следующий запуск: {formatScheduleTime(job.nextRunAt, job.timezone)} · {job.timezone}</p></div><span className={`scheduler-status ${job.latestRun?.status ?? 'queued'}`}>{job.latestRun ? job.latestRun.status : 'ожидает'}</span></header>
          <p className="scheduler-instruction">{job.instructionText}</p>
          {job.latestRun?.summary && <div className="scheduler-summary"><small>Последняя сводка</small><MarkdownContent content={job.latestRun.summary} /></div>}
          {job.latestRun?.error && <p className="scheduler-run-error">{job.latestRun.error}</p>}
          <footer><button className="secondary-button" type="button" disabled={busyJobId === job.id} onClick={() => void runNow(job.id)}>Запустить сейчас</button><button className="danger-button" type="button" disabled={busyJobId === job.id} onClick={() => void remove(job)}>Удалить</button></footer>
          {job.runs.length > 0 && <details className="scheduler-log"><summary>Журнал запусков ({job.runs.length})</summary>
            {job.runs.map((run) => <div key={run.id} className="scheduler-run"><strong>{run.status}</strong><span>{formatScheduleTime(run.finishedAt ?? run.startedAt, job.timezone)} · {run.trigger === 'manual' ? 'вручную' : 'по расписанию'}</span>{run.decisionReason && <p>{run.decisionReason}</p>}{run.events?.map((event) => <small key={event.id}>{formatScheduleTime(event.createdAt, job.timezone)} · {event.message}</small>)}</div>)}
          </details>}
        </article>)}
      </div>}
    </section>
  </div>
}

function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([initialMessage])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, isLoading])

  useEffect(() => {
    void loadSavedChatHistory()
  }, [])

  async function loadSavedChatHistory() {
    try {
      const response = await fetch('/api/agents/default/history')
      if (!response.ok) return
      const data = (await response.json()) as AgentHistoryResult
      const savedMessages = data.messages.filter((message): message is { role: 'user' | 'assistant'; content: string } => message.role === 'user' || message.role === 'assistant')
      if (savedMessages.length > 0) {
        setMessages([{ ...initialMessage }, ...savedMessages.map((message, index) => ({ ...message, id: `saved-${index}` }))])
      }
    } catch {
      // История — дополнительная возможность, поэтому не блокируем обычный чат при ошибке загрузки.
    }
  }

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
  const [summarizeAfterMessages, setSummarizeAfterMessages] = useState('10')
  const [contextStrategy, setContextStrategy] = useState<'none' | 'sliding' | 'facts' | 'branching' | 'summary'>('none')
  const [contextWindowSize, setContextWindowSize] = useState('10')
  const [initialFacts, setInitialFacts] = useState('')
  const [invariantsEnabled, setInvariantsEnabled] = useState(false)
  const [invariantFields, setInvariantFields] = useState<InvariantField[]>([])
  const [mcpEnabled, setMcpEnabled] = useState(false)
  const [input, setInput] = useState('')
  const [answer, setAnswer] = useState('')
  const [runMeta, setRunMeta] = useState<{ durationMs?: number; tokens?: number; conversationTokens?: number; tokenMetrics?: AgentTokenMetrics; invariantCheck?: InvariantCheckInfo } | null>(null)
  const [historyCount, setHistoryCount] = useState(0)
  const [isLoadingAgents, setIsLoadingAgents] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadAgents()
  }, [])

  useEffect(() => {
    if (selectedAgentId) void loadAgentHistory(selectedAgentId)
  }, [selectedAgentId])

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

  async function loadAgentHistory(id: string) {
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(id)}/history`)
      if (!response.ok) return
      const data = (await response.json()) as AgentHistoryResult
      setHistoryCount(data.count)
    } catch {
      setHistoryCount(0)
    }
  }

  async function clearAgentHistory() {
    if (!selectedAgentId || isRunning) return
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(selectedAgentId)}/history`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Не удалось очистить контекст агента.')
      setHistoryCount(0)
      setAnswer('')
      setRunMeta(null)
      setError(null)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось очистить контекст агента.')
    }
  }

  async function deleteAgent(id: string) {
    if (id === 'default' || isRunning || !window.confirm(`Удалить агента «${id}» вместе с его историей?`)) return

    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!response.ok) {
        const data = (await response.json()) as ApiError
        throw new Error(data.error || 'Не удалось удалить агента.')
      }
      const remainingAgents = agents.filter((agent) => agent.id !== id)
      setAgents(remainingAgents)
      if (selectedAgentId === id) {
        setSelectedAgentId(remainingAgents[0]?.id ?? '')
        setAnswer('')
        setRunMeta(null)
        setHistoryCount(0)
      }
      setError(null)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось удалить агента.')
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
      const numericSummarizeAfterMessages = Number(summarizeAfterMessages)
      const numericContextWindowSize = Number(contextWindowSize)
      const stopSequenceValues = stopSequenceFields.map(({ value }) => value.trim()).filter(Boolean)
      const invariantItems = invariantFields.map((item) => ({ ...item, title: item.title.trim(), rule: item.rule.trim() })).filter((item) => item.title && item.rule)
      let parsedFacts: Record<string, string[]> | undefined
      if (contextStrategy === 'facts' && initialFacts.trim()) {
        try {
          const candidate = JSON.parse(initialFacts) as unknown
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Facts должны быть JSON-объектом.')
          parsedFacts = Object.fromEntries(Object.entries(candidate as Record<string, unknown>).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
          ]))
        } catch (factsError) {
          setError(factsError instanceof Error ? factsError.message : 'Проверьте JSON facts.')
          setIsCreating(false)
          return
        }
      }
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
        contextStrategy: contextStrategy === 'summary' ? {
          strategy: 'summary',
          summarizeAfterMessages: Number.isFinite(numericSummarizeAfterMessages) ? Math.min(Math.max(Math.floor(numericSummarizeAfterMessages), 1), 100) : 10,
        } : contextStrategy !== 'none' ? {
          strategy: contextStrategy,
          windowSize: Number.isFinite(numericContextWindowSize) ? Math.min(Math.max(Math.floor(numericContextWindowSize), 1), 1_000_000) : 10,
          ...(parsedFacts ? { facts: parsedFacts } : {}),
        } : undefined,
        invariants: invariantsEnabled ? { enabled: true, items: invariantItems } : undefined,
        mcp: mcpEnabled ? { enabled: true, servers: ['yandex-calendar'] } : undefined,
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
      setHistoryCount(0)
      setAgentId('')
      setAgentName('')
      setSystemPrompt('')
      setSummarizeAfterMessages('10')
      setContextStrategy('none')
      setContextWindowSize('10')
      setInitialFacts('')
      setInvariantsEnabled(false)
      setInvariantFields([])
      setMcpEnabled(false)
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
          if (chunk.done && chunk.result) {
            setRunMeta(chunk.result)
            if (chunk.result.contextMessages !== undefined) setHistoryCount(chunk.result.contextMessages)
          }
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
              <label>Провайдер<select value={provider} onChange={(event) => { const nextProvider = event.target.value as AgentProvider; setProvider(nextProvider); setModel(agentModelOptions[nextProvider][0].value) }}><option value="deepseek">DeepSeek</option><option value="huggingface">Hugging Face</option><option value="openrouter">OpenRouter</option></select></label>
              <label>Модель<select value={model} onChange={(event) => setModel(event.target.value)}>{agentModelOptions[provider].map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
            </div>
            <label>Системный промпт<textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} placeholder="Например: отвечай кратко и с примерами..." rows={3} /></label>
            <div className="invariant-editor"><div className="agent-field-heading"><span>MCP-инструменты</span><label className="invariant-toggle"><input type="checkbox" checked={mcpEnabled} onChange={(event) => setMcpEnabled(event.target.checked)} /> Включить Яндекс Календарь</label></div><p>Агент сам выбирает MCP-инструменты через нативный tool calling. В конфигурацию сохраняется только серверный id, без команд и секретов. Выбранная модель должна поддерживать function calling.</p></div>
            <div className="invariant-editor"><div className="agent-field-heading"><span>Инварианты</span><label className="invariant-toggle"><input type="checkbox" checked={invariantsEnabled} onChange={(event) => setInvariantsEnabled(event.target.checked)} /> Включить</label></div><p>Жёсткие правила, которые агент не имеет права нарушать.</p>{invariantsEnabled && <div className="invariant-list">{invariantFields.map((item, index) => <div className="invariant-row" key={item.id}><input value={item.title} onChange={(event) => setInvariantFields((current) => current.map((entry) => entry.id === item.id ? { ...entry, title: event.target.value } : entry))} placeholder={`Правило ${index + 1}, например: Стек`} aria-label={`Название инварианта ${index + 1}`} /><textarea value={item.rule} onChange={(event) => setInvariantFields((current) => current.map((entry) => entry.id === item.id ? { ...entry, rule: event.target.value } : entry))} placeholder="Например: Использовать только SwiftUI и iOS 16+." rows={2} aria-label={`Описание инварианта ${index + 1}`} /><button className="stop-remove" type="button" onClick={() => setInvariantFields((current) => current.filter((entry) => entry.id !== item.id))} aria-label={`Удалить инвариант ${index + 1}`}>×</button></div>)}<button className="stop-add" type="button" onClick={() => setInvariantFields((current) => [...current, createInvariantField()])}>＋ Добавить инвариант</button></div>}</div>
            <div className="agent-form-row">
              <label>Температура<input type="number" min="0" max="2" step="0.1" value={temperature} onChange={(event) => setTemperature(event.target.value)} /></label>
              <label>Максимум токенов <span className="field-optional">необязательно</span><input type="number" min="1" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} placeholder="без лимита" /></label>
            </div>
            <label>Формат ответа<select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value as 'text' | 'json')}><option value="text">Обычный текст</option><option value="json">JSON</option></select></label>
            <div className="agent-stop-section"><div className="agent-field-heading"><span>Stop sequence</span><small>Необязательно</small></div><div className="stop-list">{stopSequenceFields.map((sequence, index) => <div className="stop-row" key={sequence.id}><input className="stop-input" value={sequence.value} onChange={(event) => setStopSequenceFields((current) => current.map((item) => item.id === sequence.id ? { ...item, value: event.target.value } : item))} placeholder={index === 0 ? 'Например: <END>' : 'Следующая последовательность'} aria-label={`Stop sequence ${index + 1}`} /><button className="stop-remove" type="button" onClick={() => setStopSequenceFields((current) => current.filter((item) => item.id !== sequence.id))} aria-label={`Удалить stop sequence ${index + 1}`}>×</button></div>)}<button className="stop-add" type="button" onClick={() => setStopSequenceFields((current) => [...current, createStopSequenceField()])} aria-label="Добавить stop sequence" title="Добавить stop sequence">＋</button></div></div>
            <label>Стратегия контекста<select value={contextStrategy} onChange={(event) => setContextStrategy(event.target.value as typeof contextStrategy)}><option value="none">Без стратегии</option><option value="sliding">Sliding Window</option><option value="facts">Sticky Facts</option><option value="branching">Branching</option><option value="summary">Summary</option></select></label>
            {(contextStrategy === 'sliding' || contextStrategy === 'facts') && <label>Размер окна N<input type="number" min="1" max="1000000" value={contextWindowSize} onChange={(event) => setContextWindowSize(event.target.value)} /><small className="field-help">Окно хранится отдельно у этого агента.</small></label>}
            {contextStrategy === 'summary' && <label>Сжимать после N сообщений<input type="number" min="1" max="100" value={summarizeAfterMessages} onChange={(event) => setSummarizeAfterMessages(event.target.value)} /></label>}
            {contextStrategy === 'facts' && <label>Начальные facts <span className="field-optional">JSON, необязательно</span><textarea value={initialFacts} onChange={(event) => setInitialFacts(event.target.value)} placeholder='{"goal":["..."],"constraints":[]}' rows={3} /></label>}
            <button className="compare-button" type="submit" disabled={isCreating || !agentId.trim()}>{isCreating ? 'Создаём...' : 'Создать агента'} <span>→</span></button>
          </form>
        </section>

        <section className="agent-run-panel">
          <div className="section-heading"><div><span className="step-number">02</span><div><p className="eyebrow">Запуск</p><h2>Сообщение агенту</h2></div></div></div>
          <div className="agent-picker">
            <label>Выберите агента<select value={selectedAgentId} onChange={(event) => { setSelectedAgentId(event.target.value); setAnswer(''); setRunMeta(null) }} disabled={isLoadingAgents || agents.length === 0}>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.config.name || agent.id} · {agent.id}</option>)}</select></label>
            {selectedAgent && <div className="agent-config-summary"><strong>{selectedAgent.id}</strong><span>{selectedAgent.config.provider} · {selectedAgent.config.model}</span><span>temperature {selectedAgent.config.temperature ?? 'по умолчанию'}</span><span>контекст: {historyCount} сообщений</span></div>}
            {selectedAgent && <AgentConfigDetails config={selectedAgent.config} />}
          </div>
          <form className="agent-message-form" onSubmit={runAgent}>
            <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Напишите сообщение выбранному агенту..." rows={5} disabled={isRunning || agents.length === 0} />
            <button className="compare-button" type="submit" disabled={isRunning || !input.trim() || agents.length === 0}>{isRunning ? 'Агент отвечает...' : 'Отправить сообщение'} <span>→</span></button>
          </form>
          <div className="agent-answer"><div className="agent-answer-heading"><div><p className="eyebrow">Ответ агента</p><h3>{selectedAgent?.config.name || selectedAgent?.id || 'Агент не выбран'}</h3></div><div className="agent-answer-actions">{runMeta && <span className="response-status">{runMeta.durationMs ?? '—'} мс · {runMeta.tokens ?? '—'} tokens</span>}<button className="clear-context-button" type="button" onClick={() => void clearAgentHistory()} disabled={isRunning || historyCount === 0}>Очистить контекст</button></div></div>{runMeta?.invariantCheck && <InvariantCheckBadge check={runMeta.invariantCheck} />}{runMeta?.tokenMetrics && <AgentTokenMetricsView metrics={runMeta.tokenMetrics} conversationTokens={runMeta.conversationTokens} />}{answer ? <div className="reasoning-content"><MarkdownContent content={answer} /></div> : <div className="agent-empty">{isRunning ? <><span className="loading-spinner" /> Получаем проверенный ответ...</> : 'Здесь появится ответ выбранного агента.'}</div>}</div>
        </section>
      </div>

      <section className="results-section agent-list-section"><div className="results-heading"><div><span className="step-number">03</span><div><p className="eyebrow">Реестр</p><h2>Созданные агенты</h2></div></div><span className="same-prompt">{agents.length} {pluralizeAgents(agents.length)}</span></div><div className="agent-list">{agents.map((agent) => <div className={`agent-list-item ${agent.id === selectedAgentId ? 'active' : ''}`} key={agent.id}><button className="agent-list-select" type="button" onClick={() => { setSelectedAgentId(agent.id); setAnswer(''); setRunMeta(null) }}><span className="agent-list-icon">{agent.id === 'default' ? 'D' : 'A'}</span><span><strong>{agent.config.name || agent.id}</strong><small>{agent.id} · {agent.config.provider} · {agent.config.model}</small></span><span className="agent-list-arrow">→</span></button>{agent.id === 'default' ? <span className="agent-built-in">Встроенный</span> : <button className="agent-delete-button" type="button" onClick={() => void deleteAgent(agent.id)} aria-label={`Удалить агента ${agent.id}`} title="Удалить агента">×</button>}</div>)}</div></section>
    </div>
  )
}

function AgentConfigDetails({ config }: { config: AgentConfig }) {
  const outputFormat = config.outputPolicy?.format === 'json' ? 'JSON' : 'Обычный текст'
  const stopSequences = config.outputPolicy?.stopSequences?.length ? config.outputPolicy.stopSequences.join(' · ') : 'не заданы'
  const strategy = config.contextStrategy
  const strategyLabel = strategy?.strategy === 'sliding' ? `Sliding Window · N=${strategy.windowSize ?? '—'}` : strategy?.strategy === 'facts' ? `Sticky Facts · N=${strategy.windowSize ?? '—'}` : strategy?.strategy === 'branching' ? 'Branching' : strategy?.strategy === 'summary' ? `Summary · N=${strategy.summarizeAfterMessages ?? 10}` : 'не задана'
  const invariants = config.invariants?.enabled ? config.invariants.items ?? [] : []
  return <div className="agent-config-details"><div className="agent-config-details-heading"><span>Параметры выбранного агента</span><small>Текущая конфигурация</small></div><div className="agent-config-details-grid"><div><small>Название</small><strong>{config.name || 'не задано'}</strong></div><div><small>Temperature</small><strong>{config.temperature ?? 'по умолчанию'}</strong></div><div><small>Максимум токенов ответа</small><strong>{config.maxTokens ?? 'без лимита'}</strong></div><div><small>Стратегия контекста</small><strong>{strategyLabel}</strong></div><div><small>Формат ответа</small><strong>{outputFormat}</strong></div><div><small>Лимит входа</small><strong>{config.inputPolicy?.maxCharacters ? `${config.inputPolicy.maxCharacters} символов` : 'без лимита'}</strong></div><div><small>Stop-последовательности</small><strong>{stopSequences}</strong></div><div><small>Инварианты</small><strong>{invariants.length ? `${invariants.length} активн.` : 'не заданы'}</strong></div><div><small>MCP</small><strong>{config.mcp?.enabled ? config.mcp.servers.join(' · ') : 'выключен'}</strong></div><div className="agent-config-details-wide"><small>Системный промпт</small><strong>{config.systemPrompt || 'не задан'}</strong></div>{invariants.length > 0 && <div className="agent-config-details-wide"><small>Жёсткие правила</small><strong>{invariants.map((item) => `${item.title}: ${item.rule}`).join(' · ')}</strong></div>}</div></div>
}

function AgentTokenMetricsView({ metrics, conversationTokens }: { metrics: AgentTokenMetrics; conversationTokens?: number }) {
  const accumulatedTokens = conversationTokens ?? metrics.totalTokens
  return <><div className="agent-token-metrics"><div><small>Текущий запрос</small><strong>~{metrics.inputTokens}</strong></div><div><small>Весь промпт</small><strong>{metrics.promptTokens}</strong></div><div><small>Всего за диалог</small><strong>{accumulatedTokens}</strong></div><div><small>Ответ модели</small><strong>{metrics.completionTokens}</strong></div></div><p className="agent-token-note">«Текущий запрос» — приблизительное число токенов только нового сообщения пользователя. «Весь промпт» — точный prompt_tokens: системный промпт, история и новый вопрос. «Всего за диалог» — накопленная сумма total_tokens успешных API-вызовов.</p></>
}

function TokenUsageChart({ points }: { points: AgentTokenUsagePoint[] }) {
  if (points.length === 0) return <div className="context-demo-chart-empty">После первого успешного ответа здесь появится график.</div>

  const width = 720
  const height = 280
  const padding = { top: 18, right: 18, bottom: 34, left: 48 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  const values = points.flatMap((point) => [point.inputTokens, point.promptTokens, point.conversationTokens, point.completionTokens])
  const maxValue = Math.max(...values, 1)
  const x = (index: number) => padding.left + (points.length === 1 ? chartWidth / 2 : (index / (points.length - 1)) * chartWidth)
  const y = (value: number) => padding.top + chartHeight - (value / maxValue) * chartHeight
  const series = [
    { key: 'inputTokens' as const, label: 'Текущий запрос', color: '#5d60e6' },
    { key: 'promptTokens' as const, label: 'Весь промпт', color: '#9664d9' },
    { key: 'conversationTokens' as const, label: 'Всего за диалог', color: '#2fa878' },
    { key: 'completionTokens' as const, label: 'Ответ модели', color: '#c77932' },
  ]

  return <div className="token-usage-chart"><div className="token-usage-legend">{series.map((item) => <span key={item.key}><i style={{ backgroundColor: item.color }} />{item.label}</span>)}</div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="График расхода токенов по запросам">{[0, 0.25, 0.5, 0.75, 1].map((ratio) => <g key={ratio}><line x1={padding.left} x2={width - padding.right} y1={y(maxValue * ratio)} y2={y(maxValue * ratio)} className="token-chart-grid-line" /><text x={padding.left - 8} y={y(maxValue * ratio) + 3} className="token-chart-axis-label" textAnchor="end">{Math.round(maxValue * ratio)}</text></g>)}{series.map((item) => <polyline key={item.key} fill="none" stroke={item.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" points={points.map((point, index) => `${x(index)},${y(point[item.key])}`).join(' ')} />)}{series.flatMap((item) => points.map((point, index) => <circle key={`${item.key}-${point.turn}`} cx={x(index)} cy={y(point[item.key])} r="4" fill="#fff" stroke={item.color} strokeWidth="2"><title>{`${item.label}, запрос ${point.turn}: ${point[item.key]} токенов`}</title></circle>))}{points.map((point, index) => <text key={`turn-${point.turn}`} x={x(index)} y={height - 10} className="token-chart-axis-label" textAnchor="middle">{point.turn}</text>)}</svg><p className="token-chart-caption">Номер запроса →</p></div>
}

function pluralizeAgents(count: number) {
  if (count % 10 === 1 && count % 100 !== 11) return 'агент'
  if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) return 'агента'
  return 'агентов'
}

function ContextDemoPage() {
  const [session, setSession] = useState<ContextDemoResponse | null>(null)
  const [messages, setMessages] = useState<ContextDemoMessage[]>([])
  const [input, setInput] = useState('')
  const [lastMetrics, setLastMetrics] = useState<AgentTokenMetrics | null>(null)
  const [lastDuration, setLastDuration] = useState<number | null>(null)
  const [lastContext, setLastContext] = useState<AgentContextInfo | null>(null)
  const [compressionSettings, setCompressionSettings] = useState({ summarizeAfterMessages: 10 })
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadDemo()
  }, [])

  function applySession(data: ContextDemoResponse) {
    setSession(data)
    setMessages(data.messages ?? [])
    setLastMetrics(null)
    setLastDuration(null)
    setLastContext(null)
    setCompressionSettings({ summarizeAfterMessages: data.compression?.summarizeAfterMessages ?? 10 })
    setInput('')
  }

  async function loadDemo() {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/context-demo')
      const data = (await response.json()) as ContextDemoResponse & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось загрузить агента.')
      applySession(data)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить агента.')
    } finally {
      setIsLoading(false)
    }
  }

  async function resetDemo() {
    if (isLoading) return
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/context-demo/reset', { method: 'POST' })
      const data = (await response.json()) as ContextDemoResponse & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось подготовить диалог.')
      applySession(data)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось подготовить диалог.')
    } finally {
      setIsLoading(false)
    }
  }

  async function deleteDemoAgent() {
    if (isLoading || !window.confirm('Удалить текущего агента вместе с историей и начать новый диалог?')) return
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/context-demo/agent', { method: 'DELETE' })
      const data = (await response.json()) as ContextDemoResponse & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось удалить агента.')
      applySession(data)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось удалить агента.')
    } finally {
      setIsLoading(false)
    }
  }

  async function saveCompression(enabled: boolean) {
    if (isLoading) return
    if (!Number.isInteger(compressionSettings.summarizeAfterMessages) || compressionSettings.summarizeAfterMessages < 1) {
      setError('Число сообщений должно быть целым и не меньше 1.')
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/context-demo/compression', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, ...compressionSettings }),
      })
      const data = (await response.json()) as ContextDemoResponse & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось изменить режим сжатия.')
      applySession(data)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось изменить режим сжатия.')
    } finally {
      setIsLoading(false)
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    const trimmedInput = input.trim()
    if (!trimmedInput || isLoading) return
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/context-demo/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: trimmedInput }),
      })
      const data = (await response.json()) as ContextDemoResponse & ApiError
      if (!response.ok || !data.result) throw new Error(data.error || 'Не удалось получить ответ модели.')
      setSession(data)
      setMessages((current) => data.messages ?? [...current, { role: 'user', content: data.input || trimmedInput }, { role: 'assistant', content: data.result!.output }])
      setLastMetrics(data.result.tokenMetrics ?? null)
      setLastDuration(data.result.durationMs ?? null)
      setLastContext(data.context ?? data.result.context ?? null)
      setInput('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось получить ответ модели.')
    } finally {
      setIsLoading(false)
    }
  }

  const context = lastContext ?? session?.context
  const compressionEnabled = context?.enabled ?? true

  return <div className="page-view context-demo-page">
    <header className="page-header"><div><p className="eyebrow">Управление контекстом</p><h1>Один агент, один диалог</h1><p className="header-description">Сжимайте раннюю историю в summary и сравнивайте размер промпта с полной историей.</p></div><div className="model-badge"><span className="pulse-dot" /> LFM2.5 2.6B</div></header>
    <div className="context-demo-note">Когда в истории накопится N сообщений диалога, перед следующим вопросом они вместе с предыдущим summary будут сжаты в новую сводку. В этот запрос попадут только summary и новый вопрос.</div>
    {error && <div className="error-message" role="alert">{error}</div>}
    <div className="context-demo-layout">
      <section className="context-demo-chat">
        <div className="context-demo-chat-heading"><div><p className="eyebrow">Чат</p><h2>Диалог с LFM2.5 2.6B</h2><p>{compressionEnabled ? 'При достижении порога агент заменит накопленную историю summary перед следующим ответом.' : 'В модель отправляется полная история диалога.'}</p></div><div className="context-demo-actions"><button className={`context-compression-button ${compressionEnabled ? 'enabled' : ''}`} type="button" onClick={() => void saveCompression(!compressionEnabled)} disabled={isLoading}>{compressionEnabled ? 'Сжатие: включено' : 'Сжатие: выключено'}</button><button className="clear-context-button" type="button" onClick={() => void resetDemo()} disabled={isLoading}>Начать заново</button></div></div>
        <div className="context-demo-messages" aria-live="polite">{messages.length === 0 ? <div className="context-demo-empty">Напишите первое сообщение агенту.</div> : messages.map((message, index) => <div className={`context-demo-message ${message.role} ${message.archived ? 'archived' : ''}`} key={`${message.role}-${index}`}><small>{message.role === 'user' ? 'Вы' : 'LFM2.5 2.6B'}{message.archived ? ' · в summary' : ''}</small><div className="reasoning-content"><MarkdownContent content={message.content} /></div></div>)}</div>
        <form className="context-demo-composer" onSubmit={sendMessage}><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Напишите следующее сообщение агенту..." rows={3} disabled={isLoading} /><button className="compare-button" type="submit" disabled={isLoading || !input.trim()}>{isLoading ? 'Получаем ответ...' : 'Отправить'} <span>→</span></button></form>
      </section>
      <aside className="context-demo-sidebar"><div className="context-demo-sidebar-heading"><p className="eyebrow">Метрики последнего запроса</p><h2>Токены</h2>{lastDuration !== null && <span>Ответ за {lastDuration} мс</span>}</div>{lastMetrics ? <AgentTokenMetricsView metrics={lastMetrics} conversationTokens={session?.conversationTokens} /> : <div className="context-demo-metrics-empty">После первого ответа здесь появятся четыре значения.</div>}<div className="context-demo-sidebar-info"><strong>Метрики</strong><span>«Текущий запрос» — приблизительная оценка нового сообщения.</span><span>«Весь промпт» — точный <code>prompt_tokens</code> фактически отправленного контекста.</span><span>«Ответ модели» — <code>completion_tokens</code> этого вызова.</span><span>«Всего за диалог» — сумма <code>total_tokens</code> всех успешных вызовов, включая вызовы для summary.</span><span>Лимит модели — 65 536 токенов.</span></div><button className="context-demo-delete-button" type="button" onClick={() => void deleteDemoAgent()} disabled={isLoading}>Удалить агента и начать заново</button></aside>
      <section className="context-compression-summary"><div className="context-demo-chart-heading"><div><p className="eyebrow">Сжатый контекст</p><h2>{compressionEnabled ? 'Режим сжатия включён' : 'Режим сжатия выключен'}</h2></div><span>{context?.summarizedMessages ?? 0} сообщений в summary</span></div><form className="context-compression-settings" onSubmit={(event) => { event.preventDefault(); void saveCompression(compressionEnabled) }}><label>Суммаризировать после N сообщений диалога<input type="number" min="1" max="100" value={compressionSettings.summarizeAfterMessages} onChange={(event) => setCompressionSettings({ summarizeAfterMessages: Number(event.target.value) })} disabled={isLoading} /></label><button className="context-compression-button" type="submit" disabled={isLoading}>Применить настройки</button></form><div className="context-compression-stats"><div><small>Следующий без сжатия</small><strong>~{context?.estimatedFullPromptTokens ?? 0}</strong></div><div><small>Следующий в модель</small><strong>~{context?.estimatedSentPromptTokens ?? 0}</strong></div><div><small>Оценочная экономия</small><strong>~{context?.estimatedSavedTokens ?? 0}</strong></div><div><small>Новых сообщений</small><strong>{context?.retainedMessages ?? 0}</strong></div></div>{compressionEnabled ? context?.summary ? <details className="context-summary-details" open><summary>Summary, подставляемый в следующий запрос</summary><div className="reasoning-content"><MarkdownContent content={context.summary} /></div></details> : <p className="context-summary-empty">Summary будет создан перед следующим вопросом, когда в истории накопится {compressionSettings.summarizeAfterMessages} сообщений диалога.</p> : <p className="context-summary-empty">Включите сжатие и продолжите диалог, чтобы заменить накопленную историю summary. Для сравнения переключайте режим перед следующим запросом.</p>}</section>
      <section className="context-demo-chart-section"><div className="context-demo-chart-heading"><div><p className="eyebrow">Динамика</p><h2>Расход токенов по запросам</h2></div><span>{session?.tokenHistory?.length ?? 0} запросов</span></div><TokenUsageChart points={session?.tokenHistory ?? []} /></section>
    </div>
  </div>
}

function MemoryLayersPage() {
  const [agent, setAgent] = useState<AgentSummary | null>(null)
  const [history, setHistory] = useState<AgentHistoryResult['messages']>([])
  const [input, setInput] = useState('')
  const [note, setNote] = useState('')
  const [noteLayer, setNoteLayer] = useState<'working' | 'longTerm'>('working')
  const [lastMetrics, setLastMetrics] = useState<AgentTokenMetrics | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  async function ensureAgent() {
    const existing = await fetch(`/api/agents/${memoryLabAgent.id}`)
    if (existing.ok) return await existing.json() as AgentSummary
    if (existing.status !== 404) throw new Error('Не удалось проверить учебного агента памяти.')
    const response = await fetch('/api/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: memoryLabAgent.id, config: { name: memoryLabAgent.name, provider: 'deepseek', model: 'deepseek-v4-flash', temperature: 0, systemPrompt: memoryLabSystemPrompt, memoryLayers: { mode: 'manual', enabled: true, shortTermLimit: 12, useWorking: true, useLongTerm: true, working: [], longTerm: [] } } }),
    })
    const data = await response.json() as AgentSummary & ApiError
    if (!response.ok) throw new Error(data.error || 'Не удалось создать учебного агента.')
    return data
  }

  async function load() {
    setIsLoading(true)
    try {
      const currentAgent = await ensureAgent()
      const historyResponse = await fetch(`/api/agents/${memoryLabAgent.id}/history`)
      const historyData = await historyResponse.json() as AgentHistoryResult & ApiError
      if (!historyResponse.ok) throw new Error(historyData.error || 'Не удалось загрузить историю.')
      setAgent(currentAgent); setHistory(historyData.messages); setError(null)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить память.') } finally { setIsLoading(false) }
  }

  const memory = agent?.config.memoryLayers ?? { mode: 'manual' as const, enabled: true, shortTermLimit: 12, useWorking: true, useLongTerm: true, working: [], longTerm: [] }
  const shortTerm = history.slice(-Math.max(2, memory.shortTermLimit ?? 12))
  if (shortTerm[0]?.role === 'assistant') shortTerm.shift()

  async function saveMemory(next: NonNullable<AgentConfig['memoryLayers']>) {
    if (!agent) return
    setIsLoading(true); setError(null)
    try {
      const response = await fetch(`/api/agents/${agent.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { ...agent.config, memoryLayers: next } }) })
      const data = await response.json() as AgentSummary & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось сохранить память.')
      setAgent(data)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось сохранить память.') } finally { setIsLoading(false) }
  }

  async function addNote() {
    const text = note.trim()
    if (!text) return
    const entry: ManualMemoryEntry = { id: `note-${crypto.randomUUID()}`, text, createdAt: new Date().toISOString() }
    await saveMemory({ ...memory, [noteLayer]: [...(memory[noteLayer] ?? []), entry] })
    setNote('')
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    const message = input.trim()
    if (!message) return
    setIsLoading(true); setError(null)
    try {
      const response = await fetch(`/api/agents/${memoryLabAgent.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: message }) })
      const data = await response.json() as MemoryRunResult & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось получить ответ агента.')
      setLastMetrics(data.tokenMetrics)
      setInput('')
      await load()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось получить ответ агента.') } finally { setIsLoading(false) }
  }

  async function clearShortTerm() {
    setIsLoading(true); setError(null)
    try {
      const response = await fetch(`/api/agents/${memoryLabAgent.id}/history`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Не удалось очистить текущий диалог.')
      setHistory([])
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось очистить текущий диалог.') } finally { setIsLoading(false) }
  }

  const removeNote = (layer: 'working' | 'longTerm', id: string) => void saveMemory({ ...memory, [layer]: (memory[layer] ?? []).filter((entry) => entry.id !== id) })

  return <div className="page-view memory-page">
    <header className="page-header"><div><p className="eyebrow">День 11 · Memory layers</p><h1>Память под контролем пользователя</h1><p className="header-description">Вы сами сохраняете заметки рабочей задачи и долгосрочные факты. Агент ничего не классифицирует и не записывает за вас.</p></div><div className="model-badge"><span className="pulse-dot" /> DeepSeek</div></header>
    {error && <div className="error-message" role="alert">{error}</div>}
    <section className="memory-controls"><div><strong>Режим: {memory.mode ?? 'manual'}</strong><label><input type="checkbox" checked={memory.enabled !== false} onChange={(event) => void saveMemory({ ...memory, enabled: event.target.checked })} disabled={isLoading} /> память агента</label><label><input type="checkbox" checked={memory.useWorking !== false} onChange={(event) => void saveMemory({ ...memory, useWorking: event.target.checked })} disabled={isLoading} /> рабочую</label><label><input type="checkbox" checked={memory.useLongTerm !== false} onChange={(event) => void saveMemory({ ...memory, useLongTerm: event.target.checked })} disabled={isLoading} /> долгосрочную</label></div><label>Лимит short-term<input type="number" min="2" max="100" value={memory.shortTermLimit ?? 12} disabled={isLoading} onChange={(event) => void saveMemory({ ...memory, shortTermLimit: Number(event.target.value) })} /></label></section>
    <section className="memory-workbench">
      <div className="memory-dialog"><div className="section-heading"><div><span className="step-number">01</span><div><p className="eyebrow">Short-term · {shortTerm.length}/{memory.shortTermLimit ?? 12}</p><h2>Текущий диалог</h2></div></div><button className="clear-context-button" type="button" disabled={isLoading} onClick={() => void clearShortTerm()}>Новый диалог</button></div><div className="memory-chat-history">{shortTerm.length ? shortTerm.map((message, index) => <div className={message.role} key={`${message.role}-${index}`}><small>{message.role === 'user' ? 'Вы' : 'Агент'}</small><MarkdownContent content={message.content} /></div>) : <p className="strategy-empty">Завершённых ходов пока нет.</p>}</div><form className="strategy-composer" onSubmit={send}><textarea rows={3} value={input} onChange={(event) => setInput(event.target.value)} disabled={isLoading} placeholder="Задайте вопрос агенту…" /><button className="compare-button" type="submit" disabled={isLoading || !input.trim()}>{isLoading ? 'Отправляем…' : 'Отправить'} <span>→</span></button></form>{lastMetrics && <div className="memory-run-metrics"><span>Prompt: <strong>{lastMetrics.promptTokens}</strong></span><span>Ответ: <strong>{lastMetrics.completionTokens}</strong></span><span>Всего: <strong>{lastMetrics.totalTokens}</strong></span></div>}</div>
      <aside className="memory-notebook"><div className="section-heading"><div><span className="step-number">02</span><div><p className="eyebrow">Memory notebook</p><h2>Добавить заметку</h2></div></div></div><div className="memory-note-form"><select value={noteLayer} onChange={(event) => setNoteLayer(event.target.value as 'working' | 'longTerm')} disabled={isLoading}><option value="working">В рабочую память</option><option value="longTerm">В долгосрочную память</option></select><textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} disabled={isLoading} placeholder="Например: Решили не использовать платные сервисы." /><button className="compare-button" type="button" disabled={isLoading || !note.trim()} onClick={() => void addNote()}>Сохранить заметку</button></div><MemoryNotebookLayer title="Working memory" subtitle="Только данные незавершённой задачи" entries={memory.working ?? []} onRemove={(id) => removeNote('working', id)} onClear={() => void saveMemory({ ...memory, working: [] })} disabled={isLoading} /><MemoryNotebookLayer title="Long-term memory" subtitle="Профиль, решения и знания между диалогами" entries={memory.longTerm ?? []} onRemove={(id) => removeNote('longTerm', id)} onClear={() => void saveMemory({ ...memory, longTerm: [] })} disabled={isLoading} /></aside>
    </section>
  </div>
}

function MemoryNotebookLayer({ title, subtitle, entries, onRemove, onClear, disabled }: { title: string; subtitle: string; entries: ManualMemoryEntry[]; onRemove: (id: string) => void; onClear: () => void; disabled: boolean }) {
  return <section className="memory-note-layer"><header><div><p className="eyebrow">{title}</p><h3>{subtitle}</h3></div><button type="button" onClick={onClear} disabled={disabled || !entries.length}>Очистить</button></header>{entries.length ? <div>{entries.map((entry) => <article key={entry.id}><p>{entry.text}</p><div><small>{new Date(entry.createdAt).toLocaleString()}</small><button type="button" onClick={() => onRemove(entry.id)} disabled={disabled}>Удалить</button></div></article>)}</div> : <p className="strategy-empty">Пусто — добавьте запись вручную.</p>}</section>
}

function PersonalizationPage() {
  const [agent, setAgent] = useState<AgentSummary | null>(null)
  const [history, setHistory] = useState<AgentHistoryResult['messages']>([])
  const [draft, setDraft] = useState<UserProfile | null>(null)
  const [message, setMessage] = useState('')
  const [workingNote, setWorkingNote] = useState('')
  const [globalFact, setGlobalFact] = useState('')
  const [comparisonInput, setComparisonInput] = useState('')
  const [previews, setPreviews] = useState<ProfilePreview[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isComparing, setIsComparing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  const personalization = agent?.config.personalization ?? { activeProfileId: defaultProfiles[0].id, profiles: defaultProfiles, globalLongTerm: [] }
  const profiles = personalization.profiles?.length ? personalization.profiles : defaultProfiles
  const activeProfile = profiles.find((profile) => profile.id === personalization.activeProfileId) ?? profiles[0]
  const memory = agent?.config.memoryLayers ?? { mode: 'manual' as const, enabled: true, shortTermLimit: 12, useWorking: true, useLongTerm: false, working: [], longTerm: [] }
  const shortTerm = history.slice(-Math.max(2, memory.shortTermLimit ?? 12))
  if (shortTerm[0]?.role === 'assistant') shortTerm.shift()

  useEffect(() => { setDraft(activeProfile ? { ...activeProfile } : null) }, [activeProfile?.id, activeProfile?.name, activeProfile?.style, activeProfile?.format, activeProfile?.restrictions])

  async function ensureAgent() {
    const existing = await fetch(`/api/agents/${personalizationLabAgent.id}`)
    if (existing.ok) return await existing.json() as AgentSummary
    if (existing.status !== 404) throw new Error('Не удалось проверить персонализированного агента.')
    const response = await fetch('/api/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: personalizationLabAgent.id, config: {
        name: personalizationLabAgent.name, provider: 'deepseek', model: 'deepseek-v4-flash', temperature: 0,
        systemPrompt: personalizationLabSystemPrompt,
        memoryLayers: { mode: 'manual', enabled: true, shortTermLimit: 12, useWorking: true, useLongTerm: false, working: [], longTerm: [] },
        personalization: { activeProfileId: defaultProfiles[0].id, profiles: defaultProfiles, globalLongTerm: [] },
      } }),
    })
    const data = await response.json() as AgentSummary & ApiError
    if (!response.ok) throw new Error(data.error || 'Не удалось создать персонализированного агента.')
    return data
  }

  async function load() {
    setIsLoading(true)
    try {
      const current = await ensureAgent()
      const response = await fetch(`/api/agents/${personalizationLabAgent.id}/history`)
      const data = await response.json() as AgentHistoryResult & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось загрузить текущий диалог.')
      setAgent(current); setHistory(data.messages); setError(null)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить профили.') } finally { setIsLoading(false) }
  }

  async function saveConfig(config: AgentConfig) {
    if (!agent) return
    setIsLoading(true); setError(null)
    try {
      const response = await fetch(`/api/agents/${agent.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }) })
      const data = await response.json() as AgentSummary & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось сохранить настройки.')
      setAgent(data)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось сохранить настройки.') } finally { setIsLoading(false) }
  }

  async function switchProfile(profileId: string) {
    if (!agent || profileId === activeProfile?.id) return
    await saveConfig({ ...agent.config, memoryLayers: { ...memory, working: [] }, personalization: { ...personalization, activeProfileId: profileId, profiles } })
    try {
      await fetch(`/api/agents/${agent.id}/history`, { method: 'DELETE' })
      setHistory([]); setPreviews([])
    } catch { setError('Профиль переключён, но не удалось очистить историю сессии.') }
  }

  async function saveProfile() {
    if (!agent || !draft?.name.trim()) return
    await saveConfig({ ...agent.config, personalization: { ...personalization, profiles: profiles.map((profile) => profile.id === draft.id ? { ...draft, name: draft.name.trim() } : profile), activeProfileId: draft.id } })
  }

  async function createProfile() {
    if (!agent) return
    const profile = { id: `profile-${crypto.randomUUID()}`, name: 'Новый профиль', style: 'Нейтрально и по существу.', format: 'Краткий ответ с практическими шагами.', restrictions: '' }
    setDraft(profile)
    await saveConfig({ ...agent.config, memoryLayers: { ...memory, working: [] }, personalization: { ...personalization, activeProfileId: profile.id, profiles: [...profiles, profile] } })
    await fetch(`/api/agents/${agent.id}/history`, { method: 'DELETE' })
    setHistory([]); setPreviews([])
  }

  async function deleteProfile() {
    if (!agent || !activeProfile || profiles.length < 2) return
    const nextProfiles = profiles.filter((profile) => profile.id !== activeProfile.id)
    await saveConfig({ ...agent.config, memoryLayers: { ...memory, working: [] }, personalization: { ...personalization, activeProfileId: nextProfiles[0].id, profiles: nextProfiles } })
    await fetch(`/api/agents/${agent.id}/history`, { method: 'DELETE' })
    setHistory([]); setPreviews([])
  }

  async function addNote(scope: 'working' | 'global') {
    if (!agent) return
    const text = (scope === 'working' ? workingNote : globalFact).trim()
    if (!text) return
    const entry = { id: `${scope}-${crypto.randomUUID()}`, text, createdAt: new Date().toISOString() }
    const config = scope === 'working'
      ? { ...agent.config, memoryLayers: { ...memory, working: [...(memory.working ?? []), entry] } }
      : { ...agent.config, personalization: { ...personalization, profiles, globalLongTerm: [...(personalization.globalLongTerm ?? []), entry] } }
    await saveConfig(config)
    if (scope === 'working') setWorkingNote(''); else setGlobalFact('')
  }

  async function removeNote(scope: 'working' | 'global', id: string) {
    if (!agent) return
    const config = scope === 'working'
      ? { ...agent.config, memoryLayers: { ...memory, working: (memory.working ?? []).filter((entry) => entry.id !== id) } }
      : { ...agent.config, personalization: { ...personalization, profiles, globalLongTerm: (personalization.globalLongTerm ?? []).filter((entry) => entry.id !== id) } }
    await saveConfig(config)
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    const input = message.trim()
    if (!input) return
    setIsLoading(true); setError(null)
    try {
      const response = await fetch(`/api/agents/${personalizationLabAgent.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) })
      const data = await response.json() as MemoryRunResult & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось получить ответ агента.')
      setMessage('')
      const historyResponse = await fetch(`/api/agents/${personalizationLabAgent.id}/history`)
      const historyData = await historyResponse.json() as AgentHistoryResult
      setHistory(historyData.messages)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось получить ответ агента.') } finally { setIsLoading(false) }
  }

  async function compareProfiles() {
    const input = comparisonInput.trim()
    if (!input) return
    setIsComparing(true); setError(null); setPreviews([])
    const results = await Promise.all(profiles.map(async (profile) => {
      try {
        const response = await fetch(`/api/agents/${personalizationLabAgent.id}/profile-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, profileId: profile.id }) })
        const data = await response.json() as MemoryRunResult & ApiError
        return response.ok ? { profileId: profile.id, content: data.output, tokens: data.tokenMetrics?.totalTokens } : { profileId: profile.id, error: data.error || 'Не удалось выполнить проверку.' }
      } catch { return { profileId: profile.id, error: 'Сеть недоступна.' } }
    }))
    setPreviews(results); setIsComparing(false)
  }

  return <div className="page-view personalization-page">
    <header className="page-header"><div><p className="eyebrow">День 12 · Personalization</p><h1>Ассистент, который знает пользователя</h1><p className="header-description">Профиль меняет стиль, формат и ограничения каждого ответа. Рабочая память относится к текущей сессии, а глобальные факты сохраняются для всех профилей и диалогов.</p></div><div className="model-badge"><span className="pulse-dot" /> DeepSeek</div></header>
    {error && <div className="error-message" role="alert">{error}</div>}
    <section className="profile-switcher"><div><p className="eyebrow">Активный профиль</p><select value={activeProfile?.id ?? ''} onChange={(event) => void switchProfile(event.target.value)} disabled={isLoading}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select><small>При переключении начинается чистая сессия: short-term и working memory очищаются, глобальные факты остаются.</small></div><div className="profile-switcher-actions"><button type="button" className="secondary-button" onClick={() => void createProfile()} disabled={isLoading}>+ Создать профиль</button><button type="button" className="text-button danger" onClick={() => void deleteProfile()} disabled={isLoading || profiles.length < 2}>Удалить</button></div></section>
    <section className="personalization-grid">
      <div className="profile-editor"><div className="section-heading"><div><span className="step-number">01</span><div><p className="eyebrow">Настройки профиля</p><h2>Как отвечать этому пользователю</h2></div></div></div>{draft && <div className="profile-fields"><label>Имя профиля<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} disabled={isLoading} /></label><label>Стиль общения<textarea rows={3} value={draft.style ?? ''} onChange={(event) => setDraft({ ...draft, style: event.target.value })} disabled={isLoading} placeholder="Например: спокойно, без жаргона" /></label><label>Формат ответа<textarea rows={3} value={draft.format ?? ''} onChange={(event) => setDraft({ ...draft, format: event.target.value })} disabled={isLoading} placeholder="Например: вывод, три шага, короткий пример" /></label><label>Ограничения<textarea rows={3} value={draft.restrictions ?? ''} onChange={(event) => setDraft({ ...draft, restrictions: event.target.value })} disabled={isLoading} placeholder="Например: не советовать платные сервисы" /></label><button type="button" className="compare-button" onClick={() => void saveProfile()} disabled={isLoading || !draft.name.trim()}>Сохранить профиль</button></div>}</div>
      <div className="memory-scopes"><div className="section-heading"><div><span className="step-number">02</span><div><p className="eyebrow">Memory scopes</p><h2>Память с разной областью действия</h2></div></div></div><MemoryScope title="Working memory" subtitle="Текущая задача и только эта сессия" entries={memory.working ?? []} value={workingNote} onChange={setWorkingNote} onAdd={() => void addNote('working')} onRemove={(id) => void removeNote('working', id)} disabled={isLoading} /><MemoryScope title="Global long-term memory" subtitle="Факты для всех профилей и будущих диалогов" entries={personalization.globalLongTerm ?? []} value={globalFact} onChange={setGlobalFact} onAdd={() => void addNote('global')} onRemove={(id) => void removeNote('global', id)} disabled={isLoading} /></div>
    </section>
    <section className="personalized-chat"><div className="section-heading"><div><span className="step-number">03</span><div><p className="eyebrow">Short-term · {shortTerm.length}/{memory.shortTermLimit ?? 12}</p><h2>Диалог с профилем «{activeProfile?.name}»</h2></div></div></div><div className="profile-applied">В каждый запрос добавлены: <strong>{activeProfile?.name}</strong>, его стиль, формат и ограничения, а также {personalization.globalLongTerm?.length ?? 0} глобальных фактов.</div><div className="personalized-history">{shortTerm.length ? shortTerm.map((item, index) => <div className={item.role} key={`${item.role}-${index}`}><small>{item.role === 'user' ? 'Вы' : 'Агент'}</small><MarkdownContent content={item.content} /></div>) : <p className="strategy-empty">Новая сессия — история диалога пока пуста.</p>}</div><form className="strategy-composer" onSubmit={send}><textarea rows={3} value={message} onChange={(event) => setMessage(event.target.value)} disabled={isLoading} placeholder="Спросите ассистента…" /><button className="compare-button" type="submit" disabled={isLoading || !message.trim()}>{isLoading ? 'Отправляем…' : 'Отправить'} <span>→</span></button></form></section>
    <section className="profile-comparison"><div className="section-heading"><div><span className="step-number">04</span><div><p className="eyebrow">Проверка</p><h2>Один вопрос — разные профили</h2></div></div></div><p>Один и тот же вопрос отправляется всем профилям без записи в диалог и без изменения памяти — отличается только активный профиль.</p><div className="profile-test-prompts">{profileTestPrompts.map((prompt, index) => <button type="button" key={prompt} onClick={() => setComparisonInput(prompt)} disabled={isComparing}><span>Тест {index + 1}</span>{index === 0 ? 'Первые ходы' : 'Разбор match-up'}</button>)}</div><div className="comparison-form"><textarea rows={3} value={comparisonInput} onChange={(event) => setComparisonInput(event.target.value)} disabled={isComparing} /><button className="compare-button" type="button" onClick={() => void compareProfiles()} disabled={isComparing || !comparisonInput.trim()}>{isComparing ? 'Сравниваем…' : 'Проверить все профили'}</button></div>{previews.length > 0 && <div className="profile-preview-grid">{previews.map((preview) => <article key={preview.profileId}><header><strong>{profiles.find((profile) => profile.id === preview.profileId)?.name}</strong><small>{preview.tokens ? `${preview.tokens} токенов` : 'preview'}</small></header>{preview.error ? <p className="profile-preview-error">{preview.error}</p> : <div className="reasoning-content"><MarkdownContent content={preview.content ?? ''} /></div>}</article>)}</div>}</section>
  </div>
}

function MemoryScope({ title, subtitle, entries, value, onChange, onAdd, onRemove, disabled }: { title: string; subtitle: string; entries: ManualMemoryEntry[]; value: string; onChange: (value: string) => void; onAdd: () => void; onRemove: (id: string) => void; disabled: boolean }) {
  return <section className="memory-scope"><header><div><p className="eyebrow">{title}</p><h3>{subtitle}</h3></div><span>{entries.length}</span></header><div className="memory-scope-list">{entries.length ? entries.map((entry) => <article key={entry.id}><p>{entry.text}</p><button type="button" onClick={() => onRemove(entry.id)} disabled={disabled}>×</button></article>) : <p>Пока пусто.</p>}</div><div className="memory-scope-add"><textarea rows={2} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} /><button type="button" className="secondary-button" disabled={disabled || !value.trim()} onClick={onAdd}>Добавить</button></div></section>
}

function InvariantCheckBadge({ check }: { check: InvariantCheckInfo }) {
  const label = check.status === 'passed' ? 'Инварианты соблюдены' : check.status === 'repaired' ? `Ответ исправлен · ${check.attempts}` : 'Ответ заблокирован'
  return <div className={`invariant-check-badge ${check.status}`}><strong>{label}</strong>{check.violatedInvariantIds.length > 0 && <span>Правила: {check.violatedInvariantIds.join(', ')}</span>}{check.safeDirection && <span>{check.safeDirection}</span>}</div>
}

function TaskStatePage() {
  const [agent, setAgent] = useState<AgentSummary | null>(null)
  const [history, setHistory] = useState<AgentHistoryResult['messages']>([])
  const historyRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isPausing, setIsPausing] = useState(false)
  const [lastInvariantCheck, setLastInvariantCheck] = useState<InvariantCheckInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (!shouldAutoScrollRef.current) return
    historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight, behavior: 'smooth' })
  }, [history.length])

  const state = agent?.config.taskState

  async function ensureAgent() {
    const existing = await fetch(`/api/agents/${taskStateLabAgent.id}`)
    if (existing.ok) {
      const current = await existing.json() as AgentSummary
      const hasIosProfile = current.config.personalization?.activeProfileId === day13Profiles[0].id && current.config.personalization.profiles?.some((profile) => profile.id === day13Profiles[0].id)
      const hasAutomaticMemory = current.config.memoryLayers?.mode === 'auto'
      const hasInvariants = current.config.invariants?.enabled === true && current.config.invariants.items?.length === day14Invariants.length
      if (current.config.taskMachine && current.config.systemPrompt === taskStateLabSystemPrompt && current.config.name === taskStateLabAgent.name && hasIosProfile && hasAutomaticMemory && hasInvariants) return current
      const response = await fetch(`/api/agents/${taskStateLabAgent.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { ...current.config, name: taskStateLabAgent.name, systemPrompt: taskStateLabSystemPrompt, taskMachine: true, invariants: { enabled: true, items: day14Invariants }, memoryLayers: { ...day13Memory, working: current.config.memoryLayers?.working ?? [], longTerm: current.config.memoryLayers?.longTerm ?? [] }, personalization: { activeProfileId: day13Profiles[0].id, profiles: day13Profiles, globalLongTerm: current.config.personalization?.globalLongTerm ?? [] }, contextStrategy: current.config.contextStrategy ?? { strategy: 'summary', summarizeAfterMessages: 10 } } }) })
      const migrated = await response.json() as AgentSummary & ApiError
      if (!response.ok) throw new Error(migrated.error || 'Не удалось обновить учебного агента.')
      return migrated
    }
    if (existing.status !== 404) throw new Error('Не удалось проверить учебного агента задачи.')
    const response = await fetch('/api/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: taskStateLabAgent.id, config: {
        name: taskStateLabAgent.name, provider: 'deepseek', model: 'deepseek-v4-flash', temperature: 0,
        systemPrompt: taskStateLabSystemPrompt, taskMachine: true,
        memoryLayers: { ...day13Memory, working: [], longTerm: [] },
        personalization: { activeProfileId: day13Profiles[0].id, profiles: day13Profiles, globalLongTerm: [] },
        contextStrategy: { strategy: 'summary', summarizeAfterMessages: 10 }, invariants: { enabled: true, items: day14Invariants },
      } }),
    })
    const data = await response.json() as AgentSummary & ApiError
    if (!response.ok) throw new Error(data.error || 'Не удалось создать учебного агента.')
    return data
  }

  async function load() {
    setIsLoading(true)
    try {
      const current = await ensureAgent()
      const response = await fetch(`/api/agents/${taskStateLabAgent.id}/task-state/history`)
      const data = await response.json() as AgentHistoryResult & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось загрузить историю задачи.')
      setAgent(current); setHistory(data.messages); setError(null)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить задачу.') } finally { setIsLoading(false) }
  }

  async function togglePause() {
    if (!state || state.stage === 'done') return
    setIsPausing(true); setError(null)
    try {
      const response = await fetch(`/api/agents/${taskStateLabAgent.id}/task-state`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: state.status === 'paused' ? 'resume' : 'pause' }),
      })
      const data = await response.json() as AgentTaskState & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось обновить состояние задачи.')
      if (!agent) throw new Error('Агент не загружен.')
      setAgent({ ...agent, config: { ...agent.config, taskState: data } })
      if (state.status === 'paused' && data.expectedActor === 'agent') void continueExecution()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось обновить состояние задачи.') } finally { setIsPausing(false) }
  }

  async function continueExecution() {
    setIsLoading(true); setError(null)
    try {
      const response = await fetch(`/api/agents/${taskStateLabAgent.id}/task-run-events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'ВНУТРЕННЕЕ ПРОДОЛЖЕНИЕ: продолжи execution с сохранённого текущего шага.' }) })
      if (!response.ok || !response.body) throw new Error('Не удалось продолжить выполнение задачи.')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let streamError: string | undefined
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const taskEvent = JSON.parse(line) as TaskRunEvent
          if (taskEvent.type === 'message') {
            setHistory((current) => [...current, { role: 'assistant', content: taskEvent.content }])
            if (taskEvent.taskState) setAgent((current) => current ? { ...current, config: { ...current.config, taskState: taskEvent.taskState } } : current)
            if (taskEvent.invariantCheck) setLastInvariantCheck(taskEvent.invariantCheck)
          } else if (taskEvent.type === 'done') {
            if (taskEvent.taskState) setAgent((current) => current ? { ...current, config: { ...current.config, taskState: taskEvent.taskState } } : current)
            if (taskEvent.taskNotice) setError(taskEvent.taskNotice)
            if (taskEvent.invariantCheck) setLastInvariantCheck(taskEvent.invariantCheck)
          } else streamError = taskEvent.error
        }
        if (done) break
      }
      if (streamError) throw new Error(streamError)
      const historyResponse = await fetch(`/api/agents/${taskStateLabAgent.id}/task-state/history`)
      const historyData = await historyResponse.json() as AgentHistoryResult & ApiError
      if (!historyResponse.ok) throw new Error(historyData.error || 'Не удалось обновить историю.')
      setHistory(historyData.messages)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось продолжить выполнение задачи.') } finally { setIsLoading(false) }
  }

  async function resetTask(confirmMessage: string, errorMessage: string) {
    if (!state || !window.confirm(confirmMessage)) return
    setIsLoading(true); setError(null)
    try {
      const response = await fetch(`/api/agents/${taskStateLabAgent.id}/task-state`, { method: 'DELETE' })
      const data = await response.json() as { reset?: boolean } & ApiError
      if (!response.ok || !data.reset) throw new Error(data.error || errorMessage)
      setAgent((current) => current ? { ...current, config: { ...current.config, taskState: undefined } } : current)
      setHistory([]); setInput(''); setLastInvariantCheck(null)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : errorMessage) } finally { setIsLoading(false) }
  }

  async function cancelTask() {
    await resetTask('Отменить эту задачу? Её история и рабочая память будут очищены. Профиль и долгосрочная память сохранятся.', 'Не удалось отменить задачу.')
  }

  async function startNewTask() {
    await resetTask('Начать новую задачу? История и рабочая память завершённой задачи будут очищены. Профиль и долгосрочная память сохранятся.', 'Не удалось начать новую задачу.')
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    const message = input.trim()
    if (!message || state?.status === 'paused' || state?.stage === 'done') return
    setIsLoading(true); setError(null)
    try {
      setInput('')
      setHistory((current) => [...current, { role: 'user', content: message }])
      const response = await fetch(`/api/agents/${taskStateLabAgent.id}/task-run-events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: message }) })
      if (!response.ok || !response.body) throw new Error('Не удалось запустить выполнение задачи.')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let streamError: string | undefined
      let taskWasCreated = false
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const taskEvent = JSON.parse(line) as TaskRunEvent
          if (taskEvent.type === 'message') {
            setHistory((current) => [...current, { role: 'assistant', content: taskEvent.content }])
            if (taskEvent.taskState) {
              taskWasCreated = true
              setAgent((current) => current ? { ...current, config: { ...current.config, taskState: taskEvent.taskState } } : current)
            }
            if (taskEvent.invariantCheck) setLastInvariantCheck(taskEvent.invariantCheck)
          } else if (taskEvent.type === 'done') {
            if (taskEvent.taskState) {
              taskWasCreated = true
              setAgent((current) => current ? { ...current, config: { ...current.config, taskState: taskEvent.taskState } } : current)
            }
            if (taskEvent.taskNotice) setError(taskEvent.taskNotice)
            if (taskEvent.invariantCheck) setLastInvariantCheck(taskEvent.invariantCheck)
          } else streamError = taskEvent.error
        }
        if (done) break
      }
      if (streamError) throw new Error(streamError)
      if (!taskWasCreated) return
      const historyResponse = await fetch(`/api/agents/${taskStateLabAgent.id}/task-state/history`)
      const historyData = await historyResponse.json() as AgentHistoryResult & ApiError
      if (!historyResponse.ok) throw new Error(historyData.error || 'Не удалось обновить историю.')
      setHistory(historyData.messages)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось получить ответ агента.') } finally { setIsLoading(false) }
  }

  const isPaused = state?.status === 'paused'
  const isDone = state?.stage === 'done'
  const expectedActor = state?.expectedActor ?? (state?.stage === 'execution' ? 'agent' : 'user')
  const invariants = agent?.config.invariants?.enabled ? agent.config.invariants.items ?? [] : []
  const invariantsPanel = <section className="task-invariants-overview"><div className="section-heading"><div><span className="step-number">02</span><div><p className="eyebrow">Hard constraints</p><h2>Инварианты агента</h2></div></div><span className="same-prompt">{invariants.length} активн.</span></div><p className="task-dialog-note">Они хранятся вне диалога, применяются на каждом этапе и не отменяются профилем или памятью.</p><div className="invariants-rules">{invariants.map((item) => <article key={item.id}><small>{item.id}</small><strong>{item.title}</strong><p>{item.rule}</p></article>)}</div>{lastInvariantCheck && <InvariantCheckBadge check={lastInvariantCheck} />}</section>
  if (!state) return <div className="page-view task-state-page"><header className="page-header"><div><p className="eyebrow">День 14 · Task state + invariants</p><h1>Задача в заданных границах</h1><p className="header-description">Агент планирует и выполняет задачу по этапам, одновременно соблюдая неизменяемые технические правила.</p></div><div className="task-status-badge"><span />Готов к задаче</div></header>{error && <div className="error-message" role="alert">{error}</div>}{invariantsPanel}<section className="task-dialog task-start-dialog"><div className="section-heading"><div><span className="step-number">03</span><div><p className="eyebrow">New task</p><h2>С чего начнём?</h2></div></div></div><p className="task-dialog-note">Профиль, глобальная память, рабочая память и summary-стратегия уже подключены. Первое сообщение станет целью новой задачи.</p>{history.length > 0 && <div className="task-history">{history.map((message, index) => <div className={message.role} key={`${message.role}-${index}`}><small>{message.role === 'user' ? 'Вы' : 'Агент'}</small><MarkdownContent content={message.content} /></div>)}</div>}<form className="strategy-composer" onSubmit={send}><textarea rows={4} value={input} onChange={(event) => setInput(event.target.value)} disabled={isLoading} placeholder="Например: спроектируй экран профиля на SwiftUI для iOS 16" /><button className="compare-button" type="submit" disabled={isLoading || !input.trim()}>{isLoading ? 'Создаём…' : 'Начать задачу'} <span>→</span></button></form></section></div>
  return <div className="page-view task-state-page">
    <header className="page-header"><div><p className="eyebrow">День 14 · Task state + invariants</p><h1>Задача в заданных границах</h1><p className="header-description">Агент получает этап, текущий шаг, ожидаемое действие и жёсткие инварианты в каждом запросе.</p></div><div className={`task-status-badge ${isPaused ? 'paused' : isDone ? 'done' : ''}`}><span />{isPaused ? 'На паузе' : isDone ? 'Завершена' : 'В работе'}</div></header>
    {error && <div className="error-message" role="alert">{error}</div>}
    {state && <><section className="task-stage-track" aria-label="Этапы задачи">{(['planning', 'execution', 'validation', 'done'] as TaskStage[]).map((stage, index) => <div className={`${stage === state.stage ? 'active' : ''} ${(['planning', 'execution', 'validation', 'done'] as TaskStage[]).indexOf(state.stage) > index ? 'complete' : ''}`} key={stage}><span>{index + 1}</span><strong>{taskStageLabels[stage].title}</strong><small>{taskStageLabels[stage].description}</small></div>)}</section>
    <section className="task-state-overview"><div className="section-heading"><div><span className="step-number">01</span><div><p className="eyebrow">Автоматическое состояние</p><h2>Над чем сейчас работает агент</h2></div></div></div><dl className="task-state-details"><div><dt>Задача</dt><dd>{state.task}</dd></div><div><dt>Текущий шаг</dt><dd>{state.currentStep}</dd></div><div><dt>Ожидаемое действие</dt><dd>{state.expectedAction}</dd></div></dl><div className="task-state-footer"><span>Этап: <strong>{taskStageLabels[state.stage].title}</strong></span><span>Ожидается: <strong>{expectedActor === 'agent' ? 'действие агента' : 'ваше действие'}</strong></span><span>Обновлено: {new Date(state.updatedAt).toLocaleTimeString()}</span><div className="task-state-buttons">{!isDone && <button type="button" className="pause-button" onClick={() => void togglePause()} disabled={isPausing}>{isPaused ? 'Продолжить задачу' : 'Поставить на паузу'}</button>}<button type="button" className={isDone ? 'new-task-button' : 'cancel-task-button'} onClick={() => void (isDone ? startNewTask() : cancelTask())} disabled={isLoading}>{isDone ? 'Новая задача' : 'Отменить задачу'}</button></div></div><p className="task-transition-note">{isPaused ? 'Задача на паузе: сообщения временно не отправляются. Продолжите её, когда будете готовы.' : isDone ? 'Задача завершена. Создайте новую задачу, когда будете готовы.' : expectedActor === 'agent' ? 'Агент выполняет этап самостоятельно и сам передаст готовый результат на проверку.' : state.stage === 'planning' ? 'Утвердите план или укажите правки — после этого агент начнёт выполнение.' : 'Проверьте результат: подтвердите его или укажите, что требуется доработать.'}</p></section>
    {invariantsPanel}
    <section className="task-dialog"><div className="section-heading"><div><span className="step-number">03</span><div><p className="eyebrow">Continuation · {history.length} сообщений</p><h2>Диалог без повторных объяснений</h2></div></div></div><p className="task-dialog-note">Состояние и история сохраняются при паузе. После продолжения агент получает их снова и продолжает с текущего шага.</p><div className="task-history" ref={historyRef} onScroll={(event) => { const element = event.currentTarget; shouldAutoScrollRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24 }}>{history.length ? history.map((message, index) => <div className={message.role} key={`${message.role}-${index}`}><small>{message.role === 'user' ? 'Вы' : 'Агент'}</small><MarkdownContent content={message.content} /></div>) : <p className="strategy-empty">Начните диалог — агент увидит состояние задачи автоматически.</p>}</div><form className="strategy-composer" onSubmit={send}><textarea rows={3} value={input} onChange={(event) => setInput(event.target.value)} disabled={isLoading || isPaused || isDone} placeholder={isPaused ? 'Продолжите задачу, чтобы написать сообщение.' : isDone ? 'Создайте новую задачу для нового диалога.' : 'Опишите действие или попросите помочь с текущим шагом…'} /><button className="compare-button" type="submit" disabled={isLoading || isPaused || isDone || !input.trim()}>{isLoading ? 'Агент выполняет…' : 'Отправить'} <span>→</span></button></form><div className={`task-composer-state ${expectedActor === 'agent' ? 'agent-turn' : ''}`}><span>Текущий этап</span><strong>{taskStageLabels[state.stage].title}</strong><span>{expectedActor === 'agent' ? 'Агент выполняет следующий шаг' : isDone ? 'Задача завершена' : 'Ожидается ваше действие'}</span></div></section></>}
  </div>
}

function ContextCompressionComparisonPage() {
  const [preparation, setPreparation] = useState<ContextComparisonPreparation | null>(null)
  const [input, setInput] = useState('')
  const [result, setResult] = useState<ContextCompressionComparisonResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadPreparation()
  }, [])

  async function loadPreparation() {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/context-comparison')
      const data = (await response.json()) as ContextComparisonPreparation & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось подготовить сравнение.')
      setPreparation(data)
      setInput(data.input)
      setResult(null)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось подготовить сравнение.')
    } finally {
      setIsLoading(false)
    }
  }

  async function compare(event: FormEvent) {
    event.preventDefault()
    if (!input.trim() || isLoading) return
    setIsLoading(true)
    setError(null)
    setResult(null)
    try {
      const response = await fetch('/api/context-comparison', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: input.trim() }),
      })
      const data = (await response.json()) as ContextCompressionComparisonResult & ApiError
      if (!response.ok || !data.result) throw new Error(data.error || 'Не удалось сравнить ответы.')
      setResult(data)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось сравнить ответы.')
    } finally {
      setIsLoading(false)
    }
  }

  const withoutTokens = result?.result.withoutCompression.totalTokensWithSummary ?? 0
  const withTokens = result?.result.withCompression.totalTokensWithSummary ?? 0
  const withMainTokens = result?.result.withCompression.tokenMetrics.totalTokens ?? 0
  const summaryTokens = result?.result.withCompression.summaryTokens ?? 0
  const difference = withoutTokens - withTokens
  const percentage = withoutTokens ? Math.round((difference / withoutTokens) * 100) : 0

  return <div className="page-view compression-comparison-page">
    <header className="page-header"><div><p className="eyebrow">День 9 · эксперимент</p><h1>Сжатие контекста: два ответа</h1><p className="header-description">Один и тот же подготовленный диалог и один вопрос отправляются в DeepSeek с полной историей и с summary.</p></div><div className="model-badge"><span className="pulse-dot" /> DeepSeek</div></header>
    {error && <div className="error-message" role="alert">{error}</div>}
    <section className="compression-comparison-chat" aria-label="Подготовленная история чата"><div className="compression-prepared-history">{preparation?.history.map((message, index) => <div key={`${message.role}-${index}`} className={message.role}><small>{message.role === 'user' ? 'Вы' : 'Агент'}</small><span>{message.content}</span></div>)}</div></section>
    <form className="compression-comparison-form" onSubmit={compare}><label>Финальный вопрос для обоих режимов<textarea value={input} onChange={(event) => setInput(event.target.value)} rows={3} disabled={isLoading} /></label><div><button className="compare-button" type="submit" disabled={isLoading || !input.trim()}>{isLoading ? 'DeepSeek формирует два ответа...' : 'Отправить и сравнить'} <span>→</span></button><button className="clear-context-button" type="button" onClick={() => void loadPreparation()} disabled={isLoading}>Сбросить до 10 сообщений</button></div></form>
    {result && <><section className="compression-result-grid"><CompressionComparisonCard title="Без сжатия" tone="full" side={result.result.withoutCompression} /><CompressionComparisonCard title="Со сжатием" tone="compressed" side={result.result.withCompression} /></section><div className="compression-comparison-total"><span>Без сжатия: <strong>{withoutTokens}</strong> ток.</span><span>Основной запрос с summary: <strong>{withMainTokens}</strong> ток.</span><span>Создание summary: <strong>{summaryTokens}</strong> ток.</span><span className={difference >= 0 ? 'saved' : 'increased'}>{difference >= 0 ? `Экономия с учётом обоих вызовов: ${difference} ток. (${percentage}%)` : `Разница с учётом обоих вызовов: +${Math.abs(difference)} ток. (${Math.abs(percentage)}%)`}</span></div><p className="compression-comparison-caption">Показатели «Основной запрос с summary» и «Создание summary» — отдельные точные <code>total_tokens</code> двух API-вызовов. Разница рассчитывается по их сумме.</p></>}
  </div>
}

function CompressionComparisonCard({ title, tone, side }: { title: string; tone: 'full' | 'compressed'; side: ContextCompressionComparisonSide }) {
  return <article className={`compression-result-card ${tone}`}><header><div><span className="compression-result-dot" /><strong>{title}</strong></div><div className="compression-result-totals">{tone === 'compressed' ? <><span>Основной: {side.tokenMetrics.totalTokens} ток.</span><span>Summary: {side.summaryTokens ?? 0} ток.</span></> : <span>Итого: {side.totalTokensWithSummary} ток.</span>}</div></header><div className="compression-result-answer"><MarkdownContent content={side.output} /></div><footer><span>Промпт: {side.tokenMetrics.promptTokens}</span><span>Ответ: {side.tokenMetrics.completionTokens}</span>{tone === 'compressed' && <span>В summary: {side.summarizedMessages ?? 0} сообщ.</span>}</footer>{tone === 'compressed' && side.summary && <details className="compression-result-summary"><summary>Показать summary</summary><MarkdownContent content={side.summary} /></details>}</article>
}

function day10AgentConfig(name: string, strategy: ContextStrategyName): AgentConfig {
  return { name, provider: 'deepseek', model: 'deepseek-v4-flash', temperature: 0, systemPrompt: day10SystemPrompt, contextStrategy: { strategy, ...(strategy === 'branching' ? {} : { windowSize: 10 }) } }
}

async function ensureDay10Agent(definition: { id: string; name: string }, strategy: ContextStrategyName) {
  const config = day10AgentConfig(definition.name, strategy)
  const found = await fetch(`/api/agents/${definition.id}`)
  if (found.ok) return
  if (found.status !== 404) {
    const data = await found.json() as ApiError
    throw new Error(data.error || 'Не удалось проверить агента.')
  }
  const response = await fetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: definition.id, config }) })
  const data = await response.json() as AgentSummary & ApiError
  if (!response.ok) throw new Error(data.error || 'Не удалось подготовить агента.')
}

function asStrategyMessages(messages: AgentStrategyHistory['messages']): ContextStrategyMessage[] {
  return messages.filter((message) => message.role !== 'system').map((message, index) => ({ id: `${message.role}-${index}-${message.content.slice(0, 12)}`, role: message.role as 'user' | 'assistant', content: message.content, createdAt: '' }))
}

function restoreComparisonTurns(histories: Record<ContextStrategyName, AgentStrategyHistory>): ContextStrategyTurn[] {
  const pairsByStrategy = Object.fromEntries((Object.keys(contextStrategyAgents) as ContextStrategyName[]).map((name) => {
    const messages = asStrategyMessages(histories[name].messages)
    const pairs = Array.from({ length: Math.floor(messages.length / 2) }, (_, index) => ({
      input: messages[index * 2],
      output: messages[index * 2 + 1],
      usage: histories[name].tokenHistory?.[index],
    })).filter((pair) => pair.input?.role === 'user' && pair.output?.role === 'assistant')
    return [name, pairs]
  })) as Record<ContextStrategyName, Array<{ input: ContextStrategyMessage; output: ContextStrategyMessage; usage?: AgentTokenUsagePoint }>>
  const restored: ContextStrategyTurn[] = []
  const cursors: Record<ContextStrategyName, number> = { sliding: 0, facts: 0, branching: 0 }

  while (cursors.sliding < pairsByStrategy.sliding.length) {
    const candidate = pairsByStrategy.sliding[cursors.sliding]
    const positions = {
      facts: pairsByStrategy.facts.findIndex((pair, index) => index >= cursors.facts && pair.input.content === candidate.input.content),
      branching: pairsByStrategy.branching.findIndex((pair, index) => index >= cursors.branching && pair.input.content === candidate.input.content),
    }
    if (positions.facts === -1 || positions.branching === -1) {
      cursors.sliding += 1
      continue
    }
    const pairs = {
      sliding: candidate,
      facts: pairsByStrategy.facts[positions.facts],
      branching: pairsByStrategy.branching[positions.branching],
    }
    const input = candidate.input

    const results = Object.fromEntries((Object.keys(contextStrategyAgents) as ContextStrategyName[]).map((name) => {
      const usage = pairs[name].usage
      const tokenMetrics: AgentTokenMetrics = usage
        ? { inputTokens: usage.inputTokens, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens }
        : { inputTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      const legacyStrategyMetrics = usage?.strategyTokens === undefined
        ? undefined
        : { inputTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: usage.strategyTokens }
      return [name, {
        output: pairs[name].output.content,
        tokenMetrics,
        ...(name === 'facts' && (usage?.strategyTokenMetrics || legacyStrategyMetrics) ? { factsUpdate: usage?.strategyTokenMetrics ?? legacyStrategyMetrics } : {}),
      }]
    })) as Partial<Record<ContextStrategyName, ContextStrategyResult>>
    restored.push({ id: `restored-${restored.length}`, input: input.content, createdAt: '', results })
    cursors.sliding += 1
    cursors.facts = positions.facts + 1
    cursors.branching = positions.branching + 1
  }
  return restored
}

function strategyStats(turns: ContextStrategyTurn[], name: ContextStrategyName): ContextStrategyStats {
  const results = turns.map((turn) => turn.results[name]).filter((result): result is ContextStrategyResult => Boolean(result))
  const sum = (items: AgentTokenMetrics[]) => items.reduce<ContextStrategyUsage>((total, item) => ({ promptTokens: total.promptTokens + item.promptTokens, completionTokens: total.completionTokens + item.completionTokens, totalTokens: total.totalTokens + item.totalTokens }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 })
  const answers = sum(results.map((result) => result.tokenMetrics))
  const facts = sum(results.flatMap((result) => result.factsUpdate ? [result.factsUpdate] : []))
  const overall = {
    promptTokens: answers.promptTokens + facts.promptTokens,
    completionTokens: answers.completionTokens + facts.completionTokens,
    totalTokens: answers.totalTokens + facts.totalTokens,
  }
  return { answers, facts, overall, latest: results[results.length - 1]?.tokenMetrics }
}

function ContextStrategiesPage() {
  const [contexts, setContexts] = useState<Partial<Record<ContextStrategyName, AgentStrategyContext>>>({})
  const [histories, setHistories] = useState<Partial<Record<ContextStrategyName, ContextStrategyMessage[]>>>({})
  const [turns, setTurns] = useState<ContextStrategyTurn[]>([])
  const [input, setInput] = useState('')
  const [inspector, setInspector] = useState<'sliding' | 'facts' | null>(null)
  const [isPromptPickerOpen, setIsPromptPickerOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  async function load() {
    setIsLoading(true)
    try {
      await Promise.all((Object.keys(contextStrategyAgents) as ContextStrategyName[]).map((name) => ensureDay10Agent(contextStrategyAgents[name], name)))
      const entries = await Promise.all((Object.keys(contextStrategyAgents) as ContextStrategyName[]).map(async (name) => {
        const id = contextStrategyAgents[name].id
        const [contextResponse, historyResponse] = await Promise.all([fetch(`/api/agents/${id}/context`), fetch(`/api/agents/${id}/history`)])
        const context = await contextResponse.json() as AgentStrategyContext & ApiError
        const history = await historyResponse.json() as AgentStrategyHistory & ApiError
        if (!contextResponse.ok || !historyResponse.ok) throw new Error(context.error || history.error || 'Не удалось загрузить состояние агента.')
        return [name, context, asStrategyMessages(history.messages), history] as const
      }))
      setContexts(Object.fromEntries(entries.map(([name, context]) => [name, context])))
      setHistories(Object.fromEntries(entries.map(([name, , history]) => [name, history])))
      setTurns(restoreComparisonTurns(Object.fromEntries(entries.map(([name, , , history]) => [name, history])) as Record<ContextStrategyName, AgentStrategyHistory>))
      setError(null)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить стратегии.') } finally { setIsLoading(false) }
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    const prompt = input.trim()
    if (!prompt || isLoading) return
    setIsLoading(true); setError(null)
    try {
      const entries = await Promise.all((Object.keys(contextStrategyAgents) as ContextStrategyName[]).map(async (name) => {
        const response = await fetch(`/api/agents/${contextStrategyAgents[name].id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: prompt }) })
        const data = await response.json() as AgentStrategyRunResult & ApiError
        if (!response.ok) throw new Error(data.error || `Не удалось получить ответ ${name}.`)
        return [name, { output: data.output, tokenMetrics: data.tokenMetrics, factsUpdate: data.strategyTokenMetrics, factsError: data.strategyError }] as const
      }))
      setTurns((current) => [...current, { id: crypto.randomUUID(), input: prompt, createdAt: new Date().toISOString(), results: Object.fromEntries(entries) }])
      setInput('')
      await load()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось выполнить сравнение.') } finally { setIsLoading(false) }
  }

  async function reset() {
    if (isLoading || !window.confirm('Очистить историю всех трёх агентов? Это действие нельзя отменить.')) return
    setIsLoading(true); setError(null)
    try {
      await Promise.all((Object.keys(contextStrategyAgents) as ContextStrategyName[]).flatMap((name) => {
        const id = contextStrategyAgents[name].id
        return [fetch(`/api/agents/${id}/history`, { method: 'DELETE' }), fetch(`/api/agents/${id}/context/reset`, { method: 'POST' })]
      }))
      setTurns([])
      await load()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось очистить историю.') } finally { setIsLoading(false) }
  }

  async function updateWindow(name: 'sliding' | 'facts', value: number) {
    if (!Number.isInteger(value) || value < 1 || isLoading) return
    setIsLoading(true); setError(null)
    try {
      const response = await fetch(`/api/agents/${contextStrategyAgents[name].id}/context/window`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windowSize: value }) })
      const context = await response.json() as AgentStrategyContext & ApiError
      if (!response.ok) throw new Error(context.error || 'Не удалось изменить окно.')
      setContexts((current) => ({ ...current, [name]: context }))
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось изменить окно.') } finally { setIsLoading(false) }
  }

  const factSnapshots = contexts.facts?.factsSnapshots ?? []
  const latestFacts = factSnapshots[factSnapshots.length - 1]
  const windows = { sliding: contexts.sliding?.windowSize ?? 10, facts: contexts.facts?.windowSize ?? 10 }
  return <div className="page-view context-strategies-page">
    <header className="page-header"><div><p className="eyebrow">День 10 · сравнение</p><h1>Один вопрос — три контекста</h1><p className="header-description">Каждое сообщение уходит в три обычных агента с независимой настройкой контекста. Для Branching здесь показана корневая линия; ветки доступны на отдельной странице.</p></div><button className="clear-context-button" type="button" onClick={() => void reset()} disabled={isLoading}>Очистить историю</button></header>
    {error && <div className="error-message" role="alert">{error}</div>}
    <section className="strategy-overview-grid">
      <StrategyOverviewCard title="Sliding Window" badge="Стратегия 1" description="В запрос попадают последние N сообщений и новый вопрос." stats={strategyStats(turns, 'sliding')} windowSize={windows.sliding} isLoading={isLoading} onWindowSizeChange={(value) => void updateWindow('sliding', value)} actionLabel="Показать окно" onAction={() => setInspector('sliding')} />
      <StrategyOverviewCard title="Sticky Facts" badge="Стратегия 2" description="Facts обновляются отдельным вызовом, затем в модель идут facts + последние N сообщений." stats={strategyStats(turns, 'facts')} factsTokens={strategyStats(turns, 'facts').facts.totalTokens} windowSize={windows.facts} isLoading={isLoading} onWindowSizeChange={(value) => void updateWindow('facts', value)} actionLabel="Показать facts" onAction={() => setInspector('facts')} />
      <StrategyOverviewCard title="Branching" badge="Стратегия 3" description="В сравнении используется только корневая линия. Ветки демонстрируются на отдельной странице." stats={strategyStats(turns, 'branching')} />
    </section>
    <section className="strategy-turns"><div className="context-demo-chart-heading"><div><p className="eyebrow">Ответы</p><h2>Одинаковая реплика в трёх стратегиях</h2></div><span>{turns.length} ходов</span></div>{turns.length ? turns.map((turn) => <article className="strategy-turn" key={turn.id}><p className="strategy-turn-input">{turn.input}</p><div className="strategy-turn-results">{(['sliding', 'facts', 'branching'] as ContextStrategyName[]).map((name) => <StrategyResultCard key={name} name={name} result={turn.results[name]} />)}</div></article>) : <p className="strategy-empty">Выберите первый вопрос сценария и отправьте его: появятся три независимых ответа.</p>}</section>
    <form className="strategy-composer" onSubmit={send}><textarea value={input} onChange={(event) => setInput(event.target.value)} disabled={isLoading} rows={4} placeholder="Вставьте следующий вопрос сценария…" /><div><span className="strategy-send-note">Будет отправлено в три стратегии</span><button className="clear-context-button" type="button" onClick={() => setIsPromptPickerOpen(true)} disabled={isLoading}>Выбрать сообщение</button><button className="compare-button" type="submit" disabled={isLoading || !input.trim()}>{isLoading ? 'DeepSeek отвечает…' : 'Сравнить ответы'} <span>→</span></button></div></form>
    {isPromptPickerOpen && <PromptPickerModal onClose={() => setIsPromptPickerOpen(false)} onPick={(choice) => { setInput(choice); setIsPromptPickerOpen(false) }} />}
    {inspector === 'sliding' && <StrategyInspectorModal title="Сообщения в Sliding Window" subtitle={`В следующий запрос попадут последние ${windows.sliding} сообщений.`} onClose={() => setInspector(null)}><StrategyContextCard title="Текущее окно" messages={(histories.sliding ?? []).slice(-windows.sliding)} empty="Окно пока пусто." /></StrategyInspectorModal>}
    {inspector === 'facts' && <StrategyInspectorModal title="Память Sticky Facts" subtitle={`В основной запрос идут эта карточка и последние ${windows.facts} сообщений.`} onClose={() => setInspector(null)}><article className="strategy-context-card"><header><div><p className="eyebrow">Key-Value память</p><h2>Текущие facts</h2></div><span>{latestFacts ? `обновлений: ${contexts.facts?.factsSnapshots?.length}` : 'пока пуста'}</span></header>{latestFacts ? <><pre className="facts-json">{JSON.stringify(latestFacts.values, null, 2)}</pre>{latestFacts.error && <p className="strategy-warning">Последнее обновление facts не удалось: использованы предыдущие значения.</p>}</> : <p className="strategy-empty">Facts появятся после первого сообщения.</p>}</article><StrategyContextCard title="Окно рядом с facts" messages={(histories.facts ?? []).slice(-windows.facts)} empty="Сообщений рядом с facts пока нет." /></StrategyInspectorModal>}
  </div>
}

function ContextBranchingPage() {
  const [context, setContext] = useState<AgentStrategyContext | null>(null)
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void load() }, [])

  async function load() {
    setIsLoading(true)
    try {
      await ensureDay10Agent(branchingLabAgent, 'branching')
      const response = await fetch(`/api/agents/${branchingLabAgent.id}/context`)
      const data = await response.json() as AgentStrategyContext & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось загрузить ветки.')
      setContext(data); setError(null)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить ветки.') } finally { setIsLoading(false) }
  }

  async function request(path: string, body?: Record<string, unknown>) {
    setIsLoading(true); setError(null)
    try {
      const response = await fetch(path, { method: 'POST', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
      const data = await response.json() as AgentStrategyContext & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось обновить ветки.')
      setContext(data)
      return true
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось обновить ветки.'); return false } finally { setIsLoading(false) }
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    const prompt = input.trim()
    if (!prompt || isLoading) return
    setIsLoading(true); setError(null)
    try {
      const response = await fetch(`/api/agents/${branchingLabAgent.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: prompt }) })
      const data = await response.json() as AgentStrategyRunResult & ApiError
      if (!response.ok) throw new Error(data.error || 'Не удалось продолжить ветку.')
      setInput(''); await load()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось продолжить ветку.') } finally { setIsLoading(false) }
  }

  async function clearBranches() {
    if (isLoading || !window.confirm('Очистить историю и все ветки этого агента? Это действие нельзя отменить.')) return
    setIsLoading(true); setError(null)
    try {
      await Promise.all([fetch(`/api/agents/${branchingLabAgent.id}/history`, { method: 'DELETE' }), fetch(`/api/agents/${branchingLabAgent.id}/context/reset`, { method: 'POST' })])
      await load()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось очистить ветки.') } finally { setIsLoading(false) }
  }

  const branching = context?.branching
  const activeBranch = branching?.branches.find((branch) => branch.id === branching.activeBranchId)
  const checkpoints = branching?.checkpoints ?? []
  const activeMessages = branching?.activeMessages ?? []
  const lastAssistant = [...activeMessages].reverse().find((message) => message.role === 'assistant')
  const totalTokens = activeMessages.reduce((sum, message) => sum + (message.tokenMetrics?.totalTokens ?? 0), 0)
  return <div className="page-view context-strategies-page branching-page">
    <header className="page-header"><div><p className="eyebrow">День 10 · стратегия 3</p><h1>Диалог с точкой разветвления</h1><p className="header-description">Это обычный агент со стратегией Branching. Создавайте новую ветку из текущей точки и переключайтесь между любыми сохранёнными линиями.</p></div><div className="branching-header-actions"><span className="model-badge"><span className="pulse-dot" /> DeepSeek</span><button className="clear-context-button" type="button" onClick={() => void clearBranches()} disabled={isLoading}>Очистить ветки</button></div></header>
    {error && <div className="error-message" role="alert">{error}</div>}
    <section className="branching-workbench"><aside><p className="eyebrow">Рабочая линия</p><h2>{activeBranch?.label ?? 'Корневая ветка'}</h2><p>{checkpoints.length ? `Создано checkpoint: ${checkpoints.length}. Новый можно поставить в текущей точке активной линии.` : 'Отправьте хотя бы один вопрос, чтобы зафиксировать первую точку.'}</p><small className="branching-total">Всего в активной линии: {totalTokens} ток.</small><button className="context-compression-button" type="button" disabled={isLoading || !lastAssistant} onClick={() => void request(`/api/agents/${branchingLabAgent.id}/context/checkpoint`)}>Создать одну ветку из текущей точки</button>{checkpoints.length > 0 && <div className="checkpoint-list"><small>Созданные точки</small><ol>{checkpoints.map((checkpoint, index) => <li key={checkpoint.id}>Checkpoint {index + 1} · {branching?.branches.find((branch) => branch.id === checkpoint.branchId)?.label ?? 'линия'}</li>)}</ol></div>}<div className="branch-list"><small>Перейти к линии</small><div className="strategy-branch-actions">{branching?.branches.map((branch) => <button type="button" className={`context-compression-button ${branch.id === activeBranch?.id ? 'enabled' : ''}`} key={branch.id} disabled={isLoading} onClick={() => void request(`/api/agents/${branchingLabAgent.id}/context/active-branch`, { branchId: branch.id })}>{branch.label}</button>)}</div></div></aside><StrategyContextCard title={`Сообщения: ${activeBranch?.label ?? 'корневая ветка'}`} messages={activeMessages} empty="Здесь появятся сообщения ветки." /></section>
    <form className="strategy-composer" onSubmit={send}><textarea value={input} onChange={(event) => setInput(event.target.value)} disabled={isLoading} rows={4} placeholder={`Следующий ход для ${activeBranch?.label ?? 'корневой ветки'}…`} /><div><span className="strategy-send-note">Отправка только в активную ветку</span><button className="compare-button" type="submit" disabled={isLoading || !input.trim()}>{isLoading ? 'DeepSeek отвечает…' : 'Продолжить ветку'} <span>→</span></button></div></form>
  </div>
}

function StrategyOverviewCard({ title, badge, description, stats, factsTokens, windowSize, isLoading, onWindowSizeChange, actionLabel, onAction }: { title: string; badge: string; description: string; stats?: ContextStrategyStats; factsTokens?: number; windowSize?: number; isLoading?: boolean; onWindowSizeChange?: (value: number) => void; actionLabel?: string; onAction?: () => void }) {
  return <article className="strategy-overview-card"><header><div><p className="eyebrow">{badge}</p><h2>{title}</h2></div><strong>{stats?.overall.totalTokens ?? 0} ток.</strong></header><p>{description}</p>{windowSize !== undefined && onWindowSizeChange && <label className="strategy-window-setting">Последних N сообщений<input type="number" min="1" max="1000000" step="1" value={windowSize} onChange={(event) => onWindowSizeChange(Number(event.target.value))} disabled={isLoading} /><small>Настройка этого агента.</small></label>}{actionLabel && onAction && <button type="button" className="strategy-inspect-button" onClick={onAction}>{actionLabel} <span>↗</span></button>}<footer><span>Последний prompt: {stats?.latest?.promptTokens ?? '—'}</span><span>Ответы: {stats?.answers.totalTokens ?? 0}</span>{factsTokens !== undefined && <span>Facts: {factsTokens}</span>}</footer></article>
}

function PromptPickerModal({ onClose, onPick }: { onClose: () => void; onPick: (choice: string) => void }) {
  return <div className="strategy-picker-backdrop" role="presentation" onMouseDown={onClose}><section className="strategy-prompt-picker" role="dialog" aria-modal="true" aria-label="Сообщения сценария Habit Flow" onMouseDown={(event) => event.stopPropagation()}><header><div><p className="eyebrow">Сценарий Habit Flow</p><h2>Выберите следующее сообщение</h2></div><button type="button" aria-label="Закрыть" onClick={onClose}>×</button></header><p>Выбор только подставляет текст в поле ввода. Отправка всегда запускает три сравниваемых контекста.</p><div>{contextStrategyPromptChoices.map((choice, index) => <button type="button" key={choice} onClick={() => onPick(choice)}><strong>{index + 1}</strong><span>{choice}</span></button>)}</div></section></div>
}

function StrategyInspectorModal({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: ReactNode }) {
  return <div className="strategy-picker-backdrop" role="presentation" onMouseDown={onClose}><section className="strategy-context-inspector" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}><header><div><p className="eyebrow">Контекст модели</p><h2>{title}</h2><p>{subtitle}</p></div><button type="button" aria-label="Закрыть" onClick={onClose}>×</button></header><div className="strategy-inspector-content">{children}</div></section></div>
}

function StrategyContextCard({ title, messages, empty }: { title: string; messages: ContextStrategyMessage[]; empty: string }) {
  return <article className="strategy-context-card"><header><div><p className="eyebrow">Контекст модели</p><h2>{title}</h2></div><span>{messages.length} сообщ.</span></header><div className="strategy-message-list">{messages.length ? messages.map((message) => <div className={message.role} key={message.id}><small>{message.role === 'user' ? 'Пользователь' : 'Агент'}</small><span>{message.content}</span></div>) : <p className="strategy-empty">{empty}</p>}</div></article>
}

function StrategyResultCard({ name, result }: { name: ContextStrategyName; result?: ContextStrategyResult }) {
  const title = name === 'sliding' ? 'Sliding Window' : name === 'facts' ? 'Sticky Facts' : 'Branching'
  return <article className={`strategy-result-card ${name}`}><header><strong>{title}</strong>{result && <span>{result.tokenMetrics.totalTokens} ток.</span>}</header>{result ? <><div className="reasoning-content"><MarkdownContent content={result.output} /></div><footer><span>Prompt: {result.tokenMetrics.promptTokens}</span><span>Ответ: {result.tokenMetrics.completionTokens}</span>{result.factsUpdate && <span>Facts: {result.factsUpdate.totalTokens}</span>}{result.factsError && <span className="strategy-warning">facts: ошибка</span>}</footer></> : <p>Не запускался для этого хода.</p>}</article>
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
