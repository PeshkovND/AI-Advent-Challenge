# React Starter

Чат-бот на React, TypeScript и DeepSeek API.

## Запуск

```bash
npm install
npm run dev
```

После запуска откройте адрес из терминала (обычно `http://localhost:5173`).

Перед запуском создайте `.env` на основе `.env.example` и вставьте свой ключ DeepSeek API:

```bash
cp .env.example .env
```

Ключ используется только сервером и не попадает в браузер.

## Структура

- `src/App.tsx` — интерфейс чата, состояние переписки и потоковый вывод.
- `src/styles.css` — глобальные стили и адаптивная верстка.
- `src/main.tsx` — точка входа React.
- `server/index.ts` — серверный прокси и SSE-поток от DeepSeek API.
- `vite.config.ts` — настройки Vite.
- `tsconfig.json` — строгие настройки TypeScript.

Для production-сборки используйте `npm run build`.
Для проверки типов используйте `npm run typecheck`.
