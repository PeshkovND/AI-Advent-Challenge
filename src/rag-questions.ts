export type RagEvidence = { source: string; quote: string; alternatives?: { source: string; quote: string }[] }
export type RagQuestion = { id: number; question: string; expected: string; sources: string[]; evidence: RagEvidence[] }

/** The answer criteria are written before seeing either model response. */
export const ragQuestions: RagQuestion[] = [
  { id: 1, question: 'Что хранится в data/scheduler.sqlite и как worker забирает задачу?', expected: 'Задачи, запуски, события и heartbeat; worker использует BEGIN IMMEDIATE и блокировку.', sources: ['docs/day-18.md'], evidence: [
    { source: 'docs/day-18.md', quote: '- задачи и исходные инструкции;' },
    { source: 'docs/day-18.md', quote: 'берёт задачу атомарно через `BEGIN IMMEDIATE`' },
  ] },
  { id: 2, question: 'Что происходит с пропущенными запусками после сна компьютера?', expected: 'Выполняется одна просроченная проверка; все пропущенные интервалы подряд не воспроизводятся.', sources: ['docs/day-18.md'], evidence: [
    { source: 'docs/day-18.md', quote: 'Все пропущенные интервалы подряд не воспроизводятся.' },
  ] },
  { id: 3, question: 'Какие три слоя памяти есть у агента и чем они отличаются?', expected: 'Short-term — сообщения; working — текущая задача; long-term — долговременные сведения.', sources: ['docs/day-11.md'], evidence: [
    { source: 'docs/day-11.md', quote: '| Short-term | обычная история агента' },
    { source: 'docs/day-11.md', quote: '| Working | `config.memoryLayers.working`' },
    { source: 'docs/day-11.md', quote: '| Long-term | `config.memoryLayers.longTerm`' },
  ] },
  { id: 4, question: 'Как агент маршрутизирует вызов Telegram tool среди нескольких MCP-серверов?', expected: 'Tool имеет квалифицированное имя и serverId; вызов направляется соответствующему MCP-клиенту.', sources: ['docs/day-20.md'], evidence: [
    { source: 'docs/day-20.md', quote: 'берёт сохранённый `serverId` и отправляет `tools/call`' },
  ] },
  { id: 5, question: 'Почему фоновый агент Day 20 не может создавать события в Яндекс Календаре при serverToolAccess read-only?', expected: 'Для календаря установлен read-only; инструменты записи ему не доступны.', sources: ['docs/day-20.md', 'docs/day-18.md'], evidence: [
    { source: 'docs/day-20.md', quote: 'server-level policy `read-only`', alternatives: [
      { source: 'docs/day-18.md', quote: 'Создание, изменение и удаление событий не попадают в каталог инструментов фонового агента' },
    ] },
  ] },
  { id: 6, question: 'Как определяется часовой пояс новой периодической задачи?', expected: 'Явно указанный пользователем пояс имеет приоритет; иначе берётся пояс браузера, затем AGENT_TIME_ZONE.', sources: ['docs/day-18.md'], evidence: [
    { source: 'docs/day-18.md', quote: 'Явно названный пользователем город или пояс всегда имеет приоритет.' },
    { source: 'docs/day-18.md', quote: '`AGENT_TIME_ZONE` из `.env`' },
  ] },
  { id: 7, question: 'Какие стратегии разбиения документов реализованы в Day 21?', expected: 'Fixed — 200 слов с overlap 40; structured — по заголовкам Markdown или файлам, длинные разделы тоже дробятся.', sources: ['docs/day-21.md'], evidence: [
    { source: 'docs/day-21.md', quote: '| `fixed` | 200 слов, overlap 40 слов' },
    { source: 'docs/day-21.md', quote: '| `structured` | Markdown по заголовкам, код по файлам' },
  ] },
  { id: 8, question: 'Какие метаданные сохраняются у каждого RAG-чанка?', expected: 'source, title, section, chunk_id; также strategy, ordinal и characterCount.', sources: ['docs/day-21.md'], evidence: [
    { source: 'docs/day-21.md', quote: 'обязательные `source`, `title`, `section`, `chunk_id`' },
  ] },
  { id: 9, question: 'Как осуществляется поиск по локальному RAG-индексу?', expected: 'Вопрос превращается в эмбеддинг через Ollama, затем векторы ранжируются по cosine similarity в SQLite.', sources: ['docs/day-21.md'], evidence: [
    { source: 'docs/day-21.md', quote: 'ранжирует все сохранённые чанки по cosine similarity' },
  ] },
  { id: 10, question: 'Что проверяется перед сохранением успешной фоновой сводки?', expected: 'Executor требует успешный MCP receipt; неподтверждённая сводка не сохраняется как success.', sources: ['docs/day-18.md'], evidence: [
    { source: 'docs/day-18.md', quote: 'executor требует успешный MCP receipt' },
  ] },
]
