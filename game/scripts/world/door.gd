class_name Door
extends Interactable
## Дверь: открывается и закрывается, разрушаема.
##
## ПОЧЕМУ ОТДЕЛЬНЫЙ КЛАСС, А НЕ НАСТРОЙКА ИЗ СТРОИТЕЛЯ. Interactable принимает
## действие как Callable. Если бы строитель интерьеров передавал сюда свой
## метод, ссылка вела бы на RefCounted, который освобождается сразу после
## постройки чанка: игрок нажимает «взаимодействовать» — и вызов уходит в
## мёртвый объект. Дверь обязана владеть своим состоянием сама, потому что
## живёт в дереве сцены ровно столько, сколько существует чанк.
##
## ПОЧЕМУ НАЧАЛО КООРДИНАТ В ПЕТЛЕ. Узел стоит в точке петли, а полотно
## смещено на половину ширины вдоль локальной X. Тогда поворот узла вокруг
## Y — это поворот вокруг петли. Если бы узел стоял в центре проёма, дверь
## распахивалась бы, вращаясь вокруг собственной середины, и створка
## проходила бы сквозь стену.
##
## Полотно намеренно сделано ПРЯМЫМ потомком: Interactable ищет цель
## подсветки среди детей первого уровня, и вложенное в «пивот» полотно
## осталось бы без контура при наведении.

signal door_toggled(door: Door, is_open: bool)

## Запас зоны взаимодействия относительно полотна, м.
##
## Зона чуть больше двери: игрок метит примерно в центр проёма, и узкая
## зона заставляла бы искать точку, в которой появляется подсказка.
const TRIGGER_MARGIN: float = 0.35

## Угол полного открытия, градусы. Больше 90°, чтобы створка уходила за
## плоскость стены и не перегораживала проход.
@export var open_angle_degrees: float = 104.0
## Длительность поворота, секунды. Мгновенное открытие читается как баг.
@export var swing_seconds: float = 0.85
## Направление распахивания: +1 — по часовой, -1 — против.
@export var hinge_direction: float = 1.0
## Открыта ли дверь изначально.
@export var starts_open: bool = false
## Заперта ли дверь. Запертая дверь остаётся взаимодействуемой, но не
## открывается: подсказка меняется, и игрок понимает, что нужно искать ключ.
@export var locked: bool = false
## Подсказка для запертой двери.
@export var locked_prompt: String = "Заперто"

var _leaf: MeshInstance3D = null
var _blocker: StaticBody3D = null
var _destructible: Destructible = null
var _swing: Tween = null
var _is_open: bool = false
var _closed_yaw: float = 0.0


## Строит полотно, зону взаимодействия и разрушаемую обёртку.
##
## Вызывается ДО добавления в дерево: Interactable и Destructible ищут свои
## цели в _ready(), и к этому моменту потомки обязаны уже существовать.
##
## size задан в системе координат стены: x — ширина вдоль стены,
## y — высота, z — толщина.
func configure(size: Vector3, material: Material, integrity: float) -> void:
	_closed_yaw = rotation.y

	_leaf = MeshInstance3D.new()
	_leaf.name = "leaf"
	var box: BoxMesh = BoxMesh.new()
	box.size = size
	_leaf.mesh = box
	_leaf.material_override = material
	_leaf.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
	# Полотно смещено от петли на половину ширины.
	_leaf.position = Vector3(size.x * 0.5, 0.0, 0.0)
	add_child(_leaf)

	# Коллизия полотна — BoxShape3D, а не трассировка меша. Дверь тонкая и
	# выпуклая: коробочная форма точнее, дешевле и, в отличие от вогнутой
	# трассировки, корректно ведёт себя при повороте.
	_blocker = StaticBody3D.new()
	_blocker.name = "blocker"
	_blocker.collision_layer = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD)
	_blocker.collision_mask = 0
	var blocker_shape: CollisionShape3D = CollisionShape3D.new()
	var blocker_box: BoxShape3D = BoxShape3D.new()
	blocker_box.size = size
	blocker_shape.shape = blocker_box
	blocker_shape.position = Vector3(size.x * 0.5, 0.0, 0.0)
	_blocker.add_child(blocker_shape)
	add_child(_blocker)

	# Зона взаимодействия.
	var trigger: CollisionShape3D = CollisionShape3D.new()
	trigger.name = "trigger"
	var trigger_box: BoxShape3D = BoxShape3D.new()
	trigger_box.size = Vector3(
		size.x + TRIGGER_MARGIN * 2.0, size.y + TRIGGER_MARGIN, size.z + TRIGGER_MARGIN * 2.0
	)
	trigger.shape = trigger_box
	trigger.position = Vector3(size.x * 0.5, 0.0, 0.0)
	add_child(trigger)

	# Разрушаемость. Узел создан, а не найден: полотно — брат ему, а не
	# потомок, поэтому автопоиск MeshInstance3D среди детей здесь бы не сработал.
	_destructible = Destructible.new()
	_destructible.name = "destructible"
	_destructible.integrity = integrity
	_destructible.break_energy = clampf(integrity * 0.4, 40.0, 200.0)
	_destructible.mesh_node = _leaf
	_destructible.collider_node = _blocker
	_destructible.destroyed.connect(_on_destroyed)
	add_child(_destructible)

	if starts_open:
		_is_open = true
	_update_prompt()


