export type TaskStage = 'planning' | 'execution' | 'validation' | 'done'
export type TaskStatus = 'active' | 'paused'
export type TaskActor = 'agent' | 'user'

export type AgentTaskState = {
  id: string
  task: string
  stage: TaskStage
  status: TaskStatus
  currentStep: string
  expectedAction: string
  expectedActor: TaskActor
  completedSteps: string[]
  updatedAt: string
}

export type TaskDecision = {
  answer: string
  nextStage?: TaskStage
  currentStep?: string
  expectedAction?: string
}

export const taskStages: TaskStage[] = ['planning', 'execution', 'validation', 'done']
const transitions: Record<TaskStage, TaskStage[]> = {
  planning: ['execution'],
  execution: ['planning', 'validation'],
  validation: ['execution', 'done'],
  done: [],
}

export function newTaskState(task: string): AgentTaskState {
  return { id: `task-${globalThis.crypto.randomUUID()}`, task, stage: 'planning', status: 'active', currentStep: 'Составить и согласовать план работы.', expectedAction: 'Подтвердить план или перечислить необходимые правки.', expectedActor: 'user', completedSteps: [], updatedAt: new Date().toISOString() }
}

export function taskScopeId(agentId: string, state: AgentTaskState) {
  return `${agentId}::task::${state.id}`
}

export function taskStatePrompt(state?: AgentTaskState) {
  if (!state) return undefined
  return `ФОРМАЛЬНОЕ СОСТОЯНИЕ ЗАДАЧИ
Задача: ${state.task}
Этап: ${state.stage}
Статус: ${state.status}
Текущий шаг: ${state.currentStep}
Ожидаемое действие: ${state.expectedAction}
Ожидаемый исполнитель: ${state.expectedActor === 'agent' ? 'агент' : 'пользователь'}
Завершённые шаги: ${state.completedSteps.length ? state.completedSteps.map((step) => `- ${step}`).join('\n') : 'нет'}

Продолжай только с текущего шага и не повторяй завершённые объяснения. Верни ТОЛЬКО JSON без Markdown:
{"answer":"ответ пользователю","nextStage":"planning | execution | validation | done либо пустая строка","currentStep":"актуальный шаг","expectedAction":"что ожидается дальше"}

Правила ролей: на planning пользователь утверждает план или даёт правки; на execution работаешь только ты и не просишь пользователя подтвердить промежуточный результат; когда результат готов, сам предложи переход execution → validation; на validation пользователь принимает результат (validation → done) либо указывает ошибку (validation → execution). Для planning → execution нужен явный текст пользователя, подтверждающий план. При необходимости пересмотреть план во время execution предлагай execution → planning. Если предлагаешь переход на другой незавершённый этап, в поле answer дай только короткое сообщение о начале нового этапа. Сервер затем сам вызовет тебя для выполнения первого шага и покажет его отдельным сообщением. На внутреннее сообщение с префиксом «ВНУТРЕННЕЕ ПРОДОЛЖЕНИЕ» сразу выполни текущий шаг, продвигай execution до готового результата и переводи его в validation; не обещай работу на потом. Когда переводишь задачу из execution в validation, поле answer обязано содержать полное самостоятельное решение целиком с учётом всех прошлых правок — не список изменений, не выдержки и не обещание выдать результат позднее. Код сервера проверит каждый переход.`
}

export function parseTaskDecision(output: string): TaskDecision | undefined {
  const source = output.trim().replace(/^```json\s*|^```|```$/gim, '').trim()
  // Некоторые провайдеры дописывают JSON после обычного текста вопреки инструкции.
  // Берём последний корректный объект с `answer`, чтобы не показать служебные поля в чате.
  for (const candidate of [source, ...jsonObjectsFrom(source).reverse()]) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (!isRecord(parsed) || typeof parsed.answer !== 'string' || !parsed.answer.trim()) continue
      const nextStage = isTaskStage(parsed.nextStage) ? parsed.nextStage : undefined
      return {
        answer: parsed.answer.trim(),
        ...(nextStage ? { nextStage } : {}),
        ...(typeof parsed.currentStep === 'string' && parsed.currentStep.trim() ? { currentStep: parsed.currentStep.trim().slice(0, 2_000) } : {}),
        ...(typeof parsed.expectedAction === 'string' && parsed.expectedAction.trim() ? { expectedAction: parsed.expectedAction.trim().slice(0, 2_000) } : {}),
      }
    } catch { /* Ищем следующий JSON-фрагмент в ответе модели. */ }
  }
  return undefined
}

function jsonObjectsFrom(source: string) {
  const objects: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') { inString = true; continue }
    if (character === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (character === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        objects.push(source.slice(start, index + 1))
        start = -1
      }
    }
  }
  return objects
}

export function applyTaskDecision(state: AgentTaskState, decision: TaskDecision, userInput: string): { state: AgentTaskState; notice?: string } {
  const currentStep = decision.currentStep ?? state.currentStep
  const expectedAction = decision.expectedAction ?? state.expectedAction
  let next = { ...state, currentStep, expectedAction, expectedActor: actorForStage(state.stage), updatedAt: new Date().toISOString() }
  if (!decision.nextStage || decision.nextStage === state.stage) return { state: next }
  if (state.status === 'paused') return { state, notice: 'Задача на паузе: предложение модели не применено.' }
  if (!transitions[state.stage].includes(decision.nextStage)) return { state, notice: `Переход ${state.stage} → ${decision.nextStage} запрещён.` }
  if (state.stage === 'planning' && decision.nextStage === 'execution' && !isPlanApproved(userInput)) return { state, notice: 'Переход planning → execution ожидает явного утверждения плана.' }
  next = { ...next, stage: decision.nextStage, expectedActor: actorForStage(decision.nextStage), completedSteps: [...state.completedSteps, state.currentStep].slice(-50) }
  return { state: next }
}

export function advanceTaskState(state: AgentTaskState, details: Pick<AgentTaskState, 'currentStep' | 'expectedAction'>): AgentTaskState {
  const target = taskStages[taskStages.indexOf(state.stage) + 1]
  if (!target) throw new Error('Задача уже завершена: дальнейших этапов нет.')
  const result = applyTaskDecision(state, { answer: 'manual', nextStage: target, ...details }, state.stage === 'planning' ? 'План утверждаю' : '')
  if (result.notice) throw new Error(result.notice)
  return result.state
}

export function returnTaskToExecution(state: AgentTaskState, details: Pick<AgentTaskState, 'currentStep' | 'expectedAction'>): AgentTaskState {
  const result = applyTaskDecision(state, { answer: 'manual', nextStage: 'execution', ...details }, '')
  if (result.notice) throw new Error(result.notice)
  return result.state
}

export function isPlanApproved(value: string) { return /(?:утверждаю|подтверждаю|согласовано|утверждено|план подходит|всё ок|все ок|приступай)/i.test(value) }
export function isResultApproved(value: string) { return /(?:принимаю|принять|подтверждаю|подтвердить|утверждаю|утвердить|всё верно|все верно|результат подходит|работа готова|согласен)/i.test(value) }
export function actorForStage(stage: TaskStage): TaskActor { return stage === 'execution' ? 'agent' : 'user' }
function isTaskStage(value: unknown): value is TaskStage { return value === 'planning' || value === 'execution' || value === 'validation' || value === 'done' }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
