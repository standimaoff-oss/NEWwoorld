class_name PoiDetails
extends RefCounted
## Каталог наполнения точек интереса: проёмы, мебель, наружные детали, свет.
##
## ЗАЧЕМ ЭТО ОТДЕЛЬНО ОТ RoomLayout. RoomLayout отвечает за ГЕОМЕТРИЮ
## ограждения: где проходят стены, как они режутся простенками вокруг
## проёмов, где перекрытия и лестница. Наполнение — другая ответственность:
## это состав помещений, а не их форма.
##
## Разделение ещё и вынужденное: вместе два файла превышают предел в
## 700 строк, и общий файл пришлось бы либо резать произвольно, либо
## расчищать комментарии, которые здесь — основная документация решений.
##
## ЗАВИСИМОСТИ ОДНОСТОРОННИЕ: этот файл знает RoomLayout, RoomLayout о нём
## не знает. Составлением плана занимается InteriorBuilder, поэтому
## кольцевой ссылки не возникает.
##
## Все функции статические и ничего не хранят: наполнение определяется
## габаритами постройки и не зависит от семени карты. Разным домам не нужна
## разная мебель — им нужны разные габариты, а разнообразие даёт уже
## планировка деревни.

## ------------------------------------------------------------------------
##  Проёмы по стенам
## ------------------------------------------------------------------------


## Проёмы дома по стенам и этажам.
##
## Дверь только одна и только на первом этаже: вход в дом. Окна на обоих
## этажах, причём на разных стенах — иначе все комнаты освещены одинаково
## и интерьер не читается.
static func house_openings(size: Vector3, floors: int) -> Dictionary:
	var half_x: float = size.x * 0.5
	var half_z: float = size.z * 0.5
	var window: Dictionary = {
		"kind": RoomLayout.OpeningKind.WINDOW,
		"width": RoomLayout.WINDOW_WIDTH,
		"height": RoomLayout.WINDOW_HEIGHT,
		"sill": RoomLayout.WINDOW_SILL,
	}
	var door: Dictionary = {
		"kind": RoomLayout.OpeningKind.DOOR,
		"width": RoomLayout.DOOR_WIDTH,
		"height": RoomLayout.DOOR_HEIGHT,
		"sill": 0.0,
	}
	# Ключ — номер этажа, значение — четыре стены. Дверь только на первом
	# этаже: вход в дом один, и на втором ему взяться неоткуда.
	var per_floor: Dictionary = {}
	for floor_index: int in range(maxi(floors, 1)):
		var walls: Dictionary = {
			# Окна на разных стенах: одинаковое освещение всех комнат
			# делает интерьер плоским и нечитаемым.
			"front": [_with_at(window, half_x * 0.45)],
			"back": [_with_at(window, -half_x * 0.45)],
			"left": [_with_at(window, half_z * 0.35)],
			"right": [],
		}
		if floor_index == 0:
			# Входная дверь — на передней стене, левее окна.
			walls["front"] = [_with_at(door, -half_x * 0.5), _with_at(window, half_x * 0.45)]
		per_floor[floor_index] = walls
	return per_floor


## Проёмы бункера: взрывная дверь и узкие вентиляционные окна-бойницы.
static func bunker_openings(size: Vector3) -> Dictionary:
	var half_x: float = size.x * 0.5
	var half_z: float = size.z * 0.5
	var blast: Dictionary = {
		"kind": RoomLayout.OpeningKind.BLAST_DOOR,
		"width": RoomLayout.BLAST_DOOR_WIDTH,
		"height": RoomLayout.BLAST_DOOR_HEIGHT,
		"sill": 0.0,
	}
	# Бойница — узкая щель под потолком: свет даёт, а попасть в неё снаружи
	# сложно. Широкое окно в бункере бессмысленно и разрушает образ.
	var loophole: Dictionary = {
		"kind": RoomLayout.OpeningKind.WINDOW,
		"width": 0.5,
		"height": 0.22,
		"sill": 2.1,
	}
	return {
		# Взрывная дверь — в тамбур, а не в зал: входящий оказывается в
		# небольшом помещении, и это главный признак бункера.
		"front": [_with_at(blast, -half_x * 0.55)],
		"back": [_with_at(loophole, half_x * 0.3)],
		"left": [_with_at(loophole, 0.0)],
		"right": [_with_at(loophole, half_z * 0.2)],
	}


