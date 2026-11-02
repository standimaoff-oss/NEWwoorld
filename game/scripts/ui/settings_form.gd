class_name SettingsForm
extends VBoxContainer
## SettingsForm — строит UI настроек ИЗ СХЕМЫ, а не руками.
##
## ГЛАВНОЕ СВОЙСТВО: добавили настройку в SettingsSchema.SCHEMA — и она
## сама появилась в меню, сама сохранилась в файл, сама прошла валидацию
## и сама попала в тесты. Править этот файл при этом не нужно.
##
## Противоположный подход (каждая опция нарисована в сцене руками) даёт
## ровно тот баг, который игроки описывают как «половина настроек не
## работает»: сцена есть, сохранение есть, а применение к движку забыли.
## Здесь применить настройку негде кроме SettingsService._apply_key().
##
## ТИПЫ ВИДЖЕТОВ:
##   BOOL  -> CheckBox
##   ENUM  -> OptionButton (подписи из schema.options)
##   INT   -> HSlider + значение числом (шаг из schema.step)
##   FLOAT -> HSlider + значение в процентах/единицах
##   STRING-> LineEdit
##
## Доступность: у каждого виджета есть label, hint-текст и фокус.
## Подсказка (schema.hint) показывается под строкой — игрок понимает,
## ЧТО именно делает опция, а не гадает по названию.

signal setting_edited(key: String, value: Variant)

## Единицы измерения для подписей значений. Разные настройки требуют
## разных единиц: «75%» для громкости, «144» для FPS, «75°» для FOV.
## Показывать всё одинаково — значит заставить игрока считать в уме.
##
## Таблица вместо цепочки return: линтер ограничивает число return в
## функции шестью, а главное — так формат сразу видно весь целиком.
const VALUE_FORMATS: Dictionary = {
	"video/max_fps": "fps",
	"video/scaling_scale": "percent",
	"accessibility/fov": "degrees",
	"accessibility/font_scale": "percent",
	"accessibility/screen_shake": "percent",
	"input/mouse_sensitivity": "float2",
	"input/gamepad_deadzone": "float2",
}

## Ключи, у которых значение 0 означает «особый случай».
const ZERO_SPECIALS: Dictionary = {"video/max_fps": "без лимита"}

## Ключи виджетов -> сами виджеты. Нужны, чтобы программно обновить
## значение (например, пресет качества переопределил ручные настройки).
var _widgets: Dictionary = {}
var _hint_labels: Dictionary = {}
var _section: String = ""
var _suppress_events: bool = false


## Строит форму для секции. Пустая секция = все настройки одним списком.
func build(section: String = "") -> void:
	_section = section
	_clear_children()
	var keys: Array[String] = (
		SettingsSchema.all_keys() if section.is_empty() else SettingsSchema.keys_in_section(section)
	)
	for key: String in keys:
		_build_row(key)


## Обновляет значения всех виджетов из SettingsService.
## Вызывается при открытии панели и когда пресет переопределил ручные правки.
func refresh() -> void:
	_suppress_events = true
	for key: String in _widgets.keys():
		_apply_value_to_widget(key, SettingsService.get_value(key))
	_suppress_events = false


## Ключи, которые форма сейчас отображает. Нужно тестам.
func displayed_keys() -> Array[String]:
	var out: Array[String] = []
	for key: String in _widgets.keys():
		out.append(key)
	out.sort()
	return out


func _clear_children() -> void:
	for child: Node in get_children():
		remove_child(child)
		child.queue_free()
	_widgets.clear()
	_hint_labels.clear()


# ------------------------------------------------------------------ строки --


func _build_row(key: String) -> void:
	var meta: Dictionary = SettingsSchema.describe(key)
	if meta.is_empty():
		Diagnostics.error("settings_form", "нет описания для ключа " + key)
		return

	var row := VBoxContainer.new()
	row.name = _row_name(key)
	row.add_theme_constant_override("separation", 2)

	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 10)

	var label := Label.new()
	label.text = str(meta["label"])
	label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	label.mouse_filter = Control.MOUSE_FILTER_PASS
	header.add_child(label)

	var widget: Control = _create_widget(key, meta)
	if widget == null:
		Diagnostics.error("settings_form", "не удалось создать виджет для " + key)
		row.free()
		return
	widget.size_flags_horizontal = Control.SIZE_SHRINK_END
	# Виджет в фокусной цепочке обязателен: без focus_mode меню невозможно
	# пройти геймпадом.Godot по умолчанию ставит FOCUS_ALL интерактивным
	# контролам, но подписи-Label фокус перехватывать не должны.
	header.add_child(widget)

	row.add_child(header)

	var value_label := Label.new()
	value_label.name = "ValueLabel"
	value_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	value_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	if widget is HSlider:
		# Числовое значение рядом с ползунком: без него игрок видит полосу,
		# но не понимает, какое именно число выбрал.
		header.add_child(value_label)
		_widgets[key] = {"control": widget, "value_label": value_label}
	else:
		_widgets[key] = {"control": widget, "value_label": null}

	var hint := str(meta.get("hint", ""))
	if not hint.is_empty():
		var hint_label := Label.new()
		hint_label.text = hint
		hint_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		hint_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		row.add_child(hint_label)
		_hint_labels[key] = hint_label

	add_child(row)
	_apply_value_to_widget(key, SettingsService.get_value(key))
	_style_row(row, widget)


