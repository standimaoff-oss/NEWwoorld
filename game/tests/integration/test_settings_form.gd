extends GutTest
## Интеграционные тесты формы настроек.
##
## ПРОВЕРЯЕТСЯ СВЯЗКА «схема -> интерфейс -> сервис», а не каждый элемент
## по отдельности. Именно в связках живут баги вида «настройка есть в меню,
## но не сохраняется» и «сохраняется, но не применяется».
##
## Главное свойство, которое фиксирует этот файл: добавление настройки в
## SettingsSchema.SCHEMA автоматически появляется в UI. Если кто-то решит
## рисовать опции руками, тест на число строк упадёт.

var _form: SettingsForm = null


func before_each() -> void:
	_form = SettingsForm.new()
	add_child_autofree(_form)


func test_form_builds_all_sections() -> void:
	for section: String in SettingsSchema.SECTIONS:
		var form := SettingsForm.new()
		add_child_autofree(form)
		form.build(section)
		assert_eq(
			form.displayed_keys().size(),
			SettingsSchema.keys_in_section(section).size(),
			"секция «%s»: форма показала не все настройки" % section
		)


func test_every_schema_key_gets_a_widget() -> void:
	_form.build("")
	var displayed: Array[String] = _form.displayed_keys()
	var expected: Array[String] = SettingsSchema.all_keys()
	expected.sort()
	assert_eq_deep(displayed, expected, "форма без секции должна показать ВСЕ настройки схемы")


func test_widget_type_matches_setting_type() -> void:
	# Тип виджета обязан соответствовать типу настройки. String-настройка
	# в виде ползунка — это не «некрасиво», а неработающая опция.
	_form.build("")
	for key: String in _form.displayed_keys():
		var setting_type: int = int(SettingsSchema.describe(key)["type"])
		var widget: Control = _widget_for(key)
		if widget == null:
			fail_test("для «%s» не создан виджет" % key)
			continue
		assert_true(
			_type_matches_widget(setting_type, widget),
			"«%s»: тип %d отображён виджетом %s" % [key, setting_type, widget.get_class()]
		)


func test_widget_values_match_service_before_edit() -> void:
	_form.build("")
	for key: String in _form.displayed_keys():
		var widget: Control = _widget_for(key)
		if widget == null:
			continue
		var service_value: Variant = SettingsService.get_value(key)
		assert_eq(
			str(_widget_value(widget)),
			str(service_value),
			"«%s»: виджет показывает не то, что хранит сервис" % key
		)


func test_editing_a_checkbox_updates_the_service() -> void:
	# Ключевой сценарий: игрок щёлкнул — значение изменилось в сервисе.
	# Без этого настройка существует в меню, но ничего не делает.
	var key: String = _first_key_of_type(SettingsSchema.SettingType.BOOL)
	if key.is_empty():
		pending("в схеме нет bool-настроек")
		return
	var snapshot: Dictionary = SettingsService.snapshot()
	_form.build(SettingsSchema.describe(key)["section"])
	var widget: Control = _widget_for(key)
	if widget == null or not (widget is CheckBox):
		SettingsService.set_many(snapshot, false)
		fail_test("для «%s» не создан CheckBox" % key)
		return
	var original: bool = SettingsService.get_bool(key)
	(widget as CheckBox).button_pressed = not original
	assert_eq(
		SettingsService.get_bool(key), not original, "«%s»: переключение не дошло до сервиса" % key
	)
	SettingsService.set_many(snapshot, false)


func test_editing_a_slider_updates_the_service() -> void:
	var key: String = _first_key_of_type(SettingsSchema.SettingType.FLOAT)
	if key.is_empty():
		pending("в схеме нет float-настроек")
		return
	var snapshot: Dictionary = SettingsService.snapshot()
	var meta: Dictionary = SettingsSchema.describe(key)
	_form.build(str(meta["section"]))
	var widget: Control = _widget_for(key)
	if widget == null or not (widget is HSlider):
		SettingsService.set_many(snapshot, false)
		fail_test("для «%s» не создан HSlider" % key)
		return
	var target: float = (float(meta["min"]) + float(meta["max"])) * 0.5
	(widget as HSlider).value = target
	var stored: float = SettingsService.get_float(key)
	assert_almost_eq(
		stored,
		target,
		float(meta.get("step", 0.01)) + 0.001,
		"«%s»: ползунок записал %s вместо %s" % [key, str(stored), str(target)]
	)
	SettingsService.set_many(snapshot, false)


func test_refresh_pulls_values_from_service() -> void:
	# Пресет качества переопределяет ручные настройки. Формы обязаны
	# показать НОВЫЕ значения, иначе игрок видит одно, а движок применяет
	# другое — это одна из самых раздражающих ошибок в меню настроек.
	var key: String = _first_key_of_type(SettingsSchema.SettingType.FLOAT)
	if key.is_empty():
		pending("в схеме нет float-настроек")
		return
	var snapshot: Dictionary = SettingsService.snapshot()
	var meta: Dictionary = SettingsSchema.describe(key)
	_form.build(str(meta["section"]))
	SettingsService.set_value(key, float(meta["max"]), false)
	_form.refresh()
	var widget: Control = _widget_for(key)
	if widget is HSlider:
		assert_almost_eq(
			(widget as HSlider).value,
			float(meta["max"]),
			0.0001,
			"refresh() не подтянул значение из сервиса"
		)
	SettingsService.set_many(snapshot, false)


