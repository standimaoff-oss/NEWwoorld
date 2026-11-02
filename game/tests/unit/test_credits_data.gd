extends GutTest
## Тесты game/data/credits.json.
##
## ТЗ требует: меню с контактами и сторонние ассеты ТОЛЬКО свободные либо
## с указанной атрибуцией. Это не оформление, а юридическое требование —
## CC-BY без указания автора является нарушением лицензии.
##
## Данные лежат в JSON, а не в коде, чтобы их можно было править без
## перекомпиляции и показывать в меню. Цена — отсутствие проверки типов,
## поэтому проверка вынесена сюда.

const CREDITS_PATH: String = "res://data/credits.json"

var _data: Dictionary = {}


func before_all() -> void:
	assert_file_exists(CREDITS_PATH, "нет файла контактов и атрибуции")
	var text: String = FileAccess.get_file_as_string(CREDITS_PATH)
	var parsed: Variant = JSON.parse_string(text)
	assert_typeof(
		parsed, TYPE_DICTIONARY, "credits.json не является объектом — проверьте синтаксис JSON"
	)
	if typeof(parsed) == TYPE_DICTIONARY:
		_data = parsed


func test_top_level_sections_exist() -> void:
	for section: String in ["game", "contacts", "roles", "used_assets", "asset_sources_approved"]:
		assert_has(_data, section, "нет раздела «%s»" % section)


func test_game_section_is_complete() -> void:
	var game: Dictionary = _data.get("game", {})
	for field: String in ["title", "engine", "engine_license"]:
		assert_has(game, field, "game: нет поля «%s»" % field)
	# Godot распространяется под MIT — указывать это обязательно, раз мы
	# требуем того же от чужих ассетов.
	assert_string_contains(str(game.get("engine_license", "")).to_lower(), "mit")


func test_contacts_have_required_fields() -> void:
	var contacts: Array = _data.get("contacts", [])
	assert_gt(contacts.size(), 0, "меню без контактов не выполняет требование ТЗ")
	for index in range(contacts.size()):
		var contact: Dictionary = contacts[index]
		var context: String = "contacts[%d]" % index
		assert_has(contact, "label", context + ": нет label")
		assert_has(contact, "kind", context + ": нет kind")
		assert_has(contact, "value", context + ": нет value")
		if bool(contact.get("optional", false)):
			continue
		assert_ne(
			str(contact.get("value", "")).strip_edges(),
			"",
			context + ": обязательный контакт без значения"
		)


func test_contact_kinds_are_known() -> void:
	var known: Array[String] = ["email", "url", "text", "repo", "chat"]
	for index in range(_data.get("contacts", []).size()):
		var contact: Dictionary = _data["contacts"][index]
		var kind: String = str(contact.get("kind", ""))
		assert_has(
			known,
			kind,
			"contacts[%d]: неизвестный kind «%s» — меню не поймёт, как его открыть" % [index, kind]
		)


func test_url_contacts_are_https() -> void:
	for index in range(_data.get("contacts", []).size()):
		var contact: Dictionary = _data["contacts"][index]
		if str(contact.get("kind", "")) != "url":
			continue
		var value: String = str(contact.get("value", ""))
		if value.is_empty():
			continue
		assert_true(
			value.begins_with("https://"), "contacts[%d]: «%s» должен быть https" % [index, value]
		)


func test_at_least_one_contact_is_reachable_channel() -> void:
	# «Контакты» должны давать способ написать. Адрес репозитория или почта
	# обязательны: контакт только через форму на сайте неработоспособен.
	var has_channel: bool = false
	for entry: Variant in _data.get("contacts", []):
		var contact: Dictionary = entry
		if (
			str(contact.get("kind", "")) in ["email", "repo"]
			and not str(contact.get("value", "")).is_empty()
		):
			has_channel = true
	assert_true(has_channel, "нет ни почты, ни репозитория среди контактов")


func test_every_used_asset_passes_license_check() -> void:
	var assets: Array = _data.get("used_assets", [])
	assert_gt(assets.size(), 0, "раздел атрибуции пуст")
	var problems: Array[String] = []
	for index in range(assets.size()):
		Validators.check_asset_entry(assets[index], index, problems)
	assert_eq(problems.size(), 0, "\n".join(problems))


func test_every_asset_records_a_license() -> void:
	# Отсутствие поля license — самая частая ошибка: ассет «взяли с форума»,
	# а условия не переписали. Проверяем отдельно от общей валидации, чтобы
	# сообщение было однозначным.
	for index in range(_data.get("used_assets", []).size()):
		var asset: Dictionary = _data["used_assets"][index]
		assert_has(
			asset,
			"license",
			"used_assets[%d] «%s»: нет лицензии" % [index, str(asset.get("name", "?"))]
		)
		assert_ne(
			str(asset.get("license", "")).strip_edges(),
			"",
			"used_assets[%d]: пустая лицензия" % index
		)


func test_no_asset_uses_forbidden_license() -> void:
	for index in range(_data.get("used_assets", []).size()):
		var asset: Dictionary = _data["used_assets"][index]
		var license_name: String = str(asset.get("license", ""))
		assert_does_not_have(
			Validators.FORBIDDEN_LICENSES,
			license_name,
			(
				"used_assets[%d] «%s»: лицензия «%s» запрещена в проекте"
				% [index, str(asset.get("name", "?")), license_name]
			)
		)


func test_attribution_present_where_required() -> void:
	for index in range(_data.get("used_assets", []).size()):
		var asset: Dictionary = _data["used_assets"][index]
		var problems: Array[String] = []
		Validators.check_attribution(asset, "used_assets[%d]" % index, problems)
		assert_eq(problems.size(), 0, "; ".join(problems))


func test_approved_sources_declare_licenses() -> void:
	# Список источников — рабочий инструмент: по нему ассеты ищут дальше.
	# Источник без указания лицензии бесполезен и опасен.
	var sources: Array = _data.get("asset_sources_approved", [])
	assert_gt(sources.size(), 0, "нет одобренных источников ассетов")
	for index in range(sources.size()):
		var source: Dictionary = sources[index]
		var context: String = "asset_sources_approved[%d]" % index
		assert_has(source, "name", context + ": нет name")
		assert_has(source, "license", context + ": нет license")
		assert_ne(str(source.get("license", "")).strip_edges(), "", context + ": пустая license")


func test_sources_urls_are_https() -> void:
	for index in range(_data.get("asset_sources_approved", []).size()):
		var source: Dictionary = _data["asset_sources_approved"][index]
		var url: String = str(source.get("url", ""))
		if url.is_empty():
			continue
		assert_true(
			url.begins_with("https://"), "asset_sources_approved[%d]: «%s» не https" % [index, url]
		)


func test_attribution_file_exists_and_matches_data() -> void:
	# Атрибуция обязана быть не только в меню, но и в поставке: меню может
	# не открыться, а требование лицензии действует всегда.
	var attribution_path: String = "res://assets/ATTRIBUTION.md"
	if not FileAccess.file_exists(attribution_path):
		pending("нет res://assets/ATTRIBUTION.md — создайте при первом ассете")
		return
	var text: String = FileAccess.get_file_as_string(attribution_path)
	for entry: Variant in _data.get("used_assets", []):
		var asset: Dictionary = entry
		var asset_name: String = str(asset.get("name", ""))
		if asset_name.is_empty():
			continue
		assert_string_contains(text, asset_name, "ATTRIBUTION.md не упоминает «%s»" % asset_name)
