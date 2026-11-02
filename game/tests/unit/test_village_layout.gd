extends GutTest
## Тесты планировки деревни и карты в целом.
##
## КАКОЙ КЛАСС ОШИБОК ЛОВИТ. Расстановка объектов — это генератор
## случайных чисел с ограничениями, а такие алгоритмы ломаются молча:
## цикл выбора места может не сойтись, отсечение может стать слишком
## строгим (деревня пустеет) или слишком слабым (дома стоят внахлёст).
##
## Три конкретных дефекта, которые проверяются здесь:
##
## 1. НАЛОЖЕНИЕ ОБЪЕКТОВ. Два дома в одной точке разрушают друг друга
##    одним взрывом, а физика выталкивает их со скоростью снаряда.
##
## 2. ДОМ НА ДОРОГЕ. Проезд блокируется, и игрок не может добраться до
##    второй точки интереса. Карта 500×500 м с единственной дорогой
##    обязана держать эту дорогу свободной.
##
## 3. РАЗЪЕЗЖАЮЩАЯ ГЕНЕРАЦИЯ. Если деревья или дома ставятся через
##    глобальный randf(), каждый запуск даёт другую карту — сейв
##    перестаёт соответствовать миру, а баг невозможно воспроизвести.
##
## Отдельно проверяется наличие ОБЕИХ точек интереса: это прямое
## требование заказчика, и оно легко теряется при переработке расстановки.

var _terrain: TerrainGenerator = null
var _layout: VillageLayout = null


func before_each() -> void:
	_terrain = TerrainGenerator.new(MapConfig.DEFAULT_SEED)
	_layout = VillageLayout.new(_terrain, MapConfig.DEFAULT_SEED)
	assert_not_null(_layout, "планировка не создаётся")
	_layout.build()


## Возвращает прямоугольник здания в мировых координатах с запасом.
func _footprint(building: Dictionary) -> Rect2:
	var center: Vector3 = building["position"]
	var size: Vector3 = building["size"]
	var rotation: float = building["rotation_y"]
	var cosinus: float = absf(cos(rotation))
	var sinus: float = absf(sin(rotation))
	# Повёрнутый бокс описывается выровненным по осям прямоугольником
	# большего размера. Это приближение намеренно: точная проверка
	# пересечения повёрнутых прямоугольников требует SAT, а для контроля
	# минимального зазора достаточно осевой оболочки.
	var half_x: float = (size.x * cosinus + size.z * sinus) * 0.5
	var half_z: float = (size.x * sinus + size.z * cosinus) * 0.5
	return Rect2(Vector2(center.x - half_x, center.z - half_z), Vector2(half_x * 2.0, half_z * 2.0))


func test_layout_is_built() -> void:
	assert_true(_layout.is_built(), "build() не выставил флаг готовности")


func test_layout_has_both_required_points_of_interest() -> void:
	# Требование заказчика: две детальные точки. Прямая проверка.
	var pois: Array = _layout.pois()
	assert_eq(pois.size(), 2, "ожидается ровно две точки интереса")
	assert_not_null(_layout.poi(VillageLayout.PoiKind.VILLAGE_HOUSE), "нет точки «дом в деревне»")
	assert_not_null(_layout.poi(VillageLayout.PoiKind.BUNKER), "нет точки «бункер»")

	var house_poi: Dictionary = _layout.poi(VillageLayout.PoiKind.VILLAGE_HOUSE)
	var bunker_poi: Dictionary = _layout.poi(VillageLayout.PoiKind.BUNKER)
	assert_ne(house_poi["id"], bunker_poi["id"], "обе точки указывают на одну и ту же постройку")


