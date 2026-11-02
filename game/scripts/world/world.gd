extends Node3D
## World — игровой уровень и procedural-полигон для всех систем.
##
## ЗАЧЕМ ПРОЦЕДУРНАЯ ГЕОМЕТРИЯ. Уровень собирается кодом, а не рисуется в
## редакторе, по трём причинам:
##   1. он воспроизводим — тест может построить тот же уровень и проверить
##      бюджет треугольников и число узлов;
##   2. он не зависит от .glb, которых в проекте ещё нет: системы
##      (разрушение, ветер, физика, качество) проверяются сразу;
##   3. его можно перестроить под другой размер одной константой.
## Настоящие уровни будут импортироваться из .glb через tools/asset-pipeline
## и подставляться в тот же Geometry-узел — контракт не изменится.
##
## ОТВЕТСТВЕННОСТЬ. World знает: где стоят объекты, какие флаги мира
## установлены, что сохранять в сейв. World НЕ знает: как нарезаются меши
## (DestructionService), как считается ветер (WindSystem), как рисуется HUD.
##
## ГРУППЫ. WorldEnvironment и Sun обязаны состоять в группах
## &"world_environment" и &"main_sun": QualityService находит их по группам
## и применяет к ним профиль качества. Без этого настройки графики
## сохраняются в файл, но на картинку не влияют.

## Размер площадки, метры. От него считаются все остальные размеры,
## поэтому уровень можно увеличить одной правкой.
const ARENA_HALF_SIZE: float = 22.0
## Шаг сетки колонн.
const COLUMN_SPACING: float = 7.0
## Число разрушаемых ящиков.
const CRATE_COUNT: int = 9
## Число «растений» для проверки ветра. Ветер без видимых объектов
## не проверить: именно они показывают, что шейдер читает глобальные
## параметры, а не стоит на месте.
const FOLIAGE_COUNT: int = 26
## Треугольников на один объект обстановки. Ограничение жёсткое: уровень
## собирается из примитивов, и «красивый» бокс на 5000 треугольников здесь
## не нужен — нужен предсказуемый бюджет.
const TRIANGLES_PER_PROP: int = 12

const SAVE_PROVIDER_ID: String = "world"

## Палитра уровня. Три приглушённых материала вместо одного «серого
## пластика»: различимые плоскости дают читаемые тени и понятную глубину.
## Цвета специально не насыщенные — насыщенная тестовая сцена утомляет.
const COLOR_GROUND: Color = Color(0.22, 0.24, 0.25)
const COLOR_STRUCTURE: Color = Color(0.38, 0.40, 0.43)
const COLOR_ACCENT: Color = Color(0.19, 0.42, 0.52)
const COLOR_BREAKABLE: Color = Color(0.52, 0.40, 0.30)
const COLOR_FOLIAGE: Color = Color(0.28, 0.42, 0.28)

var world_flags: Dictionary = {}
var _player: Node3D = null
var _destructibles: Array[Node] = []
var _interactables: Array[Node] = []
var _level_seed: int = 20260101
var _geometry_root: Node3D = null


func _ready() -> void:
	_geometry_root = %Geometry
	_register_groups()
	_randomize_from_seed()
	_build_level()
	_resolve_player()
	SaveService.register_provider(SAVE_PROVIDER_ID, self)
	QualityService.apply_index(SettingsService.get_int("video/quality_preset"), true)
	EventBus.level_loaded.emit("arena_01")
	Diagnostics.info(
		"world",
		(
			"уровень построен: %d узлов, %d треугольников"
			% [PerfMonitor.node_count(), _count_triangles()]
		)
	)


func _exit_tree() -> void:
	SaveService.unregister_provider(SAVE_PROVIDER_ID)


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("quick_save"):
		_quick_save()
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed("quick_load"):
		_quick_load()
		get_viewport().set_input_as_handled()


# ---------------------------------------------------------------- сборка ----


