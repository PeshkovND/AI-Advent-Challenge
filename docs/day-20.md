# День 20 — orchestration нескольких MCP-серверов

Day 20 продолжает единого агента из Days 17–19. В его конфигурации подключены три независимых MCP-сервера:

```text
yandex-calendar  — CalDAV: события и свободные окна
scheduler         — SQLite: периодические задачи и история запусков
telegram          — Telegram Bot API: заметки пользователю
```

## Как агент выбирает и маршрутизирует tool

При каждом ходе `McpToolRuntime` запускает только серверы из `mcp.servers` конкретного агента и запрашивает у каждого `tools/list`. В модель передаётся актуальный каталог с JSON Schema. Внутреннее имя каждого tool квалифицировано идентификатором сервера, например:

```text
yandex-calendar__get_calendar_events
telegram__send_telegram_note
scheduler__create_scheduled_agent_task
```

После tool call runtime ищет tool по этому квалифицированному имени, берёт сохранённый `serverId` и отправляет `tools/call` только соответствующему MCP-клиенту. Он не содержит списка календарных или Telegram-инструментов и не выбирает цепочку за модель.

Результат каждого вызова передаётся модели как структурированное `tool`-сообщение. Поэтому зависимые шаги выполняются последовательно: модель получает receipt Calendar до формирования текста для Telegram или параметров Scheduler. В интерфейсе отображается фактический trace в формате `server.tool`, а не пересказ модели.

## Демонстрационный длинный флоу

Отправьте универсальному агенту:

> Найди первое свободное окно на 60 минут в будние дни следующей недели с 10:00 до 18:00, создай там «Фокус», пришли информацию о событии в Telegram и каждый будний день в 9:00 по Омску присылай мне в Telegram сводку календаря на день.

Ожидаемая последовательность в текущем ходе:

```text
1. yandex-calendar.get_calendar_events
2. yandex-calendar.find_free_calendar_slots
3. yandex-calendar.create_calendar_event
4. telegram.send_telegram_note
5. scheduler.create_scheduled_agent_task
```

При запуске сохранённой задачи фоновый агент строит отдельную цепочку:

```text
1. yandex-calendar.get_calendar_events
2. telegram.send_telegram_note
```

Фоновый агент имеет запись только в Telegram. Для `yandex-calendar` host применяет server-level policy `read-only`, поэтому даже ошибка prompt не может выдать ему инструменты создания, изменения или удаления события.

## Подключение Telegram

1. Создайте бота через `@BotFather` и сохраните выданный токен.
2. Откройте чат с ботом и отправьте `/start` — Telegram не позволяет боту первым написать пользователю.
3. Получите `chat.id` через метод Bot API `getUpdates` после этого сообщения.
4. Добавьте секреты только в `.env` и перезапустите сервер:

```env
TELEGRAM_BOT_TOKEN=123456:example-token
TELEGRAM_CHAT_ID=123456789
```

Токен не передаётся браузеру, модели или другим MCP-серверам. Telegram MCP получает только эти две переменные окружения. Если они не настроены, попытка отправки вернёт понятную ошибку без токена.

## Проверка

Без аккаунтов Telegram и Яндекс Календаря:

```bash
npm run test:telegram:mcp
npm run test:mcp:orchestration
npm run test:calendar:slots
npm run test:scheduler:local
npm run typecheck
npm run build
```

`test:telegram:mcp` запускает отдельный Telegram MCP и локальный mock Bot API. Он проверяет discovery двух tools, точную маршрутизацию методов `sendMessage` и `editMessageText`, JSON-параметры и структурированный receipt — реальный чат при этом не затрагивается.

`test:mcp:orchestration` дополнительно запускает все три MCP-сервера через один runtime и проверяет, что каталог сохраняет источник каждого инструмента (`serverId`). Это защищает маршрутизацию от смешения инструментов разных серверов.
