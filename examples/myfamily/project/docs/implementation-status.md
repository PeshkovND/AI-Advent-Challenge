# Реализованные сценарии и ограничения MyFamily

## Что уже есть в исходном коде

Есть модульный каркас UIKit-приложения, дизайн-система, WelcomeFlow, экран ввода телефона SignInFlow, нормализация и валидация номера, requestAuth через SignInInteractor, AppAuthService, AlamofireHttpClient, фабрика HTTP-запросов, хранилища, координаторы и debug menu. Это статическое описание кода, а не результат выполнения приложения.

## Где используются заглушки

HomeCoordinator создаёт UITabBarController с тремя TitleStubViewController: Home Screen, Store Screen и My Profile Screen. Профиль и магазин не являются завершёнными пользовательскими экранами.

В AppCoordinator.startCreateProfileFlow и startOnboardingFlow используется StubFlowCoordinator. Наличие ветвления по заполненности профиля не означает готовый экран создания профиля или завершённый onboarding.

В SignInViewModel успешный запрос SMS отправляет событие `.continue`. SignInCoordinator обрабатывает его только `print("succes")`. Экран ввода SMS и отправка события `.finish(authState:)` в этом обработчике не реализованы; полный сценарий авторизации до HomeFlow не завершён. В SignInInteractor и AuthService при этом есть методы confirm — инфраструктура запроса присутствует отдельно от UI-перехода.

## Обнаруженные пробелы перед сборкой

В AppDesignSystemTests указан resourcePath Resources, но такого каталога в Tests текущего checkout нет. Это замечание статического просмотра, а не опубликованный результат компиляции. UserProfilePayload объявлен в конце AccountRepository.swift; загрузка изображения реализована методом sendUploadImageRequest в AlamofireHttpClient.swift.

Build phase ограничивает Xcode значением XCODE_VERSION_ACTUAL ≤ 1520. Адреса API в xcconfig ещё имеют шаблонные значения. Credentials сохраняются в UserDefaults; переход на secure storage отмечен TODO. Перед утверждением готовности к релизу нужны отдельные проверки сборки, backend, пользовательских сценариев и хранения токенов.

Исходное руководство QuickStartGuide содержит примеры шаблона. При расхождении с исходным кодом используйте текущие Swift-файлы и эту документацию, подготовленную по commit 548ee58.
