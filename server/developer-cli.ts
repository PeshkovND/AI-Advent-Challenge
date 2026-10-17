import 'dotenv/config'
import './network-config'
import { createInterface } from 'node:readline/promises'
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
  const result = await service.help(input, provider)
  console.log(result.answer)
  for (const citation of result.grounding.citations) console.log(`[${citation.id}] ${citation.source} · ${citation.section}\n> ${citation.quote}`)
  console.log(`MCP: ${result.context.receipts.map((receipt) => receipt.name).join(', ')} · ${result.model} · ${result.durationMs} мс`)
}
try {
  if (args.index) await command('/index')
  else if (args.command) await command(args.command)
  else {
    console.log(`Проект: ${service.status().project}. Ассистент разработчика: /help <вопрос>, /index, /exit. Каждый вопрос независим.`)
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
