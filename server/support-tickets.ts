import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { SupportAnswer, SupportMessageReply } from '../src/support-types'
import { SupportAssistant } from './support-assistant'
import { SupportError, SupportGenerationError } from './support-errors'
import { supportTicketClient } from './support-mcp-client'

/** Persistent jobs are claimed through MCP. A browser disconnect never discards a saved question. */
export class SupportTickets {
  readonly client: ReturnType<typeof supportTicketClient>
  private timer?: ReturnType<typeof setInterval>
  private running?: Promise<void>
  private abort?: AbortController
  private currentTicketId?: string
  private stopped = true
  private readonly workerId = `worker-${randomUUID()}`
  constructor(readonly assistant: SupportAssistant, private readonly options: { ask?: SupportAssistant['ask']; pollMs?: number } = {}) {
    this.client = supportTicketClient(assistant.crmLocation)
  }
  start() {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => this.wake(), this.options.pollMs || 5000)
    this.timer.unref()
    this.wake()
  }
  wake() {
    if (this.stopped || this.running) return
    this.running = this.drain().catch(() => { /* A temporarily unavailable MCP is retried on the next tick. */ }).finally(() => { this.running = undefined })
  }
  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.abort?.abort()
    await this.running
  }
  cancel(ticketId: string) { if (this.currentTicketId === ticketId) this.abort?.abort() }
  private async drain() {
    while (!this.stopped) {
      try { if (this.assistant.status().busy) return } catch { /* ask() records unavailable knowledge as a failed durable job. */ }
      const job = await this.client.claim({ workerId: this.workerId })
      if (!job || this.stopped) return
      const abort = new AbortController(); this.abort = abort; this.currentTicketId = job.ticketId
      const deadline = setTimeout(() => abort.abort(), 540000)
      let leaseLost = false, renewing = false
      const heartbeat = setInterval(() => {
        if (renewing) return
        renewing = true
        void this.client.renew({ jobId: job.id, leaseToken: job.leaseToken }).catch(() => { leaseLost = true; abort.abort() }).finally(() => { renewing = false })
      }, 20000)
      heartbeat.unref()
      try {
        let result: SupportAnswer
        for (;;) {
          abort.signal.throwIfAborted()
          try { result = await (this.options.ask || this.assistant.ask.bind(this.assistant))(job.input, { userId: job.userId, ticketId: job.ticketId }, job.provider, abort.signal); break }
          catch (error) {
            if (error instanceof SupportError && error.status === 409 && this.assistant.status().busy) { await delay(500, undefined, { signal: abort.signal }); continue }
            throw error
          }
        }
        clearInterval(heartbeat)
        if (this.stopped || leaseLost) return
        if (result.outcome === 'answered' && (result.grounding.verification.status !== 'passed' || !result.grounding.citations.length)) throw new Error('Unverified support answer')
        const reply: SupportMessageReply = { outcome: result.outcome, provider: result.provider, model: result.model, durationMs: result.durationMs,
          citations: result.grounding.citations, ...(result.grounding.clarification ? { clarification: result.grounding.clarification } : {}),
          indexRunId: result.indexRunId, ...(result.context ? { capturedAt: result.context.capturedAt } : {}) }
        await this.client.complete({ jobId: job.id, leaseToken: job.leaseToken, body: result.answer, reply })
      } catch (error) {
        clearInterval(heartbeat)
        if (!this.stopped && !leaseLost) {
          console.error('Support ticket failed', { ticketId: job.ticketId, jobId: job.id, provider: job.provider, code: error instanceof SupportGenerationError ? error.code : 'internal', stage: error instanceof SupportGenerationError ? error.stage : 'unknown' })
          const message = error instanceof SupportError ? error.message : 'Не удалось получить проверенный ответ. Вопрос сохранён. Проверьте модель и базу знаний и повторите ответ.'
          await this.client.fail({ jobId: job.id, leaseToken: job.leaseToken, error: message.slice(0, 500) }).catch(() => {})
        }
      } finally { clearTimeout(deadline); clearInterval(heartbeat); this.abort = undefined; this.currentTicketId = undefined }
    }
  }
}
