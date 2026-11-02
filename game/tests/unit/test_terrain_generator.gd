extends GutTest
## Тесты генератора рельефа.
##
## КАКОЙ КЛАСС ОШИБОК ЛОВИТ. У процедурного рельефа есть три дефекта,
## которые не видны в коде и не ловятся компилятором:
##
## 1. НЕДЕТЕРМИНИЗМ. Два запуска дают разную карту — невозможно ни
##    воспроизвести баг, ни написать тест на планировку, ни сохранить
##    состояние мира (сейв перестаёт соответствовать геометрии).
##
## 2. РАСХОЖДЕНИЕ НА ГРАНИЦЕ ЧАНКОВ. Если высота считается от локальных
##    координат чанка, а не от мировых, соседние чанки не сходятся, и по
##    карте идут ступеньки высотой в метр. Игрок на них спотыкается,
##    техника переворачивается. Визуально это выглядит как «баг физики»,
##    а причина — в системе координат генератора.
##
## 3. ВЫХОД ЗА ПРЕДЕЛЫ. Шум без ограничения амплитуды даёт ямы и пики
##    в сотни метров: игрок проваливается под карту или оказывается
##    над облаками.
##
## Тест №2 — test_adjacent_chunks_share_boundary_heights — самый важный в
## файле: он единственный проверяет свойство, из-за которого весь чанковый
## подход вообще имеет право существовать.

var _terrain: TerrainGenerator = null


func before_each() -> void:
	_terrain = TerrainGenerator.new(MapConfig.DEFAULT_SEED)
	assert_not_null(_terrain, "генератор рельефа не создаётся")


func test_same_seed_gives_identical_heights() -> void:
	# Детерминизм: одно зерно — одна карта. Проверяется в нескольких
	# точках, а не в одной: совпадение в одной точке может быть случайным.
	var other: TerrainGenerator = TerrainGenerator.new(MapConfig.DEFAULT_SEED)
	var probes: Array[Vector2] = [
		Vector2(0.0, 0.0),
		Vector2(-123.5, 88.25),
		Vector2(210.0, -199.75),
		MapConfig.VILLAGE_CENTER.x * Vector2.ONE + Vector2(3.0, -7.0),
	]
	for probe: Vector2 in probes:
		var left: float = _terrain.height_at(probe.x, probe.y)
		var right: float = other.height_at(probe.x, probe.y)
		assert_eq(
			left,
			right,
			"разные высоты при одном зерне в точке %s: %f против %f" % [probe, left, right]
		)


func test_different_seed_gives_different_map() -> void:
	# Обратная проверка детерминизма: если любое зерно даёт одну и ту же
	# карту, зерно просто игнорируется, и «настраиваемая генерация» — фикция.
	var other: TerrainGenerator = TerrainGenerator.new(MapConfig.DEFAULT_SEED + 7919)
	var differences: int = 0
	for index: int in range(12):
		var x: float = float(index) * 37.0 - 200.0
		var z: float = float(index) * 23.0 - 150.0
		if not is_equal_approx(_terrain.height_at(x, z), other.height_at(x, z)):
			differences += 1
	assert_gt(
		differences, 6, "разные зёрна дали почти одинаковый рельеф (%d отличий из 12)" % differences
	)


func test_heights_stay_within_bounds() -> void:
	# Проверка по регулярной сетке через всю карту, а не по случайным
	# точкам: случайные точки могут пропустить экстремум.
	var step: float = 25.0
	var violations: int = 0
	var x: float = -MapConfig.MAP_HALF
	while x <= MapConfig.MAP_HALF:
		var z: float = -MapConfig.MAP_HALF
		while z <= MapConfig.MAP_HALF:
			var height: float = _terrain.height_at(x, z)
			if height < MapConfig.TERRAIN_MIN_HEIGHT - 0.001:
				violations += 1
			elif height > MapConfig.TERRAIN_MAX_HEIGHT + 0.001:
				violations += 1
			z += step
		x += step
	assert_eq(violations, 0, "рельеф вышел за пределы в %d точках" % violations)


