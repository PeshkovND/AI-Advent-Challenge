import 'dotenv/config'
import express, { Response } from 'express'
import { AgentError, AgentService, createAgentRouter } from './agent-service'
import { isContextDemoScenario, prepareContextDemo, resetContextDemo } from './context-demo'

type ChatRole = 'system' | 'user' | 'assistant'

type ChatMessage = {
  role: ChatRole
  content: string
}

type CompletionResult = {
  content: string
  tokens?: number
  promptTokens?: number
  totalTokens?: number
  costUsd?: number
}

type DeepSeekResponse = {
  model?: string
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }
  choices?: Array<{
    message?: {
      role?: string
      content?: string
    }
  }>
  error?: {
    message?: string
  }
}

type DeepSeekStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string
    }
  }>
}

type CompareControls = {
  format?: string
  maxTokens?: number
  stopSequences?: string[]
  responseFormat?: 'json_object'
  jsonExample?: string
}

type ReasoningExpert = {
  id: string
  title: string
  content: string
  tokens?: number
}

type TemperatureResult = {
  temperature: number
  content: string
  tokens?: number
}

type ModelPricing = {
  cacheHitInput: number
  cacheMissInput: number
  output: number
}

type ModelDefinition = {
  id: string
  tier: string
  name: string
  model: string
  provider: 'deepseek' | 'huggingface'
  link: string
  costLabel: string
  pricing?: ModelPricing
}

