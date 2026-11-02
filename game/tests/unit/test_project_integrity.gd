extends GutTest
## Тесты целостности проекта.
##
## Проверяют то, что ломается БЕЗ ошибки компиляции: опечатка в пути сцены,
## удалённый автолоад, потерянное действие ввода. В редакторе это выглядит
## как «игра запускается и сразу чёрный экран», а ищется часами.
##
## Источник правды — ProjectSettings и InputMap, то есть то же самое, что
## видит движок в рантайме. Проверка отдельного текста project.godot
## разошлась бы с реальностью после первого же экспорта.

## Порядок автолоадов. ВАЖЕН: GameConfig первым, потому что на него
## ссылаются все остальные; EventBus вторым, потому что его используют
## все сервисы. Тест фиксирует порядок, а не только состав.
const EXPECTED_AUTOLOADS: Array[String] = [
	"GameConfig",
	"EventBus",
	"Diagnostics",
	"PerfMonitor",
	"SettingsService",
	"SaveService",
	"AudioService",
	"SceneService",
	"QualityService",
	"ThemeService",
	"DestructionService",
]

## Действия ввода из project.godot. Список намеренно продублирован здесь:
## если действие удалят из настроек, тест укажет на конкретное имя, а не
## сообщит «что-то не так с вводом» в рантайме.
const EXPECTED_ACTIONS: Array[String] = [
	"move_forward",
	"move_back",
	"move_left",
	"move_right",
	"sprint",
	"crouch",
	"jump",
	"interact",
	"look",
	"primary_action",
	"secondary_action",
	"reload",
	"drop",
	"pause",
	"inventory",
	"map",
	"menu_accept",
	"menu_cancel",
	"menu_up",
	"menu_down",
	"menu_left",
	"menu_right",
	"quick_save",
	"quick_load",
	"screenshot",
	"debug_fps",
	"debug_physics",
	"debug_wireframe",
	"debug_console",
	"debug_reload_shaders",
	"debug_poi_village",
	"debug_poi_bunker",
]

## Сцены, которые обязаны существовать: на них ссылаются GameConfig и
## другие сцены. Отсутствующая сцена — это гарантированный вылет при
## переходе, а не предупреждение.
const EXPECTED_SCENES: Array[String] = [
	GameConfig.SCENE_BOOT,
	GameConfig.SCENE_MAIN_MENU,
	GameConfig.SCENE_WORLD,
	GameConfig.SCENE_LOADING,
	"res://scenes/menu/menu_backdrop.tscn",
	"res://scenes/menu/settings_panel.tscn",
	"res://scenes/menu/credits_panel.tscn",
	"res://scenes/game/player.tscn",
	"res://scenes/game/hud.tscn",
	"res://scenes/game/debug_overlay.tscn",
]


func test_main_scene_is_set_and_exists() -> void:
	var main_scene: String = str(ProjectSettings.get_setting("run/main_scene", ""))
	assert_ne(main_scene, "", "run/main_scene не задана — игра не запустится")
	assert_true(ResourceLoader.exists(main_scene), "main_scene «%s» не существует" % main_scene)
	assert_eq(
		main_scene,
		GameConfig.SCENE_BOOT,
		"игру должен открывать boot, а не меню: boot подготавливает сервисы"
	)


func test_every_expected_scene_exists() -> void:
	for path: String in EXPECTED_SCENES:
		assert_true(ResourceLoader.exists(path), "нет сцены " + path)


func test_scene_paths_are_unique() -> void:
	var seen: Array[String] = []
	for path: String in EXPECTED_SCENES:
		assert_does_not_have(seen, path, "дубль в списке сцен: " + path)
		seen.append(path)


func test_every_autoload_is_registered() -> void:
	for autoload_name: String in EXPECTED_AUTOLOADS:
		var value: Variant = ProjectSettings.get_setting("autoload/" + autoload_name)
		assert_not_null(value, "автолоад «%s» не зарегистрирован" % autoload_name)


func test_autoload_scripts_exist() -> void:
	for autoload_name: String in EXPECTED_AUTOLOADS:
		var raw: Variant = ProjectSettings.get_setting("autoload/" + autoload_name)
		if raw == null:
			continue
		var path: String = str(raw)
		# Звёздочка означает «включить как синглтон» — её надо снять,
		# иначе ResourceLoader.exists() получает несуществующий путь.
		if path.begins_with("*"):
			path = path.substr(1)
		assert_true(
			ResourceLoader.exists(path),
			"автолоад «%s» указывает на несуществующий %s" % [autoload_name, path]
		)


func test_autoloads_are_available_at_runtime() -> void:
	# Регистрация в project.godot и реальное наличие узла — разные вещи:
	# при ошибке в пути узел молча не создаётся, а обращение к нему падает.
	for autoload_name: String in EXPECTED_AUTOLOADS:
		var node: Node = get_node_or_null("/root/" + autoload_name)
		assert_not_null(node, "автолоад «%s» не создан в дереве" % autoload_name)


