# Подключаемый RAG AI Code Review

Action из этого репозитория можно вызывать в MyFamily и других проектах. Он читает diff, содержимое файлов и RAG-контекст **целевого** Git-репозитория. Reviewer и его зависимости поставляются в `dist-action/index.cjs`; устанавливать Node-зависимости в MyFamily или переносить туда приложение DeepChat не требуется.

## Подключение

1. Добавьте repository secret `DEEPSEEK_API_KEY` в **репозитории, который нужно проверять**. Секрет AI-Advent-Challenge автоматически в MyFamily не передаётся.
2. Скопируйте [`examples/ai-review/myfamily-workflow.yml`](../examples/ai-review/myfamily-workflow.yml) в `.github/workflows/ai-code-review.yml` целевого проекта и включите этот файл в его **default branch**. Для MyFamily это `main`.
3. Откройте новый PR или обновите существующий после установки workflow. Draft PR пропускаются. Action опубликует замечания у строк в **Files changed**, краткий обновляемый комментарий, Job Summary и артефакт `ai-code-review`.

Минимальный workflow:

```yaml
name: AI code review
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: ai-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    if: ${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.sha }}
          fetch-depth: 0
          persist-credentials: false

      - uses: PeshkovND/AI-Advent-Challenge@ai-review-v1.1.0
        with:
          api-key: ${{ secrets.DEEPSEEK_API_KEY }}
```

`ai-review-v1.1.0` — рекомендуемая версия Action с обсуждениями у строк кода. Она доступна независимо от слияния ветки `day-32` в `main` этого репозитория. Для закрепления точного кода можно заменить тег полным SHA: `git ls-remote https://github.com/PeshkovND/AI-Advent-Challenge.git 'refs/tags/ai-review-v1.1.0^{}'` показывает commit annotated tag. Версия поставляется как Git tag, публикация в Marketplace не требуется.

Для фиксации на неизменяемом SHA подставьте commit из команды выше вместо тега в `uses`. Предыдущая версия `ai-review-v1.0.2` указывает на `dc359e71221316df806fc4e82cc542ebd35c5e53` и публикует только общий комментарий.

Первый PR, добавляющий workflow в целевой проект, не проверяет себя: `pull_request_target` использует workflow из default branch. Дополнительное разрешение создавать или одобрять PR не требуется. Токену нужны `contents: read` и `pull-requests: write` для комментариев и GitHub Review. Политика организации может ограничить использование внешних Actions.

## Входы

| Input | По умолчанию | Назначение |
| --- | --- | --- |
| `api-key` | — | Ключ DeepSeek; обязателен для ревью, не нужен при `prepare-only: 'true'`. |
| `github-token` | `${{ github.token }}` | Чтение PR-объектов и публикация комментария. |
| `repository-path` | `.` | Путь к checkout целевого репозитория внутри `github.workspace`. Симлинк за пределы workspace запрещён. |
| `base`, `head` | SHA из PR event | Git refs для анализа. Для публикации должны совпадать с SHA события PR. |
| `model` | `deepseek-v4-flash` | Существующий облачный клиент проекта. |
| `publish-comment` | `'true'` | Публикация комментариев и Review доступна только на `pull_request_target`. Для других событий укажите `'false'`. |
| `inline-comments` | `'true'` | Замечания в GitHub Review у строк diff. `'false'` возвращает полный текст в общий комментарий без обсуждений у строк. |
| `prepare-only` | `'false'` | Собрать `context.json`, не вызывать модель и не публиковать комментарий. |
| `upload-artifact` | `'true'` | Сохранить отчёт через `actions/upload-artifact`. |
| `artifact-name` | `ai-code-review` | Имя артефакта; при нескольких вызовах в job используйте разные имена. |

Boolean inputs передаются строками `'true'`/`'false'`. Для ручного или push-запуска нужны явные `base`/`head`, `publish-comment: 'false'` и существующие refs в checkout. Для PR отсутствующие base/head объекты загружаются с GitHub; shallow checkout может не содержать общего предка, поэтому `fetch-depth: 0` обязателен в примере.

Action сам подготавливает Node.js 24 через `actions/setup-node`. Проверено на GitHub-hosted Ubuntu. Сборка iOS и Xcode не нужны для чтения Swift-кода. В контейнере/self-hosted runner должны быть Git, bash и доступ к GitHub/DeepSeek; Node 24 должен поддерживаться ОС runner.

## Выходы и отчёт

Укажите `id: review` шагу Action, чтобы читать `steps.review.outputs.<name>`:

| Output | Значение |
| --- | --- |
| `report-directory` | Уникальный абсолютный каталог в `runner.temp`. |
| `status` | `complete`, `partial`, `failed` либо `prepared`. |
| `findings` | Число валидированных замечаний. |
| `reviewed-files` | Число успешно рассмотренных файлов. |
| `comment-url` | URL созданного/обновлённого комментария; пусто без публикации или при устаревшем PR. |
| `review-url` | URL GitHub Review или уже существующего обсуждения у строки. |
| `inline-comments` | Число созданных, обновлённых и повторно использованных обсуждений в этом запуске. |

