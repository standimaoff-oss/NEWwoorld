class_name ChunkBuilder
extends RefCounted
## ChunkBuilder — собирает содержимое одного чанка карты.
##
## ОТВЕТСТВЕННОСТЬ. Принимает индекс чанка, генератор рельефа и планировку,
## возвращает готовый Node3D с рельефом, дорогой, постройками и
## растительностью. НЕ решает, какие чанки нужны, — это задача WorldStream.
## Такое разделение позволяет тестировать построение чанка изолированно,
## а политику подгрузки менять, не трогая геометрию.
##
## ДВА ПРАВИЛА, нарушение которых обнуляет смысл потоковой подгрузки:
##
## 1. МАТЕРИАЛЫ И МЕШИ ОБЩИЕ. Они кэшируются в экземпляре построителя и
##    переиспользуются всеми чанками. Если каждый чанк создаёт свой
##    StandardMaterial3D, то 49 активных чанков — это 49 копий материала,
##    а значит 49 разных состояний отрисовки и рост видеопамяти. Кэш даёт
##    один материал на всю карту.
##
## 2. РАСТИТЕЛЬНОСТЬ — ЧЕРЕЗ MultiMesh. 1500 деревьев на карте отдельными
##    MeshInstance3D — это 1500 узлов и минимум 3000 draw call (ствол +
##    крона). MultiMesh упаковывает все деревья вида в один вызов отрисовки.
##    Ствол и крона заранее слиты в ОДИН меш, поэтому дерево — это один
##    инстанс, а не два.

## Число сегментов для цилиндрических примитивов.
##
## 7 сегментов на ствол дерева достаточно: ствол тонкий, и разница между
## 7 и 16 гранями на расстоянии больше двух метров неразличима, а число
## треугольников отличается вдвое. При 1500 деревьях это заметная экономия.
const TRUNK_SEGMENTS: int = 7

## Число сегментов кроны. Крона крупнее ствола, поэтому граней чуть больше.
const CROWN_SEGMENTS: int = 10

## Число ярусов хвои у сосны. Три конуса дают узнаваемый силуэт ели,
## один конус выглядит как конус, а не как дерево.
const PINE_TIERS: int = 3

## Поднятие ленты дороги над рельефом, в метрах.
##
## Поднятие обязательно: лента, лежащая точно на поверхности рельефа, даёт
## z-fighting — мерцание из-за совпадающей глубины. Выглядит это как битая
## текстура и не лечится ни материалом, ни настройками отрисовки.
const ROAD_LIFT: float = 0.06

## Запас при отборе точек дороги для чанка, в метрах.
##
## Точки берутся с запасом за пределами чанка, иначе лента обрывается точно
## на границе и между соседними чанками остаются дыры.
const ROAD_CLEARANCE_LOCAL: float = 8.0

## Палитра объявлена в MaterialLibrary: она общая для строителя чанков и
## строителя интерьеров. Дублирование палитры в двух файлах расходится
## незаметно, а расхождение палитры — это ровно тот «разнобой», который
## ТЗ (раздел 1) называет признаком ошибки.

## Кэш материалов. Общий с interiors: одна штукатурка обязана существовать
## в одном экземпляре, иначе движок не объединяет объекты в один проход.
var _materials: MaterialLibrary = null

## Кэш мешей деревьев по видам. Ключ — VillageLayout.Species.
var _tree_meshes: Dictionary = {}

## Кэш меша куста. Отдельно от деревьев: куст строится один раз.
var _bush_mesh: Mesh = null

## Кэш мешей построек по видам. Ключ — VillageLayout.BuildingKind.
var _building_meshes: Dictionary = {}

## Генератор рельефа. Хранится, чтобы строить чанки по запросу потока.
var _terrain: TerrainGenerator = null

## Планировка. Даёт списки зданий и растительности для чанка.
var _layout: VillageLayout = null

## Строитель подробных точек интереса. Обычные постройки остаются
## коробками: интерьер им не нужен, а стоит он десятки узлов на дом.
var _interiors: InteriorBuilder = null


