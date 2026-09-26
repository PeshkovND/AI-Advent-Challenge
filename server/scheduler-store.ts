import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type ScheduledJob = {
  id: string
  agentId: string
  name: string
  cron: string
  timezone: string
  instructionText: string
  enabled: boolean
  nextRunAt: string
  lastRunAt?: string
  createdAt: string
  updatedAt: string
}

export type ScheduledRunStatus = 'queued' | 'running' | 'success' | 'skipped' | 'error'
export type ScheduledRun = {
  id: string
  jobId: string
  trigger: 'scheduled' | 'manual'
  startedAt?: string
  finishedAt?: string
  status: ScheduledRunStatus
  decisionReason?: string
  summary?: string
  toolCalls?: unknown
  error?: string
}

export type ScheduledRunEvent = {
  id: string
  runId: string
  createdAt: string
  stage: string
  message: string
  metadata?: unknown
}

type CreateJobInput = Pick<ScheduledJob, 'agentId' | 'name' | 'cron' | 'timezone' | 'instructionText'>
type DbRow = Record<string, unknown>

const defaultDatabasePath = resolve(process.cwd(), 'data', 'scheduler.sqlite')
const lockDurationMs = 5 * 60 * 1_000

const isoNow = () => new Date().toISOString()
const json = (value: unknown) => value === undefined ? null : JSON.stringify(value)
const parseJson = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : undefined

