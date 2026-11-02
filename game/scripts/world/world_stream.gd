class_name WorldStream
extends Node3D
## WorldStream — потоковая подгрузка чанков карты вокруг игрока.
##
## ЗАЧЕМ. Карта 500 × 500 м — это 400 чанков по 25 м. Построить все сразу
## означает сотни тысяч треугольников рельефа, ~1500 деревьев и ~14 зданий
## в дереве сцены одновременно: проект не запустится на слабой машине и
## будет тратить память на то, что игрок никогда не увидит. Поток держит
## активными 49 чанков (12 % карты) и перестраивает набор по мере движения.
##
## ЧТО ДЕЛАЕТ ЭТОТ УЗЕЛ И ЧЕГО НЕ ДЕЛАЕТ.
## Здесь — ПОЛИТИКА: какие чанки нужны, когда их создавать, когда освобождать,
## какой уровень детализации применить. Геометрию строит ChunkBuilder.
## Разделение нужно потому, что политику можно менять (радиус, бюджет кадра)
## без риска сломать построение рельефа, и наоборот.
##
## ТРИ ПРАВИЛА, каждое из которых закрывает конкретную поломку:
##
## 1. НЕ БОЛЬШЕ MapConfig.CHUNKS_PER_FRAME чанков за кадр.
##    При телепорте или быстрой езде в очередь попадает 20–30 чанков сразу.
##    Создать их все в одном кадре — значит получить рывок на сотни
##    миллисекунд, то есть ровно ту просадку, которую поток призван убрать.
##
## 2. Чанк освобождается с ЗАПАСОМ (гистерезис).
##    Если выгружать ровно на границе радиуса, игрок, стоящий на границе,
##    вызывает бесконечный цикл «создать — удалить — создать». Гистерезис в
##    один чанк устраняет дрожание.
##
## 3. Перестроение чанка при смене LOD — только если уровень ДЕЙСТВИТЕЛЬНО
##    изменился. Проверка по расстоянию каждый кадр пересоздавала бы меши
##    непрерывно, что дороже, чем отсутствие LOD вообще.

## Сигнал об изменении набора активных чанков. Нужен системам, которые
## пересчитывают своё содержимое по видимой области (звук, навигация, ИИ).
signal active_chunks_changed(active_count: int, created: int, released: int)

## Сигнал о завершении первичной загрузки. По нему экран загрузки знает,
## когда можно показать игру: до этого момента под ногами нет рельефа.
signal initial_load_finished

## Гистерезис выгрузки в чанках.
##
## Выгрузка происходит на расстоянии radius + HYSTERESIS_CHUNKS. Без запаса
## игрок на границе радиуса вызывает бесконечный цикл «создать — удалить —
## создать»: визуально это постоянные рывки, хотя игрок стоит на месте.
const HYSTERESIS_CHUNKS: int = 1

## Узел, вокруг которого строится активная область. Обычно игрок или камера.
##
## Задан как Node3D, а не как конкретный класс игрока: поток не должен знать,
## кого он отслеживает, иначе его нельзя переиспользовать для камеры
## наблюдателя или транспорта.
@export var focus_node: Node3D = null

## Радиус подгрузки в чанках. По умолчанию из MapConfig, но переопределяется
## в инспекторе: на слабой машине его уменьшают, не меняя код.
@export var stream_radius: int = MapConfig.STREAM_RADIUS

## Чанков, создаваемых за один кадр.
@export var chunks_per_frame: int = MapConfig.CHUNKS_PER_FRAME

## Включён ли поток. Выключается на время загрузки уровня, чтобы не
## соперничать с ней за время кадра.
@export var streaming_enabled: bool = true

## Зерно генерации карты.
@export var map_seed: int = MapConfig.DEFAULT_SEED

## Генератор рельефа. Создаётся в _ready, доступен всем потребителям:
## расстановке объектов, проверке проходимости, позиционированию игрока.
var _terrain: TerrainGenerator = null

## Планировка деревни и окрестностей.
var _layout: VillageLayout = null

## Построитель чанков. Один на весь поток — он держит кэш материалов и мешей,
## и создание нового построителя на каждый чанк обнулило бы кэш.
var _builder: ChunkBuilder = null

## Активные чанки: индекс -> узел.
var _active: Dictionary = {}

## Уровень детализации каждого активного чанка: индекс -> int.
## Хранится отдельно, чтобы сравнивать с желаемым и не перестраивать зря.
var _lod_levels: Dictionary = {}

