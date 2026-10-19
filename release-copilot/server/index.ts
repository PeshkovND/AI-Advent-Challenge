import { config } from 'dotenv'
import { setDefaultResultOrder } from 'node:dns'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createReleaseRouter } from './release-router'
import { ReleaseService } from './release-service'
import { Projects } from './projects'

setDefaultResultOrder('ipv4first')
const appRoot = fileURLToPath(new URL('../', import.meta.url))
config({ path: resolve(appRoot, '.env'), quiet: true })
const app = express(), router = createReleaseRouter(new ReleaseService({ directory: resolve(appRoot, 'data/release-runs') }), new Projects({ configPath: resolve(appRoot, 'data/projects.json') }))
app.disable('x-powered-by')
app.use(express.json({ limit: '64kb' }))
app.use('/api/releases', router)
app.use('/api', (_req, res) => { res.status(404).json({ error: 'Маршрут не найден.' }) })
const dist = resolve(appRoot, 'dist')
if (existsSync(resolve(dist, 'index.html'))) {
  app.use(express.static(dist))
  app.get('/', (_req, res) => res.sendFile(resolve(dist, 'index.html')))
} else app.get('/', (_req, res) => { res.status(503).send('Выполните npm run build или откройте Vite на http://127.0.0.1:5176.') })
const port = Number(process.env.PORT || 8796)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некорректный PORT.')
const server = app.listen(port, '127.0.0.1', () => {
  router.releases.start()
  console.log(`Release Copilot: http://127.0.0.1:${port}`)
})
let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  server.closeIdleConnections(); server.closeAllConnections()
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  await router.releases.stop(); await closed
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
