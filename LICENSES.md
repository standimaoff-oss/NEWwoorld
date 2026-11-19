# Лицензии сторонних материалов

| Что | Источник | Лицензия |
|---|---|---|
| Данные карты (`assets/city.txt`, `tools/osm_raw/district.osm`) | © участники OpenStreetMap, https://www.openstreetmap.org/copyright | ODbL 1.0 — обязательно указывать авторство; изменённую базу распространять на тех же условиях |
| Исходники фототекстур | Poly Haven, https://polyhaven.com | CC0 |
| Исходники фототекстур | ambientCG, https://ambientcg.com | CC0 |
| 3D-модели (`assets/models`): jacaranda_tree, island_tree_01, island_tree_02, shrub_02, street_lamp_01, metal_trash_can, modular_street_seating, painted_wooden_bench, utility_box_01, utility_box_02, covered_car, planter_box_01, trashbag | Poly Haven, https://polyhaven.com/models | CC0. Модели упрощены скриптом `tools/make_models.py` |
| 3D-модели предметов магазина (`assets/models`): steel_frame_shelves_01, steel_frame_shelves_02, steel_frame_shelves_03, worn_metal_rack, wooden_display_shelves_01, Shelf_01, wooden_bookshelf_worn, painted_wooden_shelves, CashRegister_01, metal_office_desk, painted_wooden_cabinet, painted_wooden_cabinet_02, vintage_wooden_drawer_01, painted_wooden_table, WoodenTable_01, CoffeeCart_01, Television_01, television_02, boombox, security_camera_01, wall_clock, ceiling_fan, modern_ceiling_lamp_01, painted_wooden_chair_01, plastic_monobloc_chair_01, metal_stool_01, Sofa_01, industrial_storage_cart, cardboard_box_01, plastic_crate_02, wooden_crate_02, WetFloorSign_01, korean_fire_extinguisher_01, potted_plant_04, medical_box, russian_food_cans_01, long_life_food, CheeseBox_01, bleach_bottle, multi_cleaner_bottle, plastic_bottle_gallon, spray_paint_bottles, food_apple_01 | Poly Haven, https://polyhaven.com/models | CC0. Упрощены, масштабированы и собраны в группы скриптом `tools/make_models.py items` |
| Модели машин, грузовиков и автобуса (`assets/models/v_*.ssm`, `v_*.png`, 23 вида): 1980s-sedan, 1980s-hatchback, 1990s-sedan, 1990s-hatchback, 1990s-station-wagon, 1990s-suv, 1990s-minivan, sedan, hatchback, suv, station-wagon, compact-car, pickup-truck, taxi, police-car, delivery-van, minibus, delivery-truck, dump-truck, garbage-truck, ambulance, fire-truck, city-bus | Grab3D, https://grab3d.com/models/vehicles/ | CC0 1.0 — так указано на сайте у каждой модели (без авторства и без регистрации). Скрипт `tools/make_vehicles.py` скачивает модели, упрощает их в 12–40 раз, делает три уровня детализации и раскраски |
| Набор Kenney «Car Kit» 3.1 | https://kenney.nl/assets/car-kit | CC0 1.0 (`third_party/kenney/License.txt`). Использовался в версиях 0.5.4–0.5.7; с 0.5.8 этих моделей в игре нет |
| Деревья (`assets/models/tree_a…f.ssm`, `tree_*_m.ssm`, `tree_bark*.jpg`, `tree_leaf_*.png`): геометрия BirchTree_1…5 и MapleTree_3 из набора Quaternius «Ultimate Stylized Nature» (май 2022), переработана скриптом `tools/make_trees.py`; текстура коры берёзы из того же набора. Листва и трава (`grass_tuft.png`) нарисованы скриптом | https://quaternius.com (зеркало https://github.com/agentkaerf/FreeModels) | CC0 1.0 |
| Ели (`assets/models/spruce*.ssm`, `spruce_bough*.png`) и эффекты служб (`beacon_*.ssm`, `fx_*.ssm`, `fx_*.png`) | построены в проекте (`tools/make_spruce.py`, `tools/make_fx.py`) | — | свои |
| Вывески и таблички служб, дворовый заборчик, плита ПО-2, люки и заплатки (`assets/textures/svc_atlas.png`, `fence_yard.png`, `fence_po2.jpg`, `road_decal.png`); перекраска пожарной машины (`v_fire_b.png`) | нарисованы в проекте (`tools/make_svc_tex.py`), сторонних материалов нет | — |
| Отвал снегоуборщика, оранжевый маячок, лопата, комья снега (`plow_blade.ssm`, `beacon_o.ssm`, `shovel.ssm`, `fx_snow.ssm`, `plow.png`, `fx_orange.png`, `fx_snow.png`) | построены в проекте (`tools/make_plow.py`) | — | свои |
| Модели людей и их анимация (`assets/people/men.ssk`, `women.ssk`): Casual_2, Casual_Hoodie, Suit, Worker, Punk, Farmer; Casual, Formal, Suit, Worker, Punk | Quaternius, наборы «Ultimate Modular Men» и «Ultimate Modular Women», https://quaternius.com. Файлы взяты с зеркала https://github.com/agentkaerf/FreeModels, потому что папки автора на Google Drive не отдавали файлы из-за квоты | CC0 1.0, тексты в `third_party/quaternius/`. Разобраны на части и пересобраны скриптом `tools/make_people.py` |
| Текстуры шага 5.5 (`facade_house.jpg`, `int_parquet.jpg`, `int_granite.jpg`, `int_marble.jpg`, `int_oak.jpg`, `int_terrazzo.jpg`): red_brick_03, yellow_brick, herringbone_parquet, granite_tile, marble_01, wood_floor, terrazzo_tiles | Poly Haven, https://polyhaven.com | CC0 |
| 46 предметов шага 5.5 (стеллажи «Лофт», «Сканди», «Классика» и другие, вешала, манекен, примерочная, мясная и хлебная витрины, печь, декор, одежда, выпечка; модели и их текстуры `x_*.png`) | Сделаны скриптом `tools/items_extra.py` | Собственная работа проекта |
| 25 предметов шага 5.6 (станция для шаурмы, роликовый гриль, микроволновка, тепловая витрина, коробки ингредиентов и заморозки, горячая выпечка, шаурма, хот-дог, газировка, чипсы, батончики; модели и их текстуры `x_*`, `goods_fb_*`) | Сделаны скриптом `tools/items_extra.py` | Собственная работа проекта |
| ТВ-панель на стену (`tv_wall.ssm`, `tv_wall_screen.jpg`) | Сделана скриптом `tools/make_models.py` | Собственная работа проекта |
| raylib 5.5 (`third_party/raylib`) | https://github.com/raysan5/raylib | zlib/libpng, текст в `third_party/raylib/LICENSE`. **Исходники изменены** (лицензия требует это отметить): `src/platforms/rcore_android.c` — размер кадра, очередь касаний, сохранение при сворачивании, контекст OpenGL ES 3, 24-битная глубина, экран не гаснет, завершение процесса; `src/rlgl.h` — `glDrawBuffers` вместо `glDrawBuffersEXT`. Все правки помечены словом ShopSim |
| earcut.hpp (`third_party/earcut`) | https://github.com/mapbox/earcut.hpp | ISC, текст в `third_party/earcut/LICENSE` |
| Шрифты DejaVu Sans (`assets/fonts`) | https://dejavu-fonts.github.io | Свободная лицензия DejaVu / Bitstream Vera |

