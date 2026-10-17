import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const serverPath = fileURLToPath(new URL('./mcp-demo-server.ts', import.meta.url))

type ListedTool = {
  name: string
  description?: string
}

function printTools(tools: ListedTool[]) {
  console.log(`Доступные инструменты (${tools.length}):`)
  for (const tool of tools) {
    console.log(`- ${tool.name}: ${tool.description ?? 'Без описания'}`)
  }
}

async function callToolAndPrintResult(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) {
    console.error(`Инструмент ${name} вернул ошибку: ${JSON.stringify(result.content)}`)
    return
  }

  console.log(`${name} → ${JSON.stringify(result.structuredContent ?? result.content)}`)
}

function printHelp() {
  console.log('Команды:')
  console.log('  tools              — повторно показать доступные инструменты')
  console.log('  greet <имя>        — вызвать greet')
  console.log('  time               — вызвать get_current_time')
  console.log('  sum <число> <число> — вызвать calculate_sum')
  console.log('  help               — показать эту подсказку')
  console.log('  exit               — закрыть соединение')
}

async function runCommand(client: Client, tools: ListedTool[], line: string) {
  const [command, ...argumentsList] = line.trim().split(/\s+/)

  if (!command) return true
  if (command === 'exit') return false
  if (command === 'help') {
    printHelp()
    return true
  }
  if (command === 'tools') {
    printTools(tools)
    return true
  }
  if (command === 'greet') {
    const name = argumentsList.join(' ')
    if (!name) {
      console.log('Использование: greet <имя>')
      return true
    }
    await callToolAndPrintResult(client, 'greet', { name })
    return true
  }
  if (command === 'time') {
    await callToolAndPrintResult(client, 'get_current_time', {})
    return true
  }
  if (command === 'sum') {
    const [firstInput, secondInput] = argumentsList
    const first = Number(firstInput)
    const second = Number(secondInput)
    if (!Number.isFinite(first) || !Number.isFinite(second)) {
      console.log('Использование: sum <число> <число>')
      return true
    }
    await callToolAndPrintResult(client, 'calculate_sum', { first, second })
    return true
  }

  console.log(`Неизвестная команда: ${command}. Введите help, чтобы увидеть список команд.`)
  return true
}

async function runCommandLoop(client: Client, tools: ListedTool[]) {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'mcp> ',
  })

  let isClosed = false
  terminal.once('close', () => {
    isClosed = true
  })
  terminal.on('SIGINT', () => terminal.close())
  printHelp()
  terminal.prompt()

  for await (const line of terminal) {
    const shouldContinue = await runCommand(client, tools, line)
    if (!shouldContinue) {
      terminal.close()
      break
    }
    if (!isClosed) terminal.prompt()
  }
}

async function listMcpTools() {
  const client = new Client({
    name: 'day-16-demo-client',
    version: '1.0.0',
  })

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', serverPath],
  })

  try {
    await client.connect(transport)
    const { tools } = await client.listTools()

    console.log('MCP-соединение установлено.')
    printTools(tools)
    console.log('Клиент ждёт команду. Введите help для подсказки.')
    await runCommandLoop(client, tools)
  } finally {
    await client.close()
  }
}

listMcpTools().catch((error: unknown) => {
  console.error('Не удалось получить список MCP-инструментов:', error)
  process.exitCode = 1
})
