extends Node
## QualityService — применяет пресеты качества к живой сцене.
##
## РАЗДЕЛЕНИЕ ОТВЕТСТВЕННОСТИ:
##   SettingsService хранит «что выбрал игрок» (индекс пресета + ручные
##   правки того, что применимо глобально: окно, vsync, MSAA, масштаб).
##   QualityService хранит «как это выглядит» и применяет профиль к
##   WorldEnvironment, DirectionalLight3D, LOD и бюджету разрушения.
##
## Без этого разделения настройки размазаны по десяти скриптам и половина
## опций в меню молча ничего не делает.
##
## Плюс здесь живёт АДАПТИВНОЕ качество: на performance_degraded сервис
## понижает профиль на ступень. Игрок на слабом железе получает играбельный
## FPS, а не слайд-шоу с красивой картинкой.

signal profile_applied(profile: QualityProfile)

const PROFILE_PATHS: Array[String] = [
	"res://resources/quality/quality_low.tres",
	"res://resources/quality/quality_medium.tres",
	"res://resources/quality/quality_high.tres",
	"res://resources/quality/quality_ultra.tres",
]

## Группа, в которую WorldEnvironment регистрирует себя в _ready().
## Ищем через группу, а не обходом дерева: сцена может быть любой.
const ENVIRONMENT_GROUP: StringName = &"world_environment"
const SUN_GROUP: StringName = &"main_sun"

## Сколько раз подряд должна прийти деградация, прежде чем понизим профиль.
## Один раз — это загрузка шейдеров, а не слабое железо.
const DEGRADE_STRIKE_LIMIT: int = 3
## Пауза после понижения, секунды. Даём системе выйти на новый режим.
const DEGRADE_COOLDOWN_SEC: float = 6.0
## Порог FPS для ПОВЫШЕНИЯ профиля обратно. Заметно выше порога деградации
## (45), иначе будем дёргаться вверх-вниз — это видно и раздражает.
const UPGRADE_FPS_THRESHOLD: float = 75.0
const UPGRADE_STRIKE_LIMIT: int = 60  # ~10 секунд стабильно высокого FPS

var _profiles: Array[QualityProfile] = []
var _active_index: int = 2
var _adaptive_enabled: bool = true
var _degrade_strikes: int = 0
var _upgrade_strikes: int = 0
var _cooldown_remaining: float = 0.0
var _last_applied_id: StringName = &""


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_load_profiles()
	EventBus.quality_preset_changed.connect(_on_quality_preset_changed)
	EventBus.performance_degraded.connect(_on_performance_degraded)
	PerfMonitor.sample_ready.connect(_on_perf_sample)
	_adaptive_enabled = SettingsService.get_bool("gameplay/auto_quality")
	apply_index(SettingsService.get_int("video/quality_preset"), true)


func _process(delta: float) -> void:
	if _cooldown_remaining > 0.0:
		_cooldown_remaining = maxf(0.0, _cooldown_remaining - delta)


# --------------------------------------------------------------- пресеты ---


## Загружает профили с диска. Отсутствующий файл не роняет игру:
## подставляем дефолтный QualityProfile, пишем ошибку в лог.
func _load_profiles() -> void:
	_profiles.clear()
	for path: String in PROFILE_PATHS:
		if not ResourceLoader.exists(path):
			Diagnostics.error("quality", "профиль не найден: " + path)
			_profiles.append(_make_fallback_profile(path))
			continue
		var res: Resource = load(path)
		var profile: QualityProfile = res as QualityProfile
		if profile == null:
			Diagnostics.error("quality", "файл %s — не QualityProfile" % path)
			_profiles.append(_make_fallback_profile(path))
			continue
		_profiles.append(profile)
	Diagnostics.info("quality", "загружено профилей: %d" % _profiles.size())


func _make_fallback_profile(source_path: String) -> QualityProfile:
	var profile := QualityProfile.new()
	profile.profile_id = StringName(source_path.get_file().get_basename())
	profile.display_name = "Запасной"
	return profile


