class_name Validators
extends RefCounted
## Validators — проверки данных, которые нельзя доверить рантайму движка.
##
## ЗАЧЕМ. Godot охотно принимает мусор: Dictionary с отсутствующим ключом
## вернёт null, JSON с лишним полем загрузится, .glb без материалов
## отрисуется белым. Игра при этом «работает», а ломается позже и в другом
## месте. Эти функции превращают молчаливый мусор в явную ошибку с
## указанием ИМЕНИ файла и ПОЛЯ — то есть в то, что можно исправить.
##
## Все методы статические и ничего не бросают: возвращают Array[String]
## проблем. Пустой массив = данные корректны. Такой интерфейс позволяет
## собрать ВСЕ ошибки за один проход, а не чинить их по одной.
##
## Используются в boot.gd, в тестах и в tools/asset-pipeline — одни и те
## же правила на трёх языках реализации были бы тремя источниками правды,
## поэтому GDScript-версия считается основной.

## Допустимые лицензии для сторонних ассетов. Список закрытый намеренно:
## «бесплатно» без явной лицензии юридически не значит ничего, и такой
## ассет брать нельзя. CC0 и CC-BY различаются ОБЯЗАТЕЛЬНОСТЬЮ атрибуции.
const FREE_LICENSES: Array[String] = [
	"CC0",
	"CC0-1.0",
	"Public Domain",
	"MIT",
	"Apache-2.0",
	"BSD-3-Clause",
	"BSD-2-Clause",
	# Zlib и ISC — полноценные свободные лицензии, разрешающие коммерческое
	# использование и изменение. Требование у них одно: сохранить текст
	# уведомления в поставке. Zlib в проекте реально используется — под ним
	# идёт mikktspace (расчёт тангент-пространства в конвейере ассетов).
	"Zlib",
	"ISC",
	"CC-BY",
	"CC-BY-4.0",
	"CC-BY-3.0",
	"CC-BY-SA",
	"CC-BY-SA-4.0",
	"CC-BY-SA-3.0",
	"OFL-1.1",
	"Godot Engine license",
	"custom: attribution",
]

## Лицензии, при которых атрибуция ОБЯЗАТЕЛЬНА.
const ATTRIBUTION_LICENSES: Array[String] = [
	"CC-BY",
	"CC-BY-4.0",
	"CC-BY-3.0",
	"CC-BY-SA",
	"CC-BY-SA-4.0",
	"CC-BY-SA-3.0",
	"MIT",
	"Apache-2.0",
	"BSD-3-Clause",
	"BSD-2-Clause",
	# Zlib и ISC формально разрешают не указывать автора в документации
	# продукта, но текст уведомления сохранять обязаны. Относим их к
	# требующим атрибуции: потерять уведомление дороже, чем указать лишний
	# раз, а CC0 остаётся единственным вариантом без всяких условий.
	"Zlib",
	"ISC",
	"OFL-1.1",
	"custom: attribution",
]

## Лицензии, которые брать НЕЛЬЗЯ: они не свободные либо запрещают
## использование в игре.
const FORBIDDEN_LICENSES: Array[String] = [
	"CC-BY-NC",
	"CC-BY-NC-4.0",
	"CC-BY-NC-SA",
	"CC-BY-ND",
	"CC-BY-NC-ND",
	"All Rights Reserved",
	"proprietary",
	"editorial use only",
]

## Максимальный размер файла модели, байт. Ориентир из ТЗ: оптимизированный
## .glb уровня — единицы мегабайт. Файл больше этого почти наверняка не
## прошёл конвейер (draco/meshopt/KTX) и потянет за собой просадки.
const MAX_MODEL_BYTES: int = 12 * 1024 * 1024
## Максимальный размер текстуры, байт.
const MAX_TEXTURE_BYTES: int = 8 * 1024 * 1024
## Допустимые расширения моделей.
const MODEL_EXTENSIONS: Array[String] = [".glb", ".gltf"]
## Допустимые расширения текстур в проекте.
const TEXTURE_EXTENSIONS: Array[String] = [".ktx", ".png", ".jpg", ".webp", ".dds"]

# ------------------------------------------------------------------- числа --