func _init(terrain: TerrainGenerator, layout: VillageLayout) -> void:
	_terrain = terrain
	_layout = layout
	_materials = MaterialLibrary.new()
	# Интерьеры получают ту же библиотеку материалов: одна штукатурка
	# обязана существовать в одном экземпляре на всю карту.
	_interiors = InteriorBuilder.new(_materials)


## Отдаёт библиотеку материалов — ей пользуется строитель интерьеров.
func materials() -> MaterialLibrary:
	return _materials


## ------------------------------------------------------------------------
##  Построение чанка
## ------------------------------------------------------------------------


## Собирает узел чанка целиком.
##
## lod_level — уровень детализации рельефа: 0 для ближайших чанков, выше
## для дальних. Передаётся из WorldStream, который знает расстояние до
## игрока; сам построитель расстояний не видит.
func build_chunk(chunk_index: Vector2i, lod_level: int) -> Node3D:
	var root: Node3D = Node3D.new()
	root.name = "chunk_%d_%d" % [chunk_index.x, chunk_index.y]
	# Чанк позиционируется в своём углу, а геометрия внутри строится в
	# ЛОКАЛЬНЫХ координатах относительно этого угла. Причина: если хранить
	# мировые координаты в вершинах и не двигать узел, то точность float32
	# на краю карты (250 м от центра) уже недостаточна, и рельеф начинает
	# «дрожать» при движении камеры.
	root.position = MapConfig.chunk_to_corner(chunk_index)
	root.add_to_group(MapConfig.GROUP_CHUNK)

	_build_terrain(root, chunk_index, lod_level)
	_build_road(root, chunk_index)
	_build_buildings(root, chunk_index)
	_build_vegetation(root, chunk_index)
	return root


## Рельеф чанка: меш и коллизия.
func _build_terrain(root: Node3D, chunk_index: Vector2i, lod_level: int) -> void:
	var mesh: ArrayMesh = _terrain.build_chunk_mesh(chunk_index, lod_level)
	if mesh == null:
		return
	var instance: MeshInstance3D = MeshInstance3D.new()
	instance.name = "terrain"
	instance.mesh = mesh
	instance.material_override = _material_terrain()
	# Тени от рельефа обязательны: без них холмы читаются как плоское поле,
	# потому что глаз определяет форму именно по тени, а не по текстуре.
	instance.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
	# Крупный чанк рельефа выходит за пределы своей AABB на склонах,
	# поэтому запас отсечения увеличивают — иначе рельеф исчезает целиком,
	# когда камера смотрит вдоль границы чанка.
	instance.extra_cull_margin = MapConfig.CHUNK_SIZE
	root.add_child(instance)

	# Коллизия. create_trimesh_collision строит ConcavePolygonShape3D по
	# фактическому мешу: рельеф и коллизия совпадают автоматически.
	# Обратный порядок (сначала коллизия, потом меш) требовал бы считать
	# высоты дважды и рисковать расхождением.
	instance.create_trimesh_collision()
	var body: StaticBody3D = _find_static_body(instance)
	if body != null:
		body.name = "terrain_body"
		body.collision_layer = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD)
		body.collision_mask = 0


