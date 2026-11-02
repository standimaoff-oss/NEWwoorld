extends Node
## SettingsService — применение настроек к движку и их хранение.
##
## ОПИСАНИЕ настроек (типы, границы, дефолты, подписи) живёт в
## SettingsSchema. Здесь — только поведение:
##   * get/set с валидацией по схеме,
##   * применение к движку (окно, vsync, MSAA, апскейл, громкость, locale),
##   * чтение/запись user://settings.cfg атомарно,
##   * сохранение «чужих» ключей из будущих версий, чтобы обновление игры
##     не стирало пользовательские данные, которых эта версия не знает.
##
## Разделение «данные / поведение» здесь не косметика: схема нужна и UI,
## и тестам, и миграциям, а применение к движку — только сервису.

var _foreign_keys: Dictionary = {}
var _values: Dictionary = {}
var _loaded_from_disk: bool = false
var _applying: bool = false
var _headless: bool = false


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_headless = DisplayServer.get_name() == "headless"
	_values = collect_defaults()
	load_from_disk()
	apply_all()
	(
		Diagnostics
		. info(
			"settings",
			"загружено настроек: %d (с диска: %s)" % [_values.size(), str(_loaded_from_disk)],
		)
	)


# ------------------------------------------------------------------ чтение --


## Значение настройки. Для неизвестного ключа — ошибка в лог и null.
func get_value(key: String) -> Variant:
	if not _values.has(key):
		Diagnostics.error("settings", "get_value: неизвестный ключ '%s'" % key)
		return null
	return _values[key]


## Типизированные геттеры — чтобы в коде не было int(get_value(...)) везде.
func get_bool(key: String) -> bool:
	return bool(get_value(key))


func get_int(key: String) -> int:
	return int(get_value(key))


func get_float(key: String) -> float:
	return float(get_value(key))


func get_string(key: String) -> String:
	return str(get_value(key))


func has_setting(key: String) -> bool:
	return SettingsSchema.SCHEMA.has(key)


func keys_in_section(section: String) -> Array[String]:
	return SettingsSchema.keys_in_section(section)


## Полное описание настройки для построения UI.
func describe(key: String) -> Dictionary:
	if not SettingsSchema.SCHEMA.has(key):
		return {}
	var meta: Dictionary = SettingsSchema.SCHEMA[key].duplicate(true)
	meta["key"] = key
	meta["value"] = _values.get(key)
	return meta


## Значения по умолчанию для всей схемы.
func collect_defaults() -> Dictionary:
	return SettingsSchema.defaults()


# ------------------------------------------------------------------ запись --


## Устанавливает значение: валидация -> применение -> событие.
## Возвращает true, если значение изменилось и было применено.
func set_value(key: String, raw_value: Variant, apply_now: bool = true) -> bool:
	if not SettingsSchema.SCHEMA.has(key):
		Diagnostics.error("settings", "set_value: неизвестный ключ '%s'" % key)
		return false
	var validated: Variant = _validate(key, raw_value)
	if validated == null:
		return false
	if _values.get(key) == validated:
		return false
	_values[key] = validated
	if apply_now and not _applying:
		_apply_key(key)
	EventBus.settings_changed.emit(str(SettingsSchema.SCHEMA[key]["section"]))
	return true


## Массовое применение словаря. Используется пресетами качества.
func set_many(updates: Dictionary, apply_now: bool = true) -> int:
	var applied: int = 0
	_applying = true
	for key: String in updates.keys():
		if set_value(key, updates[key], false):
			applied += 1
	_applying = false
	if apply_now and applied > 0:
		apply_all()
	return applied


## Сброс к дефолтам. Пустая секция = все настройки.
func reset_section(section: String = "") -> void:
	var keys: Array[String] = keys_in_section(section) if section != "" else _all_keys()
	_applying = true
	for key: String in keys:
		_values[key] = SettingsSchema.SCHEMA[key]["default"]
	_applying = false
	apply_all()
	Diagnostics.info("settings", "сброс секции '%s'" % (section if section != "" else "ВСЕ"))
	EventBus.settings_changed.emit(section)


# ------------------------------------------------------------- применение --


## Применить ВСЕ настройки к движку. Вызывается при старте и после сброса.
func apply_all() -> void:
	_applying = true
	for key: String in _all_keys():
		_apply_key(key)
	_applying = false