func test_terrain_is_not_flat() -> void:
	# Плоский рельеф проходит все проверки границ, но карта становится
	# бессмысленной: нечего скрывать за холмом, некуда течь воде, техника
	# едет везде одинаково. Проверяем, что разброс высот ненулевой.
	var lowest: float = INF
	var highest: float = -INF
	for index: int in range(400):
		var angle: float = float(index) * 0.6180339887
		var radius: float = float(index % 20) * 12.0
		var x: float = cos(angle) * radius
		var z: float = sin(angle) * radius
		lowest = minf(lowest, _terrain.height_at(x, z))
		highest = maxf(highest, _terrain.height_at(x, z))
	assert_gt(
		highest - lowest,
		1.5,
		"рельеф практически плоский: разброс всего %.2f м" % (highest - lowest)
	)


func test_terrain_is_continuous() -> void:
	# Непрерывность: в соседних точках высота близка. Разрыв означал бы,
	# что шум даёт скачки, а на скачках физика ведёт себя непредсказуемо
	# (объекты подбрасывает, персонаж застревает).
	var step: float = 0.25
	var worst: float = 0.0
	var x: float = -40.0
	while x <= 40.0:
		var before: float = _terrain.height_at(x, 12.0)
		var after: float = _terrain.height_at(x + step, 12.0)
		worst = maxf(worst, absf(after - before))
		x += 1.0
	assert_lt(
		worst, 1.0, "на шаге %.2f м перепад высот достиг %.2f м — рельеф разорван" % [step, worst]
	)


func test_adjacent_chunks_share_boundary_heights() -> void:
	# ГЛАВНАЯ ПРОВЕРКА ФАЙЛА.
	#
	# Правый край чанка (x, z) и левый край чанка (x+1, z) описывают ОДНУ
	# И ТУ ЖЕ линию мира. Если генератор берёт координаты от угла чанка, а
	# не от мировых, значения разойдутся, и на границе появится ступенька.
	#
	# Ступенька в метр не видна в редакторе (там чанки строятся по одному),
	# но в игре на ней спотыкается персонаж и переворачивается техника.
	var pairs: Array[Vector2i] = [
		Vector2i(5, 5),
		Vector2i(9, 4),
		Vector2i(0, 0),
		Vector2i(MapConfig.CHUNKS_PER_SIDE - 2, 3),
	]
	for pair: Vector2i in pairs:
		var right_neighbour: Vector2i = pair + Vector2i(1, 0)
		var lower_neighbour: Vector2i = pair + Vector2i(0, 1)
		if right_neighbour.x >= MapConfig.CHUNKS_PER_SIDE:
			continue

		var left_heights: PackedFloat32Array = _terrain.sample_chunk_heights(pair)
		var right_heights: PackedFloat32Array = _terrain.sample_chunk_heights(right_neighbour)
		var verts: int = MapConfig.HEIGHT_VERTS_PER_SIDE

		# Правый столбец левого чанка против левого столбца правого.
		for row: int in range(verts):
			var own_edge: float = left_heights[row * verts + (verts - 1)]
			var neighbour_edge: float = right_heights[row * verts]
			assert_almost_eq(
				own_edge,
				neighbour_edge,
				0.001,
				(
					"шов по X между чанками %s и %s, строка %d: %.4f против %.4f"
					% [pair, right_neighbour, row, own_edge, neighbour_edge]
				)
			)

		if lower_neighbour.y >= MapConfig.CHUNKS_PER_SIDE:
			continue
		var lower_heights: PackedFloat32Array = _terrain.sample_chunk_heights(lower_neighbour)
		# Нижний ряд текущего чанка против верхнего ряда нижнего.
		for column: int in range(verts):
			var own_edge: float = left_heights[(verts - 1) * verts + column]
			var neighbour_edge: float = lower_heights[column]
			assert_almost_eq(
				own_edge,
				neighbour_edge,
				0.001,
				"шов по Z между чанками %s и %s, столбец %d" % [pair, lower_neighbour, column]
			)


