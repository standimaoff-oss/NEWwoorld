class_name Grenade
extends RigidBody3D
## Граната: физический снаряд с взрывателем.
##
## ЗАЧЕМ ОТДЕЛЬНЫЙ УЗЕЛ, А НЕ ВЫЗОВ explode() ПО ЛУЧУ. Взрыв из точки, куда
## смотрит игрок, — это не взрыв, а мгновенное удаление геометрии: снаряд не
## летит, не отскакивает от стены и не закатывается в помещение. Требование
## «прям физично» начинается с того, что у разрушения есть физический
## носитель. Граната летит баллистикой, отскакивает и взрывается там, где
## оказалась, а не там, куда целились.
##
## Взрыв делегируется DestructionService.explode(): сам снаряд не знает ни
## про нарезку мешей, ни про бюджет осколков.

## Взрыв произошёл. Подписчики — звук, тряска камеры, статистика.
signal exploded(grenade: Grenade, center: Vector3, radius: float)

## Радиус корпуса, м. Меньше 0,1 м — граната проваливается в щели рельефа.
const BODY_RADIUS: float = 0.09
## Время горения взрывателя после броска, с.
const FUSE_SECONDS: float = 2.6
## Скорость броска, м/с.
const THROW_SPEED: float = 13.5
## Доля скорости, направленная вверх: без неё граната летит в ноги.
const THROW_UPWARD: float = 0.16
## Начальное вращение. Чисто визуальное, но неподвижный снаряд в полёте
## выглядит как ошибка анимации.
const SPIN_RATE: Vector3 = Vector3(14.0, 6.0, -9.0)
## Отскок: бетон и грунт не должны гасить гранату полностью.
const BOUNCINESS: float = 0.32

## Вспышка взрыва.
const FLASH_RANGE: float = 11.0
const FLASH_ENERGY: float = 7.0
const FLASH_SECONDS: float = 0.3
const FLASH_COLOR: Color = Color(1.0, 0.78, 0.42)
## Ударная волна — расширяющаяся полупрозрачная сфера.
const WAVE_SECONDS: float = 0.45
const WAVE_SCALE_END: float = 0.92
const WAVE_COLOR: Color = Color(1.0, 0.86, 0.62, 0.5)
## Сколько узел живёт после взрыва, чтобы эффекты доиграли.
const EFFECT_TAIL_SECONDS: float = 0.6

## Время взрывателя. Экспортировано: отладке и тестам нужны короткие значения.
@export var fuse_seconds: float = FUSE_SECONDS
## Радиус поражения, м.
@export var explosion_radius: float = MapConfig.EXPLOSION_RADIUS
## Сила взрыва.
@export var explosion_force: float = MapConfig.EXPLOSION_ENERGY

var _remaining: float = 0.0
var _armed: bool = false
var _detonated: bool = false
var _body_mesh: MeshInstance3D = null
var _flash: OmniLight3D = null
var _wave: MeshInstance3D = null
var _wave_material: StandardMaterial3D = null


## Собирает корпус и готовит снаряд к броску.
##
## ВЫЗЫВАЕТСЯ ДО add_child(). Так же, как Door.configure(): свойства
## RigidBody3D, заданные до входа в дерево, применяются корректно, а
## коллизии и слои не приходится править отложенно через set_deferred.
func configure(thrower: Node3D = null) -> void:
	name = "grenade"
	collision_layer = GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.PROJECTILE)
	# Маска: мир и осколки. Слой игрока исключён намеренно — снаряд,
	# сталкивающийся с метателем, взрывается у него в руках в первом же кадре.
	collision_mask = (
		GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.WORLD)
		| GameConfig.physics_layer_bit(GameConfig.PhysicsLayer.DEBRIS)
	)
	mass = 0.45
	physics_material_override = _body_material()
	contact_monitor = true
	max_contacts_reported = 4
	continuous_cd = true
	can_sleep = false
	_build_body_mesh()
	if thrower is CollisionObject3D:
		add_collision_exception_with(thrower)


## Бросает снаряд. Направление нормализуется внутри: вызывающая сторона
## передаёт направление взгляда, а не готовый вектор скорости.
func launch(direction: Vector3, speed: float = THROW_SPEED) -> void:
	var aim: Vector3 = Vector3.FORWARD
	if direction.length_squared() > 0.0001:
		aim = direction.normalized()
	linear_velocity = aim * speed + Vector3.UP * speed * THROW_UPWARD
	angular_velocity = SPIN_RATE
	_remaining = maxf(fuse_seconds, 0.05)
	_armed = true
	# Взрыватель тикает в _physics_process, а _ready() его выключает: граната,
	# лежащая у игрока, не должна отсчитывать время до броска. Без включения
	# здесь снаряд летел бы вечно и взрывался только от прямого вызова.
	set_physics_process(true)


func _ready() -> void:
	if _body_mesh == null:
		configure()
	# До броска взрыватель не идёт: граната, лежащая на земле у игрока,
	# обязана ждать броска, а не тикать с момента создания узла.
	set_physics_process(false)


func _physics_process(delta: float) -> void:
	if not _armed or _detonated:
		return
	_remaining -= delta
	if _remaining <= 0.0:
		detonate()


