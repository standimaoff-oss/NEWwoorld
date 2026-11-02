extends Node
## SceneService — переходы между сценами через потоковую загрузку.
##
## ЗАЧЕМ. `get_tree().change_scene_to_file()` грузит сцену в основном
## потоке: игра замирает на 0.5–3 секунды с чёрным экраном. Это ощущается
## как сломанная игра, а не как загрузка уровня.
##
## Здесь: запрос грузится в фоне (`load_threaded_request`), показывается
## экран загрузки с реальным прогрессом, старая сцена живёт до последнего
## кадра, и только когда новая готова — происходит подмена. Плюс история
## переходов, чтобы «Назад» в меню работал, а не закрывал игру.

## Ниже этого прогресса экран загрузки не показываем: мгновенная смена
## сцены не нуждается в заставке, а мигание заставки раздражает.
const MIN_PROGRESS_TO_SHOW_LOADER: float = 0.06
const HISTORY_LIMIT: int = 16

var _loading_path: String = ""
var _loading_active: bool = false
var _history: Array[String] = []
var _loader_screen: CanvasLayer = null
var _pending_after_load: String = ""


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	# Другие системы просят переход, эмитя scene_change_requested.
	# Сами мы этот сигнал НЕ эмитим — иначе получилась бы рекурсия.
	EventBus.scene_change_requested.connect(_on_change_requested)


func _on_change_requested(path: String) -> void:
	change_to(path, true)


## Запрашивает переход. Можно звать из любого места — дубликаты запросов
## на ту же сцену игнорируются, чтобы двойной клик не грузил уровень дважды.
func change_to(path: String, record_history: bool = true) -> bool:
	if path.is_empty():
		Diagnostics.error("scene", "change_to: пустой путь")
		return false
	if _loading_active:
		Diagnostics.warn(
			"scene", "загрузка уже идёт (%s), запрос %s в очередь" % [_loading_path, path]
		)
		_pending_after_load = path
		return false
	if not ResourceLoader.exists(path):
		Diagnostics.error("scene", "сцена не найдена: " + path)
		EventBus.fatal_error_occurred.emit("scene", "сцена не найдена: " + path)
		return false

	if record_history:
		var current: String = current_scene_path()
		if not current.is_empty():
			_history.append(current)
			if _history.size() > HISTORY_LIMIT:
				_history.pop_front()

	_loading_path = path
	_loading_active = true
	var err: int = ResourceLoader.load_threaded_request(path)
	if err != OK:
		Diagnostics.error("scene", "load_threaded_request вернул %d" % err)
		_loading_active = false
		_loading_path = ""
		return false
	Diagnostics.info("scene", "запрошена загрузка: " + path)
	return true


## Переход «Назад» по истории.
func go_back() -> bool:
	if _history.is_empty():
		return false
	var path: String = _history.pop_back()
	return change_to(path, false)


func history() -> Array[String]:
	return _history.duplicate()


func current_scene_path() -> String:
	var scene: Node = get_tree().current_scene
	return scene.scene_file_path if scene != null else ""


func is_loading() -> bool:
	return _loading_active


## Прогресс текущей загрузки, 0.0..1.0
func loading_progress() -> float:
	if not _loading_active:
		return 0.0
	var progress: Array = []
	ResourceLoader.load_threaded_get_status(_loading_path, progress)
	if progress.is_empty():
		return 0.0
	return clampf(float(progress[0]), 0.0, 1.0)


func _process(_delta: float) -> void:
	if not _loading_active:
		return
	var progress: Array = []
	var status: int = ResourceLoader.load_threaded_get_status(_loading_path, progress)
	var value: float = clampf(float(progress[0]) if not progress.is_empty() else 0.0, 0.0, 1.0)
	EventBus.loading_progress.emit(_loading_path, value)

	if value > MIN_PROGRESS_TO_SHOW_LOADER and _loader_screen == null:
		_show_loader()

	match status:
		ResourceLoader.THREAD_LOAD_IN_PROGRESS:
			return
		ResourceLoader.THREAD_LOAD_LOADED:
			_finish_load()
		ResourceLoader.THREAD_LOAD_FAILED:
			Diagnostics.error("scene", "загрузка провалена: " + _loading_path)
			_abort_load()
		ResourceLoader.THREAD_LOAD_INVALID_RESOURCE:
			Diagnostics.error("scene", "некорректный ресурс: " + _loading_path)
			_abort_load()


func _finish_load() -> void:
	var packed: PackedScene = ResourceLoader.load_threaded_get(_loading_path)
	var path: String = _loading_path
	_loading_active = false
	_loading_path = ""

	if packed == null:
		Diagnostics.error("scene", "load_threaded_get вернул null для " + path)
		_abort_load()
		return

	var instance: Node = packed.instantiate()
	if instance == null:
		Diagnostics.error("scene", "не удалось инстанцировать " + path)
		_abort_load()
		return

	# Порядок важен: сначала убираем старую сцену из дерева, потом ставим
	# новую. Иначе два current_scene сосуществуют кадр и дважды обрабатывают
	# ввод — классический баг «двойной прыжок при загрузке уровня».
	var old: Node = get_tree().current_scene
	if old != null:
		get_tree().root.remove_child(old)
		old.queue_free()

	get_tree().root.add_child(instance)
	get_tree().current_scene = instance
	PerfMonitor.reset()
	_hide_loader()
	Diagnostics.info("scene", "сцена загружена: " + path)

	if not _pending_after_load.is_empty():
		var next: String = _pending_after_load
		_pending_after_load = ""
		change_to(next)


func _abort_load() -> void:
	_loading_active = false
	_loading_path = ""
	_pending_after_load = ""
	_hide_loader()


func _show_loader() -> void:
	if not ResourceLoader.exists(GameConfig.SCENE_LOADING):
		return
	var packed: PackedScene = load(GameConfig.SCENE_LOADING)
	if packed == null:
		return
	_loader_screen = packed.instantiate() as CanvasLayer
	if _loader_screen == null:
		return
	# Свой слой, а не child текущей сцены: экран загрузки должен пережить
	# уничтожение старой сцены.
	get_tree().root.add_child(_loader_screen)
	EventBus.loading_screen_shown.emit()


func _hide_loader() -> void:
	if _loader_screen == null:
		return
	_loader_screen.queue_free()
	_loader_screen = null
	EventBus.loading_screen_hidden.emit()
