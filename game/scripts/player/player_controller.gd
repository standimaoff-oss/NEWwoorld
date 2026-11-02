extends CharacterBody3D
## PlayerController — первое лицо: движение, обзор, выносливость, интерактив.
##
## ЧТО ЗДЕСЬ ПРИНЦИПИАЛЬНО:
##
## 1. СКОРОСТЬ ЗАДАНА В ЕДИНИЦАХ В СЕКУНДУ и берётся из @export, а не
##    «подбиралась, пока не стало приятно». Любой параметр движения можно
##    менять из инспектора и из теста, не трогая код.
##
## 2. УСКОРЕНИЕ/ТОРМОЖЕНИЕ раздельные и раздельные для земли и воздуха.
##    Единая константа даёт либо «коньки» на земле, либо «ватный» воздух.
##
## 3. ВЫНОСИМОСТЬ ограничивает спринт. Без неё спринт — единственная
##    кнопка движения, и остальной код движения мёртв.
##
## 4. FOV и тряска камеры берутся из настроек ДОСТУПНОСТИ, а не захардкожены:
##    accessibility/fov и accessibility/screen_shake. Игрок с укачиванием
##    обязан иметь способ убрать тряску полностью (screen_shake = 0).
##
## 5. head bob считается от ПРОЙДЕННОГО РАССТОЯНИЯ, а не от времени.
##    Покачивание по времени «плывёт» при низкой частоте кадров.
##
## Ввод обрабатывается в _unhandled_input, физика — в _physics_process.
## Смешивать их — способ получить пропущенные нажатия при падении FPS.

## Прибавка к FOV в спринте, градусы. Даёт ощущение скорости без роста
## реальной скорости движения.
const SPRINT_FOV_BONUS: float = 6.0
## Скорость интерполяции FOV, 1/с.
const FOV_SMOOTHING: float = 9.0
## Затухание тряски камеры, 1/с.
const SHAKE_DECAY: float = 7.0
## Частота тряски, Гц. Выше 25 Гц тряска превращается в мерцание.
const SHAKE_FREQUENCY: float = 17.0
## Максимальное смещение камеры от тряски, метры. Ограничитель обязателен:
## без него сильный удар выбрасывает камеру сквозь стену.
const SHAKE_MAX_OFFSET: float = 0.16

## ---------------------------------------------------------------- движение --
@export_group("Movement")
## Обычный шаг, м/с. 4.4 ≈ уверенная человеческая ходьба с небольшим
## запасом: в игре «честные» 1.4 м/с ощущаются как движение в сиропе.
@export var walk_speed: float = 4.6
## Спринт, м/с. Отношение к ходьбе ~1.55 — заметно, но не ломает баланс.
@export var sprint_speed: float = 7.2
## Присед, м/с.
@export var crouch_speed: float = 2.1
## Как быстро набирается скорость на земле, 1/с.
@export var ground_acceleration: float = 14.0
## Как быстро гасится скорость на земле, 1/с. Больше ускорения — иначе
## игрок скользит после отпускания клавиши.
@export var ground_friction: float = 18.0
## Ускорение в воздухе. Специально низкое: полный контроль в прыжке
## убирает из игры всю вертикальную геометрию.
@export var air_acceleration: float = 2.5
## Высота прыжка, м/с. При g=9.81 даёт ~1.15 м подъёма.
@export var jump_velocity: float = 4.8
## Множитель гравитации при падении. Падение быстрее подъёма субъективно
## ощущается «отзывчивее» — приём из платформеров, работает и в 3D.
@export var fall_gravity_multiplier: float = 1.35

## ------------------------------------------------------------- выносливость --
@export_group("Stamina")
@export var stamina_max: float = 100.0
## Расход в секунду при спринте.
@export var stamina_drain: float = 18.0
## Восстановление в секунду. Медленнее расхода — иначе спринт бесконечен.
@export var stamina_regen: float = 11.0
## Задержка восстановления после прекращения спринта, с.
@export var stamina_regen_delay: float = 0.7
## Порог «устал»: ниже него спринт не включается. Без порога игрок
## дёргает спринт на последнем проценте и получает рваное движение.
@export var stamina_exhausted_threshold: float = 12.0