func _register_groups() -> void:
	# QualityService ищет окружение и солнце по группам. Имена — константы
	# сервиса, поэтому берём их оттуда, а не дублируем строками.
	%WorldEnvironment.add_to_group(QualityService.ENVIRONMENT_GROUP)
	%Sun.add_to_group(QualityService.SUN_GROUP)
	add_to_group(&"world")


func _randomize_from_seed() -> void:
	# Детерминированный уровень: одинаковый seed даёт одинаковую расстановку.
	# Это нужно тестам (иначе проверка бюджета «плавает») и нужно игроку —
	# уровень не должен выглядеть по-разному при каждой загрузке.
	seed(_level_seed)


func _build_level() -> void:
	_build_ground()
	_build_perimeter()
	_build_columns()
	_build_breakable_wall()
	_build_crates()
	_build_foliage()
	_build_interactables()


func _build_ground() -> void:
	var size: float = ARENA_HALF_SIZE * 2.0
	var ground := _make_box(Vector3(size, 0.5, size), COLOR_GROUND, "Ground")
	ground.position = Vector3(0, -0.25, 0)
	# Тримеш-коллизия для земли избыточна: плоскость описывается одним
	# BoxShape и считается физикой заметно дешевле.
	var body := _make_static_body(ground, "GroundBody")
	var shape := BoxShape3D.new()
	shape.size = Vector3(size, 0.5, size)
	var collider := CollisionShape3D.new()
	collider.shape = shape
	collider.position = Vector3(0, -0.25, 0)
	body.add_child(collider)
	body.collision_layer = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD)
	_geometry_root.add_child(body)


func _build_perimeter() -> void:
	var size: float = ARENA_HALF_SIZE * 2.0
	var height: float = 3.0
	var thickness: float = 0.6
	var specs: Array[Dictionary] = [
		{
			"size": Vector3(size, height, thickness),
			"pos": Vector3(0, height * 0.5, -ARENA_HALF_SIZE)
		},
		{
			"size": Vector3(size, height, thickness),
			"pos": Vector3(0, height * 0.5, ARENA_HALF_SIZE)
		},
		{
			"size": Vector3(thickness, height, size),
			"pos": Vector3(-ARENA_HALF_SIZE, height * 0.5, 0)
		},
		{
			"size": Vector3(thickness, height, size),
			"pos": Vector3(ARENA_HALF_SIZE, height * 0.5, 0)
		},
	]
	var index: int = 0
	for spec: Dictionary in specs:
		var wall := _make_box(spec["size"], COLOR_STRUCTURE, "Wall_%d" % index)
		wall.position = spec["pos"]
		var body := _make_static_body(wall, "WallBody_%d" % index)
		_add_trimesh_collision(body)
		body.collision_layer = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD)
		_geometry_root.add_child(body)
		index += 1


func _build_columns() -> void:
	var half: float = ARENA_HALF_SIZE - 3.0
	var position_x: float = -half
	while position_x <= half:
		var position_z: float = -half
		while position_z <= half:
			# Центр площадки оставляем свободным: там появляется игрок,
			# и колонна на точке спавна — это застревание в геометрии.
			if absf(position_x) > 3.0 or absf(position_z) > 3.0:
				_add_column(Vector3(position_x, 0.0, position_z))
			position_z += COLUMN_SPACING
		position_x += COLUMN_SPACING


func _add_column(at_position: Vector3) -> void:
	var height: float = 4.2
	var column := _make_box(Vector3(0.9, height, 0.9), COLOR_ACCENT, "Column")
	column.position = at_position + Vector3(0, height * 0.5, 0)
	var cap := _make_box(Vector3(1.3, 0.28, 1.3), COLOR_STRUCTURE, "ColumnCap")
	cap.position = at_position + Vector3(0, height + 0.14, 0)
	var body := _make_static_body(column, "ColumnBody")
	body.add_child(cap)
	_add_trimesh_collision(body)
	body.collision_layer = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD)
	_geometry_root.add_child(body)


