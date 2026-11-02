extends GutTest
## Тесты арифметической согласованности MapConfig.
##
## КАКОЙ КЛАСС ОШИБОК ЛОВИТ. Числа карты связаны между собой формулами:
## размер чанка × число чанков = размер карты, (2R+1)² = число активных
## чанков, шаг рельефа × число вершин = размер чанка. Правка одного числа
## без остальных не вызывает ошибки компиляции — она молча ломает карту:
## рельеф обрывается не доходя до границы, поток подгружает не ту область,
## бюджет треугольников перестаёт соответствовать реальности.
##
## Эти тесты ничего не знают о том, «красивая» ли карта. Они проверяют, что
## карта ЦЕЛОСТНА. Именно целостность ломается первой и труднее всего
## ищется, потому что симптом — «игрок падает сквозь мир на краю карты».


func test_chunk_grid_covers_exact_map_size() -> void:
	# Главный инвариант. Если произведение не совпадает с размером карты,
	# последний ряд чанков либо не дотягивается до границы (дыра в мире),
	# либо выступает за неё (невидимая геометрия, на которую тратится бюджет).
	var covered: float = MapConfig.CHUNK_SIZE * float(MapConfig.CHUNKS_PER_SIDE)
	assert_almost_eq(
		covered,
		MapConfig.MAP_SIZE,
		0.001,
		"чанки не покрывают карту ровно: %s м вместо %s м" % [covered, MapConfig.MAP_SIZE]
	)


func test_map_is_500_meters_per_requirement() -> void:
	# Требование заказчика: карта 500 × 500 метров. Число закреплено в
	# тесте намеренно — иначе его можно «оптимизировать» до 100 метров,
	# и все остальные проверки останутся зелёными.
	assert_almost_eq(MapConfig.MAP_SIZE, 500.0, 0.001)
	assert_almost_eq(MapConfig.MAP_HALF, 250.0, 0.001)
	assert_almost_eq(MapConfig.MAP_SIZE * MapConfig.MAP_SIZE, 250000.0, 1.0)


func test_chunk_count_is_square_of_side() -> void:
	assert_eq(
		MapConfig.CHUNK_COUNT,
		MapConfig.CHUNKS_PER_SIDE * MapConfig.CHUNKS_PER_SIDE,
		"общее число чанков не равно квадрату числа чанков на сторону"
	)


func test_active_chunks_formula_matches_radius() -> void:
	# (2R + 1)² — площадь квадрата со стороной 2R+1. Если кто-то заменит
	# квадрат на круг (евклидово расстояние), число активных чанков
	# изменится, а бюджет треугольников останется прежним и перестанет
	# соответствовать реальности.
	var expected: int = (2 * MapConfig.STREAM_RADIUS + 1) * (2 * MapConfig.STREAM_RADIUS + 1)
	assert_eq(MapConfig.STREAM_ACTIVE_CHUNKS, expected)
	assert_eq(MapConfig.active_chunk_capacity(), expected)


func test_active_chunks_are_minority_of_map() -> void:
	# Смысл потоковой подгрузки — держать активной МАЛУЮ часть карты.
	# Если активных чанков больше половины, подгрузка не экономит ничего,
	# а стоимость переключения чанков добавляется к полной загрузке.
	assert_lt(
		MapConfig.STREAM_ACTIVE_CHUNKS,
		MapConfig.CHUNK_COUNT / 2,
		"активная область занимает больше половины карты — поток бессмысленен"
	)


func test_terrain_triangle_budget_matches_active_chunks() -> void:
	# Бюджет обязан быть производным от числа активных чанков, а не
	# заданным независимо. Иначе при изменении радиуса подгрузки бюджет
	# останется старым и проверка начнёт врать.
	var per_chunk: int = MapConfig.BUDGET_TERRAIN_TRIANGLES / MapConfig.STREAM_ACTIVE_CHUNKS
	assert_eq(per_chunk, 288, "треугольников на чанк ожидается 288")
	assert_gt(MapConfig.BUDGET_TERRAIN_TRIANGLES, 0)


func test_height_grid_is_consistent_with_chunk() -> void:
	# Число интервалов × шаг = размер чанка. Расхождение даёт либо
	# незакрытый край чанка (щель между чанками), либо лишние вершины.
	var intervals: float = float(MapConfig.HEIGHT_VERTS_PER_SIDE - 1)
	assert_almost_eq(
		intervals * MapConfig.HEIGHT_STEP,
		MapConfig.CHUNK_SIZE,
		0.001,
		"сетка рельефа не совпадает с размером чанка"
	)


