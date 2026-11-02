extends Node
## Diagnostics — структурированное логирование и перехват ошибок.
##
## Почему не `print()`: print в релизе бесполезен (никто не видит stdout),
## не имеет уровней, не имеет времени и не переживает закрытие игры.
## Багрепорт от игрока без лога — это гадание.
##
## Всё, что пишет сюда, попадает в:
##   * кольцевой буфер в памяти (читает debug-оверлей и консоль),
##   * файл user://logs/session.log (отдаётся вместе с багрепортом),
##   * stdout, если включён verbose или это debug-сборка.
##
## Уровни: TRACE выключен в релизе полностью, чтобы не жрать время кадра
## на форматирование строк, которые никто не прочитает.

enum Level { TRACE, DEBUG, INFO, WARN, ERROR, FATAL }

## Сколько записей держим в памяти. 2000 строк * ~200 байт = ~400 КБ —
## цена диагностики, которую не жалко.
const RING_BUFFER_CAPACITY: int = 2000
const MAX_MESSAGE_LENGTH: int = 2000
const FLUSH_LEVEL: Level = Level.WARN

const _LEVEL_NAMES: Dictionary = {
	Level.TRACE: "TRACE",
	Level.DEBUG: "DEBUG",
	Level.INFO: "INFO ",
	Level.WARN: "WARN ",
	Level.ERROR: "ERROR",
	Level.FATAL: "FATAL",
}

var _ring: Array[Dictionary] = []
var _file: FileAccess = null
var _file_path: String = ""
var _min_level: Level = Level.INFO
var _write_to_file: bool = true
var _session_started_at_ms: int = 0
var _counters: Dictionary = {}


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_session_started_at_ms = Time.get_ticks_msec()
	_min_level = Level.DEBUG if GameConfig.is_debug_runtime() else Level.INFO
	_open_log_file()
	_log(Level.INFO, "system", "NEWwoorld %s — сессия начата" % GameConfig.version_full())
	_log(Level.INFO, "system", _describe_environment())


func _exit_tree() -> void:
	_log(Level.INFO, "system", "сессия завершена")
	_close_log_file()


## ---------------------------------------------------------------- публичное


func trace(tag: String, message: String) -> void:
	_log(Level.TRACE, tag, message)


func debug(tag: String, message: String) -> void:
	_log(Level.DEBUG, tag, message)


func info(tag: String, message: String) -> void:
	_log(Level.INFO, tag, message)


func warn(tag: String, message: String) -> void:
	_log(Level.WARN, tag, message)


func error(tag: String, message: String) -> void:
	_log(Level.ERROR, tag, message)


## Фатальная ошибка: логируем, публикуем в EventBus и продолжаем работать.
## Игра не должна падать молча — но и не должна падать вообще, если можно
## деградировать.
func fatal(tag: String, message: String) -> void:
	_log(Level.FATAL, tag, message)
	EventBus.fatal_error_occurred.emit(tag, message)


## «Мягкий» ассерт. В debug-сборке пишет ERROR (видно сразу), в релизе —
## только WARN, без остановки. Замена `assert()`, который в релизе
## компилируется в ничто и прячет баг.
func check(condition: bool, tag: String, message: String) -> bool:
	if condition:
		return true
	if GameConfig.is_debug_runtime():
		error(tag, "CHECK FAILED: " + message)
	else:
		warn(tag, "CHECK FAILED: " + message)
	return false


## Проверяет, что объект валиден (не null и не freed) перед использованием.
## Самый частый источник крашей в Godot — обращение к freed-ноде из сигнала,
## который пришёл на следующем кадре.
func check_valid(obj: Object, tag: String, context: String) -> bool:
	if obj == null:
		warn(tag, "%s: объект == null" % context)
		return false
	if not is_instance_valid(obj):
		warn(tag, "%s: объект уже freed" % context)
		return false
	return true


## Инкремент именованного счётчика. Дешёвая альтернатива метрикам:
## «сколько раз сработал пул», «сколько осколков порождено за уровень».
func count(name: String, amount: int = 1) -> void:
	_counters[name] = int(_counters.get(name, 0)) + amount


func get_counter(name: String) -> int:
	return int(_counters.get(name, 0))


func reset_counters() -> void:
	_counters.clear()


## Все счётчики одним словарём — для debug-оверлея и тестов.
func counters_snapshot() -> Dictionary:
	return _counters.duplicate()


## Последние N записей лога, от старых к новым.
func recent_entries(count: int = 50) -> Array[Dictionary]:
	var take: int = clampi(count, 1, _ring.size())
	return _ring.slice(_ring.size() - take)