func profile_count() -> int:
	return _profiles.size()


func get_profile(index: int) -> QualityProfile:
	if _profiles.is_empty():
		return null
	return _profiles[clampi(index, 0, _profiles.size() - 1)]


func active_profile() -> QualityProfile:
	return get_profile(_active_index)


func active_index() -> int:
	return _active_index


func profile_names() -> Array[String]:
	var out: Array[String] = []
	for profile: QualityProfile in _profiles:
		out.append(profile.display_name)
	return out


## Найти индекс профиля по машинному id ("low"/"medium"/…).
func index_of_id(profile_id: StringName) -> int:
	for i: int in _profiles.size():
		if _profiles[i].profile_id == profile_id:
			return i
	return -1


# ------------------------------------------------------------ применение ---


## Применяет профиль по индексу. `force` — применить, даже если индекс
## не изменился (нужно после перезагрузки уровня).
func apply_index(index: int, force: bool = false) -> bool:
	if _profiles.is_empty():
		Diagnostics.error("quality", "нет профилей — применять нечего")
		return false
	var clamped: int = clampi(index, 0, _profiles.size() - 1)
	if clamped != index:
		Diagnostics.warn("quality", "индекс %d вне диапазона, взят %d" % [index, clamped])
	if not force and clamped == _active_index and _profiles[clamped].profile_id == _last_applied_id:
		return false
	_active_index = clamped
	var profile: QualityProfile = _profiles[clamped]
	_last_applied_id = profile.profile_id

	_apply_to_environment(profile)
	_apply_to_sun(profile)
	_apply_to_viewport(profile)
	_apply_global_budgets(profile)

	Diagnostics.info("quality", "применён профиль " + profile.describe())
	profile_applied.emit(profile)
	return true


func _apply_to_environment(profile: QualityProfile) -> void:
	var env_node: Node = _first_in_group(ENVIRONMENT_GROUP)
	if env_node == null or not (env_node is WorldEnvironment):
		(
			Diagnostics
			. debug(
				"quality",
				"WorldEnvironment в группе '%s' не найден — пропускаю" % ENVIRONMENT_GROUP,
			)
		)
		return
	var env: Environment = (env_node as WorldEnvironment).environment
	if env == null:
		Diagnostics.warn("quality", "у WorldEnvironment нет Environment-ресурса")
		return

	env.ssao_enabled = profile.ssao_enabled
	env.ssil_enabled = profile.ssil_enabled
	env.ssr_enabled = profile.ssr_enabled
	env.sdfgi_enabled = profile.sdfgi_enabled
	env.glow_enabled = profile.glow_enabled
	env.volumetric_fog_enabled = profile.volumetric_fog_enabled
	if profile.volumetric_fog_enabled:
		env.volumetric_fog_length = profile.render_distance * 0.5
	env.tonemap_mode = profile.tonemap_mode as Environment.ToneMapper
	env.tonemap_white = profile.tonemap_white
	env.tonemap_exposure = profile.tonemap_exposure
	env.adjustment_enabled = profile.adjustment_enabled
	# Плотность объёмного тумана растёт вместе с «тяжестью» пресета:
	# на низком туман редкий и дешёвый, на ультра — плотный и дорогой.
	if profile.volumetric_fog_enabled:
		env.volumetric_fog_density = 0.01 * float(profile.volumetric_fog_quality + 1)
		env.volumetric_fog_albedo = Color(0.86, 0.88, 0.92)
	# Флаг fog_enabled НЕ трогаем: обычный туман — художественное решение
	# уровня, а не настройка производительности.
	env.ambient_light_energy = clampf(profile.tonemap_exposure, 0.25, 2.0)


