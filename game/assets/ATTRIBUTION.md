# Атрибуция сторонних материалов — NEWwoorld

Этот файл — **единственный юридически значимый перечень** того, что взято
со стороны и на каких условиях. Он читается авторами ассетов, издателями и
всеми, кто проверяет права перед релизом.

Требование ТЗ: *«для моделей, которые ИИ сложно сделать (например человек),
можно брать ассеты со свободных форумов — только действительно свободные,
либо с указанием авторства»*. Этот файл и есть реализация второй части
требования.

> **Правило, которое нельзя нарушать.** Ассет попадает в игру только после
> того, как он записан сюда И в `game/data/credits.json`. Проверка не
> формальность: `game/tests/unit/test_credits_data.gd` и задание CI `assets`
> сверяют два файла между собой и не пропускают запись без лицензии.

---

## Как добавить новый ассет

1. **Проверьте лицензию на странице загрузки, а не в описании пакета.**
   На OpenGameArt и Sketchfab разные файлы одного автора могут идти под
   разными лицензиями.
2. Убедитесь, что лицензия есть в списке разрешённых
   (`Validators.FREE_LICENSES` или `Validators.ATTRIBUTION_LICENSES` в
   `game/scripts/util/validators.gd`) и отсутствует в `FORBIDDEN_LICENSES`.
3. Пропустите модель через конвейер:
   ```bash
   node tools/asset-pipeline/scripts/optimize_models.mjs game/assets/models
   node tools/asset-pipeline/scripts/validate_models.mjs game/assets --strict
   ```
4. Добавьте запись в `game/data/credits.json` → `used_assets`
   (поля `name`, `author`, `license`, `url`, `kind`, `attribution_required`).
5. Добавьте раздел ниже с **дословным текстом уведомления**, если лицензия
   требует атрибуции.
6. Запустите `python3 tools/verify/check_data.py` — он сверит оба файла.

---

## Разрешённые лицензии

| Лицензия | Атрибуция | Комментарий |
| --- | --- | --- |
| CC0 1.0 Universal | не требуется | Полное отречение от прав. Предпочтительный выбор. |
| MIT | требуется | Текст уведомления обязателен. |
| Apache-2.0 | требуется | Плюс сохранение файла `NOTICE`, если он был в поставке. |
| CC-BY 3.0 / 4.0 | требуется | Указать автора, источник, лицензию и факт изменений. |
| CC-BY-SA 3.0 / 4.0 | требуется | **Заразная:** производная работа обязана идти под той же лицензией. Использовать только осознанно. |
| OFL 1.1 | требуется | Только для шрифтов. Нельзя продавать шрифт отдельно. |

## Запрещённые лицензии

| Лицензия | Почему нельзя |
| --- | --- |
| CC-BY-NC, CC-BY-NC-SA, CC-BY-NC-ND | Запрет коммерческого использования. Игра с любой монетизацией — нарушение. |
| CC-BY-ND | Запрет производных работ. Оптимизация модели конвейером (упрощение, пережатие текстур) — уже производная работа. |
| Любая «custom / EULA источника» без явного разрешения перераспространения | Условия нельзя проверить, а значит нельзя и соблюдать. |
| «Royalty free» без текста лицензии | Это маркетинговая формулировка, а не лицензия. Реальные условия неизвестны. |
| Проприетарная (включая Mixamo) | Бесплатно — не значит свободно. Условия Adobe запрещают перераспространение исходных моделей. |

---

## Одобрённые источники

Список синхронизирован с `credits.json` → `asset_sources_approved`.

