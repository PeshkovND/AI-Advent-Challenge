import express, { Request, Response, Router } from 'express'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export type AgentProvider = 'deepseek' | 'huggingface' | 'openrouter'
export type AgentMessageRole = 'system' | 'user' | 'assistant'

export type AgentMessage = {
  role: AgentMessageRole
  content: string
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
  tokenHistory?: AgentTokenUsagePoint[]
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
  conversationTokens: Record<string, number>
  tokenHistory: Record<string, AgentTokenUsagePoint[]>
}

class AgentStateStore {
  private state: AgentState = { agents: [], histories: {}, conversationTokens: {}, tokenHistory: {} }
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
    return [...(this.state.histories[agentId] ?? [])]
  }

  async replaceHistory(agentId: string, messages: AgentMessage[]) {
    await this.ready
    this.state.histories[agentId] = [...messages]
    await this.persist()
  }

  async appendHistory(agentId: string, messages: AgentMessage[]) {
    await this.ready
    const nextHistory = [...(this.state.histories[agentId] ?? []), ...messages]
    this.state.histories[agentId] = nextHistory
    await this.persist()
    return this.state.histories[agentId].length
  }

  async addConversationTokens(agentId: string, metrics: AgentTokenMetrics) {
    await this.ready
    const conversationTokens = (this.state.conversationTokens[agentId] ?? 0) + metrics.totalTokens
    this.state.conversationTokens[agentId] = conversationTokens
    const history = this.state.tokenHistory[agentId] ?? []
    this.state.tokenHistory[agentId] = [...history, { ...metrics, turn: history.length + 1, conversationTokens }]
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
    delete this.state.histories[agentId]
    delete this.state.conversationTokens[agentId]
    delete this.state.tokenHistory[agentId]
    await this.persist()
  }

  async clearHistory(agentId: string) {
    await this.ready
    delete this.state.histories[agentId]
    delete this.state.conversationTokens[agentId]
    delete this.state.tokenHistory[agentId]
    await this.persist()
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
}

export class AgentError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'AgentError'
    this.statusCode = statusCode
  }
}

class LlmClient {
  constructor(private readonly options: AgentServiceOptions) {}

