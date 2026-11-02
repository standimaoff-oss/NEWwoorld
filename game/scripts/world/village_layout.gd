class_name VillageLayout
extends RefCounted
## VillageLayout — детерминированная планировка деревни и окрестностей.
##
## ЧТО ЭТО ТАКОЕ. Генератор возвращает ДАННЫЕ о размещении (список
## записей-словарей), а не узлы. Разделение принципиально:
##   · данные можно проверить тестом без дерева сцены и без Godot-раннера;
##   · данные можно сохранить в сейв и восстановить разрушенное состояние;
##   · построение узлов (дорого) отделено от планировки (дёшево), поэтому
##     потоковая подгрузка может пересчитывать только второе.
##
## ДЕТЕРМИНИЗМ. Один и тот же seed даёт байт-в-байт одинаковую планировку.
## Используется RandomNumberGenerator с явным seed, а НЕ глобальный randf():
## глобальный ГСЧ разделяется всем проектом, и порядок других вызовов
## (звук, частицы, ИИ) менял бы планировку деревни. Это требование ТЗ (5.2).
##
## ЧТО ОБЯЗАТЕЛЬНО УЧТЕНО:
##   · дома не ставятся на крутые склоны (иначе висят углом или утопают);
##   · дома не пересекаются и не подходят друг к другу вплотную — при
##     разрушении одного соседний получает урон обломками, и цепная
##     реакция сносит деревню одним взрывом;
##   · дома не ставятся на дорогу;
##   · деревья не растут на дороге, на крышах и на крутых склонах;
##   · одна из построек помечена как ТОЧКА 1 (проработанный интерьер),
##     бункер — как ТОЧКА 2.

## Виды построек. Ключи записи "kind" в списке зданий.
enum BuildingKind {
	HOUSE_SMALL,
	HOUSE_LARGE,
	BARN,
	SHED,
	WELL,
	# Добавлен последним намеренно: числовые значения видов сохраняются,
	# и вставка в середину молча превратила бы старый «сарай» в «амбар».
	BUNKER,
}

## Виды растительности. Ключи записи "species" в списке деревьев.
enum Species {
	PINE,
	BIRCH,
	OAK,
	BUSH,
}

## Типы точек интереса. Используются сценой и тестами, чтобы найти
## проработанные локации, не перебирая все здания.
enum PoiKind {
	VILLAGE_HOUSE,
	BUNKER,
}

## Габары построек по видам, в метрах (x — ширина, y — высота, z — глубина).
##
## Высота этажа 3.0–3.4 м — реальный размер для сельского дома. Ниже
## человек упирается головой, выше дом выглядит нежилым.
const BUILDING_SIZES: Dictionary = {
	BuildingKind.HOUSE_SMALL: Vector3(6.0, 3.2, 5.0),
	BuildingKind.HOUSE_LARGE: Vector3(9.0, 6.4, 7.0),
	BuildingKind.BARN: Vector3(11.0, 5.0, 8.0),
	BuildingKind.SHED: Vector3(4.0, 2.6, 3.5),
	BuildingKind.WELL: Vector3(1.6, 1.1, 1.6),
	BuildingKind.BUNKER: MapConfig.BUNKER_SIZE,
}

## Число этажей по видам. Нужно интерьеру: второй этаж — это перекрытие,
## которое обязано быть разрушаемым отдельно от стен.
const BUILDING_FLOORS: Dictionary = {
	BuildingKind.HOUSE_SMALL: 1,
	BuildingKind.HOUSE_LARGE: 2,
	BuildingKind.BARN: 1,
	BuildingKind.SHED: 1,
	BuildingKind.WELL: 1,
	BuildingKind.BUNKER: 1,
}

