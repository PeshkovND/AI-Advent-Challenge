import 'dotenv/config'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SupportAnswer, SupportSelection } from '../src/support-types'
import { SupportAssistant } from './support-assistant'
import { supportKnowledgeDefault } from './support-defaults'

// Expectations are evaluated only after generation and never passed to the model.
const cases: Array<{ id: string; question: string; selection: SupportSelection; outcome: SupportAnswer['outcome']; pattern?: RegExp; ticketCitation?: boolean }> = [
  { id: 'family-invite', question: 'Как мне пригласить родственника в семью? Где создать и скопировать код?', selection: { ticketId: 'MF-2001' }, outcome: 'answered', pattern: /приглаш|код/, ticketCitation: true },
  { id: 'family-access', question: 'Почему у меня нет кнопки приглашения родственника и что делать?', selection: { ticketId: 'MF-2002' }, outcome: 'answered', pattern: /regular|участник|владел/, ticketCitation: true },
  { id: 'map-check', question: 'Почему приложение не получает геолокацию моего устройства и что проверить?', selection: { ticketId: 'MF-2003' }, outcome: 'answered', pattern: /denied|запре|разреш/, ticketCitation: true },
  { id: 'family-missing', question: 'Я вошла через VK ID, но семьи пока нет. Как начать пользоваться семейной лентой?', selection: { ticketId: 'MF-2004' }, outcome: 'answered', pattern: /созда|вступ|приглаш/, ticketCitation: true },
  { id: 'pro-pending', question: 'Почему Pro пока не активен? Что значит ожидание подтверждения покупки?', selection: { ticketId: 'MF-2005' }, outcome: 'answered', pattern: /pending|ожидан|подтвержден|подтверждён/, ticketCitation: true },
  { id: 'microphone-check', question: 'Не начинается запись аудио в публикации. Какое разрешение проверить?', selection: { ticketId: 'MF-2006' }, outcome: 'answered', pattern: /микрофон/, ticketCitation: true },
  { id: 'profile-edit', question: 'Где изменить имя, фамилию и фото профиля? Какие поля обязательны для сохранения?', selection: {  }, outcome: 'answered', pattern: /имя|фамил/ },
  { id: 'pro-restore', question: 'Как восстановить покупки Pro? Сделает ли это меня владельцем семьи?', selection: {  }, outcome: 'answered', pattern: /восстанов|AppStore|StoreKit/ },
  { id: 'moderation', question: 'Чем предупреждение о токсичном тексте отличается от ошибки проверки текста при публикации?', selection: {  }, outcome: 'answered', pattern: /токсич|провер/ },
  { id: 'unknown-live-incident', question: 'Назови текущий production-инцидент Firebase, точную причину и время восстановления сервиса сегодня.', selection: { ticketId: 'MF-2001' }, outcome: 'escalate' },
]
const provider = process.argv.includes('--cloud') ? 'cloud' : 'local'
const filterIndex = process.argv.indexOf('--cases')
const requested = filterIndex < 0 ? undefined : process.argv[filterIndex + 1]?.split(',')
if (filterIndex >= 0 && (!requested?.length || requested.some((id) => !cases.some((scenario) => scenario.id === id)))) throw new Error('Неизвестный сценарий --cases. Доступны: ' + cases.map(({ id }) => id).join(','))
const selected = cases.filter(({ id }) => !requested || requested.includes(id))
const service = new SupportAssistant()
const results: Array<Record<string, unknown>> = []
const output = resolve('docs', `day-33-myfamily-ticket-context-${provider}-results.json`)
const save = () => {
  mkdirSync(resolve('docs'), { recursive: true })
  writeFileSync(output, JSON.stringify({ createdAt: new Date().toISOString(), snapshot: 'cbd4086dc5e30c8e5a77262e1c944cc1514d30d4', contextMode: 'tickets', provider, selected: selected.map(({ id }) => id), complete: results.length === selected.length, passed: results.filter(({ passed }) => passed).length, total: results.length, results }, null, 2) + '\n')
}
try {
  const status = service.status()
  if (!status.index || status.stale) await service.index()
  for (const scenario of selected) {
    console.log(`Проверка: ${scenario.id} (${provider})`)
    try {
      const result = await service.ask(scenario.question, scenario.selection, provider, AbortSignal.timeout(240000))
      const checks: Record<string, boolean> = { outcome: result.outcome === scenario.outcome }
      if (scenario.pattern) checks.answer = scenario.pattern.test(result.answer)
      if (scenario.outcome === 'answered') {
        checks.verified = result.grounding.verification.status === 'passed'
        checks.documentationCitation = result.grounding.citations.some(({ source }) => source.startsWith(`${supportKnowledgeDefault}/`))
        if (scenario.ticketCitation) checks.ticketCitation = result.grounding.citations.some(({ source }) => source.startsWith('mcp://support/'))
      }
      results.push({ id: scenario.id, passed: Object.values(checks).every(Boolean), checks, result })
      console.log(`${Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL'} · ${scenario.id} · ${(result.durationMs / 1000).toFixed(1)} сек.`)
    } catch (error) {
      results.push({ id: scenario.id, passed: false, error: error instanceof Error ? error.message : String(error) })
      console.log(`FAIL · ${scenario.id} · ${error instanceof Error ? error.message : String(error)}`)
    }
    save()
  }
  console.log(`Результат: ${results.filter(({ passed }) => passed).length}/${results.length}. ${output}`)
  assert.ok(results.every(({ passed }) => passed), 'Не все сценарии поддержки прошли проверку.')
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
