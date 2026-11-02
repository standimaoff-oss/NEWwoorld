class_name InteriorBuilder
extends RefCounted
## Строит подробную точку интереса: интерьер и наружные детали.
##
## КОМУ ЭТО НУЖНО. Обычная постройка деревни — глухая коробка: в неё нельзя
## войти, и прорабатывать её изнутри незачем. Точка интереса обязана быть
## полноценным помещением, потому что требование заказчика — «проработать
## обе точки и внутри, и снаружи».
##
## ПОЧЕМУ НЕ ВСЕ ДОМА ДЕЛАЮТСЯ ПОДРОБНЫМИ. Интерьер стоит 40–70 узлов на
## постройку против 3 у коробки. На 14 домов это ~800 узлов только на
## интерьеры, которые игрок никогда не увидит, потому что не зайдёт в каждый.
## Подробность оплачивается ровно там, где её видно.
##
## СЛОИ. RoomLayout даёт геометрию ограждения, PoiDetails — наполнение,
## MaterialLibrary — материалы, этот класс собирает из них узлы. Ни один из
## слоёв не знает про узлы сцены, кроме этого.
##
## РАЗРУШАЕМОСТЬ ЗАКЛАДЫВАЕТСЯ ЗДЕСЬ. Каждая панель, плита и предмет
## получает узел Destructible сразу, а не на этапе разрушения. Причина
## практическая: добавлять разрушаемость постфактум пришлось бы к уже
## собранным узлам, и пришлось бы угадывать, какой меш к какому коллайдеру
## относится. Здесь эта связь известна точно.

## Группа подробных точек интереса. Отдельная от MapConfig.GROUP_STREAMED:
## поток освобождает чанки целиком, а по этой группе системы находят
## конкретные проработанные объекты.
const GROUP_POI: StringName = &"poi"
## Предел источников света на точку интереса.
##
## Каждый источник добавляет проход освещения для всех объектов в радиусе.
## Ограничение нужно, чтобы число ламп не начало расти вместе с числом
## помещений: в длинном коридоре их может быть десять, а светить обязаны
## четыре ближайшие.
const MAX_POI_LIGHTS: int = 4
## Радиус действия источника света, м.
const LAMP_RANGE: float = 7.5
## Размер колбы, м.
const LAMP_BULB_SIZE: float = 0.16
## Стекло ставится точно в плоскость проёма, поэтому врезка нулевая.
## Ненулевая врезка нужна для дверей: створка обязана стоять внутри
## коробки, а не вровень со стеной.
const GLASS_COLLISION_INSET: float = 0.0
## Шаг сетки разбиения стекла, м. От него зависит размер осколка.
const GLASS_SHARD_SIZE: float = 0.3
## Пределы сетки: меньше двух ячеек — снова один лист, больше шести — лишняя
## геометрия на окне, которое игрок видит пару секунд.
const GLASS_GRID_MIN: int = 2
const GLASS_GRID_MAX: int = 6
## Ячейка воксельной нарезки для стекла. Общая (0,5 м) больше самой панели
## по толщине, поэтому нативный бэкенд дал бы один кусок на всё окно.
const GLASS_FRACTURE_CELL: float = 0.18

var _materials: MaterialLibrary = null
var _nodes_built: int = 0


func _init(materials: MaterialLibrary) -> void:
	_materials = materials