## Вероятности видов домов. Крупный дом один на деревню: он и есть точка 1.
## Виды, участвующие в случайной расстановке, и их веса — индекс в индекс.
##
## Таблица нужна явной, потому что _pick_weighted() возвращает ИНДЕКС, а не
## вид. Брать индекс за вид напрямую нельзя: добавление члена в BuildingKind
## молча сдвигает соответствие, и «амбар» начинает строиться как «сарай» —
## без единой ошибки компиляции. Колодец и бункер сюда не входят намеренно:
## бункер ставится в фиксированную точку, колодец в расстановке не нужен.
const PLACEABLE_KINDS: Array[int] = [
	BuildingKind.HOUSE_SMALL,
	BuildingKind.HOUSE_LARGE,
	BuildingKind.BARN,
	BuildingKind.SHED,
]
const KIND_WEIGHTS: Array[float] = [0.52, 0.08, 0.16, 0.24]

## Радиус кроны и высота деревьев по видам, в метрах.
##
## Сосна выше и уже, берёза ниже и шире, дуб самый широкий. Разброс формы
## обязателен: одинаковые деревья рядами — первый признак сгенерированной
## карты, который читается как «AI slop» (ТЗ, раздел 1).
const TREE_SHAPES: Dictionary = {
	Species.PINE: {"crown_radius": 2.2, "height_min": 9.0, "height_max": 16.0},
	Species.BIRCH: {"crown_radius": 2.8, "height_min": 7.0, "height_max": 12.0},
	Species.OAK: {"crown_radius": 3.6, "height_min": 6.0, "height_max": 11.0},
	Species.BUSH: {"crown_radius": 1.2, "height_min": 1.1, "height_max": 2.2},
}

## Веса видов деревьев при расстановке.
const SPECIES_WEIGHTS: Array[float] = [0.38, 0.27, 0.20, 0.15]

## Отступ от дороги, на котором ничего не размещается, в метрах.
const ROAD_CLEARANCE: float = 5.0

## Минимальное расстояние от дома до дерева, в метрах. Дерево вплотную к
## стене при падении разрушает её мгновенно, без участия игрока.
const TREE_TO_BUILDING: float = 3.5

## Число попыток размещения одного объекта.
##
## Ограничение обязательно: при плотной застройке случайный поиск свободного
## места может не сойтись никогда, и генерация зависнет. После исчерпания
## попыток объект просто не размещается — карта останется чуть реже, но
## не зависнет.
const PLACEMENT_ATTEMPTS: int = 40

## Зерно генерации.
var _seed: int = 0

## Генератор случайных чисел. Один на планировку, с явным зерном.
var _rng: RandomNumberGenerator = null

## Генератор рельефа. Нужен, чтобы не ставить дома на склоны и чтобы
## регистрировать площадки сглаживания.
var _terrain: TerrainGenerator = null

## Итоговые списки размещений.
var _buildings: Array[Dictionary] = []
var _road_points: Array[Vector3] = []
var _trees: Array[Dictionary] = []
var _scrub: Array[Dictionary] = []
var _pois: Dictionary = {}
var _built: bool = false


func _init(terrain: TerrainGenerator, layout_seed: int = MapConfig.DEFAULT_SEED) -> void:
	_terrain = terrain
	_seed = layout_seed
	_rng = RandomNumberGenerator.new()
	_rng.seed = layout_seed


## Строит полную планировку. Идемпотентна: повторный вызов ничего не меняет.
##
## Идемпотентность важна, потому что потоковая подгрузка может обратиться к
## планировке из нескольких мест, а пересчёт с тем же зерном обязан дать тот
## же результат — иначе здания «поедут» между вызовами.
func build() -> void:
	if _built:
		return
	_built = true
	_build_road()
	_build_buildings()
	_build_bunker()
	_build_vegetation()


