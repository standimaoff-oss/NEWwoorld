extends GutTest
## Контракт между DebugOverlay и PerfMonitor.
##
## ЗАЧЕМ ОТДЕЛЬНЫЙ ТЕСТ. Оверлей читает снимок по строковым ключам:
## snapshot.get("process_ms"). Опечатка в ключе НЕ падает — Dictionary.get
## вернёт null, и панель честно нарисует прочерк. То есть отладочный
## инструмент начнёт врать молча, а именно ему разработчик верит.
##
## Такой баг уже был: оверлей запрашивал "process_time_ms", "node_count",
## "static_memory_mb", а PerfMonitor отдаёт "process_ms", "nodes",
## "static_mem_mb". Пять строк цифр из шести были бы прочерками.
##
## Тест берёт список ключей из КОНСТАНТЫ оверлея и сверяет с реальным
## снимком — поэтому расхождение ловится сразу.

const DebugOverlayScript: GDScript = preload("res://scripts/ui/debug_overlay.gd")

var _snapshot_keys: Array = []


func before_all() -> void:
	var keys: Variant = DebugOverlayScript.SNAPSHOT_KEYS
	assert_typeof(keys, TYPE_ARRAY, "SNAPSHOT_KEYS не является массивом")
	if typeof(keys) == TYPE_ARRAY:
		_snapshot_keys = keys


func test_overlay_declares_the_keys_it_reads() -> void:
	assert_gt(_snapshot_keys.size(), 0, "оверлей не объявил ни одного ключа снимка")


func test_every_declared_key_exists_in_snapshot() -> void:
	var snapshot: Dictionary = PerfMonitor.build_snapshot()
	var missing: Array[String] = []
	for key: Variant in _snapshot_keys:
		if not snapshot.has(str(key)):
			missing.append(str(key))
	assert_eq(
		missing.size(),
		0,
		(
			(
				"PerfMonitor не отдаёт ключи, которые читает оверлей: %s\n"
				+ "доступные ключи: %s" % [", ".join(missing), ", ".join(snapshot.keys())]
			)
			if missing.size() > 0
			else ""
		)
	)


func test_snapshot_keys_are_declared_as_constants() -> void:
	# Каждый ключ обязан быть константой K_*, а не строкой в коде: константу
	# нельзя опечатать дважды, а линтер поймает несуществующее имя.
	for key: Variant in _snapshot_keys:
		var expected_const: String = "K_" + str(key).to_upper()
		assert_true(
			DebugOverlayScript.get_script_constant_map().has(expected_const),
			"ключ «%s» не вынесен в константу %s" % [str(key), expected_const]
		)


func test_constants_match_their_values() -> void:
	# Константа может быть объявлена, но содержать другое имя — тогда
	# предыдущий тест проходит, а оверлей всё равно врёт.
	var constants: Dictionary = DebugOverlayScript.get_script_constant_map()
	for key: Variant in _snapshot_keys:
		var const_name: String = "K_" + str(key).to_upper()
		if not constants.has(const_name):
			continue
		assert_eq(
			str(constants[const_name]),
			str(key),
			"%s содержит «%s» вместо «%s»" % [const_name, str(constants[const_name]), str(key)]
		)


func test_snapshot_values_are_numeric_or_string() -> void:
	# Оверлей форматирует значения через _fmt(), который ждёт число или
	# строку. Словарь или массив на месте числа дали бы «—».
	var snapshot: Dictionary = PerfMonitor.build_snapshot()
	for key: Variant in _snapshot_keys:
		var value: Variant = snapshot.get(str(key))
		assert_true(
			typeof(value) in [TYPE_FLOAT, TYPE_INT, TYPE_STRING],
			"ключ «%s» содержит %s" % [str(key), type_string(typeof(value))]
		)


func test_snapshot_is_fresh_each_call() -> void:
	# build_snapshot() обязан отдавать актуальные данные, а не кэш:
	# оверлей вызывает его раз в 250 мс.
	var first: Dictionary = PerfMonitor.build_snapshot()
	var second: Dictionary = PerfMonitor.build_snapshot()
	assert_has(first, "fps")
	assert_has(second, "fps")
	assert_false(first.is_empty())


func test_monitoring_can_be_paused() -> void:
	var was_paused: bool = PerfMonitor.is_monitoring_paused()
	PerfMonitor.set_monitoring_paused(true)
	assert_true(PerfMonitor.is_monitoring_paused())
	PerfMonitor.set_monitoring_paused(false)
	assert_false(PerfMonitor.is_monitoring_paused())
	PerfMonitor.set_monitoring_paused(was_paused)