function asString(row: DbRow, key: string) {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Повреждены данные scheduler: отсутствует ${key}.`)
  return value
}

function rowToJob(row: DbRow): ScheduledJob {
  return {
    id: asString(row, 'id'),
    agentId: asString(row, 'agent_id'),
    name: asString(row, 'name'),
    cron: asString(row, 'cron'),
    timezone: asString(row, 'timezone'),
    instructionText: asString(row, 'instruction_text'),
    enabled: Number(row.enabled) === 1,
    nextRunAt: asString(row, 'next_run_at'),
    ...(typeof row.last_run_at === 'string' ? { lastRunAt: row.last_run_at } : {}),
    createdAt: asString(row, 'created_at'),
    updatedAt: asString(row, 'updated_at'),
  }
}

function rowToRun(row: DbRow): ScheduledRun {
  return {
    id: asString(row, 'id'),
    jobId: asString(row, 'job_id'),
    trigger: asString(row, 'trigger') === 'manual' ? 'manual' : 'scheduled',
    ...(typeof row.started_at === 'string' ? { startedAt: row.started_at } : {}),
    ...(typeof row.finished_at === 'string' ? { finishedAt: row.finished_at } : {}),
    status: asString(row, 'status') as ScheduledRunStatus,
    ...(typeof row.decision_reason === 'string' ? { decisionReason: row.decision_reason } : {}),
    ...(typeof row.summary === 'string' ? { summary: row.summary } : {}),
    ...(row.tool_calls_json ? { toolCalls: parseJson(row.tool_calls_json) } : {}),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
  }
}

function rowToEvent(row: DbRow): ScheduledRunEvent {
  return {
    id: asString(row, 'id'),
    runId: asString(row, 'run_id'),
    createdAt: asString(row, 'created_at'),
    stage: asString(row, 'stage'),
    message: asString(row, 'message'),
    ...(row.metadata_json ? { metadata: parseJson(row.metadata_json) } : {}),
  }
}

/** Persistent state for scheduler MCP, the worker and the read API. */
export class SchedulerStore {
  private readonly database: DatabaseSync

  constructor(filePath = process.env.SCHEDULER_DB_PATH?.trim() || defaultDatabasePath) {
    mkdirSync(dirname(filePath), { recursive: true })
    this.database = new DatabaseSync(filePath)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  close() { this.database.close() }

  createJob(input: CreateJobInput) {
    validateCron(input.cron)
    assertTimeZone(input.timezone)
    if (!input.name.trim() || !input.instructionText.trim() || !input.agentId.trim()) throw new Error('Название, agentId и инструкция задачи обязательны.')
    const now = isoNow()
    const job: ScheduledJob = {
      id: randomUUID(),
      agentId: input.agentId.trim(),
      name: input.name.trim().slice(0, 200),
      cron: input.cron.trim(),
      timezone: input.timezone.trim(),
      instructionText: input.instructionText.trim().slice(0, 8_000),
      enabled: true,
      nextRunAt: nextRunAt(input.cron, input.timezone, new Date()),
      createdAt: now,
      updatedAt: now,
    }
    this.database.prepare(`INSERT INTO scheduled_jobs (id, agent_id, name, cron, timezone, instruction_text, enabled, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(job.id, job.agentId, job.name, job.cron, job.timezone, job.instructionText, job.nextRunAt, now, now)
    return job
  }

  listJobs() {
    return (this.database.prepare('SELECT * FROM scheduled_jobs ORDER BY created_at DESC').all() as DbRow[]).map(rowToJob)
  }

  getJob(id: string) {
    const row = this.database.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as DbRow | undefined
    return row ? rowToJob(row) : undefined
  }

  deleteJob(id: string) {
    const result = this.database.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id)
    return result.changes > 0
  }

  enqueueManualRun(jobId: string) {
    if (!this.getJob(jobId)) throw new Error('Задание не найдено.')
    const run: ScheduledRun = { id: randomUUID(), jobId, trigger: 'manual', status: 'queued' }
    this.database.prepare('INSERT INTO scheduled_job_runs (id, job_id, trigger, status) VALUES (?, ?, ?, ?)').run(run.id, jobId, run.trigger, run.status)
    this.addEvent(run.id, 'queued', 'Ручной запуск поставлен в очередь.')
    return run
  }

  getRuns(jobId: string, limit = 30) {
    return (this.database.prepare('SELECT * FROM scheduled_job_runs WHERE job_id = ? ORDER BY rowid DESC LIMIT ?').all(jobId, limit) as DbRow[]).map(rowToRun)
  }

  getLatestRun(jobId: string) {
    const row = this.database.prepare('SELECT * FROM scheduled_job_runs WHERE job_id = ? ORDER BY rowid DESC LIMIT 1').get(jobId) as DbRow | undefined
    return row ? rowToRun(row) : undefined
  }

  getEvents(runId: string) {
    return (this.database.prepare('SELECT * FROM scheduled_job_events WHERE run_id = ? ORDER BY created_at ASC').all(runId) as DbRow[]).map(rowToEvent)
  }

  addEvent(runId: string, stage: string, message: string, metadata?: unknown) {
    const event: ScheduledRunEvent = { id: randomUUID(), runId, createdAt: isoNow(), stage, message, ...(metadata === undefined ? {} : { metadata }) }
    this.database.prepare('INSERT INTO scheduled_job_events (id, run_id, created_at, stage, message, metadata_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(event.id, runId, event.createdAt, stage, message.slice(0, 2_000), json(metadata))
    return event
  }

  heartbeat(activeJobsCount: number) {
    this.database.prepare(`INSERT INTO worker_state (id, last_heartbeat_at, active_jobs_count, version, updated_at)
      VALUES ('worker', ?, ?, '1.0.0', ?)
      ON CONFLICT(id) DO UPDATE SET last_heartbeat_at = excluded.last_heartbeat_at, active_jobs_count = excluded.active_jobs_count, updated_at = excluded.updated_at`)
      .run(isoNow(), activeJobsCount, isoNow())
  }

  workerState() {
    return this.database.prepare("SELECT * FROM worker_state WHERE id = 'worker'").get() as DbRow | undefined
  }

  recoverStaleRuns(now = new Date()) {
    const nowIso = now.toISOString()
    this.database.prepare(`UPDATE scheduled_job_runs SET status = 'error', finished_at = ?, error = 'Worker был перезапущен до завершения запуска.'
      WHERE status = 'running' AND id IN (SELECT current_run_id FROM scheduled_jobs WHERE lock_until IS NOT NULL AND lock_until < ?)`)
      .run(nowIso, nowIso)
    this.database.prepare('UPDATE scheduled_jobs SET current_run_id = NULL, lock_until = NULL WHERE lock_until IS NOT NULL AND lock_until < ?').run(nowIso)
  }

  /** Claims either a manual queue item or a due scheduled run atomically. */
  claimNextRun(now = new Date()): { job: ScheduledJob; run: ScheduledRun } | undefined {
    const nowIso = now.toISOString()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      // Do not select `runs.*` and `jobs.*` together: both tables have an
      // `id`, and SQLite's duplicate-column handling can silently bind a run
      // to the wrong row. First choose exact identifiers, then hydrate each
      // entity from its own table inside the same immediate transaction.
      const queuedIds = this.database.prepare(`SELECT runs.id AS run_id, jobs.id AS job_id FROM scheduled_job_runs runs
        JOIN scheduled_jobs jobs ON jobs.id = runs.job_id
        WHERE runs.status = 'queued' AND jobs.enabled = 1 AND jobs.current_run_id IS NULL
        ORDER BY runs.rowid ASC LIMIT 1`).get() as DbRow | undefined
      if (queuedIds) {
        const runRow = this.database.prepare('SELECT * FROM scheduled_job_runs WHERE id = ?').get(asString(queuedIds, 'run_id')) as DbRow
        const jobRow = this.database.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(asString(queuedIds, 'job_id')) as DbRow
        const run = rowToRun(runRow)
        const job = rowToJob(jobRow)
        this.database.prepare("UPDATE scheduled_job_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(nowIso, run.id)
        this.database.prepare('UPDATE scheduled_jobs SET current_run_id = ?, lock_until = ?, updated_at = ? WHERE id = ?').run(run.id, new Date(now.getTime() + lockDurationMs).toISOString(), nowIso, job.id)
        this.database.exec('COMMIT')
        return { job, run: { ...run, status: 'running', startedAt: nowIso } }
      }

      const due = this.database.prepare(`SELECT * FROM scheduled_jobs
        WHERE enabled = 1 AND next_run_at <= ? AND (lock_until IS NULL OR lock_until < ?) ORDER BY next_run_at ASC LIMIT 1`).get(nowIso, nowIso) as DbRow | undefined
      if (!due) {
        this.database.exec('COMMIT')
        return undefined
      }
      const job = rowToJob(due)
      const run: ScheduledRun = { id: randomUUID(), jobId: job.id, trigger: 'scheduled', status: 'running', startedAt: nowIso }
      const next = nextRunAt(job.cron, job.timezone, now)
      this.database.prepare('INSERT INTO scheduled_job_runs (id, job_id, trigger, started_at, status) VALUES (?, ?, ?, ?, ?)').run(run.id, job.id, run.trigger, nowIso, run.status)
      this.database.prepare('UPDATE scheduled_jobs SET current_run_id = ?, lock_until = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
        .run(run.id, new Date(now.getTime() + lockDurationMs).toISOString(), next, nowIso, job.id)
      this.database.exec('COMMIT')
      return { job, run }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  completeRun(runId: string, outcome: { status: Extract<ScheduledRunStatus, 'success' | 'skipped' | 'error'>; reason: string; summary?: string; toolCalls?: unknown; error?: string }) {
    const now = isoNow()
    const runRow = this.database.prepare('SELECT * FROM scheduled_job_runs WHERE id = ?').get(runId) as DbRow | undefined
    if (!runRow) throw new Error('Запуск не найден.')
    const run = rowToRun(runRow)
    this.database.prepare(`UPDATE scheduled_job_runs SET status = ?, finished_at = ?, decision_reason = ?, summary = ?, tool_calls_json = ?, error = ? WHERE id = ?`)
      .run(outcome.status, now, outcome.reason.slice(0, 4_000), outcome.summary?.slice(0, 20_000) ?? null, json(outcome.toolCalls), outcome.error?.slice(0, 4_000) ?? null, runId)
    this.database.prepare('UPDATE scheduled_jobs SET current_run_id = NULL, lock_until = NULL, last_run_at = ?, updated_at = ? WHERE id = ?').run(now, now, run.jobId)
    this.addEvent(runId, outcome.status, outcome.reason, { ...(outcome.summary ? { summaryLength: outcome.summary.length } : {}), ...(outcome.error ? { hasError: true } : {}) })
  }

  private migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        timezone TEXT NOT NULL,
        instruction_text TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT NOT NULL,
        last_run_at TEXT,
        current_run_id TEXT,
        lock_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scheduled_job_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL CHECK(trigger IN ('scheduled', 'manual')),
        started_at TEXT,
        finished_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'success', 'skipped', 'error')),
        decision_reason TEXT,
        summary TEXT,
        tool_calls_json TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS scheduled_job_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES scheduled_job_runs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE TABLE IF NOT EXISTS worker_state (
        id TEXT PRIMARY KEY,
        last_heartbeat_at TEXT NOT NULL,
        active_jobs_count INTEGER NOT NULL,
        version TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx ON scheduled_jobs(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS scheduled_runs_job_idx ON scheduled_job_runs(job_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS scheduled_events_run_idx ON scheduled_job_events(run_id, created_at);
    `)
  }
}

type CronField = { values: Set<number>; unrestricted: boolean }

function parseCronField(expression: string, min: number, max: number) {
  const values = new Set<number>()
  const unrestricted = expression === '*'
  for (const chunk of expression.split(',')) {
    const [rangePart, stepPart] = chunk.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Некорректный cron шаг: ${chunk}.`)
    const [start, end] = rangePart === '*'
      ? [min, max]
      : rangePart.includes('-')
        ? rangePart.split('-').map(Number)
        : [Number(rangePart), Number(rangePart)]
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) throw new Error(`Некорректное cron значение: ${chunk}.`)
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return { values, unrestricted } satisfies CronField
}

function parseCron(cron: string) {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('Cron должен состоять из пяти полей: минута час день-месяца месяц день-недели.')
  return {
    minute: parseCronField(fields[0], 0, 59),
    hour: parseCronField(fields[1], 0, 23),
    dayOfMonth: parseCronField(fields[2], 1, 31),
    month: parseCronField(fields[3], 1, 12),
    dayOfWeek: parseCronField(fields[4], 0, 6),
  }
}

export function validateCron(cron: string) { parseCron(cron) }

function assertTimeZone(timezone: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format() } catch { throw new Error(`Неизвестный часовой пояс: ${timezone}.`) }
}

function localParts(date: Date, timezone: string) {
  const values = new Intl.DateTimeFormat('en-US', { timeZone: timezone, minute: '2-digit', hour: '2-digit', day: '2-digit', month: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(date).reduce<Record<string, string>>((result, part) => ({ ...result, [part.type]: part.value }), {})
  const weekday = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[values.weekday]
  return { minute: Number(values.minute), hour: Number(values.hour), dayOfMonth: Number(values.day), month: Number(values.month), dayOfWeek: weekday }
}

/** Finds the next matching minute in the supplied IANA timezone. */
export function nextRunAt(cron: string, timezone: string, after: Date) {
  const fields = parseCron(cron)
  assertTimeZone(timezone)
  let candidate = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000)
  for (let minute = 0; minute < 527_040; minute += 1) {
    const local = localParts(candidate, timezone)
    const dayMatches = fields.dayOfMonth.values.has(local.dayOfMonth)
    const weekdayMatches = fields.dayOfWeek.values.has(local.dayOfWeek)
    const calendarMatches = fields.dayOfMonth.unrestricted || fields.dayOfWeek.unrestricted
      ? dayMatches && weekdayMatches
      : dayMatches || weekdayMatches
    if (fields.minute.values.has(local.minute) && fields.hour.values.has(local.hour) && fields.month.values.has(local.month) && calendarMatches) return candidate.toISOString()
    candidate = new Date(candidate.getTime() + 60_000)
  }
  throw new Error('Не удалось найти следующий запуск за ближайший год.')
}