## Собирает точку интереса целиком по записи планировки.
##
## Возвращает узел, который строитель чанков добавляет в дерево. Позицию и
## поворот задаёт вызывающая сторона: здесь всё строится в локальных
## координатах постройки, иначе при переносе чанка интерьер уехал бы.
func build(record: Dictionary) -> Node3D:
	var kind: int = int(record["kind"])
	var size: Vector3 = record["size"]
	var floors: int = int(record.get("floors", 1))
	var is_bunker: bool = kind == VillageLayout.BuildingKind.BUNKER

	var plan: Dictionary = {}
	if is_bunker:
		var thickness: float = float(
			record.get("wall_thickness", RoomLayout.BUNKER_PARTITION_THICKNESS)
		)
		plan = RoomLayout.plan_bunker(size, thickness, PoiDetails.bunker_openings(size))
		PoiDetails.decorate_bunker(plan, size, thickness)
	else:
		plan = RoomLayout.plan_house(size, floors, PoiDetails.house_openings(size, floors))
		PoiDetails.decorate_house(plan, size, floors)

	var root: Node3D = Node3D.new()
	root.name = String(record["id"])
	root.add_to_group(MapConfig.GROUP_STREAMED)
	root.add_to_group(GROUP_POI)
	_nodes_built += 1

	var storeys: Array[Node3D] = _create_storeys(root, floors if not is_bunker else 1)
	_build_panels(storeys, plan["panels"])
	_build_slabs(storeys, plan["slabs"])
	_build_stairs(storeys[0], plan["stairs"], 0)
	_build_openings(storeys, plan["openings"], is_bunker)
	_build_furniture(storeys, plan["furniture"])
	_build_props(root, plan["props"])
	_build_roof(root, plan["roof"])
	_build_lamps(root, plan["lamps"], is_bunker)
	_attach_structure(root, storeys)
	return root


## Число узлов, построенных этим экземпляром.
func nodes_built() -> int:
	return _nodes_built


## Сводка состояния.
func describe() -> Dictionary:
	return {
		"nodes_built": _nodes_built,
		"max_lights": MAX_POI_LIGHTS,
		"materials": _materials.count() if _materials != null else 0,
	}


## ------------------------------------------------------------------------
##  Контейнеры
## ------------------------------------------------------------------------


## Создаёт контейнеры этажей.
##
## Этаж — отдельный узел намеренно: разрушение этажа обязано убирать его
## целиком, включая мебель и перегородки. Если всё лежит в одном контейнере,
## «обрушить второй этаж» невозможно без перебора всех узлов.
func _create_storeys(root: Node3D, floors: int) -> Array[Node3D]:
	var storeys: Array[Node3D] = []
	for index: int in range(maxi(floors, 1)):
		var storey: Node3D = Node3D.new()
		storey.name = "floor_%d" % index
		root.add_child(storey)
		storeys.append(storey)
		_nodes_built += 1
	return storeys


## Подключает конструктивную целостность к готовой точке интереса.
##
## Отдельный проход ПОСЛЕ построения, а не аргументы в _solid_part():
## структурная роль известна только там, где раздел плана превращается в
## узлы, а _solid_part() вызывается из семи разных мест. Проход по дереву
## читает метки, которые эти места проставили.
func _attach_structure(root: Node3D, storeys: Array[Node3D]) -> void:
	var structure: Structure = Structure.new()
	structure.name = "structure"
	# configure() до add_child(): так же, как у Grenade и Door.
	structure.configure(root)
	root.add_child(structure)
	_nodes_built += 1
	for index: int in range(storeys.size()):
		structure.register_floor(index, storeys[index])
		_register_parts(structure, storeys[index], index)
	# Крыша регистрируется этажом выше верхнего: обрушение верхнего этажа
	# обязано унести и её, иначе она повиснет в воздухе.
	var roof_node: Node = root.get_node_or_null("roof")
	if roof_node != null:
		var roof_index: int = storeys.size()
		structure.register_floor(roof_index, roof_node)
		_register_parts(structure, roof_node, roof_index)


## Регистрирует разрушаемые части узла рекурсивно.
##
## Обход обязателен: створка двери — это Destructible внутри Door, до
## которого get_children() первого уровня не доходит.
func _register_parts(structure: Structure, node: Node, floor_index: int) -> void:
	if node is Destructible:
		var part: Destructible = node as Destructible
		structure.register_part(
			part,
			floor_index,
			bool(part.get_meta("interior", false)),
			bool(part.get_meta("is_slab", false))
		)
	for child: Node in node.get_children():
		_register_parts(structure, child, floor_index)


