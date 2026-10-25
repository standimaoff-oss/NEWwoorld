# Сборка и CI

## Локально

Нужен только JDK 17. Gradle скачает wrapper.

```bash
./gradlew build        # build/libs/aquaflux-<version>.jar
./gradlew test         # тесты ядра (без Minecraft)
./gradlew runClient    # клиент с модом, папка run/
./gradlew runServer    # сервер, папка run-server/
```

Первый запуск качает Forge и Minecraft — это несколько минут и ~1 ГБ в `~/.gradle`.

## CI на GitHub Actions

| Workflow | Когда | Что делает |
|---|---|---|
| `Build` | каждый пуш и PR | компиляция, тесты, `reobfJar`, артефакт `aquaflux-jar` |
| `Release` | тег `v*` | собирает и публикует GitHub Release с jar |

Репозиторий публичный, поэтому минуты Actions бесплатны.

Выпуск версии:

```bash
# версия в gradle.properties: mod_version=0.3.0
git tag v0.3.0
git push origin v0.3.0
```

## Структура

```
src/main/java/com/standimaoff/aquaflux   код мода
src/main/resources                       ассеты, mods.toml, pack.mcmeta
src/test/java                            тесты ядра (JUnit 5)
tools/gen_assets.py                      генератор текстур (чистый Python)
```

## Текстуры

Все PNG детерминированные, генерируются скриптом:

```bash
python3 tools/gen_assets.py
```

Pillow не нужен — PNG пишется через `zlib` + `struct`. Текстуры закоммичены, поэтому
для обычной сборки Python не требуется.