## --------------------------------------------------------------- приседание --
## Во сколько раз ниже точка камеры при приседе.
@export var crouch_eye_scale: float = 0.62
## Скорость интерполяции высоты камеры при приседании, 1/с.
@export var crouch_smooth_speed: float = 12.0

## ------------------------------------------------------------------- обзор --
@export_group("Look")
## Базовая чувствительность мыши. Умножается на input/mouse_sensitivity.
@export var look_speed_base: float = 0.16
## Ограничение взгляда вверх/вниз, градусы. Ровно ±90 даёт сингулярность
## и дёргание камеры на полюсе, поэтому чуть меньше.
@export var pitch_limit_deg: float = 88.0
## Сглаживание обзора с геймпада, 1/с. На мыши сглаживание вредно:
## добавляет задержку между движением руки и картинкой.
@export var gamepad_look_smoothing: float = 26.0

## ------------------------------------------------------------- покачивание --
@export_group("Head bob")
## Амплитуда покачивания, метры. Малая величина: заметное покачивание —
## причина укачивания у части игроков.
@export var bob_amplitude: float = 0.028
## Циклов покачивания на метр пройденного пути.
@export var bob_cycles_per_meter: float = 1.15
## Доля покачивания по горизонтали относительно вертикальной.
@export var bob_horizontal_ratio: float = 0.55

## ------------------------------------------------------------------- урон --
@export_group("Health")
@export var health_max: float = 100.0
## Импульс «отдачи» камеры на единицу урона. Умножается на screen_shake.
@export var damage_shake_per_point: float = 0.05

var health: float = 100.0
var stamina: float = 100.0
var is_sprinting: bool = false
var is_crouching: bool = false
var is_exhausted: bool = false
var input_enabled: bool = true

var _pitch: float = 0.0
var _yaw: float = 0.0
var _bob_phase: float = 0.0
var _eye_height: float = GameConfig.PLAYER_EYE_HEIGHT
var _crouch_target_scale: float = 1.0
var _stamina_idle_time: float = 0.0
var _shake_energy: float = 0.0
var _shake_time: float = 0.0
var _base_fov: float = 75.0
var _current_fov: float = 75.0
var _interact_target: Node = null
var _grounded_previous: bool = true
var _using_gamepad_look: bool = false
var _look_delta_accumulator: Vector2 = Vector2.ZERO

@onready var _camera: Camera3D = %Camera
@onready var _head: Node3D = %Head
@onready var _interact_ray: RayCast3D = %InteractRay


func _ready() -> void:
	add_to_group(&"player")
	health = health_max
	stamina = stamina_max
	_base_fov = SettingsService.get_float("accessibility/fov")
	_current_fov = _base_fov
	_camera.fov = _base_fov
	_eye_height = GameConfig.PLAYER_EYE_HEIGHT
	_crouch_target_scale = 1.0
	# Мышь захватывается сразу: игрок, попавший в уровень, ожидает управление,
	# а не курсор на экране.
	_capture_mouse()
	EventBus.player_spawned.emit(self)
	EventBus.player_health_changed.emit(health, health_max)
	EventBus.player_stamina_changed.emit(stamina, stamina_max)
	EventBus.settings_changed.connect(_on_settings_changed)
	Diagnostics.info("player", "игрок заспавнен, FOV=%d" % int(_base_fov))


func _exit_tree() -> void:
	if EventBus.settings_changed.is_connected(_on_settings_changed):
		EventBus.settings_changed.disconnect(_on_settings_changed)
	_release_mouse()


