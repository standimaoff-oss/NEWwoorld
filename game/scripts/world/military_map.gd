class_name MilitaryMap
extends Node3D
## MilitaryMap — военная карта 500 × 500 м: деревня и бункер.
##
## ЧТО ЭТО ЗА УЗЕЛ. Владеет потоком чанков (WorldStream), размещает игрока
## на первой проработанной точке, регистрирует уровень в сервисах и отдаёт
## состояние карты в сохранение. Геометрию не строит — это делают WorldStream
## и ChunkBuilder.
##
## ДВЕ ПРОРАБОТАННЫЕ ТОЧКИ (требование заказчика):
##   1. VILLAGE_HOUSE — дом в деревне, проработанный внутри и снаружи;
##   2. BUNKER — небольшой бункер, проработанный внутри и снаружи.
## Обе позиции берутся из VillageLayout, а не задаются числами здесь:
## планировка детерминирована от зерна, и дублирование координат в двух
## местах привело бы к тому, что телепорт отправляет игрока не туда,
## где реально стоит здание.
##
## ПОЧЕМУ ИГРОК СТАВИТСЯ ЧЕРЕЗ force_load_around, А НЕ ПРОСТО ПЕРЕМЕЩАЕТСЯ.
## В момент появления игрока рельеф под ним ещё не построен: поток создаёт
## не больше MapConfig.CHUNKS_PER_FRAME чанков за кадр, и первые кадры под
## ногами пусто. Игрок проваливается сквозь мир и погибает до того, как
## рельеф появится. Принудительная загрузка области вокруг точки спавна
## устраняет это, а её цена (рывок при загрузке) незаметна — она скрыта
## экраном загрузки.

## Готов ли уровень к игре: рельеф под игроком построен.
signal map_ready

## Игрок перемещён к проработанной точке. Нужен интерфейсу, чтобы показать
## название локации, и тестам — чтобы проверить, что телепорт состоялся.
signal player_moved_to_poi(poi_kind: int, position: Vector3)

## Идентификатор уровня для EventBus и сохранений.
const LEVEL_ID: String = "military_map_01"

## Идентификатор провайдера сохранения.
const SAVE_PROVIDER_ID: String = "military_map"

## Высота, на которую игрок поднимается над рельефом при спавне.
##
## Спавн точно на высоте грунта — ошибка: капсула игрока касается земли
## в момент появления, физика фиксирует столкновение, и первый кадр даёт
## толчок. Подъём на 0.3 м безопасен — это меньше половины высоты капсулы.
const SPAWN_LIFT: float = 0.3

## Тег журнала.
const LOG_TAG: String = "military_map"

## Поток чанков карты. Задан в сцене, а не создан кодом: его параметры
## (радиус, бюджет кадра) должны быть видны и настраиваемы в инспекторе.
@export var stream: WorldStream = null

## Стартовая точка: 0 — деревня, 1 — бункер.
@export var start_poi: int = VillageLayout.PoiKind.VILLAGE_HOUSE

## Перемещать ли игрока к стартовой точке при загрузке.
##
## Выключается при восстановлении сохранения: там позиция берётся из сейва,
## и принудительный телепорт к точке старта отменил бы прогресс игрока.
@export var spawn_at_start_poi: bool = true

## Игрок. Ищется по группе, а не по пути к узлу: сцена игрока может быть
## заменена (наблюдатель, транспорт), и жёсткий путь сломался бы.
var _player: Node3D = null

## Зарегистрирован ли провайдер сохранения. Нужно для корректного
## снятия регистрации: повторная регистрация с тем же id перезаписывает
## предыдущую, и снятие чужой регистрации ломало бы другой уровень.
var _save_registered: bool = false

## Готов ли уровень.
var _ready_emitted: bool = false


func _ready() -> void:
	_resolve_stream()
	if stream == null:
		Diagnostics.error(LOG_TAG, "не назначен WorldStream — карта не построится")
		return
	_register_quality_groups()
	_player = _find_player()
	if _player == null:
		Diagnostics.warn(LOG_TAG, 'игрок не найден в группе &"player"')

	# Первичная загрузка идёт принудительно: см. комментарий к классу.
	_spawn_initial()

	SaveService.register_provider(SAVE_PROVIDER_ID, self)
	_save_registered = true
	EventBus.level_loaded.emit(LEVEL_ID)
	Diagnostics.info(LOG_TAG, "уровень загружен: %s" % _describe_summary())


func _exit_tree() -> void:
	if _save_registered:
		SaveService.unregister_provider(SAVE_PROVIDER_ID)
		_save_registered = false


func _unhandled_input(event: InputEvent) -> void:
	# Отладочный телепорт между проработанными точками. Вынесен в input map,
	# а не в хардкод клавиатуры: действие переназначается и видно в настройках.
	if event.is_action_pressed("debug_poi_village"):
		teleport_to_poi(VillageLayout.PoiKind.VILLAGE_HOUSE)
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed("debug_poi_bunker"):
		teleport_to_poi(VillageLayout.PoiKind.BUNKER)
		get_viewport().set_input_as_handled()