Результаты: `review.md`, `review.json`, `comment.md`; при inline-публикации — `publication.json` со счётчиками и признаком устаревшего результата/ошибки; в режиме подготовки — `context.json`. Отчёт включает баги, архитектурные проблемы и рекомендации, реальные строки diff, дословные цитаты, источники RAG и ограничения покрытия. Наличие замечаний не блокирует merge автоматически. Сбой генерации, неверные входы, недоступный Git/API или ошибка публикации делают шаг неуспешным; уже созданные отчёты сохраняются в артефакте. Артефакты хранятся 7 дней.

Для повторного анализа модель получает свежие SHA события. Перед публикацией повторно проверяются состояние PR и base/head. Старый отчёт остаётся в артефакте, но не заменяет актуальный комментарий. Конкурентные запуски одного PR отменяются настройкой `concurrency` workflow.

## Обсуждения у строк кода (v1.1.0)

По умолчанию замечания отправляются одним GitHub Review с событием `COMMENT` и точным `commit_id`. GitHub показывает файл, выделенную строку и обсуждение в **Files changed**: на него можно ответить и отметить его resolved обычными средствами GitHub. Агент не одобряет PR и не запрашивает изменения автоматически.

Перед публикацией координаты и цитата сверяются с diff из GitHub: `path`, `line`, `side` (LEFT для удалений, RIGHT для добавлений и контекста). Несколько замечаний к одной строке объединяются в обсуждение. До 50 актуальных привязок за запуск, сначала высокая серьёзность. Если GitHub не предоставил patch или строка недоступна, замечание сохраняется в полном отчёте, а краткая сводка показывает число пропущенных привязок.

Повторный запуск обновляет только собственные обсуждения `github-actions[bot]` с совпадающей меткой и актуальными координатами. Идентичный текст не публикуется заново. Ответы людей и устаревшие обсуждения не редактируются и автоматически не закрываются. При перемещении неизменённой строки используется актуальная привязка GitHub. Общий комментарий содержит статистику и ссылку на Review; полный текст остаётся в Job Summary и артефакте. При ошибке GitHub API полный текст публикуется в общий комментарий, а запуск завершается ошибкой.

## MyFamily и другие языки

Уже поддерживаются `.swift`, `.pbxproj`, `.xcconfig`, `.plist`, `.entitlements`, `.xcscheme`, `.xcworkspacedata`, Markdown, TypeScript/JavaScript, Python, Go, Rust, SQL, JSON/YAML и другие текстовые форматы из `reviewPath`.

`Docs/Architecture.md` и `project/docs/` MyFamily распознаются как документация с учётом регистра. Контекст извлекается из коммитов самого MyFamily; документы DeepChat туда не подмешиваются. Документация должна быть закоммичена в истории анализируемого проекта. Изменения PR сравниваются с merge-base; содержимое baseline используется для RAG, новая версия файла передаётся отдельно.