## Взрыв. Публичный: тесты и скриптовые события (бочка, мина) вызывают его
## напрямую, не дожидаясь истечения взрывателя.
func detonate() -> void:
	if _detonated:
		return
	_detonated = true
	_armed = false
	set_physics_process(false)

	var center: Vector3 = global_position
	# Тело снаряда больше не участвует в физике: взрыв произошёл, а корпус,
	# оставшийся твёрдым объектом в эпицентре, мешал бы осколкам разлетаться.
	collision_layer = 0
	collision_mask = 0
	freeze = true
	if _body_mesh != null:
		_body_mesh.visible = false

	var destroyed: int = DestructionService.explode(center, explosion_radius, explosion_force)
	Diagnostics.count("explosions")
	Diagnostics.info(
		"grenade",
		"взрыв в (%.1f, %.1f, %.1f): разрушено %d" % [center.x, center.y, center.z, destroyed]
	)
	exploded.emit(self, center, explosion_radius)
	EventBus.explosion_occurred.emit(center, explosion_radius, destroyed)
	_spawn_flash()
	_spawn_shockwave()
	# Узел живёт ещё немного, чтобы вспышка и волна доиграли. Освобождение
	# немедленное оборвало бы эффект на первом кадре.
	var timer: SceneTreeTimer = get_tree().create_timer(EFFECT_TAIL_SECONDS)
	timer.timeout.connect(queue_free)


## Вспышка. Обязательна, а не декоративна: взрыв без света читается как
## исчезновение геометрии, потому что разрушение само по себе бесшумно
## и происходит мгновенно.
func _spawn_flash() -> void:
	_flash = OmniLight3D.new()
	_flash.name = "flash"
	_flash.omni_range = FLASH_RANGE
	_flash.omni_attenuation = 1.5
	_flash.light_energy = FLASH_ENERGY
	_flash.light_color = FLASH_COLOR
	# Тени от одноточечного источника в открытом мире стоят дорого и дают
	# резкие артефакты на 0,3 секунды жизни эффекта.
	_flash.shadow_enabled = false
	add_child(_flash)
	var tween: Tween = create_tween()
	tween.tween_property(_flash, "light_energy", 0.0, FLASH_SECONDS)
	tween.tween_property(_flash, "omni_range", FLASH_RANGE * 0.35, FLASH_SECONDS)


## Ударная волна: расширяющаяся сфера, которая гаснет.
##
## Масштаб привязан к радиусу поражения, а не к константе: игрок обязан
## видеть границу, до которой взрыв что-то ломает. Иначе радиус остаётся
## невидимым параметром, и «не хватило совсем чуть-чуть» выглядит как баг.
func _spawn_shockwave() -> void:
	var sphere := SphereMesh.new()
	sphere.radius = 1.0
	sphere.height = 2.0
	sphere.radial_segments = 20
	sphere.rings = 10
	_wave_material = StandardMaterial3D.new()
	_wave_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_wave_material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	_wave_material.cull_mode = BaseMaterial3D.CULL_DISABLED
	_wave_material.albedo_color = WAVE_COLOR
	_wave_material.disable_receive_shadows = true
	_wave = MeshInstance3D.new()
	_wave.name = "shockwave"
	_wave.mesh = sphere
	_wave.material_override = _wave_material
	# Полупрозрачная поверхность с отбрасыванием тени даёт сплошное чёрное
	# пятно — та же ловушка, что со стёклами в интерьерах.
	_wave.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(_wave)

	var target_scale: float = explosion_radius * WAVE_SCALE_END
	_wave.scale = Vector3.ONE * BODY_RADIUS * 4.0
	var tween: Tween = create_tween()
	tween.set_parallel(true)
	(
		tween
		. tween_property(_wave, "scale", Vector3.ONE * target_scale, WAVE_SECONDS)
		. set_trans(Tween.TRANS_QUAD)
		. set_ease(Tween.EASE_OUT)
	)
	tween.tween_property(_wave_material, "albedo_color:a", 0.0, WAVE_SECONDS)


## Материал корпуса: тёмный металл с заметным трением, чтобы граната не
## скользила по склону бесконечно.
func _body_material() -> PhysicsMaterial:
	var material := PhysicsMaterial.new()
	material.bounce = BOUNCINESS
	material.friction = 0.9
	return material


## Видимый корпус. Сфера, а не меш из ассетов: внешних моделей в проекте
## нет, а примитив с малым числом сегментов на расстоянии броска неотличим.
func _build_body_mesh() -> void:
	var sphere := SphereMesh.new()
	sphere.radius = BODY_RADIUS
	sphere.height = BODY_RADIUS * 2.0
	sphere.radial_segments = 10
	sphere.rings = 5
	var material := StandardMaterial3D.new()
	material.albedo_color = Color(0.18, 0.2, 0.16)
	material.roughness = 0.62
	material.metallic = 0.35
	_body_mesh = MeshInstance3D.new()
	_body_mesh.name = "body"
	_body_mesh.mesh = sphere
	_body_mesh.material_override = material
	_body_mesh.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
	add_child(_body_mesh)


## Взведён ли взрыватель.
func is_armed() -> bool:
	return _armed


## Уже взорвалась.
func is_detonated() -> bool:
	return _detonated


## Оставшееся время взрывателя, с.
func remaining_fuse() -> float:
	return maxf(_remaining, 0.0)
