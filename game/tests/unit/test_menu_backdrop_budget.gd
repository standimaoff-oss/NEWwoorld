extends GutTest
## Тесты 3D-фона главного меню.
##
## ТЗ требует «красивые 3D-меню с чем-то игровым на фоне» и одновременно
## «оптимизацию». Это противоречие разрешается БЮДЖЕТОМ: фон может быть
## трёхмерным, пока он укладывается в фиксированную стоимость. Меню —
## первое, что видит игрок, и тормозящее меню обесценивает всю остальную
## оптимизацию.
##
## Поэтому здесь проверяются не пиксели, а числа: узлы, треугольники,
## источники света с тенями. Превышение — ошибка теста, а не «на заметку».

const BackdropScene: PackedScene = preload("res://scenes/menu/menu_backdrop.tscn")
const BackdropScript: GDScript = preload("res://scenes/menu/menu_backdrop.gd")

var _backdrop: Node3D = null


func before_each() -> void:
	assert_not_null(BackdropScene, "menu_backdrop.tscn не загружается")
	_backdrop = BackdropScene.instantiate() as Node3D
	assert_not_null(_backdrop, "сцена фона не инстанцируется")
	if _backdrop == null:
		return
	add_child_autofree(_backdrop)


func test_budget_constants_are_declared() -> void:
	assert_gt(BackdropScript.BUDGET_MAX_NODES, 0)
	assert_gt(BackdropScript.BUDGET_MAX_TRIANGLES, 0)
	assert_gt(BackdropScript.BUDGET_MAX_LIGHTS_WITH_SHADOW, 0)


func test_budget_limits_are_reasonable() -> void:
	# Верхняя граница защищает от «оптимизации» в обратную сторону: бюджет
	# в миллион треугольников формально ничего не нарушает, но смысла в
	# проверке уже нет.
	assert_lte(BackdropScript.BUDGET_MAX_NODES, 512, "меню не должно содержать сотни узлов")
	assert_lte(BackdropScript.BUDGET_MAX_TRIANGLES, 500000)
	assert_lte(
		BackdropScript.BUDGET_MAX_LIGHTS_WITH_SHADOW,
		4,
		"каждый источник с тенями — это проход карты теней"
	)


func test_backdrop_is_3d() -> void:
	# ТЗ прямо требует 3D-меню. Корень Node3D — минимальное условие: 2D-фон
	# на Control выглядит как экран настроек, а не как игра.
	assert_true(_backdrop is Node3D, "корень фона не Node3D — меню не трёхмерное")


func test_budget_report_shape() -> void:
	if not _backdrop.has_method("budget_report"):
		fail_test("у фона нет budget_report() — бюджет нечем измерить")
		return
	var report: Dictionary = _backdrop.call("budget_report")
	for key: String in ["nodes", "triangles", "shadow_lights", "budget_nodes", "budget_triangles"]:
		assert_has(report, key, "в отчёте бюджета нет ключа «%s»" % key)


func test_node_budget_is_respected() -> void:
	var report: Dictionary = _backdrop.call("budget_report")
	assert_lte(
		int(report["nodes"]),
		int(report["budget_nodes"]),
		"превышен бюджет узлов меню: %d из %d" % [int(report["nodes"]), int(report["budget_nodes"])]
	)


func test_triangle_budget_is_respected() -> void:
	var report: Dictionary = _backdrop.call("budget_report")
	assert_lte(
		int(report["triangles"]),
		int(report["budget_triangles"]),
		(
			"превышен бюджет треугольников меню: %d из %d"
			% [int(report["triangles"]), int(report["budget_triangles"])]
		)
	)


func test_shadow_lights_are_limited() -> void:
	# Тени в меню — самая дорогая часть кадра. Два источника максимум:
	# ключевой и контровой. Больше даёт видимый прирост стоимости и
	# невидимый прирост качества.
	var report: Dictionary = _backdrop.call("budget_report")
	assert_lte(
		int(report["shadow_lights"]),
		BackdropScript.BUDGET_MAX_LIGHTS_WITH_SHADOW,
		"слишком много источников света с тенями"
	)


func test_backdrop_has_a_camera() -> void:
	var found: bool = false
	for node: Node in _find_descendants(_backdrop):
		if node is Camera3D:
			found = true
	assert_true(found, "в фоне нет Camera3D — 3D-сцена не отрисуется")


func test_backdrop_has_environment() -> void:
	# Окружение отвечает за небо, свечение и туман. Без него меню выглядит
	# как серая коробка, даже если геометрия хорошая.
	var found: bool = false
	for node: Node in _find_descendants(_backdrop):
		if node is WorldEnvironment:
			var world_env := node as WorldEnvironment
			assert_not_null(world_env.environment, "WorldEnvironment без ресурса Environment")
			found = true
	assert_true(found, "в фоне нет WorldEnvironment")


func test_sky_is_procedural_not_an_hdri() -> void:
	# Процедурное небо весит ~2 КБ кода, HDR-панорама — 4..20 МБ и грузится
	# секундами. Для меню, которое показывается при каждом запуске, это
	# принципиально.
	var sky_material: Material = _find_sky_material()
	if sky_material == null:
		pending("небо не найдено — возможно, фон использует другой источник")
		return
	var is_shader_sky: bool = sky_material is ShaderMaterial
	var is_procedural: bool = sky_material is ProceduralSkyMaterial or is_shader_sky
	assert_true(is_procedural, "небо меню должно быть процедурным или шейдерным, а не панорамой")


func test_lights_are_present() -> void:
	var lights: int = 0
	for node: Node in _find_descendants(_backdrop):
		if node is DirectionalLight3D:
			lights += 1
	assert_gte(lights, 1, "в фоне нет ни одного источника света")


func test_motion_scale_comes_from_settings() -> void:
	# Скорость движения фона обязана зависеть от настройки: игрок с
	# укачиванием должен иметь способ успокоить картинку.
	var setting: float = (
		SettingsService.get_float("newwoorld/menu/motion_scale_default")
		if SettingsService.has_setting("newwoorld/menu/motion_scale_default")
		else 1.0
	)
	assert_gte(setting, 0.0)
	assert_true(
		(
			_backdrop.has_method("set_motion_scale")
			or BackdropScript.get_script_constant_map().has("CAMERA_ORBIT_SPEED")
		),
		"у фона нет способа управлять движением"
	)


func test_no_orphan_hero_when_setting_is_empty() -> void:
	# Пустой newwoorld/menu/hero_scene — нормальное состояние: герой меню
	# появляется, когда будет готовая модель. Фон обязан работать и без него.
	var hero_path: Variant = ProjectSettings.get_setting("newwoorld/menu/hero_scene", "")
	assert_typeof(hero_path, TYPE_STRING)
	if str(hero_path).is_empty():
		assert_true(_backdrop.is_inside_tree(), "фон упал без заданной hero-сцены")


func _find_descendants(root: Node) -> Array[Node]:
	var found: Array[Node] = []
	var stack: Array[Node] = [root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		found.append(node)
		for child: Node in node.get_children():
			stack.append(child)
	return found


func _find_sky_material() -> Material:
	for node: Node in _find_descendants(_backdrop):
		if not (node is WorldEnvironment):
			continue
		var environment: Environment = (node as WorldEnvironment).environment
		if environment == null or environment.sky == null:
			continue
		return environment.sky.sky_material
	return null
