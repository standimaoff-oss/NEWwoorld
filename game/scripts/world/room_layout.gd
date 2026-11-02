class_name RoomLayout
extends RefCounted
## Внутренняя планировка точки интереса — как чистые данные.
##
## ЗАЧЕМ ДАННЫЕ ОТДЕЛЕНЫ ОТ УЗЛОВ. То же разделение, что между VillageLayout и
## ChunkBuilder: планировка решает, ГДЕ что стоит, строитель — КАК превратить
## это в узлы, материалы и коллизии. Выгода практическая: план проверяется
## тестами без единого узла сцены. «Стена пересекает проём», «окно выше
## потолка», «комната замурована» ловится на числах за миллисекунды вместо
## поиска глазами на собранной сцене.
##
## СИСТЕМА КООРДИНАТ. Локальные координаты постройки: начало — центр пятна
## застройки на уровне пола первого этажа, X и Z вдоль стен, Y вверх.
## Абсолютные позицию и поворот задаёт строитель чанков. ВСЕ ПОЗИЦИИ — ЦЕНТРЫ
## объёмов, а не их основания; нарушение соглашения на одном типе элементов
## топит этот тип в пол на половину высоты.
##
## СТЕНЫ ТОЛЬКО ОСЕВЫЕ — вдоль X и вдоль Z. Диагональных стен в деревенском
## доме и в бункере не бывает, а их поддержка потребовала бы поворачивать
## каждый проём и простенок: стоимость не окупается.

## Роль поверхности — ключ палитры, а не материал напрямую.
enum SurfaceRole {
	PLASTER,
	WOOD,
	WOOD_DARK,
	CONCRETE,
	TILE,
	METAL,
	METAL_DARK,
	FABRIC,
	STONE,
	GLASS,
	LAMP,
	ROOF,
}

## Вид проёма.
enum OpeningKind {
	DOOR,
	WINDOW,
	BLAST_DOOR,
	HATCH,
}

## Вид мебели и оборудования.
enum FurnitureKind {
	TABLE,
	CHAIR,
	BED,
	SHELF,
	STOVE,
	CRATE,
	BARREL,
	BUNK_BED,
	LOCKER,
	MAP_TABLE,
}

## Форма примитива для декоративных элементов.
enum ShapeKind {
	BOX,
	CYLINDER,
	PRISM,
}

## ------------------------------------------------------------------------
##  Прочность материалов и заполнений проёмов
## ------------------------------------------------------------------------
##
## Живут рядом с перечислениями, которыми ключуются. Вынести их в SurfaceRules
## нельзя: этот файл обращается к ним при постройке каждой панели, и вынос
## создал бы цикл RoomLayout -> SurfaceRules -> RoomLayout.

## Прочность по роли поверхности.
const ROLE_INTEGRITY: Dictionary = {
	SurfaceRole.CONCRETE: MapConfig.INTEGRITY_CONCRETE,
	SurfaceRole.TILE: MapConfig.INTEGRITY_CONCRETE * 0.6,
	SurfaceRole.STONE: MapConfig.INTEGRITY_BRICK,
	SurfaceRole.PLASTER: MapConfig.INTEGRITY_BRICK,
	SurfaceRole.METAL: MapConfig.INTEGRITY_REINFORCED,
	SurfaceRole.METAL_DARK: MapConfig.INTEGRITY_REINFORCED,
	SurfaceRole.GLASS: MapConfig.INTEGRITY_GLASS,
	SurfaceRole.ROOF: MapConfig.INTEGRITY_WOOD * 1.2,
}

## Множитель накопления урона по роли поверхности.
##
## Прочность уже различает материалы, поэтому множитель не дублирует её, а
## задаёт ХАРАКТЕР реакции: стекло разлетается от малого попадания, бетон
## держит очередь. Без множителя разница сводилась бы только к числу
## попаданий, и все материалы ощущались одинаково «плотными».

## Прочность заполнения проёма по виду проёма.
const OPENING_INTEGRITY: Dictionary = {
	OpeningKind.BLAST_DOOR: MapConfig.INTEGRITY_REINFORCED,
	OpeningKind.HATCH: MapConfig.INTEGRITY_METAL_DOOR,
	OpeningKind.DOOR: MapConfig.INTEGRITY_WOOD,
	OpeningKind.WINDOW: MapConfig.INTEGRITY_GLASS,
}