  async complete(messages: AgentMessage[], options: LlmOptions): Promise<CompletionResult> {
    const apiResponse = await this.request(messages, options, false)
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

  private async request(messages: AgentMessage[], options: LlmOptions, stream: boolean) {
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
  constructor(
    readonly id: string,
    readonly config: Required<Pick<AgentConfig, 'provider' | 'model'>> & AgentConfig,
    private readonly client: LlmClient,
  ) {}

  async run(input: string, history: AgentMessage[] = []): Promise<AgentRunResult> {
    const validatedInput = validateInput(input, this.config.inputPolicy)
    const messages = buildMessages(this.config, history, validatedInput)
    const startedAt = Date.now()
    const completion = await this.client.complete(messages, toLlmOptions(this.config))
    const output = applyOutputPolicy(completion.content, this.config.outputPolicy)
    const tokenMetrics = createTokenMetrics(this.config, validatedInput, completion)

    return {
      agentId: this.id,
      input: validatedInput,
      output,
      provider: this.config.provider,
      model: this.config.model,
      durationMs: Date.now() - startedAt,
      tokens: completion.tokens,
      promptTokens: completion.promptTokens,
      totalTokens: completion.totalTokens,
      tokenMetrics,
    }
  }

  async stream(input: string, history: AgentMessage[], onChunk: (content: string) => void): Promise<AgentRunResult> {
    const validatedInput = validateInput(input, this.config.inputPolicy)
    const messages = buildMessages(this.config, history, validatedInput)
    const startedAt = Date.now()
    let streamedOutput = ''
    let emittedOutput = ''

    const completion = await this.client.stream(messages, toLlmOptions(this.config), (content) => {
      streamedOutput += content
      const visibleOutput = applyOutputCharacterLimit(streamedOutput, this.config.outputPolicy?.maxCharacters)
      const delta = visibleOutput.slice(emittedOutput.length)
      if (delta) onChunk(delta)
      emittedOutput = visibleOutput
    })

    const output = applyOutputPolicy(streamedOutput, this.config.outputPolicy)
    const tokenMetrics = createTokenMetrics(this.config, validatedInput, completion)

    return {
      agentId: this.id,
      input: validatedInput,
      output,
      provider: this.config.provider,
      model: this.config.model,
      durationMs: Date.now() - startedAt,
      tokenMetrics,
    }
  }
}

export class AgentService {
  private readonly agents = new Map<string, Agent>()
  private readonly createdAt = new Map<string, string>()
  private readonly client: LlmClient
  private readonly defaultDeepSeekModel: string
  private readonly stateStore: AgentStateStore
  readonly ready: Promise<void>

  constructor(options: AgentServiceOptions) {
    this.client = new LlmClient(options)
    this.defaultDeepSeekModel = options.defaultDeepSeekModel
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

  async clearHistory(id: string) {
    await this.ready
    this.get(id)
    await this.stateStore.clearHistory(id)
  }

  async run(id: string, input: string, providedHistory: AgentMessage[] = []) {
    await this.ready
    const agent = this.get(id)
    const storedHistory = await this.stateStore.getHistory(id)
    const sourceHistory = storedHistory.length > 0 ? storedHistory : providedHistory
    const result = await agent.run(input, sourceHistory)
    const contextMessages = await this.stateStore.appendHistory(id, [
      { role: 'user', content: result.input },
      { role: 'assistant', content: result.output },
    ])
    const conversationTokens = await this.stateStore.addConversationTokens(id, result.tokenMetrics)
    const tokenHistory = await this.stateStore.getTokenHistory(id)
    return { ...result, contextMessages, conversationTokens, tokenHistory }
  }

  async stream(id: string, input: string, providedHistory: AgentMessage[], onChunk: (content: string) => void) {
    await this.ready
    const agent = this.get(id)
    const storedHistory = await this.stateStore.getHistory(id)
    const sourceHistory = storedHistory.length > 0 ? storedHistory : providedHistory
    const result = await agent.stream(input, sourceHistory, onChunk)
    const contextMessages = await this.stateStore.appendHistory(id, [
      { role: 'user', content: result.input },
      { role: 'assistant', content: result.output },
    ])
    const conversationTokens = await this.stateStore.addConversationTokens(id, result.tokenMetrics)
    const tokenHistory = await this.stateStore.getTokenHistory(id)
    return { ...result, contextMessages, conversationTokens, tokenHistory }
  }

  async runEphemeral(input: string, config: AgentConfig, history: AgentMessage[]) {
    await this.ready
    const normalizedConfig = normalizeAgentConfig(config, this.defaultDeepSeekModel)
    const agent = new Agent('context-demo', normalizedConfig, this.client)
    return agent.run(input, history)
  }

  private register(id: string, config: Required<Pick<AgentConfig, 'provider' | 'model'>> & AgentConfig, createdAt: string) {
    this.agents.set(id, new Agent(id, config, this.client))
    this.createdAt.set(id, createdAt)
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
      const result = await service.run(request.params.agentId, runRequest.input, runRequest.history)
      response.json(result)
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
      })
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
  return { input: body.input, history }
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

/** Приближённая оценка для учебных метрик: точный токенизатор зависит от модели. */
function estimateTokens(value: string) {
  const normalized = value.trim()
  return normalized ? Math.max(1, Math.ceil(normalized.length / 3)) : 0
}

function buildMessages(config: AgentConfig, history: AgentMessage[], input: string): AgentMessage[] {
  return [
    ...(config.systemPrompt ? [{ role: 'system' as const, content: config.systemPrompt }] : []),
    ...history,
    { role: 'user' as const, content: input },
  ]
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
  }

  return removeUndefined(config)
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
    .map((item) => ({ role: item.role, content: item.content }))
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
    if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined || conversationTokens === undefined) return []
    return [{
      turn: readUsageInteger(item, 'turn') ?? index + 1,
      inputTokens,
      promptTokens,
      completionTokens,
      totalTokens,
      conversationTokens,
    }]
  })
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