## Копия проёма с заданным положением вдоль стены.
static func _with_at(opening: Dictionary, at: float) -> Dictionary:
	var copy: Dictionary = opening.duplicate()
	copy["at"] = at
	return copy


## ------------------------------------------------------------------------
##  Мебель, декор, свет
## ------------------------------------------------------------------------


## Мебель дома.
##
## Расстановка считается ОТ ВНУТРЕННИХ ГРАНЕЙ стен, а не от габарита дома.
## Разница в толщину стены — это ровно тот зазор, из-за которого предмет
## оказывается наполовину в бетоне: выглядит как ошибка расстановки, а
## находится часами, потому что числа в коде «правильные».
static func _house_furniture(
	plan: Dictionary, half_x: float, half_z: float, storey: float, floors: int
) -> void:
	var inner_x: float = half_x - RoomLayout.HOUSE_WALL_THICKNESS
	var inner_z: float = half_z - RoomLayout.HOUSE_WALL_THICKNESS
	# Горница — левая комната, от внутренней грани до перегородки.
	_add_furniture(
		plan,
		RoomLayout.FurnitureKind.STOVE,
		Vector3(-inner_x + 0.45, 0.0, -inner_z + 0.4),
		Vector3(0.8, 1.1, 0.7),
		0.0,
		RoomLayout.SurfaceRole.METAL_DARK
	)
	_add_furniture(
		plan,
		RoomLayout.FurnitureKind.TABLE,
		Vector3(-inner_x * 0.45, 0.0, inner_z * 0.3),
		Vector3(1.6, 0.76, 0.9),
		0.0,
		RoomLayout.SurfaceRole.WOOD
	)
	_add_furniture(
		plan,
		RoomLayout.FurnitureKind.CHAIR,
		Vector3(-inner_x * 0.45, 0.0, inner_z * 0.3 + 0.85),
		Vector3(0.45, 0.9, 0.45),
		TAU * 0.5,
		RoomLayout.SurfaceRole.WOOD_DARK
	)
	_add_furniture(
		plan,
		RoomLayout.FurnitureKind.CHAIR,
		Vector3(-inner_x * 0.45, 0.0, inner_z * 0.3 - 0.85),
		Vector3(0.45, 0.9, 0.45),
		0.0,
		RoomLayout.SurfaceRole.WOOD_DARK
	)
	# Полка у тыльной стены: глубина 0,5 м, центр отстоит от грани на 0,3 м.
	_add_furniture(
		plan,
		RoomLayout.FurnitureKind.SHELF,
		Vector3(-inner_x + 0.3, 0.0, inner_z - 0.75),
		Vector3(0.5, 1.8, 1.4),
		0.0,
		RoomLayout.SurfaceRole.WOOD_DARK
	)
	if floors > 1:
		var upper_y: float = storey + RoomLayout.SLAB_THICKNESS
		_add_furniture(
			plan,
			RoomLayout.FurnitureKind.BED,
			Vector3(-inner_x * 0.5, upper_y, -inner_z * 0.45),
			Vector3(2.0, 0.55, 1.4),
			0.0,
			RoomLayout.SurfaceRole.FABRIC
		)
		_add_furniture(
			plan,
			RoomLayout.FurnitureKind.SHELF,
			Vector3(-inner_x + 0.3, upper_y, inner_z - 0.65),
			Vector3(0.5, 1.6, 1.2),
			0.0,
			RoomLayout.SurfaceRole.WOOD_DARK
		)