## Роль поверхности заполнения проёма.

## Роль поверхности заполнения проёма.
const OPENING_ROLE: Dictionary = {
	OpeningKind.WINDOW: SurfaceRole.GLASS,
	OpeningKind.BLAST_DOOR: SurfaceRole.METAL_DARK,
	OpeningKind.HATCH: SurfaceRole.METAL,
	OpeningKind.DOOR: SurfaceRole.WOOD_DARK,
}

## Толщина наружной стены дома, м.
const HOUSE_WALL_THICKNESS: float = 0.3
## Толщина внутренней перегородки дома, м.
const HOUSE_PARTITION_THICKNESS: float = 0.15
## Толщина перегородки бункера, м.
const BUNKER_PARTITION_THICKNESS: float = 0.4
## Толщина перекрытия между этажами, м.
const SLAB_THICKNESS: float = 0.2
## Высота дверного проёма, м. Немного выше роста человека (1,8 м по ТЗ):
## в проём впритык игрок упирается камерой.
const DOOR_HEIGHT: float = 2.05
## Ширина дверного проёма, м.
const DOOR_WIDTH: float = 0.95
## Высота порога окна от пола, м.
const WINDOW_SILL: float = 0.95
## Высота окна, м.
const WINDOW_HEIGHT: float = 1.15
## Ширина окна, м.
const WINDOW_WIDTH: float = 1.3
## Высота взрывной двери бункера, м.
const BLAST_DOOR_HEIGHT: float = 2.1
## Ширина взрывной двери бункера, м.
const BLAST_DOOR_WIDTH: float = 1.2
## Положение перегородки дома как доля полуширины.
##
## Общая для стен и для мебели по той же причине, что и константы бункера:
## мебель, поставленная от другого числа, окажется вмурованной в стену.
const HOUSE_PARTITION_X_RATIO: float = 0.25
## Положение вертикальной перегородки бункера как доля полуширины.
##
## Значение общее для стен и для мебели. Дублирование числа в двух файлах
## привело бы к тому, что койки и ящики встали бы в бетон — визуально
## неотличимо от ошибки расстановки, но ищется часами.
const BUNKER_PARTITION_X_RATIO: float = -0.25
## Положение горизонтальной перегородки бункера как доля полуширины.
const BUNKER_PARTITION_Z_RATIO: float = 0.15
## Число ступеней лестницы.
const STAIR_STEPS: int = 12
## Ширина лестничного проёма в перекрытии, м.
const STAIR_WELL_WIDTH: float = 1.3
## Положение оси лестничного проёма как доля полуширины дома.
##
## Одно число и для проёма в перекрытии, и для самого марша. Раньше проём
## вырезался у одной стены, а марш строился у другой — и лестница упиралась
## в потолок. По коду оба элемента при этом построены правильно.
const STAIR_WELL_X_RATIO: float = 0.64
## Предельный подъём одной ступени, м. 0,28 — граница удобного шага:
## выше по лестнице приходится карабкаться, а персонаж на ступенях
## начинает «прыгать», потому что подъём превышает высоту обычного шага.
const STAIR_MAX_RISE: float = 0.28


## Прочность по роли поверхности.
static func integrity_for_role(role: int) -> float:
	return float(ROLE_INTEGRITY.get(role, MapConfig.INTEGRITY_WOOD))


## Прочность заполнения проёма.


## Прочность заполнения проёма.
static func opening_integrity(kind: int) -> float:
	return float(OPENING_INTEGRITY.get(kind, MapConfig.INTEGRITY_WOOD))


## Роль поверхности заполнения проёма.


## Роль поверхности заполнения проёма.
static func opening_role(kind: int) -> int:
	return int(OPENING_ROLE.get(kind, SurfaceRole.WOOD))


