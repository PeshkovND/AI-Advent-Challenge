import { useEffect, useRef, useState } from 'react'
import type { FolderListing, Project } from './project-types'

type OpenedProject = { project: Project; projects: Project[] }
export default function FolderPicker({ initialPath, onOpen, onClose }: {
  initialPath?: string; onOpen: (result: OpenedProject) => void; onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const request = useRef<AbortController | null>(null)
  const [listing, setListing] = useState<FolderListing>()
  const [path, setPath] = useState(initialPath || '~')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function post<T>(route: string, value: string, signal: AbortSignal): Promise<T> {
    const response = await fetch(`/api/releases/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: value }), signal })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Не удалось открыть папку.')
    return data
  }
  async function browse(next: string) {
    request.current?.abort()
    const abort = new AbortController(); request.current = abort
    setBusy(true); setError('')
    try {
      const result = await post<FolderListing>('folders', next, abort.signal)
      if (!abort.signal.aborted) { setListing(result); setPath(result.path) }
    } catch (err) { if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err)) }
    finally { if (!abort.signal.aborted) setBusy(false) }
  }
  async function open() {
    request.current?.abort()
    const abort = new AbortController(); request.current = abort
    setBusy(true); setError('')
    try { const result = await post<OpenedProject>('projects/open', path, abort.signal); if (!abort.signal.aborted) onOpen(result) }
    catch (err) { if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err)) }
    finally { if (!abort.signal.aborted) setBusy(false) }
  }
  useEffect(() => {
    dialog.current?.showModal()
    void browse(initialPath || '~')
    return () => { request.current?.abort() }
  }, [])
  return <dialog ref={dialog} className="project-folder-dialog" aria-labelledby="project-folder-title" onCancel={onClose}>
    <header><div><h2 id="project-folder-title">Открыть папку проекта</h2><p>Выберите папку на компьютере, где запущено приложение.</p></div><button type="button" aria-label="Закрыть выбор папки" onClick={onClose}>×</button></header>
    <form onSubmit={(event) => { event.preventDefault(); void browse(path) }} className="project-folder-path"><label htmlFor="project-folder-path">Путь к папке</label><div><input autoFocus id="project-folder-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/путь/к/проекту" /><button disabled={busy || !path.trim()}>Перейти</button></div></form>
    <nav aria-label="Навигация по папкам"><button disabled={busy} onClick={() => void browse(listing?.home || '~')}>Домой</button><button disabled={busy || !listing?.parent} onClick={() => void browse(listing!.parent!)}>↑ На уровень выше</button></nav>
    <div className="project-folder-list" aria-busy={busy} aria-label="Папки">{listing?.directories.map((name) => <button disabled={busy} key={name} onClick={() => void browse(`${listing.path}/${name}`)}><span aria-hidden="true">▱</span>{name}<span aria-hidden="true">›</span></button>)}{listing && !listing.directories.length && <p>Вложенных папок нет. Можно открыть текущую папку.</p>}</div>
    {busy && <p role="status">Открываем папку…</p>}{error && <p className="release-error" role="alert">{error}</p>}
    <small>Анализ использует коммиты выбранного Git-репозитория. Скрытые папки можно открыть по пути.{listing?.truncated ? ' Показаны первые 2000 папок; укажите нужный путь вручную.' : ''}</small>
    <footer><button onClick={onClose}>Отмена</button><button className="project-folder-confirm" disabled={busy || !path.trim()} onClick={() => void open()}>Открыть проект</button></footer>
  </dialog>
}
