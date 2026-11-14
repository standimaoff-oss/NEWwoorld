# Windows-обёртка макета

`app/index.html` — точная копия корневого `China_Preview.html`, её пишет `node preview/build.mjs`.
Обёртка не требует сети и не меняет `ShopSim.exe`.

```bat
npm install
npm start            :: запустить локально
npm run dist         :: ChinaPreview.exe (portable, без установки)
```

Сборка portable-EXE доступна на Windows; в Linux-песочнице её собирает CI
(`.github/workflows/china-preview-apps.yml`, job `exe`).
