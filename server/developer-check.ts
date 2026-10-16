import 'dotenv/config'
import './network-config'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { DeveloperProjects, parseDeveloperArguments } from './developer-projects'

// Local by default; --cloud explicitly sends retrieved context to configured DeepSeek.
const args = parseDeveloperArguments(process.argv.slice(2))
assert.ok(!args.command && !args.index, 'Используйте --project ID, --cases FILE и необязательный --cloud.')
assert.ok(args.project === 'current' || args.cases, 'Для внешнего проекта укажите --cases с контрольными вопросами.')
const provider = args.cloud ? 'cloud' : 'local'
const reportPath = resolve(`data/day-31-check${args.project === 'current' ? '' : '-' + args.project}${provider === 'cloud' ? '-cloud' : ''}.json`)
const service = new DeveloperProjects().get(args.project)
const status = service.status()
if (!status.index || status.stale) await service.index()
const defaultCases = [
  { question: '/help Как устроен проект: где интерфейс и сервер, как его запустить и какая сейчас git-ветка?', expected: 'answered', mcpCitation: true, required: ['src/', 'server/', 'npm run dev'] },
  { question: '/help Какой HTTP endpoint отвечает на вопросы ассистенту разработчика и какие поля он принимает?', expected: 'answered', mcpCitation: false, required: ['/api/developer/help', 'input', 'provider'] },
  { question: '/help Какие настройки Kubernetes production-кластера и SLA 99.99% используются в этом проекте?', expected: 'unknown', mcpCitation: false, required: [] },
] as const
const cases = args.cases ? z.array(z.object({ question: z.string().min(1).max(4000), expected: z.enum(['answered', 'unknown']),
  required: z.array(z.string()).default([]), requiredSources: z.array(z.string()).default([]), mcpCitation: z.boolean().default(false), branchInventory: z.boolean().optional(),
}).strict()).min(1).max(30).parse(JSON.parse(readFileSync(resolve(args.cases), 'utf8'))) : defaultCases
const results = []
for (const item of cases) {
  const result = await service.help(item.question, provider)
  const missing = item.required.filter((term) => !result.answer.includes(term))
  const missingSources = ('requiredSources' in item ? item.requiredSources : []).filter((source) => !result.grounding.citations.some((citation) => citation.source === source))
  const branch = result.context.receipts.find((receipt) => receipt.name === 'get_git_branch')?.result
  const gitReference = typeof branch?.branch === 'string' ? branch.branch : typeof branch?.commit === 'string' ? branch.commit.slice(0, 7) : undefined
  const branchInventory = 'branchInventory' in item && item.branchInventory ? result.context.receipts.find(({ name }) => name === 'list_git_branches')?.result : undefined
  const inventory = branchInventory ? z.object({ local: z.object({ branches: z.array(z.string()), total: z.number(), truncated: z.boolean() }),
    remote: z.object({ branches: z.array(z.string()), total: z.number(), truncated: z.boolean() }),
  }).parse(branchInventory) : undefined
  const missingBranches = inventory ? [...inventory.local.branches, ...inventory.remote.branches].filter((name) => !result.answer.includes(name)) : []
  const inventoryPassed = !('branchInventory' in item && item.branchInventory) || Boolean(inventory && !missingBranches.length
    && result.grounding.citations.some(({ source }) => source === 'mcp://project/list_git_branches') && result.grounding.verification.taskCheck?.answersQuestion)
  const passed = result.grounding.status === item.expected && !missing.length && !missingSources.length && inventoryPassed && (!item.mcpCitation || Boolean(gitReference && result.answer.includes(gitReference)) && result.grounding.citations.some((citation) => citation.source === 'mcp://project/get_git_branch'))
  results.push({ question: result.question, passed, missing, missingSources, expected: item.expected, status: result.grounding.status, model: result.model,
    durationMs: result.durationMs, answer: result.answer, citations: result.grounding.citations, verification: result.grounding.verification,
    retrievedDocuments: result.sources.filter((source) => !source.source.startsWith('mcp://')).map(({ source, section, score }) => ({ source, section, score })),
    mcpTools: result.context.receipts.map(({ name }) => name),
    ...(inventory ? { branchInventory: { localTotal: inventory.local.total, remoteTotal: inventory.remote.total, missingBranches } } : {}),
  })
  console.log(`${passed ? 'PASS' : 'FAIL'} · ${Math.round(result.durationMs / 1000)} сек. · ${result.question}\n${result.answer}\n`)
  writeFileSync(reportPath, JSON.stringify({ createdAt: new Date().toISOString(), provider, projectId: args.project, indexRunId: result.indexRunId, results }, null, 2) + '\n')
}
assert.ok(results.every((result) => result.passed), `Есть ошибки проверки. См. ${reportPath}.`)
