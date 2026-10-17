export class SupportError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export class SupportGenerationError extends SupportError {
  constructor(readonly code: 'answer_style' | 'citation_format' | 'model_format' | 'provider' | 'context_limit' | 'timeout' | 'internal', readonly stage: string, readonly cause: unknown) {
    const messages = {
      answer_style: 'Модель не смогла оформить краткий ответ после исправления. Вопрос сохранён — повторите ответ.',
      citation_format: 'Модель вернула некорректные ссылки на источники. Ответ не сохранён — повторите попытку.',
      model_format: 'Модель вернула некорректный формат ответа или проверки. Вопрос сохранён — повторите ответ.',
      provider: 'Не удалось выполнить запрос к выбранной модели. Вопрос сохранён — проверьте подключение и повторите ответ.',
      context_limit: 'Запрос превысил доступный контекст модели. Сократите обращение или увеличьте лимит контекста.',
      timeout: 'Модель не успела ответить за отведённое время. Вопрос сохранён — повторите ответ.',
      internal: 'Не удалось завершить обработку ответа. Вопрос сохранён — повторите попытку.',
    }
    super(messages[code], 502)
    this.name = 'SupportGenerationError'
    Object.defineProperty(this, 'cause', { value: cause, enumerable: false })
  }
}

/** Persist an allowlisted explanation, never provider payloads, prompts or credentials. */
export function supportGenerationFailure(error: unknown, stage: string): SupportError {
  if (error instanceof SupportError) return error
  const messages: string[] = []
  let current = error, invalidFormat = false
  for (let depth = 0; depth < 4 && current instanceof Error; depth++, current = (current as Error & { cause?: unknown }).cause) {
    messages.push(current.message); invalidFormat ||= current instanceof SyntaxError || current.name === 'ZodError'
  }
  const detail = messages[messages.length - 1] || ''
  const code = /Сократи ответ клиенту|Обратись прямо к клиенту|Убери внутренние классы/.test(detail) ? 'answer_style'
    : /Цитата|Цитаты|цитат|Unknown evidence ID|context evidence/.test(detail) ? 'citation_format'
    : /контекст|context budget/i.test(detail) ? 'context_limit'
    : /timeout|timed out|aborted/i.test(detail) ? 'timeout'
    : /DeepSeek:|Ollama:|fetch failed|ECONN/i.test(detail) ? 'provider'
    : invalidFormat || /JSON|формат|проверяющ|соответствие ответа/.test(detail) ? 'model_format'
    : 'internal'
  return new SupportGenerationError(code, stage, error)
}