func _ready() -> void:
	# Сначала собственный _ready базового класса: он подключает сигнал фокуса
	# и ищет цель подсветки. Порядок обратный оставил бы дверь без контура.
	super()
	action = _on_interact
	action_name = "interact"
	if _is_open:
		rotation.y = _closed_yaw + deg_to_rad(open_angle_degrees) * hinge_direction


## Открыта ли дверь.
func is_open() -> bool:
	return _is_open


## Заперта ли дверь.
func is_locked() -> bool:
	return locked


## Отпирает или запирает дверь.
func set_locked(value: bool) -> void:
	locked = value
	_update_prompt()


## Возвращает разрушаемую часть двери.
func destructible() -> Destructible:
	return _destructible


## Обработка взаимодействия.
func _on_interact(_actor: Node) -> void:
	if locked:
		Diagnostics.debug("door", "%s: заперта" % name)
		return
	toggle()


## Переключает состояние двери.
func toggle() -> void:
	_is_open = not _is_open
	_update_prompt()
	var target: float = _closed_yaw
	if _is_open:
		target = _closed_yaw + deg_to_rad(open_angle_degrees) * hinge_direction
	if _swing != null and _swing.is_valid():
		_swing.kill()
	# Твин, а не мгновенная установка: дверь обязана быть видна в движении,
	# иначе игрок не понимает, открыл он её или она была открыта всегда.
	_swing = create_tween()
	(
		_swing
		. tween_property(self, "rotation:y", target, swing_seconds)
		. set_trans(Tween.TRANS_SINE)
		. set_ease(Tween.EASE_IN_OUT)
	)
	door_toggled.emit(self, _is_open)
	# Звук намеренно не воспроизводится. AudioService.play_sfx_3d() принимает
	# готовый AudioStream, а звуковых ассетов в проекте пока нет: вызов с
	# пустым потоком дал бы предупреждение на каждое нажатие. Подключение
	# звука — задача этапа наполнения ассетами, и место для него отмечено
	# сигналом door_toggled: подписчику не важно, кто именно звучит.
	Diagnostics.count("doors_toggled")


## Реакция на разрушение полотна.
func _on_destroyed(_destructible_node: Node3D) -> void:
	# Разрушенную дверь нельзя ни открыть, ни закрыть: полотна больше нет,
	# а подсказка «Открыть» над пустым проёмом — очевидная ложь.
	action = Callable()
	set_process_input(false)
	if _swing != null and _swing.is_valid():
		_swing.kill()
	prompt = ""
	Diagnostics.debug("door", "%s: полотно разрушено" % name)


## Обновляет подсказку под текущее состояние.
func _update_prompt() -> void:
	if locked:
		prompt = locked_prompt
	elif _is_open:
		prompt = "Закрыть"
	else:
		prompt = "Открыть"
