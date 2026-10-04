import express, { Request, Response, Router } from 'express'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { AgentMemory } from './agent-memory'
import type { AgentMemoryLayersConfig, AgentMemorySnapshot, AutoMemoryUpdate } from './agent-memory'
import { personalizationPrompt } from './agent-personalization'
import type { AgentPersonalizationConfig } from './agent-personalization'
import { activeInvariants, blockedInvariantMessage, invariantCheckInput, invariantCheckSystemPrompt, invariantsPrompt, parseInvariantVerdict, repairInvariantPrompt } from './agent-invariants'
import type { AgentInvariantsConfig, InvariantCheckInfo, InvariantVerdict } from './agent-invariants'
import type { McpToolRuntime, McpToolCall } from './mcp-tool-runtime'
import { actorForStage, applyTaskDecision, newTaskState, parseTaskDecision, parseTaskInputInterpretation, taskInputIntentInput, taskInputIntentSystemPrompt, taskScopeId, taskStatePrompt } from './task-state'
import type { AgentTaskState, TaskDecision, TaskInputInterpretation, TaskTransitionAuthorization } from './task-state'
import { RagRetriever, type RagConfig, type RagCompletion } from './rag-retrieval'
import type { RagResult } from '../src/rag-types'
import { answerWithGrounding, renderGroundedAnswer } from './rag-grounding'

export type AgentProvider = 'deepseek' | 'huggingface' | 'openrouter'
export type AgentMessageRole = 'system' | 'user' | 'assistant'

export type AgentMessage = {
  role: AgentMessageRole
  content: string
  archived?: boolean
}

export type AgentTokenMetrics = {
  inputTokens: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type AgentTokenUsagePoint = AgentTokenMetrics & {
  turn: number
  conversationTokens: number
  summaryTokens?: number
  strategyTokens?: number
  strategyTokenMetrics?: AgentTokenMetrics
  memoryTokens?: number
  memoryTokenMetrics?: AgentTokenMetrics
}

export type AgentContextInfo = {
  enabled: boolean
  summary?: string
  summarizedMessages: number
  retainedMessages: number
  estimatedFullPromptTokens: number
  estimatedSentPromptTokens: number
  estimatedSavedTokens: number
  summaryTokens?: number
}

export type AgentConfig = {
  name?: string
  provider?: AgentProvider
  model?: string
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
  inputPolicy?: {
    maxCharacters?: number
  }
  outputPolicy?: {
    maxCharacters?: number
    format?: 'text' | 'json'
    stopSequences?: string[]
  }
  memoryLayers?: AgentMemoryLayersConfig
  personalization?: AgentPersonalizationConfig
  invariants?: AgentInvariantsConfig
  taskState?: AgentTaskState
  taskMachine?: boolean
  /** MCP capabilities are selected by server-side ids; clients never provide commands or credentials. */
  mcp?: { enabled: boolean; servers: string[]; toolAccess?: 'all' | 'read-only'; serverToolAccess?: Record<string, 'all' | 'read-only'> }
  rag?: RagConfig
  /**
   * Optional context policy used by the Day 10 strategy demo. The policy is
   * part of the agent configuration so the Agent, rather than the storage
   * service, decides which messages belong in the model prompt.
   */
  contextStrategy?: AgentContextStrategyConfig
}

export type AgentContextStrategy = 'sliding' | 'facts' | 'branching' | 'summary'

export type AgentContextStrategyConfig = {
  strategy: AgentContextStrategy
  windowSize?: number
  summarizeAfterMessages?: number
  facts?: Record<string, string[]>
}

export type AgentContextPreparation = {
  config: AgentConfig
  history: AgentMessage[]
  summary?: string
  summaryTokenMetrics?: AgentTokenMetrics
  summaryToPersist?: unknown
  context?: AgentContextInfo
  strategyTokenMetrics?: AgentTokenMetrics
  strategyError?: string
}

export type AgentContextCommit = {
  archiveHistory?: boolean
}

export type ContextStrategiesServiceLike = {
  prepareAgentContext(agentId: string, input: string, config: AgentConfig, history: AgentMessage[]): Promise<AgentContextPreparation>
  recordAgentTurn(agentId: string, config: AgentConfig, input: string, output: string, tokenMetrics: AgentTokenMetrics, preparation?: AgentContextPreparation): Promise<AgentContextCommit>
  getAgentContext?(agentId: string, config: AgentConfig): Promise<unknown>
  getAgentContextInfo?(agentId: string, config: AgentConfig, history: AgentMessage[]): Promise<AgentContextInfo>
  resetAgentContext?(agentId: string): Promise<unknown>
  setAgentWindowSize?(agentId: string, value: unknown, config: AgentConfig): Promise<unknown>
  createAgentCheckpoint?(agentId: string): Promise<unknown>
  activateAgentBranch?(agentId: string, branchId: unknown): Promise<unknown>
}

export type AgentRunResult = {
  agentId: string
  input: string
  output: string
  provider: AgentProvider
  model: string
  durationMs: number
  tokens?: number
  promptTokens?: number
  totalTokens?: number
  conversationTokens?: number
  contextMessages?: number
  tokenMetrics: AgentTokenMetrics
  memory?: AgentMemorySnapshot
  memoryClassifierTokenMetrics?: AgentTokenMetrics
  summaryTokenMetrics?: AgentTokenMetrics
  archiveHistory?: boolean
  autoMemoryUpdate?: AutoMemoryUpdate
  strategyTokenMetrics?: AgentTokenMetrics
  strategyError?: string
  tokenHistory?: AgentTokenUsagePoint[]
  context?: AgentContextInfo
  taskDecision?: TaskDecision
  taskState?: AgentTaskState
  taskNotice?: string
  invariantCheck?: InvariantCheckInfo
  mcpToolCalls?: McpToolCall[]
  rag?: RagResult
}

export type AgentTaskRunEvent = {
  content: string
  taskState?: AgentTaskState
  invariantCheck?: InvariantCheckInfo
}

type CompletionResult = {
  content: string
  tokens?: number
  promptTokens?: number
  totalTokens?: number
}

type LlmOptions = {
  provider: AgentProvider
  model: string
  temperature?: number
  maxTokens?: number
  stopSequences?: string[]
  format?: 'text' | 'json'
}

type AgentServiceOptions = {
  deepSeekApiKey?: string
  huggingFaceApiKey?: string
  openRouterApiKey?: string
  defaultDeepSeekModel: string
}

type AgentRecord = {
  id: string
  config: Required<Pick<AgentConfig, 'provider' | 'model'>> & AgentConfig
  createdAt: string
}

type AgentState = {
  agents: AgentRecord[]
  histories: Record<string, AgentMessage[]>
  /** Last successful MCP receipts, kept separately from conversational text. */
  mcpContexts: Record<string, McpToolCall[]>
  conversationTokens: Record<string, number>
  tokenHistory: Record<string, AgentTokenUsagePoint[]>
}

export class AgentStateStore {
  private state: AgentState = { agents: [], histories: {}, mcpContexts: {}, conversationTokens: {}, tokenHistory: {} }
  private writeQueue: Promise<void> = Promise.resolve()
  readonly ready: Promise<void>

  constructor(private readonly filePath = resolve(process.cwd(), 'data', 'agent-state.json')) {
    this.ready = this.load()
  }

  async getAgents() {
    await this.ready
    return this.state.agents.map((agent) => ({ ...agent, config: { ...agent.config } }))
  }

  async getHistory(agentId: string) {
    await this.ready
    return (this.state.histories[agentId] ?? []).map((message) => ({ ...message }))
  }

  async replaceHistory(agentId: string, messages: AgentMessage[]) {
    await this.ready
    this.state.histories[agentId] = [...messages]
    await this.persist()
    return this.state.histories[agentId].length
  }

  async appendHistory(agentId: string, messages: AgentMessage[]) {
    await this.ready
    const nextHistory = [...(this.state.histories[agentId] ?? []), ...messages]
    this.state.histories[agentId] = nextHistory
    await this.persist()
    return this.state.histories[agentId].length
  }

  async getMcpContext(agentId: string) {
    await this.ready
    return (this.state.mcpContexts[agentId] ?? []).map((call) => ({ ...call, arguments: { ...call.arguments } }))
  }

  async replaceMcpContext(agentId: string, calls: McpToolCall[]) {
    await this.ready
    const successful = calls.filter((call) => !call.isError).slice(-4)
    if (successful.length) this.state.mcpContexts[agentId] = successful
    else delete this.state.mcpContexts[agentId]
    await this.persist()
  }

  async archiveActiveHistory(agentId: string) {
    await this.ready
    this.state.histories[agentId] = (this.state.histories[agentId] ?? []).map((message) => message.archived ? message : { ...message, archived: true })
    await this.persist()
  }

  async addConversationTokens(agentId: string, metrics: AgentTokenMetrics, summaryTokens = 0, strategyTokenMetrics?: AgentTokenMetrics, memoryTokenMetrics?: AgentTokenMetrics) {
    await this.ready
    const strategyTokens = strategyTokenMetrics?.totalTokens ?? 0
    const memoryTokens = memoryTokenMetrics?.totalTokens ?? 0
    const conversationTokens = (this.state.conversationTokens[agentId] ?? 0) + metrics.totalTokens + summaryTokens + strategyTokens + memoryTokens
    this.state.conversationTokens[agentId] = conversationTokens
    const history = this.state.tokenHistory[agentId] ?? []
    this.state.tokenHistory[agentId] = [...history, {
      ...metrics,
      turn: history.length + 1,
      conversationTokens,
      ...(summaryTokens ? { summaryTokens } : {}),
      ...(strategyTokens ? { strategyTokens, strategyTokenMetrics } : {}),
      ...(memoryTokens ? { memoryTokens, memoryTokenMetrics } : {}),
    }]
    await this.persist()
    return conversationTokens
  }

  async getConversationTokens(agentId: string) {
    await this.ready
    return this.state.conversationTokens[agentId] ?? 0
  }

  async getTokenHistory(agentId: string) {
    await this.ready
    return [...(this.state.tokenHistory[agentId] ?? [])]
  }

  async replaceAgents(agents: AgentRecord[]) {
    await this.ready
    this.state.agents = agents.map((agent) => ({ ...agent, config: { ...agent.config } }))
    await this.persist()
  }

  async removeAgent(agentId: string) {
    await this.ready
    this.state.agents = this.state.agents.filter((agent) => agent.id !== agentId)
    this.removeHistoryScopes(agentId)
    await this.persist()
  }

  async clearHistory(agentId: string) {
    await this.ready
    delete this.state.histories[agentId]
    delete this.state.mcpContexts[agentId]
    delete this.state.conversationTokens[agentId]
    delete this.state.tokenHistory[agentId]
    await this.persist()
  }

  async clearAllHistory(agentId: string) {
    await this.ready
    const clearedScopes = this.removeHistoryScopes(agentId)
    await this.persist()
    return clearedScopes
  }

  private removeHistoryScopes(agentId: string) {
    const scopes = new Set<string>()
    for (const records of [this.state.histories, this.state.mcpContexts, this.state.conversationTokens, this.state.tokenHistory]) {
      for (const scope of Object.keys(records)) {
        if (scope === agentId || scope.startsWith(`${agentId}::`)) {
          scopes.add(scope)
          delete records[scope]
        }
      }
    }
    return scopes.size
  }

  private async load() {
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (isRecord(parsed)) {
        this.state = {
          agents: Array.isArray(parsed.agents) ? parsed.agents.filter(isAgentRecord) : [],
          histories: isRecord(parsed.histories) ? Object.fromEntries(Object.entries(parsed.histories).map(([id, messages]) => [id, parseStoredMessages(messages)])) : {},
          mcpContexts: isRecord(parsed.mcpContexts) ? Object.fromEntries(Object.entries(parsed.mcpContexts).map(([id, calls]) => [id, parseStoredMcpContext(calls)])) : {},
          conversationTokens: isRecord(parsed.conversationTokens)
            ? Object.fromEntries(Object.entries(parsed.conversationTokens).flatMap(([id, tokens]) => typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? [[id, Math.floor(tokens)]] : []))
            : {},
          tokenHistory: isRecord(parsed.tokenHistory)
            ? Object.fromEntries(Object.entries(parsed.tokenHistory).map(([id, points]) => [id, parseStoredTokenHistory(points)]))
            : {},
        }
      }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return
      console.warn('Не удалось загрузить сохранённый контекст агентов. Начинаем с пустого состояния.')
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

type RunRequest = {
  input: string
  history: AgentMessage[]
  conversationId?: string
  clientContext?: AgentRuntimeContext
}

/** Safe, request-scoped facts supplied by the client; never arbitrary prompt text. */
export type AgentRuntimeContext = {
  timeZone?: string
}

export class AgentError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'AgentError'
    this.statusCode = statusCode
  }
}

export class LlmClient {
  constructor(private readonly options: AgentServiceOptions) {}

  async complete(messages: AgentMessage[], options: LlmOptions, signal?: AbortSignal): Promise<CompletionResult> {
    const apiResponse = await this.request(messages, options, false, signal)
    const data = await readJson(apiResponse)

    if (!apiResponse.ok) throw this.toError(data, apiResponse.status)

    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.length === 0) {
      throw new AgentError('LLM не вернула текст ответа.', 502)
    }

    return {
      content,
      tokens: data.usage?.completion_tokens,
      promptTokens: data.usage?.prompt_tokens,
      totalTokens: data.usage?.total_tokens,
    }
  }

  async stream(messages: AgentMessage[], options: LlmOptions, onChunk: (content: string) => void): Promise<Partial<CompletionResult>> {
    const apiResponse = await this.request(messages, options, true)
    if (!apiResponse.ok) throw this.toError(await readJson(apiResponse), apiResponse.status)
    if (!apiResponse.body) throw new AgentError('LLM не вернула поток ответа.', 502)

    const reader = apiResponse.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finished = false
    let usage: Record<string, unknown> | undefined

    while (!finished) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') {
          finished = true
          break
        }

        const chunk = parseJson(payload)
        if (isRecord(chunk.usage)) usage = chunk.usage
        const content = chunk.choices?.[0]?.delta?.content
        if (typeof content === 'string' && content.length > 0) onChunk(content)
      }

      if (done) break
    }

    return {
      tokens: readUsageInteger(usage, 'completion_tokens'),
      promptTokens: readUsageInteger(usage, 'prompt_tokens'),
      totalTokens: readUsageInteger(usage, 'total_tokens'),
    }
  }

  private async request(messages: AgentMessage[], options: LlmOptions, stream: boolean, signal?: AbortSignal) {
    const isHuggingFace = options.provider === 'huggingface'
    const isOpenRouter = options.provider === 'openrouter'
    const apiKey = isHuggingFace ? this.options.huggingFaceApiKey : isOpenRouter ? this.options.openRouterApiKey : this.options.deepSeekApiKey
    if (!apiKey) {
      const variable = isHuggingFace ? 'HUGGINGFACE_API_KEY' : isOpenRouter ? 'OPENROUTER_API_KEY' : 'DEEPSEEK_API_KEY'
      throw new AgentError(`Добавьте ${variable} в файл .env и перезапустите сервер.`, 503)
    }

    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      stream,
    }

    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.stopSequences?.length) body.stop = options.stopSequences
    if (options.format === 'json') body.response_format = { type: 'json_object' }
    if (options.provider === 'deepseek') body.thinking = { type: 'disabled' }

    return fetch(
      isHuggingFace ? 'https://router.huggingface.co/v1/chat/completions' : isOpenRouter ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.deepseek.com/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      },
    )
  }

  private toError(data: Record<string, unknown>, status: number) {
    const error = data.error
    const message = typeof error === 'string'
      ? error
      : isRecord(error) && typeof error.message === 'string'
        ? error.message
        : 'LLM вернула ошибку.'
    return new AgentError(message, status >= 400 && status < 500 ? status : 502)
  }
}