## Индекс контейнера этажа для элемента плана.
func _storey_index(entry: Dictionary, storeys: Array[Node3D]) -> int:
	return clampi(int(entry.get("floor", 0)), 0, storeys.size() - 1)


## ------------------------------------------------------------------------
##  Элементы
## ------------------------------------------------------------------------


## Стеновые панели.
func _build_panels(storeys: Array[Node3D], panels: Array) -> void:
	for index: int in range(panels.size()):
		var entry: Dictionary = panels[index]
		var node: Node3D = _solid_part(
			"panel_%02d" % index,
			RoomLayout.ShapeKind.BOX,
			entry["position"],
			entry["size"],
			int(entry["role"]),
			float(entry["integrity"]),
			bool(entry["destructible"])
		)
		# Признак перегородки нужен Structure: снос перегородки не обрушает
		# ничего, а снос несущей стены обрушает этаж выше.
		node.set_meta("interior", bool(entry.get("interior", false)))
		storeys[_storey_index(entry, storeys)].add_child(node)


## Перекрытия и полы.
func _build_slabs(storeys: Array[Node3D], slabs: Array) -> void:
	for index: int in range(slabs.size()):
		var entry: Dictionary = slabs[index]
		var node: Node3D = _solid_part(
			"slab_%02d" % index,
			RoomLayout.ShapeKind.BOX,
			entry["position"],
			entry["size"],
			int(entry["role"]),
			float(entry["integrity"]),
			bool(entry["destructible"])
		)
		node.set_meta("is_slab", true)
		storeys[_storey_index(entry, storeys)].add_child(node)


## Ступени лестницы.
func _build_stairs(storey: Node3D, stairs: Array, _floor_index: int) -> void:
	for index: int in range(stairs.size()):
		var entry: Dictionary = stairs[index]
		var node: Node3D = _solid_part(
			"stair_%02d" % index,
			RoomLayout.ShapeKind.BOX,
			entry["position"],
			entry["size"],
			RoomLayout.SurfaceRole.WOOD_DARK,
			MapConfig.INTEGRITY_WOOD,
			true
		)
		storey.add_child(node)


## Проёмы: двери и стёкла.
##
## Обработка разделена принципиально. Дверь — узел с состоянием: она
## открывается, закрывается и может быть заперта. Стекло — просто хрупкая
## панель. Смешивать их в один класс значит дать окну поведение двери.
func _build_openings(storeys: Array[Node3D], openings: Array, is_bunker: bool) -> void:
	for index: int in range(openings.size()):
		var entry: Dictionary = openings[index]
		var storey: Node3D = storeys[_storey_index(entry, storeys)]
		var kind: int = int(entry["kind"])
		if kind == RoomLayout.OpeningKind.WINDOW:
			storey.add_child(
				_glass_part(
					"window_%02d" % index, entry["position"], entry["size"], int(entry["axis"])
				)
			)
		else:
			storey.add_child(
				_door_part(
					"door_%02d" % index,
					entry["position"],
					entry["size"],
					int(entry["axis"]),
					kind,
					is_bunker
				)
			)


## Мебель и оборудование.
func _build_furniture(storeys: Array[Node3D], furniture: Array) -> void:
	for index: int in range(furniture.size()):
		var entry: Dictionary = furniture[index]
		var node: Node3D = _solid_part(
			"furniture_%02d" % index,
			_furniture_shape(int(entry["kind"])),
			entry["position"],
			entry["size"],
			int(entry["role"]),
			float(entry["integrity"]),
			true
		)
		node.rotation.y = float(entry["rotation_y"])
		storeys[_storey_index(entry, storeys)].add_child(node)


## Наружные детали: крыльцо, труба, наличники, вентиляция, насыпь.
func _build_props(root: Node3D, props: Array) -> void:
	if props.is_empty():
		return
	var container: Node3D = Node3D.new()
	container.name = "props"
	root.add_child(container)
	_nodes_built += 1
	for index: int in range(props.size()):
		var entry: Dictionary = props[index]
		container.add_child(
			_solid_part(
				"prop_%02d" % index,
				int(entry["shape"]),
				entry["position"],
				entry["size"],
				int(entry["role"]),
				float(entry["integrity"]),
				bool(entry["destructible"])
			)
		)