## Стена из разрушаемых блоков. Именно на ней проверяется нарезка: блоки
## достаточно крупные, чтобы осколки читались, и достаточно многочисленные,
## чтобы проявился бюджет.
func _build_breakable_wall() -> void:
	var cell: float = 1.2
	var rows: int = 3
	var columns: int = 6
	var origin: Vector3 = Vector3(-float(columns) * cell * 0.5, 0.0, -6.0)
	for row in range(rows):
		for column in range(columns):
			var block_position: Vector3 = (
				origin + Vector3((float(column) + 0.5) * cell, (float(row) + 0.5) * cell, 0.0)
			)
			_add_destructible_box(
				block_position,
				Vector3(cell * 0.94, cell * 0.94, cell * 0.94),
				"WallBlock_%d_%d" % [row, column],
				70.0 + float(row) * 22.0
			)


func _build_crates() -> void:
	for index in range(CRATE_COUNT):
		var angle: float = TAU * float(index) / float(CRATE_COUNT)
		var radius: float = 9.0 + float(index % 3) * 2.5
		var crate_position := Vector3(cos(angle) * radius, 0.5, sin(angle) * radius)
		_add_destructible_box(crate_position, Vector3(1.0, 1.0, 1.0), "Crate_%d" % index, 45.0)


func _add_destructible_box(
	at_position: Vector3, size: Vector3, node_name: String, integrity: float
) -> void:
	var holder := Node3D.new()
	holder.name = node_name
	holder.position = at_position

	var mesh_instance := _make_box(size, COLOR_BREAKABLE, node_name + "_Mesh")
	holder.add_child(mesh_instance)

	# Отдельное статическое тело: разрушаемый блок должен блокировать
	# проход, пока цел, и переставать блокировать, когда сломан.
	var body := StaticBody3D.new()
	body.name = node_name + "_Body"
	body.collision_layer = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD)
	body.collision_mask = 0
	var shape := BoxShape3D.new()
	shape.size = size
	var collider := CollisionShape3D.new()
	collider.shape = shape
	body.add_child(collider)
	holder.add_child(body)

	var destructible_script: GDScript = load("res://scripts/world/destructible.gd")
	holder.set_script(destructible_script)
	holder.set("mesh_node", mesh_instance)
	holder.set("collider_node", body)
	holder.set("integrity", integrity)
	holder.set("break_energy", clampf(integrity, 40.0, 160.0))
	# Материал растворения задаём кодом: шейдер уже есть в проекте, а
	# держать .tres на каждый эффект — лишние файлы в репозитории.
	holder.set("dissolve_material", _make_dissolve_material())

	_geometry_root.add_child(holder)
	_destructibles.append(holder)


func _build_foliage() -> void:
	# «Растения» — тонкие вытянутые боксы в группе &"wind_affected". Форма
	# намеренно примитивная: проверить нужно ШЕЙДЕР ветра, а не модель куста.
	# Реальная трава придёт из .glb и попадёт в ту же группу.
	var wind_material: ShaderMaterial = _make_wind_material()
	var half: float = ARENA_HALF_SIZE - 2.0
	for index in range(FOLIAGE_COUNT):
		var position_x: float = randf_range(-half, half)
		var position_z: float = randf_range(-half, half)
		if absf(position_x) < 2.5 and absf(position_z) < 2.5:
			continue
		var height: float = randf_range(0.7, 1.5)
		var blade := MeshInstance3D.new()
		blade.name = "Foliage_%d" % index
		var mesh := BoxMesh.new()
		mesh.size = Vector3(0.07, height, 0.07)
		blade.mesh = mesh
		blade.position = Vector3(position_x, height * 0.5, position_z)
		blade.material_override = wind_material
		# Вершинные цвета шейдер использует как маску фазы: у основания
		# цвет темнее, значит амплитуда меньше. Без этого «трава» качается
		# целиком и выглядит как картонка на шарнире.
		_apply_gradient_colors(blade)
		blade.add_to_group(&"wind_affected")
		_geometry_root.add_child(blade)


func _apply_gradient_colors(mesh_instance: MeshInstance3D) -> void:
	# BoxMesh — примитив, вершинных цветов у него нет. Создаём их через
	# SurfaceTool нельзя без пересборки, поэтому используем instance-параметр
	# шейдера: у каждого растения своя фаза, и синхронное качание исчезает.
	var phase: float = randf() * TAU
	mesh_instance.set_instance_shader_parameter("phase_offset", phase)