export class Agent {
  private contextStrategies?: ContextStrategiesServiceLike
  private memory?: AgentMemory

  constructor(
    readonly id: string,
    readonly config: Required<Pick<AgentConfig, 'provider' | 'model'>> & AgentConfig,
    private readonly client: LlmClient,
    contextStrategies?: ContextStrategiesServiceLike,
    private readonly mcpRuntime?: McpToolRuntime,
    private readonly ragRetriever: RagRetriever = new RagRetriever(),
  ) {
    validateGroundingConfig(config)
    this.contextStrategies = contextStrategies
    if (config.memoryLayers) {
      this.memory = new AgentMemory(config.memoryLayers, async (systemPrompt, input) => {
        const classifierConfig = { provider: config.provider, model: config.model, temperature: 0, outputPolicy: { format: 'json' as const } }
        const completion = await this.client.complete([{ role: 'system', content: systemPrompt }, { role: 'user', content: input }], toLlmOptions(classifierConfig))
        return { output: completion.content, tokenMetrics: createTokenMetrics(classifierConfig, input, completion) }
      }, config.systemPrompt)
    }
  }

  setContextStrategiesService(contextStrategies: ContextStrategiesServiceLike) {
    this.contextStrategies = contextStrategies
  }

  async inspectInputInvariants(input: string) {
    const validatedInput = validateInput(input, this.config.inputPolicy)
    return this.checkInvariants('input', validatedInput)
  }

  async classifyTaskInput(input: string): Promise<TaskInputInterpretation> {
    const state = this.config.taskState
    if (!state) return { intent: 'other' }
    const classifierConfig: Required<Pick<AgentConfig, 'provider' | 'model'>> & AgentConfig = { provider: this.config.provider, model: this.config.model, temperature: 0, maxTokens: 400, outputPolicy: { format: 'json' } }
    try {
      const completion = await this.client.complete([
        { role: 'system', content: taskInputIntentSystemPrompt },
        { role: 'user', content: taskInputIntentInput(state, validateInput(input, this.config.inputPolicy)) },
      ], toLlmOptions(classifierConfig))
      return parseTaskInputInterpretation(completion.content) ?? { intent: 'other' }
    } catch {
      // Failing closed means a classifier outage can never advance the task.
      return { intent: 'other' }
    }
  }

  /**
   * The model may suggest a state change, but it never gets to narrate an
   * impossible one. Validate its structured decision before the answer is
   * stored in memory, passed to a context strategy, or emitted to the UI.
   */
  private resolveTaskOutput(rawOutput: string, input: string) {
    const taskDecision = this.config.taskMachine ? parseTaskDecision(rawOutput) : undefined
    const output = taskDecision?.answer ?? applyOutputPolicy(rawOutput, this.config.outputPolicy)
    const state = this.config.taskState
    if (!taskDecision || !state) return { output, taskDecision }

    const transition = applyTaskDecision(state, taskDecision)
    if (!transition.notice) return { output, taskDecision }
    return {
      output: blockedTaskTransitionMessage(transition.notice, state),
      taskDecision: undefined,
    }
  }

  private async checkInvariants(kind: 'input' | 'output', text: string) {
    const items = activeInvariants(this.config.invariants)
    if (!items.length) return { enabled: false as const }
    const checkConfig: Required<Pick<AgentConfig, 'provider' | 'model'>> & AgentConfig = { provider: this.config.provider, model: this.config.model, temperature: 0, maxTokens: 1_200, outputPolicy: { format: 'json' } }
    try {
      const completion = await this.client.complete([
        { role: 'system', content: invariantCheckSystemPrompt(kind) },
        { role: 'user', content: invariantCheckInput(kind, items, text) },
      ], toLlmOptions(checkConfig))
      const verdict = parseInvariantVerdict(completion.content, new Set(items.map((item) => item.id)))
      if (!verdict) return { enabled: true as const, error: 'Проверяющий инвариантов вернул некорректный результат.', tokenMetrics: createTokenMetrics(checkConfig, text, completion) }
      return { enabled: true as const, verdict, tokenMetrics: createTokenMetrics(checkConfig, text, completion) }
    } catch (error) {
      return { enabled: true as const, error: error instanceof Error ? error.message : 'Не удалось проверить инварианты.' }
    }
  }

