extends Node
## Boot — первая сцена, запускаемая движком.
##
## ЗАЧЕМ ОТДЕЛЬНАЯ СЦЕНА, А НЕ СРАЗУ МЕНЮ. Автолоады инициализируются до
## первой сцены, но им нужен кадр, чтобы достроить то, что зависит от
## дерева (пулы аудио, экран загрузки). Плюс именно здесь удобно:
##   * применить тему интерфейса,
##   * прогнать самотестирование путей и ресурсов,
##   * показать честный прогресс, а не чёрный экран,
##   * при ошибке — вывести её на экран, а не упасть молча.
##
## Boot НЕ содержит геймплея и переживает любой уровень: это единственная
## сцена, которую можно считать частью «каркаса» игры.

## Шаги инициализации. Каждый возвращает true при успехе.
## Массив нужен, чтобы прогресс-бар показывал РЕАЛЬНУЮ долю работы,
## а не красивую анимацию, которая доскакивает до 100% заранее.
const STEPS: Array[String] = [
	"theme",
	"audio_buses",
	"scene_paths",
	"quality_profiles",
	"settings",
	"save_slots",
]

const MAIN_MENU_AFTER_BOOT: bool = true

## Подписи шагов для прогресс-бара. Данные, а не match: иначе каждое
## добавление шага требует правки функции с и без того шестью return.
const STEP_LABELS: Dictionary = {
	"theme": "Тема интерфейса…",
	"audio_buses": "Аудиошины…",
	"scene_paths": "Проверка сцен…",
	"quality_profiles": "Профили качества и схема настроек…",
	"settings": "Применение настроек…",
	"save_slots": "Сохранения…",
}

var _started_at_ms: int = 0
var _failures: Array[String] = []
## Диспетчер шагов: имя -> Callable. Заполняется в _ready().
## Словарь вместо match с восемью return'ами: добавление шага теперь
## одна строка в двух константных таблицах, а не правка двух функций.
var _step_handlers: Dictionary = {}

@onready var _status: Label = $BootProgress/Center/Panel/Status
@onready var _bar: ProgressBar = $BootProgress/Center/Panel/Bar


func _ready() -> void:
	_started_at_ms = Time.get_ticks_msec()
	EventBus.boot_started.emit()
	# Boot живёт всегда: даже на паузе (которую сам и может выставить)
	# инициализация обязана завершиться.
	process_mode = Node.PROCESS_MODE_ALWAYS
	# Один кадр на то, чтобы автолоады достроились. Без этого AudioService
	# может не успеть создать пул, и первый звук в меню будет потерян.
	_run_steps.call_deferred()


func _run_steps() -> void:
	_register_step_handlers()
	var table_problems: Array[String] = _validate_step_tables()
	for problem: String in table_problems:
		Diagnostics.error("boot", problem)
	if not table_problems.is_empty():
		_failures.append("step_tables")

	var total: int = STEPS.size()
	for index: int in total:
		var step: String = STEPS[index]
		_set_progress(step, float(index) / float(total))
		# await на один кадр: интерфейс успевает отрисовать прогресс,
		# иначе полоса дёрнется из 0 в 100% за один кадр.
		await get_tree().process_frame
		var ok: bool = _run_step(step)
		if not ok:
			_failures.append(step)

	_set_progress("Готово", 1.0)
	var elapsed: int = Time.get_ticks_msec() - _started_at_ms
	var success: bool = _failures.is_empty()

	if not success:
		Diagnostics.error("boot", "провалены шаги: " + ", ".join(_failures))
		_status.text = "Запуск с ошибками:\n" + "\n".join(_failures)
	else:
		Diagnostics.info("boot", "инициализация завершена за %d мс" % elapsed)

	EventBus.boot_finished.emit(success, elapsed)

	if MAIN_MENU_AFTER_BOOT:
		# Даже при провале части шагов идём в меню: играть с отсутствующей
		# озвучкой лучше, чем смотреть на чёрный экран. Ошибка уже в логе.
		SceneService.change_to(GameConfig.SCENE_MAIN_MENU, false)


