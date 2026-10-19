import type { ReleaseFile } from './release-types'

export default function Evidence({ file }: { file: Pick<ReleaseFile, 'evidence' | 'verification'> }) {
  return <details className="release-evidence"><summary>Источники и цитаты · {file.evidence.length}</summary>{file.verification && <p className="release-caption">Отдельная модельная проверка: {file.verification.judgments.length} пунктов, попытка {file.verification.attempts}. Это дополнительная проверка, которая тоже может ошибаться.</p>}{file.evidence.map((item) => <div key={item.id}><small>{item.id} · {item.path}{item.line ? `:${item.line}` : ''} · {item.commit.slice(0, 8)} {item.side === 'LEFT' ? '· до изменения' : item.side === 'RIGHT' ? '· после изменения' : '· контекст baseline'}</small><pre>{item.quote}</pre></div>)}</details>
}
