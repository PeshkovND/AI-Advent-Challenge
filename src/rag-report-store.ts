import type { RagQuestion } from './rag-questions'
import type { RagMode, RagSettings } from './rag-improved-config'
import type { RagResult } from './rag-types'
import type { DemoSnapshot } from './rag-demo-config'

export type RagRunResult = { output: string; durationMs: number; model: string; totalTokens: number; promptTokens?: number; rag?: RagResult }
export type AnswerGrade = 'full' | 'partial' | 'wrong'
export type RagComparison = { answers: Partial<Record<RagMode, RagRunResult>>; errors: Partial<Record<RagMode, string>>; grades: Partial<Record<RagMode, AnswerGrade>> }
export type RagReport = {
  id: string; createdAt: string; settings: RagSettings; index: { id: string; model: string; embeddingProfile: string }
  modes: RagMode[]; questions: RagQuestion[]; results: Record<number, RagComparison>; completed: boolean
}

function openReports(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('deepchat-rag-reports', 2)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('reports')) request.result.createObjectStore('reports', { keyPath: 'id' })
      if (!request.result.objectStoreNames.contains('comparison')) request.result.createObjectStore('comparison')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Закройте другие вкладки RAG и обновите страницу для сохранения результатов.'))
  })
}
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>, storeName = 'reports'): Promise<T> {
  const db = await openReports()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode)
      const request = action(tx.objectStore(storeName))
      tx.oncomplete = () => resolve(request.result)
      tx.onerror = () => reject(tx.error ?? request.error)
      tx.onabort = () => reject(tx.error ?? new Error('Сохранение отчёта прервано.'))
    })
  } finally { db.close() }
}
export async function listRagReports(): Promise<RagReport[]> {
  const reports = await transaction('readonly', (store) => store.getAll()) as RagReport[]
  return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
export async function saveRagReport(report: RagReport) { await transaction('readwrite', (store) => store.put(report)) }
export async function deleteRagReport(id: string) { await transaction('readwrite', (store) => store.delete(id)) }
export async function loadDemoSnapshot(): Promise<DemoSnapshot | undefined> { return await transaction('readonly', (store) => store.get('latest'), 'comparison') }
export async function saveDemoSnapshot(snapshot: DemoSnapshot) { await transaction('readwrite', (store) => store.put(snapshot, 'latest'), 'comparison') }