## Записи уровня >= given, для фильтра «покажи только ошибки».
func entries_at_or_above(level: Level) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for entry: Dictionary in _ring:
		if int(entry["level"]) >= int(level):
			out.append(entry)
	return out


func error_count() -> int:
	var total: int = 0
	for entry: Dictionary in _ring:
		if int(entry["level"]) >= int(Level.ERROR):
			total += 1
	return total


func set_min_level(level: Level) -> void:
	_min_level = level


func set_file_logging(enabled: bool) -> void:
	_write_to_file = enabled
	if enabled and _file == null:
		_open_log_file()


func log_file_path() -> String:
	return _file_path


## Сохраняет скриншот в user://. Используется и action "screenshot",
## и автоматическим багрепортом.
func capture_screenshot(prefix: String = "shot") -> String:
	var image: Image = get_viewport().get_texture().get_image()
	if image == null:
		error("screenshot", "не удалось получить image вьюпорта")
		return ""
	var stamp: String = _timestamp_compact()
	var path: String = "user://%s_%s.png" % [prefix, stamp]
	var err: int = image.save_png(path)
	if err != OK:
		error("screenshot", "save_png вернул %d для %s" % [err, path])
		return ""
	info("screenshot", "сохранено: " + GameConfig.user_path_to_global(path))
	return path


## --------------------------------------------------------------- приватное


func _log(level: Level, tag: String, message: String) -> void:
	if int(level) < int(_min_level):
		return
	var truncated: String = message
	if truncated.length() > MAX_MESSAGE_LENGTH:
		truncated = truncated.substr(0, MAX_MESSAGE_LENGTH) + "…[обрезано]"
	var entry: Dictionary = {
		"level": int(level),
		"tag": tag,
		"message": truncated,
		"msec": Time.get_ticks_msec(),
		"uptime_ms": Time.get_ticks_msec() - _session_started_at_ms,
		"frame": Engine.get_frames_drawn(),
	}
	_ring.append(entry)
	if _ring.size() > RING_BUFFER_CAPACITY:
		_ring.pop_front()

	var line: String = _format(entry)
	_emit_to_stdout(level, line)
	if _write_to_file and _file != null:
		_file.store_line(line)
		if int(level) >= int(FLUSH_LEVEL):
			_file.flush()


func _format(entry: Dictionary) -> String:
	var level_name: String = str(_LEVEL_NAMES.get(int(entry["level"]), "?????"))
	return (
		"[%08d] %s %-12s %s"
		% [int(entry["uptime_ms"]), level_name, str(entry["tag"]), str(entry["message"])]
	)


func _emit_to_stdout(level: Level, line: String) -> void:
	match int(level):
		Level.ERROR, Level.FATAL:
			push_error(line)
		Level.WARN:
			push_warning(line)
		_:
			if GameConfig.is_debug_runtime():
				print(line)


func _open_log_file() -> void:
	_file_path = GameConfig.PATH_LOG_FILE
	var dir_path: String = _file_path.get_base_dir()
	if not DirAccess.dir_exists_absolute(dir_path):
		var mk_err: int = DirAccess.make_dir_recursive_absolute(dir_path)
		if mk_err != OK:
			push_error("Diagnostics: не создать каталог логов (%d)" % mk_err)
			_write_to_file = false
			return
	_file = FileAccess.open(_file_path, FileAccess.WRITE)
	if _file == null:
		push_error("Diagnostics: лог недоступен, err=%d" % FileAccess.get_open_error())
		_write_to_file = false


func _close_log_file() -> void:
	if _file != null:
		_file.flush()
		_file.close()
		_file = null


func _describe_environment() -> String:
	return (
		"os=%s renderer=%s gpu=%s threads=%d screen=%dx%d"
		% [
			OS.get_name(),
			str(ProjectSettings.get_setting("rendering/renderer/rendering_method", "forward_plus")),
			RenderingServer.get_current_rendering_driver_name(),
			OS.get_processor_count(),
			DisplayServer.screen_get_size().x,
			DisplayServer.screen_get_size().y,
		]
	)


func _timestamp_compact() -> String:
	var d: Dictionary = Time.get_datetime_dict_from_system()
	return (
		"%04d%02d%02d_%02d%02d%02d"
		% [
			int(d["year"]),
			int(d["month"]),
			int(d["day"]),
			int(d["hour"]),
			int(d["minute"]),
			int(d["second"]),
		]
	)
