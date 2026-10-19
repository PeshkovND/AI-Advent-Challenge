import type { ReleaseRun } from './release-types'
import { releaseRiskId } from './release-types'
import Evidence from './ReleaseEvidence'

const verdicts = { confirmed: 'Риск подтверждается кодом', dismissed: 'Гипотеза снята', uncertain: 'Нужна ручная оценка' }
const statuses = { risk: 'Потенциальная проблема', compatible: 'Совместимость подтверждается кодом', needs_review: 'Нужна проверка' }

export default function ReleaseImpactPanel({ run, canStart, onStart }: { run: ReleaseRun; canStart: boolean; onStart: () => void }) {
  const impact = run.impact
  const risks = new Map(run.files.flatMap((file) => file.risks.map((risk, index) => [releaseRiskId(file.path, index), { ...risk, path: file.path }] as const)))
  return <>
    <section className="release-card release-impact-intro">
      <h3>Влияние на связанные файлы</h3>
      <p>Сопоставляем изменённый код с его реализациями и местами использования в двух зафиксированных версиях Git, включая неизменённые файлы и тесты.</p>
      <p className="release-caption">Связи ищутся по именам типов, методов, свойств и относительным импортам. Это эвристика: динамические вызовы, неоднозначные имена и часть языковых конструкций могут быть пропущены. Компиляция и тесты проекта не запускаются.</p>
      {canStart && <button onClick={onStart}>{impact ? 'Повторить проверку связей' : 'Проверить связи'}</button>}
      {!impact && <p>Этот запуск создан до появления проверки связей. Сохранённый анализ файлов можно дополнить отдельно.</p>}
      {impact?.state === 'pending' && <p>Проверка связей в очереди.</p>}
      {impact?.state === 'analyzing' && <p role="status">AI сопоставляет вызовы, реализации и ожидания тестов…</p>}
      {impact?.state === 'failed' && <p className="release-error">{impact.error}</p>}
      {impact && <p>Просмотрено файлов: <b>{impact.scannedFiles}</b> · В контексте: <b>{impact.files.length}</b> · Найдено связей: <b>{impact.relations.length}</b></p>}
      {impact?.state === 'complete' && !impact.relations.length && <p>Прямые связи с изменённым кодом этим методом не обнаружены. Это не подтверждает отсутствие всех зависимостей.</p>}
      {impact?.summary && <><h3>Общий вывод</h3><p>{impact.summary.text}</p><small>Источники: {impact.summary.evidenceIds.join(', ')}</small></>}
      {impact && impact.relations.length > 0 && <details className="release-impact-relations"><summary>Какие файлы связаны · {impact.relations.length}</summary><ul>{impact.relations.map((edge) => <li key={JSON.stringify([edge.from, edge.to])}><code>{edge.from}</code><span> → </span><code>{edge.to}</code><small>{edge.symbols.join(', ')} · {edge.versions.map((version) => version === 'head' ? 'новая версия' : 'предыдущая версия').join(' / ')}</small></li>)}</ul></details>}
    </section>
    {impact?.findings.map((finding, index) => <section key={index} className={`release-card release-impact-finding ${finding.status}`}><span className="release-impact-status">{statuses[finding.status]}</span><h3>{finding.title}</h3><p>{finding.text}</p><small>Источники: {finding.evidenceIds.join(', ')}</small></section>)}
    {!!impact?.riskReviews.length && <section className="release-card"><h3>Переоценка рисков отдельных файлов</h3><p>Предварительные гипотезы проверены по связанным реализациям. Оценка AI требует просмотра разработчиком.</p>{impact.riskReviews.map((review) => <div key={review.riskId} className={`release-impact-review ${review.verdict}`}><span className="release-impact-status">{verdicts[review.verdict]}</span><small>{risks.get(review.riskId)?.path}</small><p><b>Гипотеза:</b> {risks.get(review.riskId)?.text}</p><p>{review.reason}</p><small>Источники: {review.evidenceIds.join(', ')}</small></div>)}</section>}
    {!!impact?.evidence.length && <section className="release-card"><Evidence file={impact} /></section>}
  </>
}
