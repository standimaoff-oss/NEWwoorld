extends GutTest
## Тесты Validators.
##
## ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ НА САМОМ ДЕЛЕ. Не «работает ли функция», а
## «отличает ли она плохие данные от хороших». Валидатор, который
## пропускает мусор, хуже отсутствующего: он создаёт иллюзию контроля.
## Поэтому на каждое правило есть и положительный, и отрицательный случай.

const GOOD_ASSET: Dictionary = {
	"name": "Набор текстур бетона",
	"author": "Ivan Petrov",
	"license": "CC-BY-4.0",
	"url": "https://example.com/concrete",
}


func test_range_accepts_value_inside() -> void:
	var problems: Array[String] = []
	assert_true(Validators.check_range(0.5, 0.0, 1.0, "x", problems))
	assert_eq(problems.size(), 0, "диапазон не должен жаловаться на значение внутри")


func test_range_rejects_value_outside() -> void:
	var problems: Array[String] = []
	assert_false(Validators.check_range(1.5, 0.0, 1.0, "громкость", problems))
	assert_eq(problems.size(), 1)
	assert_string_contains(
		problems[0], "громкость", "сообщение обязано называть поле: иначе непонятно, что чинить"
	)


func test_range_rejects_nan_and_inf() -> void:
	# NaN — самый опасный случай: он не больше и не меньше границы, поэтому
	# наивная проверка «value < min or value > max» его ПРОПУСКАЕТ.
	var problems: Array[String] = []
	assert_false(Validators.check_range(NAN, 0.0, 1.0, "x", problems))
	assert_false(Validators.check_range(INF, 0.0, 1.0, "y", problems))
	assert_eq(problems.size(), 2)


func test_range_accepts_boundaries() -> void:
	var problems: Array[String] = []
	assert_true(Validators.check_range(0.0, 0.0, 1.0, "min", problems))
	assert_true(Validators.check_range(1.0, 0.0, 1.0, "max", problems))
	assert_eq(problems.size(), 0, "границы диапазона включены")


func test_positive_rejects_zero() -> void:
	var problems: Array[String] = []
	assert_false(Validators.check_positive(0.0, "радиус", problems))
	assert_false(Validators.check_positive(-1.0, "радиус", problems))
	assert_true(Validators.check_positive(0.001, "радиус", problems))


func test_non_negative_accepts_zero() -> void:
	var problems: Array[String] = []
	assert_true(Validators.check_non_negative(0.0, "смещение", problems))
	assert_false(Validators.check_non_negative(-0.001, "смещение", problems))


func test_non_empty_string_rejects_whitespace() -> void:
	# Строка из пробелов визуально непустая, а содержательно пуста. Это
	# типичный случай «автор не указан», который проходит наивную проверку.
	var problems: Array[String] = []
	assert_false(Validators.check_non_empty_string("   ", "автор", problems))
	assert_false(Validators.check_non_empty_string(42, "автор", problems))
	assert_true(Validators.check_non_empty_string("Иван", "автор", problems))


func test_resource_path_requires_scheme() -> void:
	var problems: Array[String] = []
	assert_true(Validators.check_resource_path("res://scenes/a.tscn", "путь", problems))
	assert_true(Validators.check_resource_path("user://saves/save_0.dat", "путь", problems))
	assert_false(Validators.check_resource_path("scenes/a.tscn", "путь", problems))
	assert_false(Validators.check_resource_path("res://../outside.tscn", "путь", problems))


func test_extension_is_case_insensitive() -> void:
	var problems: Array[String] = []
	assert_true(
		Validators.check_extension("model.GLB", Validators.MODEL_EXTENSIONS, "модель", problems)
	)
	assert_false(
		Validators.check_extension("model.fbx", Validators.MODEL_EXTENSIONS, "модель", problems)
	)
	assert_string_contains(problems[0], "fbx")


func test_dict_shape_reports_every_missing_key() -> void:
	# Все ошибки за один проход, а не по одной: чинить список быстрее,
	# чем перезапускать проверку после каждой правки.
	var problems: Array[String] = []
	assert_false(
		Validators.check_dict_shape(
			{}, {"name": TYPE_STRING, "license": TYPE_STRING}, "ассет", problems
		)
	)
	assert_eq(problems.size(), 2)


func test_dict_shape_rejects_wrong_type() -> void:
	var problems: Array[String] = []
	assert_false(
		Validators.check_dict_shape({"count": "пять"}, {"count": TYPE_INT}, "запись", problems)
	)
	assert_string_contains(problems[0], "count")


func test_dict_shape_accepts_nil_expectation_as_any_type() -> void:
	var problems: Array[String] = []
	assert_true(Validators.check_dict_shape({"data": 1.5}, {"data": TYPE_NIL}, "запись", problems))


func test_extra_keys_are_reported_as_possible_typos() -> void:
	var problems: Array[String] = []
	assert_false(
		Validators.check_no_extra_keys(
			{"name": "x", "lable": "y"}, ["name", "label"], "запись", problems
		)
	)
	assert_string_contains(problems[0], "lable")
	assert_string_contains(problems[0], "опечатка")


func test_free_license_accepted() -> void:
	var problems: Array[String] = []
	assert_true(Validators.check_license("CC0", "ассет", problems))
	assert_true(Validators.check_license("CC-BY-4.0", "ассет", problems))
	assert_true(Validators.check_license("MIT", "ассет", problems))
	assert_eq(problems.size(), 0)


