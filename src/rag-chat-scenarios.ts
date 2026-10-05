/** Evaluation expectations are never supplied to the chat agent. */
export type RagChatScenario = { id: string; title: string; goal: string; turns: Array<{ input: string; expected: string; sources: string[]; memoryTerms?: string[]; absentConstraints?: string[]; dialogueOnly?: boolean }> }
export const ragChatScenarios: RagChatScenario[] = [
  {
    id: 'rag-demo', title: 'Демонстрация локального RAG', goal: 'демонстрац',
    turns: [
      { input: 'Моя цель — подготовить пятиминутную демонстрацию локального RAG для новичков. Без новых библиотек и внешних векторных баз. Отвечай кратко. Какие две стратегии разбиения документов уже есть в проекте?', expected: 'Fixed по словам и structured по разделам; сохранена цель демонстрации и ограничения.', sources: ['docs/day-21.md', 'server/rag-indexer.ts'] },
      { input: 'Для основного примера выбираем structured. Как именно эта стратегия использует заголовки Markdown?', expected: 'Разделы Markdown и метаданные section, выбран structured.', sources: ['docs/day-21.md', 'server/rag-indexer.ts'], memoryTerms: ['structured'] },
      { input: 'Термин «контекст» в нашем разговоре означает найденные чанки документов, а не историю сообщений. Какие метаданные сохраняются у каждого чанка?', expected: 'source, title, section, chunk_id; пользовательское значение «контекст» сохранено.', sources: ['docs/day-21.md', 'server/rag-indexer.ts'], memoryTerms: ['контекст'] },
      { input: 'Теперь кратко сравни её с fixed: в каких единицах задан его размер и перекрытие?', expected: 'Сравнение structured с fixed по словам, не символам.', sources: ['docs/day-21.md', 'server/rag-indexer.ts'] },
      { input: 'Основной пример всё-таки остаётся structured, fixed нужен только для сравнения. Какая локальная модель используется для эмбеддингов?', expected: 'Ollama/Nomic по документам; основной выбор не заменён на fixed.', sources: ['docs/day-21.md', 'server/rag-indexer.ts'], memoryTerms: ['structured'] },
      { input: 'Напомни конечную цель нашего диалога и что у нас означает слово «контекст».', expected: 'Цель демонстрации для новичков, контекст = найденные чанки. Источники — слова пользователя.', sources: [], dialogueOnly: true, memoryTerms: ['контекст'] },
      { input: 'Где сохраняются локальные эмбеддинги и метаданные индекса?', expected: 'SQLite и локальный файл индекса по документации.', sources: ['docs/day-21.md', 'server/rag-indexer.ts'] },
      { input: 'А как в нём ищутся подходящие фрагменты для нового вопроса?', expected: 'Вопрос эмбеддится, cosine similarity и top-K; «в нём» = локальный индекс, не память.', sources: ['docs/day-21.md', 'server/rag-indexer.ts'] },
      { input: 'Нужен ли разный префикс для текста документа и поискового вопроса у Nomic?', expected: 'search_document и search_query, только если подтверждены найденными фрагментами.', sources: ['docs/day-21.md', 'server/rag-indexer.ts'] },
      { input: 'Меняю ограничение: новые библиотеки теперь разрешены, но внешние векторные базы по-прежнему запрещены. Зафиксируй это, не меняя цель демонстрации.', expected: 'Старый запрет библиотек заменён, запрет внешних баз и цель сохранены. Цитаты пользователя.', sources: [], dialogueOnly: true, absentConstraints: ['без новых библиотек', 'новые библиотеки запрещены'] },
      { input: 'Какие команды позволяют посмотреть статистику индекса и выполнить пробный поиск?', expected: 'rag:stats и rag:search по документации, без предложений о внешнем сервисе.', sources: ['docs/day-21.md', 'package.json', 'README.md'] },
      { input: 'Собери короткий итог для моей демонстрации: цель, выбранная стратегия, где хранится индекс и как выполняется поиск. Учти действующие ограничения.', expected: 'Демонстрация для новичков, structured, SQLite, cosine; актуальные ограничения. Документальные факты имеют цитаты документов.', sources: ['docs/day-21.md', 'server/rag-indexer.ts'], memoryTerms: ['structured', 'контекст'], absentConstraints: ['без новых библиотек', 'новые библиотеки запрещены'] },
    ],
  },
  {
    id: 'scheduler-review', title: 'Чек-лист надёжности фоновых задач', goal: 'чек-лист',
    turns: [
      { input: 'Моя цель — составить чек-лист надёжности фоновых задач этого проекта. Новые зависимости запрещены, календарь используем только для чтения. Как сохраняются задачи и предотвращается их двойной запуск?', expected: 'SQLite, транзакционный захват, сохранена цель и два ограничения.', sources: ['docs/day-17.md', 'docs/day-18.md', 'server/scheduler-store.ts'] },
      { input: 'Что происходит с пропущенными запусками после перезапуска сервера?', expected: 'Поведение overdue по документации, цель не заменяется перезапуском.', sources: ['docs/day-17.md', 'docs/day-18.md', 'server/scheduler-worker.ts'] },
      { input: 'Для наших примеров зафиксируй часовой пояс Asia/Omsk. Как проект выбирает часовой пояс для календарных запросов?', expected: 'Пользовательский пояс сохранён отдельно от фактов о выборе timezone.', sources: ['docs/day-16.md', 'server/scheduler-timezone.ts'], memoryTerms: ['Asia/Omsk'] },
      { input: 'Термин «сводка» здесь означает результат фонового агента, подтверждённый MCP receipt. Что проверяют перед сохранением её как успешной?', expected: 'Проверка успешного MCP receipt; пользовательское значение термина сохранено.', sources: ['docs/day-18.md', 'server/scheduled-agent-executor.ts'], memoryTerms: ['сводка'] },
      { input: 'А какая блокировка защищает эту задачу от одновременного выполнения двумя worker?', expected: 'Транзакция/lock из scheduler, «эта задача» раскрыта в поиске.', sources: ['docs/day-18.md', 'server/scheduler-store.ts'] },
      { input: 'Напомни мою исходную цель и ограничения на календарь.', expected: 'Цель чек-листа надёжности, календарь только read-only; цитаты исходного пользователя.', sources: [], dialogueOnly: true },
      { input: 'Меняю одно ограничение: новые зависимости теперь разрешены. Календарь остаётся только для чтения, создавать и удалять события нельзя. Зафиксируй изменение.', expected: 'Замена запрета зависимостей; read-only остаётся, цели и пояс не потеряны.', sources: [], dialogueOnly: true, absentConstraints: ['новые зависимости запрещены'], memoryTerms: ['Asia/Omsk'] },
      { input: 'Как агент сопоставляет имя MCP-инструмента с конкретным сервером?', expected: 'Маршрутизация по servers/tools и именам, подтверждена кодом.', sources: ['docs/day-15.md', 'server/mcp-tool-runtime.ts'] },
      { input: 'Что именно разрешено агенту с read-only доступом к календарю?', expected: 'Только чтение/поиск, создание и удаление запрещены.', sources: ['docs/day-16.md', 'server/mcp-tool-runtime.ts'] },
      { input: 'Какой часовой пояс мы зафиксировали и что означает «сводка» в нашем разговоре?', expected: 'Asia/Omsk и результат фонового агента с MCP receipt; не общие определения.', sources: [], dialogueOnly: true, memoryTerms: ['Asia/Omsk', 'сводка'] },
      { input: 'Собери три пункта чек-листа: сохранение задач, захват worker и подтверждение успешной сводки. Не предлагай календарных записей.', expected: 'SQLite, транзакционный захват/lock, MCP receipt, соблюдение read-only.', sources: ['docs/day-18.md', 'server/scheduler-store.ts', 'server/scheduled-agent-executor.ts'] },
      { input: 'В конце напомни, чего мы хотели добиться, какие ограничения ещё действуют и какое ограничение я изменил.', expected: 'Чек-лист надёжности, read-only календарь, новые зависимости разрешены; цель из начала диалога сохранена.', sources: [], dialogueOnly: true, memoryTerms: ['Asia/Omsk', 'сводка'], absentConstraints: ['новые зависимости запрещены'] },
    ],
  },
]