## Крыша или перекрытие.
##
## Отдельный узел с именем «roof»: она падает, когда стены под ней разрушены,
## и искать её по имени проще, чем вычислять, какой из панелей она была.
func _build_roof(root: Node3D, roof: Dictionary) -> void:
	if roof.is_empty():
		return
	var node: Node3D = _solid_part(
		"roof",
		int(roof["shape"]),
		roof["position"],
		roof["size"],
		int(roof["role"]),
		float(roof["integrity"]),
		bool(roof["destructible"])
	)
	root.add_child(node)


## Освещение помещений.
func _build_lamps(root: Node3D, lamps: Array, is_bunker: bool) -> void:
	if lamps.is_empty():
		return
	var container: Node3D = Node3D.new()
	container.name = "lamps"
	root.add_child(container)
	_nodes_built += 1
	var limit: int = mini(lamps.size(), MAX_POI_LIGHTS)
	for index: int in range(limit):
		var entry: Dictionary = lamps[index]
		var position: Vector3 = entry["position"]
		# Колба — светящаяся плоскость. Она видна и сама по себе даёт
		# представление о том, где источник.
		container.add_child(
			_solid_part(
				"bulb_%02d" % index,
				RoomLayout.ShapeKind.BOX,
				position,
				Vector3.ONE * LAMP_BULB_SIZE,
				RoomLayout.SurfaceRole.LAMP,
				MapConfig.INTEGRITY_GLASS,
				true,
				false
			)
		)
		# Настоящий свет обязателен: бункер под землёй, небесного ambient
		# туда не доходит, и без источника интерьер был бы чёрным.
		# Тени выключены — они удваивают стоимость источника, а в тесном
		# помещении читаются плохо.
		var light: OmniLight3D = OmniLight3D.new()
		light.name = "light_%02d" % index
		light.position = position
		light.light_color = MaterialLibrary.COLOR_LAMP_WARM
		light.light_energy = 1.6 if is_bunker else 1.1
		light.omni_range = LAMP_RANGE
		light.omni_attenuation = 1.6
		light.shadow_enabled = false
		container.add_child(light)
		_nodes_built += 1


## ------------------------------------------------------------------------
##  Сборка узлов
## ------------------------------------------------------------------------


## Твёрдая деталь: меш, коллизия и, при необходимости, разрушаемость.
func _solid_part(
	part_name: String,
	shape: int,
	position: Vector3,
	size: Vector3,
	role: int,
	integrity: float,
	destructible: bool,
	collides: bool = true
) -> Node3D:
	var mesh_node: MeshInstance3D = MeshInstance3D.new()
	mesh_node.name = "mesh"
	mesh_node.mesh = _mesh_for_shape(shape, size)
	mesh_node.material_override = SurfaceRules.material_for_role(_materials, role)
	mesh_node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON

	var body: StaticBody3D = null
	if collides:
		body = _add_box_collision(mesh_node, shape, size)

	if not destructible:
		# Неразрушаемая деталь не получает обёртку: лишний узел в дереве
		# и лишний объект в группе, которую взрыв перебирает целиком.
		_nodes_built += 1
		mesh_node.position = position
		return mesh_node

	var wrapper: Destructible = Destructible.new()
	wrapper.name = part_name
	wrapper.position = position
	wrapper.integrity = integrity
	wrapper.break_energy = clampf(integrity * 0.35, 40.0, 260.0)
	wrapper.damage_multiplier = SurfaceRules.damage_multiplier(role)
	# Ссылки задаются явно. Автопоиск Destructible смотрит только детей
	# первого уровня, а коллайдер создан внуком — без явной ссылки
	# разрушенная стена оставила бы невидимую преграду, в которую игрок
	# упирается на пустом месте.
	wrapper.mesh_node = mesh_node
	wrapper.collider_node = body
	wrapper.add_child(mesh_node)
	_nodes_built += 2
	return wrapper


