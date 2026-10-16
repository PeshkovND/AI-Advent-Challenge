import 'dotenv/config'
import './network-config'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CodeReviewAssistant, renderReview } from './code-review'

/** Real model smoke test in an isolated repository, without committing application files. */
async function main() {
  const local = process.argv.includes('--local')
  const root = mkdtempSync(join(tmpdir(), 'ai-review-demo-'))
  const output = resolve('data/code-review-demo')
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    git('init', '-q'); git('config', 'user.name', 'Review demo'); git('config', 'user.email', 'demo@example.test')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'README.md'), '# Invoice contract\nInvoice total must equal price multiplied by quantity. Nonnegative prices and quantities are allowed.\n')
    writeFileSync(join(root, 'src/invoice.ts'), 'export const invoiceTotal = (price: number, quantity: number) => price * quantity\n')
    writeFileSync(join(root, 'src/checkout.ts'), "import { invoiceTotal } from './invoice'\nexport const total = invoiceTotal(100, 3)\n")
    git('add', '.'); git('commit', '-qm', 'Correct invoice total')
    const base = git('rev-parse', 'HEAD')
    writeFileSync(join(root, 'src/invoice.ts'), 'export const invoiceTotal = (price: number, quantity: number) => price + quantity\n')
    git('add', '.'); git('commit', '-qm', 'Introduce arithmetic regression for review')
    const head = git('rev-parse', 'HEAD')
    const report = await new CodeReviewAssistant({ root, provider: local ? 'local' : 'cloud' }).review(base, head, AbortSignal.timeout(6 * 60 * 1000))
    const detected = report.findings.some((finding) => finding.category === 'bug' && finding.path === 'src/invoice.ts' && finding.side === 'RIGHT' && finding.line === 1)
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'review.md'), renderReview(report))
    writeFileSync(join(output, 'review.json'), JSON.stringify({ ...report, demo: { expected: 'price * quantity was replaced by price + quantity', detected } }, null, 2) + '\n')
    console.log(`Демо: ${report.status}; арифметическая регрессия ${detected ? 'обнаружена' : 'не обнаружена'}. ${output}/review.md`)
    if (!detected || report.files.some((file) => file.error)) process.exitCode = 1
  } finally { rmSync(root, { recursive: true, force: true }) }
}
main().catch(() => { console.error('Демо не выполнено. Проверьте DEEPSEEK_API_KEY или Ollama (--local).'); process.exitCode = 1 })
