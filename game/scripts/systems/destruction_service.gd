extends Node
## DestructionService — разрушение геометрии на осколки.
##
## ДВА РЕЖИМА РАБОТЫ, и это принципиально:
##
##  1. NATIVE (C++ GDExtension `NewwoorldFracturer`) — если расширение
##     собрано. Нарезка меша на воксельные чанки, генерация выпуклых
##     коллизий и расчёт импульсов идут в C++, то есть в 10–50 раз быстрее
##     GDScript. На 200 осколках разница — кадр против десяти.
##
##  2. FALLBACK (чистый GDScript) — если расширение НЕ собрано. Работает
##     медленнее и проще, но РАБОТАЕТ. Проект запускается из Git без
##     единого шага сборки C++, иначе «склонировал и не запустилось».
##
## Проверка режима делается один раз при старте (`_detect_backend`), а не
## на каждый вызов: `ClassDB.class_exists()` дёшева, но не бесплатна.
##
## БЮДЖЕТ. Число живых осколков ограничено профилем качества. При
## превышении самые старые осколки retire'ятся досрочно, а событие
## destruction_budget_exceeded летит в EventBus — чтобы UI мог честно
## сказать игроку, почему эффектов меньше, чем в трейлере.

signal fracturing_started(target: Node3D, energy: float)
signal debris_pool_stats_changed(stats: Dictionary)

enum Backend { FALLBACK, NATIVE }

## Результат запроса на разрушение — три состояния, а не два.
##
## ЗАЧЕМ НЕ bool. «Не разрушилось сейчас» бывает по двум противоположным
## причинам: объект ОТЛОЖЕН в очередь и развалится через кадр, либо запрос
## ОТКЛОНЁН и не развалится никогда. Вызывающая сторона обязана их
## различать: иначе отложенный объект тут же растворяется запасным путём,
## а очередь позже режет уже уничтоженный узел.
enum FractureResult { REJECTED, QUEUED, DONE }

const GROUP_DESTRUCTIBLE: StringName = &"destructible"
const GROUP_DEBRIS: StringName = &"debris"

## Сколько секунд осколок живёт по умолчанию. Дальше — в пул.
const DEFAULT_DEBRIS_LIFETIME: float = GameConfig.DESTRUCTION_DEBRIS_LIFETIME
## Порог энергии, ниже которого разрушение не запускается: царапина
## не должна разваливать стену.
const MIN_BREAK_ENERGY: float = 12.0
## Максимум одновременных операций нарезки. Нарезка тяжёлая, поэтому
## очередь: взрыв пяти бочек в одном кадре не должен убить фреймрейт.
const MAX_CONCURRENT_BREAKS: int = GameConfig.DESTRUCTION_MAX_CONCURRENT_BREAKS

## Имя класса из C++ GDExtension.
const NATIVE_CLASS: StringName = &"NewwoorldFracturer"

## Контракт формы осколка. ОБЩИЙ для GDScript-фолбэка и C++-расширения.
##
## Зачем вынесен константой: два бэкенда нарезки должны отдавать
## ОДИНАКОВЫЙ словарь, иначе переключение между ними меняет поведение
## игры, а не только скорость. Ключ «voxel» фолбэк раньше не отдавал —
## расхождение находилось только чтением обоих исходников подряд.
## tools/verify/check_backend_contract.py сверяет этот список с ключами в
## gdextension/src/newwoorld_fracturer.cpp, поэтому разъехаться снова они
## не могут.
const PIECE_KEYS: Array[String] = [
	"mesh",
	"offset",
	"impulse",
	"spin",
	"piece_index",
	"voxel",
]

var _backend: Backend = Backend.FALLBACK
var _native_fracturer: Object = null
var _debris_pool: ObjectPool = null
var _active_debris: Array[Node3D] = []
var _break_queue: Array[Dictionary] = []
var _active_breaks: int = 0
var _chunk_budget: int = GameConfig.DESTRUCTION_MAX_ACTIVE_CHUNKS
var _total_fractured: int = 0


