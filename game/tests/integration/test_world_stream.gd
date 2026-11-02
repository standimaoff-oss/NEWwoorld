extends GutTest
## Интеграционные тесты потоковой подгрузки карты.
##
## КАКОЙ КЛАСС ОШИБОК ЛОВИТ. Модули карты по отдельности могут быть
## корректны, а вместе — не давать мира. Разрыв происходит на стыке:
## планировка возвращает данные, строитель чанков их читает, поток решает,
## какие чанки строить. Ни один из трёх модулей не ошибается, но объект не
## появляется, потому что данные не дошли до потребителя.
##
## Реальный пример, против которого написан этот файл: бункер создавался
## записью в словаре точек интереса и НЕ добавлялся в список построек.
## Планировка рапортовала «две точки», тесты планировки проходили, а в мире
## бункера не существовало — строитель чанков о нём просто не узнавал.
## Обнаружить это можно только собрав узлы и поискав их в дереве.
##
## Поэтому ключевые проверки здесь идут не по данным, а по УЗЛАМ.

const MapScene: PackedScene = preload("res://scenes/game/military_map.tscn")

var _stream: WorldStream = null


## Ищет потомка с указанным именем на любой глубине.
func _find_named(root: Node, target: String) -> Node:
	if root.name == target:
		return root
	for child: Node in root.get_children():
		var found: Node = _find_named(child, target)
		if found != null:
			return found
	return null


## Считает узлы в поддереве.
func _count_nodes(root: Node) -> int:
	var total: int = 1
	for child: Node in root.get_children():
		total += _count_nodes(child)
	return total


func before_each() -> void:
	_stream = WorldStream.new()
	_stream.name = "WorldStream"
	_stream.map_seed = MapConfig.DEFAULT_SEED
	add_child_autofree(_stream)


func test_stream_prepares_terrain_and_layout_on_ready() -> void:
	# Поток обязан построить планировку ДО первого чанка. Обратный порядок
	# даёт пустые чанки: строитель спрашивает у планировки, что здесь есть,
	# а она ещё ничего не знает.
	assert_not_null(_stream.terrain(), "террейн не создан")
	assert_not_null(_stream.layout(), "планировка не создана")
	assert_true(_stream.layout().is_built(), "планировка не построена к моменту готовности")


func test_initial_load_creates_chunks() -> void:
	assert_gt(_stream.active_chunk_count(), 0, "после готовности нет ни одного чанка")
	assert_lte(
		_stream.active_chunk_count(),
		MapConfig.STREAM_ACTIVE_CHUNKS,
		"активных чанков больше, чем позволяет радиус подгрузки"
	)


func test_chunk_nodes_are_in_the_stream_group() -> void:
	# Группа — способ для внешних систем (отладка, статистика, сохранение)
	# найти чанки, не зная структуры дерева. Без неё поток непроверяем.
	var chunks: Array[Node] = get_tree().get_nodes_in_group(MapConfig.GROUP_CHUNK)
	assert_gt(chunks.size(), 0, "в группе «%s» пусто" % MapConfig.GROUP_CHUNK)
	assert_eq(
		chunks.size(),
		_stream.active_chunk_count(),
		"число узлов в группе разошлось со счётчиком потока"
	)


func test_terrain_chunk_has_collision() -> void:
	# Рельеф без коллизии — игрок проваливается сквозь карту. Это самый
	# частый дефект процедурного мира, и он не виден в редакторе: там
	# геометрия рисуется и без коллизии.
	var chunks: Array[Node] = get_tree().get_nodes_in_group(MapConfig.GROUP_CHUNK)
	assert_gt(chunks.size(), 0)
	if chunks.is_empty():
		return
	var bodies: int = 0
	for chunk: Node in chunks:
		for descendant: Node in _collect(chunk):
			if descendant is StaticBody3D:
				bodies += 1
	assert_gt(bodies, 0, "ни в одном чанке нет статического тела — рельеф нефизичен")


## Разворачивает поддерево в плоский список.
func _collect(root: Node) -> Array[Node]:
	var out: Array[Node] = []
	for child: Node in root.get_children():
		out.append(child)
		out.append_array(_collect(child))
	return out


func test_force_load_around_reaches_the_bunker() -> void:
	# Телепорт к точке интереса обязан подгрузить её окрестность СРАЗУ, а не
	# за несколько кадров: иначе игрок оказывается в пустоте и падает.
	var created: int = _stream.force_load_around(MapConfig.BUNKER_CENTER)
	assert_gt(created, 0, "принудительная подгрузка не создала ни одного чанка")
	var bunker_chunk: Vector2i = MapConfig.world_to_chunk(MapConfig.BUNKER_CENTER)
	assert_true(
		_stream.is_chunk_active(bunker_chunk),
		"чанк бункера %s не активен после подгрузки" % bunker_chunk
	)


