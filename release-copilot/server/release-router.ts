import { Router } from 'express'
import { z } from 'zod'
import { strToU8, zipSync } from 'fflate'
import { Projects } from './projects'
import { ProjectError } from './projects'
import { ReleaseError, ReleaseService, releaseInputSchema, releaseModels, releaseRepositoryInfo } from './release-service'

const projectId = releaseInputSchema.shape.projectId
const checkUpdate = z.union([
  z.object({ reviewed: z.boolean() }).strict(),
  z.object({ checkId: z.string().min(1).max(1200), status: z.enum(['pending', 'passed', 'failed']), note: z.string().max(2000).optional() }).strict(),
])
export function createReleaseRouter(service = new ReleaseService(), projects = new Projects()) {
  const router = Router()
  router.use((req, res, next) => {
    const local = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)
    try {
      if (!local(req.hostname) || req.headers.origin && !local(new URL(req.headers.origin).hostname)) {
        res.status(403).json({ error: 'Подготовка релиза доступна из локального приложения.' }); return
      }
    } catch { res.status(403).json({ error: 'Некорректный Origin.' }); return }
    next()
  })
  const errorResponse = (res: import('express').Response, error: unknown) => {
    res.status(error instanceof ReleaseError || error instanceof ProjectError ? error.status : 503).json({ error: error instanceof ReleaseError || error instanceof ProjectError ? error.message : 'Сервис подготовки релиза недоступен.' })
  }
  router.get('/projects', (_req, res) => {
    try { res.json(projects.list()) } catch (error) { errorResponse(res, error) }
  })
  for (const route of ['folders', 'projects/open'] as const) router.post(`/${route}`, (req, res) => {
    const input = z.object({ path: route === 'folders' ? z.string().trim().min(1).max(4096).optional() : z.string().trim().min(1).max(4096) }).strict().safeParse(req.body)
    if (!input.success) { res.status(400).json({ error: 'Укажите путь к папке.' }); return }
    try { res.json(route === 'folders' ? projects.folders(input.data.path) : projects.open(input.data.path!)) }
    catch (error) { errorResponse(res, error) }
  })
  router.get('/status', (_req, res) => {
    try { res.json(releaseModels()) } catch (error) { errorResponse(res, error) }
  })
  router.get('/repository', async (req, res) => {
    const id = projectId.safeParse(req.query.projectId)
    if (!id.success) { res.status(400).json({ error: 'Выберите проект.' }); return }
    try { res.json(await releaseRepositoryInfo(projects.get(id.data).root)) }
    catch (error) { errorResponse(res, error) }
  })
  router.get('/runs', (req, res) => {
    const id = projectId.safeParse(req.query.projectId)
    if (!id.success) { res.status(400).json({ error: 'Выберите проект.' }); return }
    try { res.json(service.list(id.data).slice(0, 100).map(({ id, version, state, base, head, createdAt, projectName, coverage }) => ({ id, version, state, base, head, createdAt, projectName, coverage }))) }
    catch (error) { errorResponse(res, error) }
  })
  router.post('/runs', async (req, res) => {
    const input = releaseInputSchema.safeParse(req.body)
    if (!input.success) { res.status(400).json({ error: 'Укажите проект, версию, два Git ref и провайдер local/cloud.' }); return }
    try {
      const project = projects.list().projects.find(({ id }) => id === input.data.projectId)
      if (!project) throw new ReleaseError('Проект не найден.', 404)
      res.status(202).json(await service.create(input.data, { root: projects.get(project.id).root, name: project.name }))
    } catch (error) { errorResponse(res, error) }
  })
  router.get('/runs/:id', (req, res) => {
    try { res.json(service.get(String(req.params.id))) } catch (error) { errorResponse(res, error) }
  })
  router.patch('/runs/:id', (req, res) => {
    const input = checkUpdate.safeParse(req.body)
    if (!input.success) { res.status(400).json({ error: 'Укажите подтверждение анализа или ID и результат проверки.' }); return }
    try { res.json(service.update(String(req.params.id), input.data)) } catch (error) { errorResponse(res, error) }
  })
  for (const action of ['retry', 'cancel'] as const) router.post(`/runs/:id/${action}`, (req, res) => {
    try { res.json(service[action](String(req.params.id))) } catch (error) { errorResponse(res, error) }
  })
  router.post('/runs/:id/impact', (req, res) => {
    try { res.status(202).json(service.checkImpact(String(req.params.id))) } catch (error) { errorResponse(res, error) }
  })
  router.get('/runs/:id/artifacts/:name', (req, res) => {
    const name = z.enum(['release-notes.md', 'changelog.md', 'test-plan.md', 'readiness.json', 'bundle.zip', 'bundle.json']).safeParse(req.params.name)
    if (!name.success) { res.status(404).json({ error: 'Материал не найден.' }); return }
    try {
      const files = service.artifacts(String(req.params.id))
      res.setHeader('Content-Disposition', `attachment; filename="${name.data}"`)
      if (name.data === 'bundle.zip') {
        const archive = zipSync(Object.fromEntries(Object.entries(files).map(([path, content]) => [path, strToU8(content)])))
        res.type('application/zip').send(Buffer.from(archive))
        return
      }
      res.type(name.data.endsWith('.json') ? 'application/json' : 'text/markdown')
      res.send(name.data === 'bundle.json' ? JSON.stringify({ format: 'release-copilot-v1', files }, null, 2) + '\n' : files[name.data])
    } catch (error) { errorResponse(res, error) }
  })
  return Object.assign(router, { releases: service })
}
