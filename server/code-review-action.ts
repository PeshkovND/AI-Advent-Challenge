import './network-config'
import { execFile } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { CodeReviewAssistant, renderReview, reviewComment } from './code-review'
import { collectReviewContext, retrieveReviewSources, ReviewRepository } from './code-review-context'
import type { RagCompletion } from './rag-retrieval'
import { ActionError, publishInlineReview, publishReviewComment, type InlinePublication } from './code-review-github'
export { ActionError, publishReviewComment, publishInlineReview } from './code-review-github'

const execute = promisify(execFile)
const sha = z.string().regex(/^[a-f0-9]{40,64}$/)
const repositoryName = z.string().regex(/^[\w.-]+\/[\w.-]+$/)
const eventSchema = z.object({
  number: z.number().int().positive(), repository: z.object({ full_name: repositoryName }),
  pull_request: z.object({ number: z.number().int().positive(),
    head: z.object({ sha }), base: z.object({ sha, repo: z.object({ full_name: repositoryName }) }),
  }),
})
type PrEvent = z.infer<typeof eventSchema>
type Environment = NodeJS.ProcessEnv
type Dependencies = { complete?: RagCompletion; request?: typeof fetch }

function flag(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === '') return fallback
  if (value !== 'true' && value !== 'false') throw new ActionError('Boolean inputs must be true or false.')
  return value === 'true'
}
export function actionSettings(env: Environment) {
  if (!env.GITHUB_WORKSPACE || !env.RUNNER_TEMP) throw new ActionError('GITHUB_WORKSPACE and RUNNER_TEMP are required.')
  const workspace = realpathSync(env.GITHUB_WORKSPACE)
  const root = realpathSync(resolve(workspace, env.REVIEW_REPOSITORY_PATH || '.'))
  const path = relative(workspace, root)
  if (isAbsolute(path) || path === '..' || path.startsWith('../') || path.startsWith('..\\')) throw new ActionError('repository-path must stay within github.workspace.')
  const prepareOnly = flag(env.REVIEW_PREPARE_ONLY, false)
  const publish = !prepareOnly && flag(env.REVIEW_PUBLISH_COMMENT, true)
  let event: PrEvent | undefined
  if (env.GITHUB_EVENT_NAME === 'pull_request_target') {
    event = eventSchema.parse(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH!, 'utf8')))
    if (event.repository.full_name !== env.GITHUB_REPOSITORY || event.pull_request.base.repo.full_name !== env.GITHUB_REPOSITORY || event.number !== event.pull_request.number) {
      throw new ActionError('PR event does not match the target repository.')
    }
  } else if (publish) throw new ActionError('Comment publication requires pull_request_target. Set publish-comment: false for other events.')
  const base = env.REVIEW_BASE || event?.pull_request.base.sha
  const head = env.REVIEW_HEAD || event?.pull_request.head.sha
  if (!base || !head) throw new ActionError('Provide base/head inputs or run on pull_request_target.')
  if (publish && (base !== event!.pull_request.base.sha || head !== event!.pull_request.head.sha)) throw new ActionError('Published review must use the exact base/head SHAs from the PR event.')
  const key = env.REVIEW_API_KEY?.trim()
  if (!prepareOnly && !key) throw new ActionError('api-key is required. Pass secrets.DEEPSEEK_API_KEY from the caller repository.')
  const token = env.REVIEW_GITHUB_TOKEN?.trim()
  if (event && !token) throw new ActionError('github-token is required for PR object access.')
  return { root, base, head, key, token, event, prepareOnly, publish,
    inline: flag(env.REVIEW_INLINE_COMMENTS, true), model: env.REVIEW_MODEL || 'deepseek-v4-flash' }
}
function output(env: Environment, key: string, value: string | number) {
  if (!env.GITHUB_OUTPUT) return
  // Only internally generated, single-line values are sent to the runner protocol.
  if (/[\r\n]/.test(String(value))) throw new ActionError('Invalid output value.')
  appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`)
}
async function ensurePrObjects(settings: ReturnType<typeof actionSettings>, env: Environment, signal: AbortSignal) {
  if (!settings.event) return
  const repository = new ReviewRepository(settings.root, signal)
  const server = new URL(env.GITHUB_SERVER_URL || 'https://github.com')
  if (server.protocol !== 'https:' || server.username || server.password) throw new ActionError('GITHUB_SERVER_URL must use HTTPS.')
  const remote = `${server.origin}/${settings.event.repository.full_name}.git`
  for (const commit of [settings.base, settings.head]) {
    try { await repository.commit(commit); continue } catch { signal.throwIfAborted() }
    // Fetch only Git objects; never check out the PR or execute its files/hooks.
    const authorization = Buffer.from(`x-access-token:${settings.token}`).toString('base64')
    try {
      await execute('git', ['-C', settings.root, '-c', `http.${server.origin}/.extraheader=AUTHORIZATION: basic ${authorization}`,
        'fetch', '--no-tags', '--no-recurse-submodules', remote, commit], {
        timeout: 60000, maxBuffer: 1024 * 1024, signal,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    } catch { throw new ActionError('Cannot fetch PR Git objects. Check checkout fetch-depth and token contents: read permission.') }
  }
}

/** Target checkout is data only. This module never imports its files or its .env. */
export async function runReviewAction(env: Environment = process.env, dependencies: Dependencies = {}) {
  const settings = actionSettings(env)
  const directory = mkdtempSync(resolve(env.RUNNER_TEMP!, 'ai-code-review-'))
  output(env, 'report-directory', directory)
  const signal = AbortSignal.timeout(12 * 60 * 1000)
  await ensurePrObjects(settings, env, signal)
  if (settings.prepareOnly) {
    const context = await collectReviewContext(settings.root, settings.base, settings.head, signal)
    const { corpus, ...metadata } = context
    writeFileSync(resolve(directory, 'context.json'), JSON.stringify({ ...metadata,
      retrieval: context.files.map((file) => ({ path: file.path, sources: retrieveReviewSources(file, corpus) })) }, null, 2) + '\n', { mode: 0o600 })
    output(env, 'status', 'prepared'); output(env, 'findings', 0); output(env, 'reviewed-files', 0)
    return { directory, status: 'prepared', failed: false }
  }
  // The shared model client reads only these explicit settings; no dotenv import.
  const previous = { key: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL }
  process.env.DEEPSEEK_API_KEY = settings.key
  process.env.DEEPSEEK_MODEL = settings.model
  try {
    const report = await new CodeReviewAssistant({ root: settings.root, complete: dependencies.complete,
      model: dependencies.complete ? settings.model : undefined }).review(settings.base, settings.head, signal)
    const markdown = renderReview(report)
    let comment = reviewComment(markdown)
    for (const [name, content] of [['review.md', markdown], ['review.json', JSON.stringify(report, null, 2) + '\n'], ['comment.md', comment]]) {
      writeFileSync(resolve(directory, name), content, { mode: 0o600 })
    }
    output(env, 'status', report.status); output(env, 'findings', report.findings.length); output(env, 'reviewed-files', report.reviewedFiles)
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, comment)
    let publicationFailed = false
    if (settings.publish) {
      let inline: InlinePublication | undefined
      if (settings.inline) {
        let httpStatus: number | undefined
        try { inline = await publishInlineReview(settings.event!, report, env, dependencies.request, signal) }
        catch (error) {
          signal.throwIfAborted(); publicationFailed = true
          httpStatus = error instanceof ActionError ? error.status : undefined
          console.error(`Native GitHub review publication failed${httpStatus ? ` (HTTP ${httpStatus})` : ''}. Full reports are preserved.`)
        }
        writeFileSync(resolve(directory, 'publication.json'), JSON.stringify({ ...inline, failed: publicationFailed, httpStatus }, null, 2) + '\n')
        if (inline) {
          output(env, 'review-url', inline.reviewUrl)
          output(env, 'inline-comments', inline.created + inline.updated + inline.unchanged)
          const lines = ['<!-- day-32-ai-review -->', '# Автоматическое AI-ревью кода', '',
            `HEAD: \`${report.head}\` · статус: **${report.status}**`, '',
            `Рассмотрено файлов: ${report.reviewedFiles}/${report.totalFiles}. Замечаний: ${report.findings.length}.`, '',
            `Обсуждений у строк кода: ${inline.created + inline.updated + inline.unchanged} (новых: ${inline.created}, обновлено: ${inline.updated}).`]
          if (inline.reviewUrl) lines.push('', `[Открыть ревью у строк кода](${inline.reviewUrl})`)
          if (inline.skipped) lines.push('', `Замечаний без доступной привязки в GitHub diff или сверх лимита: ${inline.skipped}. Они сохранены в полном отчёте.`)
          if (inline.stale) lines.push('', 'PR изменился во время публикации; часть обсуждений не опубликована. Запустите ревью для актуального commit.')
          if (report.status !== 'complete') lines.push('', `Покрытие ограничено: содержимое ${report.limitedFiles.length} файлов передано частично, пропущено ${report.skipped.length} файлов. Подробности — в полном отчёте.`)
          lines.push('', 'Полный текст, источники RAG и ограничения сохранены в Job Summary и артефакте этого запуска.')
          comment = lines.join('\n') + '\n'
        }
        if (publicationFailed) comment += '\n\nНе удалось опубликовать обсуждения у строк кода. Полный отчёт сохранён; проверьте журнал Action.\n'
        writeFileSync(resolve(directory, 'comment.md'), comment, { mode: 0o600 })
      }
      output(env, 'comment-url', await publishReviewComment(settings.event!, report, comment, env, dependencies.request, signal))
    }
    return { directory, status: report.status, failed: publicationFailed || report.files.some((file) => Boolean(file.error)) }
  } finally {
    if (previous.key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous.key
    if (previous.model === undefined) delete process.env.DEEPSEEK_MODEL; else process.env.DEEPSEEK_MODEL = previous.model
  }
}