func _ready() -> void:
	_detect_backend()
	_chunk_budget = QualityService.destruction_chunk_budget()
	QualityService.profile_applied.connect(_on_profile_applied)
	EventBus.destruction_started.connect(_on_destruction_started)


func _process(delta: float) -> void:
	_retire_expired_debris(delta)
	_drain_break_queue()


## ------------------------------------------------------------ бэкенды -----


func _detect_backend() -> void:
	if not ClassDB.class_exists(NATIVE_CLASS):
		_backend = Backend.FALLBACK
		(
			Diagnostics
			. warn(
				"destruction",
				(
					(
						"C++ GDExtension '%s' не собран — работаем в режиме FALLBACK (GDScript). "
						% NATIVE_CLASS
					)
					+ "Сборка: make cpp  (подробнее docs/07_CPP_GDEXTENSION.md)"
				),
			)
		)
		return
	_native_fracturer = ClassDB.instantiate(NATIVE_CLASS)
	if _native_fracturer == null:
		_backend = Backend.FALLBACK
		Diagnostics.error("destruction", "класс есть, но не инстанцируется")
		return
	_backend = Backend.NATIVE
	Diagnostics.info("destruction", "режим NATIVE: C++ GDExtension подключён")


func backend() -> Backend:
	return _backend


func backend_name() -> String:
	return "native C++" if _backend == Backend.NATIVE else "fallback GDScript"


func is_native() -> bool:
	return _backend == Backend.NATIVE


# ------------------------------------------------------------ разрушение --


## Точка входа. `energy` — накопленный урон/импульс; ниже порога ничего
## не происходит, чтобы пуля не разваливала бетонную стену.
## Возвращает true, только если объект действительно разрушен в этом вызове.
## Отложенный в очередь объект даёт false — и это не отказ: используйте
## request_fracture(), когда разница существенна.
func fracture(
	target: Node3D,
	energy: float,
	impact_point: Vector3 = Vector3.ZERO,
	impact_normal: Vector3 = Vector3.UP
) -> bool:
	return request_fracture(target, energy, impact_point, impact_normal) == FractureResult.DONE


## То же, что fracture(), но возвращает FractureResult.
func request_fracture(
	target: Node3D,
	energy: float,
	impact_point: Vector3 = Vector3.ZERO,
	impact_normal: Vector3 = Vector3.UP
) -> int:
	var rejection: String = _fracture_rejection_reason(target, energy)
	if not rejection.is_empty():
		Diagnostics.debug("destruction", "отказ: " + rejection)
		return FractureResult.REJECTED

	if _active_breaks >= MAX_CONCURRENT_BREAKS:
		# Ставим в очередь, а не отбрасываем: взрыв должен разрушить всё,
		# просто часть объектов развалится на 1-2 кадра позже. Очередь
		# оживает при рекурсивном разрушении — обрушение этажа вызывает
		# нарезку изнутри нарезки.
		_break_queue.append(_make_break_request(target, energy, impact_point, impact_normal))
		return FractureResult.QUEUED

	_active_breaks += 1
	fracturing_started.emit(target, energy)
	EventBus.destruction_started.emit(target, energy)

	var mesh: Mesh = _resolve_mesh(target)
	var pieces: Array = (
		[] if mesh == null else _compute_pieces(mesh, target, impact_point, impact_normal, energy)
	)
	_active_breaks -= 1
	if pieces.is_empty():
		Diagnostics.warn("destruction", "нарезка не дала осколков для %s" % target.name)
		return FractureResult.REJECTED

	_spawn_debris(pieces, target)
	_consume_source(target)
	_total_fractured += 1
	Diagnostics.count("fractures")
	Diagnostics.debug("destruction", "%s -> %d осколков" % [target.name, pieces.size()])
	return FractureResult.DONE