## Точки дороги — ломаная через деревню.
##
## Дорога строится ПЕРВОЙ, потому что от неё зависит всё остальное: дома
## отступают от дороги, деревья на ней не растут. Обратный порядок потребовал
## бы перепроверять уже размещённые объекты.
func _build_road() -> void:
	var center: Vector3 = MapConfig.VILLAGE_CENTER
	var radius: float = MapConfig.VILLAGE_RADIUS
	# Ломаная из четырёх точек с небольшим изгибом. Прямая дорога через всю
	# деревню выглядит как просека, а изгиб читается как объезд рельефа.
	var bend_x: float = _rng.randf_range(-8.0, 8.0)
	var bend_z: float = _rng.randf_range(-6.0, 6.0)
	_road_points = [
		center + Vector3(-radius * 1.6, 0.0, bend_z * 0.5),
		center + Vector3(-radius * 0.4, 0.0, bend_z),
		center + Vector3(radius * 0.5, 0.0, bend_x),
		center + Vector3(radius * 1.7, 0.0, bend_x * 0.4),
	]
	# Высота каждой точки берётся из рельефа: дорога обязана лежать на земле,
	# а не висеть над склоном или уходить под него.
	for index: int in range(_road_points.size()):
		var point: Vector3 = _road_points[index]
		_road_points[index] = Vector3(point.x, _terrain.height_at(point.x, point.z), point.z)
	# Дорога — площадка сглаживания вдоль всей своей длины. Без этого она
	# ляжет поперёк склона и будет либо врезаться в грунт, либо висеть.
	for point: Vector3 in _road_points:
		_terrain.add_flatten_zone(point, MapConfig.ROAD_HALF_WIDTH + 4.0, 0.85)


## Размещает дома вдоль дороги.
func _build_buildings() -> void:
	var placed: int = 0
	var attempts: int = 0
	while placed < MapConfig.VILLAGE_HOUSE_COUNT and attempts < PLACEMENT_ATTEMPTS * 8:
		attempts += 1
		var candidate: Dictionary = _try_place_building(placed)
		if candidate.is_empty():
			continue
		_buildings.append(candidate)
		placed += 1

	# Точка 1 — самый крупный дом деревни. Выбираем его после расстановки,
	# а не назначаем заранее: заранее назначенный дом мог бы не разместиться
	# из-за склона или пересечения, и точка 1 пропала бы.
	var poi_index: int = _find_largest_building_index()
	if poi_index >= 0:
		_buildings[poi_index]["is_poi"] = true
		_buildings[poi_index]["poi_kind"] = PoiKind.VILLAGE_HOUSE
		_pois[PoiKind.VILLAGE_HOUSE] = _buildings[poi_index]


## Одна попытка разместить здание. Возвращает пустой словарь, если место
## не подошло.
func _try_place_building(ordinal: int) -> Dictionary:
	var kind: int = _pick_kind()
	var size: Vector3 = BUILDING_SIZES[kind]
	# Крупный дом может быть только один — точка 1. Если он уже размещён,
	# повторный запрос понижается до мелкого, чтобы не плодить двухэтажные дворцы.
	if kind == BuildingKind.HOUSE_LARGE and _has_poi_building():
		kind = BuildingKind.HOUSE_SMALL
		size = BUILDING_SIZES[kind]

	var position: Vector3 = _random_point_in_village()
	position.y = _terrain.height_at(position.x, position.z)

	if not _terrain.is_traversable(position.x, position.z):
		return {}
	if _distance_to_road(position) < MapConfig.ROAD_HALF_WIDTH + ROAD_CLEARANCE:
		return {}
	if _distance_to_buildings(position, size) < MapConfig.HOUSE_MIN_SPACING:
		return {}

	var rotation_y: float = _rng.randf_range(0.0, TAU)
	# Ориентация с шагом 90° выглядит аккуратнее полностью случайной: дома в
	# настоящей деревне развёрнуты фронтом к дороге, а не как попало.
	if _rng.randf() < 0.7:
		rotation_y = _snap_to_cardinal(rotation_y)

	# Регистрируем площадку сглаживания ПОД домом. Без этого дом на склоне
	# одним углом висит в воздухе, а другим утопает в грунте.
	_terrain.add_flatten_zone(position, maxf(size.x, size.z) * 0.75 + 2.0, 1.0)
	# Пересчитываем высоту после регистрации площадки: центр дома обязан
	# стоять на уже выровненном грунте.
	position.y = _terrain.height_at(position.x, position.z)

	return {
		"id": "building_%03d" % ordinal,
		"kind": kind,
		"position": position,
		"size": size,
		"floors": BUILDING_FLOORS[kind],
		"rotation_y": rotation_y,
		"is_poi": false,
		"poi_kind": -1,
		"integrity": _integrity_for_kind(kind),
	}


