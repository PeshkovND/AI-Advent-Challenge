import { groundedAgentConfig } from './rag-grounded-config'

export const ragChatAgentId = 'day25-rag-chat'
export function ragChatAgentConfig(indexRunId: string) {
  const config = groundedAgentConfig(indexRunId)
  return {
    ...config, name: 'Day 25 · RAG-чат с памятью задачи',
    systemPrompt: 'Ты — помощник по документации этого проекта. Веди связный диалог на русском, помни конечную цель и уточнения пользователя. Отвечай естественно и кратко, соблюдая его ограничения. На приветствия и обычное общение отвечай нормально; явно общие вопросы объясняй из общих знаний, не выдавая их за реализацию проекта. Факты о проекте подтверждай найденными документами, а сведения о цели/пожеланиях — словами пользователя. Если для вопроса о проекте подтверждения нет, скажи «Не знаю» и попроси уточнение. Не подменяй неизвестную реализацию общими знаниями.',
    dialogueMemory: { enabled: true, historyWindow: 6 },
    // Dialogue preparation already performs contextual query rewrite; no duplicate rewrite call.
    rag: { ...config.rag, queryRewrite: false, retrievalPolicy: 'auto' as const },
    inputPolicy: { maxCharacters: 8000 },
  }
}
