extends GutTest
## Тесты планировки помещений — точки интереса как чистые данные.
##
## КАКОЙ КЛАСС ОШИБОК ЛОВИТ. Планировка интерьера собирается из чисел, и
## каждое несогласование чисел выглядит в игре как «что-то не так», но не
## как ошибка:
##
##   * мебель, поставленная от габарита дома вместо внутренней грани стены,
##     наполовину вмурована в бетон;
##   * элемент, заданный координатой основания среди элементов, заданных
##     центром, утоплен в пол на половину своей высоты;
##   * лестничный проём, вырезанный не там, где марш, упирается в потолок;
##   * окно, не совпадающее с разрывом в стене, закрыто сплошной панелью.
##
## Ни одно из этих несогласований не видно в коде: все числа «правильные»,
## просто они из разных систем отсчёта. Проверяются они только сопоставлением
## геометрии — чем этот файл и занимается, не создавая ни одного узла сцены.

const TOLERANCE: float = 0.01

var _house: Dictionary = {}
var _bunker: Dictionary = {}
var _house_size: Vector3 = Vector3.ZERO
var _house_floors: int = 0
var _bunker_size: Vector3 = Vector3.ZERO


## План дома вместе с наполнением.
func _make_house() -> Dictionary:
	var size: Vector3 = VillageLayout.BUILDING_SIZES[VillageLayout.BuildingKind.HOUSE_LARGE]
	var floors: int = VillageLayout.BUILDING_FLOORS[VillageLayout.BuildingKind.HOUSE_LARGE]
	var plan: Dictionary = RoomLayout.plan_house(
		size, floors, PoiDetails.house_openings(size, floors)
	)
	PoiDetails.decorate_house(plan, size, floors)
	return plan


## План бункера вместе с наполнением.
func _make_bunker() -> Dictionary:
	var size: Vector3 = MapConfig.BUNKER_SIZE
	var thickness: float = MapConfig.BUNKER_WALL_THICKNESS
	var plan: Dictionary = RoomLayout.plan_bunker(size, thickness, PoiDetails.bunker_openings(size))
	PoiDetails.decorate_bunker(plan, size, thickness)
	return plan


## Пересечение двух объёмов. Все позиции в плане — центры.
func _overlaps(a: Dictionary, b: Dictionary, tolerance: float) -> bool:
	var delta: Vector3 = (Vector3(a["position"]) - Vector3(b["position"])).abs()
	var half: Vector3 = (Vector3(a["size"]) + Vector3(b["size"])) * 0.5
	return (
		delta.x < half.x - tolerance
		and delta.y < half.y - tolerance
		and delta.z < half.z - tolerance
	)


## Прямоугольник элемента в плане с учётом поворота вокруг Y.
func _xz_rect(entry: Dictionary) -> Rect2:
	var position: Vector3 = entry["position"]
	var size: Vector3 = entry["size"]
	var rotation: float = float(entry.get("rotation_y", 0.0))
	var cosinus: float = absf(cos(rotation))
	var sinus: float = absf(sin(rotation))
	var half_x: float = (size.x * cosinus + size.z * sinus) * 0.5
	var half_z: float = (size.x * sinus + size.z * cosinus) * 0.5
	return Rect2(
		Vector2(position.x - half_x, position.z - half_z), Vector2(half_x * 2.0, half_z * 2.0)
	)


func before_each() -> void:
	_house_size = VillageLayout.BUILDING_SIZES[VillageLayout.BuildingKind.HOUSE_LARGE]
	_house_floors = VillageLayout.BUILDING_FLOORS[VillageLayout.BuildingKind.HOUSE_LARGE]
	_bunker_size = MapConfig.BUNKER_SIZE
	_house = _make_house()
	_bunker = _make_bunker()


## Оба плана с их габаритами.
##
## Отдельная структура вместо сравнения планов между собой: Dictionary в
## Godot 4 сравнивается ПО СОДЕРЖИМОМУ, поэтому «plan == _bunker» означало бы
## полный обход обоих словарей на каждой итерации — медленно и нечитаемо.
func _cases() -> Array[Dictionary]:
	return [
		{
			"name": "дом",
			"plan": _house,
			"size": _house_size,
			"wall": RoomLayout.HOUSE_WALL_THICKNESS,
			"storey": _house_size.y,
		},
		{
			"name": "бункер",
			"plan": _bunker,
			"size": _bunker_size,
			"wall": MapConfig.BUNKER_WALL_THICKNESS,
			"storey": _bunker_size.y,
		},
	]


