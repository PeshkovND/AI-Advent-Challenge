# Автоматическое AI-ревью в MyFamily

17 октября 2026 года workflow установлен в `main` репозитория [PeshkovND/MyFamily](https://github.com/PeshkovND/MyFamily). Создан repository Actions secret `DEEPSEEK_API_KEY`; его значение не записывалось в файлы и логи. Само приложение и зависимости MyFamily для подключения reviewer не изменялись.

## Установка

- [PR #34](https://github.com/PeshkovND/MyFamily/pull/34) добавил `.github/workflows/ai-code-review.yml` в `main`.
- [PR #36](https://github.com/PeshkovND/MyFamily/pull/36) обновил Action до `v1.0.1`, закреплённого на SHA `24528323c63a16b1e7e817867b397dec488fd853`.
- [PR #39](https://github.com/PeshkovND/MyFamily/pull/39) обновил Action до `v1.0.2` / `dc359e71221316df806fc4e82cc542ebd35c5e53`: номер строки уточняется по единственному дословному совпадению цитаты на той же стороне diff. Это устраняет ошибки модели при подсчёте строк больших hunks.
- [Рабочий workflow](https://github.com/PeshkovND/MyFamily/blob/main/.github/workflows/ai-code-review.yml) запускается на `pull_request_target`: opened, synchronize, reopened и ready_for_review. Draft PR пропускаются.
- Разрешены `contents: read` и `pull-requests: write`. Дополнительные глобальные разрешения Actions и право создавать/одобрять PR не включались.
- Публикуется один обновляемый комментарий, Job Summary и артефакт `ai-code-review` с Markdown/JSON, срок хранения — 7 дней.

## Реальная проверка

Во временном [PR #35](https://github.com/PeshkovND/MyFamily/pull/35) свойство `Collection.isNotEmpty` намеренно изменено с `return !isEmpty` на `return isEmpty`. Приложение и тесты из PR reviewer не запускал.

[Первый запуск](https://github.com/PeshkovND/MyFamily/actions/runs/39008356373) завершился успешно. DeepSeek нашёл баг в `Collection+Extensions.swift:13`, показал инверсию логического значения и её влияние на вызов в `ResponseErrorMapper.swift`. [Автоматический комментарий](https://github.com/PeshkovND/MyFamily/pull/35#issuecomment-6230457963) опубликован GitHub Actions bot. Результат — `complete`, проверен 1/1 файл, RAG-корпус — 167 документов/файлов baseline.

Первый отчёт также выявил, что `.swift` внутри каталога `API` ошибочно относились к документации. Это исправлено в `v1.0.1`; [CI исправления](https://github.com/PeshkovND/AI-Advent-Challenge/actions/runs/39008471910) прошёл с 14 тестами и реальным DeepSeek.

[Повторный запуск v1.0.1](https://github.com/PeshkovND/MyFamily/actions/runs/39008592883) подтвердил `complete`, тот же баг и корректные категории RAG: Markdown README отдельно, Swift-код отдельно. Публикация этого отчёта была пропущена защитой от устаревшего base SHA после обновления `main`; артефакт сохранился. Для проверки обновления комментария тестовая ветка синхронизирована с актуальной `main` и запущена снова.

[Итоговый запуск после синхронизации](https://github.com/PeshkovND/MyFamily/actions/runs/39008678695) — success: `complete`, 1/1 файл, баг на строке 13, настоящая Markdown-документация и Swift-код в RAG. Существующий комментарий `6230457963` обновлён, второй комментарий не создан. [Сохранённый отчёт](day-32-myfamily-ai-review-example.md).

Тестовый PR #35 закрыт **без слияния**. `main` MyFamily содержит только установку workflow и pin исправленной версии; `Collection.isNotEmpty` остаётся `return !isEmpty`. Локальный checkout возвращён на актуальную `main`; исходная пользовательская правка `.DS_Store` сохранена.

## Расширенный PR

Небольшой PR #37 закрыт; [PR #38](https://github.com/PeshkovND/MyFamily/pull/38) содержит рефакторинг подготовки данных авторизации и проверки состояния сессии: 9 файлов, 233 добавленные и 22 удалённые строки. Название и описание оформлены как обычный PR. Он оставлен открытым и не слит в `main`.

На первом запуске обнаружен дефект reviewer: точные цитаты отклонялись из-за неверно посчитанных моделью номеров строк. Исправление выпущено как `v1.0.2`, закреплено в MyFamily через PR #39 и не меняет код приложения в `main`.

[Итоговый запуск](https://github.com/PeshkovND/MyFamily/actions/runs/39010352297) — success: 9/9 файлов рассмотрены, ошибок ответов нет; модель вернула 19 замечаний: 10 потенциальных багов, 4 архитектурных замечания и 5 рекомендаций. [AI-ревью](https://github.com/PeshkovND/MyFamily/pull/38#issuecomment-6230677153) обновлено в одном комментарии. `partial` в отчёте указывает на ограниченный объём содержимого трёх крупных файлов, а не на сбой ревью; ограничения перечислены явно.

## Обычное использование

Откройте PR в MyFamily или добавьте commit в существующий PR. В **Actions → AI code review** появится запуск; после завершения в PR будет ревью с багами, архитектурными проблемами и рекомендациями. Пустые категории не заполняются выдуманными замечаниями.

Доступ к модели и счёт DeepSeek используются через secret MyFamily. В модель отправляются diff, ограниченное содержимое файлов и найденные фрагменты этого проекта. Настройки, лимиты и входы: [ai-review-action.md](ai-review-action.md).
