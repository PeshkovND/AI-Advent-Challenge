import test from 'node:test'
import assert from 'node:assert/strict'
import { localEvidence, resolveLocalEvidence } from './local-rag-evidence'
import { parseGroundedAnswer } from './rag-grounding'
import type { RagSource } from '../src/rag-types'

const source: RagSource = { source: 'doc.md', title: 'Doc', section: 'Memory', chunkId: 'real-chunk', strategy: 'structured', score: 1,
  text: '| Working | `config.memoryLayers.working` |\n| Long-term | Stored facts |\n\nExact   spaces, `code`, and punctuation.' }

test('selected evidence restores exact Markdown and whitespace from the indexed source', () => {
  const catalogue = localEvidence([source])
  const content = resolveLocalEvidence(JSON.stringify({ status: 'answered', claims: [{ text: 'Working memory uses config.memoryLayers.working.', evidenceIds: [catalogue[0].id] }] }), catalogue)
  const answer = parseGroundedAnswer(content, [source])
  assert.equal(answer.status, 'answered')
  if (answer.status === 'answered') assert.equal(answer.citations[0].quote, source.text.split('\n\n')[0])
})
test('large passages preserve bounded literal windows and original chunk identity', () => {
  const long = { ...source, text: 'x'.repeat(3600) }
  const catalogue = localEvidence([long])
  assert.ok(catalogue.length > 1)
  assert.equal(new Set(catalogue.map((item) => item.id)).size, catalogue.length)
  for (const item of catalogue) {
    assert.ok(item.quote.length >= 12 && item.quote.length <= 1200)
    assert.ok(long.text.includes(item.quote))
    assert.equal(item.chunkId, source.chunkId)
  }
})
test('invented evidence, uncited claims and model supplied quotes are rejected', () => {
  const catalogue = localEvidence([source])
  for (const claim of [{ text: 'Fact', evidenceIds: ['invented'] }, { text: 'Fact', evidenceIds: [] },
    { text: 'Fact', evidenceIds: ['e1'], quote: 'fabricated text' }]) {
    assert.throws(() => resolveLocalEvidence(JSON.stringify({ status: 'answered', claims: [claim] }), catalogue))
  }
})
test('absence of evidence retains unknown and does not manufacture citations', () => {
  assert.equal(resolveLocalEvidence('{"status":"unknown"}', []), '{"status":"unknown"}')
  assert.deepEqual(localEvidence([{ ...source, text: 'Short' }]), [])
})


test('section headings are not selectable evidence; the adjacent factual paragraph remains literal', () => {
  const fact = 'Pending means that the transaction is awaiting confirmation.'
  const document = { ...source, text: '# Purchase support\n\n## Pending purchase\n\n' + fact }
  const catalogue = localEvidence([document])
  assert.equal(catalogue.length, 1)
  assert.equal(catalogue[0].quote, fact)
  assert.equal(catalogue[0].section, source.section)
  const content = resolveLocalEvidence(JSON.stringify({ status: 'answered', claims: [{ text: fact, evidenceIds: [catalogue[0].id] }] }), catalogue)
  assert.equal(parseGroundedAnswer(content, [document]).status, 'answered')
  assert.deepEqual(localEvidence([{ ...source, text: '## A heading without facts' }]), [])
})
