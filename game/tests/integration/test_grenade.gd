extends GutTest
## Интеграционные тесты гранаты и разрушения от взрыва.
##
## КАКОЙ КЛАСС ОШИБОК ЛОВИТ. Граната — единственный способ игрока запустить
## разрушение, и она соединяет четыре подсистемы: ввод, физику снаряда,
## DestructionService и геометрию точки интереса. Каждая из них может быть
## корректна сама по себе и не работать вместе:
##
##   * снаряд в иерархии игрока летает вместе с ним и взрывается в руках;
##   * слой игрока в маске столкновений — то же самое, но в первом кадре;
##   * взрыватель не тикает, потому что физический процесс выключен;
##   * повторное срабатывание режет уже погашенные панели второй раз.
##
## Здесь проверяется связка целиком, на настоящем бункере из планировки карты.

var _materials: MaterialLibrary = null
var _builder: InteriorBuilder = null
var _bunker_record: Dictionary = {}


func before_all() -> void:
	var terrain: TerrainGenerator = TerrainGenerator.new(MapConfig.DEFAULT_SEED)
	var layout: VillageLayout = VillageLayout.new(terrain, MapConfig.DEFAULT_SEED)
	layout.build()
	_bunker_record = layout.poi(VillageLayout.PoiKind.BUNKER)


func before_each() -> void:
	assert_false(_bunker_record.is_empty(), "в планировке нет бункера")
	_materials = MaterialLibrary.new()
	_builder = InteriorBuilder.new(_materials)


## Граната в дереве, готовая к проверкам.
func _spawn_grenade(thrower: Node3D = null) -> Grenade:
	var grenade: Grenade = Grenade.new()
	grenade.configure(thrower)
	add_child_autofree(grenade)
	return grenade


## Разрушаемые потомки узла.
func _destructibles(root: Node) -> Array[Destructible]:
	var out: Array[Destructible] = []
	var stack: Array[Node] = [root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		for child: Node in node.get_children():
			stack.append(child)
		if node is Destructible:
			out.append(node as Destructible)
	return out


func test_grenade_sits_on_the_projectile_layer() -> void:
	# Слой снаряда обязателен: на слое мира граната считалась бы частью
	# неподвижной геометрии, а на слое игрока — самим игроком для чужих лучей.
	var grenade: Grenade = _spawn_grenade()
	assert_eq(
		grenade.collision_layer,
		GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.PROJECTILE),
		"граната не на слое снарядов"
	)


func test_grenade_does_not_collide_with_players() -> void:
	# РЕГРЕССИОННАЯ ПРОВЕРКА. Слой игрока в маске означал бы, что снаряд
	# сталкивается с метателем в первый же кадр и взрывается у него в руках.
	var mask: int = _spawn_grenade().collision_mask
	assert_eq(
		mask & GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.PLAYER),
		0,
		"маска гранаты включает слой игрока"
	)


func test_grenade_hits_the_world_and_debris() -> void:
	# Без слоя мира снаряд проваливается сквозь рельеф и взрывается под
	# картой; без слоя осколков — пролетает сквозь уже разрушенные стены.
	var mask: int = _spawn_grenade().collision_mask
	assert_ne(
		mask & GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD),
		0,
		"граната не сталкивается с миром"
	)
	assert_ne(
		mask & GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.DEBRIS),
		0,
		"граната пролетает сквозь осколки"
	)


func test_thrower_gets_a_collision_exception() -> void:
	# Исключение коллизий — вторая защита после маски: капсула игрока может
	# оказаться на пути снаряда в первый кадр даже без общего слоя.
	var thrower: CharacterBody3D = CharacterBody3D.new()
	thrower.collision_layer = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.PLAYER)
	add_child_autofree(thrower)
	var grenade: Grenade = _spawn_grenade(thrower)
	# get_collision_exceptions() возвращает массив разом. Методов
	# get_collision_exception_count()/get_collision_exception_with(i) в
	# Godot 4.5 НЕТ: они есть только у 2D-аналога, и попытка вызвать их
	# дала бы ошибку уже в рантайме.
	var exceptions: Array[Node3D] = grenade.get_collision_exceptions()
	assert_true(exceptions.has(thrower), "метатель не исключён из коллизий гранаты")