## Применить настройки одной секции.
func apply_section(section: String) -> void:
	_applying = true
	for key: String in keys_in_section(section):
		_apply_key(key)
	_applying = false


func _apply_key(key: String) -> void:
	match key:
		"video/window_mode":
			_apply_window_mode(get_int(key))
		"video/vsync":
			_apply_vsync(get_int(key))
		"video/max_fps":
			Engine.max_fps = get_int(key)
		"video/msaa_3d":
			_apply_msaa(get_int(key))
		"video/screen_space_aa":
			_apply_screen_space_aa(get_int(key))
		"video/taa":
			_apply_taa(get_bool(key))
		"video/scaling_mode":
			_apply_scaling_mode(get_int(key))
		"video/scaling_scale":
			_apply_scaling_scale(get_float(key))
		"video/anisotropic_filtering":
			_apply_anisotropy(get_int(key))
		"video/quality_preset":
			EventBus.quality_preset_changed.emit(get_int(key))
		"audio/master_volume":
			_apply_bus_volume(GameConfig.BUS_MASTER, get_float(key))
		"audio/music_volume":
			_apply_bus_volume(GameConfig.BUS_MUSIC, get_float(key))
		"audio/sfx_volume":
			_apply_bus_volume(GameConfig.BUS_SFX, get_float(key))
		"audio/voice_volume":
			_apply_bus_volume(GameConfig.BUS_VOICE, get_float(key))
		"audio/ambient_volume":
			_apply_bus_volume(GameConfig.BUS_AMBIENT, get_float(key))
		"audio/mute":
			_apply_mute(get_bool(key))
		"input/gamepad_deadzone":
			_apply_deadzone(get_float(key))
		"gameplay/language":
			_apply_locale(get_string(key))
		_:
			# Остальные настройки (тени, SSAO, FOV, тряска…) применяются
			# QualityService и конкретными нодами — у них есть доступ к
			# WorldEnvironment и камере, у SettingsService его нет.
			pass


func _apply_window_mode(mode: int) -> void:
	if _headless:
		return
	match mode:
		0:
			DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_WINDOWED)
			DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_BORDERLESS, false)
		1:
			DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_WINDOWED)
			DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_BORDERLESS, true)
		2:
			DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_FULLSCREEN)
		_:
			Diagnostics.warn("settings", "неизвестный window_mode: %d" % mode)


func _apply_vsync(mode: int) -> void:
	if _headless:
		return
	var vsync_mode: DisplayServer.VSyncMode
	match mode:
		0:
			vsync_mode = DisplayServer.VSYNC_DISABLED
		1:
			vsync_mode = DisplayServer.VSYNC_ENABLED
		2:
			vsync_mode = DisplayServer.VSYNC_ADAPTIVE
		_:
			vsync_mode = DisplayServer.VSYNC_ENABLED
	DisplayServer.window_set_vsync_mode(vsync_mode)


func _apply_msaa(level: int) -> void:
	var viewport: Viewport = get_viewport()
	if viewport == null:
		return
	viewport.msaa_3d = level as Viewport.MSAA


func _apply_screen_space_aa(level: int) -> void:
	var viewport: Viewport = get_viewport()
	if viewport == null:
		return
	viewport.screen_space_aa = level as Viewport.ScreenSpaceAA


func _apply_taa(enabled: bool) -> void:
	var viewport: Viewport = get_viewport()
	if viewport == null:
		return
	viewport.use_taa = enabled


func _apply_scaling_mode(level: int) -> void:
	var viewport: Viewport = get_viewport()
	if viewport == null:
		return
	viewport.scaling_3d_mode = level as Viewport.Scaling3DMode


func _apply_scaling_scale(scale_value: float) -> void:
	var viewport: Viewport = get_viewport()
	if viewport == null:
		return
	viewport.scaling_3d_scale = clampf(scale_value, 0.5, 1.0)


func _apply_anisotropy(level: int) -> void:
	# Уровень 0..4 -> 1, 2, 4, 8, 16.
	# ВАЖНО: в Godot 4 у анизотропии НЕТ runtime-API (метод
	# RenderingServer.set_default_anisotropic_filtering не существует —
	# проверено по extension_api.json). Значение читается движком при
	# создании текстур, поэтому пишем в ProjectSettings: новые текстуры
	# подхватят его сразу, полностью — после перезапуска.
	var factor: int = 1 << clampi(level, 0, 4)
	ProjectSettings.set_setting(
		"rendering/textures/default_filters/anisotropic_filtering_level", factor
	)