func test_village_point_is_inside_the_village() -> void:
	# «Дом в деревне» обязан стоять в деревне, а не в поле за её пределом.
	var house_poi: Dictionary = _layout.poi(VillageLayout.PoiKind.VILLAGE_HOUSE)
	var center: Vector3 = house_poi["position"]
	var distance: float = (
		Vector2(center.x - MapConfig.VILLAGE_CENTER.x, center.z - MapConfig.VILLAGE_CENTER.z)
		. length()
	)
	assert_lte(
		distance,
		MapConfig.VILLAGE_RADIUS + 10.0,
		"дом-точка интереса стоит в %.1f м от центра деревни" % distance
	)


func test_village_point_is_the_largest_house() -> void:
	# Точка интереса — дом, в который игрок заходит внутрь. Он обязан быть
	# крупнейшим из жилых: интерьер маленького сарая не стоит затрат на
	# проработку, а крупный дом даёт осмысленное внутреннее пространство.
	var house_poi: Dictionary = _layout.poi(VillageLayout.PoiKind.VILLAGE_HOUSE)
	var buildings: Array[Dictionary] = _layout.buildings()
	var target: Dictionary = house_poi
	var target_volume: float = _volume(target["size"])

	assert_eq(
		target["kind"],
		VillageLayout.BuildingKind.HOUSE_LARGE,
		"точкой интереса назначен не жилой дом"
	)
	for building: Dictionary in buildings:
		if building["kind"] != VillageLayout.BuildingKind.HOUSE_LARGE:
			continue
		assert_gte(
			target_volume,
			_volume(building["size"]) - 0.001,
			"точка интереса — не крупнейший жилой дом деревни"
		)


func test_bunker_point_is_at_declared_center() -> void:
	# Позиция бункера закреплена в MapConfig. Расстановка обязана ставить
	# его именно туда: иначе телепорт по клавише отладки приведёт игрока
	# в пустое поле, а координата в конфиге станет ложью.
	var bunker_poi: Dictionary = _layout.poi(VillageLayout.PoiKind.BUNKER)
	var center: Vector3 = bunker_poi["position"]
	assert_almost_eq(center.x, MapConfig.BUNKER_CENTER.x, 0.001, "бункер смещён по X")
	assert_almost_eq(center.z, MapConfig.BUNKER_CENTER.z, 0.001, "бункер смещён по Z")
	assert_eq(bunker_poi["kind"], VillageLayout.BuildingKind.BUNKER)
	assert_eq(bunker_poi["is_poi"], true, "бункер не помечен флагом POI")
	assert_eq(
		bunker_poi["integrity"],
		MapConfig.INTEGRITY_REINFORCED,
		"бункер имеет прочность не усиленного бетона"
	)


## Возвращает объём габарита — меру размера постройки.
func _volume(size: Vector3) -> float:
	return size.x * size.y * size.z


func test_layout_is_deterministic() -> void:
	# Одна и та же карта при каждом запуске. Расхождение означало бы, что
	# где-то используется глобальный randf(), и тогда сохранение игры
	# перестаёт соответствовать геометрии мира: сейв говорит «игрок в доме
	# №3», а дом №3 в новой раскладке стоит в другом месте.
	var other_terrain: TerrainGenerator = TerrainGenerator.new(MapConfig.DEFAULT_SEED)
	var other: VillageLayout = VillageLayout.new(other_terrain, MapConfig.DEFAULT_SEED)
	other.build()

	var mine: Array[Dictionary] = _layout.buildings()
	var theirs: Array[Dictionary] = other.buildings()
	assert_eq(mine.size(), theirs.size(), "число построек разошлось при одном зерне")
	if mine.size() != theirs.size():
		return
	for index: int in range(mine.size()):
		var left: Vector3 = mine[index]["position"]
		var right: Vector3 = theirs[index]["position"]
		assert_eq(left, right, "постройка %d стоит в другом месте" % index)
		assert_eq(mine[index]["rotation_y"], theirs[index]["rotation_y"], "поворот разошёлся")

	assert_eq(_layout.trees().size(), other.trees().size(), "число деревьев разошлось")
	assert_eq(_layout.scrub().size(), other.scrub().size(), "число кустарника разошлось")
	assert_eq(_layout.road_points().size(), other.road_points().size(), "дорога разошлась")


