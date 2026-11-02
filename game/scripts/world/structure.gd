class_name Structure
extends Node
## Конструктивная целостность точки интереса: что держит что.
##
## ЗАЧЕМ ОТДЕЛЬНО ОТ DestructionService. Сервис разрушает ОДИН объект и
## намеренно ничего не знает о зданиях: он режет меш на осколки. Но снос
## несущей стены обязан иметь последствия для того, что на ней стоит. Без
## этого дом разбирается по панельке и продолжает стоять — визуально выглядит
## как «стены исчезают, а крыша висит в воздухе», и именно это чаще всего
## называют «неправдоподобным разрушением».
##
## ЧТО ИМЕННО ЗДЕСЬ РЕШАЕТСЯ. Различие несущей стены и перегородки приходит
## из данных планировки: каждая панель знает свой этаж и признак внутренней
## стены (RoomLayout помечает их при построении). Перегородка не держит
## ничего, кроме собственного веса, и её снос не обрушает ничего.
##
## КАСКАД. Обрушение этажа разрушает его панели, а они зарегистрированы
## здесь же — поэтому обрушение может запустить обрушение следующего этажа.
## Рекурсия защищена пометкой «уже обрушен» ДО обхода, иначе этаж, держащий
## сам себя, зациклился бы. Та же рекурсия делает существенным различие
## «отложено в очередь» и «отклонено» в DestructionService.

## Этаж обрушился. `floor_index` — номер обрушенного этажа.
signal floor_collapsed(structure: Structure, floor_index: int)

## Доля потерянных несущих панелей этажа, после которой этаж выше обрушается.
##
## Не 1.0 и не 0.0: при единице дом стоял бы, пока не снесена последняя
## стена, а при нуле обрушение начиналось бы от одной пробоины.
const BEARING_LOSS_RATIO: float = 0.45
## Доля потерянных плит перекрытия, после которой этаж выше обрушивается.
##
## Порог ниже стенового: плита держит нагрузку напрямую, и половина
## выбитого перекрытия — это уже не перекрытие.
const SLAB_LOSS_RATIO: float = 0.5

var _root: Node3D = null
## Номер этажа -> контейнер его узлов.
var _floors: Dictionary = {}
## Номер этажа -> {"total": int, "lost": int} для несущих панелей.
var _bearing: Dictionary = {}
## Номер этажа -> {"total": int, "lost": int} для плит перекрытия.
var _slabs: Dictionary = {}
## Номер этажа -> число снесённых перегородок (только статистика).
var _partitions_lost: Dictionary = {}
var _collapsed: Dictionary = {}
var _total_destroyed: int = 0


## Привязывает структуру к корню точки интереса.
##
## ВЫЗЫВАЕТСЯ ДО add_child() — так же, как configure() у Grenade и Door.
func configure(root: Node3D) -> void:
	_root = root


## Регистрирует контейнер этажа.
func register_floor(floor_index: int, container: Node) -> void:
	_floors[floor_index] = container
	_ensure_buckets(floor_index)


## Заводит счётчики опор этажа, если их ещё нет.
func _ensure_buckets(floor_index: int) -> void:
	if not _bearing.has(floor_index):
		_bearing[floor_index] = {"total": 0, "lost": 0}
	if not _slabs.has(floor_index):
		_slabs[floor_index] = {"total": 0, "lost": 0}


## Регистрирует разрушаемую часть и подписывается на её разрушение.
##
## `is_slab` отделяет перекрытие от стены: пороги у них разные, потому что
## плита держит нагрузку напрямую, а стена — через плиту.
func register_part(part: Destructible, floor_index: int, interior: bool, is_slab: bool) -> void:
	if part == null or not is_instance_valid(part):
		return
	part.set_meta("structure_floor", floor_index)
	part.set_meta("structure_interior", interior)
	part.set_meta("structure_slab", is_slab)
	if not part.destroyed.is_connected(_on_part_destroyed):
		part.destroyed.connect(_on_part_destroyed)
	# Только счётчики, НЕ register_floor(): повторная запись контейнера
	# этажа значением по умолчанию стирала бы ссылку на узел этажа, и
	# обрушение не находило бы чего обрушивать.
	_ensure_buckets(floor_index)
	if interior:
		# Перегородка не несущая: учитываем её отдельно и только для отчёта.
		return
	var bucket: Dictionary = _slabs[floor_index] if is_slab else _bearing[floor_index]
	bucket["total"] = int(bucket["total"]) + 1


