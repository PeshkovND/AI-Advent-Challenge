# День 6: агентный сервис

## Требования

- Один запущенный Node/Express-процесс должен уметь хранить много агентов.
- Агент — отдельная сущность с `id` и собственной конфигурацией.
- Конфигурация задаётся при создании агента и не требует интерактивного режима.
- Агент принимает пользовательский input, применяет input policy, вызывает LLM и применяет output policy.
- Для агента можно задать stop-последовательности и формат выходного ответа.
- Один и тот же сервис должен поддерживать создание одного агента и массовое создание агентов.
- Существующий чат должен отправлять сообщения через агента `default`.

## Архитектура

`server/agent-service.ts` содержит изолированные сущности `Agent`, `AgentService` и REST-роутер `createAgentRouter`:

1. `AgentService` хранит агентов в памяти в `Map` и создаёт `default` при старте.
2. `Agent` хранит конфигурацию и инкапсулирует последовательность input policy → LLM → output policy.
3. `LlmClient` выбирает DeepSeek или Hugging Face по конфигурации конкретного агента.
4. Один процесс может создать любое практическое количество агентов, не поднимая отдельные React-приложения.

## REST API

```text
GET    /api/agents
GET    /api/agents/:id
POST   /api/agents
POST   /api/agents/bulk
DELETE /api/agents/:id
POST   /api/agents/:id/run
POST   /api/agents/:id/stream
```

Создание одного агента:

```json
{
  "id": "react-helper",
  "config": {
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "temperature": 0.3,
    "inputPolicy": { "maxCharacters": 12000 },
    "outputPolicy": { "format": "text" }
  }
}
```

Запуск:

```json
{
  "input": "Объясни, что такое React component",
  "history": []
}
```

Массовое создание принимает массив `agents`. Конфигурации хранятся в одном сервисе и могут отличаться у каждого агента.

## CLI без интерактивного режима

Сервис должен быть запущен командой `npm run dev`. После этого можно создать одного агента:

```bash
npm run agents:cli -- create --config agent-config.example.json
```

Или сразу несколько:

```bash
npm run agents:cli -- bulk --config agents-config.example.json
```

CLI отправляет конфигурацию в REST API сервиса и не запускает отдельный экземпляр приложения на каждого агента.
