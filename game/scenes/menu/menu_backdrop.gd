extends Node3D
## MenuBackdrop — 3D-фон главного меню.
##
## ТРЕБОВАНИЕ ИЗ ТЗ: меню должно быть «в 3D, с фоном, связанным с игрой,
## и лёгкой анимацией вроде ветра». Реализация:
##   * процедурное небо (shaders/menu_backdrop_sky.gdshader) — плывущие
##     облака, дышащее солнце, мерцающие звёзды, ноль ассетов и ноль загрузки;
##   * двухточечный свет: тёплый ключевой + холодный контровой. Именно
##     контровой свет отделяет объект от фона и даёт «дорогую» картинку;
##     один источник света делает меню плоским, как скриншот из редактора;
##   * объёмный туман низкой плотности — связывает объект и фон в одну
##     воздушную перспективу;
##   * медленный дрейф камеры (idle drift). Камера никогда не стоит
##     абсолютно неподвижно: статичный кадр считывается как картинка,
##     а не как сцена.
##
## ГЕРОЙСКИЙ ОБЪЕКТ. В HeroRoot уровень подставляет то, что связано
## с конкретной игрой: меч, корабль, персонаж, артефакт. Backdrop не знает,
## что там будет, — он только подсвечивает и вращает. Это значит, что ОДНА
## сцена фона работает для любой игры на этом каркасе.
##
## СТОИМОСТЬ. Фон специально собран из примитивов и процедурных материалов:
## меню не должно грузиться дольше самой игры. Бюджет — см. _assert_budget().

## Скорость дрейфа камеры, градусы в секунду. Мало — иначе укачивает.
const CAMERA_ORBIT_SPEED: float = 0.85
## Амплитуда вертикального покачивания камеры, метры.
const CAMERA_BOB_AMPLITUDE: float = 0.045
const CAMERA_BOB_SPEED: float = 0.31
## Радиус орбиты камеры вокруг героя.
const CAMERA_ORBIT_RADIUS: float = 5.6
const CAMERA_HEIGHT: float = 1.9
## Вращение геройского объекта, градусы в секунду.
const HERO_SPIN_SPEED: float = 4.5
## Бюджеты фона. Проверяются при старте: если художник добавит в меню
## модель на 200k треугольников, мы узнаем об этом сразу, а не от игрока.
const BUDGET_MAX_NODES: int = 64
const BUDGET_MAX_TRIANGLES: int = 150000
const BUDGET_MAX_LIGHTS_WITH_SHADOW: int = 2

## Путь к геройской сцене. Переопределяется игрой в project.godot или
## кодом уровня. Пустой путь — фон работает без героя (только небо).
const HERO_SCENE_SETTING: String = "newwoorld/menu/hero_scene"

@export_group("Поведение фона")
## Включать ли медленный дрейф камеры.
@export var camera_drift_enabled: bool = true
## Вращать ли геройский объект.
@export var hero_spin_enabled: bool = true
## Множитель скорости всех анимаций. Ноль = полностью статичный кадр.
## Отдельная настройка доступна в меню: vestibular disorders — реальная
## причина, по которой людям нужны неподвижные фоны.
@export_range(0.0, 2.0, 0.05) var motion_scale: float = 1.0

var _camera_anchor: Node3D = null
var _camera: Camera3D = null
var _hero: Node3D = null
var _elapsed: float = 0.0
var _wind: Node = null


func _ready() -> void:
	_camera_anchor = $CameraAnchor
	_camera = %MenuCamera
	_resolve_wind_system()
	_load_hero()
	_apply_wind_materials()
	_assert_budget()
	EventBus.wind_changed.connect(_on_wind_changed)
	Diagnostics.info(
		"backdrop", "3D-фон меню готов: hero=%s" % ("есть" if _hero != null else "нет")
	)


## Отдельный метод, чтобы зависимость от ветра была явной и тестируемой.
func _resolve_wind_system() -> void:
	var found: Node = get_node_or_null("WindSystem")
	if found == null:
		# Ветер может жить в родительской сцене меню — ищем по группе.
		var nodes: Array[Node] = get_tree().get_nodes_in_group(&"wind_system")
		found = nodes[0] if not nodes.is_empty() else null
	_wind = found
	if _wind == null:
		Diagnostics.warn("backdrop", "WindSystem не найден — шейдеры получат нулевой ветер")


func _process(delta: float) -> void:
	_elapsed += delta * motion_scale
	if camera_drift_enabled and _camera_anchor != null:
		_update_camera()
	if hero_spin_enabled and _hero != null:
		_hero.rotate_y(deg_to_rad(HERO_SPIN_SPEED * delta * motion_scale))


func _update_camera() -> void:
	var angle: float = deg_to_rad(_elapsed * CAMERA_ORBIT_SPEED)
	var bob: float = sin(_elapsed * CAMERA_BOB_SPEED * TAU) * CAMERA_BOB_AMPLITUDE
	# Орбита не полная окружность, а сектор: камера качается влево-вправо.
	# Полное вращение уводит героя из-под пунктов меню — их становится
	# не прочитать. Сектор сохраняет композицию в любой момент времени.
	var swing: float = sin(angle) * 0.42
	_camera_anchor.position = Vector3(
		sin(swing) * CAMERA_ORBIT_RADIUS, CAMERA_HEIGHT + bob, cos(swing) * CAMERA_ORBIT_RADIUS
	)
	_camera_anchor.look_at(Vector3(0.0, 1.1, 0.0), Vector3.UP)


