# Подключаемый RAG AI Code Review

Action из этого репозитория можно вызывать в MyFamily и других проектах. Он читает diff, содержимое файлов и RAG-контекст **целевого** Git-репозитория. Reviewer и его зависимости поставляются в `dist-action/index.cjs`; устанавливать Node-зависимости в MyFamily или переносить туда приложение DeepChat не требуется.

## Подключение

1. Добавьте repository secret `DEEPSEEK_API_KEY` в **репозитории, который нужно проверять**. Секрет AI-Advent-Challenge автоматически в MyFamily не передаётся.
2. Скопируйте [`examples/ai-review/myfamily-workflow.yml`](../examples/ai-review/myfamily-workflow.yml) в `.github/workflows/ai-code-review.yml` целевого проекта и включите этот файл в его **default branch**. Для MyFamily это `main`.
3. Откройте новый PR или обновите существующий после установки workflow. Draft PR пропускаются. Action опубликует один обновляемый комментарий, Job Summary и артефакт `ai-code-review`.

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

      - uses: PeshkovND/AI-Advent-Challenge@ai-review-v1.0.1
        with:
          api-key: ${{ secrets.DEEPSEEK_API_KEY }}
```

`ai-review-v1.0.1` — рекомендуемая patch-версия Action. Она доступна независимо от слияния ветки `day-32` в `main` этого репозитория. Для закрепления точного кода можно заменить тег полным SHA: `git ls-remote https://github.com/PeshkovND/AI-Advent-Challenge.git 'refs/tags/ai-review-v1.0.1^{}'` показывает commit annotated tag. Версия поставляется как Git tag, публикация в Marketplace не требуется.

Опубликованная версия `ai-review-v1.0.0` указывает на `e8ecc59d061e2be1d9000d9b9cc1b1c9a8e39d6e`. Для фиксации на неизменяемом SHA: `uses: PeshkovND/AI-Advent-Challenge@e8ecc59d061e2be1d9000d9b9cc1b1c9a8e39d6e`.

Первый PR, добавляющий workflow в целевой проект, не проверяет себя: `pull_request_target` использует workflow из default branch. Дополнительное разрешение создавать или одобрять PR не требуется. Токену нужны `contents: read` и `pull-requests: write` для обычного комментария. Политика организации может ограничить использование внешних Actions.

## Входы

| Input | По умолчанию | Назначение |
| --- | --- | --- |
| `api-key` | — | Ключ DeepSeek; обязателен для ревью, не нужен при `prepare-only: 'true'`. |
| `github-token` | `${{ github.token }}` | Чтение PR-объектов и публикация комментария. |
| `repository-path` | `.` | Путь к checkout целевого репозитория внутри `github.workspace`. Симлинк за пределы workspace запрещён. |
| `base`, `head` | SHA из PR event | Git refs для анализа. Для публикации должны совпадать с SHA события PR. |
| `model` | `deepseek-v4-flash` | Существующий облачный клиент проекта. |
| `publish-comment` | `'true'` | Публикация доступна только на `pull_request_target`. Для других событий укажите `'false'`. |
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

Результаты: `review.md`, `review.json`, `comment.md`; в режиме подготовки — `context.json`. Отчёт включает баги, архитектурные проблемы и рекомендации, реальные строки diff, дословные цитаты, источники RAG и ограничения покрытия. Наличие замечаний не блокирует merge автоматически. Сбой генерации, неверные входы, недоступный Git/API или ошибка публикации делают шаг неуспешным; уже созданные отчёты сохраняются в артефакте. Артефакты хранятся 7 дней.

Для повторного анализа модель получает свежие SHA события. Перед публикацией повторно проверяются состояние PR и base/head. Старый отчёт остаётся в артефакте, но не заменяет актуальный комментарий. Конкурентные запуски одного PR отменяются настройкой `concurrency` workflow.

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

Версии выпускаются новыми тегами `ai-review-vX.Y.Z`. Опубликованные теги не передвигаются. MyFamily в рамках упаковки Action не изменяется: готовый workflow предоставлен как пример подключения.

## Проверенный выпуск — 17 октября 2026

- [GitHub-hosted Ubuntu / Node 24, push run](https://github.com/PeshkovND/AI-Advent-Challenge/actions/runs/39008044586) — success: `npm ci --ignore-scripts`, TypeScript, повторная сборка bundle без отличий, 13 тестов, оба вызова composite Action и загрузка артефактов.
- [PR run без секрета модели](https://github.com/PeshkovND/AI-Advent-Challenge/actions/runs/39008044659) — success: тесты и переносимый Action в режиме подготовки.
- Реальный `deepseek-v4-flash` вернул `complete`, проверил один Swift-файл и нашёл замену `price * quantity` на `price + quantity` в `Invoice.swift:1`; RAG-корпус содержал 8 документов/файлов baseline. [Сохранённый текст](day-32-action-example-review.md), полный JSON — артефакт `action-smoke-review` push run.
- Публикация/обновление комментария, пагинация и защита от устаревшего PR проверены тестами с подменённым HTTP transport. Smoke run использует `publish-comment: 'false'`: live-публикация в MyFamily и установка его workflow в этот выпуск не входили.
