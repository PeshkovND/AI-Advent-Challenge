# Проверка ассистента на MyFamily

MyFamily — внешний iOS-проект пользователя: https://github.com/PeshkovND/MyFamily. Документация восстановлена по Swift-коду commit `548ee58aa84ca3da659fcd05886fe383f7ccb707`. Проверяется ассистент по документации и свежему Git-контексту. Успешная проверка ассистента не подтверждает сборку iOS-приложения или доступность backend.

## Документация в формате задания

В рабочей копии `data/projects/MyFamily` подготовлены:

- `README.md` — назначение, стек, быстрый старт, структура и ссылки.
- `project/docs/project-architecture.md` — девять модулей, DI, MVVM/Coordinator, навигация и точка входа.
- `project/docs/setup.md` — Xcode, schemes, xcconfig и процедура build/test.
- `project/docs/client-api.md` и `project/docs/api/openapi.json` — частичный контракт, восстановленный по клиенту: SMS, refresh-token, logout, profile и особенности upload.
- `project/docs/data-models.md` — доменные и сетевые модели, преобразование дат, хранение и проверки авторизации.
- `project/docs/implementation-status.md` — существующий код, заглушки и обнаруженные ограничения.

Исходный `Docs/Architecture.md` сохранён. Все новые документы также доступны как снимок `examples/myfamily/`. Patch `examples/myfamily-documentation.patch` рассчитан на исходный commit 548ee58; перед применением к другому checkout используйте `git apply --check`. Повторно применять к checkout с готовой документацией не нужно.

## Подключение любой папки через интерфейс

1. Запустите `npm run dev` и откройте «Ассистент разработчика».
2. Нажмите «Открыть папку». Перейдите в MyFamily по каталогам либо введите полный путь и нажмите «Перейти».
3. Нажмите «Открыть проект», затем «Индексировать».
4. Задайте `/help Как устроен проект?` или выберите пример вопроса.

Предварительная регистрация в JSON не нужна. Сервер проверяет каталог, сохраняет канонический путь и стабильный ID, повторный выбор не создаёт дубликат. В списке остаются недавние проекты. У каждой папки отдельные индекс, MCP-корень и последние 20 ответов. Папки без Git тоже доступны: MCP явно возвращает `available: false`, а документация остаётся доступной для RAG. Без README/docs индекс строить не из чего — сначала добавьте документацию.

Данные ассистента хранятся в `data/developer-projects/<hash-root>/`, без записи SQLite в MyFamily. Индекс DeepChat остаётся в `data/developer-rag.sqlite`. Выбирается папка на машине, где запущен Express, а не загружается копия файлов из браузера.

## CLI и воспроизводимая проверка

Для CLI сохранён совместимый ID `myfamily` (образец ручной настройки — `developer-projects.example.json`). У проектов, открытых интерфейсом, ID можно получить из `GET /api/developer/projects`.

```bash
npm run developer:index -- --project myfamily
npm run developer:cli -- --project myfamily '/help Какие модули есть в MyFamily?'
npm run developer:cli -- --local --project myfamily '/help Какая сейчас git-ветка?'
npm run developer:check -- --project myfamily --cases evaluations/myfamily.json --cloud
```

Без `--cloud` приёмочные вопросы идут в локальную Ollama. Без `--project` CLI работает с DeepChat. Эмбеддинги всегда локальные. Облачный режим передаёт выбранные документы и ограниченный Git-контекст в DeepSeek, о чём сообщает интерфейс.

В MyFamily индексируются восемь документов: README, исходный Docs/Architecture.md и шесть файлов project/docs. Сборщик сохраняет реальный регистр путей. Контрольные вопросы из `evaluations/myfamily.json` находятся вне корпуса MyFamily и не индексируются.

Восемь сценариев: смешанный вопрос о наличии origin/develop и точке входа с обязательными цитатами MCP и документации; полный список локальных и известных удалённых веток; стек/минимальная iOS/точка входа/ветка; пакеты и AppContainer; метод и поля refresh-token; хранение Credentials и условия авторизации/профиля; заглушки и SignInCoordinator; отказ без доказательств на вопрос о production SLA и пароле БД. Проверяются дословные цитаты, смысловая поддержка и конкретные идентификаторы из кода.

MCP получает текущую ветку, commit и отдельный список веток MyFamily при каждом вопросе. Имена локальных и remote-tracking веток считываются из локальных Git refs, без fetch; origin/HEAD не считается веткой. Сценарий branchInventory сравнивает все полученные имена с ответом и требует цитату list_git_branches и положительный taskCheck. `day-31` относится к репозиторию ассистента. Длинный список Swift-файлов ограничивается для модели по размеру; total/truncated явно показывают неполноту. Полные receipts доступны в UI. Машинный отчёт: `data/day-31-check-myfamily-cloud.json`; сохраняемый результат: `docs/day-31-myfamily-results.json`.

## Границы iOS-проверки

Исправление вопроса о списке веток проверено отдельно в `docs/day-31-git-branches-results.json`. Простой запрос выводит точные имена из MCP, а модель получает только вопрос для выбора сценария. На проверенном checkout MyFamily — одна локальная ветка и 35 известных удалённых; это состояние локальных refs, без fetch.

Активный developer directory в этой среде — CommandLineTools; `xcodebuild -version` требует полный Xcode. Поэтому iOS build/test не выполнялись. Зафиксированы реальные ограничения кода: stub-экраны, незавершённый переход авторизации, Xcode version guard и отсутствие Resources-каталога тестового target. Код приложения не менялся.