func test_build_is_idempotent() -> void:
	# Повторный build() не должен добавлять объекты. Иначе каждый вызов
	# удваивает деревню, и карта быстро выходит за бюджет узлов.
	var buildings_before: int = _layout.buildings().size()
	var trees_before: int = _layout.trees().size()
	_layout.build()
	_layout.build()
	assert_eq(_layout.buildings().size(), buildings_before, "build() удвоил постройки")
	assert_eq(_layout.trees().size(), trees_before, "build() удвоил деревья")


func test_buildings_do_not_overlap() -> void:
	# Два дома в одной точке — физическая катастрофа: при разрушении одного
	# второй получает мгновенный импульс от вытолкнувших его обломков.
	var buildings: Array[Dictionary] = _layout.buildings()
	var boxes: Array[Rect2] = []
	for building: Dictionary in buildings:
		boxes.append(_footprint(building))

	var overlaps: int = 0
	for index: int in range(boxes.size()):
		for other: int in range(index + 1, boxes.size()):
			if boxes[index].intersects(boxes[other]):
				overlaps += 1
	assert_eq(overlaps, 0, "найдено %d пар наложенных друг на друга построек" % overlaps)


func test_buildings_respect_minimum_spacing() -> void:
	# Зазор между домами обязателен: при меньшем расстоянии обломки одного
	# разрушенного дома повреждают соседний, и деревня падает цепочкой от
	# одного взрыва. Требование «полное разрушение» не означает «всё сразу».
	var buildings: Array[Dictionary] = _layout.buildings()
	var too_close: int = 0
	for index: int in range(buildings.size()):
		var left: Vector3 = buildings[index]["position"]
		for other: int in range(index + 1, buildings.size()):
			var right: Vector3 = buildings[other]["position"]
			var distance: float = Vector2(left.x - right.x, left.z - right.z).length()
			var half_span: float = _half_span(buildings[index]) + _half_span(buildings[other])
			# Зазор измеряется между краями габаритов, а не между центрами:
			# два больших дома могут стоять дальше друг от друга центрами,
			# но ближе краями, чем два сарая.
			if distance - half_span < MapConfig.HOUSE_MIN_SPACING * 0.35:
				too_close += 1
	assert_eq(too_close, 0, "найдено %d пар домов без зазора" % too_close)


func test_no_building_sits_on_the_road() -> void:
	# Единственная дорога на карте 500×500 м связывает точки интереса.
	# Дом на дороге блокирует проезд, и вторая точка становится
	# недостижимой — карта превращается в одну локацию.
	var road: Array[Vector3] = _layout.road_points()
	assert_gt(road.size(), 1, "дорога не построена")
	var buildings: Array[Dictionary] = _layout.buildings()
	var blocked: int = 0
	for building: Dictionary in buildings:
		# Бункер стоит на дороге намеренно: к нему ведёт подъезд.
		if building["kind"] == VillageLayout.BuildingKind.BUNKER:
			continue
		var box: Rect2 = _footprint(building)
		box = Rect2(
			(
				box.position
				- Vector2(MapConfig.ROAD_HALF_WIDTH * 2.0, MapConfig.ROAD_HALF_WIDTH * 2.0)
			),
			(
				box.size
				+ Vector2(
					MapConfig.ROAD_HALF_WIDTH * 2.0 * 2.0, MapConfig.ROAD_HALF_WIDTH * 2.0 * 2.0
				)
			)
		)
		for index: int in range(road.size()):
			var point: Vector3 = road[index]
			if box.has_point(Vector2(point.x, point.z)):
				blocked += 1
	assert_eq(blocked, 0, "%d построек стоят на дороге" % blocked)


func test_all_buildings_are_inside_the_map() -> void:
	var outside: int = 0
	for building: Dictionary in _layout.buildings():
		var center: Vector3 = building["position"]
		if not MapConfig.is_inside_map(center):
			outside += 1
	assert_eq(outside, 0, "%d построек стоят за пределами карты" % outside)


