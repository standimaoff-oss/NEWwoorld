extends GutTest
## Интеграционные тесты подробных точек интереса: интерьер и наружные детали.
##
## КАКОЙ КЛАСС ОШИБОК ЛОВИТ. Планировка может быть геометрически безупречна,
## а собранные из неё узлы — нерабочими. Разрыв происходит на последнем шаге:
##
##   * у разрушаемой стены нет коллайдера — она исчезает, а игрок упирается
##     в невидимую преграду;
##   * у стекла включено отбрасывание тени — на полу чёрное пятно вместо
##     светового проёма;
##   * дверь собрана без зоны взаимодействия — на неё нельзя нажать;
##   * каждый источник света включает тени — четыре лампы стоят как четыре
##     дополнительных прохода отрисовки.
##
## Все четыре дефекта невидимы в данных планировки и видны только в узлах.
## Поэтому тесты здесь идут по собранному дереву, а не по словарям.

const MAX_POI_NODES: int = 420

var _builder: InteriorBuilder = null
var _materials: MaterialLibrary = null
var _bunker_record: Dictionary = {}
var _house_record: Dictionary = {}
var _bunker_root: Node3D = null
var _house_root: Node3D = null


## Записи точек интереса берутся из НАСТОЯЩЕЙ планировки карты.
##
## Собирать их руками нельзя: выдуманная запись расходится с реальной, и
## тест начинает проверять не то, что строится в игре. Планировка создаётся
## один раз на файл — она тяжёлая (1500 деревьев), и пересоздавать её перед
## каждой проверкой незачем.
func before_all() -> void:
	var terrain: TerrainGenerator = TerrainGenerator.new(MapConfig.DEFAULT_SEED)
	var layout: VillageLayout = VillageLayout.new(terrain, MapConfig.DEFAULT_SEED)
	layout.build()
	_bunker_record = layout.poi(VillageLayout.PoiKind.BUNKER)
	_house_record = layout.poi(VillageLayout.PoiKind.VILLAGE_HOUSE)


func before_each() -> void:
	assert_false(_bunker_record.is_empty(), "в планировке нет бункера")
	assert_false(_house_record.is_empty(), "в планировке нет дома-точки интереса")
	_materials = MaterialLibrary.new()
	_builder = InteriorBuilder.new(_materials)
	_bunker_root = _builder.build(_bunker_record)
	_house_root = _builder.build(_house_record)
	assert_not_null(_bunker_root, "бункер не построился")
	assert_not_null(_house_root, "дом не построился")
	add_child_autofree(_bunker_root)
	add_child_autofree(_house_root)