func _apply_to_sun(profile: QualityProfile) -> void:
	var sun_node: Node = _first_in_group(SUN_GROUP)
	if sun_node == null or not (sun_node is DirectionalLight3D):
		Diagnostics.debug("quality", "направленный свет в группе '%s' не найден" % SUN_GROUP)
		return
	var sun := sun_node as DirectionalLight3D
	sun.shadow_enabled = profile.directional_shadows_enabled
	# Enum называется ShadowMode (не DirectionalShadowMode) — свойство при
	# этом directional_shadow_mode. Проверено по extension_api.json.
	sun.directional_shadow_mode = profile.shadow_split_mode as DirectionalLight3D.ShadowMode
	sun.directional_shadow_max_distance = profile.shadow_max_distance
	sun.shadow_blur = 1.2 if profile.soft_shadow_filter_quality >= 2 else 0.4
	RenderingServer.directional_shadow_atlas_set_size(
		profile.shadow_map_size, profile.shadow_map_size < 4096
	)
	(
		ProjectSettings
		. set_setting(
			"rendering/lights_and_shadows/directional_shadow/soft_shadow_filter_quality",
			profile.soft_shadow_filter_quality,
		)
	)
	(
		ProjectSettings
		. set_setting(
			"rendering/lights_and_shadows/positional_shadow/soft_shadow_filter_quality",
			profile.soft_shadow_filter_quality,
		)
	)


func _apply_to_viewport(profile: QualityProfile) -> void:
	var viewport: Viewport = get_viewport()
	if viewport == null:
		return
	viewport.msaa_3d = profile.msaa_3d as Viewport.MSAA
	viewport.screen_space_aa = profile.screen_space_aa as Viewport.ScreenSpaceAA
	viewport.use_taa = profile.use_taa
	viewport.scaling_3d_mode = profile.scaling_3d_mode as Viewport.Scaling3DMode
	viewport.scaling_3d_scale = profile.scaling_3d_scale
	# Синхронизируем SettingsService, чтобы UI показывал правду:
	# пресет переопределил ручные значения — игрок должен это видеть.
	SettingsService.set_value("video/msaa_3d", profile.msaa_3d, false)
	SettingsService.set_value("video/screen_space_aa", profile.screen_space_aa, false)
	SettingsService.set_value("video/taa", profile.use_taa, false)
	SettingsService.set_value("video/scaling_mode", profile.scaling_3d_mode, false)
	SettingsService.set_value("video/scaling_scale", profile.scaling_3d_scale, false)
	SettingsService.set_value("video/anisotropic_filtering", profile.anisotropic_filtering, false)


func _apply_global_budgets(profile: QualityProfile) -> void:
	ProjectSettings.set_setting(
		"rendering/mesh_lod/lod_change/threshold_pixels", profile.mesh_lod_threshold_pixels
	)
	# Анизотропия в Godot 4 — настройка импорта текстур, runtime-API для неё
	# нет (RenderingServer.set_default_anisotropic_filtering не существует).
	# Выставляем в ProjectSettings: подхватится при следующем запуске, а
	# текущее значение уже применено SettingsService при загрузке.
	(
		ProjectSettings
		. set_setting(
			"rendering/textures/default_filters/anisotropic_filtering_level",
			1 << clampi(profile.anisotropic_filtering, 0, 4),
		)
	)
	# Отсечение невидимого — единственный пункт, который реально меняется
	# на лету через RenderingServer.
	(
		RenderingServer
		. viewport_set_use_occlusion_culling(
			get_viewport().get_viewport_rid(),
			SettingsService.get_bool("video/occlusion_culling"),
		)
	)
	# Бюджеты читает DestructionService, DecalManager и система частиц.
	# В Godot нет project setting'а «максимум декалей» — лимит держим сами.
	set_meta("max_visible_decals", profile.max_visible_decals)
	set_meta("destruction_chunk_budget", profile.destruction_chunk_budget)
	set_meta("particle_density", profile.particle_density)
	set_meta("render_distance", profile.render_distance)
	EventBus.destruction_budget_exceeded.emit(0, profile.destruction_chunk_budget)


