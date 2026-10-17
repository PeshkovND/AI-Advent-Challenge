# Запуск и тестирование MyFamily

## Требования

Нужны macOS, полный Xcode с iOS SDK и Swift Package Manager. В манифестах указан Swift tools 5.7 и iOS 15.0. Корневой проект — `XcodeProject/App.xcodeproj`; UIKit-модули следует собирать для iOS, а не обычной командой `swift test` для macOS.

Build phase `XcodeProject/BuildPhaseScripts/ensure_xcode_version.sh` задаёт `XCODE_VERSION_CONSTRAINT="1520"` и отклоняет `XCODE_VERSION_ACTUAL > 1520`. Хотя текст ошибки говорит о равенстве, проверка в скрипте проверяет верхнюю границу. Совместимость более нового Xcode требует отдельной проверки и осознанного изменения этого скрипта.

## Схемы и конфигурации

| Схема | Run / Test / Analyze | Profile / Archive |
| --- | --- | --- |
| AppDevelopment | Debug | QaRelease |
| AppProduction | DebugProduction | ProductionRelease |

Настройки лежат в `XcodeProject/App/xcconfigs/Debug.xcconfig`, `QaRelease.xcconfig`, `DebugProduction.xcconfig`, `ProductionRelease.xcconfig`. Значимые параметры: APP_DISPLAY_NAME, APP_BUILD_TYPE, APP_API_STAGING, APP_API_PRODUCTION, PRODUCT_BUNDLE_IDENTIFIER и DEVELOPMENT_TEAM. Для физического устройства нужны собственные signing-настройки.

Env читает значения через InfoPlist. При buildType production используется productionApi; в остальных случаях — выбранный в debugStorage API либо stagingApi по умолчанию. Текущие адреса API в xcconfig являются значениями шаблона и не подтверждают доступность рабочего backend.

## Порядок запуска

Откройте `XcodeProject/App.xcodeproj`, выберите AppDevelopment и iOS Simulator, дождитесь разрешения Swift Package Manager и выполните Run. Перед сетевой проверкой укажите свой backend. Для проверки командной строкой сначала получите доступные схемы и устройства:

```bash
xcodebuild -list -project XcodeProject/App.xcodeproj
xcodebuild -showdestinations -project XcodeProject/App.xcodeproj -scheme AppDevelopment
```

После выбора существующего simulator destination можно запускать build/test с его идентификатором. Команды здесь описывают процедуру; успешная сборка текущего checkout не заявляется.

## Автоматические тесты и инструменты

В AppModulesPackage объявлены AppDesignSystemTests и AppServicesTests. Тесты дизайн-системы проверяют форматирование телефона; тесты сервисов — AppError и разбор HTTP/validation errors на JSON fixtures. AppDevelopment.xcscheme перечисляет оба test target. AppProduction.xcscheme не содержит аналогичного списка тестов.

Для AppDesignSystemTests в Package.swift указан resourcePath Resources, но в текущем каталоге Tests такого каталога нет. Это необходимо проверить при подготовке сборки. Список дополнительных обнаруженных пробелов описан в `project/docs/implementation-status.md`.

Build phase `run_swiftlint.sh` использует бинарник SwiftLint 0.52.2 из Tools и запускает lint для конфигурации Debug. Старые Xcode templates в Tools описаны в исходном README как устаревшие и ограниченные App target.

В среде подготовки этой документации активны только Command Line Tools; `xcodebuild -version` требует полный Xcode. Поэтому результат проверки RAG/MCP-ассистента не является результатом сборки или UI-тестов iOS-приложения.