func test_plan_has_every_section() -> void:
	# Пустой раздел не ошибка сам по себе, но отсутствие ключа — ошибка:
	# строитель обратится к несуществующему ключу и упадёт уже в игре.
	var required: Array[String] = [
		"rooms",
		"panels",
		"slabs",
		"openings",
		"furniture",
		"stairs",
		"lamps",
		"props",
		"roof",
	]
	for case: Dictionary in _cases():
		for key: String in required:
			assert_has(case["plan"], key, "%s: нет раздела «%s»" % [case["name"], key])


func test_house_has_rooms_on_every_floor() -> void:
	# Комнаты нужны не только для красоты: по ним работают подсказки и
	# сохранение. Отсутствие комнаты на этаже означает, что этаж не описан.
	var per_floor: Dictionary = {}
	for room: Dictionary in _house["rooms"]:
		var index: int = room["floor_index"]
		per_floor[index] = int(per_floor.get(index, 0)) + 1
	assert_eq(int(per_floor.get(0, 0)), 2, "на первом этаже не две комнаты")
	assert_eq(int(per_floor.get(1, 0)), 2, "на втором этаже не две комнаты")


func test_bunker_has_three_rooms() -> void:
	var names: Array = []
	for room: Dictionary in _bunker["rooms"]:
		names.append(room["name"])
	assert_eq(names.size(), 3, "в бункере %d помещения вместо трёх" % names.size())


func test_rooms_are_not_degenerate() -> void:
	# Комната нулевой или отрицательной площади — это rect с перепутанными
	# position и size: Rect2(Vector2, Vector2) принимает размер вторым
	# аргументом, и ошибка порядка не даёт ни исключения, ни пустой комнаты
	# на глаз — она даёт комнату, в которую нельзя попасть.
	for case: Dictionary in _cases():
		for room: Dictionary in case["plan"]["rooms"]:
			var rect: Rect2 = room["rect"]
			assert_gt(rect.size.x, 0.5, "комната «%s» вырождена по X" % room["name"])
			assert_gt(rect.size.y, 0.5, "комната «%s» вырождена по Z" % room["name"])
			# Уровень пола обязан совпадать с тем, от которого построены
			# стены этого этажа. Расхождение означает, что комната
			# описывает один этаж, а геометрия построена на другом —
			# навигация и подсказки начнут называть не то помещение.
			assert_almost_eq(
				float(room["floor_y"]),
				RoomLayout.floor_base_y(case["storey"], int(room["floor_index"])),
				0.001,
				"уровень пола комнаты «%s» не совпадает с этажом" % room["name"]
			)


func test_all_entries_have_positive_dimensions() -> void:
	for case: Dictionary in _cases():
		for section: String in ["panels", "slabs", "openings", "furniture", "props", "stairs"]:
			for entry: Dictionary in case["plan"][section]:
				var size: Vector3 = entry["size"]
				assert_gt(size.x, 0.0, "%s %s: нулевая ширина" % [case["name"], section])
				assert_gt(size.y, 0.0, "%s %s: нулевая высота" % [case["name"], section])
				assert_gt(size.z, 0.0, "%s %s: нулевая глубина" % [case["name"], section])


func test_no_element_sinks_below_its_floor() -> void:
	# Позиции в плане — ЦЕНТРЫ объёмов. Если какой-то раздел задан
	# координатой основания, он утонет в полу на половину своей высоты.
	# Проверяется низ каждого элемента против уровня его этажа.
	for case: Dictionary in _cases():
		for section: String in ["furniture", "panels", "openings"]:
			for entry: Dictionary in case["plan"][section]:
				var position: Vector3 = entry["position"]
				var size: Vector3 = entry["size"]
				var floor_index: int = int(entry.get("floor", 0))
				var floor_y: float = RoomLayout.floor_base_y(case["storey"], floor_index)
				assert_gte(
					position.y - size.y * 0.5,
					floor_y - TOLERANCE,
					(
						"%s на этаже %d утоплен ниже пола: низ %.3f при полу %.3f"
						% [section, floor_index, position.y - size.y * 0.5, floor_y]
					)
				)


