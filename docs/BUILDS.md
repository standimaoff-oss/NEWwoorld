# ShopSim — сборки и скриншоты

Открытый мир, симулятор магазина на three.js/WebGL. Работает в браузере, на Android и Windows.

## Скачать

| Платформа | Файл | Размер | Ссылка |
|---|---|---|---|
| Android (7.0+) | `ShopSim.apk` | 0.88 МБ | https://github.com/standimaoff-oss/NEWwoorld/releases/download/shopsim-latest/ShopSim.apk |
| Windows (x86-64) | `ShopSim.exe` | 3.03 МБ | https://github.com/standimaoff-oss/NEWwoorld/releases/download/shopsim-latest/ShopSim.exe |

Релиз целиком: https://github.com/standimaoff-oss/NEWwoorld/releases/tag/shopsim-latest

- **Windows**: это **нативное приложение**, а не запуск браузера. Окно принадлежит игре
  (своя иконка, заголовок, минимальный размер), внутри — движок Microsoft Edge WebView2.
  Runtime предустановлен в Windows 11 и большинстве сборок Windows 10; если его нет,
  приложение подскажет, что скачать. Игра распаковывается в `%LOCALAPPDATA%\ShopSim\game`,
  файлы отдаёт встроенный сервер на `127.0.0.1:8731` (нужен для ES-модулей и importmap).
- **Android**: подписан отладочным ключом CI — при установке разрешите «неизвестные источники».
  Игра полностью офлайн: ассеты внутри APK, сервер слушает только loopback.

## Графика

Рендер с полноценным пост-процессингом в HDR:
**GTAO** (контактное затенение), **SSGI** (цветной переотражённый свет),
**Bloom** (мягкое свечение), **God rays** (лучи от солнца), ACES-тонмаппинг,
хроматическая аберрация и FXAA. Тени деревьев и магазинов попадают и на газон —
шейдер травы сам читает карту теней.

## Скриншоты

Тени от домов и деревьев на газоне и тротуаре:

![Тени](https://raw.githubusercontent.com/standimaoff-oss/NEWwoorld/arena/afd15e87-newwoorld/docs/screenshots/shadows.jpg)

![Газон](https://raw.githubusercontent.com/standimaoff-oss/NEWwoorld/arena/afd15e87-newwoorld/docs/screenshots/lawn.jpg)

День — газон, облака, город:

![День](https://raw.githubusercontent.com/standimaoff-oss/NEWwoorld/arena/afd15e87-newwoorld/docs/screenshots/day.jpg)

Закат — тёплая заря, звёзды, подсвеченные окна:

![Закат](https://raw.githubusercontent.com/standimaoff-oss/NEWwoorld/arena/afd15e87-newwoorld/docs/screenshots/sunset.jpg)

Ночь:

![Ночь](https://raw.githubusercontent.com/standimaoff-oss/NEWwoorld/arena/afd15e87-newwoorld/docs/screenshots/night.jpg)

Тротуар и газон — чистый стык:

![Тротуар](https://raw.githubusercontent.com/standimaoff-oss/NEWwoorld/arena/afd15e87-newwoorld/docs/screenshots/sidewalk.jpg)

## Управление

- **WASD** — движение, **мышь** — обзор, **E** — действие, **Shift** — бег.
- **M** — карта, **C** — каталог товаров, **Tab** — пауза.
- **Android**: экранные кнопки, наклон устройства для обзора.

## Сборка из исходников

```bash
# игра в браузере
node game/tools/serve.cjs 8080     # http://127.0.0.1:8080/game/index.html

# portable EXE (нужен zig)
node launcher/build.cjs            # → dist/ShopSim.exe

# APK (нужен Android SDK)
cd android && ./gradlew assembleRelease   # → app/build/outputs/apk/release/
```

GitHub Actions собирает оба файла автоматически при каждом изменении:
`game/**`, `android/**` или `launcher/**`.

## Проверки

- `node game/tools/gametest.cjs` — 17 автотестов (мир, торговля, погода, панели, консоль).
- `node launcher/build.cjs` — проверяет PE-заголовок, подсистему GUI и встроенный ZIP.
