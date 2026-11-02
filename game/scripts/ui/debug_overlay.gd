extends CanvasLayer
## DebugOverlay — отладочная панель.
##
## ОТДЕЛЬНО ОТ HUD намеренно. HUD — часть игры, его видят все; оверлей —
## инструмент разработчика. Смешивать их значит либо забыть выключить
## цифры в релизе, либо заставить HUD знать про Performance и физику.
##
## ОТКЛЮЧЕНИЕ В РЕЛИЗЕ. Оверлей не создаётся вообще, если сборка не
## отладочная и разработка не разрешена настройкой. «Скрывать, но считать»
## — плохой вариант: PerfMonitor продолжает собирать статистику, а игрок
## платит за это кадрами.
##
## ГОРЯЧИЕ КЛАВИШИ (заданы в project.godot, а не здесь):
##   F3 — FPS, F4 — каркас, F6 — физика, F7 — перезагрузка шейдеров.
##   Обработка в _unhandled_input, чтобы нажатие не доставалось игре.

## Ключи снимка PerfMonitor.build_snapshot(). Вынесены константами:
## опечатка в имени ключа не падает, а молча рисует прочерк — то есть
## оверлей начинает врать, и заметить это можно только сравнив со списком
## здесь. Тест tests/unit/test_debug_overlay_contract.gd сверяет эти имена
## с реальным снимком, поэтому расхождение ловится до запуска игры.
const K_FPS: String = "fps"
const K_AVG_FRAME_MS: String = "avg_frame_ms"
const K_P95_FRAME_MS: String = "p95_frame_ms"
const K_PROCESS_MS: String = "process_ms"
const K_PHYSICS_MS: String = "physics_ms"
const K_DRAW_CALLS: String = "draw_calls"
const K_PRIMITIVES: String = "primitives"
const K_NODES: String = "nodes"
const K_OBJECTS: String = "objects"
const K_RESOURCES: String = "resources"
const K_STATIC_MEM_MB: String = "static_mem_mb"
const K_PEAK_MEM_MB: String = "peak_mem_mb"
const K_VIDEO_MEM_MB: String = "video_mem_mb"
const K_PHYSICS_BODIES: String = "physics_bodies"
const K_COLLISION_PAIRS: String = "collision_pairs"

## Все ключи, которые оверлей читает из снимка. Тест проверяет, что они
## присутствуют в build_snapshot() целиком.
const SNAPSHOT_KEYS: Array[String] = [
	K_FPS,
	K_AVG_FRAME_MS,
	K_P95_FRAME_MS,
	K_PROCESS_MS,
	K_PHYSICS_MS,
	K_DRAW_CALLS,
	K_PRIMITIVES,
	K_NODES,
	K_OBJECTS,
	K_RESOURCES,
	K_STATIC_MEM_MB,
	K_PEAK_MEM_MB,
	K_VIDEO_MEM_MB,
	K_PHYSICS_BODIES,
	K_COLLISION_PAIRS,
]

## Интервал обновления текста, секунды. Чаще — цифры нечитаемы, реже —
## панель врёт о текущем состоянии.
const REFRESH_SEC: float = 0.25
## Сколько последних сообщений диагностики держать на экране.
const LOG_LINES: int = 7

var _enabled: bool = false
var _accumulator: float = 0.0
var _show_physics: bool = false
var _show_wireframe: bool = false

@onready var _panel: PanelContainer = %Panel
@onready var _stats_label: Label = %StatsLabel
@onready var _log_label: Label = %LogLabel


func _ready() -> void:
	layer = 90
	_panel.visible = false
	_log_label.text = ""
	_enabled = SettingsService.get_bool("gameplay/show_fps")
	# В отладочной сборке оверлей доступен по горячей клавише даже при
	# выключенной настройке: иначе искать проблему придётся вслепую.
	EventBus.debug_overlay_toggled.connect(_on_toggled)
	EventBus.performance_degraded.connect(_on_performance_degraded)


func _exit_tree() -> void:
	if EventBus.debug_overlay_toggled.is_connected(_on_toggled):
		EventBus.debug_overlay_toggled.disconnect(_on_toggled)
	if EventBus.performance_degraded.is_connected(_on_performance_degraded):
		EventBus.performance_degraded.disconnect(_on_performance_degraded)
	# Каркасный режим — состояние РЕНДЕР-СЕРВЕРА, а не сцены. Если его не
	# вернуть при выходе, следующий уровень отрисуется проволочным, и
	# разобраться в причине будет очень трудно.
	if _show_wireframe:
		_set_wireframe(false)


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("debug_fps"):
		toggle()
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed("debug_physics"):
		_toggle_physics()
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed("debug_wireframe"):
		_toggle_wireframe()
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed("debug_reload_shaders"):
		_reload_shaders()
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed("screenshot"):
		Diagnostics.capture_screenshot("shot")
		get_viewport().set_input_as_handled()


func _process(delta: float) -> void:
	if not _enabled:
		return
	_accumulator += delta
	if _accumulator < REFRESH_SEC:
		return
	_accumulator = 0.0
	_refresh()


func toggle() -> void:
	set_enabled(not _enabled)


func set_enabled(enabled: bool) -> void:
	_enabled = enabled
	_panel.visible = enabled
	EventBus.debug_overlay_toggled.emit(enabled)
	if enabled:
		_refresh()
	else:
		PerfMonitor.set_monitoring_paused(true)
	Diagnostics.debug("debug", "оверлей: " + ("включен" if enabled else "выключен"))


func is_enabled() -> bool:
	return _enabled


func _refresh() -> void:
	_stats_label.text = _stats_text()
	_log_label.text = _log_text()