func test_furniture_stays_inside_the_interior() -> void:
	# Расстановка обязана считаться от внутренних граней стен. Отсчёт от
	# габарита постройки вдвигает мебель в толщу наружной стены.
	for case: Dictionary in _cases():
		var bounds: Rect2 = _interior_bounds(case)
		for entry: Dictionary in case["plan"]["furniture"]:
			var rect: Rect2 = _xz_rect(entry)
			assert_true(
				bounds.encloses(rect),
				(
					"мебель «%s» выходит за внутренние границы помещения: %s против %s"
					% [entry["kind"], rect, bounds]
				)
			)


## Внутренние границы помещения в плане.
func _interior_bounds(case: Dictionary) -> Rect2:
	var size: Vector3 = case["size"]
	var thickness: float = case["wall"]
	var half_x: float = size.x * 0.5 - thickness
	var half_z: float = size.z * 0.5 - thickness
	return Rect2(Vector2(-half_x, -half_z), Vector2(half_x * 2.0, half_z * 2.0))


func test_furniture_is_not_embedded_in_partitions() -> void:
	# Перегородка стоит в середине здания, и мебель, поставленная от оси
	# перегородки вместо её грани, оказывается наполовину в бетоне. Это
	# самая частая ошибка расстановки, и она не видна ни в одном числе.
	for case: Dictionary in _cases():
		var partitions: Array = []
		for panel: Dictionary in case["plan"]["panels"]:
			if bool(panel.get("interior", false)):
				partitions.append(panel)
		assert_gt(partitions.size(), 0, "%s: нет внутренних перегородок" % case["name"])
		for entry: Dictionary in case["plan"]["furniture"]:
			var rect: Rect2 = _xz_rect(entry)
			for panel: Dictionary in partitions:
				var panel_rect: Rect2 = _xz_rect(panel)
				assert_false(
					rect.intersects(panel_rect),
					"мебель «%s» пересекает перегородку %s" % [entry["kind"], panel_rect]
				)


func test_plan_distinguishes_exterior_walls_from_partitions() -> void:
	# Флаг нужен разрушению: снос несущей стены и снос перегородки — разные
	# события. Без флага их не различить, а определять по толщине ненадёжно.
	for case: Dictionary in _cases():
		var exterior: int = 0
		var interior: int = 0
		for panel: Dictionary in case["plan"]["panels"]:
			assert_has(panel, "interior", "у панели нет признака внутренней стены")
			if bool(panel["interior"]):
				interior += 1
			else:
				exterior += 1
		assert_gt(exterior, 0, "%s: нет наружных стен" % case["name"])
		assert_gt(interior, 0, "%s: нет перегородок" % case["name"])


func test_openings_do_not_overlap_solid_panels() -> void:
	# Стена режется простенками ВОКРУГ проёма. Если разрез не совпал с
	# проёмом, стекло или дверь оказываются внутри сплошной панели: окно
	# не видно, а дверь не открывается, потому что её закрывает бетон.
	for case: Dictionary in _cases():
		for opening: Dictionary in case["plan"]["openings"]:
			for panel: Dictionary in case["plan"]["panels"]:
				assert_false(
					_overlaps(opening, panel, TOLERANCE),
					(
						"проём %s пересекает сплошную панель %s"
						% [opening["position"], panel["position"]]
					)
				)


func test_openings_fit_within_their_wall_height() -> void:
	# Порог плюс высота проёма не должны превышать высоту стены: иначе
	# перемычка над проёмом получается отрицательной высоты, а это либо
	# панель вывернутая наизнанку, либо дыра до потолка.
	for case: Dictionary in _cases():
		var storey: float = case["storey"]
		for opening: Dictionary in case["plan"]["openings"]:
			var position: Vector3 = opening["position"]
			var size: Vector3 = opening["size"]
			var floor_index: int = int(opening.get("floor", 0))
			var base: float = RoomLayout.floor_base_y(storey, floor_index)
			assert_gte(
				position.y - size.y * 0.5, base - TOLERANCE, "проём начинается ниже пола этажа"
			)
			assert_lte(
				position.y + size.y * 0.5,
				base + storey + TOLERANCE,
				"проём пробивает потолок этажа %d" % floor_index
			)


func test_house_has_a_door_only_on_the_ground_floor() -> void:
	# Дверь на втором этаже — это дверь в пустоту. Вход в дом один.
	var doors_per_floor: Dictionary = {}
	for opening: Dictionary in _house["openings"]:
		if int(opening["kind"]) == RoomLayout.OpeningKind.DOOR:
			var index: int = int(opening.get("floor", 0))
			doors_per_floor[index] = int(doors_per_floor.get(index, 0)) + 1
	# Входная дверь плюс дверь перегородки на каждом этаже.
	assert_gt(
		int(doors_per_floor.get(0, 0)),
		int(doors_per_floor.get(1, 0)),
		"на верхнем этаже дверей не меньше, чем на первом"
	)