## Находит поток чанков, если он не назначен в инспекторе.
##
## Запасной поиск обязателен: ссылка на узел, назначенная вручную в сцене,
## теряется при переименовании узла, и карта молча перестаёт строиться.
## Поиск по unique_name_in_owner работает независимо от того, кто и как
## назвал узел в инспекторе.
func _resolve_stream() -> void:
	if stream != null:
		return
	var candidate: Node = get_node_or_null("%WorldStream")
	if candidate is WorldStream:
		stream = candidate as WorldStream
		return
	# Последний вариант — перебор потомков. Нужен, если сцену собрали кодом
	# (например, в тесте) и unique_name_in_owner не выставлен.
	for child: Node in get_children():
		if child is WorldStream:
			stream = child as WorldStream
			return


## Регистрирует окружение и солнце в группах QualityService.
##
## Профиль качества ищет их ПО ГРУППАМ, а не по имени узла. Без регистрации
## применение настроек графики молча ничего не сделает: сервис не найдёт ни
## окружение, ни источник света, и смена профиля не изменит картинку.
func _register_quality_groups() -> void:
	var environment_node: Node = get_node_or_null("%WorldEnvironment")
	if environment_node != null:
		environment_node.add_to_group(QualityService.ENVIRONMENT_GROUP)
	var sun_node: Node = get_node_or_null("%Sun")
	if sun_node != null:
		sun_node.add_to_group(QualityService.SUN_GROUP)


## ------------------------------------------------------------------------
##  Размещение игрока
## ------------------------------------------------------------------------


## Начальный спавн: загружает область вокруг стартовой точки и ставит игрока.
func _spawn_initial() -> void:
	if stream == null:
		return
	var target: Vector3 = poi_position(start_poi)
	# Принудительная загрузка ДО перемещения игрока. Обратный порядок даёт
	# проваливание: физика отрабатывает раньше, чем появляется рельеф.
	var created: int = stream.force_load_around(target)
	Diagnostics.debug(LOG_TAG, "принудительно загружено чанков: %d" % created)

	if _player != null and spawn_at_start_poi:
		_place_player_at(target)
		player_moved_to_poi.emit(start_poi, target)

	if not _ready_emitted:
		_ready_emitted = true
		map_ready.emit()


## Мировая позиция проработанной точки.
##
## Возвращает позицию на рельефе, а не «сырую» из планировки: планировка
## хранит высоту, вычисленную на момент генерации, но точка обязана стоять
## на фактическом грунте с учётом сглаживания площадки.
func poi_position(poi_kind: int) -> Vector3:
	if stream == null or stream.layout() == null:
		return MapConfig.VILLAGE_CENTER
	var record: Dictionary = stream.layout().poi(poi_kind)
	if record.is_empty():
		# Точка не размещена (например, все кандидаты попали на крутой склон).
		# Возвращаем центр соответствующей области, а не ноль: телепорт в
		# начало координат отправил бы игрока за пределы карты.
		Diagnostics.warn(LOG_TAG, "точка %d не размещена — беру центр области" % poi_kind)
		return _fallback_position(poi_kind)
	var position: Vector3 = record["position"]
	return Vector3(position.x, _ground_at(position), position.z)


## Высота грунта в мировой точке с подъёмом для спавна.
func _ground_at(position: Vector3) -> float:
	if stream == null:
		return 0.0
	return stream.ground_height(position) + SPAWN_LIFT


## Запасная позиция, если точка интереса не была размещена.
func _fallback_position(poi_kind: int) -> Vector3:
	var center: Vector3 = MapConfig.BUNKER_CENTER
	if poi_kind == VillageLayout.PoiKind.VILLAGE_HOUSE:
		center = MapConfig.VILLAGE_CENTER
	return Vector3(center.x, _ground_at(center), center.z)


## Ставит игрока в точку, ориентируя его вверх по склону.
func _place_player_at(position: Vector3) -> void:
	if _player == null:
		return
	_player.global_position = position
	# Обнуляем скорость: у CharacterBody3D остаточная скорость от предыдущего
	# кадра сохранится, и после телепорта игрок продолжит движение в старом
	# направлении — выглядит как «телепорт бросает».
	var body: CharacterBody3D = _player as CharacterBody3D
	if body != null:
		body.velocity = Vector3.ZERO


## Телепортирует игрока к проработанной точке.
##
## Публичный метод: используется и отладочными клавишами, и кодом уровня
## (например, задачей «дойти до бункера»).
func teleport_to_poi(poi_kind: int) -> void:
	if stream == null:
		Diagnostics.error(LOG_TAG, "телепорт невозможен: нет WorldStream")
		return
	var target: Vector3 = poi_position(poi_kind)
	# Область вокруг новой точки обязана быть загружена ДО перемещения.
	stream.force_load_around(target)
	_place_player_at(target)
	player_moved_to_poi.emit(poi_kind, target)
	Diagnostics.info(LOG_TAG, "игрок перемещён к точке %d" % poi_kind)


## ------------------------------------------------------------------------
##  Доступ к данным карты
## ------------------------------------------------------------------------


