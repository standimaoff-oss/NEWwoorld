class_name WindSystem
extends Node
## WindSystem — глобальный ветер для шейдеров и физики.
##
## ОДНА ТОЧКА ПРАВДЫ. Все шейдеры листвы/ткани/воды читают ОДИН набор
## global shader parameters. Без этого каждая травинка качается в своей
## фазе, и сцена выглядит как набор независимых анимаций — ровно тот
## «ИИ-слоп», от которого мы договаривались уйти. Согласованный ветер
## мгновенно читается как «живой мир».
##
## Что считается:
##   * базовое направление (медленно дрейфует по шуму),
##   * сила с порывами (gusts) — октавный шум, а не синусоида: синусоида
##     выглядит механически, глаз её распознаёт за пару секунд,
##   * турбулентность для мелких деталей.
##
## Всё это уходит в GPU через `RenderingServer.global_shader_parameter_*`,
## то есть стоимость на CPU — несколько вызовов шума за кадр, и шейдеры
## не требуют per-instance uniform'ов.

## Имена глобальных shader-параметров. Должны совпадать с `global wind_*`
## в шейдерах и с registration в _register_shader_parameters().
const PARAM_DIRECTION: StringName = &"wind_direction"
const PARAM_STRENGTH: StringName = &"wind_strength"
const PARAM_TIME: StringName = &"wind_time"
const PARAM_GUST: StringName = &"wind_gust"
const PARAM_TURBULENCE: StringName = &"wind_turbulence"

## Шкала мирового времени для шума. Больше — чаще порывы.
const GUST_TIME_SCALE: float = 0.18
const DIRECTION_TIME_SCALE: float = 0.02
const TURBULENCE_TIME_SCALE: float = 1.3

## Ограничение силы. Позволяет уровню задать ураган, но не сломать физику:
## слишком большой импульс выбрасывает тела за пределы мира.
const MAX_STRENGTH: float = 25.0
const MAX_GUST_MULTIPLIER: float = 3.0

## Группа динамических тел, на которые действует ветер.
const DEBRIS_GROUP: StringName = &"debris"

@export_group("Ветер по умолчанию")
## Базовое направление в градусах вокруг оси Y. 0 = вдоль -Z.
@export_range(0.0, 360.0, 1.0) var base_direction_deg: float = 42.0
## Базовая сила, м/с условно. 0 = штиль.
@export_range(0.0, MAX_STRENGTH, 0.1) var base_strength: float = 2.4
## Насколько сильны порывы относительно базовой силы.
@export_range(0.0, MAX_GUST_MULTIPLIER, 0.05) var gustiness: float = 0.85
## Амплитуда дрейфа направления, градусы.
@export_range(0.0, 90.0, 1.0) var direction_drift_deg: float = 22.0
## Включать ли влияние ветра на физические тела (osколки, ткань).
@export var affect_rigid_bodies: bool = true
## Масштаб влияния на физику. Держим отдельно от шейдеров: визуально
## ветер может быть сильным, а сдувать ящики — уже перебор.
@export_range(0.0, 2.0, 0.05) var physics_influence: float = 0.35

var _gust_noise: FastNoiseLite = null
var _direction_noise: FastNoiseLite = null
var _turbulence_noise: FastNoiseLite = null
var _elapsed: float = 0.0
var _current_direction: Vector3 = Vector3.FORWARD
var _current_strength: float = 0.0
var _current_gust: float = 0.0
var _registered: bool = false
var _enabled: bool = true
## Усреднённое значение для физики. Мгновенный шум даёт дрожь тел —
## сглаживание убирает её, сохраняя характер порывов.
var _smoothed_direction: Vector3 = Vector3.FORWARD


func _ready() -> void:
	# Группа нужна, чтобы сцены (например, фон меню) находили ветер, не
	# зная, где именно в дереве он лежит.
	add_to_group(&"wind_system")
	_build_noise()
	_register_shader_parameters()
	# Первое применение сразу, иначе первый кадр шейдеры рисуют с нулевым
	# ветром и листва «дёргается» при загрузке уровня.
	_sample(0.0)
	_publish()


func _exit_tree() -> void:
	_unregister_shader_parameters()


func _process(delta: float) -> void:
	if not _enabled:
		return
	_sample(delta)
	_publish()
	if affect_rigid_bodies and physics_influence > 0.0:
		_apply_to_bodies(delta)


# ------------------------------------------------------------------ шум -----


func _build_noise() -> void:
	_gust_noise = _make_noise(0.9, FastNoiseLite.TYPE_SIMPLEX, 4, 101)
	_direction_noise = _make_noise(0.35, FastNoiseLite.TYPE_SIMPLEX, 2, 7777)
	_turbulence_noise = _make_noise(2.6, FastNoiseLite.TYPE_PERLIN, 3, 4242)


func _make_noise(
	freq: float, noise_type: FastNoiseLite.NoiseType, octaves: int, seed_value: int
) -> FastNoiseLite:
	var noise := FastNoiseLite.new()
	noise.noise_type = noise_type
	noise.frequency = freq
	noise.fractal_type = FastNoiseLite.FRACTAL_FBM
	noise.fractal_octaves = octaves
	noise.fractal_gain = 0.5
	noise.seed = seed_value
	return noise


# ------------------------------------------------------------ параметры GPU


func _register_shader_parameters() -> void:
	if _registered:
		return
	_add_param(PARAM_DIRECTION, Vector3.FORWARD)
	_add_param(PARAM_STRENGTH, 0.0)
	_add_param(PARAM_TIME, 0.0)
	_add_param(PARAM_GUST, 0.0)
	_add_param(PARAM_TURBULENCE, 0.0)
	_registered = true
	Diagnostics.debug("wind", "глобальные shader-параметры зарегистрированы")


