extends PanelContainer
## SettingsPanel — панель настроек поверх главного меню.
##
## Вкладки соответствуют секциям SettingsSchema. Содержимое вкладки —
## SettingsForm, построенный из схемы, поэтому «добавить настройку» не
## требует правки этой сцены вообще.
##
## ПОВЕДЕНИЕ, которое игроки проверяют в первую очередь:
##   * изменение применяется СРАЗУ (видно эффект, а не «сохраните и
##     перезапустите»),
##   * «Применить» фиксирует на диск, «Отмена» откатывает к состоянию
##     на момент открытия панели,
##   * «Сбросить» возвращает дефолты схемы, а не какие-то захардкоженные
##     значения в коде панели.

const TAB_CONTAINER_NAME: String = "Tabs"

var _forms: Dictionary = {}
var _tabs: TabContainer = null
var _snapshot_on_open: Dictionary = {}
var _status_label: Label = null


func _ready() -> void:
	_build_layout()
	EventBus.quality_preset_changed.connect(_on_quality_preset_changed)


func _build_layout() -> void:
	var root := VBoxContainer.new()
	root.name = "Root"
	root.add_theme_constant_override("separation", 12)
	add_child(root)

	var header := HBoxContainer.new()
	var title := Label.new()
	title.text = "Настройки"
	title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	header.add_child(title)
	var close_button := Button.new()
	close_button.text = "✕"
	close_button.flat = true
	close_button.focus_mode = Control.FOCUS_ALL
	close_button.pressed.connect(_on_close_pressed)
	header.add_child(close_button)
	root.add_child(header)

	_tabs = TabContainer.new()
	_tabs.name = TAB_CONTAINER_NAME
	_tabs.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_tabs.tab_alignment = HorizontalAlignment.HORIZONTAL_ALIGNMENT_LEFT
	root.add_child(_tabs)

	for section: String in SettingsSchema.SECTIONS:
		var scroll := ScrollContainer.new()
		scroll.name = _section_title(section)
		scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
		scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
		var form := SettingsForm.new()
		form.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		scroll.add_child(form)
		_tabs.add_child(scroll)
		form.build(section)
		_forms[section] = form

	var footer := HBoxContainer.new()
	footer.add_theme_constant_override("separation", 10)
	var reset_button := Button.new()
	reset_button.text = "Сбросить"
	reset_button.pressed.connect(_on_reset_pressed)
	footer.add_child(reset_button)

	_status_label = Label.new()
	_status_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_status_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	footer.add_child(_status_label)

	var cancel_button := Button.new()
	cancel_button.text = "Отмена"
	cancel_button.pressed.connect(_on_cancel_pressed)
	footer.add_child(cancel_button)

	var apply_button := Button.new()
	apply_button.text = "Применить"
	apply_button.pressed.connect(_on_apply_pressed)
	footer.add_child(apply_button)
	root.add_child(footer)


func _section_title(section: String) -> String:
	match section:
		SettingsSchema.SECTION_VIDEO:
			return "Графика"
		SettingsSchema.SECTION_AUDIO:
			return "Звук"
		SettingsSchema.SECTION_INPUT:
			return "Управление"
		SettingsSchema.SECTION_GAMEPLAY:
			return "Игра"
		SettingsSchema.SECTION_ACCESSIBILITY:
			return "Доступность"
	return section


## Вызывается MainMenu при открытии панели.
## Снимок состояния делается ИМЕННО здесь: «Отмена» обязана возвращать
## настройки к моменту открытия панели, а не к дефолтам.
func panel_opened() -> void:
	_snapshot_on_open = SettingsService.snapshot()
	for section: String in _forms.keys():
		_forms[section].refresh()
	_set_status("")
	_tabs.current_tab = 0


## Вызывается MainMenu при закрытии панели.
func panel_closed() -> void:
	_snapshot_on_open = {}


func _on_apply_pressed() -> void:
	var ok: bool = SettingsService.save_to_disk()
	_set_status("Сохранено" if ok else "Не удалось сохранить")
	# Тема пересобирается, если игрок сменил масштаб шрифта.
	ThemeService.rebuild_if_needed()
	for section: String in _forms.keys():
		_forms[section].refresh()


func _on_cancel_pressed() -> void:
	if not _snapshot_on_open.is_empty():
		SettingsService.set_many(_snapshot_on_open)
		for section: String in _forms.keys():
			_forms[section].refresh()
	_set_status("Изменения отменены")
	_on_close_pressed()


func _on_reset_pressed() -> void:
	SettingsService.reset_section("")
	for section: String in _forms.keys():
		_forms[section].refresh()
	ThemeService.rebuild_if_needed()
	_set_status("Восстановлены значения по умолчанию")


func _on_close_pressed() -> void:
	var parent: Node = get_parent()
	while parent != null:
		if parent.has_method("close_panel"):
			parent.call("close_panel")
			return
		parent = parent.get_parent()
	# Меню может быть не в родителях (панель открыли из паузы) — тогда
	# закрываемся сами.
	visible = false


func _on_quality_preset_changed(_preset_index: int) -> void:
	# Пресет переопределил MSAA/масштаб/TAA — формы обязаны показать новые
	# значения, иначе игрок видит одно, а движок применяет другое.
	for section: String in _forms.keys():
		_forms[section].refresh()


func _set_status(text: String) -> void:
	if _status_label != null:
		_status_label.text = text