func test_launch_adds_an_upward_component() -> void:
	# Бросок строго по взгляду роняет гранату под ноги: камера смотрит почти
	# горизонтально, а баллистика требует подъёма.
	var grenade: Grenade = _spawn_grenade()
	grenade.launch(Vector3(0.0, 0.0, -1.0))
	assert_gt(grenade.linear_velocity.y, 0.0, "граната брошена без подъёма")
	assert_gt(
		grenade.linear_velocity.length(), 1.0, "скорость броска почти нулевая — снаряд упадёт у ног"
	)


func test_launch_normalises_the_direction() -> void:
	# Вызывающая сторона передаёт направление взгляда, а не вектор скорости.
	# Без нормализации дальность броска зависела бы от длины вектора камеры.
	var grenade: Grenade = _spawn_grenade()
	grenade.launch(Vector3(0.0, 0.0, -7.5))
	assert_almost_eq(
		grenade.linear_velocity.length(),
		Grenade.THROW_SPEED * sqrt(1.0 + Grenade.THROW_UPWARD * Grenade.THROW_UPWARD),
		0.05,
		"длина вектора направления изменила скорость броска"
	)


func test_fuse_is_idle_until_launched() -> void:
	# Граната, лежащая на земле у игрока, обязана ждать броска. Тикающий с
	# момента создания узла взрыватель взорвал бы её прямо в руках.
	var grenade: Grenade = _spawn_grenade()
	assert_false(grenade.is_armed(), "взрыватель взведён до броска")
	assert_false(grenade.is_physics_processing(), "физический процесс идёт до броска")
	assert_eq(grenade.remaining_fuse(), 0.0, "взрыватель отсчитывает время до броска")
	grenade.launch(Vector3.FORWARD)
	assert_true(grenade.is_armed(), "взрыватель не взведён после броска")
	# РЕГРЕССИОННАЯ ПРОВЕРКА: _ready() выключает физический процесс, и без
	# включения в launch() время никогда не пошло бы.
	assert_true(
		grenade.is_physics_processing(),
		"после броска физический процесс выключен — взрыватель не тикает"
	)
	assert_almost_eq(grenade.remaining_fuse(), Grenade.FUSE_SECONDS, 0.01, "время взрывателя")


func test_detonation_emits_both_signals() -> void:
	# Локальный сигнал — для того, кто бросил. Событие шины — для тряски
	# камеры, звука и статистики: им нельзя требовать ссылку на снаряд.
	var grenade: Grenade = _spawn_grenade()
	watch_signals(grenade)
	watch_signals(EventBus)
	grenade.launch(Vector3.FORWARD)
	grenade.detonate()
	assert_signal_emitted(grenade, "exploded", "локальный сигнал взрыва не отправлен")
	assert_signal_emitted(EventBus, "explosion_occurred", "событие взрыва не дошло до шины")


func test_detonation_leaves_no_physics_body_behind() -> void:
	# Корпус в эпицентре мешал бы разлетаться осколкам: твёрдый объект
	# размером с гранату стоит ровно там, где только что всё разнесло.
	var grenade: Grenade = _spawn_grenade()
	grenade.launch(Vector3.FORWARD)
	grenade.detonate()
	assert_eq(grenade.collision_layer, 0, "после взрыва остался слой коллизий")
	assert_eq(grenade.collision_mask, 0, "после взрыва осталась маска коллизий")
	assert_true(grenade.freeze, "корпус после взрыва продолжает летать")
	assert_true(grenade.is_detonated(), "флаг подрыва не выставлен")


func test_second_detonation_is_ignored() -> void:
	# Подрыв может прийти и от взрывателя, и от контакта, и от цепной
	# реакции. Повторный вызов породил бы второй взрыв в той же точке и
	# удвоил число осколков.
	var grenade: Grenade = _spawn_grenade()
	grenade.launch(Vector3.FORWARD)
	watch_signals(grenade)
	grenade.detonate()
	grenade.detonate()
	assert_signal_emit_count(grenade, "exploded", 1, "взрыв сработал дважды")


func test_explosion_breaks_the_bunker_interior() -> void:
	# Сквозная проверка: граната внутри настоящего бункера обязана что-то
	# разрушить. Если этого не происходит, вся система разрушения мертва —
	# при том, что каждый её модуль по отдельности тесты проходит.
	var bunker: Node3D = _builder.build(_bunker_record)
	add_child_autofree(bunker)
	var parts: Array[Destructible] = _destructibles(bunker)
	assert_gt(parts.size(), 20, "в бункере слишком мало разрушаемых частей")

	var grenade: Grenade = _spawn_grenade()
	grenade.global_position = bunker.global_position
	grenade.explosion_radius = MapConfig.EXPLOSION_RADIUS
	grenade.detonate()

	var destroyed: int = 0
	for part: Destructible in parts:
		if part.is_destroyed():
			destroyed += 1
	assert_gt(destroyed, 0, "взрыв в центре бункера не разрушил ничего")


