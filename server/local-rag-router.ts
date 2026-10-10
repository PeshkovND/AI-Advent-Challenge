import { Router } from 'express'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { compareLocalRag, localRagStatus } from './local-rag-service'
import { demoModes } from '../src/rag-demo-config'

export function createLocalRagRouter() {
  const router = Router()
  let busy = false
  router.get('/status', async (_req, res) => {
    try { res.json(await localRagStatus()) } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : String(error) }) }
  })
  router.get('/report', async (_req, res) => {
    for (const name of ['day-28-rag-comparison-cloud.json', 'day-28-rag-comparison.json']) {
      try { res.json(JSON.parse(await readFile(resolve('data', name), 'utf8'))); return } catch { /* Try the local-only report next. */ }
    }
    res.json(null)
  })
  router.post('/compare', async (req, res) => {
    const { question, includeCloud = false, mode, indexRunId } = req.body || {}
    if (typeof question !== 'string' || !question.trim() || question.length > 4000 || typeof includeCloud !== 'boolean'
      || !demoModes.includes(mode) || typeof indexRunId !== 'string' || !indexRunId.trim() || indexRunId.length > 100) {
      res.status(400).json({ error: 'Нужны вопрос до 4000 символов, режим сравнения и ID индекса.' }); return
    }
    if (busy) { res.status(409).json({ error: 'Сравнение уже выполняется. Дождитесь завершения.' }); return }
    busy = true
    const abort = new AbortController()
    const closed = () => { if (!res.writableEnded) abort.abort() }
    res.on('close', closed)
    const timer = setTimeout(() => abort.abort(), 900000)
    try { res.json(await compareLocalRag(question.trim(), includeCloud, mode, indexRunId, abort.signal)) }
    catch (error) { if (!res.destroyed) res.status(502).json({ error: error instanceof Error ? error.message : String(error) }) }
    finally { clearTimeout(timer); res.off('close', closed); busy = false }
  })
  return router
}
