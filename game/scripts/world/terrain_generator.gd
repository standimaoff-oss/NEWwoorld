class_name TerrainGenerator
extends RefCounted
## TerrainGenerator — процедурный рельеф карты 500 × 500 м.
##
## ОТВЕЧАЕТ ЗА ДВЕ ВЕЩИ:
##   1. height_at(x, z) — высота в произвольной точке мира;
##   2. build_chunk_mesh() — меш одного чанка с нужным уровнем детализации.
##
## ГЛАВНОЕ ПРАВИЛО, нарушив которое получают видимый шов на карте:
## высота вычисляется от АБСОЛЮТНЫХ мировых координат, а не от локальных
## координат внутри чанка. Если сдвинуть точку отсчёта на угол чанка, шум
## для каждого чанка начнётся заново, и соседние чанки не сойдутся по
## высоте на границе — на карте появятся ступеньки высотой в метр.
##
## ВТОРОЕ ПРАВИЛО: рельеф сглажен вокруг застройки. Дом, поставленный на
## склон, либо висит в воздухе одним углом, либо утопает другим. И то, и
## другое выглядит как ошибка, хотя геометрически всё корректно. Поэтому
## в радиусе застройки высота принудительно приводится к высоте центра
## площадки, а переход к естественному рельефу делается плавным.
##
## ТРЕТЬЕ ПРАВИЛО: генерация детерминирована. Одно зерно — один рельеф.
## Это требование ТЗ (5.2), и без него невозможны ни тест планировки, ни
## воспроизведение бага.

## Слои шума. Каждый слой — свой масштаб и вес.
##
## Почему три слоя, а не один: одиночный шум даёт либо холмы одного размера
## (выглядит как сгенерированная карта), либо мелкую рябь. Сумма трёх
## масштабов даёт крупные формы, средние склоны и мелкую неровность
## поверхности — то, что глаз читает как естественный ландшафт.
const LAYER_SCALES: Array[float] = [0.0035, 0.012, 0.045]
const LAYER_WEIGHTS: Array[float] = [0.62, 0.28, 0.10]

## Амплитуда рельефа до сглаживания, в метрах.
const BASE_AMPLITUDE: float = 14.0

## Радиус сглаживания вокруг площадки застройки, в метрах.
## Больше радиуса дома — иначе сглаживание видно как искусственную
## площадку посреди поля.
const FLATTEN_RADIUS: float = 26.0

## Ширина плавного перехода от плоской площадки к естественному рельефу.
## Без перехода граница площадки — это ступенька, видимая глазом.
const FLATTEN_FEATHER: float = 12.0

## Максимальный уклон в градусах, выше которого рельеф считается
## непроходимым. Используется расстановкой деревьев и техники: на
## склоне круче этого деревья не растут, а машина не едет.
const MAX_TRAVERSABLE_SLOPE_DEG: float = 38.0

## Шаг в метрах для численного расчёта уклона.
const SLOPE_SAMPLE_STEP: float = 0.75

## Масштаб текстурных координат: сколько метров мира приходится на один
## повтор текстуры. 4 м — размер, при котором трава/земля не выглядит
## ни растянутой, ни мельтешащей.
const UV_METERS_PER_TILE: float = 4.0

## Шум рельефа. Создаётся один раз на экземпляр генератора.
var _noise: FastNoiseLite = null

## Зерно генерации. Хранится, чтобы describe() мог его отдать для отладки.
var _seed: int = 0

## Список площадок, которые нужно держать плоскими:
## каждая запись — {"center": Vector3, "radius": float, "strength": float}.
var _flatten_zones: Array[Dictionary] = []


func _init(generation_seed: int = MapConfig.DEFAULT_SEED) -> void:
	_seed = generation_seed
	_noise = FastNoiseLite.new()
	# TYPE_SIMPLEX_SMOOTH даёт непрерывную поверхность без видимых граней,
	# которые появляются у простого симплекса на больших масштабах.
	_noise.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	_noise.seed = generation_seed
	# Фрактальность здесь выключена намеренно: сумму октав собираем сами из
	# LAYER_SCALES и LAYER_WEIGHTS. Двойное наложение фрактальности
	# (внутри шума и снаружи) даёт непредсказуемую амплитуду, из-за которой
	# рельеф то плоский, то уходит за пределы бюджета высоты.
	_noise.fractal_type = FastNoiseLite.FRACTAL_NONE
	_noise.frequency = 1.0
	# Непрерывность критична: без неё граница между периодами шума даёт
	# видимый шов поперёк карты.
	_noise.offset = Vector3.ZERO