## Стекло в проёме.
##
## Коллизия у стекла есть всегда: окно, сквозь которое можно пройти,
## перестаёт быть окном. При разрушении коллизия отключается вместе с мешом.
func _glass_part(part_name: String, position: Vector3, size: Vector3, axis: int) -> Node3D:
	var mesh_node: MeshInstance3D = MeshInstance3D.new()
	mesh_node.name = "mesh"
	# Тонкая ось панели определяется осью стены: стена вдоль X даёт стекло
	# с тонкой гранью по Z, и наоборот.
	mesh_node.mesh = _pane_mesh(size, 2 if axis == 0 else 0)
	mesh_node.material_override = _materials.get_glass("glass")
	# Стекло не отбрасывает тень: полупрозрачная поверхность с тенью даёт
	# сплошное чёрное пятно на полу, а не световой проём.
	mesh_node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF

	var body: StaticBody3D = _add_box_collision(mesh_node, RoomLayout.ShapeKind.BOX, size)
	body.collision_layer = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD)

	var wrapper: Destructible = Destructible.new()
	wrapper.name = part_name
	wrapper.position = position
	wrapper.integrity = MapConfig.INTEGRITY_GLASS
	wrapper.break_energy = MapConfig.EXPLOSION_ENERGY * 0.25
	# Множитель выше единицы: стекло обязано разбиваться от малого
	# воздействия. Прочность у него и так минимальна, но без множителя
	# осколок от взрыва в десяти метрах его бы не взял.
	wrapper.damage_multiplier = SurfaceRules.damage_multiplier(RoomLayout.SurfaceRole.GLASS)
	wrapper.mesh_node = mesh_node
	wrapper.collider_node = body
	wrapper.fracture_cell_size = GLASS_FRACTURE_CELL
	wrapper.add_child(mesh_node)
	_nodes_built += 3
	# Ось запоминается в имени: на этапе разрушения осколки летят вдоль
	# нормали стены, и нормаль определяется ориентацией проёма.
	wrapper.set_meta("axis", axis)
	return wrapper


## Дверь в проёме.
func _door_part(
	part_name: String, position: Vector3, size: Vector3, axis: int, kind: int, is_bunker: bool
) -> Node3D:
	var door: Door = Door.new()
	door.name = part_name
	# Начало координат двери — в петле, а не в центре проёма.
	var hinge_offset: float = size.x * 0.5 if axis == 0 else size.z * 0.5
	if axis == 0:
		door.position = Vector3(position.x - hinge_offset, position.y, position.z)
	else:
		door.position = Vector3(position.x, position.y, position.z - hinge_offset)
		# Стена вдоль Z: локальная X двери должна смотреть вдоль мира Z.
		door.rotation.y = TAU * 0.25
	door.hinge_direction = 1.0 if axis == 0 else -1.0

	# Полотно в системе координат двери: ширина всегда вдоль локальной X.
	var leaf_size: Vector3 = size
	if axis != 0:
		leaf_size = Vector3(size.z, size.y, size.x)

	var role: int = (
		RoomLayout.SurfaceRole.METAL_DARK
		if kind == RoomLayout.OpeningKind.BLAST_DOOR
		else RoomLayout.SurfaceRole.WOOD_DARK
	)
	var integrity: float = float(RoomLayout.opening_integrity(kind))
	door.configure(leaf_size, SurfaceRules.material_for_role(_materials, role), integrity)
	if kind == RoomLayout.OpeningKind.BLAST_DOOR:
		# Взрывная дверь бункера заперта: она тяжёлая, и открытый настежь
		# бункер теряет смысл укрытия. Игрок должен взаимодействовать с ней
		# осознанно, а подсказка — отличаться от обычной двери.
		door.locked = is_bunker
		door.locked_prompt = "Взрывная дверь: открыть засов"
		door.open_angle_degrees = 78.0
		door.swing_seconds = 1.6
	_nodes_built += 4
	return door