func _build_interactables() -> void:
	_add_lever(Vector3(-4.0, 0.0, 4.0), "Lever_Gate", "Открыть ворота")
	_add_lever(Vector3(4.0, 0.0, 4.0), "Lever_Lights", "Переключить свет")
	_add_chest(Vector3(0.0, 0.0, -12.0))


func _add_lever(at_position: Vector3, node_name: String, prompt: String) -> void:
	var area := Area3D.new()
	area.name = node_name
	area.position = at_position + Vector3(0, 1.0, 0)
	area.collision_layer = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.INTERACTABLE)
	area.collision_mask = 0

	var shape := SphereShape3D.new()
	shape.radius = 0.6
	var collider := CollisionShape3D.new()
	collider.shape = shape
	area.add_child(collider)

	var visual := _make_box(Vector3(0.22, 0.9, 0.22), COLOR_ACCENT, node_name + "_Mesh")
	area.add_child(visual)

	var base := _make_box(Vector3(0.6, 0.2, 0.6), COLOR_STRUCTURE, node_name + "_Base")
	base.position = Vector3(0, -0.55, 0)
	area.add_child(base)

	area.set_script(load("res://scripts/world/interactable.gd"))
	area.set("prompt", prompt)
	area.set("single_use", false)
	# Пьедестал нужен, чтобы объект было видно: сам по себе Area3D не рисуется.
	var pedestal := _make_static_body(
		_make_box(Vector3(0.9, 1.0, 0.9), COLOR_STRUCTURE, node_name + "_Pedestal"),
		node_name + "_PedestalBody"
	)
	pedestal.position = at_position + Vector3(0, 0.5, 0)
	pedestal.collision_layer = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD)
	_geometry_root.add_child(pedestal)

	_geometry_root.add_child(area)
	_interactables.append(area)
	area.connect("interacted", _on_lever_used.bind(node_name))


func _add_chest(at_position: Vector3) -> void:
	_add_lever(at_position, "Chest_Rewards", "Открыть ящик")
	set_world_flag("chest_opened", false)


# ------------------------------------------------------------ материалы ----


func _make_box(size: Vector3, color: Color, node_name: String) -> MeshInstance3D:
	var mesh := BoxMesh.new()
	mesh.size = size
	var instance := MeshInstance3D.new()
	instance.name = node_name
	instance.mesh = mesh
	instance.material_override = _make_material(color)
	return instance


func _make_material(color: Color) -> StandardMaterial3D:
	var material := StandardMaterial3D.new()
	material.albedo_color = color
	material.roughness = 0.82
	material.metallic = 0.05
	# Тени обязательны: без них сцена выглядит плоской, и понять, где
	# заканчивается стена, невозможно.
	material.shadows_disabled = false
	return material


func _make_static_body(mesh_instance: MeshInstance3D, node_name: String) -> StaticBody3D:
	var body := StaticBody3D.new()
	body.name = node_name
	body.add_child(mesh_instance)
	return body


func _add_trimesh_collision(body: StaticBody3D) -> void:
	# create_trimesh_collision строит коллизию по фактической геометрии.
	# Для стены из одного бокса это дороже BoxShape3D, но универсальнее:
	# тот же вызов работает на импортированном .glb сложной формы.
	for child: Node in body.get_children():
		if child is MeshInstance3D:
			(child as MeshInstance3D).create_trimesh_collision()


func _make_dissolve_material() -> ShaderMaterial:
	var shader: Shader = load("res://shaders/dissolve_destruction.gdshader") as Shader
	if shader == null:
		Diagnostics.warn("world", "dissolve_destruction.gdshader не найден")
		return null
	var material := ShaderMaterial.new()
	material.shader = shader
	material.set_shader_parameter("dissolve_amount", 0.0)
	material.set_shader_parameter("edge_width", 0.06)
	material.set_shader_parameter("edge_color", Color(1.0, 0.55, 0.2))
	return material


