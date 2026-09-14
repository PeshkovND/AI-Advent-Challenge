import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { AgentError, AgentService } from './agent-service'
import type { AgentConfig, AgentContextCommit, AgentContextInfo, AgentContextPreparation, AgentMessage, AgentTokenMetrics } from './agent-service'

export const FACT_KEYS = ['goal', 'constraints', 'preferences', 'decisions', 'agreements', 'open_questions'] as const

export type FactKey = typeof FACT_KEYS[number]
export type StickyFacts = Record<FactKey, string[]>
export type ContextStrategy = 'sliding' | 'facts' | 'branching' | 'summary'

type StoredMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  tokenMetrics?: AgentTokenMetrics
}

type FactsSnapshot = {
  userMessageId: string
  values: StickyFacts
  tokenMetrics?: AgentTokenMetrics
  error?: string
  createdAt: string
}

type Branch = {
  id: string
  label: string
  parentId?: string
  checkpointMessageId?: string
  messages: StoredMessage[]
}

type Checkpoint = {
  id: string
  branchId: string
  messageId: string
  createdAt: string
}

type ContextSummary = {
  content: string
  summarizedMessages: number
  estimatedReplacedTokens: number
  updatedAt: string
}

type AgentContextState = {
  agentId: string
  strategy: ContextStrategy
  windowSize: number
  facts: StickyFacts
  factsSnapshots: FactsSnapshot[]
  summary?: ContextSummary
  branching: {
    activeBranchId: string
    checkpoints: Checkpoint[]
    branches: Branch[]
  }
  createdAt: string
}

type ContextStrategiesState = {
  agentContexts: Record<string, AgentContextState>
}

/**
 * Per-agent policies for preparing a model context. This service has no HTTP
 * surface of its own: AgentService exposes its operations through /api/agents.
 */
export class ContextStrategiesService {
  private state: ContextStrategiesState = { agentContexts: {} }
  private writeQueue: Promise<void> = Promise.resolve()
  readonly ready: Promise<void>

  constructor(
    private readonly agents: AgentService,
    private readonly defaultModel: string,
    private readonly filePath = resolve(process.cwd(), 'data', 'context-strategies.json'),
  ) {
    this.ready = this.load()
  }