## Дорога в чанке, если она через него проходит.
##
## Дорога строится отдельной лентой поверх рельефа с небольшим подъёмом.
## Подъём обязателен: лента, лежащая точно на поверхности, даёт z-fighting
## (мерцание из-за совпадающей глубины), который выглядит как битая
## текстура и не лечится материалом.
func _build_road(root: Node3D, chunk_index: Vector2i) -> void:
	if not _layout.road_touches_chunk(chunk_index):
		return
	var ribbon: Array[Vector3] = _road_points_in_chunk(chunk_index)
	if ribbon.size() < 2:
		return
	var surface: SurfaceTool = SurfaceTool.new()
	surface.begin(Mesh.PRIMITIVE_TRIANGLES)
	var half_width: float = MapConfig.ROAD_HALF_WIDTH
	for index: int in range(ribbon.size() - 1):
		var current: Vector3 = ribbon[index]
		var following: Vector3 = ribbon[index + 1]
		var direction: Vector3 = following - current
		if direction.length_squared() < 0.0001:
			continue
		# Перпендикуляр в плоскости XZ. Нормаль дороги — вверх, поэтому
		# боковое смещение берётся поворотом направления на 90°.
		var side: Vector3 = Vector3(-direction.z, 0.0, direction.x).normalized() * half_width
		var lift: float = ROAD_LIFT
		var left_near: Vector3 = current - side + Vector3(0.0, lift, 0.0)
		var right_near: Vector3 = current + side + Vector3(0.0, lift, 0.0)
		var left_far: Vector3 = following - side + Vector3(0.0, lift, 0.0)
		var right_far: Vector3 = following + side + Vector3(0.0, lift, 0.0)
		_add_ribbon_quad(surface, left_near, right_near, left_far, right_far)
	surface.generate_normals()
	var mesh: ArrayMesh = surface.commit()
	var instance: MeshInstance3D = MeshInstance3D.new()
	instance.name = "road"
	instance.mesh = mesh
	instance.material_override = _material_road()
	# Дорога не отбрасывает тень: плоская лента на земле даёт только артефакты.
	instance.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	root.add_child(instance)


## Точки дороги, попадающие в чанк, в локальных координатах чанка.
func _road_points_in_chunk(chunk_index: Vector2i) -> Array[Vector3]:
	var corner: Vector3 = MapConfig.chunk_to_corner(chunk_index)
	var margin: float = MapConfig.ROAD_HALF_WIDTH + ROAD_CLEARANCE_LOCAL
	var out: Array[Vector3] = []
	for point: Vector3 in _layout.road_points():
		var local: Vector3 = point - corner
		# Берём точки с запасом за пределами чанка: без этого лента
		# обрывается точно на границе, и между чанками остаются дыры.
		if (
			local.x >= -margin
			and local.x <= MapConfig.CHUNK_SIZE + margin
			and local.z >= -margin
			and local.z <= MapConfig.CHUNK_SIZE + margin
		):
			out.append(local)
	return out


## Один квад ленты дороги: два треугольника с текстурными координатами.
func _add_ribbon_quad(
	surface: SurfaceTool,
	left_near: Vector3,
	right_near: Vector3,
	left_far: Vector3,
	right_far: Vector3
) -> void:
	var uv_scale: float = 1.0 / 3.0
	surface.set_uv(Vector2(0.0, 0.0))
	surface.add_vertex(left_near)
	surface.set_uv(Vector2(1.0, 0.0))
	surface.add_vertex(right_near)
	surface.set_uv(Vector2(1.0, uv_scale))
	surface.add_vertex(right_far)

	surface.set_uv(Vector2(0.0, 0.0))
	surface.add_vertex(left_near)
	surface.set_uv(Vector2(1.0, uv_scale))
	surface.add_vertex(right_far)
	surface.set_uv(Vector2(0.0, uv_scale))
	surface.add_vertex(left_far)


## Постройки чанка.
func _build_buildings(root: Node3D, chunk_index: Vector2i) -> void:
	var corner: Vector3 = MapConfig.chunk_to_corner(chunk_index)
	for record: Dictionary in _layout.buildings_in_chunk(chunk_index):
		var node: Node3D = null
		if bool(record.get("is_poi", false)):
			node = _build_poi(record, corner)
		else:
			node = _build_building(record, corner)
		if node != null:
			root.add_child(node)


## Подробная точка интереса: интерьер и наружные детали.
##
## Позиция и поворот задаются здесь, а не внутри InteriorBuilder: строитель
## интерьеров работает в локальных координатах постройки и не знает, где
## находится угол чанка. Если бы он знал, интерьер пришлось бы пересчитывать
## при каждом переносе чанка.
func _build_poi(record: Dictionary, corner: Vector3) -> Node3D:
	var node: Node3D = _interiors.build(record)
	if node == null:
		return null
	var position: Vector3 = record["position"]
	node.position = Vector3(position.x - corner.x, position.y, position.z - corner.z)
	node.rotation.y = float(record["rotation_y"])
	return node