Ограничения остаются общими: до 30 изменённых файлов, до 10 000 байт diff и 4 000 байт содержимого на файл; до 400 документов/файлов и 4 МБ в RAG-корпусе. Симлинки, submodules, бинарные/слишком большие файлы и закрытые пути пропускаются с причиной. Подробнее: [day-32.md](day-32.md#ограничения-покрытия).

## Границы исполнения

Action не импортирует файлы или `.env` целевого проекта, не устанавливает его зависимости и не запускает его сборку/тесты. PR head читается только из Git blobs, внешние diff/textconv отключены. Ключ модели передаётся явно через input. Код модели и сетевой запрос переиспользуются из текущей архитектуры проекта; для RAG используется общий чанкер и отдельный лексический поиск без Ollama на CI.

Код и фрагменты документации отправляются в DeepSeek. Модель не получает GitHub token и не имеет инструментов. Публикуемый текст экранируется, ссылки на строки и цитаты проверяются кодом. Это подтверждает происхождение цитаты, но не гарантирует верность вывода модели.

## Разработка и выпуск

```bash
npm ci
npm run review:action:build
npm run test:review
npm run typecheck
git diff --check
```

Bundle и `dist-action/THIRD_PARTY_NOTICES.txt` коммитятся вместе с исходниками. Сборка использует закреплённый esbuild и lock-файл; в runtime включён только npm-пакет Zod, его лицензия сохранена рядом. Проверка CI пересобирает bundle и требует отсутствия diff.

Workflow `.github/workflows/review-action-check.yml` проверяет исходники, bundle и composite Action на отдельном Swift/Xcode-репозитории. Без ключа выполняется `prepare-only`; на push в доверенную `day-32`, если repository secret настроен, выполняется реальный DeepSeek и проверяется обнаружение намеренной замены умножения сложением. На `pull_request` секрет модели не передаётся.

Версии выпускаются новыми тегами `ai-review-vX.Y.Z`. Опубликованные теги не передвигаются. Первоначальный выпуск предоставлял workflow как пример; фактическое подключение MyFamily выполнено отдельно и описано в [day-32-myfamily-ai-review.md](day-32-myfamily-ai-review.md).

## Проверки первоначального выпуска v1.0.0 — 17 октября 2026

- [GitHub-hosted Ubuntu / Node 24, push run](https://github.com/PeshkovND/AI-Advent-Challenge/actions/runs/39008044586) — success: `npm ci --ignore-scripts`, TypeScript, повторная сборка bundle без отличий, 13 тестов, оба вызова composite Action и загрузка артефактов.
- [PR run без секрета модели](https://github.com/PeshkovND/AI-Advent-Challenge/actions/runs/39008044659) — success: тесты и переносимый Action в режиме подготовки.
- Реальный `deepseek-v4-flash` вернул `complete`, проверил один Swift-файл и нашёл замену `price * quantity` на `price + quantity` в `Invoice.swift:1`; RAG-корпус содержал 8 документов/файлов baseline. [Сохранённый текст](day-32-action-example-review.md), полный JSON — артефакт `action-smoke-review` push run.
- Публикация/обновление комментария, пагинация и защита от устаревшего PR проверены тестами с подменённым HTTP transport. Smoke run использует `publish-comment: 'false'`: live-публикация в MyFamily и установка его workflow в этот выпуск не входили.

## Patch v1.0.1 и подключение MyFamily

Первый реальный PR MyFamily выявил ошибку категорий RAG: Swift-код внутри `Sources/API` считался документацией. В `v1.0.1` категория документации дополнительно ограничена текстовыми форматами документов. Новая проверка гарантирует, что `.swift` внутри API/Docs остаётся кодом и не вытесняет Markdown/API-описания из двух слотов документации.

[GitHub CI patch-версии](https://github.com/PeshkovND/AI-Advent-Challenge/actions/runs/39008471910) прошёл: 14 тестов reviewer/Action, TypeScript, точное совпадение пересобранного bundle и реальный вызов DeepSeek. Первоначально MyFamily был закреплён на SHA `24528323c63a16b1e7e817867b397dec488fd853`. Результаты реального подключения и ссылки: [day-32-myfamily-ai-review.md](day-32-myfamily-ai-review.md).

## Patch v1.0.2: привязка строк в больших diff

На PR из девяти файлов модель возвращала дословные цитаты, но ошибалась при подсчёте номеров строк hunk. `v1.0.2` уточняет номер по единственному точному совпадению цитаты на той же стороне diff. Путь должен быть верным, исходно указанная строка должна присутствовать в переданном hunk. Неизвестные строки, выдуманные цитаты, смена стороны и неоднозначные совпадения по-прежнему отклоняются. Проверка цитат не ослаблена.

Версия закреплена на `dc359e71221316df806fc4e82cc542ebd35c5e53`; [GitHub CI](https://github.com/PeshkovND/AI-Advent-Challenge/actions/runs/39010202729) прошёл с 15 тестами и реальным DeepSeek. Повторная локальная проверка всего diff MyFamily дала валидные ответы для всех девяти файлов. MyFamily обновлён через [PR #39](https://github.com/PeshkovND/MyFamily/pull/39).

[Повторное GitHub-ревью PR #38](https://github.com/PeshkovND/MyFamily/actions/runs/39010352297) успешно: 9/9 файлов получили валидные ответы, ошибок модели/цитат нет. Опубликованы 19 замечаний (10 потенциальных багов, 4 архитектурных замечания, 5 рекомендаций) в [одном обновлённом комментарии](https://github.com/PeshkovND/MyFamily/pull/38#issuecomment-6230677153). Статус отчёта `partial` отражает усечение содержимого трёх крупных файлов до лимита контекста; diff и причины ограничений сохранены в артефакте.

## Версия v1.1.0: GitHub Review у строк кода

Неизменяемый tag указывает на `977c91233e221f529cb0382909d5e756befeb19c`. [GitHub CI](https://github.com/PeshkovND/AI-Advent-Challenge/actions/runs/39012139482) прошёл с 27 тестами, TypeScript, проверкой совпадения bundle, переносимым Swift/Xcode fixture и реальным DeepSeek. Проверены обе стороны diff, группировка замечаний, повторный запуск без дубликатов, перенос строки, переименование, пагинация, устаревшие SHA и сохранение полного отчёта при отказе API публикации. MyFamily подключён через [PR #40](https://github.com/PeshkovND/MyFamily/pull/40).
