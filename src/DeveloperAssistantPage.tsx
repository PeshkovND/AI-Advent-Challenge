import { useEffect, useState } from 'react'
import DeveloperFolderPicker from './DeveloperFolderPicker'
import CodingAssistantPanel from './CodingAssistantPanel'
import type { DeveloperProject } from './developer-types'
import './chat.css'
import './developer-assistant.css'

export default function DeveloperAssistantPage() {
  const [projects, setProjects] = useState<DeveloperProject[]>([])
  const [projectId, setProjectId] = useState('current')
  const [folderPicker, setFolderPicker] = useState(false)
  const [error, setError] = useState('')
  function selectProject(id: string) {
    setProjectId(id)
    try { localStorage.setItem('deepchat-developer-project', id) } catch { /* Selection works without storage. */ }
  }
  useEffect(() => {
    const abort = new AbortController()
    void fetch('/api/developer/projects', { signal: abort.signal }).then(async (response) => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Не удалось загрузить проекты.')
      if (abort.signal.aborted) return
      let saved: string | null = null
      try { saved = localStorage.getItem('deepchat-developer-project') } catch { /* Use server default. */ }
      setProjects(data.projects)
      setProjectId(data.projects.some(({ id }: DeveloperProject) => id === saved) ? saved! : data.defaultProjectId)
    }).catch((err) => { if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err)) })
    return () => abort.abort()
  }, [])
  return <>
    {error && <p className="rag-chat-error" role="alert">{error}</p>}
    <CodingAssistantPanel projectId={projectId} projects={projects} onSelect={selectProject} onFolder={() => setFolderPicker(true)} />
    {folderPicker && <DeveloperFolderPicker initialPath={projects.find(({ id }) => id === projectId)?.root} onClose={() => setFolderPicker(false)} onOpen={(result) => { setProjects(result.projects); selectProject(result.project.id); setFolderPicker(false) }} />}
  </>
}