## Очередь чанков на создание.
var _queue: Array[Vector2i] = []

## Индекс чанка, вокруг которого была построена область на прошлом кадре.
## Используется, чтобы не пересчитывать желаемый набор каждый кадр.
var _last_focus_chunk: Vector2i = Vector2i(-9999, -9999)

## Завершена ли первичная загрузка.
var _initial_loaded: bool = false

## Счётчики для отладки и тестов.
var _created_total: int = 0
var _released_total: int = 0
var _rebuilt_total: int = 0


func _ready() -> void:
	_terrain = TerrainGenerator.new(map_seed)
	_layout = VillageLayout.new(_terrain, map_seed)
	# Планировка обязана быть построена ДО первого чанка: она регистрирует в
	# генераторе площадки сглаживания под домами и дорогой. Если построить
	# чанк раньше, рельеф под деревней окажется холмистым, и дома будут
	# висеть углами в воздухе.
	_layout.build()
	_builder = ChunkBuilder.new(_terrain, _layout)


func _process(_delta: float) -> void:
	if not streaming_enabled:
		return
	_update_stream()


## ------------------------------------------------------------------------
##  Политика подгрузки
## ------------------------------------------------------------------------


## Основной шаг: пересчитать желаемый набор, создать недостающее, выгрузить
## лишнее.
func _update_stream() -> void:
	var focus_chunk: Vector2i = _current_focus_chunk()
	# Полный пересчёт нужен только когда игрок перешёл в другой чанк.
	# Внутри одного чанка (25 м) набор активных чанков не меняется, поэтому
	# пересчёт каждый кадр — это лишняя работа в 60 раз чаще, чем нужно.
	var moved: bool = focus_chunk != _last_focus_chunk
	if moved:
		_last_focus_chunk = focus_chunk
		_rebuild_queue(focus_chunk)

	var created: int = _create_pending()
	var released: int = _release_distant(focus_chunk)
	var rebuilt: int = _refresh_lod(focus_chunk)

	if created > 0 or released > 0:
		active_chunks_changed.emit(_active.size(), created, released)

	if not _initial_loaded and _queue.is_empty() and not _active.is_empty():
		_initial_loaded = true
		initial_load_finished.emit()


## Индекс чанка, в котором находится точка наблюдения.
func _current_focus_chunk() -> Vector2i:
	var position: Vector3 = Vector3.ZERO
	if focus_node != null and is_instance_valid(focus_node):
		position = focus_node.global_position
	elif get_viewport() != null:
		# Запасной вариант — камера. Нужен, когда поток используется в
		# редакторе или в сцене без игрока (облёт карты).
		var camera: Camera3D = get_viewport().get_camera_3d()
		if camera != null:
			position = camera.global_position
	return MapConfig.world_to_chunk(position)


## Формирует очередь чанков на создание — от ближних к дальним.
##
## Порядок обязателен: если обходить чанки по строкам, игрок, появившись в
## центре, сначала увидит заполненный край карты и пустоту под ногами.
## Сортировка по расстоянию гарантирует, что рельеф под игроком появится
## первым.
func _rebuild_queue(focus_chunk: Vector2i) -> void:
	_queue.clear()
	var candidates: Array[Dictionary] = []
	var radius: int = maxi(stream_radius, 0)
	for offset_x: int in range(-radius, radius + 1):
		for offset_z: int in range(-radius, radius + 1):
			var index: Vector2i = focus_chunk + Vector2i(offset_x, offset_z)
			if not _is_valid_chunk(index) or _active.has(index):
				continue
			# Расстояние Чебышёва, а не евклидово: активная область — квадрат,
			# и евклидово расстояние давало бы круг, из-за которого углы
			# квадрата оставались бы незагруженными.
			var distance: int = maxi(absi(offset_x), absi(offset_z))
			candidates.append({"index": index, "distance": distance})
	candidates.sort_custom(_compare_by_distance)
	for candidate: Dictionary in candidates:
		_queue.append(candidate["index"])


## Сравнение для сортировки: ближние чанки первыми.
func _compare_by_distance(left: Dictionary, right: Dictionary) -> bool:
	return int(left["distance"]) < int(right["distance"])