func _unhandled_input(event: InputEvent) -> void:
	if not input_enabled:
		return
	if event is InputEventMouseMotion:
		_using_gamepad_look = false
		_apply_look(event.relative)
		return
	if event is InputEventJoypadMotion:
		var axis_motion := event as InputEventJoypadMotion
		if axis_motion.axis in [JOY_AXIS_RIGHT_X, JOY_AXIS_RIGHT_Y]:
			_using_gamepad_look = true
			# Ось геймпада даёт направление, а не приращение: переводим в
			# дельту сами, с учётом мёртвой зоны из настроек.
			var value: float = _apply_deadzone(axis_motion.axis_value)
			var step: Vector2 = Vector2(
				value if axis_motion.axis == JOY_AXIS_RIGHT_X else 0.0,
				value if axis_motion.axis == JOY_AXIS_RIGHT_Y else 0.0
			)
			_look_delta_accumulator += step
		return
	if event.is_action_pressed("interact"):
		_try_interact()


func _physics_process(delta: float) -> void:
	if get_tree().paused or not input_enabled:
		# На паузе физика остановлена движком, но при input_enabled = false
		# (катсцена) тело обязано стоять: иначе игрок продолжает скользить.
		velocity = Vector3.ZERO
		return
	_process_gamepad_look(delta)
	var wish_direction: Vector3 = _read_movement_input()
	_update_stance()
	_update_stamina(delta, wish_direction)
	_apply_movement(delta, wish_direction)
	move_and_slide()
	_detect_ground_change()
	_update_head(delta)
	_update_camera_effects(delta)
	_update_interaction_focus()


# ------------------------------------------------------------------- обзор --


func _capture_mouse() -> void:
	if OS.has_feature("editor"):
		return
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED


func _release_mouse() -> void:
	if Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE


## Применяет дельту взгляда. Разделение «собрать ввод» / «применить поворот»
## нужно, чтобы геймпад и мышь шли через один и тот же код ограничения pitch.
func _apply_look(relative: Vector2) -> void:
	var sensitivity: float = SettingsService.get_float("input/mouse_sensitivity")
	var invert_y: bool = SettingsService.get_bool("input/invert_y")
	var scale_factor: float = look_speed_base * sensitivity
	_yaw -= relative.x * scale_factor
	var vertical: float = relative.y * scale_factor
	if invert_y:
		vertical = -vertical
	_pitch -= vertical
	_pitch = clampf(_pitch, deg_to_rad(-pitch_limit_deg), deg_to_rad(pitch_limit_deg))
	_apply_rotation()


func _process_gamepad_look(delta: float) -> void:
	if not _using_gamepad_look:
		_look_delta_accumulator = Vector2.ZERO
		return
	var step: Vector2 = _look_delta_accumulator * delta
	_look_delta_accumulator = Vector2.ZERO
	if step.length_squared() < 0.000001:
		return
	# Сглаживание только для геймпада: мышь должна быть 1:1 с рукой.
	var sensitivity: float = SettingsService.get_float("input/mouse_sensitivity")
	var invert_y: bool = SettingsService.get_bool("input/invert_y")
	var scale_factor: float = look_speed_base * sensitivity * 6.0
	_yaw = lerpf(_yaw, _yaw - step.x * scale_factor, gamepad_look_smoothing * delta)
	var vertical: float = -step.y * scale_factor
	if invert_y:
		vertical = -vertical
	_pitch = clampf(_pitch + vertical, deg_to_rad(-pitch_limit_deg), deg_to_rad(pitch_limit_deg))
	_apply_rotation()


func _apply_rotation() -> void:
	# Поворот разнесён по двум узлам: yaw на теле, pitch на голове. Один
	# узел с полным поворотом наклоняет и тело, и коллизию — игрок начинает
	# «заваливаться» при взгляде вверх.
	rotation.y = _yaw
	_head.rotation.x = _pitch


