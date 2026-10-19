# Изменения релиза

Проект: MyFamily · версия: ci-review-1.1.0

Диапазон: 5701a9a3e443569c69568c013317d0b1d1fe311a → fe9030e305306682dfea7a892c23b1a5a1a79dca

Покрытие: complete. Проанализировано 1/1 файлов.

Интерпретации AI требуют проверки разработчиком. Код проверяет источники и цитаты, отдельный вызов модели проверяет смысл выводов. Модельная проверка может ошибаться.

## .github/workflows/ai-code-review.yml

Обновление пина внешнего действия AI-Code Review с версии 1.0.2 \(commit dc359e7...\) на версию 1.1.0 \(commit 977c912...\). В комментарии указано, что новая версия выводит находки непосредственно на строках diff.

.github/workflows/ai-code-review.yml:27 (fe9030e3, RIGHT):       \# RAG AI Code Review v1.1.0, pinned commit; findings appear on diff lines.

.github/workflows/ai-code-review.yml:28 (fe9030e3, RIGHT):       - uses: PeshkovND/AI-Advent-Challenge@977c91233e221f529cb0382909d5e756befeb19c

.github/workflows/ai-code-review.yml:27 (5701a9a3, LEFT):       \# RAG AI Code Review v1.0.2, pinned to its verified commit; no npm install.

.github/workflows/ai-code-review.yml:28 (5701a9a3, LEFT):       - uses: PeshkovND/AI-Advent-Challenge@dc359e71221316df806fc4e82cc542ebd35c5e53



## Ограничения

В рамках настроенных лимитов.
