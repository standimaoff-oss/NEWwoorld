# Стабильные релизы НейроЯдра

APK и Windows-инсталлятор публикуются **только** workflow `Publish NeuroYadro stable release`. Он запускается исключительно при push тега вида `neuroyadro-vX.Y.Z`; обычные commits, PR и проверки никогда не создают GitHub Release.

## Что должен сделать maintainer

1. Дождаться зелёного `NeuroYadro verify` для PR и принять PR в `main`.
2. Настроить в GitHub Actions Secrets ключ подписи Android:
   - `NEUROYADRO_ANDROID_KEYSTORE_B64` — base64 содержимого JKS;
   - `NEUROYADRO_ANDROID_KEYSTORE_ALIAS`;
   - `NEUROYADRO_ANDROID_KEYSTORE_STORE_PASSWORD`;
   - `NEUROYADRO_ANDROID_KEYSTORE_KEY_PASSWORD`.
3. Создать и отправить **аннотированный стабильный** тег, например:

   ```bash
   git tag -a neuroyadro-v0.1.0 -m "NeuroYadro 0.1.0"
   git push origin neuroyadro-v0.1.0
   ```

Workflow намеренно завершится ошибкой до создания release, если Android signing secrets отсутствуют. Неподписанный APK не публикуется как стабильный.

## Результирующие assets

После успешных Windows и Android jobs единственный Release содержит:

| Asset | Назначение |
| --- | --- |
| `NeuroYadro-windows-x64-setup.exe` | Inno Setup installer: приложение, Qt runtime, SQLite driver и llama.cpp runtime. Модель GGUF не вшита. |
| `NeuroYadro-windows-x64-setup.exe.sha256` | SHA-256 installer. |
| `NeuroYadro-android-arm64-v8a.apk` | Подписанный Android arm64-v8a APK, без модели GGUF. |
| `NeuroYadro-android-arm64-v8a.apk.sha256` | SHA-256 APK. |

Перед объявлением версии нужно установить APK на физическое arm64 устройство и выполнить launch, загрузку GGUF, генерацию, отмену, SQLite history и повторный запуск. В этой ветке workflow ещё не выполнялся успешно, поэтому стабильных assets пока нет.