## Реакция на разрушение одной части.
func _on_part_destroyed(part: Node3D) -> void:
	_total_destroyed += 1
	if part == null or not is_instance_valid(part):
		return
	var floor_index: int = int(part.get_meta("structure_floor", -1))
	if floor_index < 0 or not _bearing.has(floor_index):
		return
	var interior: bool = bool(part.get_meta("structure_interior", false))
	if interior:
		_partitions_lost[floor_index] = int(_partitions_lost.get(floor_index, 0)) + 1
		return
	var is_slab: bool = bool(part.get_meta("structure_slab", false))
	var bucket: Dictionary = _slabs[floor_index] if is_slab else _bearing[floor_index]
	bucket["lost"] = int(bucket["lost"]) + 1
	if _threshold_exceeded(bucket, SLAB_LOSS_RATIO if is_slab else BEARING_LOSS_RATIO):
		_collapse_above(floor_index)


## Превышен ли порог потери опор.
##
## Нулевое число опор означает «этаж без несущих элементов», а не «целый
## этаж»: так бывает у крыши и у верхнего этажа, если их строили без стен.
## Обрушать в этом случае нечего, поэтому возвращаем false.
func _threshold_exceeded(bucket: Dictionary, ratio: float) -> bool:
	var total: int = int(bucket["total"])
	if total <= 0:
		return false
	return float(int(bucket["lost"])) / float(total) >= ratio


## Обрушает то, что стоит НАД указанным этажом.
func _collapse_above(floor_index: int) -> void:
	var above: int = floor_index + 1
	if not _floors.has(above):
		return
	collapse_floor(above)


## Обрушает этаж целиком. Возвращает число разрушенных частей.
##
## Публичный: тесты, скриптовые события и отладка вызывают его напрямую,
## не дожидаясь накопления порога.
func collapse_floor(floor_index: int) -> int:
	if is_collapsed(floor_index):
		return 0
	var container: Node = _floors.get(floor_index)
	if container == null or not is_instance_valid(container):
		return 0
	# Пометка ДО обхода, а не после: разрушение частей этажа приходит в
	# _on_part_destroyed, который может запустить обрушение следующего этажа.
	# Без предварительной пометки каскад возвращался в этот же этаж.
	_collapsed[floor_index] = true

	var parts: Array[Destructible] = []
	_collect_destructibles(container, parts)
	var destroyed: int = 0
	for part: Destructible in parts:
		if part.is_destroyed():
			continue
		# Точка удара — центр самой части: нарезка расходится от неё, и
		# обрушение «сверху вниз» читается именно так.
		var point: Vector3 = part.global_position + Vector3.UP * 0.2
		if part.destroy(point, Vector3.DOWN):
			destroyed += 1
	Diagnostics.info(
		"structure", "обрушение этажа %d: %d частей (%s)" % [floor_index, destroyed, _root_name()]
	)
	floor_collapsed.emit(self, floor_index)
	return destroyed


## Собирает разрушаемые части узла рекурсивно.
##
## Обход обязателен: этаж содержит и панели, и мебель, и двери, а дверь —
## это Interactable с вложенным Destructible, до которого get_children()
## первого уровня не доходит.
func _collect_destructibles(node: Node, out: Array[Destructible]) -> void:
	if node is Destructible:
		out.append(node as Destructible)
	for child: Node in node.get_children():
		_collect_destructibles(child, out)


## Обрушен ли этаж.
func is_collapsed(floor_index: int) -> bool:
	return bool(_collapsed.get(floor_index, false))


## Зарегистрированные этажи по возрастанию.
func floor_indices() -> Array:
	var keys: Array = _floors.keys()
	keys.sort()
	return keys


## Имя корня — для журнала. Корень может быть ещё не в дереве.
func _root_name() -> String:
	if _root == null or not is_instance_valid(_root):
		return "без корня"
	return String(_root.name)


## Отчёт целостности — для оверлея отладки и тестов.
func report() -> Dictionary:
	var bearing_total: int = 0
	var bearing_lost: int = 0
	var slab_total: int = 0
	var slab_lost: int = 0
	for entry: Dictionary in _bearing.values():
		bearing_total += int(entry["total"])
		bearing_lost += int(entry["lost"])
	for entry: Dictionary in _slabs.values():
		slab_total += int(entry["total"])
		slab_lost += int(entry["lost"])
	return {
		"root": _root_name(),
		"floors": _floors.size(),
		"bearing_total": bearing_total,
		"bearing_lost": bearing_lost,
		"slab_total": slab_total,
		"slab_lost": slab_lost,
		"partitions_lost": _sum_partitions(),
		"collapsed_floors": _collapsed.keys().size(),
		"destroyed": _total_destroyed,
	}


## Сумма снесённых перегородок по всем этажам.
##
## Цикл вместо лямбды в reduce(): строка с ней не влезает в 100 символов, а
## перенос лямбды gdformat складывает так, что выражение перестаёт читаться.
func _sum_partitions() -> int:
	var total: int = 0
	for value: int in _partitions_lost.values():
		total += value
	return total
