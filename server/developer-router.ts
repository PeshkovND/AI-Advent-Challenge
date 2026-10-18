import { Router } from 'express'
import { z } from 'zod'
import { DeveloperAssistant, DeveloperError } from './developer-assistant'
import { DeveloperProjects } from './developer-projects'
import { CodingError } from './coding-files'

const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).default('current')
const helpSchema = z.object({ input: z.string().trim().min(1).max(4000), provider: z.enum(['cloud', 'local']).default('cloud'), projectId: projectIdSchema }).strict()
const taskSchema = z.object({ projectId: projectIdSchema, goal: z.string().trim().min(1).max(4000), provider: z.enum(['cloud', 'local']).default('cloud'), previousRunId: z.uuid().optional() }).strict()
export function createDeveloperRouter(projects: DeveloperAssistant | DeveloperProjects = new DeveloperProjects()) {
  const router = Router()
  // This app controls the local filesystem and runs on loopback, including through Vite's proxy.
  router.use((req, res, next) => {
    const local = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)
    try {
      if (!local(req.hostname) || req.headers.origin && !local(new URL(req.headers.origin).hostname)) {
        res.status(403).json({ error: 'Доступ к локальным проектам разрешён из приложения на localhost.' }); return
      }
    } catch { res.status(403).json({ error: 'Некорректный Origin.' }); return }
    next()
  })
  const getService = (id: string) => {
    if (projects instanceof DeveloperProjects) return projects.get(id)
    if (id !== 'current') throw new DeveloperError('Неизвестный проект.', 404)
    return projects
  }
  router.get('/projects', (_req, res) => {
    try { res.json(projects instanceof DeveloperProjects ? projects.list() : { defaultProjectId: 'current', projects: [{ id: 'current', name: projects.status().project }] }) }
    catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : String(error) }) }
  })
  for (const route of ['folders', 'projects/open'] as const) router.post(`/${route}`, (req, res) => {
    const body = z.object({ path: route === 'folders' ? z.string().trim().min(1).max(4096).optional() : z.string().trim().min(1).max(4096) }).strict().safeParse(req.body)
    if (!body.success) { res.status(400).json({ error: 'Укажите путь к локальной папке проекта.' }); return }
    if (!(projects instanceof DeveloperProjects)) { res.status(503).json({ error: 'Выбор папки недоступен.' }); return }
    try { res.json(route === 'folders' ? projects.folders(body.data.path) : projects.open(body.data.path!)) }
    catch (error) { res.status(error instanceof DeveloperError ? error.status : 503).json({ error: error instanceof Error ? error.message : String(error) }) }
  })
  router.get('/status', (req, res) => {
    try {
      const parsed = projectIdSchema.safeParse(req.query.projectId)
      if (!parsed.success) { res.status(400).json({ error: 'Неверный ID проекта.' }); return }
      res.json({ ...getService(parsed.data).status(), projectId: parsed.data })
    } catch (error) { res.status(error instanceof DeveloperError ? error.status : 503).json({ error: error instanceof Error ? error.message : String(error) }) }
  })
  router.get('/tasks/:id', (req, res) => {
    try { res.json(getService(projectIdSchema.parse(req.query.projectId)).coding.get(String(req.params.id))) }
    catch (error) { res.status(error instanceof CodingError || error instanceof DeveloperError ? error.status : 400).json({ error: error instanceof Error ? error.message : String(error) }) }
  })
  for (const route of ['tasks', 'tasks/:id/apply'] as const) router.post(`/${route}`, async (req, res) => {
    const schema = route === 'tasks'
      ? taskSchema
      : z.object({ projectId: projectIdSchema }).strict()
    const body = schema.safeParse(req.body || {})
    if (!body.success) { res.status(400).json({ error: 'Укажите projectId, цель goal и provider cloud/local.' }); return }
    const abort = new AbortController()
    const closed = () => { if (!res.writableEnded) abort.abort() }
    res.on('close', closed)
    const timer = setTimeout(() => abort.abort(), 600000)
    const streaming = route === 'tasks' && req.headers.accept === 'text/event-stream'
    if (streaming) { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.flushHeaders() }
    const emit = (event: string, data: unknown) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
    try {
      const service = getService(body.data.projectId).coding
      const task = route === 'tasks' ? taskSchema.parse(req.body) : undefined
      const result = task
        ? await service.run(task.goal, task.provider, abort.signal, task.previousRunId, streaming ? (step) => emit('step', { tool: step.tool, path: step.arguments.path, query: step.arguments.query, error: step.result.error }) : undefined)
        : await service.apply(String((req.params as Record<string, string>).id), abort.signal)
      if (!res.destroyed) { if (streaming) { emit('result', { ...result, projectId: body.data.projectId }); res.end() } else res.json({ ...result, projectId: body.data.projectId }) }
    } catch (error) {
      if (!res.destroyed) {
        const message = { error: error instanceof Error ? error.message : String(error) }
        if (streaming) { emit('error', message); res.end() }
        else res.status(error instanceof CodingError || error instanceof DeveloperError ? error.status : 502).json(message)
      }
    } finally { clearTimeout(timer); res.off('close', closed) }
  })
  for (const route of ['index', 'help'] as const) router.post(`/${route}`, async (req, res) => {
    const parsed = route === 'help' ? helpSchema.safeParse(req.body) : undefined
    const index = route === 'index' ? z.object({ projectId: projectIdSchema }).strict().safeParse(req.body || {}) : undefined
    if (parsed && !parsed.success || index && !index.success) {
      res.status(400).json({ error: 'Неверный запрос. Укажите зарегистрированный projectId и корректные параметры команды.' }); return
    }
    const abort = new AbortController()
    const closed = () => { if (!res.writableEnded) abort.abort() }
    res.on('close', closed)
    const timer = setTimeout(() => abort.abort(), 600000)
    try {
      const projectId = parsed?.success ? parsed.data.projectId : index?.success ? index.data.projectId : 'current'
      const service = getService(projectId)
      const result = parsed?.success ? await service.help(parsed.data.input, parsed.data.provider, abort.signal) : await service.index(abort.signal)
      if (!res.destroyed) res.json({ ...result, projectId })
    } catch (error) {
      if (!res.destroyed) res.status(error instanceof DeveloperError ? error.status : 502).json({ error: error instanceof Error ? error.message : String(error) })
    } finally { clearTimeout(timer); res.off('close', closed) }
  })
  return router
}