## Мебель и оборудование бункера.
static func _bunker_furniture(
	plan: Dictionary,
	half_x: float,
	half_z: float,
	partition_x: float,
	partition_z: float,
	wall_thickness: float
) -> void:
	var inner_x: float = half_x - wall_thickness
	var inner_z: float = half_z - wall_thickness
	# Внутренняя грань перегородки A: мебель в зале ставится правее неё.
	var partition_face: float = partition_x + RoomLayout.BUNKER_PARTITION_THICKNESS * 0.5
	# Зал: стол с картой, две двухъярусные койки, шкаф.
	_add_furniture(
		plan,
		RoomLayout.FurnitureKind.MAP_TABLE,
		Vector3(half_x * 0.4, 0.0, 0.0),
		Vector3(2.2, 0.8, 1.2),
		0.0,
		RoomLayout.SurfaceRole.METAL
	)
	# Койки ставятся от грани перегородки, а не от её оси: длина койки 2 м,
	# и отсчёт от оси вдвигал бы половину койки в бетон.
	var bunk_x: float = partition_face + 1.05
	_add_furniture(
		plan,
		RoomLayout.FurnitureKind.BUNK_BED,
		Vector3(bunk_x, 0.0, inner_z - 0.5),
		Vector3(2.0, 1.7, 0.8),
		0.0,
		RoomLayout.SurfaceRole.METAL_DARK
	)
	_add_furniture(
		plan,
		RoomLayout.FurnitureKind.BUNK_BED,
		Vector3(bunk_x, 0.0, -inner_z + 0.5),
		Vector3(2.0, 1.7, 0.8),
		0.0,
		RoomLayout.SurfaceRole.METAL_DARK
	)
	_add_furniture(
		plan,
		RoomLayout.FurnitureKind.LOCKER,
		Vector3(inner_x - 0.35, 0.0, -1.4),
		Vector3(0.6, 1.9, 1.0),
		0.0,
		RoomLayout.SurfaceRole.METAL
	)
	# Склад: два ряда ящиков и две бочки. Ряды и столбцы заданы явно —
	# целочисленное деление индекса дало бы непредсказуемую сетку.
	var storage_front: float = partition_z + RoomLayout.BUNKER_PARTITION_THICKNESS * 0.5
	for row: int in range(2):
		for column: int in range(2):
			var offset: Vector3 = Vector3(
				-inner_x + 0.55 + float(column) * 1.3, 0.0, storage_front + 0.55 + float(row) * 1.0
			)
			_add_furniture(
				plan,
				RoomLayout.FurnitureKind.CRATE,
				offset,
				Vector3(0.9, 0.7, 0.9),
				float(row * 2 + column) * 0.3,
				RoomLayout.SurfaceRole.WOOD
			)
	_add_furniture(
		plan,
		RoomLayout.FurnitureKind.BARREL,
		Vector3(-inner_x * 0.55, 0.0, storage_front + 0.5),
		Vector3(0.6, 0.95, 0.6),
		0.0,
		RoomLayout.SurfaceRole.METAL
	)
	_add_furniture(
		plan,
		RoomLayout.FurnitureKind.BARREL,
		Vector3(-inner_x * 0.55 + 0.75, 0.0, storage_front + 0.7),
		Vector3(0.6, 0.95, 0.6),
		0.0,
		RoomLayout.SurfaceRole.METAL
	)


## Комнаты дома — данные для навигации, подсказок и сохранения.
##
## Названия комнат — содержание, а не геометрия: поэтому они живут здесь, а
## не в RoomLayout. Стены не обязаны знать, что помещение называется
## «горница», а подсказки и сохранение обязаны.
static func _house_rooms(plan: Dictionary, size: Vector3, floors: int) -> void:
	var half_x: float = size.x * 0.5
	var half_z: float = size.z * 0.5
	var partition_x: float = half_x * RoomLayout.HOUSE_PARTITION_X_RATIO
	for floor_index: int in range(maxi(floors, 1)):
		var base_y: float = RoomLayout.floor_base_y(size.y, floor_index)
		_house_rooms_on_floor(plan, half_x, half_z, partition_x, base_y, floor_index)


