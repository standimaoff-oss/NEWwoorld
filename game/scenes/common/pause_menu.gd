extends CanvasLayer
## PauseMenu — пауза.
##
## process_mode = 3 (ALWAYS) задан в сцене, а не кодом: это единственная
## причина, по которой меню вообще реагирует на ввод, когда дерево на паузе.
## Забытый process_mode — самый частый баг «пауза не открывается».
##
## ПАУЗА ЧЕСТНАЯ: get_tree().paused = true останавливает физику, анимации и
## _process всей сцены. Но SettingsService и AudioService живут в автолоадах
## и должны работать и на паузе (игрок меняет громкость в паузе постоянно),
## поэтому им в boot.gd выставлен PROCESS_MODE_ALWAYS.
##
## НАСТРОЙКИ ВНУТРИ ПАУЗЫ открываются той же SettingsPanel, что и в главном
## меню. Две разные реализации настроек — гарантированный способ получить
## «в меню работает, в игре нет».

const SETTINGS_PANEL_SCENE: PackedScene = preload("res://scenes/menu/settings_panel.tscn")

var _settings_panel: Control = null
var _is_open: bool = false
var _buttons: Array[Button] = []


func _ready() -> void:
	visible = false
	_buttons = [
		%ResumeButton,
		%SettingsButton,
		%QuickSaveButton,
		%QuickLoadButton,
		%MainMenuButton,
		%QuitButton,
	]
	%ResumeButton.pressed.connect(_on_resume_pressed)
	%SettingsButton.pressed.connect(_on_settings_pressed)
	%QuickSaveButton.pressed.connect(_on_quick_save_pressed)
	%QuickLoadButton.pressed.connect(_on_quick_load_pressed)
	%MainMenuButton.pressed.connect(_on_main_menu_pressed)
	%QuitButton.pressed.connect(_on_quit_pressed)
	EventBus.save_finished.connect(_on_save_finished)
	EventBus.load_finished.connect(_on_load_finished)
	EventBus.save_slots_changed.connect(_update_button_states)
	_update_button_states()


func _exit_tree() -> void:
	if EventBus.save_finished.is_connected(_on_save_finished):
		EventBus.save_finished.disconnect(_on_save_finished)
	if EventBus.load_finished.is_connected(_on_load_finished):
		EventBus.load_finished.disconnect(_on_load_finished)
	if EventBus.save_slots_changed.is_connected(_update_button_states):
		EventBus.save_slots_changed.disconnect(_update_button_states)


func _unhandled_input(event: InputEvent) -> void:
	if not event.is_action_pressed("pause"):
		return
	if _settings_panel != null and _settings_panel.visible:
		_close_settings()
		return
	toggle()
	# Съедаем событие: иначе тот же Esc дойдёт до мира и, например,
	# выстрелит в момент открытия паузы.
	get_viewport().set_input_as_handled()


# ------------------------------------------------------------------ пауза --


func toggle() -> void:
	if _is_open:
		close()
	else:
		open()


func open() -> void:
	if _is_open:
		return
	_is_open = true
	visible = true
	# Порядок важен: сначала пауза, потом visible. Наоборот — один кадр,
	# в котором мир уже стоит, а меню ещё не нарисовано.
	get_tree().paused = true
	_set_status("")
	_update_button_states()
	%Dimmer.modulate.a = 0.0
	%Column.modulate.a = 0.0
	var tween: Tween = create_tween().set_parallel(true)
	tween.tween_property(%Dimmer, "modulate:a", 1.0, 0.14)
	tween.tween_property(%Column, "modulate:a", 1.0, 0.18)
	tween.chain().tween_callback(_focus_first_button)
	EventBus.pause_menu_opened.emit()
	EventBus.game_paused.emit(true)
	Diagnostics.info("pause", "пауза открыта")