func test_building_ground_matches_terrain() -> void:
	# Высота дома обязана совпадать с высотой рельефа под ним, иначе дом
	# либо висит над землёй, либо утопает в ней. Расхождение больше
	# полуметра заметно глазом и ломает вход в интерьер.
	var mismatched: int = 0
	for building: Dictionary in _layout.buildings():
		var center: Vector3 = building["position"]
		var expected: float = _terrain.height_at(center.x, center.z)
		# Бункер заглублён на BUNKER_DEPTH: его основание ниже грунта, и это
		# правильно. Сверять его с уровнем земли без поправки — ложный провал.
		if int(building["kind"]) == VillageLayout.BuildingKind.BUNKER:
			expected -= MapConfig.BUNKER_DEPTH
		if absf(center.y - expected) > 0.5:
			mismatched += 1
	assert_eq(mismatched, 0, "%d построек стоят не на своей высоте рельефа" % mismatched)


func test_buildings_stand_on_traversable_ground() -> void:
	# Дом на крутом склоне выглядит неправильно и недостижим для игрока:
	# порог оказывается выше головы. Расстановка обязана это отсекать.
	var steep: int = 0
	for building: Dictionary in _layout.buildings():
		var center: Vector3 = building["position"]
		if not _terrain.is_traversable(center.x, center.z):
			steep += 1
	assert_eq(steep, 0, "%d построек стоят на непроходимом склоне" % steep)


func test_village_has_a_reasonable_number_of_buildings() -> void:
	# Слишком мало — это не деревня, а хутор. Слишком много — бюджет узлов
	# и однообразный вид. Диапазон закреплён, чтобы «оптимизация» не
	# свелась к удалению деревни.
	var residential: int = 0
	var total: int = _layout.buildings().size()
	for building: Dictionary in _layout.buildings():
		if (
			building["kind"]
			in [VillageLayout.BuildingKind.HOUSE_SMALL, VillageLayout.BuildingKind.HOUSE_LARGE]
		):
			residential += 1
	assert_between(residential, 4, MapConfig.VILLAGE_HOUSE_COUNT, "жилых домов %d" % residential)
	assert_between(total, 6, MapConfig.VILLAGE_HOUSE_COUNT + 8, "всего построек %d" % total)


func test_village_contains_auxiliary_buildings() -> void:
	# Деревня из одних одинаковых домов выглядит декорацией. Требуются
	# хозяйственные постройки — они дают разнообразие силуэтов и целей.
	var kinds: Array[int] = []
	for building: Dictionary in _layout.buildings():
		if not kinds.has(building["kind"]):
			kinds.append(building["kind"])
	assert_gt(kinds.size(), 2, "в деревне только %d типа построек" % kinds.size())


func test_trees_are_inside_the_map() -> void:
	var outside: int = 0
	for tree: Dictionary in _layout.trees():
		var position: Vector3 = tree["position"]
		if not MapConfig.is_inside_map(position):
			outside += 1
	assert_eq(outside, 0, "%d деревьев стоят за пределами карты" % outside)


func test_trees_do_not_grow_inside_buildings() -> void:
	# Дерево внутри дома — видимый артефакт, и при падении оно толкает
	# стены изнутри, разрушая постройку без участия игрока.
	var buildings: Array[Dictionary] = _layout.buildings()
	var boxes: Array[Rect2] = []
	for building: Dictionary in buildings:
		var box: Rect2 = _footprint(building)
		boxes.append(Rect2(box.position - Vector2(1.0, 1.0), box.size + Vector2(2.0, 2.0)))

	var inside: int = 0
	for tree: Dictionary in _layout.trees():
		var point: Vector2 = Vector2(tree["position"].x, tree["position"].z)
		for box: Rect2 in boxes:
			if box.has_point(point):
				inside += 1
				break
	assert_eq(inside, 0, "%d деревьев растут внутри построек" % inside)


