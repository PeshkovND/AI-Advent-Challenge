import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SchedulerStore } from './scheduler-store'
import { SchedulerWorker } from './scheduler-worker'

const input = {
  agentId: 'missing-test-agent', name: 'Локальная проверка', cron: '0 9 * * *',
  timezone: 'Asia/Omsk', instructionText: 'Тест без внешних сервисов.',
}
const outcome = { status: 'success' as const, reason: 'Тестовый результат.', summary: 'Сводка сохранена.' }

test('остановка дожидается результата; очередь и сводка переживают перезапуск', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scheduler-restart-'))
  const path = join(directory, 'scheduler.sqlite')
  let store = new SchedulerStore(path)
  try {
    const job = store.createJob(input)
    const first = store.enqueueManualRun(job.id)
    const second = store.enqueueManualRun(job.id)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const worker = new SchedulerWorker(store, async () => { await gate; return outcome })
    const tick = worker.tick()
    let stopped = false
    const stopping = worker.stop().then(() => { stopped = true })
    await Promise.resolve()
    assert.equal(stopped, false)
    release()
    await Promise.all([tick, stopping])
    assert.equal(store.getRuns(job.id).find((run) => run.id === first.id)?.summary, outcome.summary)
    assert.equal(store.getLatestRun(job.id)?.status, 'queued')
    store.close()
    store = new SchedulerStore(path)
    assert.equal(store.getJob(job.id)?.instructionText, input.instructionText)
    const restarted = new SchedulerWorker(store, async () => outcome)
    await restarted.tick()
    assert.equal(store.getLatestRun(job.id)?.id, second.id)
    assert.equal(store.getLatestRun(job.id)?.status, 'success')
    assert.equal(store.getRuns(job.id).length, 2)
    await restarted.stop()
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('после простоя выполняется одна просроченная задача без повтора всех интервалов', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scheduler-catchup-'))
  const store = new SchedulerStore(join(directory, 'scheduler.sqlite'))
  try {
    const job = store.createJob(input)
    const afterSleep = new Date(Date.parse(job.nextRunAt) + 3 * 24 * 60 * 60_000)
    const claimed = store.claimNextRun(afterSleep)
    assert.equal(claimed?.job.id, job.id)
    assert.equal(claimed?.run.trigger, 'scheduled')
    assert.ok(Date.parse(store.getJob(job.id)!.nextRunAt) > afterSleep.getTime())
    store.completeRun(claimed!.run.id, outcome)
    assert.equal(store.claimNextRun(afterSleep), undefined)
    assert.equal(store.getRuns(job.id).length, 1)
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('очередь ждёт действующую блокировку; прерванный запуск освобождается после её истечения', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scheduler-recovery-'))
  const store = new SchedulerStore(join(directory, 'scheduler.sqlite'))
  try {
    const job = store.createJob(input)
    const first = store.enqueueManualRun(job.id)
    const now = new Date()
    store.claimNextRun(now)
    const second = store.enqueueManualRun(job.id)
    assert.equal(store.claimNextRun(now), undefined)
    store.recoverStaleRuns(now)
    assert.equal(store.getRuns(job.id).find((run) => run.id === first.id)?.status, 'running')
    store.recoverStaleRuns(new Date(now.getTime() + 6 * 60_000))
    assert.equal(store.getRuns(job.id).find((run) => run.id === first.id)?.status, 'error')
    const worker = new SchedulerWorker(store, async () => outcome)
    await worker.tick()
    assert.equal(store.getLatestRun(job.id)?.id, second.id)
    assert.equal(store.getLatestRun(job.id)?.status, 'success')
    await worker.stop()
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

async function startLocalApp(directory: string) {
  const child = spawn(process.execPath, [
    '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./index.ts', import.meta.url)),
  ], {
    cwd: directory,
    // No .env or inherited provider credentials; the fixture owns all state.
    env: { PATH: process.env.PATH, NODE_ENV: 'production', PORT: '0', SCHEDULER_DB_PATH: join(directory, 'scheduler.sqlite') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  try {
    for (let attempt = 0; attempt < 300; attempt++) {
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
      if (url) return { child, url }
      if (child.exitCode !== null) throw new Error(output)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Сервер не запустился: ${output}`)
  } catch (error) { await stopLocalApp(child); throw error }
}

async function stopLocalApp(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
  try { await exited } finally { clearTimeout(timeout) }
}

test('локальное приложение запускает планировщик и восстанавливает SQLite без отдельного worker', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scheduler-app-'))
  mkdirSync(join(directory, 'dist'))
  writeFileSync(join(directory, 'dist', 'index.html'), '<main>Local application fixture</main>')
  const store = new SchedulerStore(join(directory, 'scheduler.sqlite'))
  const job = store.createJob(input)
  store.enqueueManualRun(job.id)
  let app: Awaited<ReturnType<typeof startLocalApp>> | undefined
  try {
    app = await startLocalApp(directory)
    assert.match(await (await fetch(app.url)).text(), /Local application fixture/)
    const health = await (await fetch(`${app.url}/api/health`)).json()
    assert.ok(health.schedulerWorker.last_heartbeat_at)
    const assistant = await (await fetch(`${app.url}/api/agents/day17-mcp-agent`)).json()
    assert.deepEqual(assistant.config.mcp.servers, ['yandex-calendar', 'scheduler', 'telegram'])
    assert.match(assistant.config.systemPrompt, /серверный пояс по умолчанию: Asia\/Omsk/)
    const scheduledAssistant = await (await fetch(`${app.url}/api/agents/day18-scheduler-agent`)).json()
    assert.deepEqual(scheduledAssistant.config.mcp.servers, ['yandex-calendar', 'telegram'])
    assert.deepEqual(scheduledAssistant.config.mcp.serverToolAccess, { 'yandex-calendar': 'read-only' })
    const state = await (await fetch(`${app.url}/api/scheduler/jobs`)).json()
    assert.equal(state.jobs[0].id, job.id)
    // Missing agent fails locally, proving that the worker executed the queue
    // without sending any request to an LLM or calendar service.
    assert.equal(state.jobs[0].latestRun.status, 'error')
    assert.ok(state.jobs[0].runs[0].events.some((event: { stage: string }) => event.stage === 'claimed'))
    await stopLocalApp(app.child)
    app = await startLocalApp(directory)
    const restored = await (await fetch(`${app.url}/api/scheduler/jobs`)).json()
    assert.equal(restored.jobs[0].id, job.id)
    assert.equal(restored.jobs[0].runs.length, 1)
    assert.equal(restored.jobs[0].latestRun.status, 'error')
  } finally {
    if (app) await stopLocalApp(app.child)
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
