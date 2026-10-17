# Модели данных и хранение MyFamily

## Доменные модели AppEntities

Account — Codable-структура с alreadyRegistered (Bool), profile (Account.Profile) и settings (Account.Settings). Profile хранит id, createdAt и updatedAt (Date), firstName, lastName, displayName, phoneNumber и необязательное avatarImage. Settings содержит mute (Bool).

Credentials — Codable-структура с accessToken, refreshToken и expirationDate (Date). Токены — значения модели, а не реальные секреты в документации. Источник: `XcodeProject/Packages/AppModulesPackage/Sources/AppEntities/Sources/Account.swift`.

UserProfile содержит идентификатор, роль, телефон, имена и три варианта Avatar; равенство и hash определяются по id. PhoneContact содержит personId, firstName, lastName, phoneNumber и необязательные thumbnailImageData. Image содержит small, medium и original; каждый Image.Info содержит width, height и url. Источники — соответствующие файлы AppEntities/Sources.

FriendRequestStatus перечисляет approved, ingoing, outgoing и null; FoundUsersByPhoneNumber объединяет UserProfile, friendRequest и originalNumber. Наличие этих моделей не доказывает готовность семейных или социальных экранов.

## Сетевые payload и преобразование

AuthorizedUserPayload: alreadyRegistered, profile, settings, token. ProfilePayload: id, createdAt, updatedAt, phoneNumber; firstName, lastName, displayName и avatar могут отсутствовать. TokenPayload: accessToken, refreshToken, expiresIn. В payload даты и expiresIn имеют тип String; в доменных Credentials и Account.Profile используются Date. Преобразование выполняет NetworkMapper.

Account/Profile — внутренние модели приложения. Их нельзя автоматически считать JSON Schema серверного API: состав и типы сетевых payload отличаются. Источник — `AppServices/Sources/API/NetworkPayloads/AuthorizedUserPayload.swift`.

## Хранилища и авторизация

AppContainer создаёт MemoryStorage, DefaultsStorage и отдельное debugStorage. DefaultsStorage работает поверх UserDefaults с suiteName на основе bundle id. AppAuthService сохраняет Account, Credentials и deviceId через DefaultsStorage.

Credentials сейчас хранятся в DefaultsStorage/UserDefaults. В saveCredentials есть комментарий IMPLEMENT: Replace with secure storage; Keychain для этого пути не реализован. Это текущее состояние кода, а не рекомендация хранить production-токены в UserDefaults.

В AppAuthService hasAuthorizedUser проверяет наличие credentials и условие expirationDate > Date(). hasFilledProfile требует непустые firstName, lastName и displayName профиля. Logout удаляет локальные account/credentials, а callbacks позволяют AppCoordinator вернуться к WelcomeFlow. FakeAuthService предназначен для разработки; AppContainer по умолчанию предоставляет AppAuthService.