## Мёртвая зона геймпада из настроек. Применяется квадратично: линейное
## отсечение даёт заметный «скачок» в начале отклонения стика.
func _apply_deadzone(raw_value: float) -> float:
	var deadzone: float = SettingsService.get_float("input/gamepad_deadzone")
	var magnitude: float = absf(raw_value)
	if magnitude <= deadzone:
		return 0.0
	var normalized: float = (magnitude - deadzone) / maxf(1.0 - deadzone, 0.0001)
	return signf(raw_value) * normalized * normalized


# ---------------------------------------------------------------- движение --


func _read_movement_input() -> Vector3:
	var input_vector: Vector2 = Input.get_vector(
		"move_left", "move_right", "move_forward", "move_back"
	)
	# Нормализация уже сделана get_vector, но диагональ не должна быть
	# быстрее прямого движения — get_vector это гарантирует, а ручная
	# сборка из четырёх get_action_strength нет.
	var forward: Vector3 = -global_transform.basis.z
	var right: Vector3 = global_transform.basis.x
	forward.y = 0.0
	right.y = 0.0
	return (forward * input_vector.y + right * input_vector.x).normalized()


func _target_speed() -> float:
	if is_crouching:
		return crouch_speed
	if is_sprinting:
		return sprint_speed
	return walk_speed


func _update_stance() -> void:
	var wants_crouch: bool = Input.is_action_pressed("crouch")
	var wants_sprint: bool = Input.is_action_pressed("sprint")
	is_crouching = wants_crouch
	# Спринт разрешён, только если игрок реально куда-то движется вперёд и
	# не присел. Спринт на месте сжигает выносливость впустую.
	is_sprinting = (
		wants_sprint
		and not is_crouching
		and not is_exhausted
		and Input.is_action_pressed("move_forward")
	)
	_crouch_target_scale = crouch_eye_scale if is_crouching else 1.0


func _update_stamina(delta: float, wish_direction: Vector3) -> void:
	var previous: float = stamina
	if is_sprinting and wish_direction.length_squared() > 0.01:
		stamina = maxf(0.0, stamina - stamina_drain * delta)
		_stamina_idle_time = 0.0
		if stamina <= 0.0:
			is_exhausted = true
			Diagnostics.debug("player", "выносливость исчерпана")
	else:
		_stamina_idle_time += delta
		if _stamina_idle_time >= stamina_regen_delay:
			stamina = minf(stamina_max, stamina + stamina_regen * delta)
		# Выход из «устал» с гистерезисом: порог возврата выше порога входа,
		# иначе на границе значения спринт начинает щёлкать туда-сюда.
		if is_exhausted and stamina >= stamina_exhausted_threshold:
			is_exhausted = false
	if absf(stamina - previous) > 0.001:
		EventBus.player_stamina_changed.emit(stamina, stamina_max)


func _apply_movement(delta: float, wish_direction: Vector3) -> void:
	var target_speed: float = _target_speed()
	var wish_velocity: Vector3 = wish_direction * target_speed
	# Ускорение по горизонтали; вертикаль не трогаем, ею правит гравитация.
	var factor: float = ground_acceleration if is_on_floor() else air_acceleration
	if wish_direction.length_squared() < 0.001 and is_on_floor():
		factor = ground_friction
	var horizontal: Vector3 = velocity
	horizontal.y = 0.0
	horizontal = horizontal.move_toward(wish_velocity, factor * target_speed * delta)
	velocity.x = horizontal.x
	velocity.z = horizontal.z

	if is_on_floor() and velocity.y < 0.0:
		# Небольшая downward-скорость на земле: без неё CharacterBody3D на
		# склоне теряет is_on_floor() на один кадр и игрок «подпрыгивает»
		# на спуске. Это известная особенность движка, а не выдумка.
		velocity.y = -1.2
	if Input.is_action_just_pressed("jump") and is_on_floor() and not is_crouching:
		velocity.y = jump_velocity

	gravity_apply(delta)


func gravity_apply(delta: float) -> void:
	var gravity: float = ProjectSettings.get_setting(
		"physics/3d/default_gravity", GameConfig.GRAVITY
	)
	if velocity.y > 0.0:
		velocity.y -= gravity * delta
	else:
		velocity.y -= gravity * fall_gravity_multiplier * delta


