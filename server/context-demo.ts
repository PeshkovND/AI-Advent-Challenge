import type { AgentMessage } from './agent-service'

export type ContextDemoScenario = 'short' | 'long' | 'overflow'

export type ContextDemoPreparation = {
  id: ContextDemoScenario
  title: string
  description: string
  model: string
  history: AgentMessage[]
  input: string
  historyMessages: number
}

export type ContextDemoSnapshot = {
  id: ContextDemoScenario
  title: string
  description: string
  model: string
  historyMessages: number
  conversationTokens: number
}

const MODEL = 'liquid/lfm-2.5-2.6b:free'

export function prepareContextDemo(scenario: ContextDemoScenario): ContextDemoPreparation {
  const history = scenario === 'short' ? buildShortHistory() : scenario === 'long' ? buildLongHistory() : buildOverflowHistory()
  const labels = {
    short: {
      title: 'Короткий диалог',
      description: 'Несколько сообщений с небольшим контекстом.',
      input: 'Продолжи разговор и кратко напомни, что мы уже обсудили.',
    },
    long: {
      title: 'Длинный диалог',
      description: 'Подготовленная история из множества обычных сообщений.',
      input: 'Продолжи разговор, учитывая предыдущие сообщения, и выдели главные договорённости.',
    },
    overflow: {
      title: 'Почти переполненный контекст',
      description: 'История подготовлена близко к лимиту LFM2.5. Следующее сообщение должно проверить переполнение.',
      input: 'Собери все важные детали из нашей переписки и дай итоговый ответ.',
    },
  }[scenario]

  return {
    id: scenario,
    title: labels.title,
    description: labels.description,
    model: MODEL,
    history,
    input: labels.input,
    historyMessages: history.length,
  }
}

export function isContextDemoScenario(value: string): value is ContextDemoScenario {
  return value === 'short' || value === 'long' || value === 'overflow'
}

export function resetContextDemo(scenario: ContextDemoScenario): ContextDemoSnapshot {
  const preparation = prepareContextDemo(scenario)
  return {
    id: preparation.id,
    title: preparation.title,
    description: preparation.description,
    model: preparation.model,
    historyMessages: preparation.historyMessages,
    conversationTokens: 0,
  }
}

function buildShortHistory(): AgentMessage[] {
  return [
    { role: 'user', content: 'Я делаю небольшое React-приложение для списка задач.' },
    { role: 'assistant', content: 'Хорошая идея. Можно начать с компонента списка, состояния задач и формы добавления.' },
    { role: 'user', content: 'Для хранения состояния пока хочу использовать useState.' },
    { role: 'assistant', content: 'Для простого прототипа useState подойдёт. Позже состояние можно вынести в отдельный store.' },
  ]
}

function buildLongHistory(): AgentMessage[] {
  const history: AgentMessage[] = []
  for (let index = 1; index <= 28; index += 1) {
    history.push(
      { role: 'user', content: `Сообщение ${index}: я продумываю структуру приложения, экран ${index} и его пользовательский сценарий. Что стоит учесть при реализации?` },
      { role: 'assistant', content: `Для экрана ${index} полезно заранее разделить данные, состояние и представление. Проверьте обработку ошибок, пустое состояние, повторную загрузку и удобство навигации.` },
    )
  }
  return history
}

function buildOverflowHistory(): AgentMessage[] {
  const history: AgentMessage[] = []
  // Точное переполнение определяет только провайдер по своему токенизатору,
  // поэтому этот вспомогательный сценарий не оценивает токены.
  for (let index = 1; index <= 1800; index += 1) {
    const userContent = `Запись ${index}. Пользователь обсуждает архитектуру приложения: модуль ${index} должен иметь понятный интерфейс, независимые тесты, обработку ошибок, сохранение состояния и возможность заменить реализацию без изменения остальных модулей. Зафиксируй эту деталь для продолжения диалога.`
    const assistantContent = `Запись ${index} принята. Важные детали: модуль изолирован, его состояние сохраняется, ошибки обрабатываются явно, тесты независимы, а интерфейс не зависит от внутренней реализации. Это подготовленный фрагмент контекста для проверки окна модели.`
    history.push(
      { role: 'user', content: userContent },
      { role: 'assistant', content: assistantContent },
    )
  }

  return history
}
