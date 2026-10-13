import { networkInterfaces } from 'node:os'
import { createPrivateLlmApp } from './private-llm-app'
import { initializePrivateLlmEnvironment, privateLlmConfigPath } from './private-llm-config'
import { createPrivateLlmLogger } from './private-llm-logger'

const config = await initializePrivateLlmEnvironment()
const log = createPrivateLlmLogger({ logPrompts: config.logPrompts, timeZone: process.env.AGENT_TIME_ZONE || 'Asia/Omsk' })
const app = createPrivateLlmApp(config, undefined, log)
const server = app.listen(config.port, config.host, () => {
  console.log(`Приватная LLM: http://127.0.0.1:${config.port}`)
  const hosts = config.host === '0.0.0.0' || config.host === '::'
    ? Object.values(networkInterfaces()).flatMap((items) => items || []).filter((item) => item.family === 'IPv4' && !item.internal).map((item) => item.address)
    : [config.host]
  for (const host of hosts) console.log(`Со второго компьютера: http://${host.includes(':') ? `[${host}]` : host}:${config.port}`)
  console.log(`Ключ доступа и настройки: ${privateLlmConfigPath}`)
  console.log(`${config.model}; контекст ${config.context}; ответ ${config.maxTokens}; ${config.requestsPerMinute} запросов/мин; 1 генерация + до ${config.maxQueueSize} в очереди; ожидание до ${config.queueTimeoutMs / 1000} сек.`)
  console.log(`Логи запросов выводятся здесь: время, IP, очередь, генерация и завершение${config.logPrompts ? ', первые 200 символов вопроса' : ''}.`)
})
server.on('error', (error) => { console.error(`Не удалось запустить сервис: ${error.message}`); process.exitCode = 1 })
const shutdown = () => {
  server.closeIdleConnections()
  server.closeAllConnections()
  server.close(() => process.exit(0))
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
