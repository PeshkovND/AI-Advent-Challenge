import 'dotenv/config'
import './network-config'
import { createInterface } from 'node:readline/promises'
import { parseDeveloperCommand } from './developer-assistant'
import { DeveloperProjects, parseDeveloperArguments } from './developer-projects'

const args = parseDeveloperArguments(process.argv.slice(2))
const service = new DeveloperProjects().get(args.project)
const provider = args.local ? 'local' : 'cloud'
async function command(input: string) {
  if (input === '/index') {
    const result = await service.index()
    console.log(`Индекс готов: ${result.index.sourceCount} документов, ${result.index.chunkCount} чанков.`)
    return
  }
  const goal = /^\/help(?:\s|$)/i.test(input) ? parseDeveloperCommand(input) : input.replace(/^\/task\s+/i, '')
  const result = await service.coding.run(goal, provider, undefined, previousRunId,
    (step) => console.error(`${step.tool} ${JSON.stringify(step.arguments).slice(0, 160)}${step.result.error ? ` → ${step.result.error}` : ''}`))
  previousRunId = result.id
  console.log(result.answer)
  for (const change of result.changes) console.log(change.diff)
  console.log(`Задача ${result.id} · ${result.status}. ${result.changes.length ? `Применить: npm run developer:cli -- --project ${args.project} --apply ${result.id}` : 'Файлы не изменены.'}`)
}
let previousRunId: string | undefined
try {
  if (args.apply) {
    const result = await service.coding.apply(args.apply)
    console.log(`${result.status}: ${result.changes.map(({ path }) => path).join(', ')}`)
  } else if (args.index) await command('/index')
  else if (args.command) await command(args.command)
  else {
    console.log(`Проект: ${service.root}. Задайте вопрос или цель: документация, Git и файлы в одной беседе. /index, /exit. Применение diff: --apply ID.`)
    const terminal = createInterface({ input: process.stdin, output: process.stdout })
    terminal.setPrompt('dev> '); terminal.prompt()
    try {
      for await (const line of terminal) {
        if (line.trim() === '/exit') break
        if (line.trim()) try { await command(line.trim()) } catch (error) { console.error(error instanceof Error ? error.message : String(error)) }
        terminal.prompt()
      }
    } finally { terminal.close() }
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