## Прочность постройки по её виду.
##
## Смысл различия: деревянный сарай разваливается от очереди, кирпичный дом
## требует нескольких попаданий, а бункер — взрыва. Без этого различия
## разрушение одинаково скучное и для сарая, и для бункера.
func _integrity_for_kind(kind: int) -> float:
	match kind:
		BuildingKind.WELL:
			return MapConfig.INTEGRITY_CONCRETE
		BuildingKind.BARN, BuildingKind.SHED:
			return MapConfig.INTEGRITY_WOOD
		BuildingKind.HOUSE_SMALL:
			return MapConfig.INTEGRITY_BRICK * 0.7
		BuildingKind.HOUSE_LARGE:
			return MapConfig.INTEGRITY_BRICK
		BuildingKind.BUNKER:
			return MapConfig.INTEGRITY_REINFORCED
	return MapConfig.INTEGRITY_WOOD


## Регистрирует бункер — точку 2.
##
## Бункер размещается в фиксированной позиции MapConfig.BUNKER_CENTER, а не
## случайно: это ориентир карты, и игрок должен находить его там, где
## ожидает. Случайная позиция сделала бы бесполезной любую карту или подсказку.
func _build_bunker() -> void:
	var center: Vector3 = MapConfig.BUNKER_CENTER
	# Площадка под бункером выравнивается полностью: бетонная коробка на
	# склоне недопустима, она либо висит, либо закапывается.
	var footprint: float = maxf(MapConfig.BUNKER_SIZE.x, MapConfig.BUNKER_SIZE.z)
	_terrain.add_flatten_zone(center, footprint * 0.8, 1.0)
	center.y = _terrain.height_at(center.x, center.z) - MapConfig.BUNKER_DEPTH

	var record: Dictionary = {
		"id": "bunker",
		"kind": BuildingKind.BUNKER,
		"position": center,
		"size": MapConfig.BUNKER_SIZE,
		"floors": 1,
		"rotation_y": _snap_to_cardinal(_rng.randf_range(0.0, TAU)),
		"is_poi": true,
		"poi_kind": PoiKind.BUNKER,
		"wall_thickness": MapConfig.BUNKER_WALL_THICKNESS,
		"depth": MapConfig.BUNKER_DEPTH,
		"integrity": MapConfig.INTEGRITY_REINFORCED,
	}
	_pois[PoiKind.BUNKER] = record
	# Бункер добавляется в общий список построек. Без этого он существует
	# только как запись в _pois: buildings_in_chunk() его не возвращает,
	# строитель чанков о нём не узнаёт, и точка 2 не появляется в мире.
	_buildings.append(record)


## Распределяет деревья и кустарник по карте.
##
## Размещение идёт по ВСЕЙ карте, а не только у деревни: 500 × 500 м,
## заполненные только деревней, — это пустое поле вокруг одного пятна.
func _build_vegetation() -> void:
	_fill_vegetation(_trees, MapConfig.TREE_COUNT, false)
	_fill_vegetation(_scrub, MapConfig.SCRUB_COUNT, true)