func _detect_ground_change() -> void:
	var grounded: bool = is_on_floor()
	if grounded == _grounded_previous:
		return
	_grounded_previous = grounded
	EventBus.player_grounded_changed.emit(grounded)
	if grounded:
		# Приземление добавляет тряску пропорционально скорости падения.
		# Тряска от приземления — главный источник «укачивания», поэтому
		# она обязательно проходит через множитель screen_shake.
		var impact: float = clampf(-velocity.y * 0.02, 0.0, 0.5)
		add_shake(impact * 0.4)


# ----------------------------------------------------------------- камера --


func _update_head(delta: float) -> void:
	# Высота камеры интерполируется к цели: мгновенное переключение между
	# 1.62 и 1.0 при приседе выглядит как телепорт головы.
	var target_height: float = GameConfig.PLAYER_EYE_HEIGHT * _crouch_target_scale
	_eye_height = lerpf(_eye_height, target_height, clampf(crouch_smooth_speed * delta, 0.0, 1.0))

	# Покачивание от пройденного расстояния, а не от времени.
	var horizontal_speed: float = Vector2(velocity.x, velocity.z).length()
	var bob_enabled: bool = SettingsService.get_bool("gameplay/head_bob")
	if bob_enabled and is_on_floor():
		_bob_phase += horizontal_speed * delta * bob_cycles_per_meter * TAU
	var bob_offset: Vector3 = Vector3.ZERO
	if bob_enabled and is_on_floor():
		var shake_factor: float = _shake_scale()
		bob_offset.y = sin(_bob_phase) * bob_amplitude * shake_factor
		bob_offset.x = cos(_bob_phase * 0.5) * bob_amplitude * bob_horizontal_ratio * shake_factor
	elif not bob_enabled:
		# При выключенном покачивании фазу сбрасываем: иначе после включения
		# камера дёрнется на случайной точке синусоиды.
		_bob_phase = 0.0

	_head.position.y = _eye_height
	_camera.position = bob_offset + _shake_offset()


## Множитель всех эффектов тряски из настроек доступности.
## 0.0 — полностью убрать тряску (нужно игрокам с вестибулярными проблемами).
func _shake_scale() -> float:
	return clampf(SettingsService.get_float("accessibility/screen_shake"), 0.0, 1.0)


func _shake_offset() -> Vector3:
	if _shake_energy <= 0.0005:
		return Vector3.ZERO
	# Две несоизмеримые частоты: одна синусоида даёт заметную периодичность,
	# которая читается как «искусственная» вибрация.
	var amplitude: float = minf(_shake_energy, SHAKE_MAX_OFFSET)
	return Vector3(
		sin(_shake_time * SHAKE_FREQUENCY * TAU) * amplitude,
		sin(_shake_time * SHAKE_FREQUENCY * 1.37 * TAU) * amplitude * 0.8,
		0.0
	)


func add_shake(amount: float) -> void:
	var scaled_amount: float = amount * _shake_scale()
	if scaled_amount <= 0.0:
		return
	_shake_energy = minf(_shake_energy + scaled_amount, SHAKE_MAX_OFFSET)


func _update_camera_effects(delta: float) -> void:
	_shake_time += delta
	_shake_energy = maxf(0.0, _shake_energy - _shake_energy * SHAKE_DECAY * delta)
	if _shake_energy < 0.0005:
		_shake_energy = 0.0

	var target_fov: float = _base_fov + (SPRINT_FOV_BONUS if is_sprinting else 0.0)
	_current_fov = lerpf(_current_fov, target_fov, clampf(FOV_SMOOTHING * delta, 0.0, 1.0))
	if absf(_camera.fov - _current_fov) > 0.01:
		_camera.fov = _current_fov


# --------------------------------------------------------------- интерактив --


