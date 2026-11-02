class_name Destructible
extends Node3D
## Destructible — разрушаемый объект.
##
## КОНТРАКТ С DestructionService:
##   * состоит в группе &"destructible",
##   * отдаёт меш через get_fracture_mesh(),
##   * принимает обратный вызов _on_fractured(),
##   * сам считает прочность и решает, разрушаться или нет.
##
## Разделение ответственности принципиально: этот узел знает СВОЮ прочность
## и свой внешний вид, а DestructionService знает, как нарезать меш на
## осколки и как уложиться в бюджет. Ни один из них не знает внутренностей
## другого — поэтому замена GDScript-нарезки на C++-расширение (и обратно)
## не требует правки ни одного разрушаемого объекта в игре.
##
## ВАЖНО ПРО ПРОИЗВОДИТЕЛЬНОСТЬ: прочность накапливается, а разрушение
## происходит один раз. Объект, который «разрушается» на каждом кадре
## получения урона, плодит осколки быстрее, чем физика успевает их считать.

signal destroyed(destructible: Node3D)

## Прочность. Накопленный урон выше этого значения запускает разрушение.
@export var integrity: float = 100.0
## Энергия, передаваемая в нарезку. Больше — дальше летят осколки.
@export var break_energy: float = 90.0
## Множитель накопления урона. Позволяет настроить «бетон» и «дерево»
## одним параметром, не переписывая логику.
@export var damage_multiplier: float = 1.0
## Узел с мешом. Если не задан, ищется первый MeshInstance3D среди детей.
@export var mesh_node: MeshInstance3D = null
## Материал растворения. Если задан, объект растворяется, а не исчезает
## мгновенно: мгновенное исчезновение стены читается как баг.
@export var dissolve_material: Material = null
## Длительность растворения, секунды.
@export var dissolve_duration: float = 0.45
## Звук разрушения. Именно AudioStream3D: разрушение — событие в точке
## мира, и без позиционирования стена за спиной звучит так же громко, как
## стена перед лицом. Обычный AudioStream здесь физически не подходит.
@export var break_sound: AudioStream3D = null

## Узел, который физически блокирует проход. Отключается при разрушении.
@export var collider_node: CollisionObject3D = null

var _accumulated_damage: float = 0.0
var _is_destroyed: bool = false
var _dissolve_tween: Tween = null


func _ready() -> void:
	add_to_group(DestructionService.GROUP_DESTRUCTIBLE)
	if mesh_node == null:
		mesh_node = _find_first_mesh_instance()
	if collider_node == null:
		collider_node = _find_first_collider()
	if mesh_node == null:
		# Объект без меша разрушить нельзя: нарезке нечего резать. Пишем
		# ошибку в лог на старте, а не в момент взрыва — иначе причина
		# «стена не сломалась» находится часами.
		Diagnostics.error("destructible", "%s: нет MeshInstance3D" % name)
		set_process(false)


func _exit_tree() -> void:
	if _dissolve_tween != null and _dissolve_tween.is_valid():
		_dissolve_tween.kill()


## Накопить урон. Возвращает true, если объект разрушился в этом вызове.
## impact_point/impact_normal определяют, откуда пойдёт трещина и куда
## полетят осколки.
func damage(
	amount: float, impact_point: Vector3 = Vector3.INF, impact_normal: Vector3 = Vector3.UP
) -> bool:
	if _is_destroyed or amount <= 0.0:
		return false
	_accumulated_damage += amount * damage_multiplier
	if _accumulated_damage < integrity:
		# Трещина/потёртость как обратная связь ДО разрушения: игрок должен
		# видеть, что удары попадают, иначе он бьёт стену «в пустоту».
		_show_damage_feedback()
		return false
	return destroy(impact_point, impact_normal)


## Разрушить безусловно — для взрывов и скриптовых событий.
func destroy(impact_point: Vector3 = Vector3.INF, impact_normal: Vector3 = Vector3.UP) -> bool:
	if _is_destroyed:
		return false
	var point: Vector3 = global_position if impact_point == Vector3.INF else impact_point
	# Просим сервис нарезать меш. Сервис сам решает, какой бэкенд использовать
	# и укладывается ли результат в бюджет осколков.
	var fractured: bool = DestructionService.fracture(self, break_energy, point, impact_normal)
	if not fractured:
		# Отказ сервиса (бюджет исчерпан, меш не читается) НЕ должен
		# оставлять объект «навечно неразрушаемым»: убираем его простым
		# растворением. Лучше честно исчезнувшая стена, чем стена, которую
		# игрок расстрелял впустую.
		Diagnostics.warn("destructible", "%s: нарезка не удалась, растворяем без осколков" % name)
		_is_destroyed = true
		_consume()
		destroyed.emit(self)
		return true
	# _on_fractured() вызывается сервисом внутри fracture(); здесь только
	# страхуемся, если сервис сменил поведение.
	_is_destroyed = true
	destroyed.emit(self)
	return true