func _row_name(key: String) -> String:
	# "video/msaa_3d" -> "Row_video_msaa_3d": имя ноды не может содержать "/".
	return "Row_" + key.replace("/", "_")


func _style_row(_row: Control, widget: Control) -> void:
	# Минимальная высота строки: клик по подписи должен попадать в виджет.
	# Строки «впритык» к тексту — частая причина промахов мышью.
	widget.custom_minimum_size.y = maxf(widget.custom_minimum_size.y, 30.0)


# ----------------------------------------------------------------- виджеты --


func _create_widget(key: String, meta: Dictionary) -> Control:
	match int(meta["type"]):
		SettingsSchema.SettingType.BOOL:
			return _create_check(key)
		SettingsSchema.SettingType.ENUM:
			return _create_option(key, meta)
		SettingsSchema.SettingType.INT:
			return _create_slider(key, meta, true)
		SettingsSchema.SettingType.FLOAT:
			return _create_slider(key, meta, false)
		SettingsSchema.SettingType.STRING:
			return _create_line_edit(key)
	Diagnostics.error("settings_form", "неизвестный тип настройки для " + key)
	return null


func _create_check(key: String) -> CheckBox:
	var widget := CheckBox.new()
	widget.toggled.connect(_on_bool_changed.bind(key))
	return widget


func _create_option(key: String, meta: Dictionary) -> OptionButton:
	var widget := OptionButton.new()
	var options: Array = meta.get("options", [])
	for option_text: Variant in options:
		widget.add_item(str(option_text))
	widget.item_selected.connect(_on_enum_changed.bind(key))
	widget.custom_minimum_size.x = 200.0
	return widget


func _create_slider(key: String, meta: Dictionary, integer: bool) -> HSlider:
	var widget := HSlider.new()
	widget.min_value = float(meta.get("min", 0.0))
	widget.max_value = float(meta.get("max", 1.0))
	widget.step = float(meta.get("step", 1.0 if integer else 0.01))
	widget.custom_minimum_size.x = 240.0
	widget.tick_count = _tick_count(widget.min_value, widget.max_value, widget.step)
	widget.value_changed.connect(_on_slider_changed.bind(key, integer))
	return widget


func _create_line_edit(key: String) -> LineEdit:
	var widget := LineEdit.new()
	widget.custom_minimum_size.x = 200.0
	widget.text_changed.connect(_on_text_changed.bind(key))
	return widget


## Число рисок на ползунке. Ограничено сверху: 500 рисок при шаге 0.01
## превращают ползунок в кашу и стоят лишних draw call'ов.
func _tick_count(min_value: float, max_value: float, step_value: float) -> int:
	if step_value <= 0.0:
		return 0
	var count: int = int(round((max_value - min_value) / step_value)) + 1
	return clampi(count, 0, 21)


# ---------------------------------------------------------------- значения --


func _apply_value_to_widget(key: String, value: Variant) -> void:
	if not _widgets.has(key):
		return
	var entry: Dictionary = _widgets[key]
	var widget: Control = entry["control"]
	var value_label: Label = entry["value_label"]

	if widget is CheckBox:
		(widget as CheckBox).set_pressed_no_signal(bool(value))
	elif widget is OptionButton:
		(widget as OptionButton).select(
			clampi(int(value), 0, (widget as OptionButton).item_count - 1)
		)
	elif widget is HSlider:
		(widget as HSlider).set_value_no_signal(float(value))
		if value_label != null:
			value_label.text = _format_value(key, value)
	elif widget is LineEdit:
		(widget as LineEdit).text = str(value)


func _format_value(key: String, value: Variant) -> String:
	var special: String = str(ZERO_SPECIALS.get(key, ""))
	if not special.is_empty() and int(value) == 0:
		return special
	var kind: String = str(VALUE_FORMATS.get(key, "percent" if key.contains("volume") else "raw"))
	return _format_by_kind(kind, value)


func _format_by_kind(kind: String, value: Variant) -> String:
	var number: float = float(value)
	match kind:
		"percent":
			return "%d%%" % int(round(number * 100.0))
		"degrees":
			return "%d°" % int(number)
		"fps":
			return "%d FPS" % int(number)
		"float2":
			return "%.2f" % number
	return str(value)


# ----------------------------------------------------------------- события --


func _on_bool_changed(pressed: bool, key: String) -> void:
	_commit(key, pressed)


func _on_enum_changed(index: int, key: String) -> void:
	_commit(key, index)


func _on_slider_changed(value: float, key: String, integer: bool) -> void:
	_commit(key, int(round(value)) if integer else value)


func _on_text_changed(text: String, key: String) -> void:
	_commit(key, text)


func _commit(key: String, value: Variant) -> void:
	if _suppress_events:
		return
	var changed: bool = SettingsService.set_value(key, value)
	if changed:
		setting_edited.emit(key, SettingsService.get_value(key))
	# Значение могло быть приведено к границам схемы, поэтому читаем его
	# обратно из сервиса, а не берём то, что прислал виджет.
	_apply_value_to_widget(key, SettingsService.get_value(key))


## Текущая секция формы — нужна вкладкам настроек.
func section() -> String:
	return _section
