import 'dotenv/config'
import { SupportAssistant } from './support-assistant'
import { renderGroundedAnswer } from './rag-grounding'

const args = process.argv.slice(2), service = new SupportAssistant()
const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
try {
  if (args.includes('--index')) console.log(JSON.stringify(await service.index(), null, 2))
  else if (args.includes('--catalog')) console.log(JSON.stringify(await service.catalog(), null, 2))
  else {
    const userId = value('--user'), ticketId = value('--ticket'), question = value('--question')
    if (!question) throw new Error('Использование: npm run support:cli -- --ticket MF-2002 --question "Почему нет кнопки приглашения в семью?" [--cloud]')
    const result = await service.ask(question, { ...(userId ? { userId } : {}), ...(ticketId ? { ticketId } : {}) }, args.includes('--cloud') ? 'cloud' : 'local')
    console.log(renderGroundedAnswer(result.grounding))
    console.log(JSON.stringify({ outcome: result.outcome, model: result.model, durationMs: result.durationMs, capturedAt: result.context?.capturedAt }, null, 2))
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