## Обратный вызов от DestructionService после нарезки.
## Имя с подчёркиванием — контракт сервиса, он проверяет его через
## has_method и вызывает через call().
func _on_fractured() -> void:
	_consume()


## Меш для нарезки. Часть контракта с DestructionService: объект не обязан
## быть MeshInstance3D, достаточно уметь отдать свой меш.
func get_fracture_mesh() -> Mesh:
	if mesh_node == null or not is_instance_valid(mesh_node):
		return null
	return mesh_node.mesh


func is_destroyed() -> bool:
	return _is_destroyed


## Текущая прочность 0..1 — нужна эффектам трещин и HUD-подсветке.
func integrity_ratio() -> float:
	if integrity <= 0.0:
		return 0.0
	return clampf(1.0 - _accumulated_damage / integrity, 0.0, 1.0)


# ------------------------------------------------------------------ служебное --


func _consume() -> void:
	# Сначала отключаем коллизию, потом убираем видимость. Обратный порядок
	# даёт кадр, в котором игрок проходит сквозь ещё видимую стену.
	_disable_collider()
	if break_sound != null:
		# play_sfx_3d, а не play_sfx: у play_sfx второй параметр —
		# громкость в дБ (float), и Vector3 в нём превратился бы в
		# бессмысленное число. Позиционный звук идёт отдельным методом.
		AudioService.play_sfx_3d(break_sound, global_position)
	if dissolve_material != null and mesh_node != null:
		_play_dissolve()
	elif mesh_node != null:
		mesh_node.visible = false
	set_process(false)
	Diagnostics.count("destructibles_broken")


func _disable_collider() -> void:
	if collider_node == null or not is_instance_valid(collider_node):
		return
	# set_deferred обязателен: разрушение почти всегда происходит внутри
	# физического колбэка, а менять слои коллизий в этот момент движок
	# запрещает — прямая запись тихо игнорируется или ругается в лог.
	collider_node.set_deferred("collision_layer", 0)
	collider_node.set_deferred("collision_mask", 0)
	collider_node.set_deferred("monitoring", false)
	collider_node.set_deferred("monitorable", false)
	collider_node.set_deferred("input_ray_pickable", false)


func _play_dissolve() -> void:
	if dissolve_material == null or mesh_node == null:
		return
	# Растворение через шейдер: меш остаётся на месте и исчезает плавно.
	# Резкое visible = false на крупном объекте выглядит как глитч.
	mesh_node.material_override = dissolve_material
	if _dissolve_tween != null and _dissolve_tween.is_valid():
		_dissolve_tween.kill()
	_dissolve_tween = create_tween()
	_dissolve_tween.tween_method(_set_dissolve_amount, 0.0, 1.0, dissolve_duration)
	_dissolve_tween.tween_callback(func() -> void: mesh_node.visible = false)


func _set_dissolve_amount(amount: float) -> void:
	if dissolve_material == null:
		return
	# set_shader_parameter молча игнорирует отсутствующий параметр, поэтому
	# опечатка в имени uniform'а не падает, а просто не работает. Проверяем.
	if not (dissolve_material is ShaderMaterial):
		return
	var shader_material := dissolve_material as ShaderMaterial
	if shader_material.shader == null:
		return
	shader_material.set_shader_parameter("dissolve_amount", amount)


func _show_damage_feedback() -> void:
	# Минимальная обратная связь: считаем попадания для статистики и логов.
	# Визуальные трещины здесь намеренно не генерируются — это задача
	# материала (декаль/шум в шейдере), а не логики прочности.
	Diagnostics.count("destructible_hits")


func _find_first_mesh_instance() -> MeshInstance3D:
	for child: Node in get_children():
		if child is MeshInstance3D:
			return child as MeshInstance3D
	return null


func _find_first_collider() -> CollisionObject3D:
	for child: Node in get_children():
		if child is CollisionObject3D:
			return child as CollisionObject3D
	if self is CollisionObject3D:
		return self as CollisionObject3D
	return null