  async prepareAgentContext(agentId: string, input: string, config: AgentConfig, history: AgentMessage[]): Promise<AgentContextPreparation> {
    await this.ready
    const strategy = config.contextStrategy
    if (!strategy) return { config, history }

    const context = this.ensureAgentContext(agentId, strategy.strategy, strategy.windowSize)
    if (strategy.strategy === 'facts' && strategy.facts && context.factsSnapshots.length === 0) {
      context.facts = mergeFacts(context.facts, strategy.facts)
    }

    let selectedHistory = history
    let nextConfig = config
    let strategyTokenMetrics: AgentTokenMetrics | undefined
    let strategyError: string | undefined
    let summary: string | undefined
    let summaryTokenMetrics: AgentTokenMetrics | undefined
    let summaryToPersist: ContextSummary | undefined
    let contextInfo: AgentContextInfo | undefined

    if (strategy.strategy === 'sliding') {
      selectedHistory = history.slice(-context.windowSize)
    } else if (strategy.strategy === 'facts') {
      selectedHistory = history.slice(-context.windowSize)
      try {
        const update = await this.updateAgentFacts(context, input, config)
        context.facts = update.values
        strategyTokenMetrics = update.tokenMetrics
        context.factsSnapshots.push({
          userMessageId: newId(),
          values: context.facts,
          tokenMetrics: update.tokenMetrics,
          createdAt: new Date().toISOString(),
        })
      } catch (error) {
        // A failed update must not discard the last known facts or block a turn.
        strategyError = error instanceof Error ? error.message : 'Не удалось обновить facts.'
      }
      const factsBlock = `Ниже карточка устойчивых фактов диалога. Используй её как рабочую память; если текущий вопрос явно меняет условие, приоритет у нового условия.\n${JSON.stringify(context.facts, null, 2)}`
      nextConfig = {
        ...config,
        contextStrategy: { ...strategy, windowSize: context.windowSize, facts: context.facts },
        systemPrompt: [config.systemPrompt, factsBlock].filter(Boolean).join('\n\n'),
      }
    } else if (strategy.strategy === 'branching') {
      const branch = findBranch(context.branching.branches, context.branching.activeBranchId)
      // Only an untouched root may adopt history that predates strategy setup.
      // A newly created child branch must start exactly at its checkpoint.
      if (!branch.parentId && branch.messages.length === 0 && history.length > 0) branch.messages = history.map(toStoredMessage)
      selectedHistory = this.agentBranchLineage(context, branch).map(toAgentMessage)
    } else {
      const threshold = strategy.summarizeAfterMessages ?? 10
      if (countDialogMessages(history) >= threshold) {
        const result = await this.summarizeHistory(context.summary?.content, history, config)
        summaryToPersist = {
          content: result.content,
          summarizedMessages: (context.summary?.summarizedMessages ?? 0) + history.length,
          estimatedReplacedTokens: (context.summary?.estimatedReplacedTokens ?? 0) + estimateMessagesTokens(history),
          updatedAt: new Date().toISOString(),
        }
        selectedHistory = []
        summary = summaryToPersist.content
        summaryTokenMetrics = result.tokenMetrics
        contextInfo = createSummaryContextInfo(config, selectedHistory, summaryToPersist, input)
      } else {
        summary = context.summary?.content
        contextInfo = createSummaryContextInfo(config, selectedHistory, context.summary, input)
      }
    }

    await this.persist()
    return {
      config: nextConfig,
      history: selectedHistory,
      ...(summary ? { summary } : {}),
      ...(summaryTokenMetrics ? { summaryTokenMetrics } : {}),
      ...(summaryToPersist ? { summaryToPersist } : {}),
      ...(contextInfo ? { context: contextInfo } : {}),
      ...(strategyTokenMetrics ? { strategyTokenMetrics } : {}),
      ...(strategyError ? { strategyError } : {}),
    }
  }

  async recordAgentTurn(agentId: string, config: AgentConfig, input: string, output: string, tokenMetrics: AgentTokenMetrics, preparation?: AgentContextPreparation): Promise<AgentContextCommit> {
    await this.ready
    const strategy = config.contextStrategy
    if (!strategy) return {}
    const context = this.ensureAgentContext(agentId, strategy.strategy, strategy.windowSize)
    if (strategy.strategy === 'branching') {
      appendPair(findBranch(context.branching.branches, context.branching.activeBranchId).messages, input, output, tokenMetrics)
    }
    if (strategy.strategy === 'summary' && isContextSummary(preparation?.summaryToPersist)) {
      context.summary = preparation.summaryToPersist
      await this.persist()
      return { archiveHistory: true }
    }
    await this.persist()
    return {}
  }

  async getAgentContext(agentId: string, config: AgentConfig) {
    await this.ready
    const strategy = config.contextStrategy
    if (!strategy) return { agentId, configured: false }
    const context = this.ensureAgentContext(agentId, strategy.strategy, strategy.windowSize)
    await this.persist()
    return this.serializeAgentContext(context)
  }

  async getAgentContextInfo(agentId: string, config: AgentConfig, history: AgentMessage[]): Promise<AgentContextInfo> {
    await this.ready
    const strategy = config.contextStrategy
    if (!strategy || strategy.strategy !== 'summary') {
      return createSummaryContextInfo(config, history, undefined, '')
    }
    const context = this.ensureAgentContext(agentId, strategy.strategy, strategy.windowSize)
    await this.persist()
    return createSummaryContextInfo(config, history, context.summary, '')
  }

  async resetAgentContext(agentId: string) {
    await this.ready
    delete this.state.agentContexts[agentId]
    await this.persist()
    return { agentId, configured: false, reset: true }
  }