## Обычная постройка — глухая коробка: стены, крыша, коллизия.
##
## Внутрь неё нельзя войти, поэтому интерьер не строится. Габариты и
## прочность берутся из тех же данных, что и у подробной версии, поэтому
## замена постройки на подробную не двигает её по карте.
func _build_building(record: Dictionary, corner: Vector3) -> Node3D:
	var kind: int = record["kind"]
	var size: Vector3 = record["size"]
	var floors: int = int(record["floors"])
	var position: Vector3 = record["position"]
	var local: Vector3 = Vector3(position.x - corner.x, position.y, position.z - corner.z)

	var root: Node3D = Node3D.new()
	root.name = String(record["id"])
	root.position = local
	root.rotation.y = float(record["rotation_y"])
	root.add_to_group(MapConfig.GROUP_STREAMED)
	if bool(record.get("is_poi", false)):
		root.add_to_group("poi")

	var total_height: float = size.y * float(floors)
	# Записи бункера дополнительно несут "wall_thickness" и "depth". Здесь
	# они не используются: на первом этапе важны габарит, позиция и
	# прочность, а толщина стен нужна интерьеру и разрушаемости — это
	# следующие этапы. Значения уже лежат в данных, чтобы позже не
	# пересчитывать планировку.

	# Корпус. Один BoxMesh на этаж намеренно НЕ используется: этаж обязан
	# разрушаться отдельно от других, иначе дом исчезает целиком от одного
	# попадания, и «полного разрушения» не получается.
	for floor_index: int in range(floors):
		var floor_node: Node3D = Node3D.new()
		floor_node.name = "floor_%d" % floor_index
		floor_node.position = Vector3(0.0, size.y * (float(floor_index) + 0.5), 0.0)
		var walls: MeshInstance3D = MeshInstance3D.new()
		walls.name = "walls"
		walls.mesh = _building_mesh(kind, size, true)
		walls.material_override = _material_wall(kind)
		walls.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
		floor_node.add_child(walls)
		walls.create_trimesh_collision()
		var body: StaticBody3D = _find_static_body(walls)
		if body != null:
			body.collision_layer = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD)
			body.collision_mask = 0
		root.add_child(floor_node)

	# Крыша — отдельный узел: она падает, когда разрушены стены под ней.
	var roof: MeshInstance3D = MeshInstance3D.new()
	roof.name = "roof"
	roof.mesh = _building_mesh(kind, size, false)
	roof.material_override = _material_roof(kind)
	roof.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
	roof.position = Vector3(0.0, total_height, 0.0)
	root.add_child(roof)
	roof.create_trimesh_collision()
	var roof_body: StaticBody3D = _find_static_body(roof)
	if roof_body != null:
		roof_body.collision_layer = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD)
		roof_body.collision_mask = 0

	return root


## Растительность чанка через MultiMesh.
func _build_vegetation(root: Node3D, chunk_index: Vector2i) -> void:
	var corner: Vector3 = MapConfig.chunk_to_corner(chunk_index)
	var records: Array[Dictionary] = _layout.vegetation_in_chunk(chunk_index)
	if records.is_empty():
		return

	# Группируем по видам: один MultiMesh на вид. Группировка обязательна —
	# MultiMesh рисует все инстансы ОДНИМ мешом, поэтому смешать сосну и
	# берёзу в один экземпляр нельзя.
	var grouped: Dictionary = {}
	for record: Dictionary in records:
		var species: int = int(record["species"])
		if not grouped.has(species):
			grouped[species] = []
		grouped[species].append(record)

	for species_key: int in grouped.keys():
		var group: Array = grouped[species_key]
		var mesh: Mesh = _vegetation_mesh(species_key)
		if mesh == null or group.is_empty():
			continue
		var multi_mesh: MultiMesh = MultiMesh.new()
		multi_mesh.transform_format = MultiMesh.TRANSFORM_3D
		multi_mesh.mesh = mesh
		multi_mesh.instance_count = group.size()
		for index: int in range(group.size()):
			var record: Dictionary = group[index]
			multi_mesh.set_instance_transform(index, _vegetation_transform(record, corner))

		var instance: MultiMeshInstance3D = MultiMeshInstance3D.new()
		instance.name = "vegetation_%d" % species_key
		instance.multimesh = multi_mesh
		instance.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
		# Запас отсечения равен высоте самого высокого дерева вида: крона
		# выходит за границы чанка, и без запаса дерево исчезает целиком,
		# когда его ствол оказывается за границей видимости.
		instance.extra_cull_margin = 20.0
		root.add_child(instance)