func _apply_bus_volume(bus_name: String, linear: float) -> void:
	var index: int = AudioServer.get_bus_index(bus_name)
	if index < 0:
		Diagnostics.warn("settings", "аудиошина не найдена: " + bus_name)
		return
	AudioServer.set_bus_volume_db(index, GameConfig.volume_linear_to_db(linear))


func _apply_mute(muted: bool) -> void:
	var index: int = AudioServer.get_bus_index(GameConfig.BUS_MASTER)
	if index < 0:
		return
	AudioServer.set_bus_mute(index, muted)


func _apply_deadzone(deadzone: float) -> void:
	for action: StringName in InputMap.get_actions():
		# Системные ui_* не трогаем: у них своя логика и свои дефолты.
		if String(action).begins_with("ui_"):
			continue
		InputMap.action_set_deadzone(action, deadzone)


func _apply_locale(locale_code: String) -> void:
	if locale_code.is_empty():
		return
	TranslationServer.set_locale(locale_code)
	EventBus.language_changed.emit(locale_code)


# ------------------------------------------------------------- сохранение --


## Пишет настройки в user://settings.cfg. Атомарно: сначала временный файл.
func save_to_disk() -> bool:
	var config := ConfigFile.new()
	for key: String in _values.keys():
		config.set_value(CONFIG_SECTION, key, _values[key])
	for key: String in _foreign_keys.keys():
		config.set_value(CONFIG_SECTION, key, _foreign_keys[key])
	config.set_value(CONFIG_SECTION, "_schema_version", GameConfig.SAVE_SCHEMA_VERSION)

	var tmp_path: String = GameConfig.PATH_SETTINGS + ".tmp"
	var err: int = config.save(tmp_path)
	if err != OK:
		Diagnostics.error("settings", "не сохранить %s (err=%d)" % [tmp_path, err])
		return false
	# Атомарная замена: если запись прервётся, основной файл не пострадает.
	var rename_err: int = (
		DirAccess
		. rename_absolute(
			ProjectSettings.globalize_path(tmp_path),
			ProjectSettings.globalize_path(GameConfig.PATH_SETTINGS),
		)
	)
	if rename_err != OK:
		Diagnostics.error("settings", "rename не удался (err=%d)" % rename_err)
		return false
	Diagnostics.debug("settings", "сохранено -> " + GameConfig.PATH_SETTINGS)
	EventBus.settings_saved.emit()
	return true


## Читает настройки с диска. Отсутствующие ключи остаются дефолтными.
func load_from_disk() -> bool:
	if not FileAccess.file_exists(GameConfig.PATH_SETTINGS):
		Diagnostics.info("settings", "файла настроек нет — берём дефолты")
		_loaded_from_disk = false
		return false
	var config := ConfigFile.new()
	var err: int = config.load(GameConfig.PATH_SETTINGS)
	if err != OK:
		Diagnostics.error("settings", "не прочитать настройки (err=%d)" % err)
		_loaded_from_disk = false
		return false

	var schema_version: int = int(config.get_value(CONFIG_SECTION, "_schema_version", 0))
	if schema_version != GameConfig.SAVE_SCHEMA_VERSION:
		(
			Diagnostics
			. warn(
				"settings",
				(
					"версия схемы %d, ожидаем %d — неизвестные ключи сохраняются как есть"
					% [schema_version, GameConfig.SAVE_SCHEMA_VERSION]
				),
			)
		)

	_foreign_keys.clear()
	var restored: int = 0
	for key: String in config.get_section_keys(CONFIG_SECTION):
		if key.begins_with("_"):
			continue
		var raw: Variant = config.get_value(CONFIG_SECTION, key)
		if not SettingsSchema.SCHEMA.has(key):
			_foreign_keys[key] = raw
			continue
		var validated: Variant = _validate(key, raw)
		if validated == null:
			Diagnostics.warn("settings", "отброшено невалидное '%s' = %s" % [key, str(raw)])
			continue
		_values[key] = validated
		restored += 1
	_loaded_from_disk = true
	Diagnostics.info("settings", "восстановлено настроек с диска: %d" % restored)
	EventBus.settings_loaded.emit()
	return true