func destruction_chunk_budget() -> int:
	return int(get_meta("destruction_chunk_budget", GameConfig.DESTRUCTION_MAX_ACTIVE_CHUNKS))


func particle_density() -> float:
	return float(get_meta("particle_density", 1.0))


func render_distance() -> float:
	return float(get_meta("render_distance", 300.0))


func _first_in_group(group: StringName) -> Node:
	var nodes: Array[Node] = get_tree().get_nodes_in_group(group)
	return nodes[0] if not nodes.is_empty() else null


# -------------------------------------------------------- адаптивность -----


func set_adaptive_enabled(enabled: bool) -> void:
	if _adaptive_enabled == enabled:
		return
	_adaptive_enabled = enabled
	_degrade_strikes = 0
	_upgrade_strikes = 0
	Diagnostics.info("quality", "адаптивное качество: %s" % str(enabled))


func is_adaptive_enabled() -> bool:
	return _adaptive_enabled


func _on_quality_preset_changed(preset_index: int) -> void:
	# Игрок выбрал пресет вручную — это сбрасывает историю адаптивности,
	# иначе сервис тут же «поправит» выбор обратно.
	_degrade_strikes = 0
	_upgrade_strikes = 0
	_cooldown_remaining = DEGRADE_COOLDOWN_SEC
	apply_index(preset_index, true)


func _on_performance_degraded(_avg_fps: float, _threshold_fps: float) -> void:
	if not _adaptive_enabled:
		return
	_degrade_strikes += 1
	if _degrade_strikes < DEGRADE_STRIKE_LIMIT:
		return
	if _cooldown_remaining > 0.0:
		return
	if _active_index <= 0:
		# Ниже некуда. Дальше — только динамический масштаб рендера,
		# и этим занимается _emergency_downscale.
		_emergency_downscale()
		return
	_degrade_strikes = 0
	_cooldown_remaining = DEGRADE_COOLDOWN_SEC
	var target: int = _active_index - 1
	Diagnostics.warn("quality", "адаптивное понижение: %d -> %d" % [_active_index, target])
	apply_index(target, true)
	SettingsService.set_value("video/quality_preset", target, false)
	SettingsService.save_to_disk()


func _on_perf_sample(snapshot: Dictionary) -> void:
	if not _adaptive_enabled or _cooldown_remaining > 0.0:
		return
	var fps: float = float(snapshot["fps"])
	if fps >= UPGRADE_FPS_THRESHOLD:
		_upgrade_strikes += 1
		_degrade_strikes = 0
	else:
		_upgrade_strikes = 0
	if _upgrade_strikes < UPGRADE_STRIKE_LIMIT:
		return
	if _active_index >= _profiles.size() - 1:
		_upgrade_strikes = 0
		return
	_upgrade_strikes = 0
	_cooldown_remaining = DEGRADE_COOLDOWN_SEC
	var target: int = _active_index + 1
	Diagnostics.info("quality", "адаптивное повышение: %d -> %d" % [_active_index, target])
	apply_index(target, true)
	SettingsService.set_value("video/quality_preset", target, false)


## Последняя линия обороны, когда профиль уже минимальный: режем масштаб
## рендера. Картинка мыльная, но игра остаётся играбельной — а это и есть
## цель. Возврат к 1.0 делает _on_perf_sample через пресет.
func _emergency_downscale() -> void:
	var viewport: Viewport = get_viewport()
	if viewport == null:
		return
	var current: float = viewport.scaling_3d_scale
	var next: float = snappedf(maxf(0.5, current - 0.1), 0.05)
	if is_equal_approx(current, next):
		return
	viewport.scaling_3d_scale = next
	_cooldown_remaining = DEGRADE_COOLDOWN_SEC
	Diagnostics.warn("quality", "аварийный даунскейл: %.2f -> %.2f" % [current, next])