## Регистрирует площадку, которую рельеф обязан держать плоской.
##
## Вызывается планировкой деревни и бункера. Порядок вызова не важен:
## зоны накапливаются и применяются при каждом вычислении высоты.
func add_flatten_zone(center: Vector3, radius: float, strength: float = 1.0) -> void:
	_flatten_zones.append(
		{"center": center, "radius": maxf(radius, 0.5), "strength": clampf(strength, 0.0, 1.0)}
	)


## Высота рельефа в мировой точке (x, z).
##
## Единственная точка входа для всех потребителей: генератора мешей,
## расстановки деревьев, позиционирования зданий, проверки проходимости.
## Если высоту начнут считать в нескольких местах, рельеф разъедется.
func height_at(world_x: float, world_z: float) -> float:
	var raw: float = _base_height(world_x, world_z)
	var flattened: float = _apply_flatten_zones(world_x, world_z, raw)
	return clampf(flattened, MapConfig.TERRAIN_MIN_HEIGHT, MapConfig.TERRAIN_MAX_HEIGHT)


## Естественная высота без учёта площадок застройки.
##
## Сумма октав шума. Каждая октава берётся на своём масштабе, поэтому
## один экземпляр FastNoiseLite переиспользуется — создавать шум на
## каждую октаву было бы дороже и не дало бы никакого выигрыша.
func _base_height(world_x: float, world_z: float) -> float:
	var total: float = 0.0
	for index: int in range(LAYER_SCALES.size()):
		var sample: float = _noise.get_noise_2d(
			world_x * LAYER_SCALES[index], world_z * LAYER_SCALES[index]
		)
		# get_noise_2d возвращает значения примерно в [-1; 1].
		total += sample * LAYER_WEIGHTS[index]
	# Нормируем на сумму весов, чтобы амплитуда не зависела от числа октав:
	# добавление слоя меняет форму рельефа, но не его высоту.
	var weight_sum: float = 0.0
	for weight: float in LAYER_WEIGHTS:
		weight_sum += weight
	if weight_sum <= 0.0:
		return 0.0
	# Смещение на 0.35 вверх: большая часть карты должна быть выше нуля,
	# иначе половина деревни окажется в низине, где скапливается «вода»
	# и откуда не видно окрестностей.
	return (total / weight_sum + 0.35) * BASE_AMPLITUDE


## Применяет сглаживание вокруг зарегистрированных площадок.
##
## Для каждой зоны считается коэффициент от 1 (внутри площадки — высота
## полностью равна высоте центра) до 0 (дальше зоны + перехода — естественный
## рельеф). Переход плавный, иначе граница площадки читается как ступенька.
func _apply_flatten_zones(world_x: float, world_z: float, raw_height: float) -> float:
	if _flatten_zones.is_empty():
		return raw_height
	var result: float = raw_height
	var point: Vector2 = Vector2(world_x, world_z)
	for zone: Dictionary in _flatten_zones:
		var center: Vector3 = zone["center"]
		var radius: float = zone["radius"]
		var strength: float = zone["strength"]
		var distance: float = point.distance_to(Vector2(center.x, center.z))
		var outer: float = radius + FLATTEN_FEATHER
		if distance >= outer:
			continue
		# Коэффициент сглаживания: 1 внутри radius, линейно убывает до 0
		# на границе outer.
		var factor: float = 1.0
		if distance > radius:
			factor = 1.0 - (distance - radius) / FLATTEN_FEATHER
		factor *= strength
		# Целевая высота — высота естественного рельефа В ЦЕНТРЕ площадки.
		# Берём именно её, а не ноль: площадка обязана лежать на уровне
		# окружающего поля, иначе дом окажется на холме или в яме.
		var target: float = _base_height(center.x, center.z)
		target = clampf(target, MapConfig.TERRAIN_MIN_HEIGHT, MapConfig.TERRAIN_MAX_HEIGHT)
		result = lerpf(result, target, factor)
	return result


## Уклон поверхности в градусах в мировой точке.
##
## Считается численно, по разности высот в двух ортогональных направлениях.
## Аналитической производной у суммы симплекс-шумов нет, а численная
## достаточно точна для шага 0.75 м.
func slope_at(world_x: float, world_z: float) -> float:
	var center: float = height_at(world_x, world_z)
	var along_x: float = height_at(world_x + SLOPE_SAMPLE_STEP, world_z)
	var along_z: float = height_at(world_x, world_z + SLOPE_SAMPLE_STEP)
	var gradient: Vector2 = Vector2(
		(along_x - center) / SLOPE_SAMPLE_STEP, (along_z - center) / SLOPE_SAMPLE_STEP
	)
	return rad_to_deg(atan(gradient.length()))


