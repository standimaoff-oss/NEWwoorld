extends CanvasLayer
## HUD — игровой интерфейс поверх мира.
##
## ПРИНЦИП: HUD ничего не хранит и ничего не решает. Он подписан на сигналы
## EventBus и рисует то, что ему сказали. Обратная связь идёт в одну сторону
## — поэтому HUD можно удалить целиком, и игра продолжит работать.
##
## ЭКРАННОЕ ВРЕМЯ. Постоянно видимых элементов три: прицел, здоровье,
## выносливость. Всё остальное появляется по событию и исчезает само.
## Перегруженный HUD читается хуже пустого: игрок перестаёт искать в нём
## информацию и начинает игнорировать.
##
## ДОСТУПНОСТЬ. Полосы здоровья/выносливости продублированы числами и
## отличаются не только цветом, но и длиной/подписью. Ориентация «только
## на цвет» недоступна игрокам с дальтонизмом — отсюда дублирование.

## Скорость затухания подсветки урона, 1/с.
const DAMAGE_FLASH_DECAY: float = 3.2
## Максимальная непрозрачность красной вспышки. Больше 0.6 — игрок
## перестаёт видеть, что происходит, и вспышка мешает, а не информирует.
const DAMAGE_FLASH_MAX: float = 0.45
## Длительность показа подсказки взаимодействия после потери фокуса, с.
## Мгновенное исчезновение читается как мерцание при пограничном угле.
const PROMPT_HOLD_SEC: float = 0.12
## Через сколько секунд без события скрывать строку статуса.
const STATUS_LIFETIME_SEC: float = 3.5

var _health_ratio: float = 1.0
var _stamina_ratio: float = 1.0
var _damage_flash: float = 0.0
var _prompt_target: Node = null
var _prompt_hidden_time: float = 0.0
var _status_timer: float = 0.0
var _crosshair_spread: float = 0.0

@onready var _health_bar: ProgressBar = %HealthBar
@onready var _health_label: Label = %HealthLabel
@onready var _stamina_bar: ProgressBar = %StaminaBar
@onready var _stamina_label: Label = %StatusLabel
@onready var _prompt_label: Label = %PromptLabel
@onready var _status_label: Label = %EventLabel
@onready var _damage_overlay: ColorRect = %DamageOverlay
@onready var _fps_label: Label = %FpsLabel


func _ready() -> void:
	layer = 10
	_damage_overlay.modulate.a = 0.0
	_prompt_label.modulate.a = 0.0
	_status_label.modulate.a = 0.0
	_stamina_bar.visible = false
	_fps_label.visible = SettingsService.get_bool("gameplay/show_fps")
	EventBus.player_health_changed.connect(_on_health_changed)
	EventBus.player_stamina_changed.connect(_on_stamina_changed)
	EventBus.interaction_focus_changed.connect(_on_focus_changed)
	EventBus.player_died.connect(_on_player_died)
	EventBus.destruction_chunks_spawned.connect(_on_chunks_spawned)
	EventBus.save_finished.connect(_on_save_finished)
	EventBus.settings_changed.connect(_on_settings_changed)


func _exit_tree() -> void:
	# Отписка обязательна: HUD живёт в CanvasLayer, а EventBus — автолоад.
	# Без disconnect сигнал придёт в освобождённый объект и игра упадёт
	# при повторном входе в уровень.
	for signal_pair: Array in [
		[EventBus.player_health_changed, _on_health_changed],
		[EventBus.player_stamina_changed, _on_stamina_changed],
		[EventBus.interaction_focus_changed, _on_focus_changed],
		[EventBus.player_died, _on_player_died],
		[EventBus.destruction_chunks_spawned, _on_chunks_spawned],
		[EventBus.save_finished, _on_save_finished],
		[EventBus.settings_changed, _on_settings_changed],
	]:
		var bus_signal: Signal = signal_pair[0]
		var handler: Callable = signal_pair[1]
		if bus_signal.is_connected(handler):
			bus_signal.disconnect(handler)


func _process(delta: float) -> void:
	_update_damage_flash(delta)
	_update_prompt(delta)
	_update_status(delta)
	if _fps_label.visible:
		_fps_label.text = (
			"%d FPS  ·  %.1f мс"
			% [int(round(PerfMonitor.current_fps())), PerfMonitor.avg_frame_ms()]
		)


# ------------------------------------------------------------------ полосы --