## Собирает словарь осколка по контракту PIECE_KEYS.
##
## Отдельная функция, а не литерал на месте: литерал из шести ключей с
## комментариями не влезает в 100 символов, и gdformat переносит его так,
## что структура становится нечитаемой. Плюс здесь ключи нельзя забыть.
func _make_piece(
	piece_mesh: ArrayMesh, centroid: Vector3, impulse: Vector3, piece_index: int
) -> Dictionary:
	var cell: float = maxf(GameConfig.DESTRUCTION_CELL_SIZE, 0.0001)
	# Воксельная координата куска. В C++-бэкенде она приходит из самой
	# сетки нарезки; фолбэк режет меш на группы граней, поэтому воксель
	# вычисляется из центроида — семантика та же: «в какой ячейке лежит
	# кусок». Используется детерминированным спином и отладкой.
	var voxel := Vector3i(
		int(floor(centroid.x / cell)), int(floor(centroid.y / cell)), int(floor(centroid.z / cell))
	)
	return {
		# Смещение куска ОТНОСИТЕЛЬНО объекта: без него все осколки
		# появляются в начале координат и «съезжают» на глазах у игрока.
		"mesh": piece_mesh,
		"offset": centroid,
		"impulse": impulse,
		"spin": _deterministic_spin(voxel, piece_index),
		"piece_index": piece_index,
		"voxel": voxel,
	}


## Спин осколка из целочисленного хеша, а не randf().
##
## Случайный спин делает нарезку невоспроизводимой: баг «осколки летят не
## туда» невозможно повторить, а тест бюджета получает плавающие числа.
## Хеш даёт то же разнообразие, но детерминированно — как в C++-бэкенде.
func _deterministic_spin(voxel: Vector3i, piece_index: int) -> Vector3:
	var hash_base: int = (voxel.x * 73856093) ^ (voxel.y * 19349663) ^ (voxel.z * 83492791)
	hash_base = hash_base ^ (piece_index * 2654435761)
	return Vector3(
		float((hash_base & 0xFF) - 128) * 0.09,
		float(((hash_base >> 8) & 0xFF) - 128) * 0.09,
		float(((hash_base >> 16) & 0xFF) - 128) * 0.09
	)


## Собирает запрос на отложенное разрушение. Отдельная функция, потому что
## словарь из четырёх ключей внутри условия не влезает в 100 символов, и
## gdformat начинает переносить его так, что код становится нечитаемым.
func _make_break_request(
	target: Node3D, energy: float, point: Vector3, normal: Vector3
) -> Dictionary:
	return {"target": target, "energy": energy, "point": point, "normal": normal}


## Проверяет предварительные условия и возвращает причину отказа
## (пустая строка = разрушать можно).
## Отдельным методом, потому что у fracture() с инлайн-проверками получалось
## восемь точек возврата, а gdlint держит потолок в шесть — и это правильно:
## функцию с восемью выходами невозможно прочитать за один раз.
func _fracture_rejection_reason(target: Node3D, energy: float) -> String:
	if not Diagnostics.check_valid(target, "destruction", "fracture"):
		return "объект недействителен"
	if energy < MIN_BREAK_ENERGY:
		return "энергия %.1f ниже порога %.1f" % [energy, MIN_BREAK_ENERGY]
	if not (target is MeshInstance3D) and not target.has_method("get_fracture_mesh"):
		return "%s: не MeshInstance3D и нет get_fracture_mesh()" % target.name
	if _resolve_mesh(target) == null:
		return "не удалось получить меш"
	return ""


## Гасит исходный объект после нарезки.
func _consume_source(target: Node3D) -> void:
	# Визуально — сразу, физически — отложенно. set_deferred обязателен:
	# мы внутри физического колбэка, прямая смена слоёв коллизий в этот
	# момент движком запрещена.
	target.visible = false
	if target is CollisionObject3D:
		var collider := target as CollisionObject3D
		collider.set_deferred("collision_layer", 0)
		collider.set_deferred("collision_mask", 0)
		collider.set_deferred("monitoring", false)
		collider.set_deferred("monitorable", false)
		collider.set_deferred("input_ray_pickable", false)
	# Исходный объект убираем ДО появления осколков в кадре: иначе один
	# кадр показывает и целую стену, и её обломки одновременно.
	if target.has_method("_on_fractured"):
		target.call("_on_fractured")


