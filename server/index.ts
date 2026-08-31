import 'dotenv/config'
import express from 'express'

type ChatRole = 'system' | 'user' | 'assistant'

type ChatMessage = {
  role: ChatRole
  content: string
}

type DeepSeekResponse = {
  model?: string
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

const app = express()
const port = Number(process.env.PORT ?? 8787)
const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
const model = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash'

app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, configured: Boolean(apiKey), model })
})

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