## Коллизия детали.
##
## Формы задаются вручную, а не через create_trimesh_collision(): все
## детали интерьера — коробки и цилиндры, то есть выпуклые тела. Трассировка
## меша дала бы вогнутую форму, которая дороже в расчёте и не годится для
## тел, которые позже начнут двигаться как обломки.
func _add_box_collision(mesh_node: MeshInstance3D, shape: int, size: Vector3) -> StaticBody3D:
	var body: StaticBody3D = StaticBody3D.new()
	body.name = "body"
	body.collision_layer = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD)
	# Маска ноль: статика ни с чем не сталкивается активно. Ненулевая маска
	# у неподвижного тела заставляет физический движок проверять пары
	# столкновений, которые никогда ничем не кончаются.
	body.collision_mask = 0
	var holder: CollisionShape3D = CollisionShape3D.new()
	match shape:
		RoomLayout.ShapeKind.CYLINDER:
			var cylinder: CylinderShape3D = CylinderShape3D.new()
			cylinder.radius = maxf(size.x, size.z) * 0.5
			cylinder.height = size.y
			holder.shape = cylinder
		RoomLayout.ShapeKind.PRISM:
			# Двускатная крыша не описывается ни коробкой, ни цилиндром,
			# поэтому для неё берётся выпуклая оболочка самого меша.
			mesh_node.create_convex_collision()
			var generated: StaticBody3D = _find_generated_body(mesh_node)
			if generated != null:
				generated.collision_layer = body.collision_layer
				generated.collision_mask = 0
				return generated
			var fallback: BoxShape3D = BoxShape3D.new()
			fallback.size = Vector3(size.x, size.y * 0.5, size.z)
			holder.shape = fallback
			holder.position = Vector3(0.0, -size.y * 0.25, 0.0)
		_:
			var box: BoxShape3D = BoxShape3D.new()
			box.size = Vector3(
				maxf(size.x, GLASS_COLLISION_INSET),
				maxf(size.y, GLASS_COLLISION_INSET),
				maxf(size.z, GLASS_COLLISION_INSET)
			)
			holder.shape = box
	body.add_child(holder)
	mesh_node.add_child(body)
	return body


## Находит тело, созданное create_convex_collision().
##
## Метод создаёт StaticBody3D потомком, но ссылку не возвращает — искать
## приходится перебором.
func _find_generated_body(mesh_node: MeshInstance3D) -> StaticBody3D:
	for child: Node in mesh_node.get_children():
		if child is StaticBody3D:
			return child as StaticBody3D
	return null


## ------------------------------------------------------------------------
##  Геометрия и материалы
## ------------------------------------------------------------------------


## Меш оконного стекла с сеткой разбиения на лицевых гранях.
##
## ЗАЧЕМ НЕ BoxMesh. Фолбэк-нарезка в DestructionService делит меш на группы
## ГРАНЕЙ, а у бокса их двенадцать: окно «разбилось» бы на десяток крупных
## листов вместо осколков. Требование «стёкла бьются физично» упирается
## именно в количество геометрии, а не в настройки прочности.
func _pane_mesh(size: Vector3, thin_axis: int) -> ArrayMesh:
	var u_axis: int = (thin_axis + 1) % 3
	var v_axis: int = (thin_axis + 2) % 3
	var columns: int = clampi(int(size[u_axis] / GLASS_SHARD_SIZE), GLASS_GRID_MIN, GLASS_GRID_MAX)
	var rows: int = clampi(int(size[v_axis] / GLASS_SHARD_SIZE), GLASS_GRID_MIN, GLASS_GRID_MAX)
	var half: Vector3 = size * 0.5
	var step_u: Vector3 = Vector3.ZERO
	var step_v: Vector3 = Vector3.ZERO
	step_u[u_axis] = size[u_axis] / float(columns)
	step_v[v_axis] = size[v_axis] / float(rows)

	var tool: SurfaceTool = SurfaceTool.new()
	tool.begin(Mesh.PRIMITIVE_TRIANGLES)
	# Лицевые грани — сеткой, торцевые — одним четырёхугольником каждая.
	# Торцы тонкие (6 см) и невидимы, а лишние грани плодят осколки-иголки.
	for side: int in [-1, 1]:
		var normal: Vector3 = Vector3.ZERO
		normal[thin_axis] = float(side)
		var origin: Vector3 = -step_u * float(columns) * 0.5 - step_v * float(rows) * 0.5
		origin[thin_axis] = half[thin_axis] * float(side)
		for column: int in range(columns):
			for row: int in range(rows):
				var corner: Vector3 = origin + step_u * float(column) + step_v * float(row)
				if side > 0:
					_emit_quad(
						tool,
						corner,
						corner + step_u,
						corner + step_u + step_v,
						corner + step_v,
						normal
					)
				else:
					# Обратный обход: иначе нормали смотрят внутрь панели.
					_emit_quad(
						tool,
						corner,
						corner + step_v,
						corner + step_u + step_v,
						corner + step_u,
						normal
					)
	_emit_pane_edges(tool, half, thin_axis, u_axis, v_axis)
	return tool.commit()