## Трансформация одного инстанса растения.
##
## Масштаб берётся из записи планировки, поэтому каждое дерево уникально по
## размеру, хотя меш один. Именно это убирает эффект «штампованных» деревьев.
func _vegetation_transform(record: Dictionary, corner: Vector3) -> Transform3D:
	var local: Vector3 = Vector3(record["position"]) - corner
	var height: float = float(record["height"])
	var crown: float = float(record["crown_radius"])
	var basis: Basis = Basis()
	# Поворот вокруг вертикали: деревья не должны стоять «одной гранью»
	# к камере.
	basis = basis.rotated(Vector3.UP, float(record["rotation_y"]))
	# Наклон ствола. Хранится как поворот вокруг оси X после поворота по Y.
	var lean: float = deg_to_rad(float(record.get("lean_degrees", 0.0)))
	basis = basis.rotated(basis.x, lean)
	# Неоднородный масштаб по осям: ширина кроны и высота дерева заданы
	# в планировке независимо, и их отношение меняется от дерева к дереву.
	basis = basis.scaled(Vector3(crown, height, crown))
	return Transform3D(basis, local)


## ------------------------------------------------------------------------
##  Меши
## ------------------------------------------------------------------------


## Меш постройки. wall_only=true даёт стены этажа, false — крышу.
func _building_mesh(kind: int, size: Vector3, wall_only: bool) -> Mesh:
	var cache_key: String = "%d_%s" % [kind, "w" if wall_only else "r"]
	if _building_meshes.has(cache_key):
		return _building_meshes[cache_key]

	var mesh: Mesh = null
	if wall_only:
		var box: BoxMesh = BoxMesh.new()
		box.size = size
		mesh = box
	else:
		mesh = _roof_mesh(kind, size)
	_building_meshes[cache_key] = mesh
	return mesh


## Крыша постройки.
##
## Двускатная для домов (PrismMesh — треугольная призма), плоская для сарая.
## Двускатная крыша читается как «жилой дом» мгновенно, плоская — как
## хозяйственная постройка; это различие работает без единой текстуры.
func _roof_mesh(kind: int, size: Vector3) -> Mesh:
	var overhang: float = 0.45
	match kind:
		VillageLayout.BuildingKind.BUNKER:
			# Перекрытие бункера — плита, выступающая за стены. Выступ нужен
			# не для красоты: он закрывает стык стены и грунта, иначе в
			# заглублённой коробке видна щель, через которую проваливается
			# игрок. Без этого случая бункер получал двускатную крышу из
			# ветки по умолчанию и выглядел как дом, врытый в землю.
			var slab: BoxMesh = BoxMesh.new()
			slab.size = Vector3(size.x + overhang * 2.0, 0.5, size.z + overhang * 2.0)
			return slab
		VillageLayout.BuildingKind.SHED, VillageLayout.BuildingKind.BARN:
			var flat: BoxMesh = BoxMesh.new()
			flat.size = Vector3(size.x + overhang, 0.25, size.z + overhang)
			return flat
		VillageLayout.BuildingKind.WELL:
			var well_roof: PrismMesh = PrismMesh.new()
			well_roof.size = Vector3(size.x + overhang, 0.9, size.z + overhang)
			well_roof.left_to_right = 0.5
			return well_roof
	var prism: PrismMesh = PrismMesh.new()
	prism.size = Vector3(size.x + overhang, size.y * 0.55, size.z + overhang)
	# left_to_right = 0.5 ставит конёк по центру. Значение по умолчанию 0.0
	# даёт односкатную крышу, которая для жилого дома выглядит как сарай.
	prism.left_to_right = 0.5
	return prism


