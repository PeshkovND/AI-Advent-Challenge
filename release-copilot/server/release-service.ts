import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { GitRepository, collectGitContext } from './git-context'
import { analyzeReleaseFile, ReleaseAnalysisError, releaseAnalysisSchema } from './release-analysis'
import { releaseModelSettings, modelClient, ModelRequestError } from './model-client'
import { groundingSchema } from './grounding'
import { analyzeImpact, impactSchema, pendingImpact } from './release-impact'
import { collectImpactContext } from './release-relations'
import { releaseChecks, releaseRiskId } from '../src/release-types'
import type { Completion } from './model-client'
import type { ReleaseArtifacts, ReleaseProvider, ReleaseRepositoryInfo, ReleaseRun } from '../src/release-types'

export class ReleaseError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}
const ref = z.string().trim().min(1).max(200).refine((value) => !value.startsWith('-') && !/[\x00-\x20\x7f]/.test(value))
export const releaseInputSchema = z.object({ projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  baseRef: ref, headRef: ref, version: z.string().trim().min(1).max(80), provider: z.enum(['local', 'cloud']).default('local') }).strict()
const busyStates = new Set(['queued', 'collecting', 'analyzing'])
const artifactStates = new Set(['awaiting_checks', 'ready'])
const safe = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#!|~])/g, '\\$1')

export async function releaseRepositoryInfo(root: string): Promise<ReleaseRepositoryInfo> {
  const repository = new GitRepository(root)
  try {
    const head = await repository.commit('HEAD')
    const allRefs = (await repository.git(['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)', 'refs/tags', 'refs/heads', 'refs/remotes'])).trim().split('\n').filter(Boolean)
    const tags = (await repository.git(['tag', '--merged', head, '--sort=-version:refname'])).trim().split('\n').filter(Boolean)
    let suggestedBase = tags.find((tag) => tag !== 'HEAD') || 'HEAD~1'
    try { if (await repository.commit(suggestedBase) === head) suggestedBase = 'HEAD~1'; await repository.commit(suggestedBase) }
    catch { suggestedBase = 'HEAD' }
    const dirty = Boolean((await repository.git(['status', '--porcelain', '--untracked-files=no'])).trim())
    return { head, refs: ['HEAD', ...allRefs.slice(0, 200)], refsTruncated: allRefs.length > 200, suggestedBase, dirty }
  } catch { throw new ReleaseError('Не удалось прочитать Git. Выберите репозиторий с коммитами.', 422) }
}