## Строит план деревенского дома — точка интереса 1.
##
## Дом двухэтажный: внизу общая комната с печью и кухня-прихожая, наверху
## спальня. Такое деление даёт осмысленный интерьер, а не одну коробку.
static func plan_house(size: Vector3, floors: int, openings: Dictionary) -> Dictionary:
	var plan: Dictionary = _empty_plan()
	var half_x: float = size.x * 0.5
	var half_z: float = size.z * 0.5
	var wall: float = HOUSE_WALL_THICKNESS
	var storey: float = size.y

	for floor_index: int in range(maxi(floors, 1)):
		var first_panel: int = plan["panels"].size()
		var first_opening: int = plan["openings"].size()
		var first_slab: int = plan["slabs"].size()
		var base_y: float = floor_base_y(storey, floor_index)
		var height: float = storey - (SLAB_THICKNESS if floor_index > 0 else 0.0)
		_shell(
			plan,
			half_x,
			half_z,
			wall,
			base_y,
			height,
			SurfaceRole.PLASTER,
			openings.get(floor_index, {})
		)
		# Одна перегородка на этаж делит дом на две комнаты. Без неё
		# интерьер — пустая коробка, и проработка «изнутри» не читается.
		var partition_x: float = half_x * HOUSE_PARTITION_X_RATIO
		var first_partition: int = plan["panels"].size()
		_wall(
			plan,
			1,
			partition_x,
			-half_z + wall,
			half_z - wall,
			base_y,
			height,
			HOUSE_PARTITION_THICKNESS,
			SurfaceRole.WOOD,
			[
				{
					"kind": OpeningKind.DOOR,
					"at": -half_z * 0.35,
					"width": DOOR_WIDTH,
					"height": DOOR_HEIGHT,
					"sill": 0.0
				}
			]
		)
		_tag_range(plan, "panels", first_partition, "interior", true)
		_slab(plan, half_x, half_z, base_y, floor_index, SurfaceRole.WOOD_DARK)
		_tag_range(plan, "panels", first_panel, "floor", floor_index)
		_tag_range(plan, "openings", first_opening, "floor", floor_index)
		_tag_range(plan, "slabs", first_slab, "floor", floor_index)

	_plan_stairs(plan, half_x, half_z, storey, floors)
	# Наполнение (мебель, наружные детали, крыша, свет) добавляет вызывающая
	# сторона через PoiDetails.decorate_house(). Вызов его отсюда замкнул бы
	# зависимость в кольцо: PoiDetails и так использует RoomLayout.
	return plan
	# Крыша — двускатная призма. Конёк по центру (left_to_right у строителя),
	# иначе дом получает односкатную крышу и выглядит как сарай.
	plan["roof"] = {
		"shape": ShapeKind.PRISM,
		"position": Vector3(0.0, storey * float(floors), 0.0),
		"size": Vector3(size.x + 0.9, storey * 0.55, size.z + 0.9),
		"role": SurfaceRole.ROOF,
		"integrity": MapConfig.INTEGRITY_WOOD * 1.2,
		"destructible": true,
	}


## Строит план бункера — точка интереса 2.
##
## Три помещения: тамбур у взрывной двери, склад и основной зал. Тамбур
## обязателен по смыслу объекта — он отсекает наружный воздух, и без него
## бункер читается как подвал, а не как укрытие.
static func plan_bunker(size: Vector3, wall_thickness: float, openings: Dictionary) -> Dictionary:
	var plan: Dictionary = _empty_plan()
	var half_x: float = size.x * 0.5
	var half_z: float = size.z * 0.5
	var height: float = size.y

	# Наружные стены — железобетон.
	_shell(plan, half_x, half_z, wall_thickness, 0.0, height, SurfaceRole.CONCRETE, openings)

	# Перегородка A делит бункер на левую и правую половины.
	var partition_x: float = half_x * BUNKER_PARTITION_X_RATIO
	var first_partition: int = plan["panels"].size()
	_wall(
		plan,
		1,
		partition_x,
		-half_z + wall_thickness,
		half_z - wall_thickness,
		0.0,
		height,
		BUNKER_PARTITION_THICKNESS,
		SurfaceRole.CONCRETE,
		[
			{
				"kind": OpeningKind.DOOR,
				"at": -half_z * 0.4,
				"width": 1.1,
				"height": DOOR_HEIGHT,
				"sill": 0.0
			}
		]
	)
	# Перегородка B отделяет тамбур от склада в левой половине.
	var partition_z: float = half_z * BUNKER_PARTITION_Z_RATIO
	_wall(
		plan,
		0,
		partition_z,
		-half_x + wall_thickness,
		partition_x,
		0.0,
		height,
		BUNKER_PARTITION_THICKNESS,
		SurfaceRole.CONCRETE,
		[
			{
				"kind": OpeningKind.DOOR,
				"at": -half_x * 0.65,
				"width": DOOR_WIDTH,
				"height": DOOR_HEIGHT,
				"sill": 0.0
			}
		]
	)

	_tag_range(plan, "panels", first_partition, "interior", true)
	_bunker_slabs(plan, half_x, half_z, wall_thickness)
	# Наполнение добавляет вызывающая сторона через PoiDetails.decorate_bunker().
	return plan