## Генератор рельефа.
func terrain() -> TerrainGenerator:
	if stream == null:
		return null
	return stream.terrain()


## Планировка деревни и окрестностей.
func layout() -> VillageLayout:
	if stream == null:
		return null
	return stream.layout()


## Поток чанков.
func world_stream() -> WorldStream:
	return stream


## Игрок карты.
func player() -> Node3D:
	return _player


## Обе проработанные точки одной словарной записью.
func poi_positions() -> Dictionary:
	return {
		VillageLayout.PoiKind.VILLAGE_HOUSE: poi_position(VillageLayout.PoiKind.VILLAGE_HOUSE),
		VillageLayout.PoiKind.BUNKER: poi_position(VillageLayout.PoiKind.BUNKER),
	}


## ------------------------------------------------------------------------
##  Сохранение
## ------------------------------------------------------------------------


## Собирает данные уровня для сейва.
##
## Обязательный метод провайдера SaveService. Сохраняются позиция игрока,
## зерно карты и счётчики потока — но НЕ геометрия: рельеф и планировка
## детерминированы от зерна, поэтому восстанавливаются пересчётом. Хранить
## в сейве 400 чанков геометрии означало бы сейв размером в десятки
## мегабайт вместо нескольких сотен байт.
func collect_save_data() -> Dictionary:
	var player_position: Vector3 = Vector3.ZERO
	if _player != null:
		player_position = _player.global_position
	return {
		"level_id": LEVEL_ID,
		"map_seed": stream.map_seed if stream != null else MapConfig.DEFAULT_SEED,
		"player_position":
		{
			"x": player_position.x,
			"y": player_position.y,
			"z": player_position.z,
		},
		"stream_radius": stream.stream_radius if stream != null else MapConfig.STREAM_RADIUS,
	}


## Восстанавливает состояние уровня из сейва.
func restore_save_data(data: Variant) -> void:
	if not data is Dictionary:
		Diagnostics.error(LOG_TAG, "restore_save_data: ожидался Dictionary")
		return
	var payload: Dictionary = data
	var level_id: String = str(payload.get("level_id", LEVEL_ID))
	if level_id != LEVEL_ID:
		Diagnostics.warn(LOG_TAG, "сейв от другого уровня: %s" % level_id)

	var seed_value: int = int(payload.get("map_seed", MapConfig.DEFAULT_SEED))
	if stream != null and seed_value != stream.map_seed:
		# Зерно отличается — карта другая. Перестраивать её на лету нельзя:
		# игрок окажется в не существующей геометрии. Сообщаем и выходим.
		Diagnostics.error(
			LOG_TAG,
			"зерно карты в сейве (%d) не совпадает с текущим (%d)" % [seed_value, stream.map_seed]
		)
		return

	# Телепорт к стартовой точке при восстановлении ОТКЛЮЧАЕМ: позиция
	# берётся из сейва, и спавн заново отменил бы прогресс игрока.
	spawn_at_start_poi = false
	var raw_position: Variant = payload.get("player_position", null)
	if raw_position is Dictionary:
		var coordinates: Dictionary = raw_position
		var restored: Vector3 = Vector3(
			float(coordinates.get("x", 0.0)),
			float(coordinates.get("y", 0.0)),
			float(coordinates.get("z", 0.0))
		)
		if stream != null:
			stream.force_load_around(restored)
		_place_player_at(restored)
		Diagnostics.info(LOG_TAG, "позиция игрока восстановлена")


## ------------------------------------------------------------------------
##  Служебное
## ------------------------------------------------------------------------


## Ищет игрока по группе.
func _find_player() -> Node3D:
	var candidates: Array[Node] = get_tree().get_nodes_in_group(&"player")
	if candidates.is_empty():
		return null
	return candidates[0] as Node3D


## Краткая сводка карты для журнала и отладки.
func _describe_summary() -> String:
	var summary: Dictionary = describe()
	return (
		"%s, зданий %d, деревьев %d, активных чанков %d"
		% [
			LEVEL_ID,
			summary.get("buildings", 0),
			summary.get("trees", 0),
			summary.get("active_chunks", 0),
		]
	)


## Полная сводка состояния карты — для оверлея и тестов.
func describe() -> Dictionary:
	var layout_summary: Dictionary = (
		stream.layout().describe() if stream != null and stream.layout() != null else {}
	)
	var budget: Dictionary = stream.budget_report() if stream != null else {}
	return {
		"level_id": LEVEL_ID,
		"map_size_m": MapConfig.MAP_SIZE,
		"area_m2": MapConfig.MAP_SIZE * MapConfig.MAP_SIZE,
		"buildings": layout_summary.get("buildings", 0),
		"trees": layout_summary.get("trees", 0),
		"scrub": layout_summary.get("scrub", 0),
		"pois": layout_summary.get("pois", 0),
		"active_chunks": budget.get("active_chunks", 0),
		"nodes": budget.get("nodes", 0),
		"node_budget": budget.get("node_budget", MapConfig.BUDGET_MAP_NODES),
		"map_ready": _ready_emitted,
	}
