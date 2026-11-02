class_name ObjectPool
extends RefCounted
## ObjectPool — пул переиспользуемых нод.
##
## ЗАЧЕМ. `instantiate()` + `queue_free()` для каждого осколка/пули/эффекта
## — это аллокации, сборка мусора и, главное, hitch: один кадр на 200
## свободных объектов легко стоит 15 мс. Игрок видит это как рывок в момент
## взрыва, то есть ровно тогда, когда плавность важнее всего.
##
## Пул создаёт объекты ЗАРАНЕЕ (prewarm) и возвращает их в очередь вместо
## удаления. Цена — память; выигрыш — стабильное время кадра.
##
## ИСПОЛЬЗОВАНИЕ:
##     var pool := ObjectPool.new(scene, 64, 256)
##     var shard: Node3D = pool.acquire() as Node3D
##     ...
##     pool.release(shard)
##
## Объект при выдаче проходит `_on_acquire()` и при возврате `_on_release()`,
## если такие методы у него есть — это место для сброса состояния.

signal pool_exhausted(requested: int, capacity: int)
signal pool_stats_changed(in_use: int, capacity: int)

## Сцена-образец. Держим как PackedScene, а не как готовый узел:
## PackedScene занимает существенно меньше памяти.
var _prototype: PackedScene = null
var _free_list: Array[Node] = []
var _all: Array[Node] = []
var _host: Node = null
var _min_size: int = 0
var _max_size: int = 0
var _acquired_count: int = 0
var _peak_in_use: int = 0
var _total_acquires: int = 0
var _total_creates: int = 0
var _overflow_dropped: int = 0


## `host` — узел, в который добавляются объекты пула. Обычно это
## контейнер в сцене уровня, чтобы очистка уровня чистила и пул.
func _init(
	prototype: PackedScene, min_size: int = 16, max_size: int = 128, host: Node = null
) -> void:
	if prototype == null:
		push_error("ObjectPool: prototype == null")
		return
	_prototype = prototype
	_min_size = maxi(0, min_size)
	_max_size = maxi(_min_size, max_size)
	_host = host


## Предварительный прогрев: создаём min_size объектов сразу, чтобы первый
## взрыв в игре не платил за создание осколков.
func prewarm() -> int:
	var created: int = 0
	while _all.size() < _min_size:
		var node: Node = _create_one()
		if node == null:
			break
		created += 1
	if created > 0:
		_stash_all_free()
	return created


## Выдаёт объект. Если свободных нет и лимит не выбран — создаёт новый.
## Если лимит выбран — возвращает null и эмитит pool_exhausted: вызывающий
## код ОБЯЗАН это обработать, а не молча терять эффект.
func acquire() -> Node:
	_total_acquires += 1
	if not _free_list.is_empty():
		return _activate(_free_list.pop_back())
	if _all.size() >= _max_size:
		_overflow_dropped += 1
		pool_exhausted.emit(_acquired_count, _max_size)
		return null
	return _activate(_create_one())


## Возвращает объект в пул. Узел не удаляется, а деактивируется.
func release(node: Node) -> void:
	if node == null:
		return
	if not _all.has(node):
		Diagnostics.warn("pool", "release: объект не из этого пула — освобождаем")
		node.queue_free()
		return
	if _free_list.has(node):
		Diagnostics.warn("pool", "release: двойной возврат объекта (уже в пуле)")
		return
	_deactivate(node)
	_free_list.append(node)
	_acquired_count = maxi(0, _acquired_count - 1)
	pool_stats_changed.emit(_acquired_count, _max_size)


## Возвращает все выданные объекты. Вызывается при очистке уровня.
func release_all_active() -> void:
	for node: Node in _all:
		if is_instance_valid(node) and not _free_list.has(node):
			_deactivate(node)
			_free_list.append(node)
	_acquired_count = 0
	pool_stats_changed.emit(0, _max_size)


## Полная очистка: освобождает память. Используется при выходе в меню.
func clear() -> void:
	for node: Node in _all:
		if is_instance_valid(node):
			node.queue_free()
	_all.clear()
	_free_list.clear()
	_acquired_count = 0


func in_use() -> int:
	return _acquired_count


func available() -> int:
	return _free_list.size()


func capacity() -> int:
	return _max_size


func total_created() -> int:
	return _total_creates


func peak_in_use() -> int:
	return _peak_in_use


func dropped_due_to_overflow() -> int:
	return _overflow_dropped


func stats() -> Dictionary:
	return {
		"in_use": _acquired_count,
		"free": _free_list.size(),
		"total_objects": _all.size(),
		"capacity": _max_size,
		"peak_in_use": _peak_in_use,
		"acquires": _total_acquires,
		"created": _total_creates,
		"dropped": _overflow_dropped,
	}


## Доля запросов, которые пул обслужил без создания нового объекта.
## Ключевая метрика качества настройки: ниже 0.9 — пул мал, будут hitch'и.
func reuse_ratio() -> float:
	if _total_acquires == 0:
		return 1.0
	var served_from_pool: int = _total_acquires - _total_creates
	return clampf(float(served_from_pool) / float(_total_acquires), 0.0, 1.0)


# ---------------------------------------------------------------- приватное


func _create_one() -> Node:
	var node: Node = _prototype.instantiate()
	if node == null:
		Diagnostics.error("pool", "instantiate() вернул null")
		return null
	_total_creates += 1
	_all.append(node)
	if _host != null and is_instance_valid(_host):
		_host.add_child(node)
	elif node.get_parent() == null:
		# Пул без хоста — добавляем в текущую сцену, иначе узел «висит»
		# вне дерева и его _ready() никогда не вызовется.
		var tree: SceneTree = Engine.get_main_loop() as SceneTree
		if tree != null and tree.current_scene != null:
			tree.current_scene.add_child(node)
	return node


func _activate(node: Node) -> Node:
	if node == null:
		return null
	if node.has_method("_on_acquire"):
		node.call("_on_acquire")
	if node is CanvasItem:
		(node as CanvasItem).visible = true
	if node is Node3D:
		(node as Node3D).top_level = false
	_acquired_count += 1
	_peak_in_use = maxi(_peak_in_use, _acquired_count)
	pool_stats_changed.emit(_acquired_count, _max_size)
	return node


func _deactivate(node: Node) -> void:
	if not is_instance_valid(node):
		return
	if node.has_method("_on_release"):
		node.call("_on_release")
	if node is CanvasItem:
		(node as CanvasItem).visible = false
	# Физическое тело усыпляем: спящий объект не участвует в broadphase
	# и не стоит ничего. 500 «мёртвых» осколков в пуле без этого —
	# 500 активных тел в физическом мире.
	if node is RigidBody3D:
		var body := node as RigidBody3D
		body.freeze = true
		body.linear_velocity = Vector3.ZERO
		body.angular_velocity = Vector3.ZERO
	if node is GPUParticles3D:
		(node as GPUParticles3D).emitting = false


func _stash_all_free() -> void:
	_free_list.clear()
	for node: Node in _all:
		_deactivate(node)
		_free_list.append(node)