func test_every_row_has_a_label() -> void:
	# Строка без подписи — это элемент интерфейса без объяснения. Игрок
	# будет двигать ползунок наугад.
	_form.build("")
	var rows: int = 0
	for child: Node in _form.get_children():
		if not String(child.name).begins_with("Row_"):
			continue
		rows += 1
		assert_true(_row_has_label(child), "у строки «%s» нет подписи" % str(child.name))
	assert_eq(rows, SettingsSchema.all_keys().size(), "число строк не совпадает с числом настроек")


func test_labels_are_not_empty() -> void:
	_form.build("")
	for child: Node in _form.get_children():
		if not String(child.name).begins_with("Row_"):
			continue
		for label: Label in _labels_of(child):
			if label == _hint_label_of(child):
				continue
			assert_ne(label.text.strip_edges(), "", "пустая подпись в строке " + str(child.name))


func test_row_names_escape_slashes() -> void:
	# Имя узла не может содержать «/»: ключ «video/msaa_3d» обязан стать
	# «Row_video_msaa_3d». Без замены поиск строки по ключу сломается.
	_form.build("")
	for child: Node in _form.get_children():
		assert_false(String(child.name).contains("/"), "имя узла содержит «/»: " + str(child.name))


func test_widgets_are_focusable() -> void:
	# Меню настроек обязано проходиться геймпадом. Виджет без фокуса
	# недоступен: игрок видит настройку, но не может её изменить.
	_form.build("")
	for key: String in _form.displayed_keys():
		var widget: Control = _widget_for(key)
		if widget == null:
			continue
		assert_ne(
			int(widget.focus_mode), int(Control.FOCUS_NONE), "«%s»: виджет не получает фокус" % key
		)


func test_sliders_have_ticks_within_limits() -> void:
	# Число рисок не должно превращать ползунок в кашу и не должно стоить
	# лишних отрисовок.
	_form.build("")
	for key: String in _form.displayed_keys():
		var widget: Control = _widget_for(key)
		if not (widget is HSlider):
			continue
		var slider := widget as HSlider
		assert_between(
			slider.tick_count, 0, 21, "«%s»: %d рисок на ползунке" % [key, slider.tick_count]
		)
		assert_lt(slider.min_value, slider.max_value, "«%s»: min не меньше max" % key)
		assert_between(slider.value, slider.min_value, slider.max_value, key)


# ------------------------------------------------------------- помощники ----


func _widget_for(key: String) -> Control:
	var row_name: String = "Row_" + key.replace("/", "_")
	var row: Node = _form.get_node_or_null(row_name)
	if row == null:
		return null
	for child: Node in _descendants(row):
		if child is CheckBox or child is OptionButton or child is HSlider or child is LineEdit:
			return child as Control
	return null


func _widget_value(widget: Control) -> Variant:
	if widget is CheckBox:
		return (widget as CheckBox).button_pressed
	if widget is OptionButton:
		return (widget as OptionButton).selected
	if widget is HSlider:
		return (widget as HSlider).value
	if widget is LineEdit:
		return (widget as LineEdit).text
	return null


func _type_matches_widget(setting_type: int, widget: Control) -> bool:
	match setting_type:
		SettingsSchema.SettingType.BOOL:
			return widget is CheckBox
		SettingsSchema.SettingType.ENUM:
			return widget is OptionButton
		SettingsSchema.SettingType.INT, SettingsSchema.SettingType.FLOAT:
			return widget is HSlider
		SettingsSchema.SettingType.STRING:
			return widget is LineEdit
	return false


func _descendants(root: Node) -> Array[Node]:
	var found: Array[Node] = []
	var stack: Array[Node] = [root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		found.append(node)
		for child: Node in node.get_children():
			stack.append(child)
	return found


func _labels_of(root: Node) -> Array[Label]:
	var found: Array[Label] = []
	for node: Node in _descendants(root):
		if node is Label:
			found.append(node as Label)
	return found


func _row_has_label(row: Node) -> bool:
	for label: Label in _labels_of(row):
		if not label.text.strip_edges().is_empty():
			return true
	return false


## Подсказка (schema.hint) — не подпись, она может быть пустой.
func _hint_label_of(row: Node) -> Label:
	var labels: Array[Label] = _labels_of(row)
	if labels.size() < 2:
		return null
	return labels[labels.size() - 1]


func _first_key_of_type(setting_type: int) -> String:
	var keys: Array[String] = SettingsSchema.all_keys()
	keys.sort()
	for key: String in keys:
		if int(SettingsSchema.describe(key)["type"]) == setting_type:
			return key
	return ""
