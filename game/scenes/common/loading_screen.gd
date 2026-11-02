extends CanvasLayer
## LoadingScreen — экран загрузки. Инстанцируется SceneService как CanvasLayer
## и добавляется ПРЯМО В КОРЕНЬ ДЕРЕВА, а не в текущую сцену: старая сцена
## уничтожается в середине загрузки, и экран, привязанный к ней, исчез бы
## вместе с ней — ровно в тот момент, когда он нужнее всего.
##
## layer = 100: поверх HUD (слой 10) и диалогов. Экран загрузки обязан
## перекрывать всё, иначе игрок видит полупостроенный уровень.
##
## mouse_filter = 2 (IGNORE) на корневом Control: экран не должен глотать
## ввод. Если загрузка завершится, а щёлк останется съеденным, игрок
## решит, что игра зависла.
##
## ПОДСКАЗКИ показываются на загрузке, а не в меню: именно в эти секунды
## игрок смотрит в экран и готов читать. В меню их никто не читает.

## Подсказки. Короткие, конкретные, про действия игрока — не «наслаждайтесь
## игрой». Подсказка, из которой нельзя извлечь действие, — шум.
const TIPS: Array[String] = [
	"Спринт расходует выносливость: чередуйте рывки с обычным бегом.",
	"Разрушаемые стены трескаются перед тем, как рухнуть — успейте отойти.",
	"F6 включает визуализацию коллизий: видно, где физика действительно есть.",
	"F4 — каркасный режим. Полезно проверить, что оптимизация не съела геометрию.",
	"Быстрое сохранение: F5. Быстрая загрузка: F9.",
	"Ветер усиливается волнами: трава предупреждает о порыве за секунду-две.",
	"Снизьте масштаб рендера до 80% — падение резкости почти незаметно, прирост FPS значительный.",
	"Разрушение считается в фоне: при падении FPS бюджет осколков снижается сам.",
	"Кнопка действия подсвечивается контуром, когда предмет доступен.",
	"F12 — снимок экрана без интерфейса.",
]

## Минимальная видимая длительность экрана, секунды. Загрузка из кэша
## занимает 40 мс, и мгновенное мелькание чёрного прямоугольника хуже,
## чем честные 300 мс.
const MIN_VISIBLE_SEC: float = 0.3
## Плавность прогресса: реальная загрузка скачет 0.05 -> 0.7 -> 0.72 -> 1.0.
## Ползунок, дёргающийся рывками, выглядит сломанным.
const PROGRESS_SMOOTHING: float = 8.0
const TIP_ROTATE_SEC: float = 4.0

var _current_path: String = ""
var _shown_at_msec: int = 0
var _target_progress: float = 0.0
var _displayed_progress: float = 0.0
var _tip_index: int = 0
var _tip_accumulator: float = 0.0
var _finished: bool = false
var _fade_out_tween: Tween = null


func _ready() -> void:
	_shown_at_msec = Time.get_ticks_msec()
	_tip_index = randi() % TIPS.size()
	%TipLabel.text = TIPS[_tip_index]
	%ProgressBar.value = 0.0
	EventBus.loading_progress.connect(_on_progress)
	EventBus.loading_screen_hidden.connect(_on_hidden)
	Diagnostics.debug("loading", "экран загрузки показан")


func _exit_tree() -> void:
	if EventBus.loading_progress.is_connected(_on_progress):
		EventBus.loading_progress.disconnect(_on_progress)
	if EventBus.loading_screen_hidden.is_connected(_on_hidden):
		EventBus.loading_screen_hidden.disconnect(_on_hidden)


func _process(delta: float) -> void:
	_smooth_progress(delta)
	_rotate_tips(delta)
	# Экран убирается не по сигналу загрузки, а когда прогресс дошёл до 1.0
	# И прошло минимальное время. Иначе он исчезает на 93% и игрок видит
	# недостроенный кадр.
	if _finished and _displayed_progress > 0.995:
		if Time.get_ticks_msec() - _shown_at_msec >= int(MIN_VISIBLE_SEC * 1000.0):
			_free_self()


func _smooth_progress(delta: float) -> void:
	# Экспоненциальное сглаживание, а не линейное: линейное «догоняет» цель
	# с постоянной скоростью и заметно тормозит на последних процентах.
	_displayed_progress += (
		(_target_progress - _displayed_progress) * clampf(PROGRESS_SMOOTHING * delta, 0.0, 1.0)
	)
	if _target_progress - _displayed_progress < 0.002:
		_displayed_progress = _target_progress
	%ProgressBar.value = _displayed_progress
	%DetailLabel.text = _detail_text()


## Подпись под прогрессом. Показывает реальный путь ресурса, а не
## заглушку «Загрузка…»: при зависании именно эта строка объясняет,
## какой ресурс не грузится.
func _detail_text() -> String:
	if _current_path.is_empty():
		return "Подготовка ресурсов…"
	var name_only: String = _current_path.get_file()
	if _displayed_progress > 0.995:
		return "%s — готово" % name_only
	return "%s — %d%%" % [name_only, int(round(_displayed_progress * 100.0))]


func _on_progress(path: String, value: float) -> void:
	_current_path = path
	_target_progress = clampf(value, 0.0, 1.0)


func _rotate_tips(delta: float) -> void:
	_tip_accumulator += delta
	if _tip_accumulator < TIP_ROTATE_SEC:
		return
	_tip_accumulator = 0.0
	var next_index: int = (_tip_index + 1) % TIPS.size()
	if next_index == _tip_index:
		return
	_tip_index = next_index
	# Смена подсказки с коротким затуханием: резкая замена текста читается
	# как глитч, плавная — как смена слайда.
	var tween: Tween = create_tween()
	tween.tween_property(%TipLabel, "modulate:a", 0.0, 0.16)
	tween.tween_callback(func() -> void: %TipLabel.text = TIPS[_tip_index])
	tween.tween_property(%TipLabel, "modulate:a", 1.0, 0.2)


func _on_hidden() -> void:
	# SceneService подал сигнал завершения — доводим анимацию до конца сами.
	_finished = true
	_target_progress = 1.0
	Diagnostics.debug("loading", "загрузка завершена, убираем экран")


func _free_self() -> void:
	if _fade_out_tween != null and _fade_out_tween.is_valid():
		return
	# Убираем себя сами, потому что SceneService мог освободить нас раньше
	# (queue_free из _hide_loader), а плавное затухание требует ещё пару
	# кадров жизни.
	# Затухаем через корневой Control, а не через сам CanvasLayer: у
	# CanvasLayer нет свойства modulate, и tween по несуществующему пути
	# молча не сделает ничего, оставив экран на экране.
	_fade_out_tween = create_tween()
	_fade_out_tween.tween_property($Root, "modulate:a", 0.0, 0.18)
	_fade_out_tween.tween_callback(queue_free)