## Взрыв: разрушает всё в радиусе с затуханием энергии по расстоянию.
## Энергия падает квадратично — так ощущается естественно.
func explode(center: Vector3, radius: float, force: float) -> int:
	if radius <= 0.0:
		return 0
	var broken: int = 0
	var targets: Array[Node] = get_tree().get_nodes_in_group(GROUP_DESTRUCTIBLE)
	var radius_sq: float = radius * radius
	for node: Node in targets:
		if not (node is Node3D) or not is_instance_valid(node):
			continue
		var body := node as Node3D
		var offset: Vector3 = body.global_position - center
		var distance_sq: float = offset.length_squared()
		if distance_sq > radius_sq:
			continue
		var falloff: float = 1.0 - sqrt(distance_sq) / radius
		var energy: float = force * falloff * falloff
		var direction: Vector3 = (
			offset.normalized() if offset.length_squared() > 0.0001 else Vector3.UP
		)
		if fracture(body, energy, body.global_position, direction):
			broken += 1
	# Импульс живым телам рядом — иначе взрыв ломает ящики, но не сдвигает
	# с места игрока и не разбрасывает только что созданные осколки.
	#
	# Вызывается ОДИН РАЗ на взрыв, а не из цикла по разрушенным. Внутри
	# цикла получался запрос формы к физике на каждый обломок: взрыв,
	# разваливший двадцать объектов, делал двадцать пересечений сцены за
	# кадр. К тому же при нуле разрушений импульса не было вовсе — граната
	# на открытом месте не сдвигала ничего.
	_apply_radial_impulse(center, radius, force)
	Diagnostics.info("destruction", "взрыв r=%.1f: разрушено %d объектов" % [radius, broken])
	return broken


func _apply_radial_impulse(center: Vector3, radius: float, force: float) -> void:
	# get_world_3d() есть только у Node3D, а этот сервис — Node.
	# Мир берём у вьюпорта: он один на всю активную 3D-сцену.
	var viewport: Viewport = get_viewport()
	if viewport == null or viewport.world_3d == null:
		return
	var space: PhysicsDirectSpaceState3D = viewport.world_3d.direct_space_state
	if space == null:
		return
	var query := PhysicsShapeQueryParameters3D.new()
	var shape := SphereShape3D.new()
	shape.radius = radius
	query.shape = shape
	query.transform = Transform3D(Basis.IDENTITY, center)
	query.collision_mask = (
		GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.DEBRIS)
		| GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD)
	)
	query.collide_with_bodies = true
	var hits: Array[Dictionary] = space.intersect_shape(query, 32)
	for hit: Dictionary in hits:
		var collider: Object = hit.get("collider")
		if not (collider is RigidBody3D):
			continue
		var body := collider as RigidBody3D
		# Спад и направление считаются для КАЖДОГО тела заново: раньше они
		# приходили аргументами от одного объекта, и все остальные получали
		# impulse той же силы и в ту же сторону, что и он.
		var offset: Vector3 = body.global_position - center
		var distance: float = offset.length()
		var falloff: float = clampf(1.0 - distance / radius, 0.0, 1.0)
		var direction: Vector3 = offset.normalized() if distance > 0.01 else Vector3.UP
		body.apply_central_impulse(direction * force * falloff * body.mass * 0.1)


# --------------------------------------------------------------- нарезка ---


## Размер ячейки воксельной нарезки для конкретной цели.
##
## Общий размер 0,5 м хорош для стен и плох для тонких предметов: стекло
## толщиной 6 см при такой ячейке даёт один-два куска на всё окно. Цель
## задаёт свой размер так же, как задаёт собственный меш — через метод,
## чтобы сервис не знал ничего о конкретных типах узлов.
func _resolve_cell_size(target: Node3D) -> float:
	if target.has_method("get_fracture_cell_size"):
		var custom: Variant = target.call("get_fracture_cell_size")
		if typeof(custom) == TYPE_FLOAT and custom > 0.0:
			return custom
	return GameConfig.DESTRUCTION_CELL_SIZE