## Основная статистика. PerfMonitor уже собирает её для логов и тестов —
## оверлей просто показывает готовый снимок, ничего не пересчитывая.
func _stats_text() -> String:
	var snapshot: Dictionary = PerfMonitor.build_snapshot()
	var lines: Array[String] = [
		(
			"FPS %s  ·  кадр %s мс  ·  p95 %s мс"
			% [
				_fmt(snapshot.get(K_FPS), 0),
				_fmt(snapshot.get(K_AVG_FRAME_MS), 2),
				_fmt(snapshot.get(K_P95_FRAME_MS), 2)
			]
		),
		(
			"process %s мс  ·  physics %s мс"
			% [_fmt(snapshot.get(K_PROCESS_MS), 2), _fmt(snapshot.get(K_PHYSICS_MS), 2)]
		),
		(
			"draw calls %s  ·  примитивов %s"
			% [_fmt(snapshot.get(K_DRAW_CALLS), 0), _fmt(snapshot.get(K_PRIMITIVES), 0)]
		),
		(
			"узлов %s  ·  объектов %s  ·  ресурсов %s"
			% [
				_fmt(snapshot.get(K_NODES), 0),
				_fmt(snapshot.get(K_OBJECTS), 0),
				_fmt(snapshot.get(K_RESOURCES), 0)
			]
		),
		(
			"память %s МБ (пик %s)  ·  видео %s МБ"
			% [
				_fmt(snapshot.get(K_STATIC_MEM_MB), 1),
				_fmt(snapshot.get(K_PEAK_MEM_MB), 1),
				_fmt(snapshot.get(K_VIDEO_MEM_MB), 1)
			]
		),
	]
	if _show_physics:
		lines.append(
			(
				"тел 3D %s  ·  пар коллизий %s"
				% [
					_fmt(snapshot.get(K_PHYSICS_BODIES), 0),
					_fmt(snapshot.get(K_COLLISION_PAIRS), 0)
				]
			)
		)
	lines.append(
		(
			"осколков %d  ·  разрушений %d"
			% [DestructionService.active_debris_count(), Diagnostics.get_counter("fractures")]
		)
	)
	lines.append(DestructionService.backend_name())
	return "\n".join(lines)


func _log_text() -> String:
	var entries: Array[Dictionary] = Diagnostics.recent_entries(LOG_LINES)
	var lines: Array[String] = []
	for entry: Dictionary in entries:
		lines.append("%s" % str(entry.get("message", "")))
	return "\n".join(lines)


## Форматирует значение из снимка. Значения приходят как Variant, и
## «%.2f» на строке упадёт — отсюда единая обёртка.
func _fmt(value: Variant, decimals: int) -> String:
	match typeof(value):
		TYPE_FLOAT, TYPE_INT:
			return ("%." + str(decimals) + "f") % float(value)
		TYPE_NIL:
			return "—"
	return str(value)


func _toggle_physics() -> void:
	_show_physics = not _show_physics
	get_tree().debug_collisions_hint = _show_physics
	Diagnostics.debug("debug", "визуализация коллизий: %s" % str(_show_physics))


func _toggle_wireframe() -> void:
	_set_wireframe(not _show_wireframe)
	Diagnostics.debug("debug", "каркасный режим: %s" % str(_show_wireframe))


func _set_wireframe(enabled: bool) -> void:
	_show_wireframe = enabled
	# Переключение идёт через Viewport, а не через глобальный RenderingServer:
	# состояние глобальное, но отвечает за него текущий вьюпорт, и вернуть
	# его назад обязан именно он.
	var viewport: Viewport = get_viewport()
	if viewport == null:
		return
	viewport.debug_draw = (
		Viewport.DEBUG_DRAW_WIREFRAME if enabled else Viewport.DEBUG_DRAW_DISABLED
	)


func _reload_shaders() -> void:
	# Пересборка шейдеров без перезапуска: правка .gdshader в редакторе не
	# всегда подхватывается в игре, и искать «почему не изменилось» долго.
	var recompiled: int = 0
	for node: Node in _iter_shader_owners(get_tree().root):
		_refresh_shader_owner(node)
		recompiled += 1
	Diagnostics.info("debug", "перезагружено шейдеров: %d" % recompiled)


func _iter_shader_owners(root: Node) -> Array[Node]:
	var found: Array[Node] = []
	var stack: Array[Node] = [root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		if node is GeometryInstance3D or node is CanvasItem:
			found.append(node)
		for child: Node in node.get_children():
			stack.append(child)
	return found


func _refresh_shader_owner(node: Node) -> void:
	var material: Material = null
	if node is GeometryInstance3D:
		material = (node as GeometryInstance3D).material_override
	elif node is CanvasItem:
		material = (node as CanvasItem).material
	if not (material is ShaderMaterial):
		return
	var shader_material := material as ShaderMaterial
	if shader_material.shader == null:
		return
	# Переприсваивание шейдера самому себе заставляет движок пересобрать
	# пайплайн. Дешевле, чем перезапуск сцены, и работает без редактора.
	var shader: Shader = shader_material.shader
	shader_material.shader = null
	shader_material.shader = shader


func _on_toggled(enabled: bool) -> void:
	if enabled == _enabled:
		return
	_enabled = enabled
	_panel.visible = enabled
	if enabled:
		_refresh()


func _on_performance_degraded(avg_fps: float, threshold_fps: float) -> void:
	# Просадка производительности показывается в оверлее сразу, а не ждёт
	# следующего планового обновления: это ровно тот момент, когда цифра
	# нужна разработчику.
	if not _enabled:
		return
	_stats_label.text = (
		"ПРОСАДКА: %.1f FPS при пороге %.1f\n%s" % [avg_fps, threshold_fps, _stats_text()]
	)