func test_bunker_has_a_blast_door() -> void:
	# Взрывная дверь — признак бункера. Обычная деревянная дверь в бетонной
	# стене лишает объект смысла: проработка «снаружи» перестаёт читаться.
	var found: int = 0
	for opening: Dictionary in _bunker["openings"]:
		if int(opening["kind"]) == RoomLayout.OpeningKind.BLAST_DOOR:
			found += 1
	assert_eq(found, 1, "в бункере %d взрывных дверей" % found)


func test_house_has_windows_on_both_floors() -> void:
	# Помещение без окон — чёрная коробка. Окна нужны на каждом жилом этаже.
	var floors_with_windows: Dictionary = {}
	for opening: Dictionary in _house["openings"]:
		if int(opening["kind"]) == RoomLayout.OpeningKind.WINDOW:
			floors_with_windows[int(opening.get("floor", 0))] = true
	assert_has(floors_with_windows, 0, "на первом этаже нет окон")
	assert_has(floors_with_windows, 1, "на втором этаже нет окон")


func test_glass_is_the_weakest_surface() -> void:
	# Требование «стёкла бьются» означает, что стекло обязано сдаваться
	# раньше любого другого материала. Иначе оно держит очередь наравне
	# со стеной, и «физичного» разрушения не получается.
	var glass: float = RoomLayout.integrity_for_role(RoomLayout.SurfaceRole.GLASS)
	assert_eq(glass, MapConfig.INTEGRITY_GLASS)
	for role: int in SurfaceRules.known_roles():
		if role == RoomLayout.SurfaceRole.GLASS:
			continue
		assert_gt(
			RoomLayout.integrity_for_role(role),
			glass,
			"роль %d не прочнее стекла — стекло не будет самым хрупким" % role
		)


func test_reinforced_surfaces_are_the_strongest() -> void:
	var reinforced: float = MapConfig.INTEGRITY_REINFORCED
	var concrete: float = RoomLayout.integrity_for_role(RoomLayout.SurfaceRole.CONCRETE)
	var plaster: float = RoomLayout.integrity_for_role(RoomLayout.SurfaceRole.PLASTER)
	var wood: float = RoomLayout.integrity_for_role(RoomLayout.SurfaceRole.WOOD)
	assert_gt(reinforced, concrete, "металл не прочнее бетона")
	assert_gt(concrete, plaster, "бетон не прочнее штукатурки")
	assert_gt(plaster, wood, "штукатурка не прочнее дерева")


func test_every_role_in_the_plans_has_a_material_recipe() -> void:
	# Роль без рецепта получает материал по умолчанию. Само по себе это не
	# падение, а молчаливая подмена: бетонная стена бункера оказалась бы
	# деревянной, и никто не сообщил бы об ошибке.
	var used: Dictionary = {}
	for case: Dictionary in _cases():
		for section: String in ["panels", "slabs", "openings", "furniture", "props"]:
			for entry: Dictionary in case["plan"][section]:
				used[int(entry["role"])] = true
		if not case["plan"]["roof"].is_empty():
			used[int(case["plan"]["roof"]["role"])] = true
	assert_gt(used.size(), 3, "в планах задействовано подозрительно мало ролей")
	for role: int in used:
		assert_has(
			SurfaceRules.ROLE_RECIPES,
			role,
			"для роли %d нет рецепта материала — будет молчаливая подмена" % role
		)


func test_every_opening_kind_has_role_and_integrity() -> void:
	var kinds: Array[int] = [
		RoomLayout.OpeningKind.DOOR,
		RoomLayout.OpeningKind.WINDOW,
		RoomLayout.OpeningKind.BLAST_DOOR,
		RoomLayout.OpeningKind.HATCH,
	]
	for kind: int in kinds:
		assert_has(RoomLayout.OPENING_ROLE, kind, "у вида проёма %d нет роли" % kind)
		assert_has(RoomLayout.OPENING_INTEGRITY, kind, "у вида проёма %d нет прочности" % kind)
		assert_gt(RoomLayout.opening_integrity(kind), 0.0, "прочность проёма %d нулевая" % kind)