func _resolve_mesh(target: Node3D) -> Mesh:
	if target.has_method("get_fracture_mesh"):
		var custom: Variant = target.call("get_fracture_mesh")
		if custom is Mesh:
			return custom
	if target is MeshInstance3D:
		return (target as MeshInstance3D).mesh
	return null


## Возвращает массив словарей-осколков: {mesh, transform, impulse}.
func _compute_pieces(
	mesh: Mesh, target: Node3D, impact_point: Vector3, impact_normal: Vector3, energy: float
) -> Array:
	if (
		_backend == Backend.NATIVE
		and _native_fracturer != null
		and _native_fracturer.has_method("fracture")
	):
		var native_result: Variant = _native_fracturer.call(
			"fracture",
			mesh,
			target.global_transform,
			impact_point,
			impact_normal,
			energy,
			_resolve_cell_size(target),
			_chunk_budget
		)
		if typeof(native_result) == TYPE_ARRAY:
			return native_result
		Diagnostics.error("destruction", "нативная нарезка вернула не массив — fallback")
	return _compute_pieces_gdscript(mesh, target, impact_point, impact_normal, energy)


## Запасная нарезка на чистом GDScript.
##
## Честно о границах: это НЕ воксельная перенарезка меша (её делает C++),
## а разбиение существующих треугольников по плоскостям вокруг точки удара.
## Выглядит приемлемо на ящиках/бочках/камнях и заметно хуже на сложных
## моделях — ровно поэтому нативный бэкенд и существует.
## Приводит любой Mesh к ArrayMesh.
##
## ArrayMesh — единственный формат, который читает MeshDataTool. Примитивы
## движка (BoxMesh, PlaneMesh) хранят геометрию параметрически, поэтому их
## приходится разворачивать. SurfaceTool.create_from принимает обычный Mesh
## и сохраняет UV, нормали и тангенты, а commit(existing) пишет результат
## в заранее созданный ArrayMesh — это поддерживаемый способ конвертации.
func _as_array_mesh(mesh: Mesh) -> ArrayMesh:
	if mesh == null:
		return null
	if mesh is ArrayMesh:
		return mesh as ArrayMesh
	if mesh.get_surface_count() == 0:
		return null
	var tool := SurfaceTool.new()
	tool.create_from(mesh, 0)
	var converted := ArrayMesh.new()
	tool.commit(converted)
	if converted.get_surface_count() == 0:
		return null
	return converted