## Заполняет один список растительности.
func _fill_vegetation(target: Array[Dictionary], desired_count: int, scrub_only: bool) -> void:
	var placed: int = 0
	var attempts: int = 0
	var attempt_limit: int = desired_count * PLACEMENT_ATTEMPTS
	while placed < desired_count and attempts < attempt_limit:
		attempts += 1
		var position: Vector3 = _random_point_on_map()
		if not _terrain.is_traversable(position.x, position.z):
			continue
		if _distance_to_road(position) < MapConfig.ROAD_HALF_WIDTH + 1.5:
			continue
		if _distance_to_buildings(position, Vector3.ONE) < TREE_TO_BUILDING:
			continue
		var species: int = _pick_species(scrub_only)
		var shape: Dictionary = TREE_SHAPES[species]
		var height: float = _rng.randf_range(shape["height_min"], shape["height_max"])
		var crown: float = float(shape["crown_radius"]) * _rng.randf_range(0.75, 1.3)
		position.y = _terrain.height_at(position.x, position.z)
		(
			target
			. append(
				{
					"id": "%s_%04d" % ["tree" if not scrub_only else "scrub", placed],
					"species": species,
					"position": position,
					"height": height,
					"crown_radius": crown,
					"trunk_radius": crown * 0.14,
					"rotation_y": _rng.randf_range(0.0, TAU),
					# Наклон ствола. Небольшой случайный наклон убирает
					# «частокол» из идеально вертикальных деревьев.
					"lean_degrees": _rng.randf_range(0.0, 4.0),
				}
			)
		)
		placed += 1


## Выбирает вид дерева по весам.
func _pick_species(scrub_only: bool) -> int:
	if scrub_only:
		# Кустарник — это всегда куст; деревья в список scrub не попадают,
		# иначе «мелкие детали» окажутся размером с дом.
		return Species.BUSH
	return _pick_weighted(SPECIES_WEIGHTS)


## Выбирает вид постройки для случайной расстановки.
func _pick_kind() -> int:
	if PLACEABLE_KINDS.is_empty():
		return BuildingKind.HOUSE_SMALL
	var index: int = _pick_weighted(KIND_WEIGHTS)
	return PLACEABLE_KINDS[clampi(index, 0, PLACEABLE_KINDS.size() - 1)]


## Выбор индекса по массиву весов.
func _pick_weighted(weights: Array[float]) -> int:
	var total: float = 0.0
	for weight: float in weights:
		total += weight
	if total <= 0.0:
		return 0
	var roll: float = _rng.randf() * total
	var accumulated: float = 0.0
	for index: int in range(weights.size()):
		accumulated += weights[index]
		if roll <= accumulated:
			return index
	return weights.size() - 1


## Случайная точка в пределах деревни.
func _random_point_in_village() -> Vector3:
	# Равномерное распределение по КРУГУ, а не по квадрату: выбор случайных
	# x и z независимо даёт квадрат со срезанными углами плотности, и дома
	# скапливаются к центру.
	var angle: float = _rng.randf() * TAU
	var distance: float = sqrt(_rng.randf()) * MapConfig.VILLAGE_RADIUS
	var offset: Vector2 = Vector2(cos(angle), sin(angle)) * distance
	return Vector3(
		MapConfig.VILLAGE_CENTER.x + offset.x, 0.0, MapConfig.VILLAGE_CENTER.z + offset.y
	)


## Случайная точка в пределах всей карты.
func _random_point_on_map() -> Vector3:
	var margin: float = 6.0
	var span: float = MapConfig.MAP_SIZE - margin * 2.0
	return Vector3(
		_rng.randf_range(-MapConfig.MAP_HALF + margin, -MapConfig.MAP_HALF + margin + span),
		0.0,
		_rng.randf_range(-MapConfig.MAP_HALF + margin, -MapConfig.MAP_HALF + margin + span)
	)


## Расстояние от точки до ближайшего сегмента дороги.
func _distance_to_road(position: Vector3) -> float:
	var best: float = INF
	var flat: Vector2 = Vector2(position.x, position.z)
	for index: int in range(_road_points.size() - 1):
		var start: Vector3 = _road_points[index]
		var end: Vector3 = _road_points[index + 1]
		var segment_start: Vector2 = Vector2(start.x, start.z)
		var segment_end: Vector2 = Vector2(end.x, end.z)
		best = minf(best, _distance_point_to_segment(flat, segment_start, segment_end))
	return best