func _set_progress(step_name: String, fraction: float) -> void:
	if _bar != null:
		_bar.value = clampf(fraction, 0.0, 1.0) * 100.0
	if _status != null:
		_status.text = _human_step_name(step_name)


func _human_step_name(step: String) -> String:
	return str(STEP_LABELS.get(step, step))


## Заполняет диспетчер шагов. Callable'ы вместо match: каждый шаг —
## отдельный метод с понятным результатом, и при падении точно известно,
## ЧТО именно не инициализировалось. Один большой _ready() на 120 строк
## такой информации не даёт.
func _register_step_handlers() -> void:
	_step_handlers = {
		"theme": _step_theme,
		"audio_buses": _step_audio_buses,
		"scene_paths": _step_scene_paths,
		"quality_profiles": _step_quality_profiles,
		"settings": _step_settings,
		"save_slots": _step_save_slots,
	}


func _run_step(step: String) -> bool:
	if not _step_handlers.has(step):
		Diagnostics.error("boot", "неизвестный шаг инициализации: " + step)
		return false
	var handler: Callable = _step_handlers[step]
	return bool(handler.call())


## Самотест конфигурации шагов. Дешёвая проверка, которая ловит самую
## обидную опечатку: шаг добавили в STEPS, но забыли обработчик — и boot
## молча сообщает об ошибке, которой на самом деле нет.
func _validate_step_tables() -> Array[String]:
	var problems: Array[String] = []
	for step: String in STEPS:
		if not STEP_LABELS.has(step):
			problems.append("шаг '%s' без подписи в STEP_LABELS" % step)
		if not _step_handlers.has(step):
			problems.append("шаг '%s' без обработчика в _register_step_handlers" % step)
	for step: String in STEP_LABELS.keys():
		if not STEPS.has(step):
			problems.append("подпись '%s' описана, но шаг не входит в STEPS" % step)
	return problems


func _step_theme() -> bool:
	# ThemeService — автолоад. Тема ставится на корень дерева, поэтому
	# наследуется всеми Control автоматически: ставить её каждому меню
	# отдельно — верный способ получить пять несовместимых меню.
	if not ThemeService.apply_globally():
		Diagnostics.error("boot", "ThemeService.apply_globally() не удался")
		return false
	return true


func _step_audio_buses() -> bool:
	var missing: Array[String] = []
	for bus_name: String in GameConfig.AUDIO_BUSES:
		if AudioServer.get_bus_index(bus_name) < 0:
			missing.append(bus_name)
	if not missing.is_empty():
		Diagnostics.error("boot", "отсутствуют аудиошины: " + ", ".join(missing))
		return false
	Diagnostics.info("boot", "аудиошины на месте: %d" % AudioServer.get_bus_count())
	return true


func _step_scene_paths() -> bool:
	var scenes: Array[String] = [
		GameConfig.SCENE_MAIN_MENU,
		GameConfig.SCENE_WORLD,
		GameConfig.SCENE_LOADING,
	]
	var missing: Array[String] = []
	for path: String in scenes:
		if not ResourceLoader.exists(path):
			missing.append(path)
	if not missing.is_empty():
		Diagnostics.error("boot", "не найдены сцены: " + ", ".join(missing))
		return false
	return true


func _step_quality_profiles() -> bool:
	var problems: Array[String] = SettingsService.validate_schema()
	if not problems.is_empty():
		for problem: String in problems:
			Diagnostics.error("boot", "схема настроек: " + problem)
		return false
	var count: int = QualityService.profile_count()
	if count == 0:
		Diagnostics.error("boot", "не загружено ни одного профиля качества")
		return false
	Diagnostics.info("boot", "профилей качества: %d" % count)
	return true


func _step_settings() -> bool:
	SettingsService.apply_all()
	return SettingsService.save_to_disk()


func _step_save_slots() -> bool:
	var summaries: Array[Dictionary] = SaveService.all_slot_summaries()
	var found: int = 0
	for summary: Dictionary in summaries:
		if bool(summary.get("exists", false)):
			found += 1
	Diagnostics.info("boot", "слотов сохранений найдено: %d из %d" % [found, summaries.size()])
	# Отсутствующие сохранения — норма при первом запуске, поэтому true.
	return true