  async run(input: string, history: AgentMessage[] = [], summary?: string, contextId = this.id, signal?: AbortSignal, runtimeInstruction?: string, mcpContext: McpToolCall[] = [], clientContext?: AgentRuntimeContext): Promise<AgentRunResult> {
    const validatedInput = validateInput(input, this.config.inputPolicy)
    const startedAt = Date.now()
    const preflight = await this.checkInvariants('input', validatedInput)
    if (preflight.enabled && (!preflight.verdict || preflight.verdict.verdict === 'conflict')) {
      const explanation = preflight.error ?? blockedInvariantMessage(preflight.verdict)
      return this.blockedInvariantResult(validatedInput, explanation, preflight.verdict, 0, preflight.tokenMetrics, startedAt)
    }
    const prepared = this.contextStrategies
      ? await this.contextStrategies.prepareAgentContext(contextId, validatedInput, this.config, history)
      : { config: this.config, history }
    const memory = this.memory ? await this.memory.prepare(prepared.history, validatedInput, { history, summary: prepared.summary ?? summary }) : undefined
    const effectiveConfig = withRuntimeContext(prepared.config, memory?.systemPrompt)
    const ragContext = this.config.rag?.enabled ? await this.ragRetriever.retrieve(validatedInput, this.config.rag, createRagCompletion(this.client, this.config, signal), signal) : undefined
    let grounding: RagResult['grounding']
    const groundedCompletion = async (answerMessages: AgentMessage[]) => {
      grounding = await answerWithGrounding(validatedInput, answerMessages, ragContext!.sources, createRagCompletion(this.client, this.config, signal), signal)
      const content = this.config.outputPolicy?.format === 'json' ? JSON.stringify(grounding) : renderGroundedAnswer(grounding)
      if (this.config.outputPolicy?.maxCharacters !== undefined && content.length > this.config.outputPolicy.maxCharacters) throw new AgentError('Лимит ответа слишком мал для полного ответа с источниками и цитатами. Увеличьте maxCharacters.', 502)
      return { content, tokens: grounding.usage.completionTokens, promptTokens: grounding.usage.promptTokens, totalTokens: grounding.usage.totalTokens }
    }
    const instructions = [runtimeInstruction, ragContext?.instruction].filter(Boolean).join('\n\n') || undefined
    const messages = buildMessages(effectiveConfig, memory?.history ?? prepared.history, validatedInput, prepared.summary ?? summary, instructions)
    const mcpResult = this.config.mcp?.enabled
      ? await this.mcpRuntime?.run({
        // This is the same prepared context used by the normal Agent path.
        // McpToolRuntime is an execution adapter, not a second agent.
        messages,
        verifiedToolContext: mcpContext,
        timeZone: clientContext?.timeZone,
      }, { provider: this.config.provider, model: this.config.model, temperature: this.config.temperature, maxTokens: this.config.maxTokens, servers: this.config.mcp.servers, toolAccess: this.config.mcp.toolAccess, serverToolAccess: this.config.mcp.serverToolAccess })
      : undefined
    if (this.config.mcp?.enabled && !mcpResult) throw new AgentError('MCP включён в конфигурации агента, но MCP runtime не настроен.', 503)
    let completion = ragContext && this.config.rag?.grounding?.enabled
      ? await groundedCompletion(messages)
      : mcpResult
      ? { content: mcpResult.output, tokens: mcpResult.tokens, promptTokens: mcpResult.promptTokens, totalTokens: mcpResult.totalTokens }
      : await this.client.complete(messages, toLlmOptions(this.config), signal)
    let rawOutput = completion.content
    let { output, taskDecision } = this.resolveTaskOutput(rawOutput, validatedInput)
    let tokenMetrics = sumTokenMetrics(preflight.tokenMetrics, ragContext?.trace?.usage, createTokenMetrics(this.config, validatedInput, completion))
    let attempts = 0
    const violatedIds = new Set<string>()
    let postCheck = await this.checkInvariants('output', output)
    tokenMetrics = sumTokenMetrics(tokenMetrics, postCheck.tokenMetrics)
    while (postCheck.enabled && postCheck.verdict?.verdict === 'conflict' && attempts < 2) {
      attempts += 1
      for (const violation of postCheck.verdict.violations) violatedIds.add(violation.invariantId)
      const repairMessages: AgentMessage[] = [...messages, { role: 'system', content: repairInvariantPrompt(activeInvariants(this.config.invariants), postCheck.verdict) }]
      completion = grounding ? await groundedCompletion(repairMessages) : await this.client.complete(repairMessages, toLlmOptions(this.config), signal)
      rawOutput = completion.content
      const repairedTaskOutput = this.resolveTaskOutput(rawOutput, validatedInput)
      output = repairedTaskOutput.output
      taskDecision = repairedTaskOutput.taskDecision
      tokenMetrics = sumTokenMetrics(tokenMetrics, createTokenMetrics(this.config, validatedInput, completion))
      const nextCheck = await this.checkInvariants('output', output)
      tokenMetrics = sumTokenMetrics(tokenMetrics, nextCheck.tokenMetrics)
      const previousIds = [...postCheck.verdict.violations].map((violation) => violation.invariantId).sort().join('|')
      const nextIds = nextCheck.verdict?.verdict === 'conflict' ? nextCheck.verdict.violations.map((violation) => violation.invariantId).sort().join('|') : ''
      postCheck = nextCheck
      if (previousIds === nextIds) break
    }
    if (postCheck.enabled && (!postCheck.verdict || postCheck.verdict.verdict === 'conflict')) {
      if (postCheck.verdict) for (const violation of postCheck.verdict.violations) violatedIds.add(violation.invariantId)
      const explanation = postCheck.error
        ?? (postCheck.verdict ? blockedInvariantMessage(postCheck.verdict, 'Не удалось сформировать ответ, совместимый с инвариантами.') : 'Не удалось безопасно проверить ответ на соответствие инвариантам.')
      return this.blockedInvariantResult(validatedInput, explanation, postCheck.verdict, attempts, tokenMetrics, startedAt, [...violatedIds])
    }
    const invariantCheck: InvariantCheckInfo | undefined = preflight.enabled
      ? { status: attempts > 0 ? 'repaired' : 'passed', attempts, violatedInvariantIds: [...violatedIds] }
      : undefined

    const contextCommit = this.contextStrategies && this.config.contextStrategy
      ? await this.contextStrategies.recordAgentTurn(contextId, this.config, validatedInput, output, tokenMetrics, prepared)
      : {}
    return {
      agentId: this.id,
      input: validatedInput,
      output,
      provider: this.config.provider,
      model: this.config.model,
      durationMs: Date.now() - startedAt,
      tokens: tokenMetrics.completionTokens,
      promptTokens: tokenMetrics.promptTokens,
      totalTokens: tokenMetrics.totalTokens,
      tokenMetrics,
      ...(memory ? { memory: memory.snapshot } : {}),
      ...(memory?.classifierTokenMetrics ? { memoryClassifierTokenMetrics: memory.classifierTokenMetrics } : {}),
      ...(memory?.autoUpdate ? { autoMemoryUpdate: memory.autoUpdate } : {}),
      ...(prepared.summaryTokenMetrics ? { summaryTokenMetrics: prepared.summaryTokenMetrics } : {}),
      ...(prepared.context ? { context: prepared.context } : {}),
      ...(contextCommit.archiveHistory ? { archiveHistory: true } : {}),
      ...(prepared.strategyTokenMetrics ? { strategyTokenMetrics: prepared.strategyTokenMetrics } : {}),
      ...(prepared.strategyError ? { strategyError: prepared.strategyError } : {}),
      ...(taskDecision ? { taskDecision } : {}),
      ...(invariantCheck ? { invariantCheck } : {}),
      ...(mcpResult?.toolCalls.length ? { mcpToolCalls: mcpResult.toolCalls } : {}),
      ...(ragContext ? { rag: { indexRunId: ragContext.indexRunId, sources: ragContext.sources, trace: ragContext.trace, ...(grounding ? { grounding } : {}) } } : {}),
    }
  }

  private blockedInvariantResult(input: string, output: string, verdict: InvariantVerdict | undefined, attempts: number, tokenMetrics: AgentTokenMetrics | undefined, startedAt: number, violatedInvariantIds = verdict?.violations.map((violation) => violation.invariantId) ?? []): AgentRunResult {
    const metrics = tokenMetrics ?? { inputTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    return {
      agentId: this.id,
      input,
      output,
      provider: this.config.provider,
      model: this.config.model,
      durationMs: Date.now() - startedAt,
      tokens: metrics.completionTokens,
      promptTokens: metrics.promptTokens,
      totalTokens: metrics.totalTokens,
      tokenMetrics: metrics,
      invariantCheck: {
        status: 'blocked',
        attempts,
        violatedInvariantIds,
        explanation: output,
        ...(verdict?.safeDirection ? { safeDirection: verdict.safeDirection } : {}),
      },
    }
  }

  async stream(input: string, history: AgentMessage[], onChunk: (content: string) => void, summary?: string, contextId = this.id, mcpContext: McpToolCall[] = [], clientContext?: AgentRuntimeContext): Promise<AgentRunResult> {
    if (activeInvariants(this.config.invariants).length || this.config.mcp?.enabled || (this.config.rag?.enabled && this.config.rag.grounding?.enabled)) {
      const result = await this.run(input, history, summary, contextId, undefined, runtimeContextInstruction(clientContext), mcpContext, clientContext)
      onChunk(result.output)
      return result
    }
    const validatedInput = validateInput(input, this.config.inputPolicy)
    const startedAt = Date.now()
    const prepared = this.contextStrategies
      ? await this.contextStrategies.prepareAgentContext(contextId, validatedInput, this.config, history)
      : { config: this.config, history }
    const memory = this.memory ? await this.memory.prepare(prepared.history, validatedInput, { history, summary: prepared.summary ?? summary }) : undefined
    const effectiveConfig = withRuntimeContext(prepared.config, memory?.systemPrompt)
    const ragContext = this.config.rag?.enabled ? await this.ragRetriever.retrieve(validatedInput, this.config.rag, createRagCompletion(this.client, this.config)) : undefined
    const messages = buildMessages(effectiveConfig, memory?.history ?? prepared.history, validatedInput, prepared.summary ?? summary, ragContext?.instruction)
    let streamedOutput = ''
    let emittedOutput = ''

    const completion = await this.client.stream(messages, toLlmOptions(this.config), (content) => {
      streamedOutput += content
      const visibleOutput = applyOutputCharacterLimit(streamedOutput, this.config.outputPolicy?.maxCharacters)
      const delta = visibleOutput.slice(emittedOutput.length)
      if (delta) onChunk(delta)
      emittedOutput = visibleOutput
    })

    const taskDecision = this.config.taskMachine ? parseTaskDecision(streamedOutput) : undefined
    const output = taskDecision?.answer ?? applyOutputPolicy(streamedOutput, this.config.outputPolicy)
    const tokenMetrics = sumTokenMetrics(ragContext?.trace?.usage, createTokenMetrics(this.config, validatedInput, completion))

    const contextCommit = this.contextStrategies && this.config.contextStrategy
      ? await this.contextStrategies.recordAgentTurn(contextId, this.config, validatedInput, output, tokenMetrics, prepared)
      : {}
    return {
      agentId: this.id,
      input: validatedInput,
      output,
      provider: this.config.provider,
      model: this.config.model,
      durationMs: Date.now() - startedAt,
      tokenMetrics,
      tokens: tokenMetrics.completionTokens,
      promptTokens: tokenMetrics.promptTokens,
      totalTokens: tokenMetrics.totalTokens,
      ...(memory ? { memory: memory.snapshot } : {}),
      ...(memory?.classifierTokenMetrics ? { memoryClassifierTokenMetrics: memory.classifierTokenMetrics } : {}),
      ...(memory?.autoUpdate ? { autoMemoryUpdate: memory.autoUpdate } : {}),
      ...(prepared.summaryTokenMetrics ? { summaryTokenMetrics: prepared.summaryTokenMetrics } : {}),
      ...(prepared.context ? { context: prepared.context } : {}),
      ...(contextCommit.archiveHistory ? { archiveHistory: true } : {}),
      ...(prepared.strategyTokenMetrics ? { strategyTokenMetrics: prepared.strategyTokenMetrics } : {}),
      ...(prepared.strategyError ? { strategyError: prepared.strategyError } : {}),
      ...(taskDecision ? { taskDecision } : {}),
      ...(ragContext ? { rag: { indexRunId: ragContext.indexRunId, sources: ragContext.sources, trace: ragContext.trace } } : {}),
    }
  }

}

export class AgentService {
  private readonly agents = new Map<string, Agent>()
  private readonly createdAt = new Map<string, string>()
  private readonly client: LlmClient
  private readonly defaultDeepSeekModel: string
  private readonly stateStore: AgentStateStore
  private contextStrategies?: ContextStrategiesServiceLike
  private readonly mcpRuntime?: McpToolRuntime
  private readonly activeTaskRuns = new Map<string, AbortController>()
  readonly ready: Promise<void>

  constructor(options: AgentServiceOptions & { mcpRuntime?: McpToolRuntime }) {
    this.client = new LlmClient(options)
    this.defaultDeepSeekModel = options.defaultDeepSeekModel
    this.mcpRuntime = options.mcpRuntime
    this.stateStore = new AgentStateStore()
    const defaultConfig = normalizeAgentConfig({
      name: 'Основной агент',
      provider: 'deepseek',
      model: options.defaultDeepSeekModel,
      systemPrompt: 'Ты — самостоятельный AI-агент. Отвечай понятно, по существу и на языке пользователя.',
    }, options.defaultDeepSeekModel)
    this.register('default', defaultConfig, new Date().toISOString())
    this.ready = this.restore()
  }

  get count() {
    return this.agents.size
  }

  setContextStrategiesService(contextStrategies: ContextStrategiesServiceLike) {
    this.contextStrategies = contextStrategies
    for (const agent of this.agents.values()) agent.setContextStrategiesService(contextStrategies)
  }

  async create(input: { id?: unknown; config: unknown }) {
    await this.ready
    const id = normalizeAgentId(input.id)
    if (this.agents.has(id)) throw new AgentError(`Агент с id "${id}" уже существует.`, 409)
    const config = normalizeAgentConfig(input.config, this.defaultDeepSeekModel)
    this.register(id, config, new Date().toISOString())
    await this.persistAgents()
    return this.describe(this.agents.get(id)!)
  }

  async createMany(inputs: Array<{ id?: unknown; config: unknown }>) {
    await this.ready
    const ids = new Set<string>()
    const prepared = inputs.map((input) => {
      const id = normalizeAgentId(input.id)
      if (this.agents.has(id) || ids.has(id)) throw new AgentError(`Агент с id "${id}" уже существует.`, 409)
      ids.add(id)
      return { id, config: normalizeAgentConfig(input.config, this.defaultDeepSeekModel) }
    })

    for (const item of prepared) this.register(item.id, item.config, new Date().toISOString())
    await this.persistAgents()
    return prepared.map(({ id }) => this.describe(this.agents.get(id)!))
  }

