# Android-обёртка макета

`app/src/main/assets/index.html` — точная копия корневого `China_Preview.html`,
её пишет `node preview/build.mjs`. Все текстуры, шрифт и шейдеры встроены в HTML,
поэтому `INTERNET`-разрешения нет и APK работает полностью офлайн.

```sh
cd android
./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk (подписан debug-ключом)
```

Требуется JDK 17 и Android SDK с `platforms;android-34` / `build-tools;34.0.0`.
В песочнице SDK нет, поэтому APK собирается заданием `apk` в
`.github/workflows/china-preview-apps.yml` и выкладывается артефактом сборки.

Это отдельное приложение-витрина графики, а не новая сборка игры ShopSim.
WebView должен поддерживать WebGL2 (Chrome System WebView 91+).