func test_trees_do_not_block_the_road() -> void:
	var road: Array[Vector3] = _layout.road_points()
	var blocked: int = 0
	for tree: Dictionary in _layout.trees():
		var point: Vector2 = Vector2(tree["position"].x, tree["position"].z)
		for index: int in range(road.size()):
			var current: Vector3 = road[index]
			if Vector2(current.x, current.z).distance_to(point) < MapConfig.ROAD_HALF_WIDTH * 2.0:
				blocked += 1
				break
	assert_eq(blocked, 0, "%d деревьев растут на дороге" % blocked)


func test_trees_have_positive_dimensions() -> void:
	# Нулевая высота или крона дают невидимое дерево, которое остаётся в
	# мире: игрок упирается в пустоту, а обломки падают из ничего.
	var bad: int = 0
	for tree: Dictionary in _layout.trees():
		if tree["height"] <= 0.0 or tree["crown_radius"] <= 0.0 or tree["trunk_radius"] <= 0.0:
			bad += 1
	assert_eq(bad, 0, "%d деревьев с неположительными габаритами" % bad)
	for tree: Dictionary in _layout.trees():
		assert_lt(
			tree["trunk_radius"],
			tree["crown_radius"],
			"ствол толще кроны — дерево выглядит как столб"
		)


func test_trees_are_distributed_across_the_map() -> void:
	# Лес обязан встречаться по всей карте, а не кучей в одном углу.
	# Проверка по квадрантам: пустой квадрант означает, что отсечение
	# слишком строгое и растительность пропала.
	var quadrants: Array[int] = [0, 0, 0, 0]
	for tree: Dictionary in _layout.trees():
		var position: Vector3 = tree["position"]
		var quadrant: int = (0 if position.x < 0.0 else 1) + (0 if position.z < 0.0 else 2)
		quadrants[quadrant] += 1
	for index: int in range(quadrants.size()):
		assert_gt(
			quadrants[index],
			20,
			"в квадранте %d всего %d деревьев — лес не распределён" % [index, quadrants[index]]
		)


func test_forest_density_is_reasonable() -> void:
	var trees: int = _layout.trees().size()
	assert_between(
		trees,
		MapConfig.TREE_COUNT / 4,
		MapConfig.TREE_COUNT,
		"деревьев %d при заявленных %d" % [trees, MapConfig.TREE_COUNT]
	)
	assert_between(
		_layout.scrub().size(),
		MapConfig.SCRUB_COUNT / 4,
		MapConfig.SCRUB_COUNT,
		"кустарника слишком мало или слишком много"
	)


func test_road_spans_the_map() -> void:
	# Дорога должна соединять удалённые части карты, иначе она выглядит
	# обрубком и не ведёт ни к одной точке интереса.
	var road: Array[Vector3] = _layout.road_points()
	var first: Vector3 = road[0]
	var last: Vector3 = road[road.size() - 1]
	var span: float = Vector2(first.x - last.x, first.z - last.z).length()
	assert_gt(span, 150.0, "дорога короче 150 м — это проезд между дворами")


func test_road_passes_near_bunker() -> void:
	# К бункеру обязан вести подъезд. Дорога, обрывающаяся в поле, оставляет
	# вторую точку интереса без логичного способа добраться до неё.
	var road: Array[Vector3] = _layout.road_points()
	var bunker: Vector3 = MapConfig.BUNKER_CENTER
	var closest: float = INF
	for point: Vector3 in road:
		closest = minf(closest, Vector2(point.x - bunker.x, point.z - bunker.z).length())
	assert_lt(closest, 40.0, "дорога не подходит к бункеру: %.1f м" % closest)