Названия магазинов и организаций на вывесках взяты из OpenStreetMap и принадлежат их владельцам. Логотипы не используются: вывески нарисованы текстом. Перед публичным выпуском игры названия сетей стоит заменить на вымышленные или получить разрешение.

Надписи и этикетки на упаковках товара — часть текстур моделей Poly Haven. Перед публичным выпуском стоит просмотреть их на совпадения с настоящими марками.

## Шаг 5.32

| Что | Источник | Лицензия |
|---|---|---|
| Танк Т-34-85 (`assets/models/ber_tank.ssm`) | OpenGameArt, «T-34/85», автор Lotnik, файл `Rudy.blend`: https://opengameart.org/content/t-3485 | CC0 1.0 |
| Гаубица (`assets/models/ber_howitzer.ssm`) | OpenGameArt, «Blender models for Freeciv units» (набор Cimpletoon), файл `howitzer.blend`: https://opengameart.org/content/blender-models-for-freeciv-units | CC0 1.0 |

## Шаг 5.31

| Что | Источник | Лицензия |
|---|---|---|
| Солдат, конь, фонтан, двухэтажный автобус, фургон с едой, велосипед (`assets/models/ber_*.ssm`, `ber_props.png`) | grab3d.com: `soldier`, `horse`, `fountain`, `double-decker-bus`, `food-truck`, `bicycle`; упрощены и перекрашены скриптом `tools/make_landmarks.py` | CC0 1.0 |
| Фасады Берлина с масками окон (`berlin_fac_a…d.jpg`, `*_mask.png`), стела «BER» | `tools/make_berlin.py` | часть проекта |

