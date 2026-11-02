extends GutTest
## Тесты SettingsSchema.
##
## Схема — единственный источник правды о настройках: по ней строится UI,
## по ней валидируются значения, по ней пишется файл. Если схема
## внутренне противоречива, сломано всё сразу. Поэтому эти тесты
## проверяют ИНВАРИАНТЫ схемы, а не отдельные значения.


func test_schema_is_not_empty() -> void:
	assert_gt(
		SettingsSchema.SCHEMA.size(),
		20,
		"схема подозрительно мала — вероятно, часть настроек потеряна"
	)


func test_all_sections_are_declared() -> void:
	for section: String in SettingsSchema.SECTIONS:
		assert_ne(section, "", "пустое имя секции")


func test_every_key_has_consistent_section() -> void:
	# Ключ «video/msaa_3d» обязан лежать в секции «video». Расхождение
	# означает, что настройка попадёт не в ту вкладку меню.
	for key: String in SettingsSchema.all_keys():
		var meta: Dictionary = SettingsSchema.describe(key)
		var prefix: String = key.split("/")[0]
		assert_eq(
			meta["section"],
			prefix,
			"%s: секция «%s» не совпадает с префиксом «%s»" % [key, str(meta["section"]), prefix]
		)


func test_every_key_has_required_fields() -> void:
	for key: String in SettingsSchema.all_keys():
		var meta: Dictionary = SettingsSchema.describe(key)
		for field: String in ["section", "type", "default", "label"]:
			assert_has(meta, field, "%s: нет обязательного поля «%s»" % [key, field])


func test_labels_are_non_empty() -> void:
	# Пустая подпись — это строка в меню без текста. Игрок видит ползунок
	# и не понимает, что он делает.
	for key: String in SettingsSchema.all_keys():
		var meta: Dictionary = SettingsSchema.describe(key)
		assert_ne(str(meta["label"]).strip_edges(), "", "%s: пустая подпись" % key)


func test_defaults_match_declared_type() -> void:
	for key: String in SettingsSchema.all_keys():
		var meta: Dictionary = SettingsSchema.describe(key)
		var default: Variant = meta["default"]
		match int(meta["type"]):
			SettingsSchema.SettingType.BOOL:
				assert_typeof(default, TYPE_BOOL, "%s: default не bool" % key)
			SettingsSchema.SettingType.INT, SettingsSchema.SettingType.ENUM:
				assert_typeof(default, TYPE_INT, "%s: default не int" % key)
			SettingsSchema.SettingType.FLOAT:
				assert_typeof(default, TYPE_FLOAT, "%s: default не float" % key)
			SettingsSchema.SettingType.STRING:
				assert_typeof(default, TYPE_STRING, "%s: default не String" % key)


func test_numeric_ranges_contain_default() -> void:
	for key: String in SettingsSchema.all_keys():
		var meta: Dictionary = SettingsSchema.describe(key)
		var setting_type: int = int(meta["type"])
		if (
			setting_type != SettingsSchema.SettingType.INT
			and setting_type != SettingsSchema.SettingType.FLOAT
		):
			continue
		assert_has(meta, "min", "%s: число без min" % key)
		assert_has(meta, "max", "%s: число без max" % key)
		var default_value: float = float(meta["default"])
		assert_between(
			default_value,
			float(meta["min"]),
			float(meta["max"]),
			(
				"%s: default %s вне [%s; %s]"
				% [key, str(default_value), str(meta["min"]), str(meta["max"])]
			)
		)


func test_numeric_step_is_positive() -> void:
	for key: String in SettingsSchema.all_keys():
		var meta: Dictionary = SettingsSchema.describe(key)
		if not meta.has("step"):
			continue
		assert_gt(float(meta["step"]), 0.0, "%s: шаг должен быть положительным" % key)


func test_min_does_not_exceed_max() -> void:
	for key: String in SettingsSchema.all_keys():
		var meta: Dictionary = SettingsSchema.describe(key)
		if not meta.has("min"):
			continue
		assert_lte(float(meta["min"]), float(meta["max"]), "%s: min больше max" % key)