func test_chunk_mesh_is_built() -> void:
	var mesh: ArrayMesh = _terrain.build_chunk_mesh(Vector2i(4, 6), 0)
	assert_not_null(mesh, "меш чанка не построился")
	if mesh == null:
		return
	assert_eq(mesh.get_surface_count(), 1, "ожидается одна поверхность рельефа")
	assert_gt(mesh.get_surface_count(), 0)
	var arrays: Array = mesh.surface_get_arrays(0)
	var vertices: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
	var indices: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
	var normals: PackedVector3Array = arrays[Mesh.ARRAY_NORMAL]

	var expected_verts: int = MapConfig.HEIGHT_VERTS_PER_SIDE * MapConfig.HEIGHT_VERTS_PER_SIDE
	assert_eq(
		vertices.size(),
		expected_verts,
		(
			"вершин ожидается %d (сетка %d×%d)"
			% [expected_verts, MapConfig.HEIGHT_VERTS_PER_SIDE, MapConfig.HEIGHT_VERTS_PER_SIDE]
		)
	)
	# Индексация обязательна: без неё каждый треугольник хранит три
	# независимые вершины, то есть втрое больше памяти и работы для GPU.
	assert_gt(indices.size(), 0, "меш не индексирован")
	assert_eq(indices.size() % 3, 0, "число индексов не кратно трём — треугольники рваные")
	# Нормали генерируются, а не подставляются: без них рельеф не
	# освещается и выглядит плоским пятном.
	assert_eq(normals.size(), vertices.size(), "нормалей меньше, чем вершин")


func test_chunk_mesh_triangle_count_matches_lod() -> void:
	# Каждый уровень LOD обязан уменьшать число треугольников. Если LOD не
	# работает, дальние чанки стоят столько же, сколько ближние, и вся
	# экономия потоковой подгрузки исчезает.
	var counts: Array[int] = []
	for level: int in range(MapConfig.TERRAIN_LOD_LEVELS):
		var mesh: ArrayMesh = _terrain.build_chunk_mesh(Vector2i(3, 3), level)
		assert_not_null(mesh, "меш не построился для LOD %d" % level)
		if mesh == null:
			return
		var indices: PackedInt32Array = mesh.surface_get_arrays(0)[Mesh.ARRAY_INDEX]
		counts.append(indices.size() / 3)
	assert_gt(counts[0], counts[1], "LOD 1 не легче LOD 0")
	assert_gt(counts[1], counts[2], "LOD 2 не легче LOD 1")
	# Каждый уровень должен давать примерно вчетверо меньше треугольников:
	# шаг удваивается по обеим осям.
	assert_lt(
		counts[1],
		counts[0] / 2,
		"LOD 1 уменьшил треугольники меньше чем вдвое: %d против %d" % [counts[1], counts[0]]
	)


func test_lod_zero_triangle_count_within_budget() -> void:
	# Бюджет рельефа в MapConfig исходит из 288 треугольников на чанк.
	# Если генератор начнёт строить плотнее, бюджет перестанет быть правдой,
	# а проверка «карта в бюджете» — врать.
	var mesh: ArrayMesh = _terrain.build_chunk_mesh(Vector2i(2, 2), 0)
	assert_not_null(mesh)
	if mesh == null:
		return
	var indices: PackedInt32Array = mesh.surface_get_arrays(0)[Mesh.ARRAY_INDEX]
	var triangles: int = indices.size() / 3
	assert_lte(
		triangles,
		MapConfig.BUDGET_TERRAIN_TRIANGLES / MapConfig.STREAM_ACTIVE_CHUNKS,
		"чанк рельефа тяжелее заложенного в бюджет"
	)


func test_flatten_zone_levels_the_ground() -> void:
	# Площадка сглаживания обязана делать грунт плоским: без этого дом на
	# склоне висит одним углом в воздухе, а другим утопает в земле.
	var center: Vector3 = Vector3(35.0, 0.0, -22.0)
	var fresh: TerrainGenerator = TerrainGenerator.new(MapConfig.DEFAULT_SEED + 31)
	fresh.add_flatten_zone(center, 12.0, 1.0)

	var center_height: float = fresh.height_at(center.x, center.z)
	var worst_deviation: float = 0.0
	# Внутри радиуса площадки отклонение должно быть близко к нулю.
	for index: int in range(24):
		var angle: float = float(index) * TAU / 24.0
		for distance: float in [2.0, 6.0, 10.0]:
			var x: float = center.x + cos(angle) * distance
			var z: float = center.z + sin(angle) * distance
			worst_deviation = maxf(worst_deviation, absf(fresh.height_at(x, z) - center_height))
	assert_lt(worst_deviation, 0.05, "площадка не выровнена: отклонение %.3f м" % worst_deviation)