## Создаёт чанки из очереди, не превышая бюджет кадра.
func _create_pending() -> int:
	var created: int = 0
	while not _queue.is_empty() and created < chunks_per_frame:
		var index: Vector2i = _queue.pop_front()
		if _active.has(index):
			continue
		var lod: int = _lod_for(index, _last_focus_chunk)
		var node: Node3D = _builder.build_chunk(index, lod)
		if node == null:
			continue
		add_child(node)
		_active[index] = node
		_lod_levels[index] = lod
		_created_total += 1
		created += 1
	return created


## Освобождает чанки, вышедшие за радиус с гистерезисом.
##
## Гистерезис равен одному чанку: выгрузка происходит на расстоянии
## radius + 1, а не radius. Без запаса игрок, стоящий ровно на границе,
## вызывает бесконечный цикл создания и удаления одного и того же чанка —
## визуально это постоянные рывки на месте.
func _release_distant(focus_chunk: Vector2i) -> int:
	var limit: int = maxi(stream_radius, 0) + HYSTERESIS_CHUNKS
	var to_release: Array[Vector2i] = []
	for key: Vector2i in _active.keys():
		var distance: int = maxi(absi(key.x - focus_chunk.x), absi(key.y - focus_chunk.y))
		if distance > limit:
			to_release.append(key)
	for key: Vector2i in to_release:
		_release_chunk(key)
	return to_release.size()


## Освобождает один чанк.
func _release_chunk(index: Vector2i) -> void:
	var node: Node3D = _active.get(index)
	_active.erase(index)
	_lod_levels.erase(index)
	_released_total += 1
	if node != null and is_instance_valid(node):
		# queue_free, а не free: узел может участвовать в текущем кадре
		# (физика, отрисовка), и немедленное удаление в середине кадра
		# приводит к обращению к уже уничтоженному объекту.
		node.queue_free()


## Обновляет уровень детализации активных чанков.
##
## Перестраивает чанк ТОЛЬКО если желаемый LOD отличается от текущего.
## Сравнение обязательно: пересчёт по расстоянию каждый кадр пересоздавал бы
## меши непрерывно, и это дороже, чем отсутствие LOD вообще.
func _refresh_lod(focus_chunk: Vector2i) -> int:
	var rebuilt: int = 0
	var indices: Array = _active.keys()
	for index_variant: Variant in indices:
		var index: Vector2i = index_variant
		var desired: int = _lod_for(index, focus_chunk)
		if int(_lod_levels.get(index, desired)) == desired:
			continue
		var old_node: Node3D = _active[index]
		_active.erase(index)
		_lod_levels.erase(index)
		if old_node != null and is_instance_valid(old_node):
			old_node.queue_free()
			_released_total += 1
		# Перестроенный чанк уходит в конец очереди, а не создаётся сразу:
		# иначе смена LOD у десяти чанков за один кадр даст тот же рывок,
		# от которого защищает бюджет CHUNKS_PER_FRAME.
		_queue.append(index)
		rebuilt += 1
		_rebuilt_total += 1
	return rebuilt


## Уровень детализации рельефа для чанка по его расстоянию до точки обзора.
##
## Фокус передаётся параметром, а не читается из _last_focus_chunk: явная
## зависимость позволяет вызвать метод из теста с произвольной точкой и
## убрать предупреждение линтера о неиспользуемом аргументе у вызывающих.
func _lod_for(index: Vector2i, focus_chunk: Vector2i) -> int:
	var distance: int = maxi(absi(index.x - focus_chunk.x), absi(index.y - focus_chunk.y))
	# Ближайшее кольцо — полная детализация, каждое следующее — вдвое меньше
	# треугольников. Три уровня покрывают радиус 3 с запасом.
	if distance <= 1:
		return 0
	if distance <= 2:
		return 1
	return clampi(distance - 1, 0, MapConfig.TERRAIN_LOD_LEVELS - 1)


## Допустим ли индекс чанка.
func _is_valid_chunk(index: Vector2i) -> bool:
	return (
		index.x >= 0
		and index.y >= 0
		and index.x < MapConfig.CHUNKS_PER_SIDE
		and index.y < MapConfig.CHUNKS_PER_SIDE
	)


## ------------------------------------------------------------------------
##  Публичный интерфейс
## ------------------------------------------------------------------------


## Генератор рельефа карты.
##
## Отдаётся наружу, потому что высота нужна многим системам: спавну объектов,
## проверке проходимости, позиционированию игрока при загрузке. Считать
## рельеф в нескольких местах — верный способ получить расхождение.
func terrain() -> TerrainGenerator:
	return _terrain


## Планировка карты.
func layout() -> VillageLayout:
	return _layout