## ------------------------------------------------------------------------
##  Оболочка и стены
## ------------------------------------------------------------------------


## Четыре наружные стены прямоугольного плана.
static func _shell(
	plan: Dictionary,
	half_x: float,
	half_z: float,
	thickness: float,
	base_y: float,
	height: float,
	role: int,
	openings: Dictionary
) -> void:
	# Передняя стена — вдоль X на -Z.
	_wall(
		plan,
		0,
		-half_z,
		-half_x,
		half_x,
		base_y,
		height,
		thickness,
		role,
		openings.get("front", [])
	)
	# Задняя — вдоль X на +Z.
	_wall(
		plan, 0, half_z, -half_x, half_x, base_y, height, thickness, role, openings.get("back", [])
	)
	# Левая — вдоль Z на -X.
	_wall(
		plan, 1, -half_x, -half_z, half_z, base_y, height, thickness, role, openings.get("left", [])
	)
	# Правая — вдоль Z на +X.
	_wall(
		plan, 1, half_x, -half_z, half_z, base_y, height, thickness, role, openings.get("right", [])
	)


## Одна осевая стена, разрезанная на простенки вокруг проёмов.
##
## Разрезка принципиальна: цельная стена с «отверстием» невозможна без CSG
## или вычитающей геометрии, а разрушаться обязана ЧАСТЬ стены. Если стена
## монолитна, попадание в окно ломает всю стену целиком — и «полного
## разрушения» не получается, получается исчезновение объекта.
##
## axis: 0 — стена тянется вдоль X (fixed задаёт Z), 1 — вдоль Z (fixed задаёт X).
static func _wall(
	plan: Dictionary,
	axis: int,
	fixed: float,
	from: float,
	to: float,
	base_y: float,
	height: float,
	thickness: float,
	role: int,
	openings: Array
) -> void:
	if to - from <= 0.01:
		return
	var sorted_openings: Array = openings.duplicate()
	sorted_openings.sort_custom(_compare_openings)

	var cursor: float = from
	for opening: Dictionary in sorted_openings:
		var half_width: float = float(opening["width"]) * 0.5
		var start: float = float(opening["at"]) - half_width
		var end: float = float(opening["at"]) + half_width
		# Простенок слева от проёма, во всю высоту.
		if start - cursor > 0.01:
			_panel(plan, axis, fixed, cursor, start, base_y, height, thickness, role, 1.0)
		# Простенок под проёмом (порог окна).
		var sill: float = float(opening["sill"])
		if sill > 0.01:
			_panel(plan, axis, fixed, start, end, base_y, sill, thickness, role, 1.0)
		# Простенок над проёмом (перемычка).
		var header_base: float = base_y + sill + float(opening["height"])
		var header_height: float = base_y + height - header_base
		if header_height > 0.01:
			_panel(plan, axis, fixed, start, end, header_base, header_height, thickness, role, 1.0)
		_emit_opening(plan, opening, axis, fixed, base_y, thickness)
		cursor = end
	if to - cursor > 0.01:
		_panel(plan, axis, fixed, cursor, to, base_y, height, thickness, role, 1.0)


## Сравнивает проёмы по положению вдоль стены.
static func _compare_openings(left: Dictionary, right: Dictionary) -> bool:
	return float(left["at"]) < float(right["at"])