export function releaseArtifacts(run: ReleaseRun): ReleaseArtifacts {
  const intro = `Проект: ${safe(run.projectName)} · версия: ${safe(run.version)}\n\nДиапазон: ${run.base} → ${run.head}\n\n`
  const evidenceText = (file: Pick<ReleaseRun['files'][number], 'evidence'>, ids: string[]) => ids.map((id) => {
    const item = file.evidence.find((entry) => entry.id === id)!
    return `${safe(item.path)}${item.line ? `:${item.line}` : ''} (${item.commit.slice(0, 8)}${item.side ? `, ${item.side}` : ''}): ${safe(item.quote)}`
  }).join('\n\n')
  const notes = run.files.map((file) => file.userNote).filter(Boolean)
  const internal = run.files.map((file) => `## ${safe(file.path)}\n\n${safe(file.summary.text)}\n\n${evidenceText(file, file.summary.evidenceIds)}\n\n${file.risks.map((risk) => `Потенциальный риск (${risk.severity}): ${safe(risk.text)}\n\n${evidenceText(file, risk.evidenceIds)}`).join('\n\n')}`).join('\n\n')
  const checks = run.files.flatMap((file) => file.checks.map((check) => `## ${safe(check.text)}\n\nСтатус: ${check.status}\n\n${check.steps.map((step, index) => `${index + 1}. ${safe(step)}`).join('\n')}\n\nОжидается: ${safe(check.expected)}\n\nЗаметка: ${safe(check.note) || '—'}\n\n${evidenceText(file, check.evidenceIds)}`))
  const impact = run.impact
  const impactText = impact?.state === 'complete'
    ? `Метод: поиск прямых связей по символам и импортам (эвристика, не компилятор). Просмотрено ${impact.scannedFiles} файлов, рассмотрено ${impact.files.length}, связей ${impact.relations.length}.\n\n${impact.summary ? safe(impact.summary.text) + '\n\n' + evidenceText(impact, impact.summary.evidenceIds) : 'Прямые связи с изменёнными файлами не обнаружены этим методом.'}\n\n${impact.findings.map((finding) => `### ${safe(finding.title)} (${finding.status})\n\n${safe(finding.text)}\n\n${evidenceText(impact, finding.evidenceIds)}`).join('\n\n')}\n\n${impact.riskReviews.map((review) => {
      const original = run.files.flatMap((file) => file.risks.map((risk, index) => ({ id: releaseRiskId(file.path, index), text: risk.text }))).find(({ id }) => id === review.riskId)
      return `Гипотеза: ${safe(original?.text || review.riskId)}\n\nОценка (${review.verdict}): ${safe(review.reason)}\n\n${evidenceText(impact, review.evidenceIds)}`
    }).join('\n\n')}`
    : impact?.error ? safe(impact.error) : 'Проверка связей не выполнена.'
  for (const check of impact?.checks || []) checks.push(`## Связанные файлы: ${safe(check.text)}\n\nСтатус: ${check.status}\n\n${check.steps.map((step, index) => `${index + 1}. ${safe(step)}`).join('\n')}\n\nОжидается: ${safe(check.expected)}\n\nЗаметка: ${safe(check.note) || '—'}\n\n${evidenceText(impact!, check.evidenceIds)}`)
  return {
    'release-notes.md': `# Что нового в ${safe(run.version)}\n\nЧерновик AI для проверки перед публикацией.\n\n${notes.length ? notes.map((note) => `- ${safe(note)}`).join('\n') : 'Подтверждённых пользовательских изменений в рассмотренных фрагментах не выделено.'}\n`,
    'changelog.md': `# Изменения релиза\n\n${intro}Покрытие: ${run.coverage}. Проанализировано ${run.files.length}/${run.totalFiles} файлов.\n\nИнтерпретации AI требуют проверки разработчиком. Код проверяет источники и цитаты, отдельный вызов модели проверяет смысл выводов. Модельная проверка может ошибаться.\n\n${internal}\n\n## Влияние на связанные файлы\n\n${impactText}\n\n## Ограничения\n\n${[...run.skipped.map((item) => `${item.path}: ${item.reason}`), ...run.fileErrors.map((item) => `${item.path}: ${item.error}`), ...run.files.filter((file) => file.limited).map((file) => `${file.path}: ограничен diff или контекст файла`), ...(run.corpusLimited ? ['Корпус контекста ограничен.'] : []), ...(impact?.error ? [impact.error] : [])].map((item) => `- ${safe(item)}`).join('\n') || 'В рамках настроенных лимитов.'}\n`,
    'test-plan.md': `# План ручных проверок\n\n${intro}Сценарии предложены AI. Приложение не выполняет их автоматически.\n\n${checks.join('\n\n')}\n`,
    'readiness.json': JSON.stringify({ id: run.id, project: run.projectName, version: run.version, base: run.base, head: run.head,
      state: run.state, coverage: run.coverage, reviewed: run.reviewed, totalFiles: run.totalFiles, analyzedFiles: run.files.length,
      checks: releaseChecks(run).map(({ id, status, note }) => ({ id, status, note })), impact: impact || { state: 'not_run' },
      skipped: run.skipped, fileErrors: run.fileErrors, limitedFiles: run.files.filter((file) => file.limited).map((file) => file.path), corpusLimited: run.corpusLimited,
      model: run.model, provider: run.provider, metrics: run.metrics, updatedAt: run.updatedAt,
      meaning: 'ready означает готовность пакета материалов после ручной проверки, а не публикацию или гарантию качества приложения.',
    }, null, 2) + '\n',
  }
}

type Options = { directory?: string; model?: (provider: ReleaseProvider, signal: AbortSignal, purpose: 'analysis' | 'verification' | 'impact' | 'impact-verification') => { complete: Completion; stats: { model: string; calls: number; promptTokens: number; outputTokens: number } } }

