# Архитектура MyFamily

## Технологии и слои

MyFamily использует Swift, UIKit, Combine, MVVM и Coordinator. Минимальная версия iOS — 15.0. Манифесты Swift Package Manager используют Swift tools 5.7. Источник: `XcodeProject/Packages/AppModulesPackage/Package.swift` и `XcodeProject/Packages/UmbrellaPackage/Package.swift`.

Основные слои: приложение App → UmbrellaPackage → AppModulesPackage → внешние зависимости. UmbrellaPackage объединяет девять внутренних модулей в одну библиотеку для приложения.

## Модули

| Модуль | Назначение |
| --- | --- |
| Utilities | Общие расширения, логирование, таймер, обработка клавиатуры и вспомогательные инструменты UIKit. |
| AppEntities | Account, Credentials, UserProfile, PhoneContact, Image, Avatar и AppError. |
| AppDesignSystem | Цвета, шрифты, строки, иконки, форматирование телефона и UI-компоненты. |
| AppBaseFlow | Базовые View, ViewController, ViewModel и Coordinator, общая конфигурация. |
| AppServices | HTTP-клиент Alamofire, авторизация, окружения, хранилища, загрузка изображений, камера и контакты. |
| WelcomeFlow | Приветственный экран и событие перехода ко входу. |
| SignInFlow | Экран ввода телефона, ViewModel, SignInInteractor, SignInCoordinator и AccountRepository. |
| HomeFlow | Tab bar с тремя экранами-заглушками Home, Store и Profile. |
| AppDevTools | Debug menu, feature toggles, FakeAuthService, StubFlowCoordinator и демонстрационные экраны. |

Источники: `AppModulesPackage/Package.swift` и соответствующие каталоги `Sources/<Module>/Sources`. Внешние зависимости: IQKeyboardManagerSwift, TweeTextField, Alamofire, SDWebImage, SDWebImageWebPCoder, SnapKit и JGProgressHUD.

## Точки входа и зависимости

Точка входа — `@main AppDelegate` в `XcodeProject/App/Source/Infrastructure/AppDelegate.swift`. При запуске AppDelegate включает WebP coder и менеджер клавиатуры, затем вызывает `appCoordinator.start()`.

`AppContainer.swift` создаёт Env, MemoryStorage, DefaultsStorage, debugStorage, AlamofireHttpClient, AppAuthService, HttpRequestFactory и NetworkMapper. HTTP-клиент использует AuthenticationInterceptor с OAuthAuthenticator. HttpRequestFactory получает base URL через замыкание `env.apiBaseUrlString`. AuthService получает HTTP-клиент лениво, чтобы избежать цикла инициализации.

`AppContainer.provideAuthService()` возвращает настоящий AppAuthService. FakeAuthService объявлен отдельно и по умолчанию этим методом не возвращается.

## Навигация

Корневая навигация находится в `AppCoordinator.swift`. Сначала создаётся UIWindow с UINavigationController. Debug-toggle onboarding может сразу направить в onboarding. Обычно отсутствие авторизованного пользователя ведёт в WelcomeFlow; авторизованный пользователь направляется к созданию профиля либо onboarding/Home в зависимости от состояния профиля и сохранённого признака onboarding.

WelcomeCoordinator отправляет событие signIn, по которому AppCoordinator открывает SignInCoordinator. Завершение signIn/signUp предусмотрено в корневом координаторе, но текущий обработчик `.continue` внутри SignInCoordinator только печатает `succes`; полного перехода после SMS в этом checkout нет.

## Устройство экрана

Экран разделяется на Context (события, состояния и ошибки), ContentView (UIKit layout), ViewController (binding и отображение состояния) и ViewModel (логика представления). Для обращения к сервисам используются interactor/repository. В SignInFlow это SignInViewModel → SignInInteractor → AuthService. Combine связывает события и обновления состояния.

См. также `project/docs/implementation-status.md`: координаторы и модели описывают инфраструктуру, а не гарантируют завершённость всех экранов.