## Один сплошной простенок.
##
## scale — доля прочности относительно роли. Наружные стены держат полную
## нагрузку, лёгкие простенки — меньше; иначе перегородка оказывается
## прочнее несущей стены и разрушение теряет иерархию.
static func _panel(
	plan: Dictionary,
	axis: int,
	fixed: float,
	from: float,
	to: float,
	base_y: float,
	height: float,
	thickness: float,
	role: int,
	scale: float
) -> void:
	var length: float = to - from
	var center: float = (from + to) * 0.5
	var position: Vector3 = Vector3.ZERO
	var size: Vector3 = Vector3.ZERO
	if axis == 0:
		position = Vector3(center, base_y + height * 0.5, fixed)
		size = Vector3(length, height, thickness)
	else:
		position = Vector3(fixed, base_y + height * 0.5, center)
		size = Vector3(thickness, height, length)
	(
		plan["panels"]
		. append(
			{
				"position": position,
				"size": size,
				"role": role,
				"axis": axis,
				"integrity": integrity_for_role(role) * scale,
				"destructible": true,
				# Наружная или внутренняя. Различать обязательно: перегородка
				# не держит ничего, кроме собственного веса, и разрушение
				# несущей стены обязано иметь другие последствия.
				"interior": false,
			}
		)
	)


## Проём: записывает дверь или окно на место разрыва в стене.
static func _emit_opening(
	plan: Dictionary,
	opening: Dictionary,
	axis: int,
	fixed: float,
	base_y: float,
	wall_thickness: float
) -> void:
	var kind: int = int(opening["kind"])
	var width: float = float(opening["width"])
	var height: float = float(opening["height"])
	var sill: float = float(opening["sill"])
	var center: float = float(opening["at"])

	var position: Vector3 = Vector3.ZERO
	var size: Vector3 = Vector3.ZERO
	# Заполнение проёма тоньше стены: дверь и стекло не обязаны занимать
	# всю толщину кладки, а тонкое стекло ещё и экономит геометрию.
	var depth: float = 0.06 if kind == OpeningKind.WINDOW else wall_thickness * 0.6
	if axis == 0:
		position = Vector3(center, base_y + sill + height * 0.5, fixed)
		size = Vector3(width, height, depth)
	else:
		position = Vector3(fixed, base_y + sill + height * 0.5, center)
		size = Vector3(depth, height, width)

	(
		plan["openings"]
		. append(
			{
				"kind": kind,
				"position": position,
				"size": size,
				"axis": axis,
				"role": opening_role(kind),
				"integrity": opening_integrity(kind),
			}
		)
	)


## ------------------------------------------------------------------------
##  Перекрытия, комнаты, лестница
## ------------------------------------------------------------------------


## Перекрытие этажа.
##
## На втором и следующих этажах перекрытие разрезается на две плиты с
## разрывом под лестничный проём. Монолитная плита закрыла бы проход
## наверх, а вырезать отверстие из BoxMesh нельзя — поэтому именно две плиты.
static func _slab(
	plan: Dictionary, half_x: float, half_z: float, base_y: float, floor_index: int, role: int
) -> void:
	if floor_index == 0:
		# Пол первого этажа — тонкая доска по грунту.
		(
			plan["slabs"]
			. append(
				{
					"position": Vector3(0.0, 0.05, 0.0),
					"size": Vector3(half_x * 2.0 - 0.2, 0.1, half_z * 2.0 - 0.2),
					"role": role,
					"integrity": MapConfig.INTEGRITY_WOOD,
					"destructible": true,
				}
			)
		)
		return
	var well_start: float = stair_well_center(half_x) - STAIR_WELL_WIDTH * 0.5
	var well_end: float = stair_well_center(half_x) + STAIR_WELL_WIDTH * 0.5
	var left_width: float = well_start + half_x
	if left_width > 0.05:
		(
			plan["slabs"]
			. append(
				{
					"position": Vector3(-half_x + left_width * 0.5, base_y, 0.0),
					"size": Vector3(left_width, SLAB_THICKNESS, half_z * 2.0),
					"role": SurfaceRole.WOOD,
					"integrity": MapConfig.INTEGRITY_WOOD * 1.4,
					"destructible": true,
					"floor": floor_index,
				}
			)
		)
	var right_width: float = half_x - well_end
	if right_width > 0.05:
		(
			plan["slabs"]
			. append(
				{
					"position": Vector3(well_end + right_width * 0.5, base_y, 0.0),
					"size": Vector3(right_width, SLAB_THICKNESS, half_z * 2.0),
					"role": SurfaceRole.WOOD,
					"integrity": MapConfig.INTEGRITY_WOOD * 1.4,
					"destructible": true,
					"floor": floor_index,
				}
			)
		)