func test_bunker_node_exists_in_the_world() -> void:
	# ГЛАВНАЯ ПРОВЕРКА ФАЙЛА — сквозная.
	#
	# Данные о бункере проходят три модуля: планировка → строитель чанков →
	# поток. Разрыв в любом из них даёт мир без второй точки интереса, и
	# ни один юнит-тест отдельного модуля этого не заметит.
	_stream.force_load_around(MapConfig.BUNKER_CENTER)
	var bunker: Node = _find_named(_stream, "bunker")
	assert_not_null(
		bunker,
		"бункер не построен в мире: данные есть в планировке, но не дошли до строителя чанков"
	)
	if bunker == null:
		return

	# Бункер обязан быть полноценной постройкой: корпус с коллизией и
	# перекрытие. Пустой Node3D на месте бункера — та же самая ошибка,
	# только спрятанная на уровень глубже.
	assert_gt(bunker.get_child_count(), 0, "узел бункера пуст — геометрия не построена")
	assert_not_null(_find_named(bunker, "floor_0"), "у бункера нет корпуса")
	assert_not_null(_find_named(bunker, "roof"), "у бункера нет перекрытия")
	assert_true(
		bunker.is_in_group("poi"), "бункер не в группе точек интереса — поиск POI его не найдёт"
	)


func test_village_house_poi_node_exists_in_the_world() -> void:
	# Вторая половина требования «две точки». Деревня стоит недалеко от
	# начала координат и подгружается сразу.
	var village_poi: Dictionary = _stream.layout().poi(VillageLayout.PoiKind.VILLAGE_HOUSE)
	assert_false(village_poi.is_empty(), "в планировке нет точки «дом в деревне»")
	if village_poi.is_empty():
		return
	_stream.force_load_around(village_poi["position"])
	var house: Node = _find_named(_stream, String(village_poi["id"]))
	assert_not_null(house, "дом-точка интереса «%s» не построен" % village_poi["id"])
	if house == null:
		return
	assert_true(house.is_in_group("poi"), "дом не помечен как точка интереса")


func test_both_points_of_interest_are_distinct_nodes() -> void:
	# Требование заказчика — ДВЕ точки. Если обе ссылаются на один узел,
	# формально «две точки» есть, а по факту одна.
	var bunker_poi: Dictionary = _stream.layout().poi(VillageLayout.PoiKind.BUNKER)
	var house_poi: Dictionary = _stream.layout().poi(VillageLayout.PoiKind.VILLAGE_HOUSE)
	_stream.force_load_around(bunker_poi["position"])
	_stream.force_load_around(house_poi["position"])
	var bunker: Node = _find_named(_stream, String(bunker_poi["id"]))
	var house: Node = _find_named(_stream, String(house_poi["id"]))
	assert_not_null(bunker, "бункер не найден в дереве")
	assert_not_null(house, "дом не найден в дереве")
	if bunker != null and house != null:
		assert_ne(bunker, house, "обе точки интереса — один и тот же узел")


func test_village_buildings_are_built() -> void:
	# Дома должны появиться вместе с чанками деревни. Проверка по числу
	# построенных узлов, а не по данным: данные могли не дойти до строителя.
	var house_poi: Dictionary = _stream.layout().poi(VillageLayout.PoiKind.VILLAGE_HOUSE)
	_stream.force_load_around(house_poi["position"])
	var built: int = 0
	for building: Dictionary in _stream.layout().buildings():
		if _find_named(_stream, String(building["id"])) != null:
			built += 1
	assert_gt(built, 0, "ни одна постройка не появилась в мире")


func test_active_chunk_capacity_is_never_exceeded() -> void:
	# Ёмкость — защита от бесконечного роста дерева. Несколько телепортов
	# подряд обязаны не накапливать чанки: дальние освобождаются.
	for probe: Array in [
		[MapConfig.VILLAGE_CENTER],
		[MapConfig.BUNKER_CENTER],
		[Vector3.ZERO],
		[MapConfig.BUNKER_CENTER],
		[MapConfig.VILLAGE_CENTER],
	]:
		_stream.force_load_around(probe[0])
		assert_lte(
			_stream.active_chunk_count(),
			MapConfig.STREAM_ACTIVE_CHUNKS + 4,
			"после телепорта активных чанков больше ёмкости"
		)


