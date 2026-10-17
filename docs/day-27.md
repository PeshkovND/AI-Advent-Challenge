# День 27 — локальная LLM в React-приложении

В существующей навигации появился раздел **Локальная LLM**. React отправляет историю текущего диалога на Express, сервер обращается исключительно к Ollama по loopback-адресу. Ответ отображается потоково с Markdown. Облачные API и ключи этому разделу не нужны; остальные разделы сохраняют свои провайдеры.

## Запуск

```bash
ollama pull qwen3.5:4b
# Если Ollama не запущен:
ollama serve
# В другом терминале из корня проекта:
npm run dev
```

Откройте адрес Vite из терминала и выберите «Локальная LLM». Для сборки и запуска одного сервера: `npm start`, адрес по умолчанию `http://127.0.0.1:8787`.

Настройки `.env`: `OLLAMA_BASE_URL=http://127.0.0.1:11434`, `OLLAMA_CHAT_MODEL=qwen3.5:4b`, `OLLAMA_CHAT_CONTEXT=32768`, `OLLAMA_CHAT_MAX_TOKENS=4096`. Можно выбрать установленную 9B через `OLLAMA_CHAT_MODEL=qwen3.5:9b` и перезапустить сервер.

## Работа чата

- Enter отправляет вопрос, Shift+Enter добавляет строку.
- Full history is saved in localStorage in this browser and restored after reload or leaving the section. Clear chat removes the saved history.
- «Остановить» прерывает HTTP-запрос и генерацию на стороне серверного клиента; показанный текст остаётся. Незавершённая пара сообщений исключается из последующих запросов.
- «Очистить чат» начинает новый диалог.
- Достижение лимита ответа показывает уведомление и сохраняет видимый частичный текст.
- При недоступном Ollama или незагруженной модели интерфейс показывает инструкцию; облачного fallback нет.

## Сервер

`GET /api/local-llm/status` проверяет локальный Ollama и наличие настроенной модели. `POST /api/local-llm/chat` принимает `{ messages: [{ role: "user", content: "…" }] }` и возвращает NDJSON-поток Ollama. Разрешены только роли user/assistant и loopback-адрес. Один запрос одновременно; второй получает 409. После разрыва подключения upstream отменяется. Таймаут — 10 минут, выгрузка модели — через 60 секунд простоя.

The sliding window keeps recent complete user/assistant turns and the current question. It reserves the configured output limit plus 512 tokens. Input is conservatively estimated as UTF-8 bytes plus 64 per message; this is not an exact model tokenizer. The full visible history remains in localStorage. Only selected messages reach the API; the server enforces the same window. Old details outside the window are forgotten, with no automatic summary. Oversized individual questions are rejected. API limits: 1000 messages and a 1 MB request body.

## Проверено

Полное приложение запущено на отдельном порту 8797 с пустыми DEEPSEEK_API_KEY, HUGGINGFACE_API_KEY и OPENROUTER_API_KEY. В браузере отправлены вопросы:

1. «Сколько будет 17 + 25? Ответь одним числом.» → `42`.
2. «Прибавь 8 к предыдущему результату. Ответь одним числом.» → `50`: история учитывается.
3. Запрос подробной статьи о процессах/потоках → потоковый текст отображается; остановка оставляет частичный ответ и возвращает доступность ввода.

API статуса вернул `ready: true`, контекст 32768. Пустая история отклонена с HTTP 400. TypeScript и production-сборка проверены.

Context checks: `node_modules/.bin/tsx --test server/local-llm-context.test.ts` (3 tests passed).
