import { SchedulerStore } from './scheduler-store'
import type { ScheduledJob, ScheduledRun } from './scheduler-store'

export type ScheduledTaskOutcome = {
  status: 'success' | 'skipped' | 'error'
  reason: string
  summary?: string
  toolCalls?: unknown
  error?: string
}

export type ScheduledTaskExecutor = (job: ScheduledJob, run: ScheduledRun) => Promise<ScheduledTaskOutcome>

/**
 * Durable polling worker. It owns scheduling and persistence; the executor
 * owns the agent call and natural-language interpretation of a task.
 */
export class SchedulerWorker {
  private timer?: NodeJS.Timeout
  private activeTick?: Promise<void>
  private stopping = false
  private activeJobsCount = 0

  constructor(private readonly store: SchedulerStore, private readonly executor: ScheduledTaskExecutor, private readonly options: { pollIntervalMs?: number } = {}) {}

  start() {
    if (this.timer) return
    this.stopping = false
    const poll = () => {
      try {
        // Keep reporting liveness while an agent call is still in progress.
        this.store.heartbeat(this.activeJobsCount)
        void this.tick().catch((error: unknown) => console.error('Ошибка планировщика:', error))
      } catch (error) { console.error('Ошибка heartbeat планировщика:', error) }
    }
    this.timer = setInterval(poll, this.options.pollIntervalMs ?? 30_000)
    poll()
  }

  async stop() {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.activeTick
  }

  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (this.activeTick) return this.activeTick
    this.activeTick = this.runTick().finally(() => { this.activeTick = undefined })
    return this.activeTick
  }

  private async runTick() {
    try {
      // A restarted laptop may return before the old lease has expired.
      // Recheck on each poll so that interrupted runs never remain stuck.
      this.store.recoverStaleRuns()
      this.store.heartbeat(0)
      let processed = 0
      while (processed < 8 && !this.stopping) {
        const claimed = this.store.claimNextRun()
        if (!claimed) break
        processed += 1
        this.activeJobsCount = 1
        this.store.heartbeat(this.activeJobsCount)
        this.store.addEvent(claimed.run.id, 'claimed', claimed.run.trigger === 'manual' ? 'Worker принял ручной запуск.' : 'Worker обнаружил наступившее расписание.')
        try {
          this.store.addEvent(claimed.run.id, 'agent', 'Агент начал оценку инструкции и условий.')
          const outcome = await this.executor(claimed.job, claimed.run)
          this.store.completeRun(claimed.run.id, outcome)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Не удалось выполнить фоновую задачу.'
          this.store.completeRun(claimed.run.id, { status: 'error', reason: 'Worker не смог завершить задачу.', error: message })
        } finally { this.activeJobsCount = 0 }
      }
      this.store.heartbeat(0)
    } finally {
      this.activeJobsCount = 0
    }
  }
}
