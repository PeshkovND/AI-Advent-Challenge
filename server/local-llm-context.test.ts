import test from 'node:test'
import assert from 'node:assert/strict'
import { selectLocalContext, contextCost } from '../src/local-llm-context'

test('keeps full turns and newest question within budget', () => {
  const messages = [
    { role: 'user' as const, content: 'старый'.repeat(200) },
    { role: 'assistant' as const, content: 'ответ'.repeat(200) },
    { role: 'user' as const, content: 'новый' },
    { role: 'assistant' as const, content: 'ответ' },
    { role: 'user' as const, content: 'вопрос' },
  ]
  const result = selectLocalContext(messages, 1024, 100)
  assert.equal(result.dropped, 2)
  assert.deepEqual(result.messages, messages.slice(2))
  assert.ok(result.estimatedTokens <= result.budget)
  assert.equal(messages.length, 5)
})
test('reserves answer space and rejects a question that cannot fit', () => {
  assert.throws(() => selectLocalContext([{ role: 'user', content: 'я'.repeat(300) }], 1024, 100), /Сам вопрос/)
  const result = selectLocalContext([{ role: 'user', content: 'Привет' }], 32768, 4096)
  assert.equal(result.budget, 28160)
  assert.equal(result.estimatedTokens, contextCost(result.messages[0]))
})
test('never sends an orphan assistant and retains current question', () => {
  const result = selectLocalContext([{ role: 'assistant', content: 'orphan' }, { role: 'user', content: 'question' }], 1024, 100)
  assert.deepEqual(result.messages, [{ role: 'user', content: 'question' }])
})
