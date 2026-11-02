extends Node
## MainMenu — главное меню.
##
## КОМПОЗИЦИЯ. Корень — Node, а не Control: 3D-фон (Backdrop) и 2D-интерфейс
## (UILayer на CanvasLayer) живут рядом, и движок корректно рисует 3D позади
## UI. Control-корень с Node3D внутри — частая ошибка: 3D либо не рисуется,
## либо рисуется поверх интерфейса.
##
## НАВИГАЦИЯ. Полностью работает с геймпада и клавиатуры: фокус ставится
## на первый активный пункт, Tab/стрелки ходят по списку, Enter активирует.
## Меню, в которое нельзя войти без мыши, — это брак, а не «минимализм».
##
## ПАНЕЛИ. Настройки и контакты — не отдельные сцены, а панели внутри
## этого же меню. Причина: смена сцены ради настроек убивает 3D-фон и
## заставляет перезагружать его заново. Панель открывается поверх и
## возвращает фокус туда, откуда её вызвали.

## Порядок пунктов для клавиатурной/геймпадной навигации.
## Задан явно, а не обходом дерева: порядок в UI и порядок фокуса —
## разные вещи, и второй должен быть предсказуемым.
const MENU_ORDER: Array[String] = [
	"PlayButton",
	"ContinueButton",
	"SettingsButton",
	"CreditsButton",
	"QuitButton",
]

## Машинные имена действий. Совпадают с menu_action_triggered в EventBus,
## поэтому уровень или тест может дёрнуть пункт меню без клика по нему.
const ACTION_PLAY: String = "new_game"
const ACTION_CONTINUE: String = "continue_game"
const ACTION_SETTINGS: String = "open_settings"
const ACTION_CREDITS: String = "open_credits"
const ACTION_QUIT: String = "quit"

## Пауза между появлением пунктов, секунды. Каскадное появление делает
## меню «собраннным», а не «вываленным» на экран.
const STAGGER_SEC: float = 0.055
const FADE_IN_SEC: float = 0.32
const FADE_OUT_SEC: float = 0.18

var _buttons: Dictionary = {}
var _open_panel: Control = null
var _panel_return_focus: Control = null
var _intro_tween: Tween = null


func _ready() -> void:
	_cache_buttons()
	_configure_buttons()
	_update_dynamic_state()
	_show_footer()
	_play_intro()
	EventBus.main_menu_opened.emit()
	EventBus.save_slots_changed.connect(_update_dynamic_state)
	EventBus.settings_changed.connect(_on_settings_changed)


func _exit_tree() -> void:
	EventBus.main_menu_closed.emit()
	if EventBus.save_slots_changed.is_connected(_update_dynamic_state):
		EventBus.save_slots_changed.disconnect(_update_dynamic_state)
	if EventBus.settings_changed.is_connected(_on_settings_changed):
		EventBus.settings_changed.disconnect(_on_settings_changed)


func _unhandled_input(event: InputEvent) -> void:
	# Esc закрывает верхнюю панель, а не выходит из игры: игрок, тыкающий
	# Esc в настройках, ожидает вернуться в меню, а не на рабочий стол.
	if event.is_action_pressed("menu_cancel"):
		if _open_panel != null:
			close_panel()
			get_viewport().set_input_as_handled()
			return
		if not _buttons.is_empty():
			_focus_first_button()
			get_viewport().set_input_as_handled()
	if event.is_action_pressed("pause") and _open_panel == null:
		_focus_first_button()
		get_viewport().set_input_as_handled()


# --------------------------------------------------------------- настройка --


func _cache_buttons() -> void:
	_buttons["PlayButton"] = %PlayButton
	_buttons["ContinueButton"] = %ContinueButton
	_buttons["SettingsButton"] = %SettingsButton
	_buttons["CreditsButton"] = %CreditsButton
	_buttons["QuitButton"] = %QuitButton


func _configure_buttons() -> void:
	_buttons["PlayButton"].pressed.connect(_on_play_pressed)
	_buttons["ContinueButton"].pressed.connect(_on_continue_pressed)
	_buttons["SettingsButton"].pressed.connect(_on_settings_pressed)
	_buttons["CreditsButton"].pressed.connect(_on_credits_pressed)
	_buttons["QuitButton"].pressed.connect(_on_quit_pressed)
	# В редакторе (без DisplayServer-окна) «Выйти» бессмысленна и только
	# мешает: скрываем её. В экспортированной игре она на месте.
	_buttons["QuitButton"].visible = not OS.has_feature("editor")


func _update_dynamic_state() -> void:
	# «Продолжить» активна, только если есть куда продолжать. Серая кнопка,
	# которая ничего не делает, хуже отсутствующей: игрок решает, что игра
	# сломана.
	var has_any_save: bool = false
	for summary: Dictionary in SaveService.all_slot_summaries():
		if bool(summary.get("exists", false)) and not bool(summary.get("corrupted", false)):
			has_any_save = true
			break
	var continue_button: Button = _buttons.get("ContinueButton")
	if continue_button == null:
		return
	continue_button.disabled = not has_any_save
	if has_any_save:
		var summary: Dictionary = SaveService.slot_summary(SaveService.QUICKSAVE_SLOT)
		if bool(summary.get("exists", false)):
			continue_button.text = "Продолжить  ·  %s" % str(summary.get("playtime_human", ""))
		else:
			continue_button.text = "Продолжить"


func _show_footer() -> void:
	%VersionLabel.text = "NEWwoorld %s" % GameConfig.version_full()
	%BackendLabel.text = (
		"разрушение: %s  ·  %s" % [DestructionService.backend_name(), str(OS.get_name())]
	)