## Проверяет, что значение — конечное число в диапазоне.
## NaN и INF в физике дают объекты, которые «улетают» без ошибки в логе.
static func check_range(
	value: float, minimum: float, maximum: float, field: String, problems: Array[String]
) -> bool:
	if is_nan(value) or is_inf(value):
		problems.append("%s: значение не конечное (%s)" % [field, str(value)])
		return false
	if value < minimum or value > maximum:
		problems.append(
			"%s: %s вне диапазона [%s; %s]" % [field, str(value), str(minimum), str(maximum)]
		)
		return false
	return true


static func check_positive(value: float, field: String, problems: Array[String]) -> bool:
	if is_nan(value) or value <= 0.0:
		problems.append("%s: ожидалось положительное число, получено %s" % [field, str(value)])
		return false
	return true


static func check_non_negative(value: float, field: String, problems: Array[String]) -> bool:
	if is_nan(value) or value < 0.0:
		problems.append("%s: ожидалось неотрицательное число, получено %s" % [field, str(value)])
		return false
	return true


# ------------------------------------------------------------------ строки --


static func check_non_empty_string(value: Variant, field: String, problems: Array[String]) -> bool:
	if typeof(value) != TYPE_STRING:
		problems.append("%s: ожидалась строка, получен %s" % [field, type_string(typeof(value))])
		return false
	if String(value).strip_edges().is_empty():
		problems.append("%s: пустая строка" % field)
		return false
	return true


## Проверяет, что путь начинается с res:// или user:// и не содержит «..».
## Относительные пути в .tscn/.tres работают, но ломаются при переносе
## файла, а «..» позволяет выйти за пределы проекта.
static func check_resource_path(value: Variant, field: String, problems: Array[String]) -> bool:
	if not check_non_empty_string(value, field, problems):
		return false
	var path: String = String(value)
	if not (path.begins_with("res://") or path.begins_with("user://")):
		problems.append("%s: путь «%s» должен начинаться с res:// или user://" % [field, path])
		return false
	if path.contains(".."):
		problems.append("%s: путь «%s» содержит «..»" % [field, path])
		return false
	return true


static func check_extension(
	value: String, allowed: Array[String], field: String, problems: Array[String]
) -> bool:
	var lowered: String = value.to_lower()
	for extension: String in allowed:
		if lowered.ends_with(extension):
			return true
	problems.append(
		"%s: «%s» — недопустимое расширение, разрешены %s" % [field, value, ", ".join(allowed)]
	)
	return false


# --------------------------------------------------------------- словари ---


## Проверяет наличие обязательных ключей и их типы.
## expected: имя ключа -> один из TYPE_* движка.
static func check_dict_shape(
	data: Dictionary, expected: Dictionary, context: String, problems: Array[String]
) -> bool:
	var ok: bool = true
	for key: String in expected.keys():
		if not data.has(key):
			problems.append("%s: нет обязательного поля «%s»" % [context, key])
			ok = false
			continue
		var wanted: int = int(expected[key])
		var actual: int = typeof(data[key])
		if wanted != TYPE_NIL and actual != wanted:
			problems.append(
				(
					"%s.%s: ожидался тип %s, получен %s"
					% [context, key, type_string(wanted), type_string(actual)]
				)
			)
			ok = false
	return ok


## Лишние ключи — почти всегда опечатка. «lable» вместо «label» не
## вызывает ошибки, а просто не отображается.
static func check_no_extra_keys(
	data: Dictionary, allowed: Array[String], context: String, problems: Array[String]
) -> bool:
	var ok: bool = true
	for key: Variant in data.keys():
		if not allowed.has(String(key)):
			problems.append(
				"%s: неизвестное поле «%s» (возможна опечатка)" % [context, String(key)]
			)
			ok = false
	return ok


# ------------------------------------------------------------- лицензии ----


static func check_license(value: Variant, context: String, problems: Array[String]) -> bool:
	if not check_non_empty_string(value, context + ".license", problems):
		problems.append(
			(
				"%s: лицензия обязательна — ассет без явной лицензии "
				+ "считать бесплатным нельзя" % context
			)
		)
		return false
	var license_name: String = String(value).strip_edges()
	if FORBIDDEN_LICENSES.has(license_name):
		problems.append(
			"%s: лицензия «%s» запрещена в проекте (несвободная)" % [context, license_name]
		)
		return false
	if not FREE_LICENSES.has(license_name):
		problems.append(
			(
				"%s: лицензия «%s» не в списке разрешённых; добавьте "
				+ "её осознанно в Validators.FREE_LICENSES" % [context, license_name]
			)
		)
		return false
	return true