## Меш растения по виду. Ствол и крона слиты в один меш.
func _vegetation_mesh(species: int) -> Mesh:
	if species == VillageLayout.Species.BUSH:
		return _bush_mesh_cached()
	if _tree_meshes.has(species):
		return _tree_meshes[species]
	var mesh: Mesh = _build_tree_mesh(species)
	_tree_meshes[species] = mesh
	return mesh


## Собирает меш дерева из примитивов.
##
## Меш строится в ЕДИНИЧНЫХ габаритах (высота 1, радиус кроны 1), а реальный
## размер задаётся масштабом инстанса. Без этого на каждый вид дерева
## требовался бы отдельный меш на каждый размер, и кэш переставал работать.
func _build_tree_mesh(species: int) -> Mesh:
	var surface: SurfaceTool = SurfaceTool.new()
	surface.begin(Mesh.PRIMITIVE_TRIANGLES)

	# Ствол — единичный цилиндр высотой 1, с центром в 0.5.
	var trunk: CylinderMesh = CylinderMesh.new()
	trunk.top_radius = 0.055
	trunk.bottom_radius = 0.085
	trunk.height = 1.0
	trunk.radial_segments = TRUNK_SEGMENTS
	trunk.rings = 1
	# Порядок аргументов: (mesh, surface_index, transform) — не наоборот.
	surface.append_from(trunk, 0, Transform3D(Basis(), Vector3(0.0, 0.5, 0.0)))

	match species:
		VillageLayout.Species.PINE:
			_append_pine_crown(surface)
		VillageLayout.Species.BIRCH:
			_append_round_crown(surface, 0.62, 0.30, 0.62)
		VillageLayout.Species.OAK:
			_append_round_crown(surface, 0.52, 0.44, 0.55)
			# Вторая, меньшая крона сверху: один шар выглядит как мяч на
			# палке, два — как крона.
			_append_round_crown(surface, 0.78, 0.26, 0.40)

	surface.generate_normals()
	surface.generate_tangents()
	return surface.commit()


## Крона сосны — несколько ярусов конуса.
##
## Конус получается цилиндром с нулевым верхним радиусом: отдельного класса
## ConeMesh в Godot нет, а попытка найти его заканчивается пустой кроной.
func _append_pine_crown(surface: SurfaceTool) -> void:
	for tier: int in range(PINE_TIERS):
		var ratio: float = float(tier) / float(PINE_TIERS)
		var base_y: float = 0.28 + ratio * 0.52
		var tier_height: float = 0.42 - ratio * 0.10
		var tier_radius: float = 0.48 - ratio * 0.13
		var cone: CylinderMesh = CylinderMesh.new()
		cone.top_radius = 0.0
		cone.bottom_radius = tier_radius
		cone.height = tier_height
		cone.radial_segments = CROWN_SEGMENTS
		cone.rings = 1
		surface.append_from(
			cone, 0, Transform3D(Basis(), Vector3(0.0, base_y + tier_height * 0.5, 0.0))
		)


## Круглая крона — сплюснутая сфера.
func _append_round_crown(
	surface: SurfaceTool, center_y: float, radius_xz: float, radius_y: float
) -> void:
	var sphere: SphereMesh = SphereMesh.new()
	sphere.radius = radius_xz
	sphere.height = radius_y * 2.0
	sphere.radial_segments = CROWN_SEGMENTS
	sphere.rings = maxi(CROWN_SEGMENTS / 2, 4)
	# Сфера задаётся радиусом и высотой, поэтому для неоднородной кроны
	# дополнительно масштабируем базис трансформации.
	var basis: Basis = Basis().scaled(Vector3(1.0, radius_y / maxf(radius_xz, 0.001), 1.0))
	surface.append_from(sphere, 0, Transform3D(basis, Vector3(0.0, center_y, 0.0)))