## Ось лестничного проёма — общая для марша и для отверстия в перекрытии.
static func stair_well_center(half_x: float) -> float:
	return half_x * STAIR_WELL_X_RATIO


## Лестница между этажами.
##
## Ступени — отдельные коробки, а не наклонная плоскость: по наклонной
## плоскости персонаж скользит, а отдельные ступени дают нормальный подъём.
static func _plan_stairs(
	plan: Dictionary, half_x: float, half_z: float, storey: float, floors: int
) -> void:
	if floors < 2:
		return
	var rise: float = (storey + SLAB_THICKNESS) / float(STAIR_STEPS)
	rise = minf(rise, STAIR_MAX_RISE)
	var run_length: float = half_z * 1.5
	var start_z: float = half_z - 1.0
	for step: int in range(STAIR_STEPS):
		(
			plan["stairs"]
			. append(
				{
					"position":
					Vector3(
						stair_well_center(half_x),
						rise * (float(step) + 0.5),
						start_z - run_length * (float(step) / float(STAIR_STEPS))
					),
					"size": Vector3(1.0, rise, run_length / float(STAIR_STEPS) * 1.05),
				}
			)
		)


## Пол и потолок бункера.
static func _bunker_slabs(
	plan: Dictionary, half_x: float, half_z: float, wall_thickness: float
) -> void:
	# Пол толще стен: он держит вес грунта сверху и нагрузку от техники.
	(
		plan["slabs"]
		. append(
			{
				"position": Vector3(0.0, -0.15, 0.0),
				"size": Vector3(half_x * 2.0, 0.3, half_z * 2.0),
				"role": SurfaceRole.CONCRETE,
				"integrity": MapConfig.INTEGRITY_REINFORCED,
				"destructible": false,
			}
		)
	)
	# Ступень у входа: перепад между полом и грунтом снаружи. Без неё
	# игрок падает на 0,3 м каждый раз при входе.
	(
		plan["slabs"]
		. append(
			{
				"position": Vector3(-half_x * 0.55, -0.05, -half_z + wall_thickness * 0.5),
				"size": Vector3(2.0, 0.1, wall_thickness),
				"role": SurfaceRole.TILE,
				"integrity": MapConfig.INTEGRITY_CONCRETE,
				"destructible": true,
			}
		)
	)


## Высота пола этажа над полом первого этажа.
##
## Формула обязана быть одна: её используют и построение стен, и расстановка
## мебели, и описание комнат. Две копии разошлись бы при первом же изменении
## толщины перекрытия, и мебель верхнего этажа встала бы на уровне потолка
## нижнего.
static func floor_base_y(storey: float, floor_index: int) -> float:
	if floor_index <= 0:
		return 0.0
	# Пол этажа — верх перекрытия ниже.
	return storey * float(floor_index) + SLAB_THICKNESS


## Помечает элементы, добавленные в план начиная с указанного индекса.
##
## Отдельный шаг, а не параметр _wall(): пометка проходит через четыре уровня
## вложенности, и лишний аргумент на каждом из них только мешает. По диапазону
## то же самое делается в одном месте.
##
## Номер этажа обязателен: строитель раскладывает панели по контейнерам
## этажей, чтобы этаж можно было разрушить отдельно. Определять этаж по
## высоте ненадёжно — при нестандартной высоте этажа панели уедут не в тот
## контейнер, и дом разрушится «наоборот».
static func _tag_range(
	plan: Dictionary, key: String, first: int, field: String, value: Variant
) -> void:
	var items: Array = plan[key]
	for index: int in range(first, items.size()):
		items[index][field] = value


## Пустой план — единая структура для обоих типов точек.
static func _empty_plan() -> Dictionary:
	return {
		"rooms": [],
		"panels": [],
		"slabs": [],
		"openings": [],
		"furniture": [],
		"stairs": [],
		"lamps": [],
		"props": [],
		"roof": {},
	}


## Сводка плана — для тестов и отладки.
static func summarize(plan: Dictionary) -> Dictionary:
	return {
		"rooms": plan["rooms"].size(),
		"panels": plan["panels"].size(),
		"slabs": plan["slabs"].size(),
		"openings": plan["openings"].size(),
		"furniture": plan["furniture"].size(),
		"stairs": plan["stairs"].size(),
		"lamps": plan["lamps"].size(),
		"props": plan["props"].size(),
	}