func _compute_pieces_gdscript(
	mesh: Mesh, target: Node3D, impact_point: Vector3, impact_normal: Vector3, energy: float
) -> Array:
	var pieces: Array = []
	if mesh.get_surface_count() == 0:
		return pieces

	# MeshDataTool.create_from_surface принимает ИМЕННО ArrayMesh, а не Mesh.
	# Примитивы движка (BoxMesh, PlaneMesh, CylinderMesh) ему не подходят,
	# хотя являются полноценными Mesh: приведение обязательно.
	var array_mesh: ArrayMesh = _as_array_mesh(mesh)
	if array_mesh == null:
		Diagnostics.error("destruction", "меш не удалось привести к ArrayMesh")
		return pieces

	var mdt := MeshDataTool.new()
	if mdt.create_from_surface(array_mesh, 0) != OK:
		Diagnostics.error("destruction", "MeshDataTool не прочитал поверхность 0")
		return pieces

	var face_count: int = mdt.get_face_count()
	if face_count == 0:
		return pieces

	# Число осколков растёт с энергией, но упирается в бюджет. Без этого
	# лимита один взрыв порождает тысячи тел и физика ложится.
	var wanted: int = clampi(int(4.0 + sqrt(energy) * 1.5), 4, 96)
	wanted = mini(wanted, maxi(1, _remaining_chunk_budget() / 8))
	var faces_per_piece: int = maxi(1, face_count / wanted)

	var local_impact: Vector3 = target.global_transform.affine_inverse() * impact_point
	var tool := SurfaceTool.new()
	tool.begin(Mesh.PRIMITIVE_TRIANGLES)

	var faces_in_current: int = 0
	var centroid_sum: Vector3 = Vector3.ZERO
	var piece_index: int = 0

	for face_index: int in face_count:
		var v0: int = mdt.get_face_vertex(face_index, 0)
		var v1: int = mdt.get_face_vertex(face_index, 1)
		var v2: int = mdt.get_face_vertex(face_index, 2)
		var p0: Vector3 = mdt.get_vertex(v0)
		var p1: Vector3 = mdt.get_vertex(v1)
		var p2: Vector3 = mdt.get_vertex(v2)
		_add_face_to_tool(tool, mdt, p0, p1, p2, face_index)
		centroid_sum += (p0 + p1 + p2) / 3.0
		faces_in_current += 1

		if faces_in_current >= faces_per_piece or face_index == face_count - 1:
			var centroid: Vector3 = centroid_sum / float(faces_in_current)
			var piece_mesh: ArrayMesh = tool.commit()
			if piece_mesh != null:
				var away: Vector3 = centroid - local_impact
				if away.length_squared() < 0.0001:
					away = impact_normal
				pieces.append(
					_make_piece(
						piece_mesh, centroid, away.normalized() * (energy * 0.02 + 1.0), piece_index
					)
				)
			piece_index += 1
			tool.clear()
			tool.begin(Mesh.PRIMITIVE_TRIANGLES)
			faces_in_current = 0
			centroid_sum = Vector3.ZERO

	return pieces


func _add_face_to_tool(
	tool: SurfaceTool, mdt: MeshDataTool, p0: Vector3, p1: Vector3, p2: Vector3, face_index: int
) -> void:
	var normal: Vector3 = mdt.get_face_normal(face_index)
	tool.set_normal(normal)
	tool.add_vertex(p0)
	tool.set_normal(normal)
	tool.add_vertex(p1)
	tool.set_normal(normal)
	tool.add_vertex(p2)


# --------------------------------------------------------------- осколки ---


func _spawn_debris(pieces: Array, source: Node3D) -> void:
	var parent: Node = _debris_container()
	if parent == null:
		return
	var material: Material = _resolve_material(source)
	var spawned: int = 0

	for piece_data: Dictionary in pieces:
		if _remaining_chunk_budget() <= 0:
			Diagnostics.warn(
				"destruction", "бюджет осколков исчерпан (%d) — обрезаем" % _chunk_budget
			)
			EventBus.destruction_budget_exceeded.emit(_active_debris.size(), _chunk_budget)
			break
		var body := RigidBody3D.new()
		body.name = "Debris_%d" % spawned
		body.collision_layer = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.DEBRIS)
		body.collision_mask = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD)
		body.freeze = false
		body.mass = clampf(0.5 + float(spawned) * 0.05, 0.2, 8.0)
		# Мелкий мусор не должен толкать игрока как грузовик.
		body.continuous_cd = false
		body.max_contacts_reported = 0

		var mesh_node := MeshInstance3D.new()
		mesh_node.mesh = piece_data["mesh"]
		if material != null:
			mesh_node.material_override = material
		mesh_node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
		body.add_child(mesh_node)

		# Выпуклая коллизия: trimesh для динамического тела нельзя
		# (Godot честно предупреждает об этом в рантайме).
		mesh_node.create_convex_collision()

		body.global_transform = (
			source.global_transform * Transform3D(Basis.IDENTITY, piece_data["offset"])
		)
		body.add_to_group(GROUP_DEBRIS)
		body.set_meta("spawn_time", Time.get_ticks_msec())
		body.set_meta("lifetime", _debris_lifetime())
		parent.add_child(body)

		body.apply_central_impulse(piece_data["impulse"])
		body.angular_velocity = piece_data["spin"]
		_active_debris.append(body)
		spawned += 1

	EventBus.destruction_chunks_spawned.emit(spawned, source.global_position)
	debris_pool_stats_changed.emit(stats())