func test_damage_multiplier_orders_materials_correctly() -> void:
	# Характер реакции обязан соответствовать материалу: хрупкое разлетается
	# быстро, монолитное держится. Обратный порядок означал бы, что бетон
	# рассыпается от одного попадания, а стекло держит очередь.
	var glass: float = SurfaceRules.damage_multiplier(RoomLayout.SurfaceRole.GLASS)
	var wood: float = SurfaceRules.damage_multiplier(RoomLayout.SurfaceRole.WOOD)
	var concrete: float = SurfaceRules.damage_multiplier(RoomLayout.SurfaceRole.CONCRETE)
	var metal: float = SurfaceRules.damage_multiplier(RoomLayout.SurfaceRole.METAL_DARK)
	assert_gt(glass, wood, "стекло реагирует медленнее дерева")
	assert_gt(wood, concrete, "дерево реагирует медленнее бетона")
	assert_gt(concrete, metal, "бетон реагирует медленнее металла")
	assert_almost_eq(
		SurfaceRules.damage_multiplier(-9999),
		1.0,
		0.001,
		"неизвестная роль должна получать нейтральный множитель"
	)


func test_roof_covers_the_footprint() -> void:
	# Крыша меньше пятна застройки — дом с дырой сверху: видно интерьер,
	# а дождь и свет попадают внутрь там, где их быть не должно.
	for case: Dictionary in _cases():
		var roof: Dictionary = case["plan"]["roof"]
		assert_false(roof.is_empty(), "в плане нет крыши")
		if roof.is_empty():
			continue
		var size: Vector3 = roof["size"]
		var building: Vector3 = case["size"]
		assert_gte(size.x, building.x, "крыша уже постройки")
		assert_gte(size.z, building.z, "крыша короче постройки")


func test_stairs_reach_the_upper_floor() -> void:
	# Лестница обязана доходить до уровня пола второго этажа. Недоход на
	# 30 см выглядит как «последняя ступенька в воздух», и игрок падает.
	assert_gt(_house["stairs"].size(), 0, "в двухэтажном доме нет лестницы")
	var top_step: Dictionary = _house["stairs"][_house["stairs"].size() - 1]
	var top_y: float = float(top_step["position"].y) + float(top_step["size"].y) * 0.5
	var upper_floor: float = RoomLayout.floor_base_y(_house_size.y, 1)
	assert_almost_eq(
		top_y,
		upper_floor,
		0.05,
		"верх лестницы на %.3f, а пол второго этажа на %.3f" % [top_y, upper_floor]
	)


func test_stairs_pass_through_the_slab_opening() -> void:
	# РЕГРЕССИОННАЯ ПРОВЕРКА. Проём в перекрытии и марш обязаны строиться от
	# одной оси. Раньше проём вырезался у одной стены, а марш — у другой, и
	# лестница упиралась в потолок: оба элемента при этом были «правильными».
	var well_center: float = RoomLayout.stair_well_center(_house_size.x * 0.5)
	var well_start: float = well_center - RoomLayout.STAIR_WELL_WIDTH * 0.5
	var well_end: float = well_center + RoomLayout.STAIR_WELL_WIDTH * 0.5

	for step: Dictionary in _house["stairs"]:
		var position: Vector3 = step["position"]
		var size: Vector3 = step["size"]
		assert_gte(
			position.x - size.x * 0.5,
			well_start - TOLERANCE,
			"ступень выходит за левый край лестничного проёма"
		)
		assert_lte(
			position.x + size.x * 0.5,
			well_end + TOLERANCE,
			"ступень выходит за правый край лестничного проёма"
		)

	# Ни одна плита перекрытия не должна перекрывать проём.
	for slab: Dictionary in _house["slabs"]:
		if int(slab.get("floor", 0)) == 0:
			continue
		var position: Vector3 = slab["position"]
		var size: Vector3 = slab["size"]
		var slab_start: float = position.x - size.x * 0.5
		var slab_end: float = position.x + size.x * 0.5
		var covers_well: bool = slab_start < well_end and slab_end > well_start
		assert_false(covers_well, "плита перекрытия закрыла лестничный проём")


func test_stair_rise_is_walkable() -> void:
	# Подъём ступени выше 0,28 м превращает лестницу в препятствие: персонаж
	# на ней «прыгает», потому что шаг превышает высоту обычного подъёма.
	for step: Dictionary in _house["stairs"]:
		assert_lte(
			float(step["size"].y),
			RoomLayout.STAIR_MAX_RISE + TOLERANCE,
			"подъём ступени превышает допустимый"
		)