/** One bounded background worker; persisted snapshots survive closing the browser. */
export class ReleaseService {
  readonly directory: string
  private active?: { id: string; abort: AbortController; done: Promise<void> }
  private stopped = true
  constructor(private readonly options: Options = {}) { this.directory = options.directory || resolve(process.cwd(), 'data/release-runs') }
  private path(id: string) {
    if (!z.uuid().safeParse(id).success) throw new ReleaseError('Неверный ID запуска.')
    return resolve(this.directory, id, 'run.json')
  }
  get(id: string): ReleaseRun {
    try { return JSON.parse(readFileSync(this.path(id), 'utf8')) }
    catch (error) { if (error instanceof ReleaseError) throw error; throw new ReleaseError('Запуск не найден или повреждён.', 404) }
  }
  list(projectId?: string) {
    mkdirSync(this.directory, { recursive: true })
    return readdirSync(this.directory).filter((id) => z.uuid().safeParse(id).success).flatMap((id) => {
      try { const run = this.get(id); return !projectId || run.projectId === projectId ? [run] : [] } catch { return [] }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  private save(run: ReleaseRun) {
    run.updatedAt = new Date().toISOString()
    const path = this.path(run.id), directory = resolve(this.directory, run.id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temp = `${path}.tmp`
    writeFileSync(temp, JSON.stringify(run, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, path)
    if (artifactStates.has(run.state)) {
      for (const [name, content] of Object.entries(releaseArtifacts(run))) {
        const target = resolve(directory, name)
        writeFileSync(`${target}.tmp`, content, { mode: 0o600 }); renameSync(`${target}.tmp`, target)
      }
    }
  }
  start() {
    if (!this.stopped) return
    this.stopped = false
    for (const run of this.list()) if (run.state === 'analyzing' || run.state === 'collecting') {
      run.state = 'failed'; run.error = 'Сервер остановился во время анализа. Повторите запуск: закреплённые SHA сохранятся.'; run.progress = 'Запуск прерван'; this.save(run)
    }
    this.kick()
  }
  async stop() {
    this.stopped = true; this.active?.abort.abort(); await this.active?.done
  }
  async create(input: z.infer<typeof releaseInputSchema>, project: { root: string; name: string }) {
    if (this.list().filter((run) => busyStates.has(run.state)).length >= 20) throw new ReleaseError('Очередь заполнена. Дождитесь завершения запусков.', 409)
    const repository = new GitRepository(project.root)
    let base: string, head: string
    try { base = await repository.commit(input.baseRef); head = await repository.commit(input.headRef) }
    catch { throw new ReleaseError('Не найден базовый или целевой commit. Проверьте Git ref.', 422) }
    if (base === head) throw new ReleaseError('Выберите разные коммиты для сравнения.', 422)
    const now = new Date().toISOString()
    const run: ReleaseRun = { ...input, id: randomUUID(), projectName: project.name, root: project.root, base, head,
      model: '', createdAt: now, updatedAt: now, state: 'queued', progress: 'В очереди', totalFiles: 0, files: [], skipped: [], fileErrors: [],
      corpusDocuments: 0, corpusLimited: false, coverage: 'pending', reviewed: false, impact: pendingImpact(), analysisMode: 'full', metrics: { calls: 0, promptTokens: 0, outputTokens: 0, durationMs: 0 } }
    this.save(run); this.kick(); return run
  }
  cancel(id: string) {
    const run = this.get(id)
    if (!busyStates.has(run.state)) throw new ReleaseError('Запуск уже завершён.', 409)
    this.active?.id === id && this.active.abort.abort()
    run.state = 'cancelled'; run.progress = 'Отменён пользователем'; this.save(run); return run
  }
  retry(id: string) {
    const run = this.get(id)
    if (!['failed', 'cancelled', 'awaiting_checks'].includes(run.state) || this.active?.id === id) throw new ReleaseError('Повтор пока недоступен.', 409)
    run.state = 'queued'; run.progress = 'Повтор в очереди'; delete run.error
    run.files = []; run.fileErrors = []; run.skipped = []; run.totalFiles = 0; run.coverage = 'pending'; run.reviewed = false
    run.metrics = { calls: 0, promptTokens: 0, outputTokens: 0, durationMs: 0 }
    run.impact = pendingImpact(); run.analysisMode = 'full'
    this.save(run)
    for (const name of ['release-notes.md', 'changelog.md', 'test-plan.md', 'readiness.json']) rmSync(resolve(this.directory, run.id, name), { force: true })
    this.kick(); return run
  }
  checkImpact(id: string) {
    const run = this.get(id)
    if (!artifactStates.has(run.state) || !run.files.length || this.active?.id === id) throw new ReleaseError('Дождитесь материалов перед проверкой связей.', 409)
    if (this.list().filter((item) => busyStates.has(item.state)).length >= 20) throw new ReleaseError('Очередь заполнена.', 409)
    run.analysisMode = 'impact'; run.impact = pendingImpact(); run.reviewed = false; run.coverage = 'pending'
    run.state = 'queued'; run.progress = 'Проверка связей в очереди'; delete run.error
    this.save(run); this.kick(); return run
  }
  update(id: string, update: { reviewed?: boolean; checkId?: string; status?: 'pending' | 'passed' | 'failed'; note?: string }) {
    const run = this.get(id)
    if (!artifactStates.has(run.state)) throw new ReleaseError('Дождитесь завершения анализа.', 409)
    if (update.reviewed !== undefined) run.reviewed = update.reviewed
    if (update.checkId) {
      const check = releaseChecks(run).find((check) => check.id === update.checkId)
      if (!check) throw new ReleaseError('Проверка не найдена.', 404)
      if (update.status) check.status = update.status
      if (update.note !== undefined) check.note = update.note
    }
    const checks = releaseChecks(run)
    run.state = run.reviewed && run.coverage === 'complete' && (!run.impact || run.impact.state === 'complete') && checks.length > 0 && checks.every((check) => check.status === 'passed') ? 'ready' : 'awaiting_checks'
    run.progress = run.state === 'ready' ? 'Материалы проверены, пакет готов' : 'Материалы готовы к ручной проверке'
    this.save(run); return run
  }
  artifacts(id: string) {
    const run = this.get(id)
    if (!artifactStates.has(run.state)) throw new ReleaseError('Материалы ещё не готовы.', 409)
    return releaseArtifacts(run)
  }
  private kick() {
    if (this.stopped || this.active) return
    const run = this.list().reverse().find((run) => run.state === 'queued')
    if (!run) return
    const abort = new AbortController()
    const done = Promise.resolve().then(() => this.process(run, abort.signal)).finally(() => { this.active = undefined; this.kick() })
    this.active = { id: run.id, abort, done }
  }
  private async process(run: ReleaseRun, signal: AbortSignal) {
    const started = Date.now()
    const previous = run.analysisMode === 'impact' ? { ...run.metrics } : { calls: 0, promptTokens: 0, outputTokens: 0, durationMs: 0 }
    const allStats: Array<{ calls: number; promptTokens: number; outputTokens: number }> = [previous]
    const metrics = () => { run.metrics = { calls: allStats.reduce((n, stats) => n + stats.calls, 0), promptTokens: allStats.reduce((n, stats) => n + stats.promptTokens, 0), outputTokens: allStats.reduce((n, stats) => n + stats.outputTokens, 0), durationMs: previous.durationMs + Date.now() - started } }
    try {
      signal.throwIfAborted()
      run.state = 'collecting'; run.progress = 'Читаем diff и контекст из Git'; this.save(run)
      const context = await collectGitContext(run.root, run.base, run.head, signal, 'direct')
      signal.throwIfAborted()
      run.totalFiles = context.totalFiles; run.skipped = context.skipped; run.corpusDocuments = context.corpusDocuments; run.corpusLimited = context.corpusTruncated
      if (!context.totalFiles) throw new ReleaseError('Между выбранными коммитами нет изменений файлов.', 422)
      if (!context.files.length) throw new ReleaseError('В диапазоне нет поддерживаемых текстовых файлов. Проверьте список пропусков.', 422)
      const localModel = process.env.RELEASE_LOCAL_MODEL || 'qwen3.5:9b'
      if (run.analysisMode !== 'impact') {
      const client = this.options.model?.(run.provider, signal, 'analysis') || modelClient(run.provider, signal, fetch, { localModel, jsonSchema: z.toJSONSchema(releaseAnalysisSchema) })
      const verifier = this.options.model?.(run.provider, signal, 'verification') || modelClient(run.provider, signal, fetch, { localModel, jsonSchema: z.toJSONSchema(groundingSchema) })
      allStats.push(client.stats, verifier.stats); run.model = client.stats.model; run.state = 'analyzing'
      for (const [index, file] of context.files.entries()) {
        signal.throwIfAborted()
        run.progress = `${index + 1}/${context.files.length}: ${file.path}`; metrics(); this.save(run)
        try { run.files.push(await analyzeReleaseFile(file, context, client.complete, signal, verifier.complete)) }
        catch (error) {
          signal.throwIfAborted()
          run.fileErrors.push({ path: file.path,
            error: error instanceof ReleaseAnalysisError || error instanceof ModelRequestError ? error.message : 'Не получен анализ с корректными ссылками. Проверьте доступность модели и повторите.',
            ...(error instanceof ReleaseAnalysisError ? { diagnostics: error.diagnostics } : {}) })
        }
        metrics(); this.save(run)
      }
      }
      signal.throwIfAborted()
      if (!run.files.length) throw new ReleaseError('Не получены проверенные материалы. Откройте причины отказа в ограничениях и повторите анализ.', 502)
      run.state = 'analyzing'; run.progress = 'Ищем связанные файлы в двух снимках Git'; run.impact = { ...pendingImpact(), state: 'analyzing' }; this.save(run)
      try {
        const impactContext = await collectImpactContext(run.root, context, signal)
        run.impact.files = impactContext.files; run.impact.scannedFiles = impactContext.scannedFiles; run.impact.relations = impactContext.relations
        run.progress = `Проверяем взаимодействия: ${impactContext.files.length} файлов, ${impactContext.relations.length} связей`; this.save(run)
        const client = this.options.model?.(run.provider, signal, 'impact') || modelClient(run.provider, signal, fetch, { localModel, jsonSchema: z.toJSONSchema(impactSchema), maxTokens: run.provider === 'cloud' ? 16384 : 4096 })
        const verifier = this.options.model?.(run.provider, signal, 'impact-verification') || modelClient(run.provider, signal, fetch, { localModel, jsonSchema: z.toJSONSchema(groundingSchema), maxTokens: run.provider === 'cloud' ? 16384 : 4096 })
        allStats.push(client.stats, verifier.stats)
        run.impact = await analyzeImpact(impactContext, run.files, client.complete, verifier.complete, signal)
      } catch (error) {
        signal.throwIfAborted()
        run.impact = { ...run.impact, state: 'failed', error: error instanceof ReleaseAnalysisError || error instanceof ModelRequestError ? error.message : 'Не удалось проверить связанные файлы. Проверьте модель и повторите проверку связей.', ...(error instanceof ReleaseAnalysisError ? { diagnostics: error.diagnostics } : {}) }
      }
      signal.throwIfAborted()
      run.coverage = run.skipped.length || run.fileErrors.length || run.files.some((file) => file.limited) || run.corpusLimited || run.impact.state !== 'complete' ? 'partial' : 'complete'
      run.state = 'awaiting_checks'; run.progress = 'Материалы готовы к ручной проверке'; metrics(); this.save(run)
    } catch (error) {
      if (this.get(run.id).state === 'cancelled') return
      metrics(); run.state = 'failed'; run.progress = 'Анализ прерван'
      run.error = signal.aborted ? 'Анализ прерван остановкой сервера. Можно повторить с теми же SHA.'
        : error instanceof ReleaseError ? error.message : 'Не удалось собрать данные Git или обратиться к модели. Проверьте репозиторий и настройки провайдера.'
      this.save(run)
    }
  }
}

export function releaseModels() {
  const settings = releaseModelSettings()
  return { localModel: process.env.RELEASE_LOCAL_MODEL || 'qwen3.5:9b', cloudModel: settings.cloudModel, cloudAvailable: Boolean(process.env.DEEPSEEK_API_KEY?.trim()) }
}
