import { ragQuestions, type RagQuestion } from './rag-questions'

export const ragAbstentionQuestion: RagQuestion = {
  id: 14, question: 'Какая схема репликации Redis и сколько Redis-реплик настроено в этом проекте?',
  expected: 'В документах нет подтверждённой конфигурации Redis или количества реплик.', sources: [], evidence: [],
}

export const additionalRagQuestions: RagQuestion[] = [
  { ...ragQuestions[0], id: 11, question: 'Что лежит в SQLite планировщика и как обеспечивается атомарный захват запуска воркером?' },
  { ...ragQuestions[5], id: 12, question: 'Откуда берётся timezone для расписания, если пользователь явно не назвал город или пояс?' },
  { id: 13, question: 'Какой оптимизатор и learning rate использует этот проект при обучении нейросети на GPU?', expected: 'В документах нет подтверждения, что проект обучает нейросеть на GPU; оптимизатор и learning rate неизвестны.', sources: [], evidence: [] },
  ragAbstentionQuestion,
]
export const day23Questions = [...ragQuestions, ...additionalRagQuestions]
