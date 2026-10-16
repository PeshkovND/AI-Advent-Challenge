import 'dotenv/config'
import './network-config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { CodeReviewAssistant, renderReview, reviewComment } from './code-review'
import { collectReviewContext, reviewLimits, retrieveReviewSources } from './code-review-context'

async function main() {
  const { values } = parseArgs({ options: {
    base: { type: 'string' }, head: { type: 'string', default: 'HEAD' }, root: { type: 'string', default: process.cwd() },
    output: { type: 'string', default: 'data/code-review' }, local: { type: 'boolean', default: false },
    'prepare-only': { type: 'boolean', default: false },
  } })
  if (!values.base) throw new Error('Укажите --base <ветка или SHA>; пример: npm run review:pr -- --base main --head HEAD')
  const output = resolve(values.output!)
  mkdirSync(output, { recursive: true })
  const signal = AbortSignal.timeout(12 * 60 * 1000)
  if (values['prepare-only']) {
    const context = await collectReviewContext(values.root!, values.base, values.head!, signal)
    const { corpus, ...metadata } = context
    writeFileSync(resolve(output, 'context.json'), JSON.stringify({ ...metadata, limits: reviewLimits,
      retrieval: context.files.map((file) => ({ path: file.path, sources: retrieveReviewSources(file, corpus) })) }, null, 2) + '\n', { mode: 0o600 })
    console.log(`Контекст готов: ${context.files.length}/${context.totalFiles} файлов; RAG: ${context.corpusDocuments} документов и файлов кода. ${output}/context.json`)
    return
  }
  const report = await new CodeReviewAssistant({ root: values.root, provider: values.local ? 'local' : 'cloud',
    onProgress: (path) => console.error(`Ревью: ${JSON.stringify(path)}`) }).review(values.base, values.head!, signal)
  const markdown = renderReview(report)
  for (const [name, text] of [['review.json', JSON.stringify(report, null, 2) + '\n'], ['review.md', markdown], ['comment.md', reviewComment(markdown)]]) {
    writeFileSync(resolve(output, name), text, { mode: 0o600 })
  }
  console.log(`Ревью: ${report.status}; файлов ${report.reviewedFiles}/${report.totalFiles}; замечаний ${report.findings.length}. ${output}/review.md`)
  if (report.files.some((file) => file.error)) process.exitCode = 1
}
main().catch(() => {
  // Avoid echoing a raw provider error or Git command that might contain private input.
  console.error('AI-ревью не выполнено. Проверьте --base/--head, доступность Git refs, DEEPSEEK_API_KEY (или Ollama с --local) и лимиты контекста. Пример: npm run review:pr -- --base main --head HEAD')
  process.exitCode = 1
})
