import { Router } from 'express'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { answerOptimizedQuestion, benchmarkOptimization, optimizationStatus, optimizationMessages, validateOptimizationProfile } from './llm-optimization-service'
import type { OptimizationReport } from '../src/llm-optimization'
import { optimizationDemoCases } from '../src/llm-optimization-cases'
import { emptyComparisonReport, loadComparisonReport, saveComparisonReport } from './llm-optimization-comparison'
import { optimizationJudgeSettings } from './llm-optimization-judge'
import { compareOptimizationCases, reviewOptimizationCases } from './llm-optimization-runner'

export function createLlmOptimizationRouter() {
  const router = Router()
  let busy = false
  router.get('/status', async (_req, res) => { const status = await optimizationStatus(), judge = optimizationJudgeSettings(); res.status(status.ready ? 200 : 503).json({ ...status, judgeReady: judge.ready, judgeModel: judge.model, judgeConcurrency: judge.concurrency }) })
  router.get('/report', async (_req, res) => {
    try { res.json(await loadComparisonReport()) }
    catch (error) { res.status(500).json({ error: String(error) }) }
  })
  router.delete('/report', async (_req, res) => {
    if (busy) { res.status(409).json({ error: 'Дождитесь завершения запроса.' }); return }
    busy = true
    try { const report = emptyComparisonReport(); await saveComparisonReport(report); res.json(report) }
    catch (error) { res.status(500).json({ error: String(error) }) }
    finally { busy = false }
  })
  router.post('/compare', async (req, res) => {
    const ids = req.body?.caseIds ?? [req.body?.caseId]
    if (!Array.isArray(ids) || !ids.length || ids.length > optimizationDemoCases.length || new Set(ids).size !== ids.length
      || req.body?.caseIds !== undefined && req.body?.caseId !== undefined || !ids.every((id) => optimizationDemoCases.some((item) => item.id === id))) { res.status(400).json({ error: 'Выберите уникальные вопросы из контрольного набора.' }); return }
    if (busy) { res.status(409).json({ error: 'Сравнение уже выполняется.' }); return }
    busy = true
    const abort = new AbortController()
    const closed = () => { if (!res.writableEnded) abort.abort() }
    res.on('close', closed)
    try {
      const report = await loadComparisonReport()
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8'); res.setHeader('Cache-Control', 'no-cache'); res.flushHeaders()
      await compareOptimizationCases({ report, caseIds: ids, signal: abort.signal,
        onReport: async (next) => { await saveComparisonReport(next); if (!res.destroyed) res.write(JSON.stringify({ report: next }) + '\n') },
        onProgress: (progress) => { if (!res.destroyed) res.write(JSON.stringify({ progress }) + '\n') },
        onCaseError: (caseId, error) => { if (!res.destroyed) res.write(JSON.stringify({ caseError: { caseId, error } }) + '\n') },
      })
      res.end()
    } catch (error) {
      if (!res.destroyed) {
        const message = error instanceof Error ? error.message : String(error)
        if (res.headersSent) res.end(JSON.stringify({ error: message }) + '\n')
        else res.status(502).json({ error: message })
      }
    } finally { res.off('close', closed); busy = false }
  })
  router.post('/review', async (req, res) => {
    const ids = req.body?.caseIds ?? (req.body?.caseId === undefined ? undefined : [req.body.caseId])
    if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > optimizationDemoCases.length || new Set(ids).size !== ids.length
      || req.body?.caseIds !== undefined && req.body?.caseId !== undefined || !ids.every((id) => optimizationDemoCases.some((test) => test.id === id)))) { res.status(400).json({ error: 'Выберите уникальные вопросы из контрольного набора.' }); return }
    if (!optimizationJudgeSettings().ready) { res.status(503).json({ error: 'Настройте DEEPSEEK_API_KEY на сервере.' }); return }
    if (busy) { res.status(409).json({ error: 'Дождитесь завершения текущего запроса.' }); return }
    busy = true
    const abort = new AbortController()
    const closed = () => { if (!res.writableEnded) abort.abort() }
    res.on('close', closed)
    try {
      const report = await loadComparisonReport()
      const cases = report.cases.filter((test) => (!ids || ids.includes(test.id)) && ['baseline', 'optimized'].every((id) => report.samples.some((sample) => sample.caseId === test.id && sample.profileId === id && sample.answer)))
      if (!cases.length) { res.status(400).json({ error: 'Сначала получите оба ответа.' }); return }
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8'); res.setHeader('Cache-Control', 'no-cache'); res.flushHeaders()
      await reviewOptimizationCases({ report, caseIds: cases.map((test) => test.id), signal: abort.signal,
        onReport: async (next) => { await saveComparisonReport(next); if (!res.destroyed) res.write(JSON.stringify({ report: next }) + '\n') },
        onProgress: (progress) => { if (!res.destroyed) res.write(JSON.stringify({ progress }) + '\n') },
      })
      res.end()
    } catch (error) {
      if (!res.destroyed) {
        const message = error instanceof Error ? error.message : String(error)
        if (res.headersSent) res.end(JSON.stringify({ error: message }) + '\n')
        else res.status(502).json({ error: message })
      }
    } finally { res.off('close', closed); busy = false }
  })
  router.post('/answer', async (req, res) => {
    let profile
    try { profile = validateOptimizationProfile(req.body?.profile); optimizationMessages(req.body?.question, req.body?.materials, profile) }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); return }
    if (busy) { res.status(409).json({ error: 'Оптимизация уже выполняет запрос. Дождитесь завершения.' }); return }
    busy = true
    const abort = new AbortController()
    const closed = () => { if (!res.writableEnded) abort.abort() }
    res.on('close', closed)
    try { res.json(await answerOptimizedQuestion(req.body.question, req.body.materials, profile, abort.signal)) }
    catch (error) { if (!res.destroyed) res.status(502).json({ error: error instanceof Error ? error.message : String(error) }) }
    finally { res.off('close', closed); busy = false }
  })
  router.post('/benchmark', async (req, res) => {
    const { repetitions = 2, includeQ8 = false } = req.body || {}
    if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5 || typeof includeQ8 !== 'boolean') { res.status(400).json({ error: 'Нужны 1–5 повторов и includeQ8: boolean.' }); return }
    if (busy) { res.status(409).json({ error: 'Прогон уже выполняется. Дождитесь завершения.' }); return }
    busy = true
    const abort = new AbortController()
    const closed = () => { if (!res.writableEnded) abort.abort() }
    res.on('close', closed)
    const directory = resolve('data'), output = resolve(directory, 'day-29-optimization.json')
    try {
      await benchmarkOptimization({ repetitions, includeQ8, signal: abort.signal, onProgress: async (report: OptimizationReport) => {
        await mkdir(directory, { recursive: true })
        await writeFile(output + '.tmp', JSON.stringify(report, null, 2) + '\n')
        await rename(output + '.tmp', output)
        if (!res.destroyed) {
          if (!res.headersSent) { res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8'); res.setHeader('Cache-Control', 'no-cache'); res.flushHeaders() }
          res.write(JSON.stringify({ report }) + '\n')
        }
      } })
      res.end()
    } catch (error) {
      if (!res.destroyed) {
        const message = error instanceof Error ? error.message : String(error)
        if (res.headersSent) res.end(JSON.stringify({ error: message }) + '\n')
        else res.status(502).json({ error: message })
      }
    } finally { res.off('close', closed); busy = false }
  })
  return router
}
