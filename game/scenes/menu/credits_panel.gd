extends PanelContainer
## CreditsPanel — авторы, контакты и атрибуция ассетов.
##
## ТРЕБОВАНИЕ ИЗ ТЗ: «меню с контактами». Реализовано не мёртвым текстом,
## а данными из game/data/credits.json:
##   * контакты кликабельны — почта копируется в буфер, ссылки открываются;
##   * раздел атрибуции перечисляет каждый сторонний ассет с лицензией;
##   * список одобренных источников — рабочий инструмент, а не справка:
##     он же продублирован в docs/04_ASSET_SOURCES.md.
##
## АТРИБУЦИЯ — ЮРИДИЧЕСКОЕ ТРЕБОВАНИЕ, а не вежливость. CC-BY без указания
## автора — нарушение лицензии. Поэтому запись в credits.json и в
## assets/ATTRIBUTION.md обязательна для любого несвободного ассета, и
## тест tests/unit/test_credits_data.gd это контролирует.

const CREDITS_PATH: String = "res://data/credits.json"

var _data: Dictionary = {}
var _scroll: ScrollContainer = null
var _status_label: Label = null


func _ready() -> void:
	_load_data()
	_build_layout()


func _load_data() -> void:
	if not FileAccess.file_exists(CREDITS_PATH):
		Diagnostics.error("credits", "нет файла " + CREDITS_PATH)
		return
	var text: String = FileAccess.get_file_as_string(CREDITS_PATH)
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		Diagnostics.error("credits", "credits.json не разобран")
		return
	_data = parsed
	Diagnostics.info(
		"credits", "загружено: %d контактов, %d ассетов" % [_contacts().size(), _assets().size()]
	)


func _contacts() -> Array:
	return _data.get("contacts", [])


func _assets() -> Array:
	return _data.get("used_assets", [])


func _roles() -> Array:
	return _data.get("roles", [])


func _sources() -> Array:
	return _data.get("asset_sources_approved", [])


func _build_layout() -> void:
	var root := VBoxContainer.new()
	root.add_theme_constant_override("separation", 10)
	add_child(root)

	var header := HBoxContainer.new()
	var title := Label.new()
	title.text = "Авторы и контакты"
	title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	header.add_child(title)
	var close_button := Button.new()
	close_button.text = "✕"
	close_button.flat = true
	close_button.pressed.connect(_on_close_pressed)
	header.add_child(close_button)
	root.add_child(header)

	_scroll = ScrollContainer.new()
	_scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	root.add_child(_scroll)

	var content := VBoxContainer.new()
	content.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	content.add_theme_constant_override("separation", 18)
	_scroll.add_child(content)

	_build_about(content)
	_build_contacts(content)
	_build_roles(content)
	_build_assets(content)
	_build_sources(content)

	_status_label = Label.new()
	_status_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	root.add_child(_status_label)


func _add_section(parent: Control, heading: String) -> VBoxContainer:
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 4)
	var label := Label.new()
	label.text = heading
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT
	box.add_child(label)
	parent.add_child(box)
	return box


func _build_about(parent: Control) -> void:
	var game: Dictionary = _data.get("game", {})
	var box := _add_section(parent, "Об игре")
	var text := RichTextLabel.new()
	text.bbcode_enabled = true
	text.fit_content = true
	text.text = (
		"%s\n%s\n\nДвижок: %s (%s)"
		% [
			str(game.get("title", "NEWwoorld")),
			str(game.get("tagline", "")),
			str(game.get("engine", "Godot Engine")),
			str(game.get("engine_license", "MIT")),
		]
	)
	box.add_child(text)


func _build_contacts(parent: Control) -> void:
	var box := _add_section(parent, "Контакты")
	for entry: Variant in _contacts():
		if typeof(entry) != TYPE_DICTIONARY:
			continue
		var contact: Dictionary = entry
		var value: String = str(contact.get("value", ""))
		if value.is_empty() and bool(contact.get("optional", false)):
			# Пустой необязательный контакт не показываем: строка
			# «Сообщество: » выглядит как недоделка.
			continue
		box.add_child(_make_contact_row(contact))


func _make_contact_row(contact: Dictionary) -> HBoxContainer:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 10)

	var label := Label.new()
	label.text = str(contact.get("label", ""))
	label.custom_minimum_size.x = 190.0
	row.add_child(label)

	var value: String = str(contact.get("value", ""))
	var kind: String = str(contact.get("kind", "text"))
	var openable: bool = bool(contact.get("openable", false)) and kind == "url"
	var copyable: bool = bool(contact.get("copyable", false))

	if openable:
		row.add_child(_make_link(value, value))
	else:
		var text := Label.new()
		text.text = value
		text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		row.add_child(text)

	if copyable or openable:
		var button := Button.new()
		button.text = "Открыть" if openable else "Копировать"
		button.pressed.connect(_on_contact_action.bind(value, openable))
		row.add_child(button)

	var note: String = str(contact.get("note", ""))
	if not note.is_empty():
		# Примечание показываем в тултипе, а не отдельной строкой: иначе
		# панель контактов раздувается до размеров документации.
		row.tooltip_text = note
	return row


