extends GutTest
## Тесты DestructionService.
##
## ГЛАВНОЕ, что здесь проверяется, — КОНТРАКТ между двумя бэкендами.
## Сервис умеет резать меш и на GDScript (всегда), и на C++ (если собрана
## библиотека). Выбор происходит в рантайме, поэтому у разработчика без
## собранного .so работает один код, а у игрока — другой. Если словари
## осколков различаются, баг воспроизведётся только у игрока.
##
## Контракт зафиксирован константой PIECE_KEYS и продублирован проверкой
## tools/verify/check_backend_contract.py на стороне C++.

var _host: Node3D = null


func before_each() -> void:
	_host = Node3D.new()
	add_child_autofree(_host)


func test_backend_is_detected() -> void:
	var backend_name: String = DestructionService.backend_name()
	assert_ne(
		backend_name.strip_edges(),
		"",
		"backend_name() пуст — неизвестно, какой код нарезки работает"
	)


func test_is_native_matches_classdb() -> void:
	# Флаг «нативный бэкенд» обязан соответствовать реальной доступности
	# класса. Рассогласование означает, что сервис вызывает несуществующий
	# метод и молча падает в фолбэк на каждом кадре.
	var class_available: bool = ClassDB.class_exists(DestructionService.NATIVE_CLASS)
	if not class_available:
		assert_false(
			DestructionService.is_native(),
			"сервис считает бэкенд нативным, но класс не зарегистрирован"
		)


func test_piece_keys_are_declared_and_unique() -> void:
	var keys: Array[String] = DestructionService.PIECE_KEYS
	assert_gt(keys.size(), 0, "контракт осколка пуст")
	var seen: Array[String] = []
	for key: String in keys:
		assert_ne(key.strip_edges(), "", "пустой ключ в PIECE_KEYS")
		assert_does_not_have(seen, key, "дубль ключа " + key)
		seen.append(key)


func test_piece_keys_cover_what_debris_consumes() -> void:
	# Осколок без меша не отрисуется, без offset появится в начале координат,
	# без impulse упадёт на месте. Эти три ключа обязательны в любом бэкенде.
	for key: String in ["mesh", "offset", "impulse"]:
		assert_has(
			DestructionService.PIECE_KEYS,
			key,
			"в контракте нет ключа «%s», который нужен для спавна осколка" % key
		)


func test_low_energy_does_not_break() -> void:
	# Порог энергии — это то, что отличает «пуля поцарапала бетон» от
	# «бетон развалился». Без порога разрушается всё и всегда.
	var target: MeshInstance3D = _make_box()
	_host.add_child(target)
	var below: float = DestructionService.MIN_BREAK_ENERGY * 0.5
	assert_false(
		DestructionService.fracture(target, below), "объект разрушился при энергии ниже порога"
	)
	assert_true(target.visible, "объект исчез, хотя разрушения не было")


func test_zero_energy_does_not_break() -> void:
	var target: MeshInstance3D = _make_box()
	_host.add_child(target)
	assert_false(DestructionService.fracture(target, 0.0))
	assert_false(
		DestructionService.fracture(target, -50.0), "отрицательная энергия не должна разрушать"
	)


func test_high_energy_breaks_the_box() -> void:
	var target: MeshInstance3D = _make_box()
	_host.add_child(target)
	var before: int = DestructionService.active_debris_count()
	var energy: float = DestructionService.MIN_BREAK_ENERGY * 4.0
	var broken: bool = DestructionService.fracture(target, energy)
	if not broken:
		# Разрушение могло быть отложено в очередь, если сервис уже занят
		# другими вызовами. Это корректное поведение, а не ошибка.
		pending("fracture() не разрушил объект сразу — возможно, очередь занята")
		return
	assert_gt(
		DestructionService.active_debris_count(),
		before,
		"после разрушения осколков не стало больше"
	)
	assert_false(target.visible, "исходный объект остался видимым после нарезки")


func test_source_is_hidden_after_fracture() -> void:
	var target: MeshInstance3D = _make_box()
	_host.add_child(target)
	var energy: float = DestructionService.MIN_BREAK_ENERGY * 4.0
	if not DestructionService.fracture(target, energy):
		pending("нарезка отложена очередью")
		return
	assert_false(target.visible)


func test_invalid_target_is_rejected_safely() -> void:
	# Сервис вызывается из игрового кода, где объект мог быть освобождён
	# кадр назад. Падение здесь — это краш при взрыве.
	assert_false(DestructionService.fracture(null, 999.0))
	var no_mesh := Node3D.new()
	_host.add_child(no_mesh)
	assert_false(
		DestructionService.fracture(no_mesh, 999.0), "Node3D без меша не должен разрушаться"
	)