## Требует указания автора, если лицензия этого требует.
static func check_attribution(entry: Dictionary, context: String, problems: Array[String]) -> bool:
	var license_name: String = str(entry.get("license", ""))
	if not ATTRIBUTION_LICENSES.has(license_name):
		return true
	var author: String = str(entry.get("author", "")).strip_edges()
	if author.is_empty() or author.to_lower() in ["unknown", "неизвестно", "n/a"]:
		problems.append(
			(
				"%s: лицензия «%s» требует указания автора, а поле "
				+ "author пусто или бессодержательно" % [context, license_name]
			)
		)
		return false
	return true


# -------------------------------------------------------------- геометрия --


static func check_normalized_direction(
	value: Vector3, field: String, problems: Array[String]
) -> bool:
	var length: float = value.length()
	if length < 0.0001:
		problems.append("%s: нулевой вектор не задаёт направление" % field)
		return false
	if absf(length - 1.0) > 0.02:
		problems.append("%s: вектор не нормализован (длина %.4f)" % [field, length])
		return false
	return true


static func check_finite_vector(value: Vector3, field: String, problems: Array[String]) -> bool:
	if (
		is_nan(value.x)
		or is_nan(value.y)
		or is_nan(value.z)
		or is_inf(value.x)
		or is_inf(value.y)
		or is_inf(value.z)
	):
		problems.append("%s: вектор содержит NaN/INF (%s)" % [field, str(value)])
		return false
	return true


## Треугольник невырожден, если его площадь больше эпсилон.
## Вырожденный треугольник ломает расчёт нормалей и нарезку меша:
## MeshDataTool на таких данных возвращает мусор без ошибки.
static func check_triangle_non_degenerate(
	a: Vector3, b: Vector3, c: Vector3, context: String, problems: Array[String]
) -> bool:
	var area: float = (b - a).cross(c - a).length() * 0.5
	if area < 0.000001:
		problems.append("%s: вырожденный треугольник (площадь %.8f)" % [context, area])
		return false
	return true


# ----------------------------------------------------------------- файлы ---


## Проверяет существование и размер файла ассета.
static func check_asset_file(
	path: String, field: String, problems: Array[String], max_bytes: int = MAX_MODEL_BYTES
) -> bool:
	if not ResourceLoader.exists(path) and not FileAccess.file_exists(path):
		problems.append("%s: файл «%s» не найден" % [field, path])
		return false
	var global_path: String = ProjectSettings.globalize_path(path)
	var size_bytes: int = 0
	if FileAccess.file_exists(global_path):
		size_bytes = FileAccess.get_file_as_bytes(global_path).size()
	if size_bytes > max_bytes:
		problems.append(
			(
				"%s: «%s» весит %.2f МБ при лимите %.2f МБ — пропустите "
				+ (
					"через tools/asset-pipeline (draco/meshopt/KTX)"
					% [field, path, float(size_bytes) / 1048576.0, float(max_bytes) / 1048576.0]
				)
			)
		)
		return false
	return true


## Сводная проверка записи об ассете из credits.json / ATTRIBUTION.md.
static func check_asset_entry(entry: Dictionary, index: int, problems: Array[String]) -> bool:
	var context: String = "used_assets[%d]" % index
	if typeof(entry) != TYPE_DICTIONARY:
		problems.append("%s: ожидался объект" % context)
		return false
	var ok: bool = check_dict_shape(
		entry,
		{
			"name": TYPE_STRING,
			"author": TYPE_STRING,
			"license": TYPE_STRING,
		},
		context,
		problems
	)
	ok = check_license(entry.get("license"), context, problems) and ok
	ok = check_attribution(entry, context, problems) and ok
	var url: String = str(entry.get("url", ""))
	if url.is_empty():
		problems.append("%s: url обязателен — по нему проверяют лицензию" % context)
		ok = false
	elif not url.begins_with("https://"):
		problems.append("%s: url «%s» должен быть https" % [context, url])
		ok = false
	return ok