func test_glass_breaks_before_concrete() -> void:
	# Требование «стёкла бьются физично» начинается с порядка: стекло обязано
	# сдаваться первым. Проверка на настоящей геометрии, а не на таблицах.
	var bunker: Node3D = _builder.build(_bunker_record)
	add_child_autofree(bunker)
	var glass_energy: float = INF
	var wall_energy: float = 0.0
	for part: Destructible in _destructibles(bunker):
		if String(part.name).begins_with("window_"):
			glass_energy = minf(glass_energy, part.break_energy)
		elif String(part.name).begins_with("panel_"):
			wall_energy = maxf(wall_energy, part.break_energy)
	assert_lt(glass_energy, INF, "в бункере нет стёкол")
	assert_lt(
		glass_energy,
		wall_energy,
		"стекло (%.1f) требует не меньше энергии, чем стена (%.1f)" % [glass_energy, wall_energy]
	)


func test_glass_pane_is_subdivided_into_shards() -> void:
	# РЕГРЕССИОННАЯ ПРОВЕРКА. Фолбэк-нарезка делит меш на группы ГРАНЕЙ, а у
	# BoxMesh их двенадцать: окно разбивалось бы на десяток крупных листов.
	# Требование «бьётся» упирается в количество геометрии, а не в прочность.
	var bunker: Node3D = _builder.build(_bunker_record)
	add_child_autofree(bunker)
	var checked: int = 0
	for part: Destructible in _destructibles(bunker):
		if not String(part.name).begins_with("window_"):
			continue
		var mesh: Mesh = part.get_fracture_mesh()
		assert_not_null(mesh, "у стекла нет меша для нарезки")
		if mesh == null:
			continue
		assert_gt(
			mesh.get_faces().size(),
			36,
			(
				"панель стекла не разбита на осколки: %d вершин, как у обычного бокса"
				% mesh.get_faces().size()
			)
		)
		checked += 1
	assert_gt(checked, 0, "стёкол для проверки не найдено")


func test_glass_declares_its_own_fracture_cell() -> void:
	# Общая ячейка 0,5 м толще самой панели (6 см), поэтому нативный
	# воксельный бэкенд дал бы один кусок на всё окно.
	var bunker: Node3D = _builder.build(_bunker_record)
	add_child_autofree(bunker)
	for part: Destructible in _destructibles(bunker):
		if not String(part.name).begins_with("window_"):
			continue
		assert_gt(part.fracture_cell_size, 0.0, "стекло не задаёт собственную ячейку нарезки")
		assert_lt(
			part.fracture_cell_size,
			GameConfig.DESTRUCTION_CELL_SIZE,
			"ячейка стекла не мельче общей — смысл теряется"
		)


func test_walls_keep_the_shared_fracture_cell() -> void:
	# Обратная сторона предыдущей проверки: собственная ячейка нужна тонким
	# предметам, а не всем подряд. Мельчение стен взорвало бы бюджет осколков.
	var bunker: Node3D = _builder.build(_bunker_record)
	add_child_autofree(bunker)
	var checked: int = 0
	for part: Destructible in _destructibles(bunker):
		if not String(part.name).begins_with("panel_"):
			continue
		assert_almost_eq(
			part.fracture_cell_size,
			0.0,
			0.001,
			"стена «%s» задала собственную ячейку нарезки" % part.name
		)
		checked += 1
	assert_gt(checked, 0, "панелей для проверки не найдено")


func test_service_reports_queued_breaks_separately() -> void:
	# Три состояния вместо двух. Отложенный объект НЕЛЬЗЯ считать отказом:
	# растворение здесь и сейчас оставило бы очередь резать мёртвый узел.
	assert_true(
		DestructionService.FractureResult.values().size() == 3,
		(
			"у результата нарезки %d состояний вместо трёх"
			% DestructionService.FractureResult.values().size()
		)
	)
	assert_ne(
		DestructionService.FractureResult.QUEUED,
		DestructionService.FractureResult.REJECTED,
		"очередь и отказ оказались одним состоянием"
	)