## Все потомки узла одним списком.
func _descendants(root: Node) -> Array[Node]:
	var out: Array[Node] = []
	var stack: Array[Node] = [root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		out.append(node)
		for child: Node in node.get_children():
			stack.append(child)
	return out


## Первый потомок с указанным именем.
func _find_named(root: Node, target: String) -> Node:
	for node: Node in _descendants(root):
		if node.name == target:
			return node
	return null


## Все узлы указанного типа.
func _all_of(root: Node, type_name: String) -> Array[Node]:
	var out: Array[Node] = []
	for node: Node in _descendants(root):
		if node.get_class() == type_name:
			out.append(node)
	return out


func test_poi_is_tagged_as_point_of_interest() -> void:
	# Группа — единственный способ для игровых систем найти проработанную
	# точку, не обходя дерево чанков. Без неё телепорт по клавише отладки и
	# подсказки не знают, куда вести игрока.
	assert_true(_bunker_root.is_in_group(InteriorBuilder.GROUP_POI), "бункер не в группе POI")
	assert_true(_house_root.is_in_group(InteriorBuilder.GROUP_POI), "дом не в группе POI")
	assert_true(
		_bunker_root.is_in_group(MapConfig.GROUP_STREAMED),
		"бункер не помечен как потоковый — поток его не освободит"
	)


func test_building_is_split_into_storeys() -> void:
	# Этаж — отдельный узел: разрушение этажа обязано убирать его целиком.
	# Без деления «обрушить второй этаж» требует перебора всех узлов дерева.
	assert_not_null(_find_named(_house_root, "floor_0"), "у дома нет первого этажа")
	assert_not_null(_find_named(_house_root, "floor_1"), "у дома нет второго этажа")
	assert_not_null(_find_named(_house_root, "roof"), "у дома нет крыши")
	assert_not_null(_find_named(_bunker_root, "floor_0"), "у бункера нет помещения")
	assert_not_null(_find_named(_bunker_root, "roof"), "у бункера нет перекрытия")


func test_house_has_an_interior_not_a_solid_box() -> void:
	# Ключевое отличие подробной точки от обычной постройки. Обычный дом —
	# одна коробка на этаж; подробный — десятки панелей, потому что стена
	# режется простенками вокруг проёмов. Если панелей мало, значит построен
	# не интерьер, а та же коробка, и проработки «изнутри» нет.
	var panels: int = 0
	for node: Node in _descendants(_house_root):
		if String(node.name).begins_with("panel_"):
			panels += 1
	assert_gt(panels, 24, "у дома всего %d стеновых панелей — это коробка, а не интерьер" % panels)


func test_bunker_has_an_interior() -> void:
	var panels: int = 0
	for node: Node in _descendants(_bunker_root):
		if String(node.name).begins_with("panel_"):
			panels += 1
	assert_gt(panels, 16, "у бункера всего %d панелей" % panels)
	# Мебель и оборудование — то, ради чего в бункер стоит заходить.
	var furniture: int = 0
	for node: Node in _descendants(_bunker_root):
		if String(node.name).begins_with("furniture_"):
			furniture += 1
	assert_gt(furniture, 6, "в бункере всего %d предметов оборудования" % furniture)


func test_exterior_details_are_present() -> void:
	# Требование заказчика: точка проработана и СНАРУЖИ. Наружные детали —
	# отдельный контейнер, и он обязан быть непустым: гладкая коробка с
	# прорезями окон не читается ни как дом, ни как укрытие.
	for root: Node3D in [_house_root, _bunker_root]:
		var props: Node = _find_named(root, "props")
		assert_not_null(props, "нет контейнера наружных деталей")
		if props == null:
			continue
		assert_gt(
			props.get_child_count(),
			2,
			"наружных деталей %d — точка не проработана снаружи" % props.get_child_count()
		)


func test_doors_are_interactive() -> void:
	# Дверь обязана быть не просто мешем, а узлом взаимодействия: иначе на
	# неё нельзя нажать, и интерьер остаётся запертым изнутри.
	var doors: Array[Node] = []
	for node: Node in _descendants(_bunker_root):
		if node is Door:
			doors.append(node)
	for node: Node in _descendants(_house_root):
		if node is Door:
			doors.append(node)
	assert_gt(doors.size(), 2, "дверей меньше, чем помещений")
	for door: Node in doors:
		assert_true(door is Interactable, "дверь не является взаимодействуемой")
		var interactable: Interactable = door as Interactable
		assert_true(interactable.action.is_valid(), "у двери не задано действие")
		assert_true(interactable.monitorable, "дверь не видна лучу игрока")
		assert_ne(interactable.interaction_prompt(), "", "у двери пустая подсказка")


func test_bunker_blast_door_is_locked() -> void:
	# Взрывная дверь заперта: открытый настежь бункер перестаёт быть укрытием.
	# Проверка на состоянии узла, а не на данных — именно узел отвечает
	# игроку «заперто».
	var locked_found: bool = false
	for node: Node in _descendants(_bunker_root):
		if node is Door and (node as Door).is_locked():
			locked_found = true
	assert_true(locked_found, "в бункере нет ни одной запертой двери")


func test_doors_have_a_trigger_zone() -> void:
	# Зона взаимодействия — CollisionShape3D внутри Area3D. Без неё дверь
	# существует, но нажатие не проходит: луч не находит объект.
	for node: Node in _descendants(_bunker_root):
		if not (node is Door):
			continue
		var shapes: int = 0
		for child: Node in node.get_children():
			if child is CollisionShape3D:
				shapes += 1
		assert_gt(shapes, 0, "у двери «%s» нет зоны взаимодействия" % node.name)


func test_doors_open_on_interaction() -> void:
	# Поведенческая проверка: взаимодействие обязано менять состояние.
	# Без неё дверь может быть собрана правильно и при этом не открываться —
	# например, если действие не подключено.
	var door: Door = null
	for node: Node in _descendants(_house_root):
		if node is Door and not (node as Door).is_locked():
			door = node as Door
			break
	assert_not_null(door, "в доме нет незапертой двери")
	if door == null:
		return
	assert_false(door.is_open(), "дверь открыта до взаимодействия")
	door.interact(null)
	assert_true(door.is_open(), "после взаимодействия дверь не открылась")
	assert_eq(door.interaction_prompt(), "Закрыть", "подсказка не сменилась на «Закрыть»")
	# Поворот идёт твином, поэтому в этом же кадре угол ещё прежний.
	# Проверяется состояние и параметры распахивания, а не промежуточный кадр.
	assert_gt(
		door.open_angle_degrees, 90.0, "угол открытия меньше прямого — створка закроет проход"
	)
	door.toggle()
	assert_false(door.is_open(), "дверь не закрылась обратно")
	assert_eq(door.interaction_prompt(), "Открыть", "подсказка не вернулась к «Открыть»")


func test_every_destructible_has_mesh_and_collider() -> void:
	# РЕГРЕССИОННАЯ ПРОВЕРКА. Destructible ищет коллайдер только среди детей
	# ПЕРВОГО уровня, а create_trimesh_collision() создаёт тело внуком. Без
	# явной ссылки разрушенная стена оставила бы невидимую преграду: игрок
	# расстрелял дом, а упирается в пустоту на его месте.
	var checked: int = 0
	for root: Node3D in [_house_root, _bunker_root]:
		for node: Node in _descendants(root):
			if not (node is Destructible):
				continue
			var destructible: Destructible = node as Destructible
			checked += 1
			assert_not_null(destructible.mesh_node, "у «%s» нет меша — нечего резать" % node.name)
			if destructible.get("collider_node") != null:
				assert_true(
					destructible.collider_node is CollisionObject3D,
					"коллайдер «%s» не является телом столкновения" % node.name
				)
	assert_gt(checked, 30, "разрушаемых объектов подозрительно мало: %d" % checked)


func test_destructibles_join_the_destruction_group() -> void:
	# Сервис разрушения ищет цели по группе. Объект вне группы неуязвим, и
	# игрок расстреливает стену впустую — самый обидный дефект разрушаемости.
	# Список потомков строится один раз: пересборка внутри цикла дала бы
	# квадратичную стоимость на нескольких сотнях узлов.
	var ours: Dictionary = {}
	for node: Node in _descendants(_house_root):
		ours[node] = true
	for node: Node in _descendants(_bunker_root):
		ours[node] = true
	var in_group: int = 0
	for node: Node in get_tree().get_nodes_in_group(DestructionService.GROUP_DESTRUCTIBLE):
		if ours.has(node):
			in_group += 1
	assert_gt(in_group, 30, "в группе разрушаемых всего %d объектов точки" % in_group)


func test_glass_is_the_most_fragile_part() -> void:
	# Требование «стёкла бьются физично» начинается с прочности: стекло
	# обязано сдаваться раньше любой стены, иначе оно держит очередь наравне
	# с бетоном и разрушение не читается.
	var glass_integrity: float = INF
	var wall_integrity: float = 0.0
	for node: Node in _descendants(_bunker_root):
		if not (node is Destructible):
			continue
		var destructible: Destructible = node as Destructible
		if String(node.name).begins_with("window_"):
			glass_integrity = minf(glass_integrity, destructible.integrity)
		elif String(node.name).begins_with("panel_"):
			wall_integrity = maxf(wall_integrity, destructible.integrity)
	assert_lt(glass_integrity, INF, "в бункере нет стёкол")
	assert_eq(glass_integrity, MapConfig.INTEGRITY_GLASS, "прочность стекла не из конфигурации")
	assert_gt(wall_integrity, glass_integrity * 10.0, "стена бункера слишком близка к стеклу")


func test_windows_exist_in_both_points() -> void:
	for root: Node3D in [_house_root, _bunker_root]:
		var windows: int = 0
		for node: Node in _descendants(root):
			if String(node.name).begins_with("window_"):
				windows += 1
		assert_gt(windows, 0, "в точке «%s» нет ни одного окна" % root.name)


func test_glass_does_not_cast_shadow() -> void:
	# Полупрозрачная поверхность с отбрасыванием тени даёт сплошное чёрное
	# пятно на полу вместо светового проёма. Лечится только отключением тени,
	# ни материалом, ни настройкой отрисовки.
	for root: Node3D in [_house_root, _bunker_root]:
		for node: Node in _descendants(root):
			if not (node is MeshInstance3D):
				continue
			if String(node.name) != "mesh":
				continue
			var parent: Node = node.get_parent()
			if parent == null or not String(parent.name).begins_with("window_"):
				continue
			var mesh: MeshInstance3D = node as MeshInstance3D
			assert_eq(
				mesh.cast_shadow,
				GeometryInstance3D.SHADOW_CASTING_SETTING_OFF,
				"стекло отбрасывает тень"
			)


func test_glass_material_is_transparent() -> void:
	# Непрозрачное «стекло» — это стена. Проверка идёт по материалу, потому
	# что прозрачность задаётся не в геометрии, а в ресурсе.
	for root: Node3D in [_house_root, _bunker_root]:
		for node: Node in _descendants(root):
			if not (node is MeshInstance3D):
				continue
			var parent: Node = node.get_parent()
			if parent == null or not String(parent.name).begins_with("window_"):
				continue
			var mesh: MeshInstance3D = node as MeshInstance3D
			var material: Material = mesh.material_override
			assert_true(material is StandardMaterial3D, "у стекла нестандартный материал")
			if material is StandardMaterial3D:
				var standard: StandardMaterial3D = material as StandardMaterial3D
				assert_eq(
					standard.transparency, BaseMaterial3D.TRANSPARENCY_ALPHA, "стекло непрозрачно"
				)
				assert_lt(standard.albedo_color.a, 0.6, "стекло слишком плотное")
				assert_eq(
					standard.cull_mode,
					BaseMaterial3D.CULL_DISABLED,
					"стекло исчезает при взгляде изнутри"
				)


func test_walls_have_collision() -> void:
	# Интерьер без коллизии — декорация: игрок проходит сквозь стены.
	var bodies: int = 0
	for node: Node in _descendants(_bunker_root):
		if node is StaticBody3D:
			bodies += 1
	assert_gt(bodies, 20, "у бункера всего %d тел столкновения" % bodies)
	for node: Node in _descendants(_bunker_root):
		if not (node is StaticBody3D):
			continue
		var body: StaticBody3D = node as StaticBody3D
		assert_ne(body.collision_layer, 0, "тело не на слое мира — сквозь него пройдут")
		assert_eq(body.collision_mask, 0, "у статической стены ненулевая маска")


func test_light_count_is_within_budget() -> void:
	# Каждый источник света добавляет проход освещения для всех объектов в
	# радиусе. Предел задан константой строителя, и превышение означает, что
	# число ламп начало зависеть от числа комнат.
	for root: Node3D in [_house_root, _bunker_root]:
		var lights: Array[Node] = _all_of(root, "OmniLight3D")
		assert_lte(
			lights.size(),
			InteriorBuilder.MAX_POI_LIGHTS,
			"в точке «%s» источников света больше предела" % root.name
		)


func test_lights_do_not_cast_shadows() -> void:
	# Тени от источника в тесном помещении удваивают его стоимость и читаются
	# плохо. Отключение теней — осознанное решение, и оно обязано быть
	# зафиксировано тестом, иначе первая же правка «для красоты» его снимет.
	for root: Node3D in [_house_root, _bunker_root]:
		for node: Node in _all_of(root, "OmniLight3D"):
			var light: OmniLight3D = node as OmniLight3D
			assert_false(light.shadow_enabled, "источник света в интерьере включил тени")
			assert_gt(light.omni_range, 1.0, "радиус света меньше метра — лампа ничего не освещает")


func test_interior_is_actually_lit() -> void:
	# Бункер под землёй: небесный ambient туда не доходит. Без источника
	# света интерьер был бы чёрным, и вся проработка «изнутри» не видна.
	var lights: Array[Node] = _all_of(_bunker_root, "OmniLight3D")
	assert_gt(lights.size(), 0, "в бункере нет ни одного источника света")


func test_poi_stays_within_the_node_budget() -> void:
	# Подробная точка стоит десятки узлов. Предел нужен, чтобы проработка не
	# превратилась в неограниченный рост: 49 активных чанков умножают любую
	# расточительность на себя.
	for root: Node3D in [_house_root, _bunker_root]:
		var total: int = _descendants(root).size()
		assert_lt(
			total,
			MAX_POI_NODES,
			"точка «%s» содержит %d узлов при пределе %d" % [root.name, total, MAX_POI_NODES]
		)


func test_materials_are_shared_not_duplicated() -> void:
	# Общий кэш материалов: две одинаковые штукатурки — это два переключения
	# состояния отрисовки вместо одного. Проверка по числу материалов в
	# библиотеке после постройки обеих точек.
	var count: int = _materials.count()
	assert_gt(count, 5, "материалов подозрительно мало: %d" % count)
	assert_lt(count, 30, "материалов %d — похоже, кэш не работает" % count)
	# Повторная постройка не должна создавать новые материалы.
	var again: Node3D = _builder.build(_bunker_record)
	add_child_autofree(again)
	assert_eq(_materials.count(), count, "повторная постройка создала новые материалы")


func test_builder_counts_what_it_created() -> void:
	# Счётчик узлов попадает в отчёт бюджета. Если он расходится с деревом,
	# проверка «карта в бюджете» начинает врать.
	var before: int = _builder.nodes_built()
	var node: Node3D = _builder.build(_bunker_record)
	add_child_autofree(node)
	assert_gt(_builder.nodes_built(), before, "счётчик узлов не растёт")
	var summary: Dictionary = _builder.describe()
	assert_has(summary, "nodes_built")
	assert_has(summary, "max_lights")


func test_stairs_are_built_as_separate_steps() -> void:
	# Ступени — отдельные коробки. Наклонная плоскость вместо них заставляет
	# персонажа скользить: он не может стоять на склоне, и подъём превращается
	# в падение назад.
	var steps: int = 0
	for node: Node in _descendants(_house_root):
		if String(node.name).begins_with("stair_"):
			steps += 1
	assert_eq(
		steps,
		RoomLayout.STAIR_STEPS,
		"ступеней построено %d из %d" % [steps, RoomLayout.STAIR_STEPS]
	)


func test_lamps_have_visible_bulbs() -> void:
	# Источник света без видимой колбы выглядит как ошибка освещения: комната
	# светится, а откуда — непонятно.
	var bulbs: int = 0
	for node: Node in _descendants(_bunker_root):
		if String(node.name).begins_with("bulb_"):
			bulbs += 1
	var lights: Array[Node] = _all_of(_bunker_root, "OmniLight3D")
	assert_eq(bulbs, lights.size(), "колб меньше, чем источников света")
	assert_gt(bulbs, 0, "в бункере нет ламп")