func test_height_bounds_are_sane() -> void:
	assert_lt(MapConfig.TERRAIN_MIN_HEIGHT, 0.0, "минимум рельефа должен быть ниже нуля")
	assert_gt(MapConfig.TERRAIN_MAX_HEIGHT, 0.0, "максимум рельефа должен быть выше нуля")
	assert_gt(MapConfig.TERRAIN_MAX_HEIGHT, MapConfig.TERRAIN_MIN_HEIGHT)
	# Размах рельефа не должен превышать размер чанка: иначе склон будет
	# круче 45° на всём протяжении, и техника не проедет нигде.
	var span: float = MapConfig.TERRAIN_MAX_HEIGHT - MapConfig.TERRAIN_MIN_HEIGHT
	assert_lt(span, MapConfig.CHUNK_SIZE * 1.5, "размах рельефа слишком велик")


func test_lod_levels_are_declared() -> void:
	assert_gt(MapConfig.TERRAIN_LOD_LEVELS, 1, "один уровень — это отсутствие LOD")
	assert_lte(MapConfig.TERRAIN_LOD_LEVELS, 4, "больше четырёх уровней не даёт выигрыша")


func test_chunks_per_frame_is_limited() -> void:
	# Ограничение бюджета кадра — защита от рывка при телепорте. Значение 0
	# означало бы, что чанки не создаются никогда, а большое значение
	# обессмысливает потоковую подгрузку.
	assert_between(MapConfig.CHUNKS_PER_FRAME, 1, 8)


func test_village_fits_inside_map() -> void:
	# Деревня обязана целиком лежать на карте. Выход за границу означает,
	# что часть домов попадёт в область без рельефа и провалится.
	var center: Vector3 = MapConfig.VILLAGE_CENTER
	var edge: float = MapConfig.VILLAGE_RADIUS
	assert_lt(absf(center.x) + edge, MapConfig.MAP_HALF, "деревня выходит за границу карты по X")
	assert_lt(absf(center.z) + edge, MapConfig.MAP_HALF, "деревня выходит за границу карты по Z")


func test_bunker_fits_inside_map() -> void:
	var center: Vector3 = MapConfig.BUNKER_CENTER
	var half_footprint: float = maxf(MapConfig.BUNKER_SIZE.x, MapConfig.BUNKER_SIZE.z) * 0.5
	assert_lt(absf(center.x) + half_footprint, MapConfig.MAP_HALF, "бункер вне карты по X")
	assert_lt(absf(center.z) + half_footprint, MapConfig.MAP_HALF, "бункер вне карты по Z")


func test_two_points_are_separated() -> void:
	# Требование заказчика: ДВЕ разные точки. Если они окажутся рядом,
	# это одна точка, а не две. Расстояние обязано превышать диаметр
	# деревни, иначе бункер стоит «во дворах».
	var distance: float = MapConfig.VILLAGE_CENTER.distance_to(MapConfig.BUNKER_CENTER)
	assert_gt(
		distance,
		MapConfig.VILLAGE_RADIUS * 1.5,
		"точки слишком близко: %.1f м — это одна локация, а не две" % distance
	)


func test_house_spacing_prevents_chain_destruction() -> void:
	# Дома ближе этого расстояния при разрушении одного задевают соседний
	# обломками, и один взрыв сносит всю деревню. Требование «полного
	# разрушения» не означает «мгновенного разрушения всего».
	assert_gt(MapConfig.HOUSE_MIN_SPACING, 0.0)
	assert_gt(
		MapConfig.HOUSE_MIN_SPACING,
		MapConfig.EXPLOSION_RADIUS * 0.8,
		"дома стоят плотнее радиуса взрыва — разрушение будет цепным"
	)


func test_bunker_is_stronger_than_house() -> void:
	# Смысл бункера — выдерживать то, что разрушает дом. Если прочность
	# одинакова, бункер не отличается от сарая ничем, кроме формы.
	assert_gt(MapConfig.INTEGRITY_REINFORCED, MapConfig.INTEGRITY_BRICK)
	assert_gt(MapConfig.INTEGRITY_BRICK, MapConfig.INTEGRITY_WOOD)
	assert_gt(MapConfig.INTEGRITY_WOOD, MapConfig.INTEGRITY_GLASS)


func test_explosion_energy_breaks_wood_but_not_bunker() -> void:
	# Баланс взрыва: одного взрыва должно хватать на деревянную постройку
	# и НЕ хватать на бункер. Иначе либо бункер бессмыслен, либо взрыв
	# бесполезен.
	assert_gt(MapConfig.EXPLOSION_ENERGY, MapConfig.INTEGRITY_WOOD)
	assert_lt(MapConfig.EXPLOSION_ENERGY, MapConfig.INTEGRITY_REINFORCED)


func test_destruction_budgets_are_positive() -> void:
	assert_gt(MapConfig.EXPLOSION_RADIUS, 0.0)
	# Размер ячейки дробления объявлен в GameConfig, а не в MapConfig: он
	# общий для всех уровней. Карта обязана быть с ним согласована — ячейка
	# толще стены даёт обломки размером со всю стену, и разрушение
	# превращается в исчезновение объекта.
	assert_gt(GameConfig.DESTRUCTION_CELL_SIZE, 0.0)
	assert_lt(
		GameConfig.DESTRUCTION_CELL_SIZE,
		MapConfig.BUNKER_WALL_THICKNESS,
		"ячейка дробления толще стены бункера"
	)