  async setAgentWindowSize(agentId: string, value: unknown, config: AgentConfig) {
    await this.ready
    const strategy = config.contextStrategy
    if (!strategy || strategy.strategy === 'branching') throw new AgentError('Размер окна доступен только для Sliding Window и Sticky Facts.')
    const context = this.ensureAgentContext(agentId, strategy.strategy, strategy.windowSize)
    context.windowSize = parseAgentWindowSize(value)
    await this.persist()
    return this.serializeAgentContext(context)
  }

  async createAgentCheckpoint(agentId: string) {
    await this.ready
    const context = this.state.agentContexts[agentId]
    if (!context) throw new AgentError('Для агента ещё не создано состояние стратегии.')
    if (context.strategy !== 'branching') throw new AgentError('Checkpoint доступен только для стратегии Branching.')
    const source = findBranch(context.branching.branches, context.branching.activeBranchId)
    const lastAssistant = [...this.agentBranchLineage(context, source)].reverse().find((message) => message.role === 'assistant')
    if (!lastAssistant) throw new AgentError('Сначала получите хотя бы один ответ в текущей ветке.')

    context.branching.checkpoints.push({ id: newId(), branchId: source.id, messageId: lastAssistant.id, createdAt: new Date().toISOString() })
    const branch: Branch = {
      id: newId(),
      label: `Ветка ${context.branching.checkpoints.length}`,
      parentId: source.id,
      checkpointMessageId: lastAssistant.id,
      messages: [],
    }
    context.branching.branches.push(branch)
    context.branching.activeBranchId = branch.id
    await this.persist()
    return this.serializeAgentContext(context)
  }

  async activateAgentBranch(agentId: string, branchId: unknown) {
    await this.ready
    const context = this.state.agentContexts[agentId]
    if (!context) throw new AgentError('Для агента ещё не создано состояние стратегии.')
    if (context.strategy !== 'branching') throw new AgentError('Переключение веток доступно только для стратегии Branching.')
    if (typeof branchId !== 'string') throw new AgentError('Передайте id ветки.')
    context.branching.activeBranchId = findBranch(context.branching.branches, branchId).id
    await this.persist()
    return this.serializeAgentContext(context)
  }

  private ensureAgentContext(agentId: string, strategy: ContextStrategy, requestedWindowSize?: number) {
    const existing = this.state.agentContexts[agentId]
    if (!existing || existing.strategy !== strategy) {
      const root: Branch = { id: newId(), label: 'Корневая ветка', messages: [] }
      this.state.agentContexts[agentId] = {
        agentId,
        strategy,
        windowSize: requestedWindowSize ?? 10,
        facts: emptyFacts(),
        factsSnapshots: [],
        branching: { activeBranchId: root.id, checkpoints: [], branches: [root] },
        createdAt: new Date().toISOString(),
      }
    } else if (requestedWindowSize !== undefined) {
      existing.windowSize = requestedWindowSize
    }
    return this.state.agentContexts[agentId]
  }

  private async updateAgentFacts(context: AgentContextState, prompt: string, config: AgentConfig) {
    const result = await this.agents.runEphemeral(
      `Снимок памяти перед новым ходом:\n${JSON.stringify(context.facts, null, 2)}\n\nСодержание нового пользовательского хода:\n${prompt}`,
      {
        provider: config.provider ?? 'deepseek',
        model: config.model ?? this.defaultModel,
        temperature: 0,
        outputPolicy: { format: 'json' },
        systemPrompt: 'Ты поддерживаешь компактную карточку достоверных сведений о диалоге. Пересобери её с учётом нового хода, не делая выводов от себя. Ответом должен быть только JSON-объект, без Markdown и пояснений. Допустимы ровно ключи goal, constraints, preferences, decisions, agreements и open_questions; у каждого — массив коротких строк. Сохраняй актуальные прежние пункты, добавляй новые подтверждённые условия, а устаревшие или явно отменённые замещай новыми.',
      },
      [],
      false,
    )
    return { values: normalizeFacts(JSON.parse(result.output)), tokenMetrics: result.tokenMetrics }
  }