## Четыре торцевые грани панели стекла.
func _emit_pane_edges(
	tool: SurfaceTool, half: Vector3, thin_axis: int, u_axis: int, v_axis: int
) -> void:
	for axis: int in [u_axis, v_axis]:
		var other: int = v_axis if axis == u_axis else u_axis
		var across: Vector3 = Vector3.ZERO
		var along: Vector3 = Vector3.ZERO
		across[thin_axis] = half[thin_axis]
		along[other] = half[other]
		for side: int in [-1, 1]:
			var center: Vector3 = Vector3.ZERO
			center[axis] = half[axis] * float(side)
			var normal: Vector3 = Vector3.ZERO
			normal[axis] = float(side)
			_emit_quad(
				tool,
				center - across - along,
				center + across - along,
				center + across + along,
				center - across + along,
				normal
			)


## Четырёхугольник двумя треугольниками.
##
## Нормаль задаётся до КАЖДОЙ вершины: SurfaceTool запоминает последнее
## значение, а не применяет его ко всему примитиву.
func _emit_quad(
	tool: SurfaceTool, a: Vector3, b: Vector3, c: Vector3, d: Vector3, normal: Vector3
) -> void:
	for vertex: Vector3 in [a, b, c, a, c, d]:
		tool.set_normal(normal)
		tool.add_vertex(vertex)


## Меш по форме и габариту.
func _mesh_for_shape(shape: int, size: Vector3) -> Mesh:
	match shape:
		RoomLayout.ShapeKind.CYLINDER:
			var cylinder: CylinderMesh = CylinderMesh.new()
			cylinder.top_radius = maxf(size.x, size.z) * 0.5
			cylinder.bottom_radius = maxf(size.x, size.z) * 0.5
			cylinder.height = size.y
			# Сегментов меньше, чем по умолчанию: труба вентиляции вдали не
			# обязана быть идеально круглой, а грани стоят треугольников.
			cylinder.radial_segments = 12
			cylinder.rings = 1
			return cylinder
		RoomLayout.ShapeKind.PRISM:
			var prism: PrismMesh = PrismMesh.new()
			prism.size = size
			# Конёк по центру. Значение по умолчанию 0.0 даёт односкатную
			# крышу, и жилой дом начинает выглядеть как сарай.
			prism.left_to_right = 0.5
			return prism
	var box: BoxMesh = BoxMesh.new()
	box.size = size
	return box


## Форма по виду мебели.
##
## Бочки — единственная не коробочная мебель: цилиндр узнаётся силуэтом,
## и замена его коробкой сразу читается как подделка.
func _furniture_shape(kind: int) -> int:
	if kind == RoomLayout.FurnitureKind.BARREL:
		return RoomLayout.ShapeKind.CYLINDER
	return RoomLayout.ShapeKind.BOX