func test_chunk_queries_partition_the_map() -> void:
	# Каждая постройка обязана попадать ровно в те чанки, где она реально
	# находится. Пропуск означает, что дом не построится, когда игрок
	# подойдёт; дубль означает два дома в одной точке.
	var buildings: Array[Dictionary] = _layout.buildings()
	var seen: Dictionary = {}
	for index: int in range(MapConfig.CHUNKS_PER_SIDE):
		for other: int in range(MapConfig.CHUNKS_PER_SIDE):
			var chunk: Vector2i = Vector2i(index, other)
			for entry: Dictionary in _layout.buildings_in_chunk(chunk):
				var key: String = entry["id"]
				if not seen.has(key):
					seen[key] = 0
				seen[key] += 1

	assert_eq(seen.size(), buildings.size(), "не все постройки распределены по чанкам")
	for building: Dictionary in buildings:
		var identifier: String = building["id"]
		assert_has(seen, identifier, "постройка «%s» не попала ни в один чанк" % identifier)
		if seen.has(identifier):
			# Ровно один чанк: габарит любой постройки меньше чанка, поэтому
			# пересечение двух чанков означало бы, что дом построится дважды.
			assert_eq(
				seen[identifier],
				1,
				"постройка «%s» назначена %d чанкам" % [identifier, seen[identifier]]
			)


func test_vegetation_queries_cover_all_trees() -> void:
	var expected: int = _layout.trees().size() + _layout.scrub().size()
	var collected: int = 0
	for index: int in range(MapConfig.CHUNKS_PER_SIDE):
		for other: int in range(MapConfig.CHUNKS_PER_SIDE):
			var chunk: Vector2i = Vector2i(index, other)
			for entry: Dictionary in _layout.vegetation_in_chunk(chunk):
				collected += 1
	assert_eq(
		collected,
		expected,
		"по чанкам распределено %d объектов растительности из %d" % [collected, expected]
	)


func test_road_touch_query_finds_road_chunks() -> void:
	var touched: int = 0
	for index: int in range(MapConfig.CHUNKS_PER_SIDE):
		for other: int in range(MapConfig.CHUNKS_PER_SIDE):
			if _layout.road_touches_chunk(Vector2i(index, other)):
				touched += 1
	assert_gt(touched, 0, "дорога не отмечена ни в одном чанке")
	assert_lt(
		touched, MapConfig.CHUNK_COUNT, "дорога отмечена во всех чанках — запрос не различает их"
	)


func test_buildings_near_pois_are_flagged() -> void:
	# Точки интереса обязана быть ровно две, и обе помечены. Флаг — это
	# способ для строителя чанков понять, что постройку нужно прорабатывать
	# детально (интерьер, разрушаемые окна), а не рисовать болванкой.
	var flagged: int = 0
	for building: Dictionary in _layout.buildings():
		if building["is_poi"]:
			flagged += 1
			assert_has(building, "poi_kind", "у POI нет вида точки интереса")
	assert_eq(flagged, 2, "помечено %d точек интереса вместо двух" % flagged)


func test_bunker_is_built_as_part_of_the_map() -> void:
	# РЕГРЕССИОННЫЙ ТЕСТ. Бункер создавался записью в _pois и не добавлялся
	# в общий список построек. Формально обе точки интереса «существовали»,
	# но buildings_in_chunk() бункер не возвращала, строитель чанков о нём
	# не узнавал, и точка 2 не появлялась в мире. Симптом — телепорт по
	# клавише отладки приводил игрока в пустое поле.
	#
	# Проверка идёт не через buildings(), а через ЧАНК: именно так бункер
	# попадает в игру, и именно на этом шаге он раньше терялся.
	var bunker_poi: Dictionary = _layout.poi(VillageLayout.PoiKind.BUNKER)
	var position: Vector3 = bunker_poi["position"]
	var chunk: Vector2i = MapConfig.world_to_chunk(position)
	var found: bool = false
	for entry: Dictionary in _layout.buildings_in_chunk(chunk):
		if entry["id"] == bunker_poi["id"]:
			found = true
	assert_true(found, "бункер не попадает в чанк %s и не будет построен" % chunk)

	var ids: Array[String] = []
	for building: Dictionary in _layout.buildings():
		ids.append(building["id"])
	assert_has(ids, bunker_poi["id"], "бункера нет в общем списке построек")