  async update(id: string, config: AgentConfig) {
    await this.ready
    this.get(id)
    this.register(id, normalizeAgentConfig(config, this.defaultDeepSeekModel), this.createdAt.get(id) ?? new Date().toISOString())
    await this.persistAgents()
    return this.describe(this.agents.get(id)!)
  }

  async getInvariants(id: string) {
    await this.ready
    const invariants = this.get(id).config.invariants
    return invariants ?? { enabled: false, items: [] }
  }

  async updateInvariants(id: string, invariants: unknown) {
    await this.ready
    const agent = this.get(id)
    if (!isRecord(invariants) || !('invariants' in invariants)) throw new AgentError('Передайте объект { invariants: { enabled, items } }.')
    const nextConfig = normalizeAgentConfig({ ...agent.config, invariants: invariants.invariants }, this.defaultDeepSeekModel)
    this.register(id, nextConfig, this.createdAt.get(id) ?? new Date().toISOString())
    await this.persistAgents()
    return this.get(id).config.invariants ?? { enabled: false, items: [] }
  }

  list() {
    return [...this.agents.values()].map((agent) => this.describe(agent))
  }

  get(id: string) {
    const agent = this.agents.get(id)
    if (!agent) throw new AgentError(`Агент "${id}" не найден.`, 404)
    return agent
  }

  async remove(id: string) {
    await this.ready
    if (id === 'default') throw new AgentError('Встроенного агента default удалить нельзя.', 400)
    if (!this.agents.delete(id)) throw new AgentError(`Агент "${id}" не найден.`, 404)
    this.createdAt.delete(id)
    await this.stateStore.removeAgent(id)
    if (this.contextStrategies?.resetAgentContext) await this.contextStrategies.resetAgentContext(id)
  }

  async getHistory(id: string) {
    await this.ready
    this.get(id)
    return this.stateStore.getHistory(id)
  }

  async getConversationTokens(id: string) {
    await this.ready
    this.get(id)
    return this.stateStore.getConversationTokens(id)
  }

  async getTokenHistory(id: string) {
    await this.ready
    this.get(id)
    return this.stateStore.getTokenHistory(id)
  }

  async getContextInfo(id: string) {
    await this.ready
    const agent = this.get(id)
    const history = await this.stateStore.getHistory(id)
    const activeHistory = history.filter((message) => !message.archived)
    return this.contextStrategies?.getAgentContextInfo
      ? this.contextStrategies.getAgentContextInfo(id, agent.config, activeHistory)
      : createContextInfo(agent.config, activeHistory, undefined, 0, 0)
  }

  async clearHistory(id: string) {
    await this.ready
    this.get(id)
    await this.stateStore.clearHistory(id)
  }

  async clearAllHistory(id: string) {
    await this.ready
    this.get(id)
    const clearedScopes = await this.stateStore.clearAllHistory(id)
    if (this.contextStrategies?.resetAgentContext) await this.contextStrategies.resetAgentContext(id)
    return { agentId: id, clearedScopes }
  }

  async getContextStrategyState(id: string) {
    await this.ready
    const agent = this.get(id)
    return this.contextStrategies?.getAgentContext
      ? this.contextStrategies.getAgentContext(id, agent.config)
      : { configured: false }
  }

  async resetContextStrategyState(id: string) {
    await this.ready
    this.get(id)
    return this.contextStrategies?.resetAgentContext
      ? this.contextStrategies.resetAgentContext(id)
      : { configured: false }
  }

  async setContextStrategyWindow(id: string, value: unknown) {
    await this.ready
    const agent = this.get(id)
    if (!agent.config.contextStrategy) throw new AgentError('У агента не настроена стратегия контекста.')
    const nextWindow = this.contextStrategies?.setAgentWindowSize
      ? await this.contextStrategies.setAgentWindowSize(id, value, agent.config)
      : { configured: false }
    const nextConfig = { ...agent.config, contextStrategy: { ...agent.config.contextStrategy, windowSize: (nextWindow as { windowSize?: number }).windowSize ?? agent.config.contextStrategy.windowSize } }
    this.register(id, normalizeAgentConfig(nextConfig, this.defaultDeepSeekModel), this.createdAt.get(id) ?? new Date().toISOString())
    await this.persistAgents()
    return nextWindow
  }

  async createContextStrategyCheckpoint(id: string) {
    await this.ready
    this.get(id)
    return this.contextStrategies?.createAgentCheckpoint
      ? this.contextStrategies.createAgentCheckpoint(id)
      : { configured: false }
  }

  async activateContextStrategyBranch(id: string, branchId: unknown) {
    await this.ready
    this.get(id)
    return this.contextStrategies?.activateAgentBranch
      ? this.contextStrategies.activateAgentBranch(id, branchId)
      : { configured: false }
  }

  async getTaskState(id: string) {
    await this.ready
    const state = this.get(id).config.taskState
    if (!state) throw new AgentError('У агента не настроено состояние задачи.', 404)
    return state
  }

  async getTaskHistory(id: string) {
    await this.ready
    const state = this.get(id).config.taskState
    return state ? this.stateStore.getHistory(taskScopeId(id, state)) : []
  }

  async resetTask(id: string) {
    await this.ready
    const agent = this.get(id)
    const previous = agent.config.taskState
    if (previous) {
      const scope = taskScopeId(id, previous)
      await this.stateStore.clearHistory(scope)
      if (this.contextStrategies?.resetAgentContext) await this.contextStrategies.resetAgentContext(scope)
    }
    const memory = agent.config.memoryLayers
    this.register(id, normalizeAgentConfig({ ...agent.config, taskState: undefined, memoryLayers: memory ? { ...memory, working: [] } : undefined }, this.defaultDeepSeekModel), this.createdAt.get(id) ?? new Date().toISOString())
    await this.persistAgents()
    return { reset: true }
  }

  async transitionTaskState(id: string, input: unknown) {
    await this.ready
    const agent = this.get(id)
    const body = isRecord(input) ? input : {}
    const action = body.action
    const current = agent.config.taskState
    let next: AgentTaskState
    if (action === 'start') {
      const task = readString(body.task, 4_000)
      const currentStep = readString(body.currentStep, 2_000)
      const expectedAction = readString(body.expectedAction, 2_000)
      if (!task || !currentStep || !expectedAction) throw new AgentError('Для старта укажите задачу, текущий шаг и ожидаемое действие.')
      next = { ...newTaskState(task), currentStep, expectedAction }
    } else {
      if (!current) throw new AgentError('Сначала запустите задачу.')
      if (action === 'pause') next = { ...current, status: 'paused', updatedAt: new Date().toISOString() }
      else if (action === 'resume') {
        if (current.stage === 'done') throw new AgentError('Завершённую задачу нельзя продолжить: создайте новую.')
        next = { ...current, status: 'active', updatedAt: new Date().toISOString() }
      } else if (action === 'update') {
        const currentStep = readString(body.currentStep, 2_000)
        const expectedAction = readString(body.expectedAction, 2_000)
        if (!currentStep || !expectedAction) throw new AgentError('Укажите текущий шаг и ожидаемое действие.')
        next = { ...current, currentStep, expectedAction, updatedAt: new Date().toISOString() }
      } else throw new AgentError('Неизвестное действие состояния задачи.')
    }
    if (action === 'start' && current) {
      const previousScope = taskScopeId(id, current)
      await this.stateStore.clearHistory(previousScope)
      if (this.contextStrategies?.resetAgentContext) await this.contextStrategies.resetAgentContext(previousScope)
    }
    const memory = action === 'start' && agent.config.memoryLayers ? { ...agent.config.memoryLayers, working: [] } : agent.config.memoryLayers
    this.register(id, normalizeAgentConfig({ ...agent.config, taskState: next, memoryLayers: memory }, this.defaultDeepSeekModel), this.createdAt.get(id) ?? new Date().toISOString())
    await this.persistAgents()
    if (action === 'pause' && current) this.activeTaskRuns.get(taskScopeId(id, current))?.abort()
    return this.get(id).config.taskState!
  }

