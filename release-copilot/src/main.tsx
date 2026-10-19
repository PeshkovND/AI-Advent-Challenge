import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ReleasePage from './ReleasePage'
createRoot(document.getElementById('root')!).render(<StrictMode><header className="app-brand"><span aria-hidden="true">↗</span><div><strong>Release Copilot</strong><small>Подготовка релизов с AI</small></div></header><ReleasePage /></StrictMode>)