func test_bunker_kind_does_not_collide_with_a_house_kind() -> void:
	# Бункер записывался как "kind": PoiKind.BUNKER. Численно PoiKind.BUNKER
	# равен 1, а BuildingKind.HOUSE_LARGE тоже 1: строитель чанков построил
	# бы на месте бункера двухэтажный дом с двускатной крышей. Разные
	# перечисления обязаны не пересекаться в поле "kind".
	var bunker_poi: Dictionary = _layout.poi(VillageLayout.PoiKind.BUNKER)
	var kind: int = bunker_poi["kind"]
	assert_eq(kind, VillageLayout.BuildingKind.BUNKER, "бункер помечен чужим видом")
	assert_ne(kind, VillageLayout.BuildingKind.HOUSE_LARGE, "вид бункера совпал с крупным домом")
	assert_ne(kind, VillageLayout.BuildingKind.HOUSE_SMALL, "вид бункера совпал с малым домом")


func test_placeable_kinds_and_weights_stay_aligned() -> void:
	# Веса сопоставляются видам ПО ИНДЕКСУ. Если массивы разъедутся, «амбар»
	# начнёт строиться как «сарай» — без единой ошибки компиляции.
	assert_eq(
		VillageLayout.PLACEABLE_KINDS.size(),
		VillageLayout.KIND_WEIGHTS.size(),
		"число размещаемых видов и весов разошлось"
	)
	for kind: int in VillageLayout.PLACEABLE_KINDS:
		assert_ne(
			kind,
			VillageLayout.BuildingKind.BUNKER,
			"бункер не должен выбираться случайно — у него фиксированная позиция"
		)
		assert_has(VillageLayout.BUILDING_SIZES, kind, "у вида %d нет габарита" % kind)
		assert_has(VillageLayout.BUILDING_FLOORS, kind, "у вида %d нет этажности" % kind)


func test_every_building_kind_has_size_and_floors() -> void:
	# Таблицы габаритов и этажности обязаны покрывать ВСЕ члены перечисления,
	# включая добавленные позже. Пропуск даёт ошибку обращения к словарю уже
	# в игре, в момент подхода игрока к нужному чанку.
	var sizes: Dictionary = VillageLayout.BUILDING_SIZES
	var floors: Dictionary = VillageLayout.BUILDING_FLOORS
	var kinds: Array[int] = [
		VillageLayout.BuildingKind.HOUSE_SMALL,
		VillageLayout.BuildingKind.HOUSE_LARGE,
		VillageLayout.BuildingKind.BARN,
		VillageLayout.BuildingKind.SHED,
		VillageLayout.BuildingKind.WELL,
		VillageLayout.BuildingKind.BUNKER,
	]
	for kind: int in kinds:
		assert_has(sizes, kind, "в BUILDING_SIZES нет вида %d" % kind)
		assert_has(floors, kind, "в BUILDING_FLOORS нет вида %d" % kind)
		assert_gt(floors[kind], 0, "этажность неположительна у вида %d" % kind)


func test_describe_reports_layout_summary() -> void:
	var summary: Dictionary = _layout.describe()
	for key: String in ["seed", "buildings", "trees", "scrub", "road_points", "pois"]:
		assert_has(summary, key, "в describe() нет ключа «%s»" % key)
	assert_eq(int(summary["pois"]), 2)


## Половина наибольшего габарита постройки — для расчёта зазора между краями.
func _half_span(building: Dictionary) -> float:
	var size: Vector3 = building["size"]
	var rotation: float = building["rotation_y"]
	var cosinus: float = absf(cos(rotation))
	var sinus: float = absf(sin(rotation))
	return maxf(size.x * cosinus + size.z * sinus, size.x * sinus + size.z * cosinus) * 0.5