func _update_interaction_focus() -> void:
	if not input_enabled:
		return
	var collider: Node = null
	if _interact_ray.is_colliding():
		collider = _interact_ray.get_collider() as Node
	var target: Node = _resolve_interactable(collider)
	if target == _interact_target:
		return
	_interact_target = target
	# Сигнал уходит в HUD: подсказка «Нажмите E» рисуется интерфейсом, а не
	# игроком. Игрок не должен знать, как выглядит HUD.
	EventBus.interaction_focus_changed.emit(target)


## Поднимаемся от физического тела до узла, реализующего интерактив.
## Луч попадает в CollisionShape/Area3D, а логика живёт на родителе —
## без этого шага половина интерактивных объектов «не нажимается».
func _resolve_interactable(collider: Node) -> Node:
	if collider == null:
		return null
	var node: Node = collider
	var depth: int = 0
	while node != null and depth < 4:
		if node.is_in_group(&"interactable") and node.has_method("interact"):
			return node
		node = node.get_parent()
		depth += 1
	return null


func _try_interact() -> void:
	if _interact_target == null or not is_instance_valid(_interact_target):
		return
	var direction: Vector3 = _interact_target.global_position - global_position
	# Проверка дистанции дублирует длину луча намеренно: луч может попасть
	# в объект за стеной через тонкий коллайдер, а угловое ограничение
	# отсекает объекты за спиной.
	if direction.length() > GameConfig.INTERACT_MAX_DISTANCE:
		return
	if (
		rad_to_deg(_camera.global_transform.basis.z.angle_to(-direction))
		> GameConfig.INTERACT_MAX_ANGLE_DEG
	):
		return
	_interact_target.call("interact", self)
	EventBus.player_interacted_with.emit(_interact_target)


# --------------------------------------------------------------- здоровье --


func take_damage(amount: float, source_position: Vector3 = Vector3.INF) -> void:
	if amount <= 0.0 or health <= 0.0:
		return
	health = maxf(0.0, health - amount)
	EventBus.player_health_changed.emit(health, health_max)
	add_shake(amount * damage_shake_per_point)
	Diagnostics.debug("player", "урон %.1f, осталось %.1f" % [amount, health])
	if source_position != Vector3.INF:
		# Лёгкий поворот к источнику урона: игрок понимает, откуда прилетело,
		# без миникарты и маркеров.
		var to_source: Vector3 = source_position - global_position
		to_source.y = 0.0
		if to_source.length_squared() > 0.01:
			_yaw = atan2(-to_source.x, -to_source.z) * 0.35 + _yaw * 0.65
			_apply_rotation()
	if health <= 0.0:
		_die("damage")


func heal(amount: float) -> void:
	if amount <= 0.0:
		return
	health = minf(health_max, health + amount)
	EventBus.player_health_changed.emit(health, health_max)


func _die(cause: String) -> void:
	input_enabled = false
	_release_mouse()
	EventBus.player_died.emit(cause)
	Diagnostics.warn("player", "игрок погиб: " + cause)


func respawn(at_position: Vector3) -> void:
	global_position = at_position
	velocity = Vector3.ZERO
	health = health_max
	stamina = stamina_max
	is_exhausted = false
	input_enabled = true
	_capture_mouse()
	EventBus.player_health_changed.emit(health, health_max)
	EventBus.player_stamina_changed.emit(stamina, stamina_max)
	EventBus.player_respawned.emit()


func _on_settings_changed(section: String) -> void:
	if section == SettingsSchema.SECTION_ACCESSIBILITY:
		_base_fov = SettingsService.get_float("accessibility/fov")


## Текущая высота глаз — нужна HUD и камере отладки.
func eye_position() -> Vector3:
	return _camera.global_position


func view_direction() -> Vector3:
	return -_camera.global_transform.basis.z


func stamina_ratio() -> float:
	return stamina / maxf(stamina_max, 0.001)


func health_ratio() -> float:
	return health / maxf(health_max, 0.001)