  private async summarizeHistory(previousSummary: string | undefined, history: AgentMessage[], config: AgentConfig) {
    const result = await this.agents.runEphemeral(
      `Предыдущее резюме:\n${previousSummary || 'Нет.'}\n\nНовые сообщения для включения в резюме:\n${formatMessages(history)}`,
      {
        provider: config.provider ?? 'deepseek',
        model: config.model ?? this.defaultModel,
        temperature: 0,
        maxTokens: Math.min(config.maxTokens ?? 800, 800),
        systemPrompt: `Ты создаёшь компактное summary контекста агента. Верни только summary на русском, без вступления и Markdown-обёртки.

Новое всегда важнее противоречащего старого. Сохрани цель, подтверждённые факты, имена, даты, числа, решения, причины решений, ограничения, предпочтения, состояние артефактов и открытые следующие шаги. Не добавляй догадок, не пересказывай диалог дословно и не сохраняй приветствия или промежуточные рассуждения. Если факт не подтверждён, отметь его как неопределённый. Объём — до 250 слов.

Структура:
## Цель и контекст
## Факты и решения
## Ограничения и предпочтения
## Открытые вопросы / следующие шаги`,
      },
      [],
      false,
    )
    return { content: result.output.trim(), tokenMetrics: result.tokenMetrics }
  }

  private agentBranchLineage(context: AgentContextState, branch: Branch): StoredMessage[] {
    if (!branch.parentId) return [...branch.messages]
    const inherited = this.agentBranchLineage(context, findBranch(context.branching.branches, branch.parentId))
    const checkpointIndex = inherited.findIndex((message) => message.id === branch.checkpointMessageId)
    if (checkpointIndex === -1) throw new AgentError('Не удалось восстановить checkpoint ветки.')
    return [...inherited.slice(0, checkpointIndex + 1), ...branch.messages]
  }

  private serializeAgentContext(context: AgentContextState) {
    const snapshot = clone(context)
    const activeBranch = findBranch(snapshot.branching.branches, snapshot.branching.activeBranchId)
    return {
      ...snapshot,
      configured: true,
      branching: { ...snapshot.branching, activeMessages: this.agentBranchLineage(snapshot, activeBranch) },
    }
  }

  private async load() {
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (isRecord(parsed) && isRecord(parsed.agentContexts)) {
        this.state.agentContexts = Object.fromEntries(
          Object.entries(parsed.agentContexts).filter((entry): entry is [string, AgentContextState] => isAgentContextState(entry[1])),
        )
      }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return
      console.warn('Не удалось загрузить сохранённые стратегии контекста. Будет создано новое состояние.')
    }
  }

  private persist() {
    const snapshot = JSON.stringify(this.state, null, 2)
    const temporaryPath = `${this.filePath}.tmp`
    const operation = this.writeQueue.then(async () => {
      await writeFile(temporaryPath, snapshot, 'utf8')
      await rename(temporaryPath, this.filePath)
    })
    this.writeQueue = operation.catch(() => {})
    return operation
  }
}

function emptyFacts(): StickyFacts {
  return { goal: [], constraints: [], preferences: [], decisions: [], agreements: [], open_questions: [] }
}