func _make_wind_material() -> ShaderMaterial:
	var shader: Shader = load("res://shaders/wind_foliage.gdshader") as Shader
	if shader == null:
		Diagnostics.warn("world", "wind_foliage.gdshader не найден")
		return null
	var material := ShaderMaterial.new()
	material.shader = shader
	material.set_shader_parameter("albedo", COLOR_FOLIAGE)
	material.set_shader_parameter("max_bend", 0.22)
	material.set_shader_parameter("anchor_height", 0.05)
	material.set_shader_parameter("flutter_amount", 0.08)
	return material


# ---------------------------------------------------------------- игрок ----


func _resolve_player() -> void:
	var candidates: Array[Node] = get_tree().get_nodes_in_group(&"player")
	if candidates.is_empty():
		Diagnostics.error("world", 'игрок не найден в группе &"player"')
		return
	_player = candidates[0] as Node3D


func player() -> Node3D:
	return _player


# ------------------------------------------------------------ флаги мира ---


func set_world_flag(flag_name: String, value: Variant) -> void:
	world_flags[flag_name] = value


## Часть контракта с Interactable: объект спрашивает у уровня, выполнено ли
## условие. Хранить флаги в самих объектах нельзя — состояние игры
## оказалось бы размазано по десяткам дверей.
func has_world_flag(flag_name: String) -> bool:
	return bool(world_flags.get(flag_name, false))


func _on_lever_used(_actor: Node, lever_name: String) -> void:
	match lever_name:
		"Lever_Gate":
			set_world_flag("gate_open", not has_world_flag("gate_open"))
			Diagnostics.info(
				"world", "ворота: %s" % ("открыты" if has_world_flag("gate_open") else "закрыты")
			)
		"Lever_Lights":
			_toggle_sun()
		"Chest_Rewards":
			set_world_flag("chest_opened", true)
			Diagnostics.info("world", "ящик открыт")
			_reward_player()


func _toggle_sun() -> void:
	var sun: DirectionalLight3D = %Sun
	sun.visible = not sun.visible
	# Заполняющий свет включаем в противофазе: сцена без ИСТОЧНИКА света
	# выглядит чёрным экраном, и игрок решает, что игра сломалась.
	$FillLight.light_energy = 0.85 if not sun.visible else 0.22


func _reward_player() -> void:
	if _player == null or not _player.has_method("heal"):
		return
	_player.call("heal", 25.0)


# ------------------------------------------------------------- сохранения --


## Часть контракта с SaveService: провайдер отдаёт словарь своего состояния.
func collect_save_data() -> Dictionary:
	var destructible_states: Array = []
	for node: Node in _destructibles:
		if not is_instance_valid(node):
			continue
		var destroyed: bool = false
		if node.has_method("is_destroyed"):
			destroyed = bool(node.call("is_destroyed"))
		destructible_states.append({"name": str(node.name), "destroyed": destroyed})
	var player_position: Array[float] = [0.0, 0.0, 0.0]
	if _player != null and is_instance_valid(_player):
		var position: Vector3 = (_player as Node3D).global_position
		player_position = [position.x, position.y, position.z]
	return {
		"level_id": "arena_01",
		"seed": _level_seed,
		"flags": world_flags.duplicate(true),
		"destructibles": destructible_states,
		"player_position": player_position,
	}


## Вторая половина контракта: восстановить состояние из словаря.
func restore_save_data(data: Variant) -> void:
	if typeof(data) != TYPE_DICTIONARY:
		Diagnostics.error("world", "restore_save_data: ожидался Dictionary")
		return
	var payload: Dictionary = data
	_level_seed = int(payload.get("seed", _level_seed))
	var flags: Variant = payload.get("flags", {})
	if typeof(flags) == TYPE_DICTIONARY:
		world_flags = (flags as Dictionary).duplicate(true)
	_restore_destructibles(payload.get("destructibles", []))
	_restore_player_position(payload.get("player_position", []))
	QualityService.apply_index(SettingsService.get_int("video/quality_preset"), true)
	Diagnostics.info("world", "состояние уровня восстановлено")


