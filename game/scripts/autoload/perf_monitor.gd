extends Node
## PerfMonitor — непрерывная телеметрия производительности.
##
## «Оптимизация» без измерения — это религия. Этот сервис считает то, что
## реально влияет на ощущение игры:
##   * fps и время кадра (среднее, p95, худший кадр),
##   * сколько кадров подряд мы ниже порога (hitch-детектор),
##   * память (статическая + видеопамять),
##   * число draw call'ов и объектов сцены,
##   * физику: активные тела, число контактов.
##
## И главное — он УМЕЕТ сообщать QualityService, что пора понизить пресет.
## Это и есть адаптивное качество: на слабом железе игра сама становится
## играбельной вместо того, чтобы показывать слайд-шоу.

signal sample_ready(snapshot: Dictionary)

## Сколько кадров держим в скользящем окне статистики.
const WINDOW_SIZE: int = 120
## Как часто (в секундах) пересчитываем агрегаты и публикуем их.
## Каждый кадр — лишняя работа; 10 раз в секунду достаточно для UI.
const SAMPLE_INTERVAL: float = 0.1
## FPS, ниже которого начинаем считать деградацию.
const DEGRADED_FPS_THRESHOLD: float = 45.0
## Сколько подряд сэмплов должно быть ниже порога, чтобы заявить о проблеме.
## Один просевший кадр — это загрузка шейдера, а не деградация.
const DEGRADED_SAMPLES_REQUIRED: int = 3
## Кадр длиннее этого считается «тычком» (hitch).
const HITCH_FRAME_MS: float = 33.4

var _frame_times_ms: Array[float] = []
var _elapsed_since_sample: float = 0.0
var _degraded_streak: int = 0
var _hitch_count: int = 0
var _worst_frame_ms: float = 0.0
var _degradation_reported: bool = false
var _paused: bool = false
var _latest: Dictionary = {}


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_frame_times_ms.resize(WINDOW_SIZE)
	_frame_times_ms.fill(0.0)


func _process(delta: float) -> void:
	if _paused:
		return
	_record_frame(delta)
	_elapsed_since_sample += delta
	if _elapsed_since_sample < SAMPLE_INTERVAL:
		return
	_elapsed_since_sample = 0.0
	_latest = build_snapshot()
	_evaluate_degradation(_latest)
	sample_ready.emit(_latest)


## ---------------------------------------------------------------- метрики --


func current_fps() -> float:
	return float(Performance.get_monitor(Performance.TIME_FPS))


func process_time_ms() -> float:
	return float(Performance.get_monitor(Performance.TIME_PROCESS)) * 1000.0


func physics_time_ms() -> float:
	return float(Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS)) * 1000.0


func static_memory_mb() -> float:
	return float(OS.get_static_memory_usage()) / 1048576.0


func peak_memory_mb() -> float:
	return float(OS.get_static_memory_peak_usage()) / 1048576.0


func video_memory_mb() -> float:
	return float(Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED)) / 1048576.0


func draw_calls() -> int:
	return int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME))


func primitives() -> int:
	return int(Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME))


func node_count() -> int:
	return int(Performance.get_monitor(Performance.OBJECT_NODE_COUNT))


func object_count() -> int:
	return int(Performance.get_monitor(Performance.OBJECT_COUNT))


func resource_count() -> int:
	return int(Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT))


func active_physics_bodies_3d() -> int:
	return int(Performance.get_monitor(Performance.PHYSICS_3D_ACTIVE_OBJECTS))


func physics_collision_pairs() -> int:
	return int(Performance.get_monitor(Performance.PHYSICS_3D_COLLISION_PAIRS))


## Среднее время кадра по скользящему окну, миллисекунды.
func avg_frame_ms() -> float:
	if _frame_times_ms.is_empty():
		return 0.0
	var total: float = 0.0
	var counted: int = 0
	for value: float in _frame_times_ms:
		if value > 0.0:
			total += value
			counted += 1
	return (total / float(counted)) if counted > 0 else 0.0


## 95-й перцентиль времени кадра. Именно он описывает «игра дёргается»:
## среднее всегда красивое, а игрок чувствует хвост распределения.
func p95_frame_ms() -> float:
	return _percentile_frame_ms(0.95)


