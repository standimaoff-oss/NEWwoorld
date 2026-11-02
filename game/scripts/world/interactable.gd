class_name Interactable
extends Area3D
## Interactable — объект, с которым игрок может взаимодействовать.
##
## Area3D, а не StaticBody3D: взаимодействие определяется ПЕРЕСЕЧЕНИЕМ с
## лучом игрока, а не физическим столкновением. Тело для блокировки прохода
## настраивается отдельно (child CollisionObject3D в сцене объекта).
##
## КОНТРАКТ С ИГРОКОМ (player_controller.gd):
##   * состоит в группе &"interactable",
##   * реализует interact(actor: Node) -> void,
##   * публикует prompt через interaction_prompt().
## Игрок находит объект по лучу, поднимается до узла в группе и вызывает
## interact(). Больше он об этом классе не знает ничего.
##
## ПОДСВЕТКА через outline_select.gdshader как next_pass материала: контур
## рисуется «выдавливанием» обратной стороны меша, стоит один проход и не
## требует ни постобработки, ни буфера выделения.

signal interacted(actor: Node)
signal focus_changed(focused: bool)

## Текст подсказки. Показывается в HUD, когда игрок смотрит на объект.
@export var prompt: String = "Взаимодействовать"
## Действие вызывается при взаимодействии. Задаётся в инспекторе или кодом
## уровня — поэтому один и тот же класс обслуживает дверь, рычаг и ящик.
@export var action: Callable = Callable()
## Одноразовое ли взаимодействие. После срабатывания объект перестаёт
## отзываться и убирает подсветку.
@export var single_use: bool = false
## Требуется ли предмет/условие. Пустая строка = всегда доступно.
@export var requires_flag: String = ""
## Включать контур при наведении.
@export var highlight_on_focus: bool = true
## Материал контура. Создаётся кодом, если не задан: контур обязателен,
## иначе игрок не понимает, на что смотрит.
@export var outline_material: ShaderMaterial = null
## Ключ действия ввода, которое активирует объект. Совпадает с prompt —
## подсказка обязана называть ту кнопку, которая действительно работает.
@export var action_name: String = "interact"

var _is_used: bool = false
var _is_focused: bool = false
var _outline_owner: MeshInstance3D = null


func _ready() -> void:
	add_to_group(&"interactable")
	monitoring = false
	# monitorable обязателен: луч игрока настроен на collide_with_areas, и
	# без monitorable он пройдёт сквозь объект, не заметив его.
	monitorable = true
	input_ray_pickable = true
	_outline_owner = _find_highlight_target()
	if outline_material == null:
		outline_material = _build_outline_material()
	EventBus.interaction_focus_changed.connect(_on_global_focus_changed)
	_apply_availability()


func _exit_tree() -> void:
	if EventBus.interaction_focus_changed.is_connected(_on_global_focus_changed):
		EventBus.interaction_focus_changed.disconnect(_on_global_focus_changed)


## Точка входа, вызываемая игроком.
func interact(actor: Node) -> void:
	if _is_used or not is_available():
		return
	if not requires_flag.is_empty() and not _flag_satisfied():
		Diagnostics.debug("interactable", "%s: условие '%s' не выполнено" % [name, requires_flag])
		return
	if single_use:
		_is_used = true
	if action.is_valid():
		action.call(actor)
	else:
		# Действие не задано — это ошибка уровня, а не повод молча глотать
		# нажатие: игрок нажал E и ничего не произошло.
		Diagnostics.warn("interactable", "%s: action не задан" % name)
	interacted.emit(actor)
	Diagnostics.count("interactions")
	_apply_availability()


## Текст подсказки для HUD. Отдельным методом, а не свойством: подсказка
## может зависеть от состояния («Открыть» / «Заперто»).
func interaction_prompt() -> String:
	if _is_used:
		return ""
	if not requires_flag.is_empty() and not _flag_satisfied():
		return "%s — заперто" % prompt
	return "%s  [%s]" % [prompt, _action_key_label()]


func is_available() -> bool:
	return not _is_used


func is_focused() -> bool:
	return _is_focused


## Метка клавиши из карты ввода. Показывать «Нажмите E», когда действие
## назначено на F, — способ заставить игрока тыкать все кнопки подряд.
func _action_key_label() -> String:
	var events: Array[InputEvent] = InputMap.action_get_events(action_name)
	for event: InputEvent in events:
		if event is InputEventKey:
			var key_event := event as InputEventKey
			return OS.get_keycode_string(
				(
					key_event.physical_keycode
					if key_event.physical_keycode != KEY_NONE
					else key_event.keycode
				)
			)
		if event is InputEventJoypadButton:
			return "геймпад %d" % int((event as InputEventJoypadButton).button_index)
	return action_name


func _flag_satisfied() -> bool:
	# Флаги мира хранит уровень, а не этот объект: иначе каждая дверь
	# держала бы свою копию состояния игры.
	var level: Node = get_parent()
	while level != null:
		if level.has_method("has_world_flag"):
			return bool(level.call("has_world_flag", requires_flag))
		level = level.get_parent()
	Diagnostics.warn("interactable", "%s: уровень не реализует has_world_flag()" % name)
	return false


func set_focused(focused: bool) -> void:
	if _is_focused == focused:
		return
	_is_focused = focused
	if highlight_on_focus:
		_apply_outline(focused and not _is_used)
	focus_changed.emit(focused)


## Глобальный сигнал фокуса: игрок сообщает, НА ЧТО он смотрит. Сравниваем
## по идентичности, чтобы подсветка включалась ровно у одного объекта.
func _on_global_focus_changed(target: Node) -> void:
	set_focused(target == self)


func _apply_availability() -> void:
	if _is_used:
		set_focused(false)
		set_deferred("monitorable", false)
		# Убрать объект из группы, чтобы игрок перестал его находить:
		# поиск по группе дешевле, чем проверка is_used у каждого кандидата.
		remove_from_group(&"interactable")


func _apply_outline(enabled: boolean) -> void:
	if _outline_owner == null or outline_material == null:
		return
	# next_pass, а не material_override: контур рисуется ВТОРЫМ проходом
	# поверх основного материала, и основной материал объекта не теряется.
	_outline_owner.material_overlay = outline_material if enabled else null


func _find_highlight_target() -> MeshInstance3D:
	for child: Node in get_children():
		if child is MeshInstance3D:
			return child as MeshInstance3D
	var parent: Node = get_parent()
	if parent is MeshInstance3D:
		return parent as MeshInstance3D
	return null


## Собирает материал контура кодом. Загружать .tres ради одного шейдера
## не нужно: параметры всё равно настраиваются на месте.
func _build_outline_material() -> ShaderMaterial:
	var shader: Shader = load("res://shaders/outline_select.gdshader") as Shader
	if shader == null:
		Diagnostics.error("interactable", "не найден outline_select.gdshader")
		return null
	var material := ShaderMaterial.new()
	material.shader = shader
	material.render_priority = 1
	material.set_shader_parameter("outline_width", 0.022)
	material.set_shader_parameter("outline_color", Color(0.92, 0.78, 0.36))
	material.set_shader_parameter("blocked_color", Color(0.75, 0.25, 0.22))
	material.set_shader_parameter("pulse_speed", 2.2)
	material.set_shader_parameter("is_blocked", 0.0)
	return material
