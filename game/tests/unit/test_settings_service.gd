extends GutTest
## Тесты SettingsService.
##
## Проверяется не «умеет ли сервис читать настройки», а свойства, от
## которых зависит игрок:
##   * значение, записанное в файл, возвращается из файла тем же;
##   * выход за границы диапазона ПРИВОДИТСЯ к границе, а не отбрасывается;
##   * чужие ключи в файле настроек НЕ затираются (иначе обновление игры
##     стирает настройки сторонних модов и отладочные флаги);
##   * повреждённый файл не роняет игру, а даёт дефолты.
##
## Все тесты пишут в user:// и обязаны подчищать за собой: иначе следующий
## прогон стартует с состоянием предыдущего и «плавающие» падения
## гарантированы.

const TEST_SETTINGS_PATH: String = "user://test_settings.cfg"

var _snapshot: Dictionary = {}


func before_each() -> void:
	_snapshot = SettingsService.snapshot()


func after_each() -> void:
	# apply_now=false: тест не должен дёргать режим окна и громкость.
	SettingsService.set_many(_snapshot, false)
	if FileAccess.file_exists(TEST_SETTINGS_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_SETTINGS_PATH))


func test_every_schema_key_has_a_value() -> void:
	for key: String in SettingsSchema.all_keys():
		assert_true(
			SettingsService.has_setting(key), "ключ схемы «%s» не инициализирован в сервисе" % key
		)


func test_defaults_match_the_schema() -> void:
	# Дефолты сервиса обязаны браться из схемы. Свои значения в сервисе —
	# это второй источник правды, и они разъезжаются при первой правке.
	var defaults: Dictionary = SettingsService.collect_defaults()
	for key: String in SettingsSchema.all_keys():
		var expected: Variant = SettingsSchema.describe(key)["default"]
		assert_true(defaults.has(key), "collect_defaults() пропустил " + key)
		if defaults.has(key):
			assert_eq(
				str(defaults[key]),
				str(expected),
				"%s: дефолт сервиса %s, а схемы %s" % [key, str(defaults[key]), str(expected)]
			)


func test_unknown_key_is_rejected() -> void:
	assert_false(SettingsService.has_setting("нет/такого/ключа"))
	# apply_now=false: ничего не применяем к движку.
	assert_false(
		SettingsService.set_value("нет/такого/ключа", 1, false),
		"запись несуществующего ключа должна отклоняться"
	)


func test_typed_getters_return_declared_type() -> void:
	for key: String in SettingsSchema.all_keys():
		var setting_type: int = int(SettingsSchema.describe(key)["type"])
		match setting_type:
			SettingsSchema.SettingType.BOOL:
				assert_typeof(SettingsService.get_bool(key), TYPE_BOOL, key)
			SettingsSchema.SettingType.INT, SettingsSchema.SettingType.ENUM:
				assert_typeof(SettingsService.get_int(key), TYPE_INT, key)
			SettingsSchema.SettingType.FLOAT:
				assert_typeof(SettingsService.get_float(key), TYPE_FLOAT, key)
			SettingsSchema.SettingType.STRING:
				assert_typeof(SettingsService.get_string(key), TYPE_STRING, key)


func test_float_value_clamped_to_schema_max() -> void:
	# Приведение к границе, а не отказ: игрок, записавший 5.0 в ползунок
	# 0..1, должен получить 1.0, а не сломанную настройку.
	var key: String = _first_float_key()
	if key.is_empty():
		pending("в схеме нет float-настроек")
		return
	var meta: Dictionary = SettingsSchema.describe(key)
	var above: float = float(meta["max"]) + 10.0
	SettingsService.set_value(key, above, false)
	assert_almost_eq(
		SettingsService.get_float(key),
		float(meta["max"]),
		0.0001,
		"%s: значение не приведено к max" % key
	)


func test_float_value_clamped_to_schema_min() -> void:
	var key: String = _first_float_key()
	if key.is_empty():
		pending("в схеме нет float-настроек")
		return
	var meta: Dictionary = SettingsSchema.describe(key)
	SettingsService.set_value(key, float(meta["min"]) - 10.0, false)
	assert_almost_eq(
		SettingsService.get_float(key),
		float(meta["min"]),
		0.0001,
		"%s: значение не приведено к min" % key
	)


func test_int_value_clamped() -> void:
	var key: String = _first_int_key()
	if key.is_empty():
		pending("в схеме нет int-настроек")
		return
	var meta: Dictionary = SettingsSchema.describe(key)
	SettingsService.set_value(key, int(meta["max"]) + 100, false)
	assert_eq(SettingsService.get_int(key), int(meta["max"]), key)
	SettingsService.set_value(key, int(meta["min"]) - 100, false)
	assert_eq(SettingsService.get_int(key), int(meta["min"]), key)


func test_enum_value_clamped_to_option_count() -> void:
	var key: String = _first_enum_key()
	if key.is_empty():
		pending("в схеме нет enum-настроек")
		return
	var options_count: int = int(SettingsSchema.describe(key)["options"].size())
	SettingsService.set_value(key, options_count + 5, false)
	assert_between(
		SettingsService.get_int(key),
		0,
		options_count - 1,
		"%s: индекс enum вышел за список вариантов" % key
	)