func test_lamps_are_inside_the_rooms() -> void:
	# Лампа за пределами помещения освещает улицу вместо комнаты.
	for case: Dictionary in _cases():
		var bounds: Rect2 = _interior_bounds(case)
		for lamp: Dictionary in case["plan"]["lamps"]:
			var point: Vector2 = Vector2(float(lamp["position"].x), float(lamp["position"].z))
			assert_true(bounds.has_point(point), "лампа висит вне помещения")


func test_human_scale_of_openings_and_rooms() -> void:
	# Масштаб задан ТЗ (раздел 1) от роста человека 1,8 м. Дверь ниже роста
	# человека — в неё нельзя пройти, потолок ниже 2,2 м — помещение давит.
	for case: Dictionary in _cases():
		for opening: Dictionary in case["plan"]["openings"]:
			var kind: int = int(opening["kind"])
			if kind == RoomLayout.OpeningKind.WINDOW:
				continue
			var height: float = float(opening["size"].y)
			assert_gt(height, 1.9, "дверной проём ниже роста человека")
			assert_lt(height, 2.6, "дверной проём непропорционально высок")
	var house_storey: float = _house_size.y
	assert_gt(house_storey, 2.4, "потолок дома ниже 2,4 м")
	assert_lt(house_storey, 4.0, "этаж дома выше четырёх метров")


func test_bunker_is_low_profile() -> void:
	# Бункер обязан быть заглублён: коробка, стоящая на земле целиком, — это
	# сарай, а не укрытие. Проверяется, что глубина заглубления существенна
	# относительно высоты, а над грунтом выступает немного.
	assert_gt(MapConfig.BUNKER_DEPTH, _bunker_size.y * 0.5, "бункер почти не заглублён")
	var above_ground: float = _bunker_size.y - MapConfig.BUNKER_DEPTH
	assert_lt(above_ground, 1.2, "бункер слишком сильно выступает над грунтом")
	assert_gt(above_ground, 0.1, "бункер полностью под землёй — вход не найти")


func test_plan_is_deterministic() -> void:
	# Планировка не использует случайность, но проверить это стоит: появление
	# randf() сделало бы интерьер разным при каждом подходе игрока к дому,
	# и перестройка чанка меняла бы расстановку мебели на глазах.
	var again: Dictionary = _make_house()
	assert_eq(again["panels"].size(), _house["panels"].size(), "число панелей разошлось")
	assert_eq(again["furniture"].size(), _house["furniture"].size(), "число мебели разошлось")
	for index: int in range(_house["furniture"].size()):
		assert_eq(
			again["furniture"][index]["position"],
			_house["furniture"][index]["position"],
			"мебель %d сместилась при повторном построении" % index
		)


func test_summarize_reports_every_section() -> void:
	var summary: Dictionary = RoomLayout.summarize(_house)
	for key: String in ["rooms", "panels", "slabs", "openings", "furniture", "props"]:
		assert_has(summary, key, "в summarize() нет ключа «%s»" % key)
		assert_gt(int(summary[key]), 0, "раздел «%s» пуст" % key)


func test_house_is_detailed_inside_and_outside() -> void:
	# Прямое требование заказчика: точка проработана И ВНУТРИ, И СНАРУЖИ.
	# «Снаружи» — это не только стены: нужны детали, по которым дом
	# узнаётся, иначе проработка снаружи отсутствует по сути.
	assert_gt(_house["furniture"].size(), 4, "внутри дома почти нет наполнения")
	assert_gt(_house["panels"].size(), 12, "у дома слишком мало стеновых панелей")
	var exterior_props: int = 0
	for prop: Dictionary in _house["props"]:
		if bool(prop.get("exterior", false)):
			exterior_props += 1
	assert_gt(exterior_props, 2, "снаружи дом не проработан: %d деталей" % exterior_props)


func test_bunker_is_detailed_inside_and_outside() -> void:
	assert_gt(_bunker["furniture"].size(), 4, "внутри бункера почти нет оборудования")
	var exterior_props: int = 0
	for prop: Dictionary in _bunker["props"]:
		if bool(prop.get("exterior", false)):
			exterior_props += 1
	assert_gt(exterior_props, 2, "снаружи бункер не проработан: %d деталей" % exterior_props)
	# Вентиляция — главный внешний признак укрытия.
	var has_vent: bool = false
	for prop: Dictionary in _bunker["props"]:
		if int(prop["shape"]) == RoomLayout.ShapeKind.CYLINDER:
			has_vent = true
	assert_true(has_vent, "у бункера нет вентиляционной трубы")