## Делает кликабельную ссылку.
##
## ВАЖНО: в Godot НЕТ класса LinkLabel — он есть в Qt и в HTML, и его
## отсутствие легко «вспомнить» по аналогии. Ссылка в Godot делается либо
## RichTextLabel с bbcode [url], либо обычной кнопкой. Кнопка здесь
## предпочтительнее: она входит в фокусную цепочку, то есть ссылку можно
## открыть геймпадом, а мету RichTextLabel — только мышью.
func _make_link(text: String, url: String) -> Button:
	var link := Button.new()
	link.text = text
	link.flat = true
	link.tooltip_text = url
	link.alignment = HORIZONTAL_ALIGNMENT_LEFT
	link.pressed.connect(_open_url.bind(url))
	return link


## Открывает внешний URL. Возвращает успех — вызывающий код показывает
## результат в статусной строке, потому что браузер может быть не настроен.
func _open_url(url: String) -> bool:
	if url.is_empty():
		return false
	var err: int = OS.shell_open(url)
	if err != OK:
		Diagnostics.warn("credits", "не удалось открыть " + url)
		_set_status("Ссылку не открыть: %s" % url)
		return false
	_set_status("Открываю " + url)
	return true


func _on_contact_action(value: String, open_url: bool) -> void:
	if value.is_empty():
		return
	if open_url:
		var err: int = OS.shell_open(value)
		_set_status("Открываю " + value if err == OK else "Не удалось открыть ссылку")
		return
	DisplayServer.clipboard_set(value)
	_set_status("Скопировано в буфер обмена")


func _build_roles(parent: Control) -> void:
	var roles: Array = _roles()
	if roles.is_empty():
		return
	var box := _add_section(parent, "Команда")
	for entry: Variant in roles:
		if typeof(entry) != TYPE_DICTIONARY:
			continue
		var role: Dictionary = entry
		var people: Array = role.get("people", [])
		var label := Label.new()
		label.text = "%s — %s" % [str(role.get("role", "")), _join_people(people)]
		label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		box.add_child(label)


## Список имён в строку. Отдельная функция вместо str().join() по сырому
## массиву: JSON отдаёт Variant'ы, и join на них падает.
func _join_people(people: Array) -> String:
	var names: Array[String] = []
	for person: Variant in people:
		names.append(str(person))
	return ", ".join(names)


func _build_assets(parent: Control) -> void:
	var assets: Array = _assets()
	if assets.is_empty():
		return
	var box := _add_section(parent, "Сторонние компоненты и ассеты")
	for entry: Variant in assets:
		if typeof(entry) != TYPE_DICTIONARY:
			continue
		var asset: Dictionary = entry
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 8)
		var name_label := Label.new()
		name_label.text = str(asset.get("name", ""))
		name_label.custom_minimum_size.x = 210.0
		row.add_child(name_label)
		var license_label := Label.new()
		license_label.text = str(asset.get("license", "—"))
		license_label.custom_minimum_size.x = 110.0
		row.add_child(license_label)
		var author_label := Label.new()
		author_label.text = str(asset.get("author", ""))
		author_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		row.add_child(author_label)
		var url: String = str(asset.get("url", ""))
		if not url.is_empty():
			row.add_child(_make_link("ссылка", url))
		row.tooltip_text = (
			"Атрибуция %s"
			% (
				"обязательна"
				if bool(asset.get("attribution_required", false))
				else "не обязательна, но указана"
			)
		)
		box.add_child(row)


func _build_sources(parent: Control) -> void:
	var sources: Array = _sources()
	if sources.is_empty():
		return
	var box := _add_section(parent, "Откуда брать бесплатные ассеты")
	for entry: Variant in sources:
		if typeof(entry) != TYPE_DICTIONARY:
			continue
		var source: Dictionary = entry
		var label := Label.new()
		label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		label.text = (
			"%s — %s. %s"
			% [
				str(source.get("name", "")),
				str(source.get("license", "")),
				str(source.get("notes", ""))
			]
		)
		box.add_child(label)
		var url: String = str(source.get("url", ""))
		if not url.is_empty():
			box.add_child(_make_link(url, url))


func panel_opened() -> void:
	_set_status("")


func panel_closed() -> void:
	_set_status("")


func _set_status(text: String) -> void:
	if _status_label != null:
		_status_label.text = text


func _on_close_pressed() -> void:
	var parent: Node = get_parent()
	while parent != null:
		if parent.has_method("close_panel"):
			parent.call("close_panel")
			return
		parent = parent.get_parent()
	visible = false