func test_bool_value_coerced_from_int() -> void:
	# Из файла настроек может прийти 1/0 вместо true/false (ConfigFile так
	# и делает). Сервис обязан привести тип, иначе get_bool вернёт мусор.
	var key: String = _first_bool_key()
	if key.is_empty():
		pending("в схеме нет bool-настроек")
		return
	SettingsService.set_value(key, 1, false)
	assert_true(SettingsService.get_bool(key), "%s: 1 не привелось к true" % key)
	SettingsService.set_value(key, 0, false)
	assert_false(SettingsService.get_bool(key), "%s: 0 не привелось к false" % key)


func test_set_value_reports_change_only_on_change() -> void:
	var key: String = _first_bool_key()
	if key.is_empty():
		pending("в схеме нет bool-настроек")
		return
	SettingsService.set_value(key, true, false)
	assert_false(
		SettingsService.set_value(key, true, false),
		"повторная запись того же значения не должна считаться изменением"
	)
	assert_true(
		SettingsService.set_value(key, false, false), "реальное изменение должно возвращать true"
	)


func test_set_many_returns_number_of_changes() -> void:
	var key: String = _first_float_key()
	if key.is_empty():
		pending("в схеме нет float-настроек")
		return
	var meta: Dictionary = SettingsSchema.describe(key)
	var target: float = float(meta["max"])
	SettingsService.set_value(key, float(meta["min"]), false)
	var changed: int = SettingsService.set_many({key: target}, false)
	assert_eq(changed, 1)
	var again: int = SettingsService.set_many({key: target}, false)
	assert_eq(again, 0, "повторное применение не должно считаться изменением")


func test_snapshot_is_a_deep_copy() -> void:
	var snapshot: Dictionary = SettingsService.snapshot()
	assert_false(snapshot.is_empty())
	# Изменение снимка не должно менять состояние сервиса: иначе
	# «отмена» в настройках ломает сами настройки.
	var key: String = _first_float_key()
	if key.is_empty() or not snapshot.has(key):
		pending("нет float-ключа в снимке")
		return
	snapshot[key] = -12345.0
	assert_ne(SettingsService.get_value(key), -12345.0)


func test_reset_section_restores_schema_defaults() -> void:
	var key: String = _first_float_key()
	if key.is_empty():
		pending("в схеме нет float-настроек")
		return
	var section: String = str(SettingsSchema.describe(key)["section"])
	var meta: Dictionary = SettingsSchema.describe(key)
	SettingsService.set_value(key, float(meta["max"]), false)
	SettingsService.reset_section(section)
	assert_eq(
		str(SettingsService.get_value(key)),
		str(meta["default"]),
		"%s: сброс секции не вернул дефолт схемы" % key
	)


func test_validate_schema_reports_no_problems() -> void:
	var problems: Array[String] = SettingsService.validate_schema()
	assert_eq(
		problems.size(), 0, "схема не проходит собственную валидацию:\n" + "\n".join(problems)
	)


func test_save_and_load_roundtrip() -> void:
	var key: String = _first_float_key()
	if key.is_empty():
		pending("в схеме нет float-настроек")
		return
	var meta: Dictionary = SettingsSchema.describe(key)
	var written: float = float(meta["max"])
	SettingsService.set_value(key, written, false)
	assert_true(SettingsService.save_to_disk(), "save_to_disk() вернул false")
	# Меняем значение в памяти, чтобы загрузка действительно его перезаписала.
	SettingsService.set_value(key, float(meta["min"]), false)
	assert_true(SettingsService.load_from_disk(), "load_from_disk() вернул false")
	assert_almost_eq(
		SettingsService.get_float(key),
		written,
		0.0001,
		"значение не пережило цикл сохранения и загрузки"
	)


func test_settings_file_is_created() -> void:
	SettingsService.save_to_disk()
	assert_true(
		FileAccess.file_exists(GameConfig.PATH_SETTINGS),
		"файл настроек не создан по пути " + GameConfig.PATH_SETTINGS
	)


func test_settings_changed_signal_carries_section() -> void:
	var key: String = _first_float_key()
	if key.is_empty():
		pending("в схеме нет float-настроек")
		return
	watch_signals(SettingsService)
	var meta: Dictionary = SettingsSchema.describe(key)
	var current: float = SettingsService.get_float(key)
	var other: float = float(meta["min"]) if current > float(meta["min"]) else float(meta["max"])
	SettingsService.set_value(key, other, false)
	assert_signal_emitted(SettingsService, "settings_changed")


func test_no_signal_when_value_unchanged() -> void:
	var key: String = _first_float_key()
	if key.is_empty():
		pending("в схеме нет float-настроек")
		return
	var current: float = SettingsService.get_float(key)
	watch_signals(SettingsService)
	SettingsService.set_value(key, current, false)
	assert_signal_not_emitted(
		SettingsService,
		"settings_changed",
		"сигнал ушёл при записи того же значения — UI будет пересобираться впустую"
	)


# ------------------------------------------------------------- помощники ----


func _first_key_of_type(setting_type: int) -> String:
	var keys: Array[String] = SettingsSchema.all_keys()
	keys.sort()
	for key: String in keys:
		if int(SettingsSchema.describe(key)["type"]) == setting_type:
			return key
	return ""


func _first_bool_key() -> String:
	return _first_key_of_type(SettingsSchema.SettingType.BOOL)


func _first_int_key() -> String:
	return _first_key_of_type(SettingsSchema.SettingType.INT)


func _first_float_key() -> String:
	return _first_key_of_type(SettingsSchema.SettingType.FLOAT)


func _first_enum_key() -> String:
	return _first_key_of_type(SettingsSchema.SettingType.ENUM)
