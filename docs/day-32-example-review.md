<!-- day-32-ai-review -->
# Автоматическое AI-ревью кода
HEAD: `547cd787739204e8281d918bfd7f341ca2713d5e` · merge-base: `5bca7c7d0e9cf7c4f6e81524d0384a73aa35c30a`
Модель: deepseek-v4-flash · статус: **complete**
Проверено файлов: 1/1. RAG: 3 документов и файлов кода baseline.

## Потенциальные баги

- **[high] Умножение заменено на сложение в расчёте суммы счёта** — src/invoice.ts:1 (RIGHT)
  Функция invoiceTotal теперь возвращает price + quantity вместо price \* quantity. Это нарушает контракт из README.md \(«Invoice total must equal price multiplied by quantity»\) и ломает вызов в src/checkout.ts: invoiceTotal\(100, 3\) вернёт 103 вместо ожидаемых 300. Условие воспроизведения: любой вызов invoiceTotal с quantity &gt; 1 даёт неверную сумму счёта.
  Рекомендация: Вернуть умножение: export const invoiceTotal = \(price: number, quantity: number\) =&gt; price \* quantity
  Источник diff: export const invoiceTotal = \(price: number, quantity: number\) =&gt; price + quantity
  Источник README.md: Invoice total must equal price multiplied by quantity.
  Источник src/checkout.ts: export const total = invoiceTotal\(100, 3\)

## Архитектурные проблемы

Не выявлены в рассмотренных фрагментах.

## Рекомендации

Не выявлены в рассмотренных фрагментах.

## Покрытие и ограничения

RAG использует лексический TF-IDF-поиск по документации и коду merge-base; найденные фрагменты переданы модели. Проверены пути, строки и дословность цитат. Смысл замечаний требует проверки разработчиком; тесты кодом reviewer не запускаются.

- src/invoice.ts: ревью получено; RAG: README.md, src/invoice.ts, src/checkout.ts.