function mergeFacts(base: StickyFacts, incoming: Record<string, string[]>): StickyFacts {
  const result = { ...base }
  for (const key of FACT_KEYS) {
    const values = incoming[key]
    if (Array.isArray(values)) result[key] = [...new Set(values.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
  }
  return result
}

function normalizeFacts(value: unknown): StickyFacts {
  if (!isRecord(value)) throw new AgentError('Facts-модель вернула не объект JSON.')
  const facts = emptyFacts()
  for (const key of FACT_KEYS) {
    const values = typeof value[key] === 'string' ? [value[key]] : value[key]
    if (!Array.isArray(values) || !values.every((item) => typeof item === 'string')) throw new AgentError('Facts-модель вернула неверную структуру JSON.')
    facts[key] = [...new Set(values.map((item) => item.trim()).filter(Boolean))]
  }
  return facts
}

function formatMessages(messages: AgentMessage[]) {
  return messages.map((message) => `${message.role === 'assistant' ? 'Агент' : message.role === 'user' ? 'Пользователь' : 'Система'}: ${message.content}`).join('\n\n')
}

function countDialogMessages(messages: AgentMessage[]) {
  return messages.filter((message) => message.role === 'user' || message.role === 'assistant').length
}

function estimateTokens(value: string) {
  const normalized = value.trim()
  return normalized ? Math.max(1, Math.ceil(normalized.length / 3)) : 0
}

function estimateMessagesTokens(messages: AgentMessage[]) {
  return messages.reduce((total, message) => total + estimateTokens(message.content) + 4, 0)
}

function createSummaryContextInfo(config: AgentConfig, retainedHistory: AgentMessage[], summary: ContextSummary | undefined, input: string): AgentContextInfo {
  const systemTokens = estimateTokens(config.systemPrompt ?? '') + (config.systemPrompt ? 4 : 0)
  const fullPromptTokens = systemTokens + estimateMessagesTokens(retainedHistory) + estimateTokens(input) + 4 + (summary?.estimatedReplacedTokens ?? 0)
  const sentPromptTokens = systemTokens + estimateMessagesTokens(retainedHistory) + estimateTokens(input) + 4 + (summary ? estimateTokens(summary.content) + 4 : 0)
  return {
    enabled: config.contextStrategy?.strategy === 'summary',
    ...(summary ? { summary: summary.content } : {}),
    summarizedMessages: summary?.summarizedMessages ?? 0,
    retainedMessages: retainedHistory.length,
    estimatedFullPromptTokens: fullPromptTokens,
    estimatedSentPromptTokens: sentPromptTokens,
    estimatedSavedTokens: Math.max(0, fullPromptTokens - sentPromptTokens),
  }
}

function appendPair(messages: StoredMessage[], input: string, output: string, tokenMetrics: AgentTokenMetrics) {
  messages.push(
    { id: newId(), role: 'user', content: input, createdAt: new Date().toISOString() },
    { id: newId(), role: 'assistant', content: output, tokenMetrics, createdAt: new Date().toISOString() },
  )
}

function toStoredMessage(message: AgentMessage): StoredMessage {
  return { id: newId(), role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content, createdAt: new Date().toISOString() }
}

function toAgentMessage(message: StoredMessage): AgentMessage {
  return { role: message.role, content: message.content }
}

function parseAgentWindowSize(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_000_000) throw new AgentError('Размер окна агента должен быть целым числом от 1 до 1 000 000.')
  return value
}

function findBranch(branches: Branch[], id: string) {
  const branch = branches.find((item) => item.id === id)
  if (!branch) throw new AgentError('Ветка не найдена.')
  return branch
}

function newId() {
  return globalThis.crypto.randomUUID()
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isAgentContextState(value: unknown): value is AgentContextState {
  return isRecord(value)
    && typeof value.agentId === 'string'
    && (value.strategy === 'sliding' || value.strategy === 'facts' || value.strategy === 'branching' || value.strategy === 'summary')
    && typeof value.windowSize === 'number'
    && isRecord(value.facts)
    && Array.isArray(value.factsSnapshots)
    && isRecord(value.branching)
    && Array.isArray(value.branching.branches)
    && Array.isArray(value.branching.checkpoints)
    && typeof value.branching.activeBranchId === 'string'
}

function isContextSummary(value: unknown): value is ContextSummary {
  return isRecord(value)
    && typeof value.content === 'string'
    && typeof value.summarizedMessages === 'number'
    && typeof value.estimatedReplacedTokens === 'number'
    && typeof value.updatedAt === 'string'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return isRecord(error) && typeof error.code === 'string'
}
