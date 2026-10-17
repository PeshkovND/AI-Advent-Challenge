import { defaultRagSettings, improvedAgentConfig } from './rag-improved-config'

export function groundedAgentConfig(indexRunId: string) {
  const config = improvedAgentConfig('full', defaultRagSettings, indexRunId)
  return { ...config, name: 'Day 24 · RAG с проверяемыми цитатами', rag: { ...config.rag, grounding: { enabled: true } } }
}
