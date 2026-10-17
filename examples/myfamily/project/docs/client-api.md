# Клиентский API MyFamily

Это описание восстановлено по Swift-клиенту, а не получено из backend. Оно подтверждает форму создаваемых запросов, но не работоспособность сервера. Backend-реализации в репозитории нет.

## Где искать код

`XcodeProject/Packages/AppModulesPackage/Sources/AppServices/Sources/API/HttpRequestFactory.swift` определяет пути, HTTP-методы и параметры. `HttpClient/AlamofireHttpClient.swift` отправляет обычные запросы. `Services/AuthService.swift` реализует requestAuth, confirm, refreshToken и logout. Сетевые модели находятся в `API/NetworkPayloads/AuthorizedUserPayload.swift`.

## Авторизация

| HTTP | Путь | JSON-параметры | Метод фабрики |
| --- | --- | --- | --- |
| POST | /auth/request | uuid, number, access="user" | requestAuth(uuid:number:) |
| POST | /auth/confirm | uuid, number, access="user", code | confirmAuth(uuid:number:code:) |
| POST | /auth/refresh-token | uuid, refreshToken | refreshToken(uuid:refreshToken:) |
| POST | /auth/logout | Без параметров тела в HttpRequest<Params.None> | logout() |

uuid — идентификатор устройства, number — номер телефона, code — SMS-код. AuthService сначала читает сохранённый deviceId, затем использует identifierForVendor либо UUID и сохраняет результат. SignInViewModel удаляет символы форматирования номера и добавляет countryCode из GlobalConfig перед requestAuth.

Запросы с параметрами используют JSONParameterEncoder. Base URL добавляется замыканием baseUrlProviding; его предоставляет Env через AppContainer. Endpoint для обновления токена — именно POST /auth/refresh-token; поле refreshToken передаётся вместе с uuid.

## Профиль и изображение

Фабрика `getUseProfile()` создаёт GET /profile. Название метода с Use сохранено как в исходном коде. AccountRepository.fetchProfile вызывает этот запрос и обновляет AccountHolder после преобразования ответа NetworkMapper.

`uploadAvatar(data:)` создаёт UploadImageHttpRequest с endpoint /profile/avatar и multipart-полем avatar. У части задаются fileName image.jpg и MIME image/jpeg. AlamofireHttpClient.sendUploadImageRequest вызывает session.upload с multipartFormData и URL, оставляя HTTP-метод значением по умолчанию Alamofire. В частичном OpenAPI этот путь вынесен в x-client-upload: явный HTTP-метод в собственном Swift-коде не задан.

## Ответы и ограничения контракта

AuthorizedUserPayload содержит alreadyRegistered, profile, settings и token. TokenPayload содержит accessToken, refreshToken, expiresIn (String). Это клиентские ожидаемые поля, а не подтверждённый контракт работающего backend. HTTP success-коды, production SLA и полный набор серверных ошибок здесь не установлены.

Частичная машиночитаемая схема — `project/docs/api/openapi.json`; путь /profile/avatar указан там как неподтверждённая операция без выдуманного HTTP-метода. Данные моделей подробнее описаны в `project/docs/data-models.md`.