## Комнаты одного этажа дома.
static func _house_rooms_on_floor(
	plan: Dictionary,
	half_x: float,
	half_z: float,
	partition_x: float,
	base_y: float,
	floor_index: int
) -> void:
	var prefix: String = "верх" if floor_index > 0 else "низ"
	_add_room(
		plan,
		"%s: горница" % prefix,
		floor_index,
		base_y,
		Rect2(Vector2(-half_x, -half_z), Vector2(partition_x + half_x, half_z * 2.0))
	)
	_add_room(
		plan,
		"%s: сени" % prefix,
		floor_index,
		base_y,
		Rect2(Vector2(partition_x, -half_z), Vector2(half_x - partition_x, half_z * 2.0))
	)


## Комнаты бункера.
static func _bunker_rooms(plan: Dictionary, size: Vector3, wall_thickness: float) -> void:
	var half_x: float = size.x * 0.5
	var half_z: float = size.z * 0.5
	var partition_x: float = half_x * RoomLayout.BUNKER_PARTITION_X_RATIO
	var partition_z: float = half_z * RoomLayout.BUNKER_PARTITION_Z_RATIO
	var inner_x: float = half_x - wall_thickness
	var inner_z: float = half_z - wall_thickness
	_add_room(
		plan,
		"бункер: зал",
		0,
		0.0,
		Rect2(Vector2(partition_x, -inner_z), Vector2(inner_x - partition_x, inner_z * 2.0))
	)
	_add_room(
		plan,
		"бункер: тамбур",
		0,
		0.0,
		Rect2(Vector2(-inner_x, -inner_z), Vector2(partition_x + inner_x, inner_z + partition_z))
	)
	_add_room(
		plan,
		"бункер: склад",
		0,
		0.0,
		Rect2(Vector2(-inner_x, partition_z), Vector2(partition_x + inner_x, inner_z - partition_z))
	)


## Добавляет одну комнату в план.
##
## Помощник обязателен, а не удобен: rect комнаты — это position и size,
## и перепутать их местами при ручном добавлении очень легко. Ошибка дала бы
## комнату нулевой площади, а тест «комната не пуста» поймал бы её только
## на одной из пяти.
static func _add_room(
	plan: Dictionary, room_name: String, floor_index: int, floor_y: float, rect: Rect2
) -> void:
	(
		plan["rooms"]
		. append(
			{
				"name": room_name,
				"rect": rect,
				"floor_index": floor_index,
				"floor_y": floor_y,
			}
		)
	)


## Внешние детали дома: крыльцо, труба, цоколь, ставни.
##
## Детали снаружи обязательны — требование «проработать обе точки и внутри,
## и снаружи». Гладкая коробка с прорезями окон не читается как дом: его
## делают узнаваемым именно крыльцо, труба и цоколь.
static func _house_props(
	plan: Dictionary, size: Vector3, half_x: float, half_z: float, storey: float, floors: int
) -> void:
	var total_height: float = storey * float(floors)
	# Цоколь — каменный пояс ниже первого этажа.
	(
		plan["props"]
		. append(
			{
				"shape": RoomLayout.ShapeKind.BOX,
				"position": Vector3(0.0, -0.25, 0.0),
				"size": Vector3(size.x + 0.3, 0.5, size.z + 0.3),
				"role": RoomLayout.SurfaceRole.STONE,
				"integrity": MapConfig.INTEGRITY_BRICK,
				"destructible": false,
				"exterior": true,
			}
		)
	)
	# Крыльцо со ступенью перед входной дверью.
	(
		plan["props"]
		. append(
			{
				"shape": RoomLayout.ShapeKind.BOX,
				"position": Vector3(-half_x * 0.5, -0.12, -half_z - 0.55),
				"size": Vector3(1.8, 0.24, 1.1),
				"role": RoomLayout.SurfaceRole.STONE,
				"integrity": MapConfig.INTEGRITY_BRICK,
				"destructible": true,
				"exterior": true,
			}
		)
	)
	# Печная труба. Без неё дом с печью внутри выглядит недостоверно.
	(
		plan["props"]
		. append(
			{
				"shape": RoomLayout.ShapeKind.BOX,
				"position": Vector3(-half_x + 0.7, total_height + 1.1, -half_z + 0.7),
				"size": Vector3(0.7, 2.4, 0.7),
				"role": RoomLayout.SurfaceRole.STONE,
				"integrity": MapConfig.INTEGRITY_BRICK,
				"destructible": true,
				"exterior": true,
			}
		)
	)
	# Наличники: тонкие рамки вокруг окон. Дешёвая деталь, которая сильнее
	# всего отличает жилой дом от сарая.
	for side: float in [-1.0, 1.0]:
		(
			plan["props"]
			. append(
				{
					"shape": RoomLayout.ShapeKind.BOX,
					"position":
					Vector3(
						half_x * 0.45,
						RoomLayout.WINDOW_SILL + RoomLayout.WINDOW_HEIGHT + 0.09,
						side * half_z
					),
					"size": Vector3(RoomLayout.WINDOW_WIDTH + 0.24, 0.14, 0.08),
					"role": RoomLayout.SurfaceRole.WOOD_DARK,
					"integrity": MapConfig.INTEGRITY_WOOD,
					"destructible": true,
					"exterior": true,
				}
			)
		)