func _restore_destructibles(states: Variant) -> void:
	if typeof(states) != TYPE_ARRAY:
		return
	# Индексируем по имени: порядок узлов в дереве не обязан совпадать с
	# порядком записи в сейве, а поиск по имени переживает перестановку.
	var by_name: Dictionary = {}
	for node: Node in _destructibles:
		if is_instance_valid(node):
			by_name[str(node.name)] = node
	var restored: int = 0
	for entry: Variant in states:
		if typeof(entry) != TYPE_DICTIONARY:
			continue
		var record: Dictionary = entry
		var node: Variant = by_name.get(str(record.get("name", "")))
		if node == null or not bool(record.get("destroyed", false)):
			continue
		if (node as Object).has_method("destroy"):
			(node as Object).call("destroy")
			restored += 1
	Diagnostics.debug("world", "восстановлено разрушений: %d" % restored)


func _restore_player_position(value: Variant) -> void:
	if typeof(value) != TYPE_ARRAY:
		return
	var components: Array = value
	if components.size() < 3 or _player == null or not is_instance_valid(_player):
		return
	var position := Vector3(float(components[0]), float(components[1]), float(components[2]))
	(_player as Node3D).global_position = position
	# Скорость обнуляем: сохранённая позиция не подразумевает сохранённое
	# движение, а остаточная скорость выбрасывает игрока из точки спавна.
	if _player.has_method("respawn"):
		_player.call("respawn", position)


func _quick_save() -> void:
	var ok: bool = SaveService.quick_save()
	_show_status("Сохранено" if ok else "Не удалось сохранить")


func _quick_load() -> void:
	var ok: bool = SaveService.quick_load()
	_show_status("Загружено" if ok else "Не удалось загрузить")


func _show_status(text: String) -> void:
	if _hud() != null and _hud().has_method("show_status"):
		_hud().call("show_status", text)


func _hud() -> Node:
	# HUD — фиксированный ребёнок сцены уровня, поиск по группе здесь
	# только добавил бы способ получить не тот узел.
	return get_node_or_null("HUD")


# ------------------------------------------------------------- диагностика --


## Число треугольников в уровне. Нужно тестам бюджета: «оптимизировано»
## без измерения — это мнение, а не факт.
func _count_triangles() -> int:
	var total: int = 0
	for node: Node in _iter_descendants(_geometry_root):
		if not (node is MeshInstance3D):
			continue
		var mesh: Mesh = (node as MeshInstance3D).mesh
		if mesh == null:
			continue
		for surface in range(mesh.get_surface_count()):
			total += _surface_triangle_count(mesh, surface)
	return total


## Треугольников в одной поверхности меша.
##
## Индексный массив есть не всегда: примитивы движка (BoxMesh, PlaneMesh)
## хранят вершины сплошным списком без индексов. Считать треугольники
## только по ARRAY_INDEX — значит получить ноль для всего тестового уровня
## и сделать проверку бюджета бессмысленной.
func _surface_triangle_count(mesh: Mesh, surface: int) -> int:
	if mesh.surface_get_primitive_type(surface) != Mesh.PRIMITIVE_TRIANGLES:
		return 0
	var arrays: Array = mesh.surface_get_arrays(surface)
	var indices: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
	if not indices.is_empty():
		return int(indices.size() / 3)
	var vertices: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
	return int(vertices.size() / 3)


func _iter_descendants(root: Node) -> Array[Node]:
	var found: Array[Node] = []
	if root == null:
		return found
	var stack: Array[Node] = [root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		found.append(node)
		for child: Node in node.get_children():
			stack.append(child)
	return found


func destructible_count() -> int:
	return _destructibles.size()


func interactable_count() -> int:
	return _interactables.size()


## Сводка для тестов и отладочного оверлея.
func budget_report() -> Dictionary:
	return {
		"nodes": PerfMonitor.node_count(),
		"triangles": _count_triangles(),
		"destructibles": _destructibles.size(),
		"interactables": _interactables.size(),
		"max_triangles_per_prop": TRIANGLES_PER_PROP,
	}
