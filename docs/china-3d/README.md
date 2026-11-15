# Пекин · Гулоу / Наньлогусян — OSM 3D

**Главный файл:** [`../../China_3D.html`](../../China_3D.html) — 4,855,261 B, SHA-256 `4664967b25d5f9ed451668b9c80bc1ce6cab490ca3a315590a0e71fccfba61dc`.

Это **именно 3D-сцена**, а не 2D-карта, не top-down диорама и не «одна улица без переулков». Автономный WebGL2-документ построен в стиле и с графическим пайплайном `China_Preview.html`: PBR-текстуры ambientCG, подмножество Noto Sans SC, процедурное небо/погода/свет, дождь, день/ночь, GTAO + SSGI, орбита/пешком, мобильные панели, поиск и карточки объектов. Все данные, шрифт, текстуры и three.js встроены в один HTML: при открытии через `file://` сетевых запросов нет.

## Источник данных

- `docs/beijing-osm-3d/osm-map.json` — сырой OSM API v0.6 `map.json` для bbox `116.385, 39.93, 116.402, 39.945`; 6,807 elements.
- `docs/beijing-osm-3d/osm-source.json` — provenance: получено `2026-11-15T06:15:48.217414+00:00`, `OpenStreetMap API v0.6 / map.json`, `ODbL 1.0`.
- Атрибуция: **© OpenStreetMap contributors**, **ODbL 1.0**. Она встроена в документ, HUD, карточку объекта и диалог ограничений.
- Runtime extract: `docs/china-3d/beijing-3d.json`; генератор `tools/make_china_3d.py`; сборщик `tools/build_china_3d.mjs`; проверка `tools/verify_china_3d.cjs`.

## Что отрисовано

| Слой | OSM-основа | Количество |
|---|---|---:|
| Здания | точные контуры `building` way/relation | 552 |
| Улицы и хутуны | `highway` way, в т.ч. service/footway/pedestrian/residential | 253 |
| Межквартальные переулки | те же `highway` way по классам хутунов | 232 |
| Заборы/ворота | `barrier` way + barrier node внутри буфера | 8 (6 way + 2 node) |
| Вода | `natural=water` / multipolygon relations | 4 полигона |
| Маркеры POI | тегированные узлы OSM | 487 |
| Именованные объекты | реальные `name` / `name:en` | 691 |

Барабанная башня `w267371087` использует `height=47` прямо из OSM. У Колокольной башни `w425993664` в OSM нет `height`: `47.9 м` взято из внешнего справочника Baidu Baike [1] и явно помечено в `meta.externalHeightSources` и UI. Памятники и heritage-объекты (33) показаны как реальные OSM-контуры/точки, а не фотограмметрия и не импорт Sketchfab.

## Явные ограничения (не «додумано молча»)

В UI есть кнопка «Данные» со всеми 13 disclosure; они также хранятся в `meta.caveats`. Ключевые:

- OSM — краудсорсинговая база. Отсутствие забора, ворот или переулка в выгрузке не доказывает их отсутствия на местности.
- В сырой выгрузке 6 barrier-way и 6 barrier-node; внутри буфера отрисованы все 6 way и только 2 node. Остальные 4 barrier-node и 68 тегированных узлов находятся за кадром и disclosed.
- Ни у одного highway-way нет `width`: ширина полос выведена из класса дороги (`meta.roadWidths`).
- Только 1 объект имеет `height`, 27 имеют `building:levels`. Высота остальных зданий — консервативная оценка по типу `building` (`meta.defaultHeights`), помечена `defaultHeight=true`.
- Покрытие building-контуров неравномерное: в радиусе 150 м от центра `w4922662` (Наньлогусян) всего 1 контур, в радиусе 300 м — 3. Пустые дворовые пространства не заполнены выдуманными зданиями.
- Длинные транзитные way обрезаны по буферу +160 м; некоторые member-way озёрных relation отсутствуют в bbox. Водные поверхности плоские, без батиметрии.
- Окна, фонари, вывески, карнизы, черепичные крыши, кроны деревьев и объёмная трава — **стилистические процедурные детали**, а не объекты OSM; они отключаются отдельными слоями.

## Проверка

`docs/china-3d/verification.json` → **PASS**, 2026-11-15T07:44:52.637Z. Chromium/WebGL2 (SwiftShader), ошибок 0, внешних запросов 0, предупреждений 6 (только ReadPixels/duplicate-three notice).

- Перспективная 3D-камера, 665,361 треугольников, 91 draw calls, canvas непустой.
- Поиск по русскому алиасу «Нанлугусян», выбор `w4922662`, карточка OSM, слои, все подписи, погода, ночь, качество, мобильные шторки и режим «пешком» работают.
- GTAO + SSGI активны на high: AO parity max delta `1`, вклад SSGI `343,136` / changedSamples `26,307`, без вымывания кадра.
- Скриншоты: 11 PNG в этой папке, включая `00-ui.png`, `01-overview.png`, `03-hutongs.png`, `07-rain-night.png`, `09-mobile.png`, `10-mobile-drawer.png`.

Команды для воспроизведения:

```bash
python3 tools/make_china_3d.py
node tools/build_china_3d.mjs
node tools/verify_china_3d.cjs
```

## Что не менялось

`ShopSim.exe`, сохранения, исходная игра, старые `China_Preview.html`, `China_Map.html`, PWA/APK/EXE не пересобирались. Это отдельный standalone 3D-превью на основе реальной картографии OSM. Проверка сделана в Chromium/WebGL2, а не на физическом Android-устройстве.

[1] Baidu Baike — bell tower and drum tower — https://baike.baidu.com/en/item/bell%20tower%20and%20drum%20tower/1525576