## Внешние детали бункера: входной тамбур поверх грунта, вентиляция, насыпь.
static func _bunker_props(
	plan: Dictionary, half_x: float, half_z: float, wall_thickness: float, height: float
) -> void:
	var door_x: float = -half_x * 0.55
	# Входная коробка выступает над грунтом: без неё вход — просто дыра
	# в земле, и его не найти.
	(
		plan["props"]
		. append(
			{
				"shape": RoomLayout.ShapeKind.BOX,
				"position": Vector3(door_x, height * 0.55, -half_z - 0.45),
				"size": Vector3(RoomLayout.BLAST_DOOR_WIDTH + 0.9, height + 1.1, 1.0),
				"role": RoomLayout.SurfaceRole.CONCRETE,
				"integrity": MapConfig.INTEGRITY_CONCRETE,
				"destructible": true,
				"exterior": true,
			}
		)
	)
	# Вентиляционная труба. Бункер без вентиляции задыхается, и труба —
	# главный внешний признак того, что это именно укрытие.
	(
		plan["props"]
		. append(
			{
				"shape": RoomLayout.ShapeKind.CYLINDER,
				"position": Vector3(half_x * 0.55, height + 0.9, half_z * 0.4),
				"size": Vector3(0.35, 2.2, 0.35),
				"role": RoomLayout.SurfaceRole.METAL,
				"integrity": MapConfig.INTEGRITY_METAL_DOOR,
				"destructible": true,
				"exterior": true,
			}
		)
	)
	# Земляная насыпь по периметру. Скрывает бетон и даёт бункеру
	# вписанный в рельеф силуэт.
	for index: int in range(4):
		var along_x: bool = index < 2
		var sign: float = -1.0 if index % 2 == 0 else 1.0
		var offset: Vector3 = Vector3.ZERO
		var box_size: Vector3 = Vector3.ZERO
		if along_x:
			offset = Vector3(0.0, -0.35, sign * (half_z + wall_thickness * 1.2))
			box_size = Vector3(half_x * 2.0 + 3.0, 0.7, wall_thickness * 2.4)
		else:
			offset = Vector3(sign * (half_x + wall_thickness * 1.2), -0.35, 0.0)
			box_size = Vector3(wall_thickness * 2.4, 0.7, half_z * 2.0 + 3.0)
		(
			plan["props"]
			. append(
				{
					"shape": RoomLayout.ShapeKind.BOX,
					"position": offset,
					"size": box_size,
					"role": RoomLayout.SurfaceRole.STONE,
					"integrity": MapConfig.INTEGRITY_WOOD * 0.2,
					"destructible": true,
					"exterior": true,
				}
			)
		)