func _add_param(param_name: StringName, default_value: Variant) -> void:
	# Параметр может уже существовать (второй WindSystem в сцене, или
	# перезапуск уровня). add при существующем имени — предупреждение движка,
	# поэтому сначала проверяем.
	if _has_global_param(param_name):
		RenderingServer.global_shader_parameter_set(param_name, default_value)
		return
	var type_hint: int = (
		RenderingServer.GLOBAL_VAR_TYPE_VEC3
		if default_value is Vector3
		else RenderingServer.GLOBAL_VAR_TYPE_FLOAT
	)
	RenderingServer.global_shader_parameter_add(param_name, type_hint, default_value)


func _has_global_param(param_name: StringName) -> bool:
	## `global_shader_parameter_get_list()` возвращает имена всех
	## зарегистрированных глобальных параметров движка. Проверяем по нему —
	## это единственный честный способ, getter'а по имени в API нет.
	var existing: Array = RenderingServer.global_shader_parameter_get_list()
	return existing.has(String(param_name)) or existing.has(param_name)


func _unregister_shader_parameters() -> void:
	if not _registered:
		return
	for param_name: StringName in [
		PARAM_DIRECTION, PARAM_STRENGTH, PARAM_TIME, PARAM_GUST, PARAM_TURBULENCE
	]:
		RenderingServer.global_shader_parameter_remove(param_name)
	_registered = false


func _publish() -> void:
	RenderingServer.global_shader_parameter_set(PARAM_DIRECTION, _current_direction)
	RenderingServer.global_shader_parameter_set(PARAM_STRENGTH, _current_strength)
	RenderingServer.global_shader_parameter_set(PARAM_TIME, _elapsed)
	RenderingServer.global_shader_parameter_set(PARAM_GUST, _current_gust)
	RenderingServer.global_shader_parameter_set(
		PARAM_TURBULENCE, _turbulence_noise.get_noise_2d(_elapsed * TURBULENCE_TIME_SCALE, 0.0)
	)


# -------------------------------------------------------------- расчёт -----


func _sample(delta: float) -> void:
	_elapsed += delta

	var drift_deg: float = (
		_direction_noise.get_noise_2d(_elapsed * DIRECTION_TIME_SCALE, 0.0) * direction_drift_deg
	)
	var yaw_deg: float = base_direction_deg + drift_deg
	var yaw_rad: float = deg_to_rad(yaw_deg)
	var target_direction := Vector3(sin(yaw_rad), 0.0, -cos(yaw_rad))

	# Сглаживание направления экспоненциальное и НЕ зависит от частоты кадров:
	# иначе на 144 Гц ветер «успокаивается» быстрее, чем на 60, и поведение
	# игры различается на разных машинах.
	var smoothing: float = 1.0 - exp(-3.0 * delta)
	_smoothed_direction = _smoothed_direction.lerp(target_direction, smoothing)
	_current_direction = _smoothed_direction.normalized()

	var gust_raw: float = _gust_noise.get_noise_2d(_elapsed * GUST_TIME_SCALE, 13.7)
	# Шум даёт -1..1; порыв — только положительная часть, усиленная.
	_current_gust = maxf(0.0, gust_raw) * gustiness
	_current_strength = clampf(
		base_strength * (1.0 + _current_gust * MAX_GUST_MULTIPLIER), 0.0, MAX_STRENGTH
	)


func _apply_to_bodies(delta: float) -> void:
	var bodies: Array[Node] = get_tree().get_nodes_in_group(DEBRIS_GROUP)
	if bodies.is_empty():
		return
	# Не толкаем все тела каждый кадр: это O(N) физических операций.
	# Импульс масштабируем дельтой, чтобы не зависеть от частоты кадров.
	var impulse_scale: float = physics_influence * _current_strength * delta
	if impulse_scale <= 0.0:
		return
	for node: Node in bodies:
		if not (node is RigidBody3D) or not is_instance_valid(node):
			continue
		var body := node as RigidBody3D
		if body.freeze or body.sleeping:
			continue
		body.apply_central_force(_current_direction * impulse_scale * body.mass)


# ------------------------------------------------------------- публичное ---


func wind_direction() -> Vector3:
	return _current_direction


func wind_strength() -> float:
	return _current_strength


func gust() -> float:
	return _current_gust


func elapsed() -> float:
	return _elapsed


func set_enabled(enabled: bool) -> void:
	if _enabled == enabled:
		return
	_enabled = enabled
	if not enabled:
		# Обнуляем, чтобы листва замерла в нейтральном положении,
		# а не застыла в случайной позе.
		_current_strength = 0.0
		_current_gust = 0.0
		_publish()
	Diagnostics.info("wind", "ветер: %s" % ("включён" if enabled else "выключен"))


func is_enabled() -> bool:
	return _enabled


## Мгновенный порыв (взрыв, заклинание). Не меняет базовый ветер —
## добавляет короткий всплеск поверх.
func gust_burst(strength: float, duration: float = 1.2) -> void:
	var previous: float = base_strength
	var tween: Tween = create_tween()
	base_strength = clampf(previous + strength, 0.0, MAX_STRENGTH)
	tween.tween_interval(duration)
	tween.tween_method(_set_strength, base_strength, previous, duration * 1.5)


func _set_strength(value: float) -> void:
	base_strength = clampf(value, 0.0, MAX_STRENGTH)


## Сводка для debug-оверлея.
func debug_text() -> String:
	return (
		"wind %.1f m/s dir %s gust %.2f t=%.1f"
		% [
			_current_strength,
			str(_current_direction).replace("\n", ""),
			_current_gust,
			_elapsed,
		]
	)
