# Вход VK ID и сессия

Снимок исходников: MyFamily, origin/develop, commit cbd4086dc5e30c8e5a77262e1c944cc1514d30d4.

## Как работает вход через VK ID

В проверенной ветке develop основной вход MyFamily выполняется через VK ID: AppAuthService.signIn вызывает vkIdClient.authorize. При успехе сохраняются credentials и данные аккаунта, после чего запускается проверка семьи. Это не корпоративный SSO и не основной SMS-сценарий ранней ветки main. Старый обработчик SMS-ошибки сам по себе не означает, что пользователь сейчас входит по SMS. При проблеме с VK ID нужно уточнить этап и точный текст ошибки; без диагностического события нельзя объявлять сбой VK или Firebase.

## Истекшая сессия и отсутствие семьи

Сессия считается действующей, только если credentials присутствуют и expirationDate больше текущего времени. При отсутствии или истечении сессии стартует сценарий входа. Если демонстрационный контекст показывает expired или absent, предложите повторный вход через VK ID, не запрашивая токен или код. Успешный вход ещё не означает готовность семьи: после авторизации приложение проверяет familyId; отсутствие семьи ведёт к выбору создания семьи или вступления. Это не ошибка SMS. Проверка hasFilledProfile также учитывает имя, фамилию и наличие семьи.

## Источники реализации

- `XcodeProject/Packages/AppModulesPackage/Sources/AppServices/Sources/Services/AuthService.swift`
- `XcodeProject/Packages/AppModulesPackage/Sources/SignInFlow/Sources/SignInScreen/SignInViewModel.swift`
- `XcodeProject/Packages/AppModulesPackage/Sources/SignInFlow/Sources/FamilyCheckingScreen/FamilyCheckingRepository.swift`
