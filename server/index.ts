import 'dotenv/config'
import express from 'express'

type ChatRole = 'system' | 'user' | 'assistant'

type ChatMessage = {
  role: ChatRole
  content: string
}

type DeepSeekResponse = {
  model?: string
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
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

const app = express()
const port = Number(process.env.PORT ?? 8787)
const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
const model = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash'

app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, configured: Boolean(apiKey), model })
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
  if (!apiKey) {
    response.status(503).json({
      error: 'Добавьте DEEPSEEK_API_KEY в файл .env и перезапустите сервер.',
    })
    return
  }

  const messages = request.body?.messages as unknown

  if (!isChatMessageArray(messages)) {
    response.status(400).json({
      error: 'Поле messages должно содержать непустой массив сообщений.',
    })
    return
  }

  try {
    const deepSeekResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        thinking: { type: 'disabled' },
      }),
    })

    if (!deepSeekResponse.ok) {
      const data = (await deepSeekResponse.json()) as DeepSeekResponse
      response.status(deepSeekResponse.status).json({
        error: data.error?.message || 'DeepSeek API вернул ошибку.',
      })
      return
    }

    if (!deepSeekResponse.body) {
      response.status(502).json({ error: 'DeepSeek API не вернул поток ответа.' })
      return
    }

    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.flushHeaders()

    const reader = deepSeekResponse.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue

        const payload = line.slice(6).trim()
        if (payload === '[DONE]') {
          response.end()
          return
        }

        const chunk = JSON.parse(payload) as DeepSeekStreamChunk
        const content = chunk.choices?.[0]?.delta?.content
        if (content) {
          response.write(`data: ${JSON.stringify({ content })}\n\n`)
        }
      }

      if (done) break
    }

    response.end()
  } catch (error) {
    console.error('DeepSeek request failed:', error)
    if (response.headersSent) {
      response.write(`data: ${JSON.stringify({ error: 'Поток ответа был прерван.' })}\n\n`)
      response.end()
    } else {
      response.status(502).json({
        error: 'Не удалось связаться с DeepSeek API. Проверьте подключение и ключ.',
      })
    }
  }
})

async function requestCompletion(
  messages: ChatMessage[],
  options: { max_tokens?: number; stop?: string[]; response_format?: { type: 'json_object' } } = {},
): Promise<{ content: string; tokens?: number }> {
  if (!apiKey) throw new Error('Добавьте DEEPSEEK_API_KEY в файл .env и перезапустите сервер.')

  const deepSeekResponse = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      thinking: { type: 'disabled' },
      ...options,
    }),
  })

  const data = (await deepSeekResponse.json()) as DeepSeekResponse

  if (!deepSeekResponse.ok) {
    throw new Error(data.error?.message || 'DeepSeek API вернул ошибку.')
  }

  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('DeepSeek API не вернул текст ответа.')

  return { content, tokens: data.usage?.completion_tokens }
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
