import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// Isolated Swift/Xcode fixture for the published Action's CI smoke test.
const workspace = process.env.GITHUB_WORKSPACE || process.cwd()
const root = mkdtempSync(join(workspace, '.review-fixture-'))
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
git('init', '-q'); git('config', 'user.name', 'Action smoke test'); git('config', 'user.email', 'smoke@example.test')
mkdirSync(join(root, 'Docs'))
writeFileSync(join(root, 'Docs/Architecture.md'), '# Invoice contract\nInvoice.total must return price multiplied by quantity.\n')
writeFileSync(join(root, 'Invoice.swift'), 'func total(price: Int, quantity: Int) -> Int { price * quantity }\n')
writeFileSync(join(root, 'Checkout.swift'), 'let invoiceTotal = total(price: 100, quantity: 3)\n')
writeFileSync(join(root, 'App.xcconfig'), 'SWIFT_VERSION = 5.0\n')
writeFileSync(join(root, 'App.pbxproj'), '// Xcode project fixture\n')
writeFileSync(join(root, 'Info.plist'), '<plist><dict/></plist>\n')
writeFileSync(join(root, 'App.entitlements'), '<plist><dict/></plist>\n')
// Installing target dependencies would fail: the Action must never run this.
writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { postinstall: 'exit 99' } }))
git('add', '.'); git('commit', '-qm', 'correct Swift baseline'); const base = git('rev-parse', 'HEAD')
writeFileSync(join(root, 'Invoice.swift'), 'func total(price: Int, quantity: Int) -> Int { price + quantity }\n')
git('add', '.'); git('commit', '-qm', 'intentional regression'); const head = git('rev-parse', 'HEAD')
const outputs = `repository-path=${relative(workspace, root)}\nbase=${base}\nhead=${head}\n`
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs)
else console.log(outputs)