func test_world_to_chunk_roundtrip() -> void:
	# Координата -> индекс чанка -> угол чанка. Угол обязан лежать не
	# дальше размера чанка от исходной точки, иначе преобразование врёт
	# и поток подгружает не ту область, где находится игрок.
	var samples: Array[Vector3] = [
		Vector3(0.0, 0.0, 0.0),
		Vector3(-249.0, 0.0, -249.0),
		Vector3(249.0, 0.0, 249.0),
		MapConfig.VILLAGE_CENTER,
		MapConfig.BUNKER_CENTER,
	]
	for position: Vector3 in samples:
		var index: Vector2i = MapConfig.world_to_chunk(position)
		var corner: Vector3 = MapConfig.chunk_to_corner(index)
		assert_gte(index.x, 0, "индекс чанка отрицателен для %s" % position)
		assert_gte(index.y, 0, "индекс чанка отрицателен для %s" % position)
		assert_lt(index.x, MapConfig.CHUNKS_PER_SIDE, "индекс вне диапазона")
		assert_lt(index.y, MapConfig.CHUNKS_PER_SIDE, "индекс вне диапазона")
		# Точка обязана лежать внутри чанка: между углом и углом + размер.
		assert_gte(position.x, corner.x - 0.001, "точка левее своего чанка")
		assert_lte(position.x, corner.x + MapConfig.CHUNK_SIZE + 0.001, "точка правее своего чанка")
		assert_gte(position.z, corner.z - 0.001, "точка выше своего чанка")
		assert_lte(position.z, corner.z + MapConfig.CHUNK_SIZE + 0.001, "точка ниже своего чанка")


func test_chunk_center_is_inside_chunk() -> void:
	var index: Vector2i = Vector2i(7, 3)
	var corner: Vector3 = MapConfig.chunk_to_corner(index)
	var center: Vector3 = MapConfig.chunk_to_world(index)
	assert_almost_eq(
		center.x - corner.x,
		MapConfig.CHUNK_SIZE * 0.5,
		0.001,
		"центр чанка смещён относительно угла"
	)
	assert_almost_eq(center.y, 0.0, 0.001, "центр чанка должен быть на нулевой высоте")


func test_world_to_chunk_clamps_out_of_map() -> void:
	# Выход за пределы карты обязан давать КРАЙНИЙ чанк, а не отрицательный
	# или запредельный индекс. Отрицательный индекс привёл бы к попытке
	# построить чанк за границей мира, где нет рельефа.
	var far_out: Vector3 = Vector3(99999.0, 0.0, -99999.0)
	var index: Vector2i = MapConfig.world_to_chunk(far_out)
	assert_between(index.x, 0, MapConfig.CHUNKS_PER_SIDE - 1)
	assert_between(index.y, 0, MapConfig.CHUNKS_PER_SIDE - 1)


func test_is_inside_map_boundaries() -> void:
	assert_true(MapConfig.is_inside_map(Vector3.ZERO))
	assert_true(MapConfig.is_inside_map(Vector3(MapConfig.MAP_HALF, 0.0, MapConfig.MAP_HALF)))
	assert_false(MapConfig.is_inside_map(Vector3(MapConfig.MAP_HALF + 1.0, 0.0, 0.0)))
	assert_false(MapConfig.is_inside_map(Vector3(0.0, 0.0, -MapConfig.MAP_HALF - 1.0)))


func test_group_names_are_declared() -> void:
	# Имена групп — контракт между потоком чанков и системами, которые
	# ищут объекты карты. Пустое имя означало бы, что get_nodes_in_group
	# вернёт всё дерево.
	assert_ne(String(MapConfig.GROUP_CHUNK), "")
	assert_ne(String(MapConfig.GROUP_STREAMED), "")
	assert_ne(MapConfig.GROUP_CHUNK, MapConfig.GROUP_STREAMED)


func test_describe_reports_all_key_numbers() -> void:
	var summary: Dictionary = MapConfig.describe()
	var required: Array[String] = [
		"map_size_m",
		"area_m2",
		"chunk_size_m",
		"chunks_per_side",
		"chunk_count",
		"stream_radius",
		"active_chunks",
		"node_budget",
		"village_center",
		"bunker_center",
		"default_seed",
	]
	for key: String in required:
		assert_has(summary, key, "в describe() нет ключа «%s»" % key)


func test_node_budget_exceeds_active_chunk_need() -> void:
	# Бюджет узлов обязан быть достижим, но не бессмысленно большим.
	# Проверка «на 49 чанков приходится разумное число узлов» — иначе
	# либо бюджет нереален (всё время превышен), либо не ограничивает ничего.
	var per_chunk: int = MapConfig.BUDGET_MAP_NODES / MapConfig.STREAM_ACTIVE_CHUNKS
	assert_between(
		per_chunk, 20, 400, "узлов на чанк ожидается от 20 до 400, получено %d" % per_chunk
	)