## Добавляет предмет мебели в план.
##
## СОГЛАШЕНИЕ О КООРДИНАТАХ: все позиции в плане — ЦЕНТРЫ объёмов, а не их
## основания. Вызывающая сторона передаёт высоту ПОЛА, и она приводится к
## центру здесь. Без этого половина предметов оказалась бы утопленной в пол:
## стол высотой 0,76 м с центром на нуле уходит вниз на 0,38 м, и это
## выглядит как провалившаяся мебель, а не как ошибка данных.
static func _add_furniture(
	plan: Dictionary, kind: int, base_position: Vector3, size: Vector3, rotation_y: float, role: int
) -> void:
	(
		plan["furniture"]
		. append(
			{
				"kind": kind,
				"position":
				Vector3(base_position.x, base_position.y + size.y * 0.5, base_position.z),
				"size": size,
				"rotation_y": rotation_y,
				"role": role,
				"integrity": MapConfig.INTEGRITY_WOOD * 0.5,
				"floor": 0 if base_position.y < 0.5 else 1,
			}
		)
	)


## Добавляет лампу в план.
static func _plan_append_lamp(plan: Dictionary, position: Vector3) -> void:
	plan["lamps"].append({"position": position})


## Наполняет план дома: мебель, наружные детали, крыша и свет.
##
## Вызывается ПОСЛЕ RoomLayout.plan_house(), когда ограждение уже построено:
## мебель расставляется от габаритов, а не от стен, и порядок не влияет на
## результат, но логически сначала появляется коробка, потом содержимое.
static func decorate_house(plan: Dictionary, size: Vector3, floors: int) -> void:
	var half_x: float = size.x * 0.5
	var half_z: float = size.z * 0.5
	var storey: float = size.y
	_house_rooms(plan, size, floors)
	_house_furniture(plan, half_x, half_z, storey, floors)
	_house_props(plan, size, half_x, half_z, storey, floors)
	# Крыша — двускатная призма. Конёк по центру задаёт строитель, иначе
	# дом получает односкатную крышу и выглядит как сарай.
	plan["roof"] = {
		"shape": RoomLayout.ShapeKind.PRISM,
		"position": Vector3(0.0, storey * float(floors), 0.0),
		"size": Vector3(size.x + 0.9, storey * 0.55, size.z + 0.9),
		"role": RoomLayout.SurfaceRole.ROOF,
		"integrity": MapConfig.INTEGRITY_WOOD * 1.2,
		"destructible": true,
	}
	_plan_append_lamp(plan, Vector3(-half_x * 0.45, storey - 0.35, 0.0))
	if floors > 1:
		_plan_append_lamp(plan, Vector3(-half_x * 0.45, storey * 2.0 - 0.35, 0.0))


## Наполняет план бункера: оборудование, наружные детали, перекрытие и свет.
static func decorate_bunker(plan: Dictionary, size: Vector3, wall_thickness: float) -> void:
	var half_x: float = size.x * 0.5
	var half_z: float = size.z * 0.5
	var height: float = size.y
	# Положения перегородок берутся из тех же констант, что и стены:
	# мебель обязана стоять в помещениях, а не в бетоне.
	var partition_x: float = half_x * RoomLayout.BUNKER_PARTITION_X_RATIO
	var partition_z: float = half_z * RoomLayout.BUNKER_PARTITION_Z_RATIO
	_bunker_rooms(plan, size, wall_thickness)
	_bunker_furniture(plan, half_x, half_z, partition_x, partition_z, wall_thickness)
	_bunker_props(plan, half_x, half_z, wall_thickness, height)
	# Перекрытие держит грунт сверху, поэтому прочнее стен и отмечено
	# неразрушаемым: проломленный потолок под слоем земли обрушил бы всё
	# помещение от одного попадания.
	plan["roof"] = {
		"shape": RoomLayout.ShapeKind.BOX,
		"position": Vector3(0.0, height, 0.0),
		"size": Vector3(size.x + 0.9, 0.5, size.z + 0.9),
		"role": RoomLayout.SurfaceRole.CONCRETE,
		"integrity": MapConfig.INTEGRITY_REINFORCED,
		"destructible": false,
	}
	# Аварийное освещение: зал и тамбур. Настоящий источник света только
	# у входа — он влияет на видимость и потому стоит бюджета.
	_plan_append_lamp(plan, Vector3(half_x * 0.45, height - 0.3, 0.0))
	_plan_append_lamp(plan, Vector3(-half_x * 0.6, height - 0.3, -half_z * 0.45))