type ModelComparisonResult = {
  id: string
  tier: string
  name: string
  model: string
  provider: ModelDefinition['provider']
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

const app = express()
const port = Number(process.env.PORT ?? 8787)
const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
const huggingFaceApiKey = process.env.HUGGINGFACE_API_KEY?.trim()
const openRouterApiKey = process.env.OPENROUTER_API_KEY?.trim()
const model = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash'
const agentService = new AgentService({
  deepSeekApiKey: apiKey,
  huggingFaceApiKey,
  openRouterApiKey,
  defaultDeepSeekModel: model,
})

const CONTEXT_DEMO_AGENT_ID = 'context-demo'
const CONTEXT_DEMO_MODEL = 'liquid/lfm-2.5-2.6b:free'
const CONTEXT_DEMO_CONFIG = {
  name: 'Демонстрация токенов',
  provider: 'openrouter' as const,
  model: CONTEXT_DEMO_MODEL,
  systemPrompt: 'Отвечай по существу и учитывай историю диалога.',
}

async function ensureContextDemoAgent() {
  await agentService.ready
  const existing = agentService.list().find((agent) => agent.id === CONTEXT_DEMO_AGENT_ID)
  if (!existing) {
    await agentService.create({ id: CONTEXT_DEMO_AGENT_ID, config: CONTEXT_DEMO_CONFIG })
  } else if (existing.config.maxTokens !== undefined) {
    const { maxTokens: _oldMaxTokens, ...configWithoutLimit } = existing.config
    await agentService.update(CONTEXT_DEMO_AGENT_ID, { ...configWithoutLimit, ...CONTEXT_DEMO_CONFIG })
  }
}

async function getContextDemoState() {
  await ensureContextDemoAgent()
  const [messages, conversationTokens, tokenHistory] = await Promise.all([
    agentService.getHistory(CONTEXT_DEMO_AGENT_ID),
    agentService.getConversationTokens(CONTEXT_DEMO_AGENT_ID),
    agentService.getTokenHistory(CONTEXT_DEMO_AGENT_ID),
  ])
  return {
    id: CONTEXT_DEMO_AGENT_ID,
    title: 'Диалог с агентом',
    description: 'Обычный зарегистрированный агент с сохранённой историей.',
    model: CONTEXT_DEMO_MODEL,
    historyMessages: messages.length,
    conversationTokens,
    tokenHistory,
    messages,
  }
}

const modelDefinitions: ModelDefinition[] = [
  {
    id: 'gemma-small',
    tier: 'Небольшая',
    name: 'Gemma 3 4B',
    model: 'google/gemma-3-4b-it:deepinfra',
    provider: 'huggingface',
    link: 'https://huggingface.co/google/gemma-3-4b-it',
    costLabel: 'По тарифу DeepInfra',
  },
  {
    id: 'deepseek-flash',
    tier: 'Средняя',
    name: 'DeepSeek V4 Flash',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    link: 'https://api-docs.deepseek.com/quick_start/pricing',
    costLabel: 'Рассчитывается по тарифу',
    pricing: { cacheHitInput: 0.0028, cacheMissInput: 0.14, output: 0.28 },
  },
  {
    id: 'deepseek-pro',
    tier: 'Сильная',
    name: 'DeepSeek V4 Pro',
    model: 'deepseek-v4-pro',
    provider: 'deepseek',
    link: 'https://api-docs.deepseek.com/quick_start/pricing',
    costLabel: 'Рассчитывается по тарифу',
    pricing: { cacheHitInput: 0.003625, cacheMissInput: 0.435, output: 0.87 },
  },
]

app.use(express.json({ limit: '1mb' }))
app.use('/api/agents', createAgentRouter(agentService))

app.get('/api/context-demo', async (_request, response) => {
  try {
    response.json(await getContextDemoState())
  } catch (error) {
    sendContextDemoError(response, error)
  }
})

app.post('/api/context-demo/reset', async (_request, response) => {
  try {
    await ensureContextDemoAgent()
    await agentService.clearHistory(CONTEXT_DEMO_AGENT_ID)
    response.json(await getContextDemoState())
  } catch (error) {
    sendContextDemoError(response, error)
  }
})

app.delete('/api/context-demo/agent', async (_request, response) => {
  try {
    await ensureContextDemoAgent()
    await agentService.remove(CONTEXT_DEMO_AGENT_ID)
    response.json(await getContextDemoState())
  } catch (error) {
    sendContextDemoError(response, error)
  }
})

app.post('/api/context-demo/reset/:scenario', (request, response) => {
  if (!isContextDemoScenario(request.params.scenario)) {
    response.status(404).json({ error: 'Неизвестный сценарий демонстрации контекста.' })
    return
  }
  response.json(resetContextDemo(request.params.scenario))
})

app.post('/api/context-demo/message', async (request, response) => {
  const input = request.body?.input as unknown
  if (typeof input !== 'string' || input.trim().length === 0) {
    response.status(400).json({ error: 'Поле input должно быть непустой строкой.' })
    return
  }

  try {
    await ensureContextDemoAgent()
    const result = await agentService.run(CONTEXT_DEMO_AGENT_ID, input.trim())
    response.json({ ...(await getContextDemoState()), input: result.input, result })
  } catch (error) {
    sendContextDemoError(response, error)
  }
})

app.post('/api/context-demo/:scenario', async (request, response) => {
  if (!isContextDemoScenario(request.params.scenario)) {
    response.status(404).json({ error: 'Неизвестный сценарий демонстрации контекста.' })
    return
  }

  const preparation = prepareContextDemo(request.params.scenario)
  const input = typeof request.body?.input === 'string' && request.body.input.trim()
    ? request.body.input.trim()
    : preparation.input

  try {
    const result = await agentService.runEphemeral(input, {
      provider: 'openrouter',
      model: preparation.model,
      systemPrompt: 'Отвечай по существу и учитывай историю диалога.',
    }, preparation.history)

    response.json({
      id: preparation.id,
      title: preparation.title,
      description: preparation.description,
      model: preparation.model,
      input,
      historyMessages: preparation.historyMessages,
      result,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось выполнить сценарий демонстрации контекста.'
    response.status(502).json({
      id: preparation.id,
      title: preparation.title,
      description: preparation.description,
      model: preparation.model,
      input,
      historyMessages: preparation.historyMessages,
      error: message,
    })
  }
})

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, configured: Boolean(apiKey), model, agents: agentService.count })
})