func test_non_commercial_license_rejected() -> void:
	# CC-BY-NC — «бесплатно», но НЕ для коммерческого использования.
	# Это самое частое нарушение в играх, собранных из ассетов с форумов.
	var problems: Array[String] = []
	assert_false(Validators.check_license("CC-BY-NC-4.0", "ассет", problems))
	assert_string_contains(problems[0], "запрещена")


func test_unknown_license_rejected() -> void:
	# Неизвестная лицензия не должна проскакивать: её надо добавить в
	# список ОСОЗНАННО. Молчаливое «разрешено» здесь опаснее отказа.
	var problems: Array[String] = []
	assert_false(Validators.check_license("какая-то бесплатная", "ассет", problems))


func test_missing_license_is_error() -> void:
	var problems: Array[String] = []
	assert_false(Validators.check_license("", "ассет", problems))
	assert_false(Validators.check_license(null, "ассет", problems))


func test_attribution_required_for_cc_by() -> void:
	var problems: Array[String] = []
	assert_false(
		Validators.check_attribution({"license": "CC-BY-4.0", "author": ""}, "ассет", problems)
	)
	assert_false(
		Validators.check_attribution(
			{"license": "CC-BY-4.0", "author": "unknown"}, "ассет", problems
		)
	)
	assert_true(
		Validators.check_attribution(
			{"license": "CC-BY-4.0", "author": "Ivan Petrov"}, "ассет", problems
		)
	)


func test_attribution_not_required_for_cc0() -> void:
	# CC0 не требует указания автора: требовать его — значит заставлять
	# выдумывать данные, что хуже честного «автор не указан».
	var problems: Array[String] = []
	assert_true(Validators.check_attribution({"license": "CC0", "author": ""}, "ассет", problems))
	assert_eq(problems.size(), 0)


func test_asset_entry_full_check() -> void:
	var problems: Array[String] = []
	assert_true(Validators.check_asset_entry(GOOD_ASSET, 0, problems))
	assert_eq(problems.size(), 0)


func test_asset_entry_requires_https_url() -> void:
	var problems: Array[String] = []
	var entry: Dictionary = GOOD_ASSET.duplicate()
	entry["url"] = "http://example.com/insecure"
	assert_false(Validators.check_asset_entry(entry, 0, problems))
	assert_string_contains(problems[0], "https")


func test_normalized_direction_rejects_zero_and_unnormalized() -> void:
	var problems: Array[String] = []
	assert_false(Validators.check_normalized_direction(Vector3.ZERO, "направление", problems))
	assert_false(
		Validators.check_normalized_direction(Vector3(1, 0, 0) * 2.0, "направление", problems)
	)
	assert_true(Validators.check_normalized_direction(Vector3(0, 0, -1), "направление", problems))


func test_finite_vector_rejects_nan() -> void:
	var problems: Array[String] = []
	assert_false(Validators.check_finite_vector(Vector3(NAN, 0, 0), "позиция", problems))
	assert_false(Validators.check_finite_vector(Vector3.INF, "позиция", problems))
	assert_true(Validators.check_finite_vector(Vector3(1, 2, 3), "позиция", problems))


func test_degenerate_triangle_rejected() -> void:
	var problems: Array[String] = []
	# Коллинеарные точки: площадь нулевая, нормаль не определена.
	assert_false(
		Validators.check_triangle_non_degenerate(
			Vector3(0, 0, 0), Vector3(1, 0, 0), Vector3(2, 0, 0), "треугольник", problems
		)
	)
	# Совпадающие точки — тоже вырождение.
	assert_false(
		Validators.check_triangle_non_degenerate(
			Vector3.ONE, Vector3.ONE, Vector3.ONE, "треугольник", problems
		)
	)
	assert_true(
		Validators.check_triangle_non_degenerate(
			Vector3(0, 0, 0), Vector3(1, 0, 0), Vector3(0, 1, 0), "треугольник", problems
		)
	)


func test_license_lists_do_not_overlap_forbidden() -> void:
	# Инвариант самих данных: лицензия не может быть одновременно
	# разрешённой и запрещённой. Проверка дешёвая, а цена расхождения —
	# юридическая.
	for license_name: String in Validators.FORBIDDEN_LICENSES:
		assert_false(
			Validators.FREE_LICENSES.has(license_name),
			"%s одновременно в FREE и FORBIDDEN" % license_name
		)


func test_attribution_licenses_are_subset_of_free() -> void:
	for license_name: String in Validators.ATTRIBUTION_LICENSES:
		assert_has(
			Validators.FREE_LICENSES,
			license_name,
			"%s требует атрибуции, но не считается свободной" % license_name
		)


func test_model_size_limits_are_sane() -> void:
	# Лимиты из ТЗ. Слишком большой лимит делает проверку бессмысленной,
	# слишком маленький — блокирует легитимные ассеты.
	assert_between(Validators.MAX_MODEL_BYTES, 1024 * 1024, 64 * 1024 * 1024)
	assert_gt(Validators.MAX_TEXTURE_BYTES, 0)
	assert_lte(Validators.MAX_TEXTURE_BYTES, Validators.MAX_MODEL_BYTES * 2)