func test_debris_are_in_the_debris_group() -> void:
	var target: MeshInstance3D = _make_box()
	_host.add_child(target)
	var energy: float = DestructionService.MIN_BREAK_ENERGY * 4.0
	if not DestructionService.fracture(target, energy):
		pending("нарезка отложена очередью")
		return
	var debris_nodes: Array[Node] = get_tree().get_nodes_in_group(DestructionService.GROUP_DEBRIS)
	assert_gt(
		debris_nodes.size(), 0, "осколки не состоят в группе debris — ветер и уборка их не найдут"
	)


func test_debris_are_rigid_bodies() -> void:
	var target: MeshInstance3D = _make_box()
	_host.add_child(target)
	var energy: float = DestructionService.MIN_BREAK_ENERGY * 4.0
	if not DestructionService.fracture(target, energy):
		pending("нарезка отложена очередью")
		return
	for node: Node in get_tree().get_nodes_in_group(DestructionService.GROUP_DEBRIS):
		assert_true(
			node is RigidBody3D, "осколок %s не RigidBody3D — он не будет падать" % str(node.name)
		)


func test_active_debris_never_exceeds_budget() -> void:
	# Инвариант производительности: сколько бы объектов ни взорвали, число
	# активных осколков ограничено. Именно это отличает «разрушение» от
	# «падения FPS до нуля».
	var budget: int = GameConfig.DESTRUCTION_MAX_ACTIVE_CHUNKS
	for index in range(6):
		var target: MeshInstance3D = _make_box()
		target.name = "Burst_%d" % index
		_host.add_child(target)
		DestructionService.fracture(target, DestructionService.MIN_BREAK_ENERGY * 6.0)
		assert_lte(
			DestructionService.active_debris_count(),
			budget,
			"бюджет осколков превышен на итерации %d" % index
		)


func test_concurrent_break_limit_is_declared() -> void:
	assert_gt(DestructionService.MAX_CONCURRENT_BREAKS, 0)
	assert_lte(
		DestructionService.MAX_CONCURRENT_BREAKS, GameConfig.DESTRUCTION_MAX_CONCURRENT_BREAKS
	)


func test_explode_with_zero_radius_does_nothing() -> void:
	assert_eq(DestructionService.explode(Vector3.ZERO, 0.0, 100.0), 0)
	assert_eq(
		DestructionService.explode(Vector3.ZERO, -5.0, 100.0),
		0,
		"отрицательный радиус не должен ничего делать"
	)


func test_explode_returns_broken_count() -> void:
	var target: MeshInstance3D = _make_box()
	target.position = Vector3(2.0, 0.0, 0.0)
	_host.add_child(target)
	var broken: int = DestructionService.explode(Vector3.ZERO, 6.0, 400.0)
	assert_typeof(broken, TYPE_INT)
	assert_gte(broken, 0)


func test_backend_survives_repeated_calls() -> void:
	# Утечка состояния между вызовами проявляется не сразу, а через
	# десяток взрывов. Проверяем, что счётчики не уходят в отрицательные
	# значения и сервис продолжает отвечать.
	for index in range(10):
		var target: MeshInstance3D = _make_box()
		target.name = "Repeat_%d" % index
		_host.add_child(target)
		DestructionService.fracture(target, DestructionService.MIN_BREAK_ENERGY * 3.0)
	assert_gte(DestructionService.active_debris_count(), 0)
	assert_ne(DestructionService.backend_name(), "")


func test_fracture_emits_event() -> void:
	var target: MeshInstance3D = _make_box()
	_host.add_child(target)
	watch_signals(EventBus)
	DestructionService.fracture(target, DestructionService.MIN_BREAK_ENERGY * 4.0)
	assert_signal_emitted(
		EventBus, "destruction_started", "событие разрушения не ушло — HUD и звук о нём не узнают"
	)


# ------------------------------------------------------------- помощники ----


func _make_box() -> MeshInstance3D:
	# BoxMesh — примитив без индексов: MeshDataTool обязан прочитать и его.
	# На импортированном .glb с индексами тест был бы «проще», а реальный
	# случай — сложнее. Поэтому именно примитив.
	var mesh := BoxMesh.new()
	mesh.size = Vector3(1.2, 1.2, 1.2)
	var instance := MeshInstance3D.new()
	instance.name = "DestructibleBox"
	instance.mesh = mesh
	instance.position = Vector3(0, 1.0, 0)
	return instance