func _debris_container() -> Node:
	var existing: Node = (
		get_tree().current_scene.get_node_or_null("DebrisContainer")
		if get_tree().current_scene != null
		else null
	)
	if existing != null:
		return existing
	var container := Node3D.new()
	container.name = "DebrisContainer"
	if get_tree().current_scene != null:
		get_tree().current_scene.add_child(container)
	return container


func _resolve_material(source: Node3D) -> Material:
	if source is MeshInstance3D:
		var mi := source as MeshInstance3D
		if mi.material_override != null:
			return mi.material_override
		if mi.mesh != null and mi.mesh.get_surface_count() > 0:
			return mi.get_active_material(0)
	return null


func _debris_lifetime() -> float:
	# На низких пресетах мусор живёт меньше: меньше тел = меньше физики.
	var profile: QualityProfile = QualityService.active_profile()
	var scale_factor: float = 0.5 if profile != null and profile.sort_order <= 1 else 1.0
	return DEFAULT_DEBRIS_LIFETIME * scale_factor


func _remaining_chunk_budget() -> int:
	return _chunk_budget - _active_debris.size()


func _retire_expired_debris(_delta: float) -> void:
	if _active_debris.is_empty():
		return
	var now: int = Time.get_ticks_msec()
	var keep: Array[Node3D] = []
	for body: Node3D in _active_debris:
		if not is_instance_valid(body):
			continue
		var born: int = int(body.get_meta("spawn_time", now))
		var lifetime_ms: int = int(body.get_meta("lifetime", DEFAULT_DEBRIS_LIFETIME) * 1000.0)
		if now - born > lifetime_ms:
			_retire(body)
		else:
			keep.append(body)
	if keep.size() != _active_debris.size():
		_active_debris = keep
		debris_pool_stats_changed.emit(stats())


func _retire(body: Node3D) -> void:
	# Усыпляем и прячем за кадр ДО удаления: queue_free() отложен,
	# и тело успело бы прожить ещё несколько кадров физики.
	if body is RigidBody3D:
		(body as RigidBody3D).freeze = true
	body.visible = false
	body.queue_free()
	EventBus.destruction_chunk_retired.emit()
	Diagnostics.count("debris_retired")


func _drain_break_queue() -> void:
	while not _break_queue.is_empty() and _active_breaks < MAX_CONCURRENT_BREAKS:
		var request: Dictionary = _break_queue.pop_front()
		var target: Variant = request.get("target")
		if not is_instance_valid(target):
			continue
		fracture(target, float(request["energy"]), request["point"], request["normal"])


# ---------------------------------------------------------------- утилиты --


func active_debris_count() -> int:
	return _active_debris.size()


func chunk_budget() -> int:
	return _chunk_budget


func queued_breaks() -> int:
	return _break_queue.size()


func total_fractured() -> int:
	return _total_fractured


func stats() -> Dictionary:
	return {
		"backend": backend_name(),
		"active": _active_debris.size(),
		"budget": _chunk_budget,
		"queued": _break_queue.size(),
		"fractured_total": _total_fractured,
		"drops": Diagnostics.get_counter("debris_retired"),
	}


## Полная очистка — при смене уровня.
func clear_all_debris() -> void:
	for body: Node3D in _active_debris:
		if is_instance_valid(body):
			body.queue_free()
	_active_debris.clear()
	_break_queue.clear()
	Diagnostics.debug("destruction", "все осколки очищены")


func _on_profile_applied(profile: QualityProfile) -> void:
	_chunk_budget = profile.destruction_chunk_budget
	Diagnostics.info("destruction", "бюджет осколков: %d" % _chunk_budget)


func _on_destruction_started(target: Node3D, energy: float) -> void:
	# Событие извне (например, скрипт уровня сам решил что-то сломать).
	# Не уходим в рекурсию: fracture() эмитит его сам, поэтому здесь
	# только лог, а не повторный вызов.
	Diagnostics.debug("destruction", "внешний запрос на %s (энергия %.1f)" % [target.name, energy])