app.post('/api/compare', async (request, response) => {
  const prompt = request.body?.prompt as unknown

  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    response.status(400).json({ error: 'Поле prompt должно быть непустой строкой.' })
    return
  }

  const controls = normalizeCompareControls(request.body?.controls)
  const controlledSystemParts: string[] = []

  if (controls.format) controlledSystemParts.push(`Формат ответа: ${controls.format}`)
  if (controls.responseFormat) {
    const jsonExample = controls.jsonExample || '{"summary":"краткое резюме","items":["пункт 1","пункт 2"]}'
    controlledSystemParts.push(`Верни только валидный JSON-объект в формате json. Не добавляй markdown или текст вне JSON. Используй такую структуру: ${jsonExample}`)
  }
  if (controls.stopSequences?.length) {
    controlledSystemParts.push(`Заверши ответ при появлении одной из последовательностей: ${controls.stopSequences.map((sequence) => `"${sequence}"`).join(', ')}.`)
  }

  const controlledMessages: ChatMessage[] = [
    ...(controlledSystemParts.length > 0
      ? [{ role: 'system' as const, content: controlledSystemParts.join(' ') }]
      : []),
    { role: 'user', content: prompt.trim() },
  ]

  try {
    const [unconstrained, constrained] = await Promise.all([
      requestCompletion([{ role: 'user', content: prompt.trim() }]),
      requestCompletion(controlledMessages, {
        ...(controls.maxTokens ? { max_tokens: controls.maxTokens } : {}),
        ...(controls.stopSequences?.length ? { stop: controls.stopSequences } : {}),
        ...(controls.responseFormat ? { response_format: { type: controls.responseFormat } } : {}),
      }),
    ])

    response.json({
      prompt: prompt.trim(),
      unconstrained,
      constrained,
      controls,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось сравнить ответы.'
    response.status(502).json({ error: message })
  }
})

app.post('/api/temperature', async (request, response) => {
  const prompt = request.body?.prompt as unknown

  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    response.status(400).json({ error: 'Поле prompt должно быть непустой строкой.' })
    return
  }

  const temperatures = [0, 0.7, 1.2, 1.7, 2.0] as const

  try {
    const results = await Promise.all(
      temperatures.map(async (temperature): Promise<TemperatureResult> => {
        const result = await requestCompletion(
          [{ role: 'user', content: prompt.trim() }],
          { temperature },
        )

        return { temperature, ...result }
      }),
    )

    response.json({ prompt: prompt.trim(), results })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось получить ответы для разных температур.'
    response.status(502).json({ error: message })
  }
})

app.post('/api/models', async (request, response) => {
  const prompt = request.body?.prompt as unknown

  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    response.status(400).json({ error: 'Поле prompt должно быть непустой строкой.' })
    return
  }

  const trimmedPrompt = prompt.trim()
  const messages: ChatMessage[] = [{ role: 'user', content: trimmedPrompt }]
  const commonOptions = { temperature: 0.7 }

  const results = await Promise.all(modelDefinitions.map(async (definition): Promise<ModelComparisonResult> => {
    const startedAt = Date.now()

    try {
      const completion = definition.provider === 'deepseek'
        ? await requestCompletion(messages, { ...commonOptions, model: definition.model })
        : await requestHuggingFaceCompletion(messages, definition.model, commonOptions)

      return {
        id: definition.id,
        tier: definition.tier,
        name: definition.name,
        model: definition.model,
        provider: definition.provider,
        link: definition.link,
        durationMs: Date.now() - startedAt,
        content: completion.content,
        tokens: completion.tokens,
        promptTokens: completion.promptTokens,
        totalTokens: completion.totalTokens,
        costUsd: completion.costUsd,
        costLabel: definition.costLabel,
      }
    } catch (error) {
      return {
        id: definition.id,
        tier: definition.tier,
        name: definition.name,
        model: definition.model,
        provider: definition.provider,
        link: definition.link,
        durationMs: Date.now() - startedAt,
        costLabel: definition.costLabel,
        error: error instanceof Error ? error.message : 'Модель не вернула ответ.',
      }
    }
  }))

  response.json({ prompt: trimmedPrompt, results })
})