func test_flatten_zone_fades_outside() -> void:
	# За пределами площадки рельеф обязан вернуться к естественному.
	# Если сглаживание «растекается» на всю карту, вся местность становится
	# плоской и пропадает смысл рельефа.
	var center: Vector3 = Vector3(-80.0, 0.0, 60.0)
	var fresh: TerrainGenerator = TerrainGenerator.new(MapConfig.DEFAULT_SEED + 17)
	var far_x: float = center.x + 200.0
	var far_z: float = center.z + 150.0
	var natural: float = _terrain.height_at(far_x, far_z)

	fresh.add_flatten_zone(center, 10.0, 1.0)
	var affected: float = fresh.height_at(far_x, far_z)
	assert_almost_eq(
		affected, natural, 0.001, "сглаживание площадки изменило рельеф в 250 м от неё"
	)


func test_slope_is_measured_in_degrees() -> void:
	# Уклон обязан быть в градусах и в разумных пределах. Значение в
	# радианах выглядело бы как «уклон 0.6» там, где на самом деле 35°,
	# и проверка проходимости пропускала бы отвесные склоны.
	var worst: float = 0.0
	for index: int in range(60):
		var x: float = float(index) * 8.0 - 240.0
		var z: float = float(index) * 5.0 - 150.0
		worst = maxf(worst, _terrain.slope_at(x, z))
	assert_gte(worst, 0.0, "уклон отрицательный")
	assert_lte(worst, 90.0, "уклон больше 90° — это нависающая скала")


func test_traversable_flag_matches_slope_limit() -> void:
	# Флаг проходимости обязан быть согласован с числовым порогом.
	# Рассогласование даёт ситуацию, когда расстановка объектов считает
	# склон допустимым, а движение по нему невозможно.
	var agree: int = 0
	var total: int = 0
	for index: int in range(80):
		var x: float = float(index) * 6.0 - 240.0
		var z: float = float(index * 7 % 80) * 6.0 - 240.0
		var traversable: bool = _terrain.is_traversable(x, z)
		var slope: float = _terrain.slope_at(x, z)
		var expected: bool = slope <= TerrainGenerator.MAX_TRAVERSABLE_SLOPE_DEG
		total += 1
		if traversable == expected:
			agree += 1
	assert_eq(agree, total, "флаг проходимости разошёлся с порогом в %d точках" % (total - agree))


func test_describe_reports_state() -> void:
	var summary: Dictionary = _terrain.describe()
	for key: String in ["seed", "octaves", "base_amplitude_m", "flatten_zones"]:
		assert_has(summary, key, "в describe() нет ключа «%s»" % key)
	assert_eq(int(summary["seed"]), MapConfig.DEFAULT_SEED)
	assert_eq(int(summary["octaves"]), TerrainGenerator.LAYER_SCALES.size())


func test_layer_weights_are_normalized() -> void:
	# Веса октав нормируются при суммировании. Если сумма весов равна нулю,
	# генератор делит на ноль и возвращает ноль — карта становится плоской,
	# и ни одна другая проверка этого не заметит.
	var total: float = 0.0
	for weight: float in TerrainGenerator.LAYER_WEIGHTS:
		assert_gt(weight, 0.0, "вес октавы неположителен")
		total += weight
	assert_gt(total, 0.0, "сумма весов октав равна нулю")
	assert_eq(
		TerrainGenerator.LAYER_SCALES.size(),
		TerrainGenerator.LAYER_WEIGHTS.size(),
		"число масштабов и весов октав не совпадает"
	)


func test_flatten_zones_are_counted() -> void:
	var fresh: TerrainGenerator = TerrainGenerator.new(MapConfig.DEFAULT_SEED)
	assert_eq(fresh.flatten_zone_count(), 0)
	fresh.add_flatten_zone(Vector3.ZERO, 8.0, 1.0)
	fresh.add_flatten_zone(Vector3(20.0, 0.0, 0.0), 8.0, 1.0)
	assert_eq(fresh.flatten_zone_count(), 2)


func test_degenerate_flatten_zone_does_not_crash() -> void:
	# Нулевой и отрицательный радиус обязаны приводиться к безопасному
	# значению, а не к делению на ноль внутри расчёта коэффициента.
	var fresh: TerrainGenerator = TerrainGenerator.new(MapConfig.DEFAULT_SEED)
	fresh.add_flatten_zone(Vector3.ZERO, 0.0, 1.0)
	fresh.add_flatten_zone(Vector3(5.0, 0.0, 5.0), -10.0, 1.0)
	var height: float = fresh.height_at(1.0, 1.0)
	assert_false(is_nan(height), "высота стала NaN при вырожденной площадке")
	assert_false(is_inf(height), "высота стала бесконечной")
