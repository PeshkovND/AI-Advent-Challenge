import { createHash } from 'node:crypto'
import { checkOptimizationAnswer, optimizationCases, optimizationProfiles, summarizeOptimization,
  type OptimizationAnswer, type OptimizationProfile, type OptimizationReport, type OptimizationStatus, type QaMaterial } from '../src/llm-optimization'

type Dependencies = { fetch?: typeof fetch; timeoutMs?: number }
export function optimizationSettings() {
  const base = new URL(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434')
  if (!['http:', 'https:'].includes(base.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password) throw new Error('Оптимизация требует loopback-адрес Ollama без авторизации.')
  return { base, model: process.env.OLLAMA_CHAT_MODEL || 'qwen3.5:4b', q8Model: process.env.OLLAMA_OPTIMIZATION_Q8_MODEL || 'qwen3.5:4b-q8_0' }
}
const sameName = (a: string, b: string) => a.replace(/:latest$/, '') === b.replace(/:latest$/, '')
async function ollamaJson(path: string, body: unknown | undefined, signal: AbortSignal | undefined, request: typeof fetch) {
  const timeout = AbortSignal.timeout(body === undefined ? 10000 : 300000)
  const response = await request(new URL(path, optimizationSettings().base), {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  const data = await response.json()
  if (!response.ok || data.error) throw new Error(`Ollama: ${data.error || response.status}`)
  return data
}
export async function optimizationStatus(dependencies: Dependencies = {}): Promise<OptimizationStatus> {
  const { model, q8Model } = optimizationSettings()
  try {
    const data = await ollamaJson('/api/tags', undefined, undefined, dependencies.fetch || fetch)
    const models = (data.models || []).map((item: { name: string; size: number; details?: { quantization_level?: string } }) => ({ name: item.name, size: item.size, quantization: item.details?.quantization_level || 'unknown' }))
    const ready = models.some((item: { name: string }) => sameName(item.name, model))
    return { model, q8Model, ready, q8Ready: models.some((item: { name: string }) => sameName(item.name, q8Model)), models, ...(!ready ? { error: `Загрузите модель: ollama pull ${model}` } : {}) }
  } catch (error) { return { model, q8Model, ready: false, q8Ready: false, models: [], error: error instanceof Error ? error.message : String(error) } }
}

export function validateOptimizationProfile(input: unknown): OptimizationProfile {
  const value = input as OptimizationProfile | undefined
  if (!value || !optimizationProfiles.some((item) => item.id === value.id) || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2
    || !Number.isSafeInteger(value.context) || value.context < 2048 || value.context > 32768
    || !Number.isSafeInteger(value.maxTokens) || value.maxTokens < 32 || value.maxTokens > 4096 || value.maxTokens + 512 >= value.context
    || typeof value.systemPrompt !== 'string' || !value.systemPrompt.trim() || value.systemPrompt.length > 6000) throw new Error('Проверьте temperature (0–2), контекст (2048–32768), ответ (32–4096) и prompt (до 6000 символов).')
  if (value.topP !== undefined && (!Number.isFinite(value.topP) || value.topP <= 0 || value.topP > 1)) throw new Error('top_p должен быть больше 0 и не больше 1.')
  if (value.adaptiveContext !== undefined && typeof value.adaptiveContext !== 'boolean') throw new Error('adaptiveContext должен быть boolean.')
  if (value.sourceLayout !== undefined && value.sourceLayout !== 'blocks') throw new Error('Неизвестный шаблон материалов.')
  return { ...value, label: optimizationProfiles.find((item) => item.id === value.id)!.label }
}
const conservativeInputBudget = (messages: { content: string }[]) => messages.reduce((n, item) => n + new TextEncoder().encode(item.content).length + 64, 0)
export function resolveOptimizationContext(messages: { content: string }[], profile: OptimizationProfile) {
  const required = conservativeInputBudget(messages) + profile.maxTokens + 512
  if (required > profile.context) throw new Error('Материалы превышают консервативный бюджет контекста. Сократите их или увеличьте окно. Текст не обрезается автоматически.')
  if (!profile.adaptiveContext) return profile.context
  return [2048, 4096, 8192, 16384, 32768, profile.context].sort((a, b) => a - b).find((size) => size >= required && size <= profile.context)!
}
export function optimizationMessages(question: string, materials: QaMaterial[], profile: OptimizationProfile) {
  if (typeof question !== 'string' || !question.trim() || question.length > 4000 || !Array.isArray(materials) || !materials.length || materials.length > 8
    || materials.some((item) => !item || typeof item.title !== 'string' || item.title.length > 200 || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 20000)) throw new Error('Нужны вопрос до 4000 символов и от 1 до 8 непустых материалов.')
  const sourceText = profile.sourceLayout === 'blocks'
    ? materials.map((item, index) => `Материал ${JSON.stringify({ id: index + 1, title: item.title })}\n${item.text.replace(/;[ \t]*/g, ';\n')}`).join('\n\n')
    : JSON.stringify(materials.map((item, index) => ({ id: index + 1, title: item.title, text: item.text })))
  const allowedSources = profile.sourceLayout === 'blocks' ? `\n\nДопустимые ссылки на материалы: ${materials.map((_item, index) => `[${index + 1}]`).join(', ')}. Других источников нет.` : ''
  const messages = [{ role: 'system', content: profile.systemPrompt }, { role: 'user', content: `Материалы${profile.sourceLayout === 'blocks' ? '' : ' (JSON)'}:\n${sourceText}${allowedSources}\n\nВопрос: ${question.trim()}\nОтветь кратко.` }]
  resolveOptimizationContext(messages, profile)
  return messages
}

async function generate(model: string, messages: { role: string; content: string }[], profile: OptimizationProfile, signal: AbortSignal | undefined, request: typeof fetch, timeoutMs = 300000): Promise<OptimizationAnswer> {
  signal?.throwIfAborted()
  const started = performance.now()
  const timeout = AbortSignal.timeout(timeoutMs)
  const response = await request(new URL('/api/chat', optimizationSettings().base), { method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    body: JSON.stringify({ model, messages, stream: true, think: false, keep_alive: '5m', options: { temperature: profile.temperature,
      num_ctx: profile.context, num_predict: profile.maxTokens, seed: 29, ...(profile.topP === undefined ? {} : { top_p: profile.topP }) } }),
  })
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`)
  if (!response.body) throw new Error('Ollama вернула пустой поток.')
  let content = '', buffer = '', firstTokenMs: number | undefined
  let final: Record<string, unknown> | undefined
  const consume = (line: string) => {
    if (!line.trim()) return
    const data = JSON.parse(line)
    if (data.error) throw new Error(String(data.error))
    if (data.message?.content) { firstTokenMs ??= performance.now() - started; content += data.message.content }
    if (data.done) final = data
  }
  const reader = response.body.getReader(), decoder = new TextDecoder()
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1) }
      if (done) { consume(buffer); break }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const wallMs = performance.now() - started
  if (!final || !content.trim()) throw new Error('Ответ пуст или поток прерван до финальных метрик.')
  const number = (key: string) => typeof final![key] === 'number' && Number.isFinite(final![key]) && (final![key] as number) >= 0 ? final![key] as number : undefined
  const ms = (key: string) => number(key) === undefined ? undefined : number(key)! / 1e6
  const outputTokens = number('eval_count'), generationMs = ms('eval_duration')
  const answer: OptimizationAnswer = { content, doneReason: String(final.done_reason || 'unknown'), metrics: { wallMs, firstTokenMs,
    loadMs: ms('load_duration'), promptMs: ms('prompt_eval_duration'), generationMs, promptTokens: number('prompt_eval_count'), outputTokens,
    tokensPerSecond: outputTokens !== undefined && generationMs ? outputTokens * 1000 / generationMs : undefined } }
  try {
    const ps = await ollamaJson('/api/ps', undefined, signal, request)
    const loaded = ps.models?.find((item: { name: string }) => sameName(item.name, model))
    if (loaded) { answer.metrics.modelMemoryBytes = loaded.size; answer.metrics.gpuMemoryBytes = loaded.size_vram; answer.metrics.loadedContext = loaded.context_length }
    else answer.metrics.memoryError = 'Модель отсутствует в снимке /api/ps.'
  } catch (error) { answer.metrics.memoryError = error instanceof Error ? error.message : String(error) }
  return answer
}
export async function answerOptimizedQuestion(question: string, materials: QaMaterial[], input: OptimizationProfile, signal?: AbortSignal, dependencies: Dependencies = {}) {
  const profile = validateOptimizationProfile(input)
  const messages = optimizationMessages(question, materials, profile)
  const settings = optimizationSettings()
  return generate(profile.id === 'q8' ? settings.q8Model : settings.model, messages, { ...profile, context: resolveOptimizationContext(messages, profile) }, signal, dependencies.fetch || fetch, dependencies.timeoutMs)
}

export async function benchmarkOptimization(options: { repetitions?: number; includeQ8?: boolean; signal?: AbortSignal; cases?: typeof optimizationCases; profiles?: OptimizationProfile[]; suiteId?: string; timeoutMs?: number;
  onProgress?: (report: OptimizationReport) => Promise<void> | void } = {}, dependencies: Dependencies = {}): Promise<OptimizationReport> {
  const repetitions = options.repetitions ?? 2
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error('Число повторов: от 1 до 5.')
  const request = dependencies.fetch || fetch, settings = optimizationSettings()
  const status = await optimizationStatus(dependencies)
  if (!status.ready) throw new Error(status.error || 'Модель не установлена.')
  if (options.includeQ8 && !status.q8Ready) throw new Error(`Q8 не установлена: ollama pull ${settings.q8Model}`)
  const cases = options.cases ?? optimizationCases
  const profiles = (options.profiles ?? optimizationProfiles.filter((item) => item.id !== 'q8' || options.includeQ8)).map((item) => ({ ...validateOptimizationProfile(item), model: item.id === 'q8' ? settings.q8Model : settings.model }))
  const report: OptimizationReport = { version: 1, ...(options.suiteId ? { suiteId: options.suiteId } : {}), startedAt: new Date().toISOString(), repetitions, cases,
    profiles, models: [], warmups: [], samples: [], summaries: [], notes: [
      'Вопросы независимы; одинаковые фиксированные фрагменты. Retrieval и облачные API не используются. Ожидаемые ответы и правила оценки не передаются модели.',
      'Перед каждым профилем/повтором модель выгружается и прогревается коротким отдельным запросом. Прогрев исключён из метрик ответов. Порядок профилей и вопросов обращается в чётных повторах.',
      'Память — снимок size и size_vram из /api/ps после ответа, не пиковый RSS и не общая память macOS. CPU/GPU load и системный swap этим отчётом не измеряются.',
      'Автопроверки ищут ключевые факты, ссылки, отказ, краткость и обрезку. Это не семантическая оценка: требуется чтение полных ответов.',
      'Seed=29, think=false, keep_alive=5m. Другие параметры берутся из установленного тега и сохранены в models.parameters. Малый набор не доказывает общее качество модели.',
      'При adaptiveContext окно выбирается по консервативному бюджету UTF-8 байтов, с резервом ответа и 512 токенов; все материалы сохраняются. Каждая смена окна предварительно прогревается. Фактическое окно записано в metrics.loadedContext.',
      `Таймаут отдельного измеряемого ответа — ${(options.timeoutMs ?? 60000) / 1000} секунд. Медиана относится к успешным ответам; ошибки и их длительность сохраняются отдельно.`,
    ] }
  const installed = await ollamaJson('/api/tags', undefined, options.signal, request)
  for (const name of [...new Set(profiles.map((item) => item.model))]) {
    const tag = installed.models.find((item: { name: string }) => sameName(item.name, name))
    const shown = await ollamaJson('/api/show', { model: name }, options.signal, request)
    report.models.push({ name, digest: tag.digest, size: tag.size, quantization: shown.details?.quantization_level || 'unknown',
      parameters: shown.parameters || '', templateHash: createHash('sha256').update(shown.template || '').digest('hex'),
      architecture: shown.model_info?.['general.architecture'], parameterCount: shown.model_info?.['general.parameter_count'] })
  }
  if (options.includeQ8) {
    const [baseModel, q8Model] = report.models
    if (!q8Model || baseModel.quantization !== 'Q4_K_M' || q8Model.quantization !== 'Q8_0'
      || !baseModel.architecture || baseModel.architecture !== q8Model.architecture || !baseModel.parameterCount || baseModel.parameterCount !== q8Model.parameterCount) throw new Error('Для сравнения квантования нужны Q4_K_M и Q8_0 одной архитектуры и числа параметров.')
    report.notes.push('Q4 и Q8 — установленные теги одной модели; digests различаются. Совпадение архитектуры, размера, шаблона и параметров не доказывает идентичность исходной ревизии весов; это сравнение доступных вариантов.')
  }
  const progress = async () => { report.summaries = summarizeOptimization(report.samples, profiles); await options.onProgress?.(report) }
  await progress()
  let previousModel: string | undefined
  try {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const profile of repetition % 2 ? profiles : [...profiles].reverse()) {
        options.signal?.throwIfAborted()
        if (previousModel && previousModel !== profile.model) await ollamaJson('/api/chat', { model: previousModel, messages: [], stream: false, keep_alive: 0 }, options.signal, request)
        await ollamaJson('/api/chat', { model: profile.model, messages: [], stream: false, keep_alive: 0 }, options.signal, request)
        previousModel = profile.model
        const orderedCases = repetition % 2 ? cases : [...cases].reverse()
        let activeContext = profile.context
        if (profile.adaptiveContext && orderedCases.length) {
          try { activeContext = resolveOptimizationContext(optimizationMessages(orderedCases[0].question, orderedCases[0].materials, profile), profile) }
          catch { /* The case itself records budget validation errors below. */ }
        }
        const started = performance.now()
        let warmupError: string | undefined
        try { await generate(profile.model, [{ role: 'user', content: 'Ответь одним словом: готов.' }], { ...profile, context: activeContext, maxTokens: 8 }, options.signal, request) }
        catch (error) { options.signal?.throwIfAborted(); warmupError = error instanceof Error ? error.message : String(error) }
        report.warmups.push({ profileId: profile.id, repetition, context: activeContext, wallMs: performance.now() - started, ...(warmupError ? { error: warmupError } : {}) })
        for (const test of orderedCases) {
          options.signal?.throwIfAborted()
          let started = performance.now()
          try {
            if (warmupError) throw new Error(`Прогрев не выполнен: ${warmupError}`)
            if (profile.adaptiveContext) {
              const context = resolveOptimizationContext(optimizationMessages(test.question, test.materials, profile), profile)
              if (context !== activeContext) {
                const warming = performance.now()
                try {
                  await generate(profile.model, [{ role: 'user', content: 'Ответь одним словом: готов.' }], { ...profile, context, maxTokens: 8 }, options.signal, request)
                  activeContext = context
                  report.warmups.push({ profileId: profile.id, repetition, caseId: test.id, context, wallMs: performance.now() - warming })
                } catch (error) {
                  report.warmups.push({ profileId: profile.id, repetition, caseId: test.id, context, wallMs: performance.now() - warming, error: error instanceof Error ? error.message : String(error) })
                  throw error
                }
              }
            }
            started = performance.now()
            const answer = await answerOptimizedQuestion(test.question, test.materials, profile, options.signal, { ...dependencies, timeoutMs: options.timeoutMs ?? 60000 })
            report.samples.push({ profileId: profile.id, caseId: test.id, repetition, answer, quality: checkOptimizationAnswer(test, answer.content, answer.doneReason) })
          } catch (error) { options.signal?.throwIfAborted(); report.samples.push({ profileId: profile.id, caseId: test.id, repetition, error: error instanceof Error ? error.message : String(error), errorMs: performance.now() - started }) }
          await progress()
        }
      }
    }
    report.finishedAt = new Date().toISOString()
  } catch (error) {
    if (!options.signal?.aborted) throw error
    report.cancelled = true
    report.notes.push('Прогон остановлен: показаны только завершённые запросы.')
  } finally { await progress() }
  return report
}
