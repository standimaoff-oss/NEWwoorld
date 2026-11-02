extends GutTest
## Тесты GameConfig — единственного источника констант.
##
## Проверяются НЕ значения (их подбирают под геймплей), а ИНВАРИАНТЫ:
## согласованность слоёв, корректность масок, обратимость преобразований.
## Ошибка в маске коллизий не падает — она делает игрока проходящим сквозь
## стены, и ищут это часами.


func test_version_string_format() -> void:
	var version: String = GameConfig.version_string()
	var parts: PackedStringArray = version.split(".")
	assert_eq(parts.size(), 3, "версия должна быть из трёх чисел: " + version)
	for part: String in parts:
		assert_true(part.is_valid_int(), "компонент версии не число: " + part)


func test_version_full_contains_schema() -> void:
	# Схема сейва в строке версии нужна, чтобы по логу игрока понять,
	# из какого формата сохранение. Без неё миграция превращается в гадание.
	var full: String = GameConfig.version_full()
	assert_string_contains(full, GameConfig.version_string())
	assert_string_contains(full, "schema")
	assert_string_contains(full, str(GameConfig.SAVE_SCHEMA_VERSION))


func test_save_schema_is_supported_by_itself() -> void:
	# Инвариант миграции: текущая схема обязана быть не старее минимальной
	# поддерживаемой. Иначе свежее сохранение не загрузится ничем.
	assert_gte(GameConfig.SAVE_SCHEMA_VERSION, GameConfig.SAVE_SCHEMA_MIN_SUPPORTED)


func test_physics_layers_are_contiguous_from_one() -> void:
	var values: Array[int] = []
	for layer: int in GameConfig.PhysicsLayer.values():
		values.append(layer)
	values.sort()
	assert_eq(values[0], 1, "нумерация слоёв должна начинаться с 1")
	for index in range(values.size()):
		assert_eq(
			values[index], index + 1, "слой %d пропущен: значения %s" % [index + 1, str(values)]
		)


func test_physics_layer_bit_matches_enum() -> void:
	for layer: int in GameConfig.PhysicsLayer.values():
		assert_eq(GameConfig.physics_layer_bit(layer), 1 << (layer - 1))


func test_physics_layer_count_does_not_exceed_engine_limit() -> void:
	# Godot поддерживает 32 слоя физики. Превышение не ошибка компиляции,
	# а молча не работающая маска.
	assert_lte(GameConfig.PhysicsLayer.size(), 32)
	assert_lte(GameConfig.RenderLayer.size(), 32)


func test_player_collision_mask_includes_required_layers() -> void:
	# Игрок обязан сталкиваться с миром: без этого он проваливается.
	var world_bit: int = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD)
	assert_ne(
		GameConfig.PLAYER_COLLISION_MASK & world_bit, 0, "маска игрока не включает слой World"
	)
	var interactable_bit: int = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.INTERACTABLE)
	assert_ne(
		GameConfig.PLAYER_COLLISION_MASK & interactable_bit,
		0,
		"маска игрока не включает Interactable — взаимодействие не сработает"
	)


func test_player_collision_mask_excludes_own_layer() -> void:
	# Игрок в собственной маске — это само столкновение. CharacterBody3D
	# при этом может застревать на собственном коллайдере.
	var player_bit: int = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.PLAYER)
	assert_eq(GameConfig.PLAYER_COLLISION_MASK & player_bit, 0)


func test_player_dimensions_are_consistent() -> void:
	# Высота глаз обязана быть внутри роста: иначе камера оказывается
	# внутри коллайдера (чёрный экран) или над ним (игрок видит пол).
	assert_gt(GameConfig.PLAYER_EYE_HEIGHT, 0.0)
	assert_lt(GameConfig.PLAYER_EYE_HEIGHT, GameConfig.PLAYER_HEIGHT)
	# Диаметр капсулы должен быть меньше роста, иначе тело «лежит».
	assert_lt(GameConfig.PLAYER_RADIUS * 2.0, GameConfig.PLAYER_HEIGHT)
	# Капсула в Godot требует height >= 2 * radius.
	assert_gte(GameConfig.PLAYER_HEIGHT, GameConfig.PLAYER_RADIUS * 2.0)


func test_gravity_is_positive() -> void:
	assert_gt(GameConfig.GRAVITY, 0.0)
	assert_between(GameConfig.GRAVITY, 1.0, 30.0, "гравитация вне разумных для игры пределов")


func test_volume_conversion_is_reversible() -> void:
	# Прямое и обратное преобразование должны быть взаимно обратными.
	# Без этого ползунок громкости «уезжает» после сохранения и загрузки.
	for linear in [0.0, 0.01, 0.25, 0.5, 0.75, 1.0]:
		var db_value: float = GameConfig.volume_linear_to_db(linear)
		var restored: float = GameConfig.volume_db_to_linear(db_value)
		assert_almost_eq(restored, linear, 0.001, "не обратимо при linear=%s" % str(linear))