func close() -> void:
	if not _is_open:
		return
	_close_settings()
	_is_open = false
	get_tree().paused = false
	var tween: Tween = create_tween()
	tween.set_parallel(true)
	tween.tween_property(%Dimmer, "modulate:a", 0.0, 0.1)
	tween.tween_property(%Column, "modulate:a", 0.0, 0.12)
	tween.chain().tween_callback(func() -> void: visible = false)
	EventBus.pause_menu_closed.emit()
	EventBus.game_paused.emit(false)
	Diagnostics.info("pause", "пауза закрыта")


func is_open() -> bool:
	return _is_open


func _focus_first_button() -> void:
	for button: Button in _buttons:
		if button.visible and not button.disabled:
			button.grab_focus()
			return


func _update_button_states() -> void:
	# «Быстрая загрузка» неактивна без сохранения: серая кнопка, которая
	# ничего не делает, читается игроком как баг.
	var has_quick: bool = SaveService.has_save(SaveService.QUICKSAVE_SLOT)
	%QuickLoadButton.disabled = not has_quick
	# Меню в этот момент уже открыто: состояние кнопок пересчитывается
	# при open() и при изменении списка слотов, поэтому дополнительных
	# условий на _is_open здесь не нужно — они только запутывают.
	%QuickSaveButton.disabled = false


func _set_status(text: String) -> void:
	%StatusLabel.text = text


# --------------------------------------------------------------- настройки --


func _on_settings_pressed() -> void:
	if _settings_panel == null:
		_settings_panel = SETTINGS_PANEL_SCENE.instantiate() as Control
		if _settings_panel == null:
			_set_status("Не удалось открыть настройки")
			return
		_settings_panel.custom_minimum_size = Vector2(760, 560)
		%SettingsHost.add_child(_settings_panel)
	_set_buttons_visible(false)
	_settings_panel.visible = true
	if _settings_panel.has_method("panel_opened"):
		_settings_panel.call("panel_opened")
	EventBus.settings_opened.emit()


func _close_settings() -> void:
	if _settings_panel == null or not _settings_panel.visible:
		return
	if _settings_panel.has_method("panel_closed"):
		_settings_panel.call("panel_closed")
	_settings_panel.visible = false
	_set_buttons_visible(true)
	_focus_first_button()


func _set_buttons_visible(buttons_visible: bool) -> void:
	# Кнопки именно СКРЫВАЕМ, а не делаем неактивными: неактивная кнопка
	# остаётся в фокусной цепочке, и геймпад «застревает» на ней.
	%Column.visible = buttons_visible


# ---------------------------------------------------------------- действия --


func _on_resume_pressed() -> void:
	close()


func _on_quick_save_pressed() -> void:
	_set_status("Сохранение…")
	SaveService.quick_save()


func _on_quick_load_pressed() -> void:
	_set_status("Загрузка…")
	SaveService.quick_load()


func _on_save_finished(_slot: int, ok: bool, message: String) -> void:
	_set_status(message if not ok else "Сохранено")
	_update_button_states()


func _on_load_finished(_slot: int, ok: bool, message: String) -> void:
	_set_status(message if not ok else "Загружено")
	if ok:
		close()


func _on_main_menu_pressed() -> void:
	SettingsService.save_to_disk()
	# Снимаем паузу ДО смены сцены: сцена, загруженная в паузе, приходит
	# в дерево уже остановленной, и игрок получает чёрный экран с нерабочим
	# вводом. Классический баг, который не воспроизводится в редакторе.
	get_tree().paused = false
	_is_open = false
	visible = false
	EventBus.game_paused.emit(false)
	EventBus.pause_menu_closed.emit()
	SceneService.change_to(GameConfig.SCENE_MAIN_MENU, false)


func _on_quit_pressed() -> void:
	SettingsService.save_to_disk()
	get_tree().paused = false
	Diagnostics.info("pause", "выход из игры по запросу игрока")
	get_tree().quit(0)