app.post('/api/reasoning', async (request, response) => {
  const task = request.body?.task as unknown

  if (typeof task !== 'string' || task.trim().length === 0) {
    response.status(400).json({ error: 'Поле task должно быть непустой строкой.' })
    return
  }

  const trimmedTask = task.trim()
  const expertDefinitions = [
    { id: 'analyst', title: 'Аналитик', instruction: 'Разбери условия, выдели факты, ограничения и проверь логические связи.' },
    { id: 'engineer', title: 'Инженер', instruction: 'Предложи практичный алгоритм решения и последовательно проверь его на задаче.' },
    { id: 'critic', title: 'Критик', instruction: 'Реши задачу независимо и найди возможные ошибки, неоднозначности и контрпримеры.' },
  ]
  const directMessages: ChatMessage[] = [{ role: 'user', content: trimmedTask }]
  const stepByStepMessages: ChatMessage[] = [
    { role: 'system', content: 'Решай задачу пошагово. Показывай ход рассуждения, промежуточные выводы и итоговый ответ.' },
    { role: 'user', content: trimmedTask },
  ]
  const promptEngineerMessages: ChatMessage[] = [
    { role: 'system', content: 'Ты — prompt-инженер. Твоя задача — составить самостоятельный, точный и понятный prompt для другого AI-агента, которому будет передана исходная задача. Не решай задачу сам, не сообщай ответ, не добавляй вычисления, рассуждения, варианты решения или комментарии. В готовом prompt явно укажи роль AI-агента, исходную задачу, важные условия и ограничения, а также требования к форме итогового ответа. Не изменяй смысл задачи и не добавляй факты, которых в ней нет. Верни только готовый текст prompt без кавычек, пояснений и вводных фраз.' },
    { role: 'user', content: `Составь промпт для решения этой задачи:\n\n${trimmedTask}` },
  ]
  const expertMessages = expertDefinitions.map(({ id, title, instruction }) => ({
    id,
    title,
    messages: [
      { role: 'system' as const, content: `Ты — ${title.toLowerCase()} в совете экспертов. ${instruction} Дай собственное решение задачи, а в конце сформулируй итог и уровень уверенности.` },
      { role: 'user' as const, content: trimmedTask },
    ],
  }))

  try {
    const [direct, stepByStep, generatedPrompt, ...expertResults] = await Promise.all([
      requestCompletion(directMessages),
      requestCompletion(stepByStepMessages),
      requestCompletion(promptEngineerMessages),
      ...expertMessages.map(({ messages }) => requestCompletion(messages)),
    ])

    const promptBasedMessages: ChatMessage[] = [{ role: 'user', content: generatedPrompt.content }]
    const promptBased = await requestCompletion(promptBasedMessages)

    const experts: ReasoningExpert[] = expertDefinitions.map((expert, index) => ({
      ...expert,
      content: expertResults[index].content,
      tokens: expertResults[index].tokens,
    }))

    const councilMessages: ChatMessage[] = [
      { role: 'system', content: 'Ты — председатель совета экспертов. На основе задачи и полного ответа каждого эксперта сформируй единое решение совета. Сопоставь выводы аналитика, инженера и критика, укажи, где они совпадают и расходятся, проверь спорные места и не игнорируй ни одного участника. В конце дай ясный итоговый ответ. Отвечай на русском в Markdown.' },
      { role: 'user', content: buildCouncilPrompt(trimmedTask, experts) },
    ]
    const council = await requestCompletion(councilMessages)

    response.json({
      task: trimmedTask,
      direct,
      stepByStep,
      generatedPrompt: generatedPrompt.content,
      promptBased,
      experts,
      council,
      prompts: {
        direct: directMessages,
        stepByStep: stepByStepMessages,
        promptEngineer: promptEngineerMessages,
        promptBased: promptBasedMessages,
        experts: expertMessages,
        council: councilMessages,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось получить варианты решения.'
    response.status(502).json({ error: message })
  }
})

function buildCouncilPrompt(task: string, experts: ReasoningExpert[]) {
  const expertText = experts.map(({ title, content }) => `${title}:\n${clipForPrompt(content)}`).join('\n\n')

  return `Задача:\n${task}\n\nПолные ответы членов совета:\n${expertText}`
}

function clipForPrompt(value: string, maxLength = 7000) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n[текст сокращён]` : value
}

function normalizeCompareControls(value: unknown): CompareControls {
  if (typeof value !== 'object' || value === null) return {}

  const controls = value as Record<string, unknown>
  const format = typeof controls.format === 'string' && controls.format.trim() ? controls.format.trim() : undefined
  const stopSequences = Array.isArray(controls.stopSequences)
    ? controls.stopSequences
        .filter((sequence): sequence is string => typeof sequence === 'string' && sequence.trim().length > 0)
        .map((sequence) => sequence.trim().slice(0, 80))
        .slice(0, 16)
    : undefined
  const maxTokens = typeof controls.maxTokens === 'number' && Number.isFinite(controls.maxTokens)
    ? Math.min(Math.max(Math.floor(controls.maxTokens), 16), 1000)
    : undefined
  const responseFormat = controls.responseFormat === 'json_object' ? 'json_object' : undefined
  const jsonExample = typeof controls.jsonExample === 'string' && controls.jsonExample.trim()
    ? controls.jsonExample.trim().slice(0, 4000)
    : undefined

  return { format, maxTokens, stopSequences: stopSequences?.length ? stopSequences : undefined, responseFormat, jsonExample }
}

app.post('/api/chat', async (request, response) => {
  const messages = request.body?.messages as unknown

  if (!isChatMessageArray(messages)) {
    response.status(400).json({
      error: 'Поле messages должно содержать непустой массив сообщений.',
    })
    return
  }

  const latestMessage = messages[messages.length - 1]
  if (latestMessage.role !== 'user') {
    response.status(400).json({ error: 'Последнее сообщение должно быть сообщением пользователя.' })
    return
  }

  try {
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.flushHeaders()

    await agentService.stream('default', latestMessage.content, messages.slice(0, -1), (content) => {
      response.write(`data: ${JSON.stringify({ content })}\n\n`)
    })
    response.write('data: [DONE]\n\n')
    response.end()
  } catch (error) {
    if (response.headersSent) {
      response.write(`data: ${JSON.stringify({ error: error instanceof Error ? error.message : 'Поток агента был прерван.' })}\n\n`)
      response.end()
    } else {
      response.status(502).json({ error: error instanceof Error ? error.message : 'Не удалось запустить агента.' })
    }
  }
})

async function requestCompletion(
  messages: ChatMessage[],
  options: { model?: string; max_tokens?: number; stop?: string[]; response_format?: { type: 'json_object' }; temperature?: number } = {},
): Promise<CompletionResult> {
  if (!apiKey) throw new Error('Добавьте DEEPSEEK_API_KEY в файл .env и перезапустите сервер.')

  const { model: requestModel, ...requestOptions } = options

  const deepSeekResponse = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: requestModel ?? model,
      messages,
      stream: false,
      thinking: { type: 'disabled' },
      ...requestOptions,
    }),
  })

  const data = (await deepSeekResponse.json()) as DeepSeekResponse

  if (!deepSeekResponse.ok) {
    throw new Error(data.error?.message || 'DeepSeek API вернул ошибку.')
  }

  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('DeepSeek API не вернул текст ответа.')

  const usage = data.usage
  const pricing = deepSeekPricing[requestModel ?? model]
  const promptTokens = usage?.prompt_tokens
  const completionTokens = usage?.completion_tokens
  const cacheHitTokens = usage?.prompt_cache_hit_tokens ?? 0
  const cacheMissTokens = usage?.prompt_cache_miss_tokens ?? Math.max((promptTokens ?? 0) - cacheHitTokens, 0)
  const costUsd = pricing && promptTokens !== undefined && completionTokens !== undefined
    ? (cacheHitTokens * pricing.cacheHitInput + cacheMissTokens * pricing.cacheMissInput + completionTokens * pricing.output) / 1_000_000
    : undefined

  return {
    content,
    tokens: completionTokens,
    promptTokens,
    totalTokens: usage?.total_tokens,
    costUsd,
  }
}

async function requestHuggingFaceCompletion(
  messages: ChatMessage[],
  modelName: string,
  options: { max_tokens?: number; temperature?: number } = {},
): Promise<CompletionResult> {
  if (!huggingFaceApiKey) throw new Error('Добавьте HUGGINGFACE_API_KEY в файл .env для запуска модели Hugging Face.')

  const huggingFaceResponse = await fetch('https://router.huggingface.co/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${huggingFaceApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelName,
      messages,
      stream: false,
      ...options,
    }),
  })

  const data = (await huggingFaceResponse.json()) as DeepSeekResponse

  if (!huggingFaceResponse.ok) {
    throw new Error(data.error?.message || 'Hugging Face API вернул ошибку.')
  }

  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('Hugging Face API не вернул текст ответа.')

  return {
    content,
    tokens: data.usage?.completion_tokens,
    promptTokens: data.usage?.prompt_tokens,
    totalTokens: data.usage?.total_tokens,
  }
}

const deepSeekPricing: Record<string, ModelPricing> = {
  'deepseek-v4-flash': { cacheHitInput: 0.0028, cacheMissInput: 0.14, output: 0.28 },
  'deepseek-v4-pro': { cacheHitInput: 0.003625, cacheMissInput: 0.435, output: 0.87 },
}

function sendContextDemoError(response: Response, error: unknown) {
  const status = error instanceof AgentError ? error.statusCode : 502
  response.status(status).json({
    error: error instanceof Error ? error.message : 'Не удалось выполнить операцию с агентом.',
  })
}

app.listen(port, () => {
  console.log(`API server is running at http://localhost:${port}`)
  console.log(`DeepSeek model: ${model}`)
})

function isChatMessageArray(value: unknown): value is ChatMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (message): message is ChatMessage =>
        typeof message === 'object' &&
        message !== null &&
        'role' in message &&
        'content' in message &&
        (message.role === 'system' || message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        message.content.trim().length > 0,
    )
  )
}