func worst_frame_ms() -> float:
	return _worst_frame_ms


func hitch_count() -> int:
	return _hitch_count


## ---------------------------------------------------------------- сводка ---


## Полный снимок метрик. Используется debug-оверлеем, логами и тестами.
func build_snapshot() -> Dictionary:
	return {
		"fps": current_fps(),
		"avg_frame_ms": avg_frame_ms(),
		"p95_frame_ms": p95_frame_ms(),
		"worst_frame_ms": _worst_frame_ms,
		"process_ms": process_time_ms(),
		"physics_ms": physics_time_ms(),
		"static_mem_mb": static_memory_mb(),
		"peak_mem_mb": peak_memory_mb(),
		"video_mem_mb": video_memory_mb(),
		"draw_calls": draw_calls(),
		"primitives": primitives(),
		"nodes": node_count(),
		"objects": object_count(),
		"resources": resource_count(),
		"physics_bodies": active_physics_bodies_3d(),
		"collision_pairs": physics_collision_pairs(),
		"hitches": _hitch_count,
	}


## Компактная строка для оверлея: две строки, всё главное.
func overlay_text() -> String:
	var s: Dictionary = _latest if not _latest.is_empty() else build_snapshot()
	return (
		(
			"FPS %d  frame %.2f ms (p95 %.2f, max %.2f)\n"
			% [
				int(s["fps"]),
				float(s["avg_frame_ms"]),
				float(s["p95_frame_ms"]),
				float(s["worst_frame_ms"]),
			]
		)
		+ (
			"draw %d  nodes %d  phys %d  mem %.0f MB  vram %.0f MB  hitch %d"
			% [
				int(s["draw_calls"]),
				int(s["nodes"]),
				int(s["physics_bodies"]),
				float(s["static_mem_mb"]),
				float(s["video_mem_mb"]),
				int(s["hitches"]),
			]
		)
	)


## Сброс статистики — нужен при смене уровня, чтобы цифры старого уровня
## не портили картину нового.
func reset() -> void:
	_frame_times_ms.fill(0.0)
	_hitch_count = 0
	_worst_frame_ms = 0.0
	_degraded_streak = 0
	_degradation_reported = false
	Diagnostics.debug("perf", "статистика сброшена")


func set_monitoring_paused(paused: bool) -> void:
	_paused = paused


func is_monitoring_paused() -> bool:
	return _paused


## --------------------------------------------------------------- приватное


func _record_frame(delta: float) -> void:
	var frame_ms: float = delta * 1000.0
	_frame_times_ms.pop_front()
	_frame_times_ms.append(frame_ms)
	if frame_ms > _worst_frame_ms:
		_worst_frame_ms = frame_ms
	if frame_ms > HITCH_FRAME_MS:
		_hitch_count += 1


func _percentile_frame_ms(percentile: float) -> float:
	var valid: Array[float] = []
	for value: float in _frame_times_ms:
		if value > 0.0:
			valid.append(value)
	if valid.is_empty():
		return 0.0
	valid.sort()
	var index: int = clampi(int(round(percentile * float(valid.size() - 1))), 0, valid.size() - 1)
	return valid[index]


func _evaluate_degradation(snapshot: Dictionary) -> void:
	var fps: float = float(snapshot["fps"])
	# Первые секунды после старта FPS недостоверен: компиляция шейдеров,
	# стриминг ассетов. Не реагируем, пока окно не заполнено.
	if snapshot["avg_frame_ms"] <= 0.0:
		return
	if fps < DEGRADED_FPS_THRESHOLD:
		_degraded_streak += 1
	else:
		_degraded_streak = 0
		_degradation_reported = false
	if _degraded_streak >= DEGRADED_SAMPLES_REQUIRED and not _degradation_reported:
		_degradation_reported = true
		var threshold: float = DEGRADED_FPS_THRESHOLD
		var p95: float = float(snapshot["p95_frame_ms"])
		Diagnostics.warn(
			"perf", "деградация: %.1f FPS (порог %.1f, p95 %.2f ms)" % [fps, threshold, p95]
		)
		EventBus.performance_degraded.emit(fps, DEGRADED_FPS_THRESHOLD)