## Проходима ли точка для пешего движения и техники.
func is_traversable(world_x: float, world_z: float) -> bool:
	return slope_at(world_x, world_z) <= MAX_TRAVERSABLE_SLOPE_DEG


## Строит меш рельефа одного чанка.
##
## lod_level: 0 — полный шаг MapConfig.HEIGHT_STEP, каждый следующий уровень
## удваивает шаг и уменьшает число треугольников вчетверо.
##
## Вершины берутся по АБСОЛЮТНЫМ координатам, поэтому граница чанка
## совпадает с границей соседнего чанка до последней вершины.
func build_chunk_mesh(chunk_index: Vector2i, lod_level: int = 0) -> ArrayMesh:
	var step_multiplier: int = 1 << clampi(lod_level, 0, MapConfig.TERRAIN_LOD_LEVELS - 1)
	var step: float = MapConfig.HEIGHT_STEP * float(step_multiplier)
	var corner: Vector3 = MapConfig.chunk_to_corner(chunk_index)
	# Число узлов сетки вдоль стороны чанка на этом уровне детализации.
	# На LOD 0 это 13 (12 интервалов), на LOD 1 — 7, на LOD 2 — 4.
	var intervals: int = maxi(int(round(MapConfig.CHUNK_SIZE / step)), 1)
	var verts_per_side: int = intervals + 1

	var surface: SurfaceTool = SurfaceTool.new()
	surface.begin(Mesh.PRIMITIVE_TRIANGLES)

	# Первый проход: вершины и текстурные координаты.
	# Нормали НЕ задаём вручную — их посчитает generate_normals() по
	# фактической геометрии. Заданные «на глаз» нормали дают неправильное
	# освещение, которое выглядит как ошибка материала.
	for row: int in range(verts_per_side):
		for column: int in range(verts_per_side):
			var world_x: float = corner.x + float(column) * step
			var world_z: float = corner.z + float(row) * step
			var height: float = height_at(world_x, world_z)
			# Мировые текстурные координаты, а не локальные: иначе текстура
			# «поплывёт» на границе чанков, и шов станет виден.
			surface.set_uv(Vector2(world_x / UV_METERS_PER_TILE, world_z / UV_METERS_PER_TILE))
			surface.add_vertex(Vector3(world_x - corner.x, height, world_z - corner.z))

	# Индексация. Без неё каждый треугольник хранит три независимые вершины,
	# то есть втрое больше памяти и втрое больше работы для GPU. Индексация
	# также сваривает вершины на границах квадов, что необходимо для
	# корректного расчёта нормалей.
	surface.index()
	surface.generate_normals()
	surface.generate_tangents()

	return surface.commit()


## Возвращает высоты чанка плоским массивом — для отладки и тестов.
##
## Не используется при построении меша (там высоты берутся напрямую), но
## нужен тесту, который проверяет сходимость границ соседних чанков.
func sample_chunk_heights(chunk_index: Vector2i, lod_level: int = 0) -> PackedFloat32Array:
	var step_multiplier: int = 1 << clampi(lod_level, 0, MapConfig.TERRAIN_LOD_LEVELS - 1)
	var step: float = MapConfig.HEIGHT_STEP * float(step_multiplier)
	var corner: Vector3 = MapConfig.chunk_to_corner(chunk_index)
	var intervals: int = maxi(int(round(MapConfig.CHUNK_SIZE / step)), 1)
	var verts_per_side: int = intervals + 1
	var out: PackedFloat32Array = PackedFloat32Array()
	out.resize(verts_per_side * verts_per_side)
	for row: int in range(verts_per_side):
		for column: int in range(verts_per_side):
			var index: int = row * verts_per_side + column
			out[index] = height_at(corner.x + float(column) * step, corner.z + float(row) * step)
	return out


## Число зарегистрированных площадок сглаживания.
func flatten_zone_count() -> int:
	return _flatten_zones.size()


## Зерно генерации. Нужно тестам: два генератора с одним зерном обязаны
## дать идентичный рельеф.
func generation_seed() -> int:
	return _seed


## Сводка состояния генератора для отладочного оверлея.
func describe() -> Dictionary:
	return {
		"seed": _seed,
		"noise_type": "simplex_smooth",
		"octaves": LAYER_SCALES.size(),
		"base_amplitude_m": BASE_AMPLITUDE,
		"flatten_zones": _flatten_zones.size(),
		"max_slope_deg": MAX_TRAVERSABLE_SLOPE_DEG,
		"uv_meters_per_tile": UV_METERS_PER_TILE,
	}