func _load_hero() -> void:
	var hero_path: String = str(ProjectSettings.get_setting(HERO_SCENE_SETTING, ""))
	if hero_path.is_empty():
		Diagnostics.debug("backdrop", "hero_scene не задан — фон без героя")
		return
	if not ResourceLoader.exists(hero_path):
		Diagnostics.error("backdrop", "hero_scene не найден: " + hero_path)
		return
	var packed: PackedScene = load(hero_path)
	if packed == null:
		Diagnostics.error("backdrop", "не загрузить hero_scene: " + hero_path)
		return
	_hero = packed.instantiate() as Node3D
	if _hero == null:
		Diagnostics.error("backdrop", "hero_scene — не Node3D")
		return
	$HeroRoot.add_child(_hero)


## Проходит по визуальным узлам героя и навешивает материал ветра на то,
## что должно качаться. Признак — группа "wind_affected" или имя материала.
## Не навешиваем на всё подряд: металл и камень, качающиеся на ветру,
## ломают доверие к картинке сильнее, чем их неподвижность.
func _apply_wind_materials() -> void:
	if _hero == null:
		return
	var affected: Array[Node] = _hero.find_children("*", "MeshInstance3D", true, false)
	var applied: int = 0
	for node: Node in affected:
		if not node.is_in_group(&"wind_affected"):
			continue
		var mesh_instance := node as MeshInstance3D
		var material := ShaderMaterial.new()
		material.shader = load("res://shaders/wind_foliage.gdshader")
		material.set_shader_parameter("wind_response", 0.6)
		material.set_shader_parameter("anchor_height", 0.0)
		mesh_instance.material_overlay = material
		applied += 1
	if applied > 0:
		Diagnostics.debug("backdrop", "материал ветра применён к %d узлам" % applied)


## Проверка бюджета фона. Работает как guard в рантайме И как тест:
## вызывается из tests/smoke/test_menu_backdrop_budget.gd.
func _assert_budget() -> Dictionary:
	var report: Dictionary = budget_report()
	if int(report["nodes"]) > BUDGET_MAX_NODES:
		Diagnostics.warn(
			"backdrop",
			"превышен бюджет узлов меню: %d > %d" % [int(report["nodes"]), BUDGET_MAX_NODES]
		)
	if int(report["triangles"]) > BUDGET_MAX_TRIANGLES:
		Diagnostics.warn(
			"backdrop",
			(
				"превышен бюджет треугольников меню: %d > %d"
				% [int(report["triangles"]), BUDGET_MAX_TRIANGLES]
			)
		)
	if int(report["shadow_lights"]) > BUDGET_MAX_LIGHTS_WITH_SHADOW:
		Diagnostics.warn(
			"backdrop", "слишком много источников света с тенями: %d" % int(report["shadow_lights"])
		)
	return report


func budget_report() -> Dictionary:
	var node_count: int = 0
	var triangles: int = 0
	var shadow_lights: int = 0
	var stack: Array[Node] = [self]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		node_count += 1
		for child: Node in node.get_children():
			stack.append(child)
		if node is MeshInstance3D:
			var mesh: Mesh = (node as MeshInstance3D).mesh
			if mesh != null:
				for surface: int in mesh.get_surface_count():
					triangles += _surface_triangle_count(mesh, surface)
		if node is DirectionalLight3D:
			if (node as DirectionalLight3D).shadow_enabled:
				shadow_lights += 1
		if node is OmniLight3D or node is SpotLight3D:
			if (node as Light3D).shadow_enabled:
				shadow_lights += 1
	return {
		"nodes": node_count,
		"triangles": triangles,
		"shadow_lights": shadow_lights,
		"budget_nodes": BUDGET_MAX_NODES,
		"budget_triangles": BUDGET_MAX_TRIANGLES,
	}


func _surface_triangle_count(mesh: Mesh, surface: int) -> int:
	var arrays: Array = mesh.surface_get_arrays(surface)
	if arrays.size() <= Mesh.ARRAY_INDEX:
		return 0
	var indices: Variant = arrays[Mesh.ARRAY_INDEX]
	if indices is PackedInt32Array:
		return (indices as PackedInt32Array).size() / 3
	var vertices: Variant = arrays[Mesh.ARRAY_VERTEX]
	if vertices is PackedVector3Array:
		return (vertices as PackedVector3Array).size() / 3
	return 0


func _on_wind_changed(_direction: Vector3, strength: float, _gustiness: float) -> void:
	# Глобальные shader-параметры публикует сам WindSystem, присваивать
	# их здесь не нужно. Но фон реагирует на силу ветра: при шквале туман
	# становится плотнее и небо — темнее. Мелочь, а сцена перестаёт быть
	# декорацией и начинает отвечать на состояние мира.
	var env_node: Node = %WorldEnvironment
	if env_node == null or not (env_node is WorldEnvironment):
		return
	var environment: Environment = (env_node as WorldEnvironment).environment
	if environment == null:
		return
	var gust_pressure: float = clampf(strength / 12.0, 0.0, 1.0)
	environment.volumetric_fog_density = lerpf(0.012, 0.026, gust_pressure)


## Точка подстановки геройского объекта извне (уровень/меню конкретной игры).
func set_hero(scene: PackedScene) -> void:
	if _hero != null and is_instance_valid(_hero):
		_hero.queue_free()
	if scene == null:
		_hero = null
		return
	_hero = scene.instantiate() as Node3D
	if _hero == null:
		Diagnostics.error("backdrop", "set_hero: сцена не Node3D")
		return
	$HeroRoot.add_child(_hero)
	_apply_wind_materials()
