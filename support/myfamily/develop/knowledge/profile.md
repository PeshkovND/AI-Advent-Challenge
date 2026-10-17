# Профиль и выход из семьи

Снимок исходников: MyFamily, origin/develop, commit cbd4086dc5e30c8e5a77262e1c944cc1514d30d4.

## Как изменить имя, фамилию и фото

В develop есть рабочий экран редактирования профиля. EditProfileViewModel подставляет текущие данные аккаунта и обрезает пробелы в имени и фамилии. Кнопка сохранения активна, только если оба поля непустые. Выбранная фотография загружается отдельно, а сохранение вызывает editUser с именем, фамилией и URL изображения. Семья и роль при редактировании сохраняются. В editUser обработчике ViewModel есть guard на URL изображения: без него сохранение не продолжается, поэтому при зависании уточните загрузилась ли фотография. ImagePicker поддерживает камеру и фотоальбом. Если контекст показывает запрет камеры или фото, проверьте соответствующий доступ в настройках устройства; не обещайте конкретный системный диалог для любой сборки.

## Как выйти из семьи и удалить публикацию

Кнопка выхода из семьи в собственном профиле показывается пользователю, который не является owner. Для owner эта кнопка по условию needShowLeavefamilyButton скрыта. Нельзя придумывать передачу владения, удаление семьи или обход ограничения: такой сценарий здесь не подтверждён. Выход regular удаляет familyId аккаунта, после чего снова запускается проверка семьи. Из профиля предусмотрено удаление публикации; после успешного запроса она исключается из локального списка, а лента помечается для обновления. Поддержка не удаляет семью или публикации за пользователя.

## Источники реализации

- `XcodeProject/Packages/AppModulesPackage/Sources/HomeFlow/Sources/EditProfileScreen/EditProfileRepository.swift`
- `XcodeProject/Packages/AppModulesPackage/Sources/HomeFlow/Sources/EditProfileScreen/EditProfileViewModel.swift`
- `XcodeProject/Packages/AppModulesPackage/Sources/HomeFlow/Sources/ProfileScreen/ProfileViewModel.swift`
- `XcodeProject/Packages/AppModulesPackage/Sources/HomeFlow/Sources/ProfileScreen/ProfileRepository.swift`
- `XcodeProject/Packages/AppModulesPackage/Sources/AppServices/Sources/ImagePicker/ImagePicker.swift`