func test_volume_zero_is_silence() -> void:
	assert_eq(GameConfig.volume_linear_to_db(0.0), GameConfig.VOLUME_DB_MIN)
	assert_eq(GameConfig.volume_db_to_linear(GameConfig.VOLUME_DB_MIN), 0.0)


func test_volume_db_range_is_ordered() -> void:
	assert_lt(GameConfig.VOLUME_DB_MIN, GameConfig.VOLUME_DB_MAX)
	assert_lte(GameConfig.VOLUME_DB_MAX, 12.0, "усиление выше +12 дБ даёт клиппинг")


func test_audio_buses_are_unique_and_named() -> void:
	var seen: Array[String] = []
	for bus_name: String in GameConfig.AUDIO_BUSES:
		assert_ne(bus_name.strip_edges(), "", "пустое имя шины")
		assert_does_not_have(seen, bus_name, "дубль шины " + bus_name)
		seen.append(bus_name)
	assert_has(
		GameConfig.AUDIO_BUSES,
		GameConfig.BUS_MASTER,
		"шина Master обязательна: на неё завязаны все остальные"
	)


func test_destruction_budgets_are_positive_and_bounded() -> void:
	assert_gt(GameConfig.DESTRUCTION_MAX_ACTIVE_CHUNKS, 0)
	assert_gt(GameConfig.DESTRUCTION_MAX_CONCURRENT_BREAKS, 0)
	assert_gt(GameConfig.DESTRUCTION_DEBRIS_LIFETIME, 0.0)
	assert_gt(GameConfig.DESTRUCTION_CELL_SIZE, 0.0)
	# Верхние границы защищают от «оптимизации» в обратную сторону:
	# бюджет в миллион осколков собирается одним движением ползунка.
	assert_lte(GameConfig.DESTRUCTION_MAX_ACTIVE_CHUNKS, 8192)
	assert_lte(GameConfig.DESTRUCTION_MAX_CONCURRENT_BREAKS, 32)
	assert_lte(GameConfig.DESTRUCTION_DEBRIS_LIFETIME, 120.0)
	assert_lte(GameConfig.DESTRUCTION_CELL_SIZE, 4.0)


func test_interaction_limits_are_reachable() -> void:
	# Дистанция взаимодействия должна превышать радиус игрока, иначе
	# дотянуться до объекта физически невозможно.
	assert_gt(GameConfig.INTERACT_MAX_DISTANCE, GameConfig.PLAYER_RADIUS)
	assert_between(GameConfig.INTERACT_MAX_ANGLE_DEG, 5.0, 120.0)


func test_scene_paths_use_res_scheme() -> void:
	var problems: Array[String] = []
	for path: String in [
		GameConfig.SCENE_BOOT,
		GameConfig.SCENE_MAIN_MENU,
		GameConfig.SCENE_WORLD,
		GameConfig.SCENE_LOADING
	]:
		Validators.check_resource_path(path, "SCENE_*", problems)
	assert_eq(problems.size(), 0, "; ".join(problems))


func test_user_paths_use_user_scheme() -> void:
	for path: String in [
		GameConfig.PATH_SETTINGS,
		GameConfig.PATH_SAVE_DIR,
		GameConfig.PATH_LOG_FILE,
		GameConfig.PATH_CREDITS_DATA.replace("res://", "user://")
	]:
		assert_true(
			path.begins_with("user://"),
			"пользовательские данные обязаны лежать в user://, а не в res://: " + path
		)


func test_save_file_template_has_slot_placeholder() -> void:
	# Без %d все слоты пишутся в один файл и перезаписывают друг друга.
	assert_string_contains(GameConfig.PATH_SAVE_FILE_TEMPLATE, "%d")
	assert_eq(
		GameConfig.PATH_SAVE_FILE_TEMPLATE.count("%d"),
		1,
		"должен быть ровно один подстановочный номер слота"
	)


func test_resource_exists_at_rejects_garbage() -> void:
	assert_false(GameConfig.resource_exists_at(""))
	assert_false(GameConfig.resource_exists_at("res://нет/такого/файла.tres"))


func test_debug_defaults_are_off() -> void:
	# Отладка, включённая по умолчанию, уезжает в релиз. Это не гипотеза:
	# так происходит почти всегда, если значение не зафиксировано тестом.
	assert_false(GameConfig.DEBUG_OVERLAY_ENABLED_DEFAULT)
	assert_false(GameConfig.DEBUG_CONSOLE_ENABLED_DEFAULT)


func test_design_resolution_is_standard() -> void:
	assert_eq(GameConfig.DESIGN_RESOLUTION, Vector2i(1920, 1080))
	assert_gt(GameConfig.MIN_WINDOW_SIZE.x, 0)
	assert_lt(GameConfig.MIN_WINDOW_SIZE.x, GameConfig.DESIGN_RESOLUTION.x)
