extends GutTest
## Смоук-тесты: всё критичное должно ЗАГРУЖАТЬСЯ.
##
## Отдельный каталог smoke/, а не unit/, потому что эти тесты отвечают на
## другой вопрос. Unit спрашивает «правильно ли работает», smoke — «не
## сломано ли настолько, что не запускается». Прогон smoke занимает
## секунды и запускается на каждом коммите; полный прогон — перед релизом.
##
## Здесь намеренно НЕ проверяется поведение. Проверка «сцена открылась» —
## уже огромная часть пользы: битая ссылка на ext_resource, отсутствующий
## скрипт или ошибка разбора .tscn ловятся именно так.

const SCENES_TO_LOAD: Array[String] = [
	"res://scenes/boot/boot.tscn",
	"res://scenes/menu/main_menu.tscn",
	"res://scenes/menu/menu_backdrop.tscn",
	"res://scenes/menu/settings_panel.tscn",
	"res://scenes/menu/credits_panel.tscn",
	"res://scenes/common/loading_screen.tscn",
	"res://scenes/common/pause_menu.tscn",
	"res://scenes/game/world.tscn",
	# Карта 500 × 500 м с деревней и бункером. В файле нет геометрии — все
	# 400 чанков строит WorldStream в рантайме, поэтому здесь проверяется
	# только целостность сцены и её внешних ссылок.
	"res://scenes/game/military_map.tscn",
	"res://scenes/game/player.tscn",
	"res://scenes/game/hud.tscn",
	"res://scenes/game/debug_overlay.tscn",
]

const SCRIPTS_TO_LOAD: Array[String] = [
	"res://scripts/autoload/game_config.gd",
	"res://scripts/autoload/event_bus.gd",
	"res://scripts/autoload/diagnostics.gd",
	"res://scripts/autoload/perf_monitor.gd",
	"res://scripts/autoload/settings_service.gd",
	"res://scripts/autoload/save_service.gd",
	"res://scripts/autoload/audio_service.gd",
	"res://scripts/autoload/scene_service.gd",
	"res://scripts/autoload/quality_service.gd",
	"res://scripts/settings/settings_schema.gd",
	"res://scripts/systems/destruction_service.gd",
	"res://scripts/systems/wind_system.gd",
	"res://scripts/systems/object_pool.gd",
	"res://scripts/systems/quality_profile.gd",
	"res://scripts/ui/theme_builder.gd",
	"res://scripts/ui/settings_form.gd",
	"res://scripts/ui/hud.gd",
	"res://scripts/ui/debug_overlay.gd",
	"res://scripts/player/player_controller.gd",
	"res://scripts/world/world.gd",
	"res://scripts/world/destructible.gd",
	# Grenade и Structure идут ПОСЛЕ destruction_service и destructible:
	# граната вызывает explode(), а структура подписывается на сигнал
	# Destructible.destroyed. Загрузка в обратном порядке дала бы
	# «Could not resolve class» на ровном месте.
	"res://scripts/systems/grenade.gd",
	"res://scripts/world/structure.gd",
	"res://scripts/world/interactable.gd",
	"res://scripts/world/map_config.gd",
	"res://scripts/world/terrain_generator.gd",
	"res://scripts/world/village_layout.gd",
	# Порядок здесь — порядок зависимостей: SurfaceRules ключует таблицы
	# перечислениями RoomLayout, поэтому RoomLayout обязан загрузиться раньше.
	# Проверка загрузки в неправильном порядке дала бы «Could not resolve
	# class» на ровном месте.
	"res://scripts/world/material_library.gd",
	"res://scripts/world/room_layout.gd",
	"res://scripts/world/surface_rules.gd",
	"res://scripts/world/poi_details.gd",
	"res://scripts/world/door.gd",
	"res://scripts/world/interior_builder.gd",
	"res://scripts/world/chunk_builder.gd",
	"res://scripts/world/world_stream.gd",
	"res://scripts/world/military_map.gd",
	"res://scripts/util/validators.gd",
]

const RESOURCES_TO_LOAD: Array[String] = [
	"res://default_bus_layout.tres",
	"res://resources/environment/default_env.tres",
	"res://resources/environment/military_env.tres",
	"res://resources/quality/quality_low.tres",
	"res://resources/quality/quality_medium.tres",
	"res://resources/quality/quality_high.tres",
	"res://resources/quality/quality_ultra.tres",
	"res://icon.svg",
]

const SHADERS_TO_LOAD: Array[String] = [
	"res://shaders/wind_foliage.gdshader",
	"res://shaders/dissolve_destruction.gdshader",
	"res://shaders/menu_backdrop_sky.gdshader",
	"res://shaders/post_grade.gdshader",
	"res://shaders/water_surface.gdshader",
	"res://shaders/outline_select.gdshader",
]


func test_all_scenes_exist_on_disk() -> void:
	for path: String in SCENES_TO_LOAD:
		assert_true(ResourceLoader.exists(path), "нет файла сцены " + path)


func test_all_scenes_load_as_packed_scene() -> void:
	for path: String in SCENES_TO_LOAD:
		if not ResourceLoader.exists(path):
			continue
		var resource: Resource = load(path)
		assert_not_null(resource, "не загружается " + path)
		if resource == null:
			continue
		assert_true(
			resource is PackedScene,
			"%s загрузился как %s, а не PackedScene" % [path, resource.get_class()]
		)