  async run(id: string, input: string, providedHistory: AgentMessage[] = [], onTaskEvent?: (event: AgentTaskRunEvent) => void, conversationId?: string, clientContext?: AgentRuntimeContext) {
    await this.ready
    let agent = this.get(id)
    if (agent.config.taskMachine && !agent.config.taskState) {
      // Do not persist a task whose very objective violates a hard rule.
      // Agent.run will return the same safe refusal and append it to the normal
      // agent history, but there is intentionally no taskState to continue.
      const initialGuard = await agent.inspectInputInvariants(input)
      if (initialGuard.enabled && (!initialGuard.verdict || initialGuard.verdict.verdict === 'conflict')) {
        const result = await agent.run(input, providedHistory, undefined, id)
        onTaskEvent?.({ content: result.output, ...(result.invariantCheck ? { invariantCheck: result.invariantCheck } : {}) })
        return result
      }
      const state = newTaskState(validateInput(input, agent.config.inputPolicy))
      const memory = agent.config.memoryLayers ? { ...agent.config.memoryLayers, working: [] } : undefined
      this.register(id, normalizeAgentConfig({ ...agent.config, taskState: state, memoryLayers: memory }, this.defaultDeepSeekModel), this.createdAt.get(id) ?? new Date().toISOString())
      await this.persistAgents()
      agent = this.get(id)
    }
    if (agent.config.taskState?.status === 'paused') throw new AgentError('Задача на паузе. Продолжите её перед новым сообщением.', 409)
    const scope = agent.config.taskState ? taskScopeId(id, agent.config.taskState) : conversationId ? conversationScopeId(id, conversationId) : id
    const storedHistory = await this.stateStore.getHistory(scope)
    const mcpContext = await this.stateStore.getMcpContext(scope)
    const activeHistory = storedHistory.filter((message) => !message.archived)
    const sourceHistory = activeHistory.length > 0 ? activeHistory : providedHistory
    const initialState = agent.config.taskState
    const initialStage = initialState?.stage
    const isInternalContinuation = input.startsWith('ВНУТРЕННЕЕ ПРОДОЛЖЕНИЕ')
    // Validation feedback is normally a command for the state machine. Check it
    // before applying that command so a conflicting requested change cannot
    // silently move validation back into execution.
    const inputGuard = initialState?.stage === 'validation' ? await agent.inspectInputInvariants(input) : undefined
    const invariantBlocked = inputGuard?.enabled === true && (!inputGuard.verdict || inputGuard.verdict.verdict === 'conflict')
    const inputIntent: TaskInputInterpretation = !invariantBlocked && !isInternalContinuation
      ? await agent.classifyTaskInput(input)
      : { intent: 'other' as const }
    const userTransition = invariantBlocked
      ? undefined
      : initialState?.stage === 'planning' && inputIntent.intent === 'approve_plan'
        ? { answer: '', nextStage: 'execution' as const, currentStep: 'Выполнить согласованный план и подготовить результат.', expectedAction: 'Агент выполняет работу и передаёт готовый результат на проверку.' }
        : initialState?.stage === 'validation'
          ? inputIntent.intent === 'approve_result'
            ? { answer: '', nextStage: 'done' as const, currentStep: 'Результат принят пользователем.', expectedAction: 'Задача завершена.' }
            : inputIntent.intent === 'request_revision'
              ? { answer: '', nextStage: 'execution' as const, currentStep: `Исправить замечание пользователя: ${input}`.slice(0, 2_000), expectedAction: 'Агент вносит правки и передаёт обновлённый результат на проверку.' }
              : undefined
          : undefined
    const requestedStageConflict = Boolean(initialState && inputIntent.requestedStage && inputIntent.requestedStage !== initialState.stage && inputIntent.requestedStage !== userTransition?.nextStage)
    const bypassDecision = initialState && (inputIntent.intent === 'attempt_bypass' || requestedStageConflict)
      ? {
          answer: '',
          currentStep: initialState.stage === 'planning' ? 'Составить и согласовать план работы.' : initialState.currentStep,
          expectedAction: initialState.stage === 'planning' ? 'Попросить агента подготовить план, затем явно подтвердить его.' : initialState.expectedAction,
        }
      : undefined
    // Подтверждения и замечания на этапах, где ожидается пользователь, — это
    // команды state machine. Не отправляем их сначала в модель: иначе она
    // успевает выдать промежуточный ответ, а затем execution выдаёт второй.
    const transitionOutput = initialState?.stage === 'planning'
      ? 'План подтверждён. Начинаю выполнение согласованного плана.'
      : initialState?.stage === 'validation' && userTransition?.nextStage === 'done'
        ? 'Результат принят. Задача завершена.'
        : initialState?.stage === 'validation'
          ? 'Правка принята. Перехожу к execution и готовлю полную обновлённую версию результата.'
          : ''
    const result: AgentRunResult = invariantBlocked
      ? {
          agentId: agent.id,
          input: validateInput(input, agent.config.inputPolicy),
          output: blockedInvariantMessage(inputGuard?.verdict),
          provider: agent.config.provider,
          model: agent.config.model,
          durationMs: 0,
          tokenMetrics: { inputTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          invariantCheck: {
            status: 'blocked',
            attempts: 0,
            violatedInvariantIds: inputGuard?.verdict?.violations.map((violation) => violation.invariantId) ?? [],
            explanation: blockedInvariantMessage(inputGuard?.verdict),
            ...(inputGuard?.verdict?.safeDirection ? { safeDirection: inputGuard.verdict.safeDirection } : {}),
          },
        }
      : userTransition
      ? {
          agentId: agent.id,
          input: validateInput(input, agent.config.inputPolicy),
          output: transitionOutput,
          provider: agent.config.provider,
          model: agent.config.model,
          durationMs: 0,
          tokenMetrics: { inputTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }
      : bypassDecision
        ? {
            agentId: agent.id,
            input: validateInput(input, agent.config.inputPolicy),
            output: requestedStageConflict && inputIntent.requestedStage ? blockedRequestedStageMessage(initialState!, inputIntent.requestedStage) : blockedLifecycleBypassMessage(initialState!),
            provider: agent.config.provider,
            model: agent.config.model,
            durationMs: 0,
            tokenMetrics: { inputTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          }
      : await agent.run(input, sourceHistory, undefined, scope, undefined, [
        runtimeContextInstruction(clientContext),
        inputIntent.intent === 'request_plan_revision'
          ? 'Пользователь запросил правки к плану. Верни полный обновлённый план целиком: включи все прежние релевантные пункты и внесённые изменения. Не ограничивайся описанием правок, не начинай execution и в конце попроси утвердить обновлённый план.'
          : undefined,
      ].filter(Boolean).join('\n\n') || undefined, mcpContext, clientContext)
    const authorization: TaskTransitionAuthorization = {
      planApproved: inputIntent.intent === 'approve_plan',
      resultApproved: inputIntent.intent === 'approve_result',
      revisionRequested: inputIntent.intent === 'request_revision',
    }
    let taskUpdate = await this.applyTaskDecision(id, userTransition ?? bypassDecision ?? result.taskDecision, authorization)
    if (result.autoMemoryUpdate) await this.persistAutoMemory(id, result.autoMemoryUpdate)
    if (result.mcpToolCalls?.length) await this.stateStore.replaceMcpContext(scope, result.mcpToolCalls)
    if (result.archiveHistory) {
      await this.stateStore.archiveActiveHistory(scope)
    }
    let contextMessages = await this.stateStore.appendHistory(scope, [
      ...(isInternalContinuation ? [] : [{ role: 'user' as const, content: result.input }]),
      { role: 'assistant', content: result.output },
    ])
    let conversationTokens = await this.stateStore.addConversationTokens(scope, result.tokenMetrics, result.summaryTokenMetrics?.totalTokens ?? 0, result.strategyTokenMetrics, result.memoryClassifierTokenMetrics)
    onTaskEvent?.({ content: result.output, taskState: taskUpdate?.state ?? this.get(id).config.taskState, ...(result.invariantCheck ? { invariantCheck: result.invariantCheck } : {}) })

    // Execution belongs to the agent. After a transition into it, run a bounded
    // internal loop until the agent itself reaches validation.
    const stateChanged = initialStage !== undefined && taskUpdate?.state.stage !== initialStage
    const shouldAutoRun = stateChanged || (isInternalContinuation && initialState?.expectedActor === 'agent')
    let automaticSteps = 0
    while (shouldAutoRun && !taskUpdate?.notice && taskUpdate?.state.status === 'active' && taskUpdate.state.expectedActor === 'agent' && automaticSteps < 4) {
      const beforeContinuation = taskUpdate.state
      const continuationAgent = this.get(id)
      const continuationHistory = (await this.stateStore.getHistory(scope)).filter((message) => !message.archived)
      const continuationMcpContext = await this.stateStore.getMcpContext(scope)
      const continuationInput = `ВНУТРЕННЕЕ ПРОДОЛЖЕНИЕ: выполни шаг «${beforeContinuation.currentStep}» на этапе execution. Не жди подтверждения пользователя. Если результат задачи готов, сам переведи её в validation и покажи пользователю полное самостоятельное решение с учётом всех правок; не ограничивайся списком изменённых мест. Иначе опиши выполненную часть и следующий конкретный шаг execution.`
      const controller = new AbortController()
      this.activeTaskRuns.set(scope, controller)
      try {
        const continuation = await continuationAgent.run(continuationInput, continuationHistory, undefined, scope, controller.signal, runtimeContextInstruction(clientContext), continuationMcpContext, clientContext)
        const completionDecision = continuation.invariantCheck?.status === 'blocked'
          ? {
              answer: '',
              nextStage: 'planning' as const,
              currentStep: 'Уточнить требования, конфликтующие с инвариантами.',
              expectedAction: 'Пользователь корректирует требование в рамках активных инвариантов, затем подтверждает обновлённый план.',
            }
          : continuation.taskDecision ?? { answer: '', nextStage: 'validation' as const, currentStep: 'Проверить готовый результат.', expectedAction: 'Пользователь проверяет результат: принимает его или указывает правки.' }
        const continuationUpdate = await this.applyTaskDecision(id, completionDecision)
        if (continuation.autoMemoryUpdate) await this.persistAutoMemory(id, continuation.autoMemoryUpdate)
        if (continuation.mcpToolCalls?.length) await this.stateStore.replaceMcpContext(scope, continuation.mcpToolCalls)
        if (continuation.archiveHistory) await this.stateStore.archiveActiveHistory(scope)
        contextMessages = await this.stateStore.appendHistory(scope, [{ role: 'assistant', content: continuation.output }])
        conversationTokens = await this.stateStore.addConversationTokens(scope, continuation.tokenMetrics, continuation.summaryTokenMetrics?.totalTokens ?? 0, continuation.strategyTokenMetrics, continuation.memoryClassifierTokenMetrics)
        onTaskEvent?.({ content: continuation.output, taskState: continuationUpdate?.state ?? this.get(id).config.taskState, ...(continuation.invariantCheck ? { invariantCheck: continuation.invariantCheck } : {}) })
        automaticSteps += 1
        if (!continuationUpdate) break
        taskUpdate = continuationUpdate
        const unchanged = taskUpdate.state.stage === beforeContinuation.stage && taskUpdate.state.currentStep === beforeContinuation.currentStep && taskUpdate.state.expectedAction === beforeContinuation.expectedAction
        if (unchanged) break
      } catch (error) {
        const latestState = this.get(id).config.taskState
        taskUpdate = latestState?.status === 'paused'
          ? { state: latestState }
          : { state: beforeContinuation, notice: error instanceof Error ? `Не удалось автоматически продолжить execution: ${error.message}` : 'Не удалось автоматически продолжить execution.' }
        break
      } finally {
        if (this.activeTaskRuns.get(scope) === controller) this.activeTaskRuns.delete(scope)
      }
    }
    if (automaticSteps === 4 && taskUpdate?.state.expectedActor === 'agent') taskUpdate = { state: taskUpdate.state, notice: 'Автоматическое выполнение остановлено после 4 шагов, чтобы избежать бесконечного цикла.' }
    const tokenHistory = await this.stateStore.getTokenHistory(scope)
    return { ...result, contextMessages, conversationTokens, tokenHistory, ...(taskUpdate?.state ? { taskState: taskUpdate.state } : {}), ...(taskUpdate?.notice ? { taskNotice: taskUpdate.notice } : {}) }
  }

  async stream(id: string, input: string, providedHistory: AgentMessage[], onChunk: (content: string) => void, conversationId?: string, clientContext?: AgentRuntimeContext) {
    await this.ready
    const agent = this.get(id)
    if (agent.config.taskState?.status === 'paused') throw new AgentError('Задача на паузе. Продолжите её перед новым сообщением.', 409)
    const scope = agent.config.taskState ? taskScopeId(id, agent.config.taskState) : conversationId ? conversationScopeId(id, conversationId) : id
    const storedHistory = await this.stateStore.getHistory(scope)
    const mcpContext = await this.stateStore.getMcpContext(scope)
    const activeHistory = storedHistory.filter((message) => !message.archived)
    const sourceHistory = activeHistory.length > 0 ? activeHistory : providedHistory
    const result = await agent.stream(input, sourceHistory, onChunk, undefined, scope, mcpContext, clientContext)
    if (result.autoMemoryUpdate) await this.persistAutoMemory(id, result.autoMemoryUpdate)
    if (result.mcpToolCalls?.length) await this.stateStore.replaceMcpContext(scope, result.mcpToolCalls)
    if (result.archiveHistory) {
      await this.stateStore.archiveActiveHistory(scope)
    }
    const contextMessages = await this.stateStore.appendHistory(scope, [
      { role: 'user', content: result.input },
      { role: 'assistant', content: result.output },
    ])
    const conversationTokens = await this.stateStore.addConversationTokens(scope, result.tokenMetrics, result.summaryTokenMetrics?.totalTokens ?? 0, result.strategyTokenMetrics, result.memoryClassifierTokenMetrics)
    const tokenHistory = await this.stateStore.getTokenHistory(scope)
    return { ...result, contextMessages, conversationTokens, tokenHistory }
  }

  private async applyTaskDecision(id: string, decision?: TaskDecision, authorization?: TaskTransitionAuthorization) {
    const agent = this.get(id)
    const state = agent.config.taskState
    if (!state || !decision) return undefined
    const applied = applyTaskDecision(state, decision, authorization)
    this.register(id, normalizeAgentConfig({ ...agent.config, taskState: applied.state }, this.defaultDeepSeekModel), this.createdAt.get(id) ?? new Date().toISOString())
    await this.persistAgents()
    return applied
  }

  async runEphemeral(input: string, config: AgentConfig, history: AgentMessage[], useContextStrategies = true) {
    await this.ready
    const normalizedConfig = normalizeAgentConfig(config, this.defaultDeepSeekModel)
    const agent = new Agent('context-demo', normalizedConfig, this.client, useContextStrategies ? this.contextStrategies : undefined)
    return agent.run(input, history)
  }

  /** Runs an active saved profile without adding a turn or changing its memory. */
  async previewProfile(id: string, input: string, profileId: unknown) {
    await this.ready
    const agent = this.get(id)
    const profiles = agent.config.personalization?.profiles ?? []
    if (typeof profileId !== 'string' || !profiles.some((profile) => profile.id === profileId)) {
      throw new AgentError('Профиль для сравнения не найден.')
    }
    const config = normalizeAgentConfig({
      ...agent.config,
      personalization: { ...agent.config.personalization, activeProfileId: profileId },
    }, this.defaultDeepSeekModel)
    return new Agent(`${id}-preview`, config, this.client).run(input, [])
  }

  async compareCompression(input: string, history: AgentMessage[], summarizeAfterMessages = 10) {
    await this.ready
    const baseConfig: AgentConfig = {
      name: 'Сравнение сжатия',
      provider: 'deepseek',
      model: this.defaultDeepSeekModel,
      systemPrompt: 'Отвечай по существу, учитывай все факты из контекста и не упоминай техническое устройство истории.',
    }
    const withoutCompression = new Agent('without-compression', normalizeAgentConfig(baseConfig, this.defaultDeepSeekModel), this.client, this.contextStrategies)
    const withCompression = new Agent('with-compression', normalizeAgentConfig({
      ...baseConfig,
      contextStrategy: { strategy: 'summary', summarizeAfterMessages },
    }, this.defaultDeepSeekModel), this.client, this.contextStrategies)
    if (this.contextStrategies?.resetAgentContext) await this.contextStrategies.resetAgentContext('with-compression')
    const [withoutResult, withResult] = await Promise.all([
      withoutCompression.run(input, history),
      withCompression.run(input, history),
    ])
    if (!withResult.summaryTokenMetrics || !withResult.context?.summary) throw new AgentError('Подготовленный сценарий не достиг порога сжатия.', 500)
    const compressedTotalTokens = withResult.summaryTokenMetrics.totalTokens + withResult.tokenMetrics.totalTokens

    return {
      withoutCompression: { ...withoutResult, totalTokensWithSummary: withoutResult.tokenMetrics.totalTokens },
      withCompression: {
        ...withResult,
        totalTokensWithSummary: compressedTotalTokens,
        summaryTokens: withResult.summaryTokenMetrics.totalTokens,
        summary: withResult.context.summary,
        summarizedMessages: withResult.context.summarizedMessages,
      },
    }
  }

  private register(id: string, config: Required<Pick<AgentConfig, 'provider' | 'model'>> & AgentConfig, createdAt: string) {
    this.agents.set(id, new Agent(id, config, this.client, this.contextStrategies, this.mcpRuntime))
    this.createdAt.set(id, createdAt)
  }

  private async persistAutoMemory(id: string, update: AutoMemoryUpdate) {
    const agent = this.get(id)
    const memory = agent.config.memoryLayers
    if (!memory || memory.mode !== 'auto') return
    const nextConfig = {
      ...agent.config,
      memoryLayers: {
        ...memory,
        working: update.working,
        longTerm: update.longTerm,
      },
    }
    this.register(id, nextConfig, this.createdAt.get(id) ?? new Date().toISOString())
    await this.persistAgents()
  }

  private async persistAgents() {
    await this.stateStore.replaceAgents([...this.agents.values()].map((agent) => ({
      id: agent.id,
      config: agent.config,
      createdAt: this.createdAt.get(agent.id) ?? new Date().toISOString(),
    })))
  }

  private async restore() {
    const savedAgents = await this.stateStore.getAgents()
    if (savedAgents.length === 0) {
      await this.persistAgents()
      return
    }

    for (const savedAgent of savedAgents) {
      this.register(savedAgent.id, normalizeAgentConfig(savedAgent.config, this.defaultDeepSeekModel), savedAgent.createdAt)
    }
  }

  private describe(agent: Agent) {
    return { id: agent.id, config: agent.config, createdAt: this.createdAt.get(agent.id) }
  }
}

export function createAgentRouter(service: AgentService): Router {
  const router = express.Router()

  router.get('/', async (_request, response) => {
    await service.ready
    response.json({ agents: service.list(), count: service.count })
  })

  router.get('/:agentId', async (request, response) => {
    try {
      await service.ready
      response.json(service.list().find((agent) => agent.id === request.params.agentId) ?? throwNotFound(request.params.agentId))
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.post('/', async (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {}
      const created = await service.create({ id: body.id, config: body.config ?? body })
      response.status(201).json(created)
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.put('/:agentId', async (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {}
      response.json(await service.update(request.params.agentId, body.config ?? body))
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.get('/:agentId/invariants', async (request, response) => {
    try {
      response.json(await service.getInvariants(request.params.agentId))
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.put('/:agentId/invariants', async (request, response) => {
    try {
      response.json(await service.updateInvariants(request.params.agentId, request.body))
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.post('/bulk', async (request, response) => {
    try {
      const rawAgents = Array.isArray(request.body) ? request.body : isRecord(request.body) ? request.body.agents : undefined
      if (!Array.isArray(rawAgents) || rawAgents.length === 0) throw new AgentError('Передайте непустой массив agents.')
      const entries = rawAgents.map((item) => {
        const body = isRecord(item) ? item : {}
        return { id: body.id, config: body.config ?? body }
      })
      response.status(201).json({ agents: await service.createMany(entries) })
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.get('/:agentId/context', async (request, response) => {
    try {
      response.json(await service.getContextStrategyState(request.params.agentId))
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.post('/:agentId/context/reset', async (request, response) => {
    try {
      response.json(await service.resetContextStrategyState(request.params.agentId))
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.post('/:agentId/context/window', async (request, response) => {
    try {
      response.json(await service.setContextStrategyWindow(request.params.agentId, request.body?.windowSize))
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.post('/:agentId/context/checkpoint', async (request, response) => {
    try {
      response.json(await service.createContextStrategyCheckpoint(request.params.agentId))
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.post('/:agentId/context/active-branch', async (request, response) => {
    try {
      response.json(await service.activateContextStrategyBranch(request.params.agentId, request.body?.branchId))
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.get('/:agentId/task-state', async (request, response) => {
    try {
      response.json(await service.getTaskState(request.params.agentId))
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.post('/:agentId/task-state', async (request, response) => {
    try {
      response.json(await service.transitionTaskState(request.params.agentId, request.body))
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.get('/:agentId/task-state/history', async (request, response) => {
    try {
      const messages = await service.getTaskHistory(request.params.agentId)
      response.json({ agentId: request.params.agentId, messages, count: messages.length })
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.delete('/:agentId/task-state', async (request, response) => {
    try {
      response.json(await service.resetTask(request.params.agentId))
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.get('/:agentId/history', async (request, response) => {
    try {
      const messages = await service.getHistory(request.params.agentId)
      const conversationTokens = await service.getConversationTokens(request.params.agentId)
      const tokenHistory = await service.getTokenHistory(request.params.agentId)
      response.json({ agentId: request.params.agentId, messages, count: messages.length, conversationTokens, tokenHistory })
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.delete('/:agentId/history', async (request, response) => {
    try {
      await service.clearHistory(request.params.agentId)
      response.status(204).send()
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.delete('/:agentId/history/all', async (request, response) => {
    try {
      response.json(await service.clearAllHistory(request.params.agentId))
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.delete('/:agentId', async (request, response) => {
    try {
      await service.remove(request.params.agentId)
      response.status(204).send()
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.post('/:agentId/run', async (request, response) => {
    try {
      const runRequest = parseRunRequest(request)
      const result = await service.run(request.params.agentId, runRequest.input, runRequest.history, undefined, runRequest.conversationId, runRequest.clientContext)
      response.json(result)
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.post('/:agentId/task-run-events', async (request, response) => {
    response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders()
    const emit = (payload: Record<string, unknown>) => response.write(`${JSON.stringify(payload)}\n`)
    try {
      const runRequest = parseRunRequest(request)
      const result = await service.run(request.params.agentId, runRequest.input, runRequest.history, (event) => emit({ type: 'message', ...event }), runRequest.conversationId, runRequest.clientContext)
      emit({ type: 'done', taskState: result.taskState, taskNotice: result.taskNotice })
    } catch (error) {
      emit({ type: 'error', error: error instanceof Error ? error.message : 'Не удалось выполнить задачу.' })
    } finally {
      response.end()
    }
  })

  router.post('/:agentId/profile-preview', async (request, response) => {
    try {
      const input = request.body?.input
      if (typeof input !== 'string' || !input.trim()) throw new AgentError('Поле input должно быть непустой строкой.')
      response.json(await service.previewProfile(request.params.agentId, input, request.body?.profileId))
    } catch (error) {
      sendAgentError(response, error)
    }
  })

  router.post('/:agentId/stream', async (request, response) => {
    try {
      const runRequest = parseRunRequest(request)
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      response.setHeader('Cache-Control', 'no-cache, no-transform')
      response.setHeader('Connection', 'keep-alive')
      response.flushHeaders()

      const result = await service.stream(request.params.agentId, runRequest.input, runRequest.history, (content) => {
        response.write(`data: ${JSON.stringify({ content })}\n\n`)
      }, runRequest.conversationId, runRequest.clientContext)
      response.write(`data: ${JSON.stringify({ done: true, result })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    } catch (error) {
      if (response.headersSent) {
        response.write(`data: ${JSON.stringify({ error: error instanceof Error ? error.message : 'Поток агента прерван.' })}\n\n`)
        response.end()
      } else {
        sendAgentError(response, error)
      }
    }
  })

  return router
}

function parseRunRequest(request: Request): RunRequest {
  const body = isRecord(request.body) ? request.body : {}
  if (typeof body.input !== 'string' || body.input.trim().length === 0) {
    throw new AgentError('Поле input должно быть непустой строкой.')
  }

  const history = body.history === undefined ? [] : parseHistory(body.history)
  return { input: body.input, history, conversationId: parseConversationId(body.conversationId), clientContext: parseClientContext(body.clientContext) }
}

function parseClientContext(value: unknown): AgentRuntimeContext | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new AgentError('clientContext должен быть объектом.')
  if (value.timeZone === undefined) return undefined
  if (typeof value.timeZone !== 'string' || value.timeZone.length > 100 || !value.timeZone.trim()) {
    throw new AgentError('clientContext.timeZone должен быть непустым IANA-часовым поясом.')
  }
  const timeZone = value.timeZone.trim()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
  } catch {
    throw new AgentError('clientContext.timeZone должен быть корректным IANA-часовым поясом, например Asia/Omsk.')
  }
  return { timeZone }
}

function runtimeContextInstruction(context?: AgentRuntimeContext) {
  if (!context?.timeZone) return undefined
  return `Контекст текущего запроса: браузер пользователя сообщил часовой пояс ${context.timeZone}. Используй его как пояс по умолчанию для относительных дат («сегодня», «завтра», ближайшая пятница) и для новой периодической задачи. Если пользователь в текущей реплике явно назвал другой город или часовой пояс, его указание имеет приоритет. Всегда сохраняй для новой задачи IANA-идентификатор выбранного пояса и называй его в ответе.`
}

function parseConversationId(value: unknown) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value)) {
    throw new AgentError('conversationId должен содержать от 1 до 120 букв, цифр, дефисов или подчёркиваний.')
  }
  return value
}

function conversationScopeId(agentId: string, conversationId: string) {
  return `${agentId}::conversation::${conversationId}`
}

function parseHistory(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) throw new AgentError('Поле history должно быть массивом сообщений.')
  return value.map((item) => {
    if (!isRecord(item) || !['user', 'assistant', 'system'].includes(String(item.role)) || typeof item.content !== 'string') {
      throw new AgentError('Каждое сообщение history должно содержать role и content.')
    }
    return { role: item.role as AgentMessageRole, content: item.content }
  })
}

/** Auxiliary RAG calls share the normal agent provider and credentials; their usage is counted. */
export function createRagCompletion(client: Pick<LlmClient, 'complete'>, config: AgentConfig, signal?: AbortSignal): RagCompletion {
  return async (messages, stage) => {
    const timeout = AbortSignal.timeout(stage === 'rewrite' ? 45_000 : 90_000)
    const completion = await client.complete(messages, {
      provider: config.provider ?? 'deepseek', model: config.model ?? 'deepseek-v4-flash',
      temperature: stage === 'answer' ? config.temperature ?? 0 : 0,
      maxTokens: stage === 'rewrite' ? 400 : stage === 'verify' ? 2_048 : stage === 'answer' ? config.maxTokens ?? 4_096 : 4_096, format: 'json',
    }, signal ? AbortSignal.any([signal, timeout]) : timeout)
    // Auxiliary prompts are not a new user message; count their exact API usage only.
    const usage = createTokenMetrics(config, '', completion)
    return { content: completion.content, usage }
  }
}

function createTokenMetrics(
  config: AgentConfig,
  input: string,
  completion: Pick<CompletionResult, 'tokens' | 'promptTokens' | 'totalTokens'>,
) {
  const promptTokens = completion.promptTokens
  const completionTokens = completion.tokens
  const totalTokens = completion.totalTokens
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
    throw new AgentError(config.provider + ' не вернул точные usage-токены для запроса.', 502)
  }
  return { inputTokens: estimateTokens(input), promptTokens, completionTokens, totalTokens }
}

function sumTokenMetrics(...metrics: Array<AgentTokenMetrics | undefined>) {
  return metrics.reduce<AgentTokenMetrics>((total, item) => ({
    inputTokens: total.inputTokens + (item?.inputTokens ?? 0),
    promptTokens: total.promptTokens + (item?.promptTokens ?? 0),
    completionTokens: total.completionTokens + (item?.completionTokens ?? 0),
    totalTokens: total.totalTokens + (item?.totalTokens ?? 0),
  }), { inputTokens: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 })
}

/** Приближённая оценка для учебных метрик: точный токенизатор зависит от модели. */
function estimateTokens(value: string) {
  const normalized = value.trim()
  return normalized ? Math.max(1, Math.ceil(normalized.length / 3)) : 0
}

function buildMessages(config: AgentConfig, history: AgentMessage[], input: string, summary?: string, runtimeInstruction?: string): AgentMessage[] {
  return [
    ...(config.systemPrompt ? [{ role: 'system' as const, content: config.systemPrompt }] : []),
    ...(summary ? [{
      role: 'system' as const,
      content: `Сжатое резюме ранней части диалога. Используй его как контекст, но не упоминай сжатие без необходимости.\n\n${summary}`,
    }] : []),
    ...(runtimeInstruction ? [{ role: 'system' as const, content: runtimeInstruction }] : []),
    ...history,
    { role: 'user' as const, content: input },
  ]
}

function withRuntimeContext(config: AgentConfig, memoryPrompt?: string): AgentConfig {
  const personalization = personalizationPrompt(config.personalization)
  const invariants = invariantsPrompt(config.invariants)
  const taskState = taskStatePrompt(config.taskState)
  const systemPrompt = [config.systemPrompt, personalization, invariants, taskState, memoryPrompt].filter(Boolean).join('\n\n')
  return systemPrompt ? { ...config, systemPrompt } : config
}

function blockedTaskTransitionMessage(notice: string, state: AgentTaskState) {
  return `Автомат не изменил этап: ${notice} Текущий этап остаётся ${state.stage}. ${state.expectedAction}`
}

function blockedLifecycleBypassMessage(state: AgentTaskState) {
  const reason = state.stage === 'planning'
    ? 'Нельзя перейти к выполнению без утверждённого плана.'
    : state.stage === 'validation'
      ? 'Нельзя завершить задачу или пропустить проверку результата на этапе validation.'
      : state.stage === 'execution'
        ? 'Нельзя пропустить текущий этап выполнения задачи.'
        : 'Завершённая задача не допускает дальнейших переходов.'
  return `${reason} Задача остаётся на этапе ${state.stage}. Следующее допустимое действие: ${state.expectedAction}`
}

function blockedRequestedStageMessage(state: AgentTaskState, requestedStage: AgentTaskState['stage']) {
  return `Переход ${state.stage} → ${requestedStage} запрещён. Задача остаётся на этапе ${state.stage}. Следующее допустимое действие: ${state.expectedAction}`
}

function formatMessagesForSummary(messages: AgentMessage[]) {
  return messages.map((message) => `${message.role === 'assistant' ? 'Агент' : message.role === 'user' ? 'Пользователь' : 'Система'}: ${message.content}`).join('\n\n')
}

function countDialogMessages(messages: AgentMessage[]) {
  return messages.filter((message) => message.role === 'user' || message.role === 'assistant').length
}

function createContextInfo(
  config: AgentConfig,
  retainedHistory: AgentMessage[],
  summary: string | undefined,
  summarizedMessages: number,
  estimatedReplacedTokens: number,
  input = '',
): AgentContextInfo {
  const estimatedFullPromptTokens = estimateMessagesTokens(buildMessages(config, retainedHistory, input)) + estimatedReplacedTokens
  const estimatedSentPromptTokens = estimateMessagesTokens(buildMessages(config, retainedHistory, input, summary))
  return {
    enabled: config.contextStrategy?.strategy === 'summary',
    summary,
    summarizedMessages,
    retainedMessages: retainedHistory.length,
    estimatedFullPromptTokens,
    estimatedSentPromptTokens,
    estimatedSavedTokens: Math.max(0, estimatedFullPromptTokens - estimatedSentPromptTokens),
  }
}

function estimateMessagesTokens(messages: AgentMessage[]) {
  return messages.reduce((total, message) => total + estimateTokens(message.content) + 4, 0)
}

function validateInput(input: string, policy: AgentConfig['inputPolicy']) {
  const value = input.trim()
  if (!value) throw new AgentError('Запрос агента не может быть пустым.')
  if (policy?.maxCharacters !== undefined && value.length > policy.maxCharacters) {
    throw new AgentError(`Запрос превышает лимит входной политики: ${policy.maxCharacters} символов.`)
  }
  return value
}

function applyOutputPolicy(output: string, policy: AgentConfig['outputPolicy']) {
  const limited = applyOutputCharacterLimit(output, policy?.maxCharacters)
  if (policy?.format !== 'json') return limited

  const fencedMatch = limited.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fencedMatch?.[1] ?? limited.trim()
  try {
    return JSON.stringify(JSON.parse(candidate), null, 2)
  } catch {
    throw new AgentError('Output policy требует валидный JSON, но агент вернул другой формат.', 502)
  }
}

function applyOutputCharacterLimit(output: string, maxCharacters?: number) {
  return maxCharacters === undefined ? output : output.slice(0, maxCharacters)
}

function toLlmOptions(config: Required<Pick<AgentConfig, 'provider' | 'model'>> & AgentConfig): LlmOptions {
  return {
    provider: config.provider,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    stopSequences: config.outputPolicy?.stopSequences,
    format: config.outputPolicy?.format,
  }
}

function normalizeAgentConfig(value: unknown, defaultDeepSeekModel: string) {
  const input = isRecord(value) ? value : {}
  const provider: AgentProvider = input.provider === 'huggingface' ? 'huggingface' : input.provider === 'openrouter' ? 'openrouter' : 'deepseek'
  const fallbackModel = provider === 'huggingface' ? 'google/gemma-3-4b-it:deepinfra' : provider === 'openrouter' ? 'liquid/lfm-2.5-2.6b:free' : defaultDeepSeekModel
  const model = readString(input.model, 200) || fallbackModel

  const config: AgentConfig & { provider: AgentProvider; model: string } = {
    name: readString(input.name, 120),
    provider,
    model,
    systemPrompt: readString(input.systemPrompt, 8000),
    temperature: readNumber(input.temperature, 0, 2),
    maxTokens: readInteger(input.maxTokens, 1, 100000),
    inputPolicy: normalizeInputPolicy(input.inputPolicy),
    outputPolicy: normalizeOutputPolicy(input.outputPolicy),
    contextStrategy: normalizeContextStrategy(input.contextStrategy) ?? normalizeLegacySummaryStrategy(input.contextCompression),
    memoryLayers: normalizeMemoryLayers(input.memoryLayers),
    personalization: normalizePersonalization(input.personalization),
    invariants: normalizeInvariants(input.invariants),
    taskState: normalizeTaskState(input.taskState),
    taskMachine: input.taskMachine === true ? true : undefined,
    mcp: normalizeMcpConfig(input.mcp),
    rag: normalizeRagConfig(input.rag),
  }

  validateGroundingConfig(config)
  return removeUndefined(config)
}

function validateGroundingConfig(config: AgentConfig) {
  if (!config.rag?.enabled || !config.rag.grounding?.enabled) return
  // Citation verification is independent of retrieval enhancements. Basic RAG can
  // keep its original top-K search; the generator/verifier must still reject unsupported facts.
  if (config.taskMachine || config.mcp?.enabled) throw new AgentError('Режим проверяемых цитат работает с документами RAG и не совмещается с taskMachine или MCP-действиями. Используйте отдельного обычного RAG-агента.')
  if (config.outputPolicy?.stopSequences?.length) throw new AgentError('Stop-последовательности несовместимы с полным JSON-контрактом цитат.')
}

function normalizeMcpConfig(value: unknown): AgentConfig['mcp'] | undefined {
  if (!isRecord(value) || value.enabled !== true) return undefined
  const servers = readStringArray(value.servers, 16, 120)
  if (!servers.length) return undefined
  const serverToolAccess = isRecord(value.serverToolAccess)
    ? Object.fromEntries(Object.entries(value.serverToolAccess).flatMap(([serverId, access]) => (
      servers.includes(serverId) && (access === 'all' || access === 'read-only') ? [[serverId, access]] : []
    ))) as Record<string, 'all' | 'read-only'>
    : undefined
  return {
    enabled: true,
    servers,
    ...(value.toolAccess === 'read-only' ? { toolAccess: 'read-only' as const } : {}),
    ...(serverToolAccess && Object.keys(serverToolAccess).length ? { serverToolAccess } : {}),
  }
}

export function normalizeRagConfig(value: unknown): RagConfig | undefined {
  if (!isRecord(value) || value.enabled !== true) return undefined
  const strategy = value.strategy === 'fixed' ? 'fixed' : 'structured'
  const topK = readInteger(value.topK, 1, 8) ?? 4
  const validNumber = (input: unknown, min: number, max: number, integer = false): input is number => typeof input === 'number' && Number.isFinite(input) && input >= min && input <= max && (!integer || Number.isInteger(input))
  const candidateTopK = validNumber(value.candidateTopK, topK, 30, true) ? value.candidateTopK : undefined
  if (value.candidateTopK !== undefined && candidateTopK === undefined) throw new AgentError(`candidateTopK должен быть целым числом от topK (${topK}) до 30.`)
  const minSimilarity = validNumber(value.minSimilarity, -1, 1) ? value.minSimilarity : undefined
  if (value.minSimilarity !== undefined && minSimilarity === undefined) throw new AgentError('minSimilarity должен быть числом от -1 до 1.')
  const rerankInput = isRecord(value.rerank) && value.rerank.enabled === true ? value.rerank : undefined
  const minRelevance = rerankInput?.minRelevance === undefined ? 2 : validNumber(rerankInput.minRelevance, 0, 3, true) ? rerankInput.minRelevance : undefined
  if (rerankInput && minRelevance === undefined) throw new AgentError('minRelevance должен быть целым числом от 0 до 3.')
  return {
    enabled: true, strategy, topK,
    ...(candidateTopK !== undefined ? { candidateTopK } : {}),
    ...(minSimilarity !== undefined ? { minSimilarity } : {}),
    ...(value.queryRewrite === true ? { queryRewrite: true } : {}),
    ...(rerankInput ? { rerank: { enabled: true, minRelevance: minRelevance! } } : {}),
    ...(isRecord(value.grounding) && value.grounding.enabled === true ? { grounding: { enabled: true } } : {}),
    ...(readString(value.indexRunId, 120) ? { indexRunId: readString(value.indexRunId, 120) } : {}),
  }
}

function normalizeInputPolicy(value: unknown) {
  if (!isRecord(value)) return undefined
  return removeUndefined({
    maxCharacters: readInteger(value.maxCharacters, 1, 1000000),
  })
}

function normalizeOutputPolicy(value: unknown) {
  if (!isRecord(value)) return undefined
  const stopSequences = readStringArray(value.stopSequences, 32, 200)
  const format: 'text' | 'json' | undefined = value.format === 'json' ? 'json' : value.format === 'text' ? 'text' : undefined
  return removeUndefined({
    maxCharacters: readInteger(value.maxCharacters, 1, 1000000),
    format,
    stopSequences: stopSequences.length ? stopSequences : undefined,
  })
}

function normalizeContextStrategy(value: unknown): AgentContextStrategyConfig | undefined {
  if (!isRecord(value)) return undefined
  const strategy: AgentContextStrategy | undefined = value.strategy === 'sliding'
    ? 'sliding'
    : value.strategy === 'facts'
      ? 'facts'
      : value.strategy === 'branching'
        ? 'branching'
        : value.strategy === 'summary'
          ? 'summary'
        : undefined
  if (!strategy) return undefined

  const facts = isRecord(value.facts)
    ? Object.fromEntries(Object.entries(value.facts).map(([key, items]) => [
      key,
      Array.isArray(items)
        ? items.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
        : [],
    ]))
    : undefined

  return removeUndefined({
    strategy,
    windowSize: readInteger(value.windowSize, 1, 1000000),
    summarizeAfterMessages: readInteger(value.summarizeAfterMessages, 1, 100),
    facts: facts && Object.keys(facts).length ? facts : undefined,
  })
}

/** One-release migration for saved Day 9 agents. New configs only use contextStrategy. */
function normalizeLegacySummaryStrategy(value: unknown): AgentContextStrategyConfig | undefined {
  if (!isRecord(value) || value.enabled !== true) return undefined
  return {
    strategy: 'summary',
    summarizeAfterMessages: readInteger(value.summarizeAfterMessages, 1, 100) ?? readInteger(value.summarizeAfterUserMessages, 1, 100) ?? 10,
  }
}

function normalizeMemoryLayers(value: unknown): AgentMemoryLayersConfig | undefined {
  if (!isRecord(value)) return undefined
  const normalizeEntries = (entries: unknown) => Array.isArray(entries)
    ? entries.slice(0, 50).flatMap((entry) => {
      if (!isRecord(entry)) return []
      const text = readString(entry.text, 4_000)
      if (!text) return []
      const id = typeof entry.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(entry.id) ? entry.id : `memory-${globalThis.crypto.randomUUID()}`
      const createdAt = typeof entry.createdAt === 'string' && !Number.isNaN(Date.parse(entry.createdAt)) ? entry.createdAt : new Date().toISOString()
      return [{ id, text, createdAt }]
    })
    : undefined
  return removeUndefined({
    mode: value.mode === 'auto' ? 'auto' as const : value.mode === 'manual' ? 'manual' as const : undefined,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    shortTermLimit: readInteger(value.shortTermLimit, 2, 100),
    useWorking: typeof value.useWorking === 'boolean' ? value.useWorking : undefined,
    useLongTerm: typeof value.useLongTerm === 'boolean' ? value.useLongTerm : undefined,
    working: normalizeEntries(value.working),
    longTerm: normalizeEntries(value.longTerm),
    autoInstructions: readString(value.autoInstructions, 2_000),
  })
}

function normalizePersonalization(value: unknown): AgentPersonalizationConfig | undefined {
  if (!isRecord(value)) return undefined
  const profiles = Array.isArray(value.profiles)
    ? value.profiles.slice(0, 20).flatMap((item) => {
      if (!isRecord(item)) return []
      const id = typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(item.id) ? item.id : undefined
      const name = readString(item.name, 120)
      if (!id || !name) return []
      return [removeUndefined({
        id,
        name,
        style: readString(item.style, 2_000),
        format: readString(item.format, 2_000),
        restrictions: readString(item.restrictions, 2_000),
      })]
    })
    : undefined
  const globalLongTerm = Array.isArray(value.globalLongTerm)
    ? value.globalLongTerm.slice(0, 50).flatMap((entry) => {
      if (!isRecord(entry)) return []
      const text = readString(entry.text, 4_000)
      if (!text) return []
      const id = typeof entry.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(entry.id) ? entry.id : `fact-${globalThis.crypto.randomUUID()}`
      const createdAt = typeof entry.createdAt === 'string' && !Number.isNaN(Date.parse(entry.createdAt)) ? entry.createdAt : new Date().toISOString()
      return [{ id, text, createdAt }]
    })
    : undefined
  const activeProfileId = typeof value.activeProfileId === 'string' && profiles?.some((profile) => profile.id === value.activeProfileId)
    ? value.activeProfileId
    : profiles?.[0]?.id
  return removeUndefined({ activeProfileId, profiles, globalLongTerm })
}

function normalizeInvariants(value: unknown): AgentInvariantsConfig | undefined {
  if (!isRecord(value)) return undefined
  const items = Array.isArray(value.items)
    ? value.items.slice(0, 20).flatMap((item) => {
      if (!isRecord(item)) return []
      const title = readString(item.title, 160)
      const rule = readString(item.rule, 2_000)
      if (!title || !rule) return []
      const id = typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(item.id)
        ? item.id
        : `invariant-${globalThis.crypto.randomUUID()}`
      return [{ id, title, rule }]
    })
    : []
  const uniqueItems = items.filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
  if (!uniqueItems.length && value.enabled !== true) return undefined
  return { enabled: value.enabled === true, items: uniqueItems }
}

function normalizeTaskState(value: unknown): AgentTaskState | undefined {
  if (!isRecord(value)) return undefined
  const task = readString(value.task, 4_000)
  const currentStep = readString(value.currentStep, 2_000)
  const expectedAction = readString(value.expectedAction, 2_000)
  const stage = value.stage === 'planning' || value.stage === 'execution' || value.stage === 'validation' || value.stage === 'done' ? value.stage : undefined
  if (!task || !currentStep || !expectedAction || !stage) return undefined
  const status = value.status === 'paused' ? 'paused' as const : 'active' as const
  const id = typeof value.id === 'string' && /^task-[a-zA-Z0-9_-]{1,100}$/.test(value.id) ? value.id : `task-${globalThis.crypto.randomUUID()}`
  const completedSteps = Array.isArray(value.completedSteps)
    ? value.completedSteps.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(-50)
    : []
  const updatedAt = typeof value.updatedAt === 'string' && !Number.isNaN(Date.parse(value.updatedAt)) ? value.updatedAt : new Date().toISOString()
  return { id, task, stage, status, currentStep, expectedAction, expectedActor: actorForStage(stage), completedSteps, updatedAt }
}

function normalizeAgentId(value: unknown) {
  const id = typeof value === 'string' && value.trim() ? value.trim() : `agent-${globalThis.crypto.randomUUID().slice(0, 8)}`
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new AgentError('id агента может содержать только латинские буквы, цифры, _ и - (до 64 символов).')
  return id
}

function readString(value: unknown, maxLength: number) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : undefined
}

function readNumber(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, min), max) : undefined
}

function readInteger(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), min), max) : undefined
}

function readUsageInteger(value: Record<string, unknown> | undefined, key: string) {
  const number = value?.[key]
  return typeof number === 'number' && Number.isFinite(number) ? Math.floor(number) : undefined
}

function readStringArray(value: unknown, maxItems: number, maxItemLength: number) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, maxItemLength))
    .slice(0, maxItems)
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}

function isAgentRecord(value: unknown): value is AgentRecord {
  return isRecord(value)
    && typeof value.id === 'string'
    && isRecord(value.config)
    && typeof value.createdAt === 'string'
}

function parseStoredMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is AgentMessage => isRecord(item)
    && ['system', 'user', 'assistant'].includes(String(item.role))
    && typeof item.content === 'string')
    .map((item) => ({ role: item.role, content: item.content, ...(item.archived === true ? { archived: true } : {}) }))
}

function parseStoredMcpContext(value: unknown): McpToolCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.serverId !== 'string' || !isRecord(item.arguments) || item.isError !== false) return []
    return [{
      name: item.name.slice(0, 200),
      serverId: item.serverId.slice(0, 200),
      arguments: item.arguments,
      result: item.result,
      isError: false,
    }]
  }).slice(-4)
}

function parseStoredTokenHistory(value: unknown): AgentTokenUsagePoint[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    if (!isRecord(item)) return []
    const promptTokens = readUsageInteger(item, 'promptTokens')
    const inputTokens = readUsageInteger(item, 'inputTokens') ?? 0
    const completionTokens = readUsageInteger(item, 'completionTokens')
    const totalTokens = readUsageInteger(item, 'totalTokens')
    const conversationTokens = readUsageInteger(item, 'conversationTokens')
    const summaryTokens = readUsageInteger(item, 'summaryTokens')
    const strategyTokens = readUsageInteger(item, 'strategyTokens')
    const memoryTokens = readUsageInteger(item, 'memoryTokens')
    const strategyMetrics = isRecord(item.strategyTokenMetrics)
      ? parseTokenMetrics(item.strategyTokenMetrics)
      : undefined
    const memoryMetrics = isRecord(item.memoryTokenMetrics)
      ? parseTokenMetrics(item.memoryTokenMetrics)
      : undefined
    if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined || conversationTokens === undefined) return []
    return [{
      turn: readUsageInteger(item, 'turn') ?? index + 1,
      inputTokens,
      promptTokens,
      completionTokens,
      totalTokens,
      conversationTokens,
      ...(summaryTokens === undefined ? {} : { summaryTokens }),
      ...((strategyTokens ?? strategyMetrics?.totalTokens) === undefined ? {} : { strategyTokens: strategyTokens ?? strategyMetrics!.totalTokens }),
      ...(strategyMetrics ? { strategyTokenMetrics: strategyMetrics } : {}),
      ...((memoryTokens ?? memoryMetrics?.totalTokens) === undefined ? {} : { memoryTokens: memoryTokens ?? memoryMetrics!.totalTokens }),
      ...(memoryMetrics ? { memoryTokenMetrics: memoryMetrics } : {}),
    }]
  })
}

function parseTokenMetrics(value: Record<string, unknown>): AgentTokenMetrics | undefined {
  const promptTokens = readUsageInteger(value, 'promptTokens')
  const inputTokens = readUsageInteger(value, 'inputTokens') ?? 0
  const completionTokens = readUsageInteger(value, 'completionTokens')
  const totalTokens = readUsageInteger(value, 'totalTokens')
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) return undefined
  return { inputTokens, promptTokens, completionTokens, totalTokens }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return isRecord(error) && typeof error.code === 'string'
}

async function readJson(response: globalThis.Response): Promise<Record<string, any>> {
  try {
    const data: unknown = await response.json()
    return isRecord(data) ? data : {}
  } catch {
    return {}
  }
}

function parseJson(value: string): Record<string, any> {
  try {
    const data: unknown = JSON.parse(value)
    return isRecord(data) ? data : {}
  } catch {
    return {}
  }
}

function throwNotFound(id: string): never {
  throw new AgentError(`Агент "${id}" не найден.`, 404)
}

function sendAgentError(response: Response, error: unknown) {
  const statusCode = error instanceof AgentError ? error.statusCode : 500
  const message = error instanceof Error ? error.message : 'Неизвестная ошибка агента.'
  response.status(statusCode).json({ error: message })
}