## Меш куста.
func _bush_mesh_cached() -> Mesh:
	if _bush_mesh != null:
		return _bush_mesh
	var surface: SurfaceTool = SurfaceTool.new()
	surface.begin(Mesh.PRIMITIVE_TRIANGLES)
	_append_round_crown(surface, 0.42, 0.50, 0.42)
	_append_round_crown(surface, 0.36, 0.34, 0.30)
	surface.generate_normals()
	surface.generate_tangents()
	_bush_mesh = surface.commit()
	return _bush_mesh


## ------------------------------------------------------------------------
##  Материалы
## ------------------------------------------------------------------------


## Материал рельефа.
func _material_terrain() -> StandardMaterial3D:
	return _cached_material("terrain", MaterialLibrary.COLOR_GRASS, 1.0, 0.92, false)


## Материал дороги.
func _material_road() -> StandardMaterial3D:
	return _cached_material("road", MaterialLibrary.COLOR_ROAD, 1.0, 0.98, false)


## Материал стен по виду постройки.
func _material_wall(kind: int) -> StandardMaterial3D:
	match kind:
		VillageLayout.BuildingKind.BUNKER:
			# Бетон чуть темнее и глаже штукатурки: монолитная поверхность
			# отражает свет равномернее, и это читается как «укрепление»,
			# а не как ещё один дом.
			return _cached_material(
				"wall_concrete", MaterialLibrary.COLOR_CONCRETE, 0.88, 0.82, false
			)
		VillageLayout.BuildingKind.BARN, VillageLayout.BuildingKind.SHED:
			return _cached_material("wall_wood", MaterialLibrary.COLOR_WOOD, 0.85, 0.9, false)
		VillageLayout.BuildingKind.WELL:
			return _cached_material("wall_stone", MaterialLibrary.COLOR_ROCK, 0.9, 0.85, false)
	return _cached_material("wall_plaster", MaterialLibrary.COLOR_PLASTER, 0.8, 0.88, false)


## Материал крыши.
##
## Вид обязателен: перекрытие бункера — тот же бетон, что и стены. Черепица
## на врытой в землю коробке разрушает узнаваемость объекта, ради которой
## бункер и ставится отдельной точкой интереса.
func _material_roof(kind: int) -> StandardMaterial3D:
	if kind == VillageLayout.BuildingKind.BUNKER:
		return _cached_material("wall_concrete", MaterialLibrary.COLOR_CONCRETE, 0.88, 0.82, false)
	return _cached_material("roof", MaterialLibrary.COLOR_ROOF, 0.75, 0.86, false)


## Возвращает материал из общего кэша.
##
## Тонкий делегат: логика создания материала живёт в MaterialLibrary, а не
## здесь, чтобы строитель интерьеров получал ровно те же экземпляры.
func _cached_material(
	key: String, albedo: Color, roughness: float, metallic_inverse: float, cull_disabled: bool
) -> StandardMaterial3D:
	return _materials.get_material(key, albedo, roughness, metallic_inverse, cull_disabled)


## ------------------------------------------------------------------------
##  Служебное
## ------------------------------------------------------------------------


## Находит StaticBody3D, созданный create_trimesh_collision().
##
## Метод создаёт тело как потомка переданного узла, но НЕ возвращает ссылку
## на него. Искать приходится перебором — и это не небрежность: единственный
## способ получить созданное тело и настроить ему слои столкновений.
func _find_static_body(owner: Node) -> StaticBody3D:
	for child: Node in owner.get_children():
		var body: StaticBody3D = child as StaticBody3D
		if body != null:
			return body
	return null


## Сводка кэша построителя — для отладки утечек.
##
## Если число материалов или мешей растёт вместе с числом построенных
## чанков, кэш не работает и видеопамять течёт. Тест сверяет эти числа
## до и после постройки нескольких чанков.
func describe_cache() -> Dictionary:
	return {
		"materials": _materials.count(),
		"tree_meshes": _tree_meshes.size(),
		"building_meshes": _building_meshes.size(),
		"bush_mesh": _bush_mesh != null,
		"interior_nodes": _interiors.nodes_built() if _interiors != null else 0,
	}
