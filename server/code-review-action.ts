import './network-config'
import { execFile } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { CodeReviewAssistant, renderReview, reviewComment } from './code-review'
import { collectReviewContext, retrieveReviewSources, ReviewRepository } from './code-review-context'
import type { RagCompletion } from './rag-retrieval'

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
export class ActionError extends Error {}

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
  return { root, base, head, key, token, event, prepareOnly, publish, model: env.REVIEW_MODEL || 'deepseek-v4-flash' }
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

export async function publishReviewComment(event: PrEvent, report: { base: string; head: string }, body: string,
  env: Environment, request: typeof fetch = fetch, signal?: AbortSignal) {
  const api = new URL(env.GITHUB_API_URL || 'https://api.github.com')
  if (api.protocol !== 'https:' || api.username || api.password) throw new ActionError('GITHUB_API_URL must use HTTPS.')
  const call = async (path: string, method = 'GET', data?: unknown) => {
    const response = await request(new URL(api.href.replace(/\/$/, '') + path), { method,
      headers: { Authorization: `Bearer ${env.REVIEW_GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}), signal })
    if (!response.ok) throw new ActionError(`GitHub API returned HTTP ${response.status}. Check pull-requests: write permission.`)
    return response.json()
  }
  const prefix = `/repos/${event.repository.full_name}`
  const current = await call(`${prefix}/pulls/${event.number}`)
  if (current.state !== 'open' || current.head.sha !== report.head || current.base.sha !== report.base) return ''
  let existing: { id: number } | undefined
  for (let page = 1; ; page++) {
    const comments = await call(`${prefix}/issues/${event.number}/comments?per_page=100&page=${page}`) as Array<{ id: number; user?: { login: string }; body?: string }>
    existing = comments.find((comment) => comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith('<!-- day-32-ai-review -->'))
    if (existing || comments.length < 100) break
  }
  // Recheck after pagination so an updated PR does not receive a stale comment.
  const latest = await call(`${prefix}/pulls/${event.number}`)
  if (latest.state !== 'open' || latest.head.sha !== report.head || latest.base.sha !== report.base) return ''
  const result = existing ? await call(`${prefix}/issues/comments/${existing.id}`, 'PATCH', { body })
    : await call(`${prefix}/issues/${event.number}/comments`, 'POST', { body })
  return String(result.html_url || '')
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
    const markdown = renderReview(report), comment = reviewComment(markdown)
    for (const [name, content] of [['review.md', markdown], ['review.json', JSON.stringify(report, null, 2) + '\n'], ['comment.md', comment]]) {
      writeFileSync(resolve(directory, name), content, { mode: 0o600 })
    }
    output(env, 'status', report.status); output(env, 'findings', report.findings.length); output(env, 'reviewed-files', report.reviewedFiles)
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, comment)
    if (settings.publish) output(env, 'comment-url', await publishReviewComment(settings.event!, report, comment, env, dependencies.request, signal))
    return { directory, status: report.status, failed: report.files.some((file) => Boolean(file.error)) }
  } finally {
    if (previous.key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous.key
    if (previous.model === undefined) delete process.env.DEEPSEEK_MODEL; else process.env.DEEPSEEK_MODEL = previous.model
  }
}