func test_all_scripts_load() -> void:
	for path: String in SCRIPTS_TO_LOAD:
		assert_true(ResourceLoader.exists(path), "нет скрипта " + path)
		if not ResourceLoader.exists(path):
			continue
		var resource: Resource = load(path)
		assert_not_null(resource, "не загружается скрипт " + path)
		if resource == null:
			continue
		assert_true(resource is GDScript, "%s не GDScript" % path)


func test_all_scripts_compile() -> void:
	# reload() возвращает ошибку разбора. Это сильнее, чем load(): скрипт
	# может загрузиться как ресурс, но не собраться в класс.
	for path: String in SCRIPTS_TO_LOAD:
		if not ResourceLoader.exists(path):
			continue
		var script: GDScript = load(path) as GDScript
		if script == null:
			continue
		assert_eq(script.reload(), OK, "скрипт не компилируется: " + path)


func test_all_resources_load() -> void:
	for path: String in RESOURCES_TO_LOAD:
		assert_true(ResourceLoader.exists(path), "нет ресурса " + path)
		if not ResourceLoader.exists(path):
			continue
		assert_not_null(load(path), "не загружается " + path)


func test_all_shaders_load() -> void:
	for path: String in SHADERS_TO_LOAD:
		assert_true(ResourceLoader.exists(path), "нет шейдера " + path)
		if not ResourceLoader.exists(path):
			continue
		var shader: Shader = load(path) as Shader
		assert_not_null(shader, "не загружается шейдер " + path)
		if shader == null:
			continue
		# Пустой код шейдера — это файл, который кто-то очистил. Godot
		# загрузит его без ошибки, а материал станет прозрачным.
		assert_gt(shader.code.strip_edges().length(), 0, "шейдер пуст: " + path)


func test_quality_profiles_are_ordered() -> void:
	# Профили обязаны идти от слабого к сильному: QualityService снижает
	# качество по индексу, и переставленный порядок даст «Ultra» на слабом ПК.
	var previous_budget: int = -1
	for path: String in RESOURCES_TO_LOAD:
		if not path.contains("quality_"):
			continue
		var profile: Resource = load(path)
		if profile == null:
			continue
		var budget: int = int(profile.get("destruction_chunk_budget"))
		assert_gte(
			budget,
			previous_budget,
			(
				"%s: бюджет осколков %d меньше, чем у предыдущего профиля %d"
				% [path, budget, previous_budget]
			)
		)
		previous_budget = budget


func test_quality_service_sees_all_profiles() -> void:
	assert_eq(
		QualityService.profile_count(), 4, "ожидаются 4 профиля качества: low, medium, high, ultra"
	)
	var names: Array[String] = QualityService.profile_names()
	assert_eq(names.size(), 4)


func test_default_environment_is_valid() -> void:
	var environment: Environment = (
		load("res://resources/environment/default_env.tres") as Environment
	)
	assert_not_null(environment)
	if environment == null:
		return
	# Фон не должен быть «чёрной дырой»: BGMode.SKY или COLOR, иначе меню
	# и уровень открываются пустотой.
	assert_ne(
		int(environment.background_mode),
		int(Environment.BG_CLEAR_COLOR),
		"окружение по умолчанию очищает экран прозрачным цветом"
	)


func test_bus_layout_declares_project_buses() -> void:
	var layout: AudioBusLayout = load("res://default_bus_layout.tres") as AudioBusLayout
	assert_not_null(layout, "не загружается раскладка аудиошин")
	if layout == null:
		return
	# У AudioBusLayout в Godot 4.5 НЕТ методов перечисления шин: get_bus_count
	# и get_bus_name живут в AudioServer, который и применяет эту раскладку.
	# Проверка через сервер честнее: она подтверждает не только что ресурс
	# распарсился, но и что шины из него действительно действуют.
	var bus_names: Array[String] = []
	for index in range(AudioServer.get_bus_count()):
		bus_names.append(AudioServer.get_bus_name(index))
	for expected: String in GameConfig.AUDIO_BUSES:
		assert_has(
			bus_names,
			expected,
			"шина «%s» объявлена в GameConfig, но отсутствует в раскладке" % expected
		)


func test_theme_builds() -> void:
	# Тема строится кодом, поэтому «не собирается» здесь означает, что все
	# меню останутся с дефолтным серым оформлением Godot.
	var theme: Theme = ThemeService.build_theme()
	assert_not_null(theme, "build_theme() вернул null")
	if theme == null:
		return
	assert_gt(theme.get_font_size("font_size", "Label"), 0, "в теме нет размера шрифта для Label")


func test_theme_variations_exist() -> void:
	var theme: Theme = ThemeService.build_theme()
	if theme == null:
		fail_test("тема не собралась")
		return
	# Вариации используются в сценах через theme_type_variation. Отсутствующая
	# вариация не ошибка движка — элемент просто отрисуется базовым стилем,
	# и меню потеряет вид.
	for variation: String in [
		"MenuButton",
		"AccentButton",
		"DangerButton",
		"GhostButton",
		"DialogPanel",
		"InsetPanel",
		"DisplayLabel",
		"MonoLabel"
	]:
		assert_true(
			# has_type() в Theme нет — есть get_type_list().
			theme.get_type_list().has(variation) or _theme_has_stylebox(theme, variation),
			"в теме нет вариации «%s»" % variation
		)


func _theme_has_stylebox(theme: Theme, type_name: String) -> bool:
	for stylebox_name: String in ["panel", "normal", "focus"]:
		if theme.has_stylebox(stylebox_name, type_name):
			return true
	return false


func test_boot_scene_is_the_main_scene() -> void:
	var main_scene: String = str(ProjectSettings.get_setting("run/main_scene", ""))
	assert_eq(main_scene, "res://scenes/boot/boot.tscn")