## Расстояние от точки до отрезка — стандартная проекция с ограничением.
func _distance_point_to_segment(point: Vector2, start: Vector2, end: Vector2) -> float:
	var segment: Vector2 = end - start
	var length_squared: float = segment.length_squared()
	if length_squared <= 0.0001:
		return point.distance_to(start)
	# Параметр проекции, зажатый в [0; 1]: вне отрезка ближайшей точкой
	# является конец, а не продолжение прямой.
	var parameter: float = clampf((point - start).dot(segment) / length_squared, 0.0, 1.0)
	return point.distance_to(start + segment * parameter)


## Расстояние от точки до ближайшего здания с учётом его габаритов.
##
## Считается до ЦЕНТРА минус половина диагонали основания: точное расстояние
## до повёрнутого прямоугольника дороже, а для проверки «не слишком ли
## близко» достаточно консервативной оценки.
func _distance_to_buildings(position: Vector3, size: Vector3) -> float:
	var best: float = INF
	var flat: Vector2 = Vector2(position.x, position.z)
	var own_reach: float = sqrt(size.x * size.x + size.z * size.z) * 0.5
	for building: Dictionary in _buildings:
		var other_position: Vector3 = building["position"]
		var other_size: Vector3 = building["size"]
		var other_reach: float = (
			sqrt(other_size.x * other_size.x + other_size.z * other_size.z) * 0.5
		)
		var center_distance: float = flat.distance_to(Vector2(other_position.x, other_position.z))
		best = minf(best, center_distance - other_reach - own_reach)
	return best


## Индекс самого крупного здания — кандидата в точку 1.
func _find_largest_building_index() -> int:
	var best_index: int = -1
	var best_volume: float = -1.0
	for index: int in range(_buildings.size()):
		var building: Dictionary = _buildings[index]
		# Бункер крупнее любого дома и перетянул бы точку 1 на себя.
		if int(building["kind"]) == BuildingKind.BUNKER:
			continue
		var size: Vector3 = building["size"]
		var volume: float = size.x * size.y * size.z * float(building["floors"])
		if volume > best_volume:
			best_volume = volume
			best_index = index
	return best_index


## Есть ли уже здание, назначенное точкой 1.
func _has_poi_building() -> bool:
	for building: Dictionary in _buildings:
		# Флага is_poi недостаточно: у бункера он тоже true, но точка 1 —
		# это жилой дом. Иначе появление бункера запретило бы строить
		# крупный дом, и деревня осталась бы без точки интереса.
		if int(building.get("poi_kind", -1)) == PoiKind.VILLAGE_HOUSE:
			return true
	return false


## Приводит угол к ближайшему из четырёх направлений.
func _snap_to_cardinal(angle: float) -> float:
	var quarter: float = TAU / 4.0
	return floorf(angle / quarter + 0.5) * quarter


## ------------------------------------------------------------------------
##  Публичный доступ к данным
## ------------------------------------------------------------------------


## Все здания деревни.
func buildings() -> Array[Dictionary]:
	return _buildings


## Точки ломаной дороги в мировых координатах.
func road_points() -> Array[Vector3]:
	return _road_points


## Все деревья на карте.
func trees() -> Array[Dictionary]:
	return _trees


## Кустарник и мелкие детали.
func scrub() -> Array[Dictionary]:
	return _scrub


## Запись точки интереса по её типу. Пустой словарь, если точки нет.
func poi(poi_kind: int) -> Dictionary:
	return _pois.get(poi_kind, {})


## Все зарегистрированные точки интереса.
func pois() -> Dictionary:
	return _pois