func _focus_first_button() -> void:
	for node_name: String in MENU_ORDER:
		var button: Button = _buttons.get(node_name)
		if button != null and button.visible and not button.disabled:
			button.grab_focus()
			return


func _play_intro() -> void:
	# Каскадное появление: пункты выезжают слева и проявляются по очереди.
	# Дёшево (один Tween на всё меню), но именно такие детали отличают
	# собранное меню от набора кнопок на ColorRect.
	if _intro_tween != null and _intro_tween.is_valid():
		_intro_tween.kill()
	_intro_tween = create_tween().set_parallel(true)
	var index: int = 0
	for node_name: String in MENU_ORDER:
		var button: Button = _buttons.get(node_name)
		if button == null:
			continue
		button.modulate.a = 0.0
		button.position.x -= 24.0
		var delay: float = STAGGER_SEC * float(index)
		_intro_tween.tween_property(button, "modulate:a", 1.0, FADE_IN_SEC).set_delay(delay)
		(
			_intro_tween
			. tween_property(button, "position:x", button.position.x + 24.0, FADE_IN_SEC)
			. set_delay(delay)
			. set_trans(Tween.TRANS_CUBIC)
			. set_ease(Tween.EASE_OUT)
		)
		index += 1
	_intro_tween.chain().tween_callback(_focus_first_button)


# ------------------------------------------------------------------ панели --


## Открывает панель настроек или контактов поверх меню.
func open_panel(panel: Control) -> void:
	if panel == null:
		return
	if _open_panel != null:
		close_panel()
	_panel_return_focus = get_viewport().gui_get_focus_owner() as Control
	_open_panel = panel
	panel.visible = true
	panel.modulate.a = 0.0
	var tween: Tween = create_tween()
	tween.tween_property(panel, "modulate:a", 1.0, FADE_IN_SEC)
	(
		tween
		. parallel()
		. tween_property(panel, "scale", Vector2.ONE, FADE_IN_SEC)
		. from(Vector2(0.97, 0.97))
		. set_trans(Tween.TRANS_CUBIC)
		. set_ease(Tween.EASE_OUT)
	)
	_set_menu_interactive(false)
	if panel.has_method("panel_opened"):
		panel.call("panel_opened")
	if panel == %SettingsPanel:
		EventBus.settings_opened.emit()
	elif panel == %CreditsPanel:
		EventBus.credits_opened.emit()


## Закрывает панель и ВОЗВРАЩАЕТ ФОКУС туда, откуда её открыли.
## Без этого после закрытия настроек геймпад «теряется»: фокус уходит
## в никуда, и игрок жмёт кнопки впустую.
func close_panel() -> void:
	if _open_panel == null:
		return
	var panel: Control = _open_panel
	_open_panel = null
	if panel.has_method("panel_closed"):
		panel.call("panel_closed")
	var tween: Tween = create_tween()
	tween.tween_property(panel, "modulate:a", 0.0, FADE_OUT_SEC)
	tween.tween_callback(func() -> void: panel.visible = false)
	_set_menu_interactive(true)
	if _panel_return_focus != null and is_instance_valid(_panel_return_focus):
		_panel_return_focus.grab_focus()
	else:
		_focus_first_button()
	_panel_return_focus = null


func _set_menu_interactive(interactive: bool) -> void:
	for node_name: String in MENU_ORDER:
		var button: Button = _buttons.get(node_name)
		if button != null:
			button.focus_mode = (Control.FOCUS_ALL if interactive else Control.FOCUS_NONE)
			if not interactive:
				button.mouse_filter = Control.MOUSE_FILTER_IGNORE


func is_panel_open() -> bool:
	return _open_panel != null


# ----------------------------------------------------------------- действия --


func _on_play_pressed() -> void:
	EventBus.menu_action_triggered.emit(ACTION_PLAY)
	_start_game()


func _on_continue_pressed() -> void:
	EventBus.menu_action_triggered.emit(ACTION_CONTINUE)
	var ok: bool = SaveService.quick_load()
	if not ok:
		# Не нашли быстрое сохранение — берём первый существующий слот.
		for summary: Dictionary in SaveService.all_slot_summaries():
			if bool(summary.get("exists", false)) and not bool(summary.get("corrupted", false)):
				ok = SaveService.load_game(int(summary["slot"]))
				break
	if not ok:
		Diagnostics.warn("menu", "продолжить не удалось — начинаем новую игру")
	_start_game()


func _on_settings_pressed() -> void:
	EventBus.menu_action_triggered.emit(ACTION_SETTINGS)
	open_panel(%SettingsPanel)


func _on_credits_pressed() -> void:
	EventBus.menu_action_triggered.emit(ACTION_CREDITS)
	open_panel(%CreditsPanel)


func _on_quit_pressed() -> void:
	EventBus.menu_action_triggered.emit(ACTION_QUIT)
	SettingsService.save_to_disk()
	Diagnostics.info("menu", "выход по запросу игрока")
	# Даём логам дописаться до того, как процесс завершится.
	get_tree().root.propagate_notification(Node.NOTIFICATION_PREDELETE)
	get_tree().quit(0)


func _start_game() -> void:
	SettingsService.save_to_disk()
	EventBus.game_started.emit()
	SceneService.change_to(GameConfig.SCENE_WORLD, true)


func _on_settings_changed(_section: String) -> void:
	# Пересборка темы нужна только при смене масштаба шрифта. ThemeService
	# сам сравнивает текущий масштаб с применённым, поэтому перетаскивание
	# ползунка громкости не пересобирает тему на каждое событие.
	ThemeService.rebuild_if_needed()