| Источник | Лицензия | Условие |
| --- | --- | --- |
| [Kenney](https://kenney.nl/assets) | CC0 | Атрибуция не требуется, но приветствуется. |
| [Poly Haven](https://polyhaven.com) | CC0 | HDRI, текстуры, модели. Всё под CC0. |
| [ambientCG](https://ambientcg.com) | CC0 | PBR-материалы. |
| [Quaternius](https://quaternius.com) | CC0 | Low-poly пакеты, включая персонажей. |
| [KayKit](https://kaylousberg.itch.io) | CC0 (проверять по пакету) | Часть пакетов CC0; лицензию смотреть на странице конкретного пакета. |
| [OpenGameArt](https://opengameart.org) | разные | **Лицензию читать у каждого файла.** Там есть и CC0, и CC-BY-NC — последнее брать нельзя. |
| [Sketchfab](https://sketchfab.com/features/free-3d-models) | разные | Фильтр по CC0 безопасен. CC-BY требует атрибуции ниже. |
| [Mixamo](https://www.mixamo.com) | проприетарная | **НЕ использовать для перераспространения.** Подходит только для временной анимации на этапе прототипирования, с обязательной заменой до релиза. |

---

## Инструменты и библиотеки в составе проекта

Эти компоненты попадают в репозиторий (git-подмодуль `gdextension/godot-cpp`,
вендоренный `game/addons/gut/`, `node_modules` в конвейере) или связываются со
сборкой. Все требуют сохранения уведомления.

### Godot Engine

- **Автор:** Godot Engine contributors
- **Лицензия:** MIT
- **Источник:** <https://godotengine.org>
- **Атрибуция в игре:** обязательна (пункт «Движок» в титрах).

> Copyright (c) 2014-present Godot Engine contributors.
> Copyright (c) 2007-2014 Juan Linietsky, Ariel Manzur.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

### GUT (Godot Unit Test)

- **Автор:** Butch Wesley (bitwes)
- **Лицензия:** MIT
- **Расположение в проекте:** `game/addons/gut/` (вендоренные файлы, не подмодуль)
- **Источник:** <https://github.com/bitwes/Gut>
- **Атрибуция в игре:** обязательна (пункт «Инструменты» в титрах).

> MIT License. Copyright (c) Butch Wesley.
> Полный текст — в `game/addons/gut/LICENSE`.

### godot-cpp

- **Автор:** Godot Engine contributors
- **Лицензия:** MIT
- **Расположение в проекте:** `gdextension/godot-cpp/` (git-подмодуль, тег `godot-4.5-stable`)
- **Источник:** <https://github.com/godotengine/godot-cpp>
- **Атрибуция в игре:** обязательна. Статически связывается с расширением,
  поэтому попадает в бинарник игры.

> MIT License. Copyright (c) 2017-present Godot Engine contributors.
> Полный текст — в `gdextension/godot-cpp/LICENSE.md`.

### gdtoolkit (gdlint / gdformat / gdparse)

- **Автор:** Marcin Woźniak и контрибьюторы
- **Лицензия:** MIT
- **Источник:** <https://github.com/Scony/godot-gdscript-toolkit>
- **Атрибуция в игре:** обязательна в разделе инструментов. В саму игру не
  попадает — используется только на этапе разработки.

### glTF-Transform

- **Автор:** Don McCurdy
- **Лицензия:** MIT
- **Источник:** <https://github.com/donmccurdy/glTF-Transform>
- **Атрибуция в игре:** обязательна в разделе инструментов. Используется в
  `tools/asset-pipeline/` для оптимизации моделей; в сборку игры не входит.

### Draco

- **Автор:** Google
- **Лицензия:** Apache-2.0
- **Источник:** <https://github.com/google/draco>
- **Атрибуция в игре:** обязательна. Кодек сжатия геометрии
  `KHR_draco_mesh_compression` — при его использовании декодер попадает
  в сборку.

> Licensed under the Apache License, Version 2.0.
> Copyright 2022 The Draco Authors.

### meshoptimizer

- **Автор:** Arseny Kapoulkine
- **Лицензия:** MIT
- **Источник:** <https://github.com/zeux/meshoptimizer>
- **Атрибуция в игре:** обязательна. Используется для сжатия
  `EXT_meshopt_compression`, переупорядочивания вершин и упрощения
  геометрии.

> MIT License. Copyright (c) 2016-2024 Arseny Kapoulkine.

### sharp

- **Автор:** Lovell Fuller и контрибьюторы
- **Лицензия:** Apache-2.0
- **Источник:** <https://github.com/lovell/sharp>
- **Атрибуция в игре:** обязательна в разделе инструментов. Обрабатывает
  текстуры в конвейере; в сборку игры не входит.
- **Дополнительно:** sharp связывается с libvips (LGPL-2.1+) и может
  включать libimage, libwebp, libjpeg-turbo, zlib — их уведомления лежат в
  `tools/asset-pipeline/node_modules/sharp/`.

### mikktspace

- **Автор:** Morten S. Mikkelsen
- **Лицензия:** Zlib
- **Источник:** <https://archive.blender.org/wiki/index.php/Dev:Shading/Tangent_Space_Normal_Maps/>
- **Назначение:** расчёт тангент-пространства для normal mapping в
  `tools/asset-pipeline/scripts/optimize_models.mjs`.

> Copyright (C) 2011 by Morten S. Mikkelsen. This software is provided
> 'as-is', without any express or implied warranty.

---

## Игровые ассеты (модели, текстуры, звук, шрифты)

**На текущий момент сторонних игровых ассетов в проекте нет.**

Всё визуальное содержимое создаётся процедурно кодом:

| Что | Как сделано | Файл |
| --- | --- | --- |
| Небо в меню | процедурный шейдер `shader_type sky`, ~2 КБ вместо 4–20 МБ HDRI-панорамы | `game/shaders/menu_sky.gdshader` |
| Фон главного меню | сцена `menu_backdrop` с бюджетом ≤512 узлов / 500 000 треугольников / ≤2 теневых источника | `game/scenes/menu/menu_backdrop.tscn` |
| Арена | генерируется кодом в рантайме | `game/scripts/world/world.gd` |
| Материалы окружения | `Environment` + 4 профиля качества | `game/resources/environment/`, `game/resources/quality/` |
| Ветер | целочисленный value-noise + fBm в C++ | `gdextension/src/newwoorld_wind_field.cpp` |
| Иконка приложения | собственный SVG | `game/icon.svg` |

Это не экономия на качестве, а сознательное решение: процедурное содержимое
не имеет лицензионных ограничений, весит килобайты и масштабируется под любой
профиль качества без перекодирования ассетов.

**Каталоги под будущие ассеты уже созданы и пусты:**
`game/assets/models/`, `game/assets/textures/`, `game/assets/materials/`,
`game/assets/audio/`, `game/assets/fonts/`.

Как только в любой из них добавляется файл, этот раздел перестаёт быть пустым:
для каждого ассета требуется подраздел с автором, лицензией, источником,
фактом изменений и дословным текстом уведомления.

### Шаблон записи об игровом ассете

```markdown
### <Название ассета — должно совпадать с name в credits.json>

- **Автор:** <имя или студия>
- **Лицензия:** <CC0 / CC-BY 4.0 / MIT / …>
- **Источник:** <прямая ссылка на страницу загрузки>
- **Файл в проекте:** `game/assets/models/<путь>.glb`
- **Изменения:** <да/нет; если да — что именно: упрощение, пережатие
  текстур, переименование материалов>
- **Дата добавления:** <ГГГГ-ММ-ДД>

<Дословный текст уведомления, если лицензия требует атрибуции>
```

Для ассетов под CC-BY уведомление обязано содержать все четыре элемента:
имя автора, название работы, ссылку на источник и ссылку на текст лицензии,
плюс отметку о внесении изменений. Пропуск любого из них — нарушение
лицензии, даже если файл «бесплатный».

---

## Шрифты

Сторонних шрифтов в проекте нет: используется системный шрифт Godot.
Каталог `game/assets/fonts/` зарезервирован.

При добавлении шрифта действует дополнительное ограничение: лицензия должна
разрешать **встраивание в приложение** (embedding). Некоторые OFL-шрифты
разрешают использование только в полиграфии, и это не проверяется ничем,
кроме чтения самого текста лицензии.

---

## Звук и музыка

Сторонних звуков в проекте нет. Каталоги `game/assets/audio/sfx/` и
`game/assets/audio/music/` зарезервированы. Схема маршрутизации шин — в
`game/resources/default_bus_layout.tres`, перечень имён шин —
`GameConfig.AUDIO_BUSES`.

---

## Контакты для правообладателей

Если вы обнаружили в проекте свой материал, указанный неверно или не
указанный вовсе — напишите, он будет исправлен или удалён.

Актуальные контакты берутся из `game/data/credits.json` → `contacts` и
отображаются в игре в разделе «Контакты» (`game/scenes/menu/credits_panel.tscn`).

> **Перед релизом обязательно заменить значения-заглушки**
> `hello@example.com` и `https://example.com` на настоящие. Сейчас они
> намеренно недействительны: неработающий адрес хуже отсутствующего, потому
> что правообладатель, написавший в никуда, не получит ответа.
