export type LocalMessage = { role: 'user' | 'assistant'; content: string }
// UTF-8 bytes are a deliberately conservative estimate for a byte-based tokenizer.
export function contextCost(message: LocalMessage) {
  return new TextEncoder().encode(message.content).length + 64
}
export function selectLocalContext(messages: LocalMessage[], context: number, maxOutput: number) {
  const budget = context - maxOutput - 512
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') throw new Error('Нужен вопрос пользователя.')
  let used = contextCost(last)
  if (used > budget) throw new Error('Сам вопрос слишком большой для контекста. Сократите его или разделите на части.')
  let start = messages.length - 1
  // Keep whole user/assistant turns; never start with an orphan assistant reply.
  while (start >= 2) {
    const user = messages[start - 2], assistant = messages[start - 1]
    if (user.role !== 'user' || assistant.role !== 'assistant') break
    const cost = contextCost(user) + contextCost(assistant)
    if (used + cost > budget) break
    used += cost; start -= 2
  }
  return { messages: messages.slice(start), dropped: start, estimatedTokens: used, budget }
}