# ---------------------------------------------------------------- утилиты --


## Полный дамп значений — для тестов, отладки и багрепорта.
func snapshot() -> Dictionary:
	return _values.duplicate(true)


## Проверяет целостность самой схемы. Вызывается тестом на каждом прогоне:
## опечатка в SettingsSchema.SCHEMA должна падать в CI, а не у игрока.
func validate_schema() -> Array[String]:
	var problems: Array[String] = []
	for key: String in SettingsSchema.all_keys():
		var meta: Dictionary = SettingsSchema.SCHEMA[key]
		for required: String in ["section", "type", "default", "label", "hint"]:
			if not meta.has(required):
				problems.append("%s: нет поля '%s'" % [key, required])
		if not SECTIONS.has(str(meta.get("section", ""))):
			problems.append("%s: неизвестная секция '%s'" % [key, str(meta["section"])])
		var type_id: int = int(meta.get("type", -1))
		if type_id < 0 or type_id > SettingsSchema.SettingType.STRING:
			problems.append("%s: некорректный type=%d" % [key, type_id])
		if _validate(key, meta.get("default")) == null:
			problems.append("%s: дефолт не проходит собственную валидацию" % key)
		if type_id == SettingsSchema.SettingType.ENUM and not meta.has("options"):
			problems.append("%s: ENUM без options" % key)
	return problems


func _all_keys() -> Array[String]:
	var out: Array[String] = []
	for key: String in SettingsSchema.all_keys():
		out.append(key)
	out.sort()
	return out


## Приводит значение к типу схемы и проверяет границы.
## Возвращает null, если значение использовать нельзя.
## Разбито на валидаторы по типу: у одного большого match получалось
## семь точек возврата, а у каждого типа своя логика приведения.
func _validate(key: String, raw_value: Variant) -> Variant:
	if raw_value == null:
		Diagnostics.error("settings", "validate: null для '%s'" % key)
		return null
	var meta: Dictionary = SettingsSchema.SCHEMA[key]
	var type_id: int = int(meta["type"])
	var result: Variant = null
	match type_id:
		SettingsSchema.SettingType.BOOL:
			result = _validate_bool(raw_value)
		SettingsSchema.SettingType.INT:
			result = _validate_int(key, raw_value, meta)
		SettingsSchema.SettingType.FLOAT:
			result = _validate_float(key, raw_value, meta)
		SettingsSchema.SettingType.ENUM:
			result = _validate_enum(key, raw_value, meta)
		SettingsSchema.SettingType.STRING:
			result = str(raw_value)
		_:
			Diagnostics.error("settings", "validate: тип %d неизвестен для '%s'" % [type_id, key])
	return result


func _validate_bool(raw_value: Variant) -> Variant:
	if raw_value is bool:
		return raw_value
	if raw_value is String:
		return str(raw_value).to_lower() in ["true", "1", "yes", "on"]
	if raw_value is int or raw_value is float:
		return int(raw_value) != 0
	return null


func _validate_int(key: String, raw_value: Variant, meta: Dictionary) -> Variant:
	if not (raw_value is int or raw_value is float):
		Diagnostics.error("settings", "validate: '%s' ждёт число, дано %s" % [key, str(raw_value)])
		return null
	return clampi(
		int(raw_value), int(meta.get("min", -2147483648)), int(meta.get("max", 2147483647))
	)


func _validate_float(key: String, raw_value: Variant, meta: Dictionary) -> Variant:
	if not (raw_value is int or raw_value is float):
		Diagnostics.error("settings", "validate: '%s' ждёт число, дано %s" % [key, str(raw_value)])
		return null
	return clampf(float(raw_value), float(meta.get("min", 0.0)), float(meta.get("max", 1.0)))


func _validate_enum(key: String, raw_value: Variant, meta: Dictionary) -> Variant:
	var options: Array = meta.get("options", [])
	var index: int = -1
	if raw_value is int:
		index = int(raw_value)
	elif raw_value is String:
		index = options.find(raw_value)
	if index < 0 or index >= options.size():
		Diagnostics.error(
			"settings",
			"validate: '%s' = %s вне диапазона 0..%d" % [key, str(raw_value), options.size() - 1]
		)
		return null
	return index