func test_game_config_is_the_first_autoload() -> void:
	# Все остальные сервисы читают константы GameConfig в своём _ready().
	# Если GameConfig окажется позже, они получат null и упадут при старте.
	var root_children: Array[Node] = []
	for child: Node in get_tree().root.get_children():
		root_children.append(child)
	var config_index: int = -1
	for index in range(root_children.size()):
		if root_children[index].name == "GameConfig":
			config_index = index
	assert_gt(config_index, -1, "GameConfig не найден среди детей корня")
	# До GameConfig могут стоять только служебные узлы движка (GUT и т.п.),
	# но не наши сервисы.
	for index in range(config_index):
		var node_name: String = str(root_children[index].name)
		assert_does_not_have(
			EXPECTED_AUTOLOADS, node_name, "автолоад «%s» создан РАНЬШЕ GameConfig" % node_name
		)


func test_every_expected_input_action_exists() -> void:
	for action: String in EXPECTED_ACTIONS:
		assert_true(InputMap.has_action(action), "нет действия ввода " + action)


func test_movement_actions_have_both_keyboard_and_gamepad() -> void:
	# ТЗ требует профессионального интерфейса: игра без геймпада — это
	# не «не доделали», а отсечённая аудитория.
	var critical: Array[String] = [
		"move_forward",
		"move_back",
		"move_left",
		"move_right",
		"jump",
		"sprint",
		"interact",
		"pause",
		"menu_accept",
		"menu_cancel",
	]
	for action: String in critical:
		if not InputMap.has_action(action):
			continue
		var events: Array[InputEvent] = InputMap.action_get_events(action)
		var has_key: bool = false
		var has_pad: bool = false
		for event: InputEvent in events:
			if event is InputEventKey:
				has_key = true
			if event is InputEventJoypadButton or event is InputEventJoypadMotion:
				has_pad = true
		assert_true(has_key, "%s: нет привязки к клавиатуре" % action)
		assert_true(has_pad, "%s: нет привязки к геймпаду" % action)


func test_no_action_is_empty() -> void:
	# Действие без событий невозможно нажать. Оно молча «не работает».
	for action: String in EXPECTED_ACTIONS:
		if not InputMap.has_action(action):
			continue
		assert_gt(
			InputMap.action_get_events(action).size(),
			0,
			"%s: действие объявлено, но не привязано ни к чему" % action
		)


func test_pause_action_does_not_collide_with_movement() -> void:
	# Пересечение клавиш между паузой и движением даёт «игра встала, пока
	# я бежал». Проверяем физические коды, а не имена.
	var pause_codes: Array[int] = _physical_codes("pause")
	for action: String in [
		"move_forward", "move_back", "move_left", "move_right", "jump", "sprint", "interact"
	]:
		for code: int in _physical_codes(action):
			assert_does_not_have(
				pause_codes, code, "%s пересекается с pause по коду %d" % [action, code]
			)


func _physical_codes(action: String) -> Array[int]:
	var codes: Array[int] = []
	if not InputMap.has_action(action):
		return codes
	for event: InputEvent in InputMap.action_get_events(action):
		if event is InputEventKey:
			var key_event := event as InputEventKey
			var code: int = int(key_event.physical_keycode)
			codes.append(code if code != 0 else int(key_event.keycode))
	return codes


func test_rendering_backend_is_declared() -> void:
	# Forward Plus обязателен: SSAO, SDFGI и объёмный туман из профилей
	# качества в Compatibility не работают, и настройки графики станут
	# декоративными.
	var features: Variant = ProjectSettings.get_setting("application/config/features", [])
	assert_typeof(features, TYPE_ARRAY)
	if typeof(features) != TYPE_ARRAY:
		return
	var found_forward_plus: bool = false
	for feature: Variant in features:
		if str(feature) == "Forward Plus":
			found_forward_plus = true
	assert_true(found_forward_plus, "проект не объявляет рендер Forward Plus")


func test_physics_ticks_per_second_is_sane() -> void:
	var ticks: int = int(ProjectSettings.get_setting("physics/common/physics_ticks_per_second", 0))
	# Меньше 30 — физика «плывёт», больше 120 — процессор тратится впустую.
	assert_between(ticks, 30, 120, "physics_ticks_per_second = %d" % ticks)


func test_physics_layer_names_are_declared() -> void:
	for layer: int in GameConfig.PhysicsLayer.values():
		var setting: String = "layer_names/3d_physics/layer_%d" % layer
		var value: Variant = ProjectSettings.get_setting(setting, "")
		assert_ne(
			str(value).strip_edges(),
			"",
			"%s не задано: слои без имён невозможно отлаживать" % setting
		)


func test_stretch_mode_is_set() -> void:
	# Без stretch-настройки интерфейс ломается при любом размере окна,
	# отличном от проектного.
	var mode: String = str(ProjectSettings.get_setting("display/window/stretch/mode", ""))
	assert_ne(mode, "", "display/window/stretch/mode не задан")
	var aspect: String = str(ProjectSettings.get_setting("display/window/stretch/aspect", ""))
	assert_ne(aspect, "", "display/window/stretch/aspect не задан")


func test_gut_addon_is_present() -> void:
	# В GUT 9.6.1 нет assert_dir_exists — каталог проверяем через DirAccess.
	# Сам факт отсутствия такого ассерта поймал godot_api_check: он
	# индексирует class_name из addons/, поэтому знает реальный API GUT.
	assert_true(
		DirAccess.dir_exists_absolute("res://addons/gut"),
		"нет каталога res://addons/gut — тесты нечем запускать"
	)
	assert_file_exists("res://addons/gut/plugin.cfg")
	assert_true(
		ResourceLoader.exists("res://addons/gut/test.gd"),
		"нет базового класса GutTest — тесты не соберутся"
	)
