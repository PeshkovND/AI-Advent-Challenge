import { StrictMode, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import LocalLlmPage from './LocalLlmPage'
import './private-llm.css'

const sessionKey = 'private-llm-access-key'
function savedKey() {
  try { return sessionStorage.getItem(sessionKey) || '' } catch { return '' }
}
function PrivateLlmApp() {
  const [apiKey, setApiKey] = useState(savedKey)
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  function logout() {
    try { sessionStorage.removeItem(sessionKey) } catch { /* Storage may be disabled. */ }
    setApiKey(''); setInput(''); setError('')
  }
  async function login(event: FormEvent) {
    event.preventDefault()
    const key = input.trim()
    if (!key || busy) return
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/local-llm/status', { headers: { Authorization: `Bearer ${key}` } })
      if (response.status === 401) throw new Error('Ключ не подходит. Скопируйте PRIVATE_LLM_API_KEY из настроек на сервере.')
      if (!response.ok && response.status !== 503) throw new Error('Не удалось подключиться к сервису.')
      try { sessionStorage.setItem(sessionKey, key) } catch { /* Keep the key in memory. */ }
      setApiKey(key); setInput('')
    } catch (err) { setError(err instanceof Error ? err.message : 'Сервис недоступен.') }
    finally { setBusy(false) }
  }
  return apiKey ? <main className="private-llm-shell"><LocalLlmPage apiKey={apiKey} privateService onUnauthorized={logout} /></main>
    : <main className="private-llm-login"><form onSubmit={(event) => void login(event)}>
      <span className="private-llm-badge">DAY 30 · ДОМАШНИЙ СЕРВЕР</span>
      <h1>Ваш приватный AI</h1><p>Локальная модель на домашнем компьютере.<br />Вопросы и ответы обрабатываются на сервере.</p>
      <label htmlFor="access-key">Ключ доступа</label><input id="access-key" type="password" value={input} onChange={(event) => setInput(event.target.value)} autoComplete="off" autoFocus placeholder="Вставьте ключ с Mac" disabled={busy} />
      {error && <p className="rag-chat-error" role="alert">{error}</p>}
      <button type="submit" disabled={!input.trim() || busy}>{busy ? 'Подключение…' : 'Открыть чат →'}</button>
      <small>Ключ хранится в этой вкладке до её закрытия. История чата сохраняется в этом браузере.</small>
    </form></main>
}

createRoot(document.getElementById('root')!).render(<StrictMode><PrivateLlmApp /></StrictMode>)
