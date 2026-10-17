# MyFamily

MyFamily — заготовка iOS-приложения на Swift и UIKit с модульной архитектурой, MVVM, Coordinator и Combine. В текущем коде есть приветственный экран, ввод телефона, сервисы авторизации, сетевой слой и дизайн-система. Главный экран, магазин, профиль, создание профиля и onboarding содержат заглушки; готовые семейные функции из названия репозитория не следуют.

Документация подготовлена по исходному коду репозитория PeshkovND/MyFamily, commit `548ee58` (`init app`), 16 октября 2026 года. Сборка iOS и доступность backend этой проверкой не подтверждены.

## Быстрый старт

1. Установите Xcode с iOS SDK. В `Package.swift` указан Swift tools 5.7, минимальная платформа — iOS 15. В build phase есть ограничение версии Xcode: см. [запуск](project/docs/setup.md).
2. Откройте `XcodeProject/App.xcodeproj`.
3. Выберите схему `AppDevelopment` и доступный iOS Simulator. Swift Package Manager должен разрешить зависимости.
4. Для устройства задайте собственные `DEVELOPMENT_TEAM` и `PRODUCT_BUNDLE_IDENTIFIER` в `XcodeProject/App/xcconfigs/`.
5. Замените шаблонные `APP_API_STAGING` и `APP_API_PRODUCTION` на адреса своего backend перед проверкой сетевой авторизации.

## Структура

- `XcodeProject/App/Source/Infrastructure/` — `AppDelegate`, корневой `AppCoordinator` и контейнер зависимостей `AppContainer`.
- `XcodeProject/Packages/AppModulesPackage/` — основные модули и тесты Swift Package Manager.
- `XcodeProject/Packages/UmbrellaPackage/` — пакет, объединяющий внутренние модули для App target.
- `XcodeProject/App/xcconfigs/` — четыре конфигурации сборки и API-окружения.
- `project/docs/` — актуальные руководства по архитектуре, запуску, данным, ограничениям и частичное OpenAPI-описание в `api/openapi.json`.
- `Docs/Architecture.md` — исходное описание архитектурных слоёв шаблона.
- `QuickStartGuide/` — исходное руководство по шаблону; примеры в нём требуют сверки с текущим кодом.
- `Tools/` — SwiftLint 0.52.2 и исторические Xcode-шаблоны экранов.

## Документация

- [Архитектура и точки входа](project/docs/project-architecture.md)
- [Запуск, схемы, настройки и тесты](project/docs/setup.md)
- [Клиентский API авторизации и профиля](project/docs/client-api.md)
- [Частичное OpenAPI-описание клиента](project/docs/api/openapi.json)
- [Модели данных и хранение](project/docs/data-models.md)
- [Реализованные сценарии и ограничения](project/docs/implementation-status.md)
- [Исходное описание слоёв](Docs/Architecture.md)

Документация описывает текущий checkout. Наличие фабрики HTTP-запроса или модели данных само по себе не означает готовый экран, работающий backend или завершённый пользовательский сценарий.

## Документация для ассистента

Для RAG используйте корневой `README.md` и каталог `project/docs/`, включая `project/docs/api/openapi.json`. Исходный `Docs/Architecture.md` дополняет их историческим описанием слоёв. Состояние Git (текущая ветка, commit и изменения) нужно получать при каждом вопросе через MCP, а не брать из документации. Ветка и commit здесь намеренно не выдаются за текущее состояние checkout.