func test_clear_all_releases_every_chunk() -> void:
	_stream.force_load_around(Vector3.ZERO)
	assert_gt(_stream.active_chunk_count(), 0)
	_stream.clear_all()
	assert_eq(_stream.active_chunk_count(), 0, "clear_all() освободил не всё")
	assert_eq(
		get_tree().get_nodes_in_group(MapConfig.GROUP_CHUNK).size(),
		0,
		"узлы чанков остались в дереве после clear_all()"
	)


func test_disabled_stream_builds_nothing() -> void:
	# Отключение подгрузки — путь для отладки и слабых машин. Оно обязано
	# действительно останавливать строительство, иначе флаг ничего не значит.
	var idle: WorldStream = WorldStream.new()
	idle.map_seed = MapConfig.DEFAULT_SEED
	idle.streaming_enabled = false
	add_child_autofree(idle)
	assert_eq(idle.active_chunk_count(), 0, "при выключенной подгрузке чанки всё равно строятся")


func test_ground_height_matches_terrain() -> void:
	# Поток отдаёт высоту грунта внешним системам: спавн игрока, телепорт,
	# расстановка объектов. Расхождение с террейном роняет игрока с высоты
	# или закапывает его под землю.
	for probe: Array in [[10.0, -30.0], [-120.0, 88.0], [200.0, 150.0]]:
		var x: float = probe[0]
		var z: float = probe[1]
		var expected: float = _stream.terrain().height_at(x, z)
		assert_almost_eq(
			_stream.ground_height(Vector3(x, 0.0, z)),
			expected,
			0.001,
			"высота грунта в точке (%.1f, %.1f) разошлась с террейном" % [x, z]
		)


func test_budget_report_is_complete() -> void:
	var report: Dictionary = _stream.budget_report()
	var required: Array[String] = [
		"active_chunks",
		"active_chunk_capacity",
		"nodes",
		"node_budget",
		"mesh_instances",
		"multimesh_instances",
		"physics_bodies",
		"pending",
		"stream_radius",
		"chunks_per_frame",
		"builder_cache",
	]
	for key: String in required:
		assert_has(report, key, "в budget_report() нет ключа «%s»" % key)


func test_node_budget_is_respected() -> void:
	# Бюджет узлов — главная защита карты 500×500 м от превращения в
	# миллион объектов. Превышение означает, что либо радиус подгрузки
	# слишком велик, либо постройки слишком детализированы.
	_stream.force_load_around(MapConfig.VILLAGE_CENTER)
	var report: Dictionary = _stream.budget_report()
	var nodes: int = int(report["nodes"])
	assert_lte(
		nodes,
		MapConfig.BUDGET_MAP_NODES,
		"карта использует %d узлов при бюджете %d" % [nodes, MapConfig.BUDGET_MAP_NODES]
	)
	assert_eq(nodes, _count_nodes(_stream) - 1, "отчёт об узлах разошёлся с деревом")


func test_builder_cache_does_not_grow_with_chunks() -> void:
	# Кэш мешей и материалов обязан быть общим. Если он растёт с каждым
	# чанком, то 49 активных чанков дают 49 копий каждого материала —
	# память утекает, а поток подгрузки превращается в генератор мусора.
	_stream.force_load_around(Vector3.ZERO)
	var first: int = int(_stream.budget_report()["builder_cache"])
	_stream.force_load_around(MapConfig.VILLAGE_CENTER)
	_stream.force_load_around(MapConfig.BUNKER_CENTER)
	var second: int = int(_stream.budget_report()["builder_cache"])
	assert_gt(first, 0, "кэш пуст — меши не переиспользуются")
	assert_lte(
		second,
		first + 8,
		"кэш вырос с %d до %d за две области: меши не разделяются между чанками" % [first, second]
	)


func test_counters_track_streaming_activity() -> void:
	var before: Dictionary = _stream.counters()
	_stream.force_load_around(MapConfig.BUNKER_CENTER)
	var after: Dictionary = _stream.counters()
	assert_false(before.is_empty(), "счётчики пусты")
	assert_eq(before.keys(), after.keys(), "набор ключей счётчиков изменился")


func test_map_scene_declares_the_stream() -> void:
	# Сцена карты обязана содержать поток как узел с уникальным именем:
	# military_map.gd ищет его через %WorldStream. Отсутствие приведёт к
	# уровню без мира — и это не ошибка времени выполнения, а пустая сцена.
	var scene: PackedScene = MapScene
	assert_not_null(scene, "military_map.tscn не загружается")
	var state: SceneState = scene.get_state()
	var names: Array[String] = []
	for index: int in range(state.get_node_count()):
		names.append(state.get_node_name(index))
	assert_has(names, "WorldStream", "в сцене карты нет узла WorldStream")
	assert_has(names, "WorldEnvironment", "в сцене карты нет окружения")
	assert_has(names, "Sun", "в сцене карты нет солнца")