## Высота рельефа в мировой точке. Короткий путь к terrain().height_at().
func ground_height(world_position: Vector3) -> float:
	if _terrain == null:
		return 0.0
	return _terrain.height_at(world_position.x, world_position.z)


## Число активных чанков.
func active_chunk_count() -> int:
	return _active.size()


## Активен ли указанный чанк.
func is_chunk_active(index: Vector2i) -> bool:
	return _active.has(index)


## Чанков в очереди на создание.
func pending_count() -> int:
	return _queue.size()


## Немедленно загружает область вокруг точки, игнорируя бюджет кадра.
##
## Нужен при телепорте и при первоначальном появлении игрока: ждать, пока
## поток догрузит рельеф за несколько кадров, нельзя — игрок провалится
## сквозь пустое место. Цена — рывок при вызове, поэтому метод не
## используется в обычном движении.
func force_load_around(world_position: Vector3) -> int:
	var focus: Vector2i = MapConfig.world_to_chunk(world_position)
	_last_focus_chunk = focus
	_rebuild_queue(focus)
	var created: int = 0
	var guard: int = MapConfig.CHUNK_COUNT
	while not _queue.is_empty() and guard > 0:
		guard -= 1
		var index: Vector2i = _queue.pop_front()
		if _active.has(index) or not _is_valid_chunk(index):
			continue
		var lod: int = _lod_for(index, focus)
		var node: Node3D = _builder.build_chunk(index, lod)
		if node == null:
			continue
		add_child(node)
		_active[index] = node
		_lod_levels[index] = lod
		_created_total += 1
		created += 1
	_release_distant(focus)
	if not _initial_loaded and not _active.is_empty():
		_initial_loaded = true
		initial_load_finished.emit()
	return created


## Сбрасывает точку наблюдения.
##
## После сброса набор активных чанков пересчитывается на следующем кадре.
## Нужно при смене управляемого объекта (игрок → транспорт → камера).
func reset_focus() -> void:
	_last_focus_chunk = Vector2i(-9999, -9999)


## Полностью очищает активные чанки.
##
## Используется при уходе с карты и в тестах: без очистки тест, создавший
## десять чанков, оставляет их в дереве, и следующий тест измеряет уже не то.
func clear_all() -> void:
	for key: Vector2i in _active.keys():
		var node: Node3D = _active[key]
		if node != null and is_instance_valid(node):
			node.queue_free()
	_active.clear()
	_lod_levels.clear()
	_queue.clear()
	_last_focus_chunk = Vector2i(-9999, -9999)


## Счётчики для отладки.
func counters() -> Dictionary:
	return {
		"created": _created_total,
		"released": _released_total,
		"rebuilt": _rebuilt_total,
		"active": _active.size(),
		"pending": _queue.size(),
	}


## Отчёт о соответствии бюджетам MapConfig.
##
## Возвращает словарь, а не печатает в лог: тест сравнивает значения,
## оверлей показывает их игроку. Требование ТЗ (6.2) — бюджеты проверяемы.
func budget_report() -> Dictionary:
	var node_count: int = 0
	var mesh_instances: int = 0
	var multimesh_instances: int = 0
	var bodies: int = 0
	for key: Vector2i in _active.keys():
		var chunk: Node3D = _active[key]
		if chunk == null or not is_instance_valid(chunk):
			continue
		# Обход в глубину: чанк содержит узлы построек, а те — свои меши,
		# поэтому одного уровня потомков недостаточно.
		var stack: Array[Node] = [chunk]
		while not stack.is_empty():
			var node: Node = stack.pop_back()
			node_count += 1
			if node is MeshInstance3D:
				mesh_instances += 1
			elif node is MultiMeshInstance3D:
				multimesh_instances += 1
			elif node is StaticBody3D or node is RigidBody3D:
				bodies += 1
			for child: Node in node.get_children():
				stack.append(child)
	return {
		"active_chunks": _active.size(),
		"active_chunk_capacity": MapConfig.active_chunk_capacity(),
		"nodes": node_count,
		"node_budget": MapConfig.BUDGET_MAP_NODES,
		"mesh_instances": mesh_instances,
		"multimesh_instances": multimesh_instances,
		"physics_bodies": bodies,
		"pending": _queue.size(),
		"stream_radius": stream_radius,
		"chunks_per_frame": chunks_per_frame,
		"builder_cache": _builder.describe_cache() if _builder != null else {},
	}
