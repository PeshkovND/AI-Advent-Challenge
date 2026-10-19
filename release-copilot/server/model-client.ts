export type Completion = (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, stage: 'rewrite' | 'rerank' | 'answer' | 'verify' | 'memory') => Promise<{ content: string; usage: { inputTokens: number; promptTokens: number; completionTokens: number; totalTokens: number } }>
export class ModelRequestError extends Error {}

export function releaseModelSettings() {
  const base = new URL(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434')
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Для Ollama нужен loopback-адрес.')
  const context = Number(process.env.RELEASE_CONTEXT || 32768), maxTokens = Number(process.env.RELEASE_MAX_TOKENS || 4096)
  if (![context, maxTokens].every((n) => Number.isSafeInteger(n) && n > 0) || context > 131072 || maxTokens + 512 >= context) throw new Error('Некорректный бюджет контекста Release Copilot.')
  return { base, context, maxTokens, model: process.env.RELEASE_LOCAL_MODEL || 'qwen3.5:9b', cloudModel: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash' }
}

/** Standalone transport; no chat history, SQLite, MCP servers or other application services. */
export function modelClient(provider: 'local' | 'cloud', signal?: AbortSignal, request: typeof fetch = fetch, options: { localModel?: string; jsonSchema?: Record<string, unknown>; maxTokens?: number } = {}) {
  const settings = { ...releaseModelSettings(), ...(options.localModel ? { model: options.localModel } : {}), ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}) }
  if (!Number.isSafeInteger(settings.maxTokens) || settings.maxTokens < 1 || provider === 'local' && settings.maxTokens + 512 >= settings.context) throw new Error('Некорректный бюджет ответа модели.')
  const stats = { model: provider === 'local' ? settings.model : settings.cloudModel, calls: 0, promptTokens: 0, outputTokens: 0 }
  const generate = async (messages: Parameters<Completion>[0], schema?: Record<string, unknown>) => {
    signal?.throwIfAborted()
    const prompt = provider === 'cloud' && schema
      ? [...messages, { role: 'system' as const, content: `Ответ должен соответствовать JSON Schema целиком, включая required, additionalProperties и ограничения длины/числа элементов:\n${JSON.stringify(schema)}` }]
      : messages
    const byteEstimate = prompt.reduce((n, item) => n + Buffer.byteLength(item.content) + 64, 0)
    // num_ctx is an Ollama setting. Do not apply this local budget to DeepSeek.
    // Send complete input to the cloud; its API enforces the actual model context window.
    if (provider === 'local' && byteEstimate + settings.maxTokens + 512 > settings.context) throw new ModelRequestError('Полный файл не помещается в контекст локальной модели. Увеличьте RELEASE_CONTEXT или выберите DeepSeek. Файл не обрезан.')
    const timeout = AbortSignal.timeout(300000), requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    stats.calls++
    let content: string, input: number, output: number
    if (provider === 'local') {
      const response = await request(new URL('/api/chat', settings.base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: requestSignal,
        body: JSON.stringify({ model: settings.model, messages: prompt, format: schema || 'json', think: false, stream: false, keep_alive: '60s', options: { num_ctx: settings.context, num_predict: settings.maxTokens, temperature: 0 } }) })
      const data = await response.json()
      if (!response.ok || data.error) throw new Error('Ollama недоступна или отклонила запрос.')
      content = data.message?.content; input = data.prompt_eval_count || 0; output = data.eval_count || 0
      stats.promptTokens += input; stats.outputTokens += output
      if (data.done_reason === 'length') throw new ModelRequestError('Ответ модели не завершён. Увеличьте RELEASE_MAX_TOKENS и повторите анализ.')
    } else {
      const key = process.env.DEEPSEEK_API_KEY?.trim()
      if (!key) throw new Error('Ключ DeepSeek не настроен.')
      const response = await request('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, signal: requestSignal,
        body: JSON.stringify({ model: settings.cloudModel, messages: prompt, thinking: { type: 'disabled' }, stream: false, response_format: { type: 'json_object' }, temperature: 0, max_tokens: settings.maxTokens }) })
      const data = await response.json()
      if (!response.ok || data.error) throw new Error('DeepSeek недоступен или отклонил запрос.')
      content = data.choices?.[0]?.message?.content; input = data.usage?.prompt_tokens || 0; output = data.usage?.completion_tokens || 0
      stats.promptTokens += input; stats.outputTokens += output
      if (data.choices?.[0]?.finish_reason === 'length') throw new ModelRequestError('Ответ модели не завершён. Увеличьте RELEASE_MAX_TOKENS и повторите анализ.')
    }
    if (typeof content !== 'string' || !content.trim()) throw new Error('Модель вернула пустой ответ.')
    return { content, usage: { inputTokens: byteEstimate, promptTokens: input, completionTokens: output, totalTokens: input + output } }
  }
  const complete: Completion = async (messages, stage) => {
    if (provider !== 'local' || stage !== 'verify') return generate(messages, options.jsonSchema)
    const data = JSON.parse(messages[messages.length - 1].content) as { claims: Array<{ claimId: number }> }
    const keys = data.claims.map((claim) => String(claim.claimId))
    const judgment = { type: 'object', properties: { supported: { type: 'boolean' }, reason: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['supported', 'reason'], additionalProperties: false }
    const schema = { type: 'object', properties: { items: { type: 'object', properties: Object.fromEntries(keys.map((key) => [key, judgment])), required: keys, additionalProperties: false } }, required: ['items'], additionalProperties: false }
    const prompt = messages.map((item, index) => index === 0 ? { ...item, content: item.content.split('Верни только JSON:')[0] + `Верни только JSON с объектом items. Его ключи — claimId: ${keys.join(', ')}. Значения: {"supported":true,"reason":"краткое обоснование"}. Оцени каждый пункт ровно один раз. Не возвращай массив.` } : item)
    const response = await generate(prompt, schema)
    const parsed = JSON.parse(response.content)
    if (!parsed.items || typeof parsed.items !== 'object' || Array.isArray(parsed.items) || Object.keys(parsed.items).length !== keys.length || keys.some((key) => !Object.hasOwn(parsed.items, key))) throw new Error('Не получена проверка каждого пункта.')
    return { ...response, content: JSON.stringify({ items: data.claims.map(({ claimId }) => ({ claimId, ...parsed.items[String(claimId)] })) }) }
  }
  return { complete, stats }
}
