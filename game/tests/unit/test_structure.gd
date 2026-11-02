extends GutTest
## Тесты конструктивной целостности точки интереса.
##
## КАКОЙ КЛАСС ОШИБОК ЛОВИТ. Разрушение отдельной панели работает само по
## себе, и тест на одну панель ничего не скажет о здании. Здесь проверяется
## связь между ними:
##
##   * снос перегородки не обрушает ничего — иначе дом складывается от
##     простенка между комнатами;
##   * снос несущих стен обрушает этаж выше — иначе стены исчезают, а крыша
##     висит в воздухе;
##   * порог срабатывает, а не «когда сломано всё»;
##   * обрушение не зацикливается на самом себе.
##
## Последний пункт важнее, чем выглядит: обрушение этажа разрушает его части,
## а они зарегистрированы здесь же, то есть обработчик вызывает обрушение из
## обрушения.

var _materials: MaterialLibrary = null
var _builder: InteriorBuilder = null
var _house_record: Dictionary = {}
var _bunker_record: Dictionary = {}
var _house: Node3D = null
var _bunker: Node3D = null


## Находит структуру точки интереса.
func _structure(root: Node3D) -> Structure:
	for child: Node in root.get_children():
		if child is Structure:
			return child as Structure
	return null


## Разрушаемые части этажа с нужными признаками.
func _parts(root: Node3D, floor_index: int, interior: bool, is_slab: bool) -> Array[Destructible]:
	var out: Array[Destructible] = []
	var stack: Array[Node] = [root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		for child: Node in node.get_children():
			stack.append(child)
		if not (node is Destructible):
			continue
		if int(node.get_meta("structure_floor", -1)) != floor_index:
			continue
		if bool(node.get_meta("structure_interior", false)) != interior:
			continue
		if bool(node.get_meta("structure_slab", false)) != is_slab:
			continue
		out.append(node as Destructible)
	return out


## Записи точек интереса берутся из настоящей планировки и создаются ОДИН
## раз: раскладка деревни тяжёлая (1500 деревьев), а узлы — нет.
func before_all() -> void:
	var terrain: TerrainGenerator = TerrainGenerator.new(MapConfig.DEFAULT_SEED)
	var layout: VillageLayout = VillageLayout.new(terrain, MapConfig.DEFAULT_SEED)
	layout.build()
	_house_record = layout.poi(VillageLayout.PoiKind.VILLAGE_HOUSE)
	_bunker_record = layout.poi(VillageLayout.PoiKind.BUNKER)


## Узлы строятся заново для каждой проверки.
##
## Общие узлы из before_all() освобождались бы autofree после первой
## проверки, и остальные тесты работали бы с мёртвым деревом. К тому же
## разрушение необратимо: начав со второго теста, проверка «порог ещё не
## превышен» увидела бы уже сломанные стены.
func before_each() -> void:
	assert_false(_house_record.is_empty(), "в планировке нет дома-точки интереса")
	assert_false(_bunker_record.is_empty(), "в планировке нет бункера")
	_materials = MaterialLibrary.new()
	_builder = InteriorBuilder.new(_materials)
	_house = _builder.build(_house_record)
	_bunker = _builder.build(_bunker_record)
	add_child_autofree(_house)
	add_child_autofree(_bunker)


func test_every_point_of_interest_has_a_structure() -> void:
	# Без структуры точка интереса — набор независимых панелей: разрушение
	# каждой работает, а здание в целом ведёт себя как декорация.
	assert_not_null(_structure(_house), "у дома нет Structure")
	assert_not_null(_structure(_bunker), "у бункера нет Structure")


func test_structure_is_a_child_not_a_sibling() -> void:
	# Структура обязана уезжать вместе с точкой интереса, когда поток
	# освобождает чанк. Отдельный узел в корне сцены пережил бы свой дом и
	# держал ссылки на освобождённые панели.
	assert_eq(_structure(_house).get_parent(), _house, "структура не внутри точки интереса")


func test_bearing_walls_are_registered() -> void:
	var structure: Structure = _structure(_house)
	var report: Dictionary = structure.report()
	assert_gt(int(report["bearing_total"]), 8, "несущих стен зарегистрировано подозрительно мало")
	assert_eq(int(report["bearing_lost"]), 0, "до разрушений что-то уже потеряно")


func test_partitions_are_not_counted_as_bearing() -> void:
	# Перегородки зарегистрированы, но в счётчик несущих не попадают: иначе
	# снос межкомнатной стены обрушил бы этаж.
	var structure: Structure = _structure(_house)
	var partitions: Array[Destructible] = _parts(_house, 0, true, false)
	var bearing_before: int = int(structure.report()["bearing_total"])
	assert_gt(partitions.size(), 0, "перегородок на первом этаже не найдено")
	for partition: Destructible in partitions:
		partition.destroy()
	assert_eq(
		int(structure.report()["bearing_total"]),
		bearing_before,
		"перегородки попали в счётчик несущих стен"
	)
	assert_gt(int(structure.report()["partitions_lost"]), 0, "снос перегородок не учтён в отчёте")


func test_destroying_partitions_collapses_nothing() -> void:
	var structure: Structure = _structure(_bunker)
	for partition: Destructible in _parts(_bunker, 0, true, false):
		partition.destroy()
	assert_false(structure.is_collapsed(1), "перегородки обрушили что-то выше")
	assert_eq(int(structure.report()["collapsed_floors"]), 0, "снос перегородок привёл к обрушению")


func test_house_has_a_roof_above_the_top_floor() -> void:
	# Крыша регистрируется этажом ВЫШЕ верхнего: обрушение верхнего этажа
	# обязано унести и её. Если крыши в реестре нет, она повиснет в воздухе.
	var structure: Structure = _structure(_house)
	var indices: Array = structure.floor_indices()
	assert_gt(indices.size(), 2, "у двухэтажного дома зарегистрировано %d уровней" % indices.size())
	# Уровень 2 — это крыша: этажей два (0 и 1), значит индекс выше верхнего.
	assert_true(indices.has(2), "крыша не зарегистрирована уровнем выше верхнего этажа")


func test_slab_threshold_is_stricter_than_wall_threshold() -> void:
	# Плита держит нагрузку напрямую, стена — через плиту. Поэтому половина
	# выбитого перекрытия обрушает этаж раньше, чем половина выбитых стен.
	assert_lt(
		Structure.SLAB_LOSS_RATIO, Structure.BEARING_LOSS_RATIO, "порог перекрытия мягче стенового"
	)
	assert_between(Structure.BEARING_LOSS_RATIO, 0.1, 0.9, "порог стен вне осмысленных границ")
	assert_between(Structure.SLAB_LOSS_RATIO, 0.1, 0.9, "порог плит вне осмысленных границ")


func test_destroying_bearing_walls_collapses_the_floor_above() -> void:
	var structure: Structure = _structure(_bunker)
	var walls: Array[Destructible] = _parts(_bunker, 0, false, false)
	assert_gt(walls.size(), 4, "у бункера слишком мало несущих стен для проверки")
	# Ломаем ровно столько, чтобы превысить порог, и ни одной лишней:
	# проверка обязана сработать ОТ ПОРОГА, а не от полного сноса.
	var needed: int = int(ceil(float(walls.size()) * Structure.BEARING_LOSS_RATIO))
	watch_signals(structure)
	for index: int in range(needed):
		walls[index].destroy()
	assert_true(structure.is_collapsed(1), "превышение порога не обрушило уровень выше")
	assert_signal_emitted(structure, "floor_collapsed", "сигнал обрушения не отправлен")


func test_partial_damage_does_not_collapse_anything() -> void:
	# Одна пробоина не должна складывать дом: иначе разрушение превращается
	# в мгновенное удаление уровня от любого попадания.
	var structure: Structure = _structure(_house)
	var walls: Array[Destructible] = _parts(_house, 0, false, false)
	assert_gt(walls.size(), 6, "мало несущих стен для проверки порога")
	walls[0].destroy()
	assert_false(structure.is_collapsed(1), "одна пробитая стена обрушила второй этаж")
	assert_eq(int(structure.report()["bearing_lost"]), 1, "потеря не учтена")


func test_collapse_is_idempotent() -> void:
	# Обрушение вызывается и порогом, и напрямую, и каскадом. Без защиты
	# повторный вызов резал бы уже погашенные панели второй раз и плодил
	# осколки из ничего.
	var structure: Structure = _structure(_house)
	var first: int = structure.collapse_floor(1)
	var second: int = structure.collapse_floor(1)
	assert_gt(first, 0, "первое обрушение ничего не разрушило")
	assert_eq(second, 0, "повторное обрушение разрушило ещё %d частей" % second)


func test_collapse_reaches_nested_destructibles() -> void:
	# Дверь — это Interactable с вложенным Destructible. Обход только детей
	# первого уровня её пропустил бы, и после обрушения этажа в проёме
	# осталась бы висеть закрытая дверь.
	var structure: Structure = _structure(_bunker)
	var destroyed: int = structure.collapse_floor(0)
	assert_gt(destroyed, 0, "обрушение этажа ничего не разрушило")
	var left: int = 0
	for part: Destructible in _parts(_bunker, 0, false, false):
		if not part.is_destroyed():
			left += 1
	assert_eq(left, 0, "после обрушения этажа осталось %d целых несущих стен" % left)


func test_report_exposes_every_counter() -> void:
	var report: Dictionary = _structure(_house).report()
	for key: String in [
		"root",
		"floors",
		"bearing_total",
		"bearing_lost",
		"slab_total",
		"slab_lost",
		"partitions_lost",
		"collapsed_floors",
		"destroyed",
	]:
		assert_has(report, key, "в отчёте целостности нет ключа «%s»" % key)
	assert_eq(String(report["root"]), String(_house.name), "отчёт не знает имени точки")


func test_structure_survives_a_detached_root() -> void:
	# Поток чанков освобождает точку интереса целиком. Структура обязана не
	# падать, если корень уже невалиден: её отчёт могут запросить оверлей
	# отладки или сохранение в тот же кадр.
	var detached: Node3D = Node3D.new()
	var structure: Structure = Structure.new()
	structure.configure(detached)
	detached.free()
	assert_eq(String(structure.report()["root"]), "без корня", "отчёт упал на мёртвом корне")
	structure.free()