## Шаг 5.30

| Что | Источник | Лицензия |
|---|---|---|
| Карта Берлина: здания, улицы, газоны, Шпрее, деревья, фонари, скамейки и остальное (`assets/berlin.txt`, исходник `tools/osm_raw/berlin.json.xz`) | OpenStreetMap, API 0.6, квартал 13.3670–13.3860° в. д., 52.5120–52.5235° с. ш. | © участники OpenStreetMap, ODbL 1.0 (https://www.openstreetmap.org/copyright) |
| Фасады, Рейхстаг, песчаник, вода, атлас флагов и вывесок (`assets/textures/berlin_*.jpg`, `berlin_atlas.png`) | нарисованы скриптом `tools/make_berlin.py`, шрифт DejaVu Sans | часть проекта |
| Рейхстаг, Бранденбургские ворота, советский мемориал, стелы, телебашня, колонна Победы | построены кодом игры (`src/berlin_lm.inc`) по общеизвестным размерам | часть проекта |
| Табло рейсов над стойками 2, 4 и 5 (`assets/textures/airport_atlas.jpg`) | `tools/make_airport.py` | часть проекта |

## Шаг 5.29

| Что | Источник | Лицензия |
|---|---|---|
| Электрокар, скутер, дверь гостиничного номера (`assets/models/isl_cart.ssm`, `isl_scooter.ssm`, `isl_door.ssm`) | сделаны для проекта скриптом `tools/make_island.py` | часть проекта |
| Новый атлас островов 2048 × 1024: окна со ставнями, балконные и арочные двери, витрины, ограждение, лифт, ворота, цифры номеров, картины, 20 вывесок (`assets/textures/island_atlas.png`) | нарисован тем же скриптом, шрифт DejaVu Sans | часть проекта |

## Шаг 5.28

| Что | Источник | Лицензия |
|---|---|---|
| Лодка, яхта, буй, щит «For sale» (`assets/models/isl_*.ssm`, `isl_models.jpg`) | сделаны для проекта скриптом `tools/make_island.py` | часть проекта |
| Вывески, окна, двери, листья пальм, зонты, маркизы, солома, дно бассейна (`assets/textures/island_atlas.png`) | нарисованы тем же скриптом, шрифт DejaVu Sans | часть проекта |
| Черепица, штукатурка, песок (`island_roof.jpg`, `island_stucco.jpg`, `island_sand.jpg`) | созданы тем же скриптом | часть проекта |
| Шум прибоя (`assets/sound/sea.ogg`) | синтезирован тем же скриптом | часть проекта |

Острова Исла-Дорада и Исла-Перла, отель, виллы и рейсы VG 205 / VG 206 выдуманы и не повторяют настоящих мест. Чужих материалов в этом шаге нет.

## Шаг 5.27

| Что | Источник | Лицензия |
|---|---|---|
| Самолёты и чемоданы (`assets/models/air_plane_*.ssm`, `air_plane_*.jpg`, `air_bag_*.ssm`, `air_bag.jpg`) | сделаны для проекта скриптом `tools/make_airport.py` | часть проекта |
| Вывески, табло, витрины, плакаты аэропорта (`assets/textures/airport_atlas.jpg`) | нарисованы тем же скриптом, шрифт DejaVu Sans | часть проекта; шрифт — лицензия DejaVu |
| Гул двигателей (`assets/sound/jet.ogg`) | синтезирован тем же скриптом | часть проекта |

Авиакомпании «Волга-Авиа», «Самарские авиалинии», «Жигули Эйр», номера рейсов и кафе «Взлёт» выдуманы. Аэропорт не повторяет настоящий аэропорт Самары (Курумоч).

## Шаг 5.26

| Что | Источник | Лицензия |
|---|---|---|
| Скамейка и уличная урна (`assets/models/bench.ssm`, `bench_wood.ssm`, `bin_street.ssm`, `bench_street.jpg`, `bench_street_dark.jpg`) | loafbrr, «Lamp Post, Bench, Trashcan», https://opengameart.org/content/lamp-post-bench-trashcan (https://loafbrr.itch.io/) | CC0 1.0; указание автора не обязательно, приведено из благодарности. Преобразовано `tools/make_bench.py` |
| Эталон «советский микрорайон сверху» (`refs/new3/soviet_district_top.jpg`) | сгенерирован нейросетью для проекта | в игру не входит |

## Шаг 5.25

Новых сторонних материалов нет: зал банка и двери строит код игры (`src/bank.inc`) из уже имеющихся текстур мрамора, гранита и дуба (Poly Haven / ambientCG, CC0), люди — прежние модели Quaternius (CC0).

## Шаг 5.24

Новых сторонних материалов нет. Фасад банка (`assets/textures/bank_facade.jpg`) целиком нарисован скриптом `tools/make_bank.py`; присланная пользователем фотография здания Банка России служила только образцом и в игру не входит. Надпись набрана шрифтом DejaVu (лицензия — в `licenses/`). Модель антикражных рамок (`assets/models/antitheft_gate.ssm`) строит `tools/items_extra.py`.

## Шаг 5.23

Новых сторонних материалов нет: заборы частного сектора строит код игры из уже имеющихся текстур дерева и профлиста.

## Шаг 5.22

Новых сторонних материалов нет. Модели кассового бокса с лентой и кассы самообслуживания (`assets/models/checkout_belt.ssm`, `self_checkout.ssm`, текстуры `x_pos_*.jpg`) построены скриптом `tools/items_extra.py`; крыльцо, сени и прочие детали частных домов строит код игры.

## Шаг 5.21

| Что | Откуда | Лицензия |
|---|---|---|
| Фотографии окон и застеклённых лоджий, плитка стены в `assets/textures/facade_panel.jpg`, `facade_panel5.jpg`, `facade_brick_red.jpg`, `facade_brick_white.jpg`, `facade_stair.jpg` (файлы набора `my16wins1…7.png`, `balkons1…4.png`, `whiteplitka.png`) | «Residential building lowpoly apartment block», Mixazzz, opengameart.org/content/residential-building-lowpoly-apartment-block; собрано в фасады `tools/make_facades.py` | CC0 1.0 |
| Стены тех же фасадов: `concrete_wall_008`, `red_brick_03`, `yellow_brick` | Poly Haven, polyhaven.com | CC0 1.0 |

Фотографии настоящих домов (серии 1-464, 1-447, самарские девятиэтажки), найденные поиском, служили только образцом для сравнения; в игру они не входят.

## Шаг 5.20

**С версии 0.5.20 модель ниже в игру не входит** (файлы `bld_*` удалены); запись оставлена для истории.

| Что | Откуда | Лицензия |
|---|---|---|
| Жилые дома `assets/models/bld_4…16.ssm`, `bld_ggb.jpg`, маска окон `bld_ggb_m.png` | «Soviet Panel Apartment House 3D», GGBotNet, opengameart.org/content/soviet-panel-apartment-house-3d; секции на другое число этажей и маска окон сделаны `tools/make_buildings.py` | CC0 1.0 |

## Шаг 5.7

| Что | Откуда | Лицензия |
|---|---|---|
| Фонарь, пожарный гидрант, светофор, конус, барьер (`assets/models/lamp_street.ssm`, `hydrant.ssm`, `tlight.ssm`, `cone.ssm`, `barrier.ssm`, `q_zombie_*.png`) | Quaternius, набор «Zombie Apocalypse Kit» (зеркало github.com/agentkaerf/FreeModels) | CC0 1.0 |
| Секции ограды и балконное ограждение (`fence_metal.ssm`, `fence_ornate.ssm`, `balcony_rail.ssm`, `q_medieval_*.png`) — лежат в ресурсах, в игре пока не расставлены | Quaternius, набор «Medieval Village MegaKit» | CC0 1.0 |
| Автобус (`bus.ssm`, `bus_open.ssm`, `bus_*.png`, `bus_floor.jpg`) | собственная модель, `tools/make_bus.py` | часть проекта |

## Шаг 5.18

Звуки `assets/sound/*.ogg` — записи Joseph Sardin с BigSoundBank.com. Сайт распространяет их под Creative Commons CC0 1.0 (общественное достояние): можно использовать без указания автора и без отчислений, в том числе в играх. Записи нарезаны, сведены в моно 24 кГц и закольцованы (`tools/make_sounds.py`).

| Запись | Откуда | Лицензия |
|---|---|---|
| № 0165 — «Footsteps on wooden floor» | bigsoundbank.com, файл `UPLOAD/ogg/0165.ogg` | CC0 1.0 |
| № 0189 — «Car start (Citroen Saxo)» | bigsoundbank.com, файл `UPLOAD/ogg/0189.ogg` | CC0 1.0 |
| № 0258 — «Car horn» | bigsoundbank.com, файл `UPLOAD/ogg/0258.ogg` | CC0 1.0 |
| № 0339 — «Coin in cup #1» | bigsoundbank.com, файл `UPLOAD/ogg/0339.ogg` | CC0 1.0 |
| № 0608 — «Crossroads ambience» | bigsoundbank.com, файл `UPLOAD/ogg/0608.ogg` | CC0 1.0 |
| № 0659 — «Wind in a tree» | bigsoundbank.com, файл `UPLOAD/ogg/0659.ogg` | CC0 1.0 |
| № 0682 — «Barking of a small dog» | bigsoundbank.com, файл `UPLOAD/ogg/0682.ogg` | CC0 1.0 |
| № 0792 — «Metal drawer» | bigsoundbank.com, файл `UPLOAD/ogg/0792.ogg` | CC0 1.0 |
| № 0886 — «Two-tone siren» | bigsoundbank.com, файл `UPLOAD/ogg/0886.ogg` | CC0 1.0 |
| № 0999 — «Countryside morning birds» | bigsoundbank.com, файл `UPLOAD/ogg/0999.ogg` | CC0 1.0 |
| № 1145 — «Iveco Daily diesel engine» | bigsoundbank.com, файл `UPLOAD/ogg/1145.ogg` | CC0 1.0 |
| № 1289 — «Rain on concrete» | bigsoundbank.com, файл `UPLOAD/ogg/1289.ogg` | CC0 1.0 |
| № 1318 — «Footsteps on concrete» | bigsoundbank.com, файл `UPLOAD/ogg/1318.ogg` | CC0 1.0 |
| № 1417 — «Supermarket checkout beep» | bigsoundbank.com, файл `UPLOAD/ogg/1417.ogg` | CC0 1.0 |
| № 1526 — «Peugeot 107 door» | bigsoundbank.com, файл `UPLOAD/ogg/1526.ogg` | CC0 1.0 |
| № 1703 — «Apartment door opening» | bigsoundbank.com, файл `UPLOAD/ogg/1703.ogg` | CC0 1.0 |
| № 1704 — «Apartment door closing» | bigsoundbank.com, файл `UPLOAD/ogg/1704.ogg` | CC0 1.0 |
| № 1711 — «Small elevator» | bigsoundbank.com, файл `UPLOAD/ogg/1711.ogg` | CC0 1.0 |
| № 2387 — «Ground-floor apartment ambience» | bigsoundbank.com, файл `UPLOAD/ogg/2387.ogg` | CC0 1.0 |
| № 2890 — «Footsteps in the snow» | bigsoundbank.com, файл `UPLOAD/ogg/2890.ogg` | CC0 1.0 |
| № 2955 — «Barking dog #3» | bigsoundbank.com, файл `UPLOAD/ogg/2955.ogg` | CC0 1.0 |
| № 3113 — «Thunder #2» | bigsoundbank.com, файл `UPLOAD/ogg/3113.ogg` | CC0 1.0 |
| № 3114 — «Thunder #3» | bigsoundbank.com, файл `UPLOAD/ogg/3114.ogg` | CC0 1.0 |

## Шаг 5.17

| Что | Откуда | Лицензия |
|---|---|---|
| Собаки `assets/models/dog_husky.sdg`, `dog_shiba.sdg` (Husky, ShibaInu) | Quaternius, «Ultimate Animated Animals», quaternius.com; конвертер `tools/make_dogs.py` | CC0 1.0 |
| `assets/music/guitar1.ogg` — «Apple Cider» | Zane Little Music, opengameart.org/content/apple-cider | CC0 1.0 |
| `assets/music/guitar2.ogg` — «A Small Fire Will Do (Calming Loop)» | Trex0n, opengameart.org/content/a-small-fire-will-do-calming-loop | CC0 1.0 |
| `assets/music/guitar3.ogg` — «Etirwer» | Kistol, opengameart.org/content/etirwer | CC0 1.0 |
| `assets/music/accordion1.ogg` — «The Accordion Sample» | Spring Spring, opengameart.org/content/the-accordion-sample | CC0 1.0 |
| `assets/music/accordion2.ogg` — «The Accordion Sample IV» | Spring Spring, opengameart.org/content/the-accordion-sample-iv | CC0 1.0 (также OGA-BY 3.0) |

Записи укорочены до 60–85 секунд, сведены в моно и закольцованы (`tools/make_music.py`). CC0 не требует указывать авторов; они названы из уважения к их работе.

## Шаг 5.16

| Что | Откуда | Лицензия |
|---|---|---|
| Звуки и музыка (сканер, касса, монеты, лай, гитара, аккордеон, голос) | синтезируются программой при запуске, `src/snd.cpp`; мелодии сочинены для игры | часть проекта |
| Шапки, шарфы, капюшоны, зонты, гитара, аккордеон, собаки, чехол для гитары | сетки строятся кодом, `src/people.cpp`, `src/life.cpp` | часть проекта |
| Машины в объявлениях и у игрока | те же модели Grab3D, что и в уличном движении | CC0 1.0 |

## Шаг 5.15

| Что | Откуда | Лицензия |
|---|---|---|
| Мебель и вещи для квартиры (`assets/models`): GothicBed_01, vintage_day_bed, sofa_02, sofa_03, ArmChair_01, GreenChair_01, modern_arm_chair_01, mid_century_lounge_chair, Rockingchair_01, Ottoman_01, GothicCabinet_01, GothicCommode_01, ClassicConsole_01, WoodenTable_03, modern_wooden_cabinet, ClassicNightstand_01, painted_wooden_nightstand, round_wooden_table_02, dining_table, wooden_table_02, modern_coffee_table_01, coffee_table_round_01, side_table_01, painted_wooden_chair_02, painted_wooden_stool, chinese_screen_panels, lantern_chandelier_01, classic_laptop, gaming_console, vintage_electric_kettle, alarm_clock_01, vintage_grandfather_clock_01, fancy_picture_frame_01, ornate_mirror_01, dartboard, ceramic_vase_01, ceramic_vase_02, ceramic_vase_03, throw_pillows_01, standing_picture_frame_01, rubber_duck_toy | Poly Haven, https://polyhaven.com | CC0 |
| Ковры, шторы, «стенка», шкаф-купе, кровати, письменный стол, стиральная машина, плоский телевизор, лампы, люстра, бра, полка, книги, две картины (`h_*.jpg`, `h_*.png` и модели) | нарисованы и построены кодом, `tools/items_home.py` | часть проекта |
| Обои `wallpaper.jpg`, атлас балконов и подъездов `yard_atlas.png` | нарисованы кодом, `tools/make_home_tex.py` | часть проекта |