func test_enum_defaults_are_valid_indices() -> void:
	# ENUM хранит ИНДЕКС варианта. Default вне диапазона — это OptionButton
	# без выбранного пункта и значение, которое не отображается как текст.
	for key: String in SettingsSchema.all_keys():
		var meta: Dictionary = SettingsSchema.describe(key)
		if int(meta["type"]) != SettingsSchema.SettingType.ENUM:
			continue
		var options: Array = meta["options"]
		assert_gt(options.size(), 1, "%s: enum меньше двух вариантов" % key)
		assert_between(
			int(meta["default"]),
			0,
			options.size() - 1,
			"%s: default %d вне диапазона вариантов" % [key, int(meta["default"])]
		)


func test_enum_options_are_unique_strings() -> void:
	for key: String in SettingsSchema.all_keys():
		var meta: Dictionary = SettingsSchema.describe(key)
		if int(meta["type"]) != SettingsSchema.SettingType.ENUM:
			continue
		var seen: Array[String] = []
		for option: Variant in meta["options"]:
			assert_typeof(option, TYPE_STRING, "%s: вариант не строка" % key)
			assert_does_not_have(seen, str(option), "%s: дубль варианта «%s»" % [key, str(option)])
			seen.append(str(option))


func test_volume_keys_share_the_same_range() -> void:
	# Все громкости должны иметь одинаковый диапазон: разные шкалы
	# заставляют игрока подбирать «мастер на 70, музыку на 40» вслепую.
	var reference_min: float = -1.0
	var reference_max: float = -1.0
	for key: String in SettingsSchema.all_keys():
		if not key.contains("volume"):
			continue
		var meta: Dictionary = SettingsSchema.describe(key)
		if reference_min < 0.0:
			reference_min = float(meta["min"])
			reference_max = float(meta["max"])
		assert_eq(float(meta["min"]), reference_min, "%s: другой min" % key)
		assert_eq(float(meta["max"]), reference_max, "%s: другой max" % key)


func test_keys_in_section_partition_the_schema() -> void:
	# Объединение секций должно давать ровно все ключи, без дублей и потерь.
	var collected: Array[String] = []
	for section: String in SettingsSchema.SECTIONS:
		for key: String in SettingsSchema.keys_in_section(section):
			collected.append(key)
	collected.sort()
	var expected: Array[String] = SettingsSchema.all_keys()
	expected.sort()
	assert_eq_deep(collected, expected, "секции не покрывают схему целиком")


func test_every_section_is_non_empty() -> void:
	# Пустая секция — это пустая вкладка в меню настроек.
	for section: String in SettingsSchema.SECTIONS:
		assert_gt(SettingsSchema.keys_in_section(section).size(), 0, "секция «%s» пуста" % section)


func test_describe_unknown_key_returns_empty() -> void:
	assert_true(SettingsSchema.describe("нет/такого/ключа").is_empty())


func test_accessibility_keys_exist() -> void:
	# ТЗ требует графику с настройками и профессиональный GUI. Доступность —
	# часть профессионального интерфейса, а не дополнение: без этих ключей
	# часть игроков физически не сможет играть.
	for key: String in [
		"accessibility/fov",
		"accessibility/font_scale",
		"accessibility/screen_shake",
		"accessibility/colorblind_mode"
	]:
		assert_true(SettingsSchema.SCHEMA.has(key), "нет ключа " + key)


func test_gameplay_head_bob_is_declared() -> void:
	# Покачивание камеры читает player_controller.gd. Ключ обязан быть в
	# схеме: иначе get_bool вернёт дефолт, и настройка не появится в меню.
	assert_has(SettingsSchema.SCHEMA, "gameplay/head_bob")
	assert_eq(
		int(SettingsSchema.describe("gameplay/head_bob")["type"]), SettingsSchema.SettingType.BOOL
	)
