import { initializePrivateLlmEnvironment, privateLlmConfigPath } from './private-llm-config'

await initializePrivateLlmEnvironment()
console.log(`Настройки и ключ доступа: ${privateLlmConfigPath}`)
console.log('Запуск: npm run llm:service')