## Здания, попадающие в указанный чанк.
##
## Используется потоковой подгрузкой: строить нужно только то, что относится
## к загружаемому чанку. Отступ на половину диагонали здания обязателен —
## здание стоит у границы чанка, но принадлежит ему, даже если его центр
## уже в соседнем.
func buildings_in_chunk(chunk_index: Vector2i) -> Array[Dictionary]:
	var corner: Vector3 = MapConfig.chunk_to_corner(chunk_index)
	var out: Array[Dictionary] = []
	for building: Dictionary in _buildings:
		var size: Vector3 = building["size"]
		var reach: float = sqrt(size.x * size.x + size.z * size.z) * 0.5
		var position: Vector3 = building["position"]
		var inside_x: bool = (
			position.x + reach >= corner.x and position.x - reach <= corner.x + MapConfig.CHUNK_SIZE
		)
		var inside_z: bool = (
			position.z + reach >= corner.z and position.z - reach <= corner.z + MapConfig.CHUNK_SIZE
		)
		if inside_x and inside_z:
			out.append(building)
	return out


## Растительность, попадающая в указанный чанк.
func vegetation_in_chunk(chunk_index: Vector2i) -> Array[Dictionary]:
	var corner: Vector3 = MapConfig.chunk_to_corner(chunk_index)
	var limit: float = MapConfig.CHUNK_SIZE
	var out: Array[Dictionary] = []
	for record: Dictionary in _trees + _scrub:
		var position: Vector3 = record["position"]
		var radius: float = float(record["crown_radius"])
		var inside_x: bool = (
			position.x + radius >= corner.x and position.x - radius <= corner.x + limit
		)
		var inside_z: bool = (
			position.z + radius >= corner.z and position.z - radius <= corner.z + limit
		)
		if inside_x and inside_z:
			out.append(record)
	return out


## Дорога проходит через чанк?
func road_touches_chunk(chunk_index: Vector2i) -> bool:
	var corner: Vector3 = MapConfig.chunk_to_corner(chunk_index)
	var margin: float = MapConfig.ROAD_HALF_WIDTH + ROAD_CLEARANCE
	for index: int in range(_road_points.size() - 1):
		var start: Vector3 = _road_points[index]
		var end: Vector3 = _road_points[index + 1]
		if _segment_touches_rect(
			Vector2(start.x, start.z),
			Vector2(end.x, end.z),
			Vector2(corner.x, corner.z),
			MapConfig.CHUNK_SIZE + margin * 2.0,
			margin
		):
			return true
	return false


## Пересекает ли отрезок прямоугольник чанка с запасом.
func _segment_touches_rect(
	start: Vector2, end: Vector2, corner: Vector2, side: float, margin: float
) -> bool:
	var minimum: Vector2 = corner - Vector2(margin, margin)
	var maximum: Vector2 = corner + Vector2(side + margin, side + margin)
	# Достаточно проверки, что хотя бы один конец или средняя точка отрезка
	# попадает в расширенный прямоугольник: сегменты дороги короткие
	# (десятки метров), поэтому пропуск длинного диагонального отрезка
	# практически невозможен, а точный тест пересечения дороже.
	var middle: Vector2 = (start + end) * 0.5
	for point: Vector2 in [start, end, middle]:
		if point.x >= minimum.x and point.x <= maximum.x:
			if point.y >= minimum.y and point.y <= maximum.y:
				return true
	return false


## Сводка планировки для отладки и тестов.
func describe() -> Dictionary:
	var kinds: Dictionary = {}
	for building: Dictionary in _buildings:
		var key: int = building["kind"]
		kinds[key] = int(kinds.get(key, 0)) + 1
	return {
		"seed": _seed,
		"buildings": _buildings.size(),
		"buildings_by_kind": kinds,
		"road_points": _road_points.size(),
		"trees": _trees.size(),
		"scrub": _scrub.size(),
		"pois": _pois.size(),
		"flatten_zones": _terrain.flatten_zone_count(),
	}