func _on_health_changed(current: float, maximum: float) -> void:
	var previous: float = _health_ratio
	_health_ratio = clampf(current / maxf(maximum, 0.001), 0.0, 1.0)
	_health_bar.value = _health_ratio * 100.0
	_health_label.text = "%d / %d" % [int(round(current)), int(round(maximum))]
	# Вспышка только при ПОТЕРЕ здоровья: при лечении красная рамка
	# сообщает игроку ложную информацию.
	if _health_ratio < previous - 0.001:
		_damage_flash = minf(DAMAGE_FLASH_MAX, _damage_flash + (previous - _health_ratio) * 2.2)
	_health_bar.modulate = _health_tint()


## Цвет полосы здоровья. Меняется не только оттенком, но и насыщенностью:
## при дальтонизме различимость обеспечивается и яркостью тоже.
func _health_tint() -> Color:
	if _health_ratio > 0.6:
		return Color(1, 1, 1)
	if _health_ratio > 0.3:
		return Color(1.0, 0.82, 0.55)
	return Color(1.0, 0.42, 0.38)


func _on_stamina_changed(current: float, maximum: float) -> void:
	_stamina_ratio = clampf(current / maxf(maximum, 0.001), 0.0, 1.0)
	# Полоса показывается только когда она нужна: постоянно висящая
	# полная полоса выносливости — визуальный шум.
	var should_show: bool = _stamina_ratio < 0.995
	if should_show != _stamina_bar.visible:
		_stamina_bar.visible = should_show
		_stamina_label.visible = should_show
	if should_show:
		_stamina_bar.value = _stamina_ratio * 100.0
		_stamina_label.text = "%d%%" % int(round(_stamina_ratio * 100.0))


func _update_damage_flash(delta: float) -> void:
	if _damage_flash <= 0.0:
		return
	_damage_flash = maxf(0.0, _damage_flash - _damage_flash * DAMAGE_FLASH_DECAY * delta)
	if _damage_flash < 0.004:
		_damage_flash = 0.0
	_damage_overlay.modulate.a = _damage_flash


# ------------------------------------------------------------- подсказки ----


func _on_focus_changed(target: Node) -> void:
	_prompt_target = target
	if target == null:
		_prompt_hidden_time = 0.0
		return
	_prompt_label.text = _prompt_text(target)
	_prompt_hidden_time = PROMPT_HOLD_SEC


func _prompt_text(target: Node) -> String:
	if target.has_method("interaction_prompt"):
		var prompt: Variant = target.call("interaction_prompt")
		if typeof(prompt) == TYPE_STRING and not String(prompt).is_empty():
			return String(prompt)
	return String(target.name)


func _update_prompt(delta: float) -> void:
	if _prompt_target != null and is_instance_valid(_prompt_target):
		_prompt_label.modulate.a = lerpf(
			_prompt_label.modulate.a, 1.0, clampf(14.0 * delta, 0.0, 1.0)
		)
		return
	if _prompt_hidden_time > 0.0:
		_prompt_hidden_time -= delta
		return
	_prompt_label.modulate.a = lerpf(_prompt_label.modulate.a, 0.0, clampf(10.0 * delta, 0.0, 1.0))


func show_status(text: String) -> void:
	_status_label.text = text
	_status_timer = STATUS_LIFETIME_SEC


func _update_status(delta: float) -> void:
	if _status_timer > 0.0:
		_status_timer -= delta
		_status_label.modulate.a = lerpf(
			_status_label.modulate.a, 1.0, clampf(16.0 * delta, 0.0, 1.0)
		)
		return
	_status_label.modulate.a = lerpf(_status_label.modulate.a, 0.0, clampf(6.0 * delta, 0.0, 1.0))


# ---------------------------------------------------------------- события ---


func _on_player_died(cause: String) -> void:
	show_status("Вы погибли: %s" % cause)
	_damage_flash = DAMAGE_FLASH_MAX


func _on_chunks_spawned(count: int, _origin: Vector3) -> void:
	# Расширение прицела на короткое время — дешёвая обратная связь
	# попадания. Без неё игрок не понимает, попал ли он, пока не увидит
	# разлетающиеся осколки (а при промахе не увидит никогда).
	_crosshair_spread = minf(1.0, _crosshair_spread + float(count) * 0.04)


func _on_save_finished(_slot: int, ok: bool, message: String) -> void:
	show_status(message if not ok else "Игра сохранена")


func _on_settings_changed(section: String) -> void:
	if section == SettingsSchema.SECTION_GAMEPLAY:
		_fps_label.visible = SettingsService.get_bool("gameplay/show_fps")
