extends Node
## AudioService — музыка, эффекты, пул плееров и ducking.
##
## ЗАЧЕМ ПУЛ. Создать AudioStreamPlayer — дёшево. Создать 200 штук за кадр
## взрыва — дорого и слышно (щелчки, пропуски). Пул переиспользует плееры,
## а сверх лимита отбрасывает САМЫЕ ТИХИЕ звуки: игрок не заметит потерю
## далёкого шага, но заметит просадку FPS.
##
## DUCKING. Когда говорит персонаж или идёт важный UI-звук, музыка
## приглушается. Без этого озвучка тонет в саундтреке — классическая
## ошибка, которую игроки описывают как «плохой звук», не понимая причины.

enum SfxPriority { LOW, NORMAL, HIGH, CRITICAL }

const SFX_POOL_SIZE: int = 24
const MUSIC_PLAYERS: int = 2
const CROSSFADE_SEC: float = 1.6
## На сколько дБ приглушаем музыку во время речи.
const VOICE_DUCK_DB: float = -12.0
const DUCK_RAMP_SEC: float = 0.25
## Звук тише этого порога в дБ не играет вообще: не тратим голос микшера.
const AUDIBILITY_FLOOR_DB: float = -50.0

var _sfx_pool: Array[AudioStreamPlayer] = []
var _pool_busy: Array[bool] = []
var _pool_priority: Array[int] = []
var _pool_started_ms: Array[int] = []
var _music_players: Array[AudioStreamPlayer] = []
var _music_active_index: int = 0
var _music_tween: Tween = null
var _duck_tween: Tween = null
var _current_track: String = ""
var _music_paused_position: Dictionary = {}


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_build_pools()
	_verify_buses()
	EventBus.game_paused.connect(_on_game_paused)


# ------------------------------------------------------------------ пулы ---


func _build_pools() -> void:
	for i: int in SFX_POOL_SIZE:
		var player := AudioStreamPlayer.new()
		player.name = "Sfx%02d" % i
		player.bus = GameConfig.BUS_SFX
		player.max_polyphony = 1
		add_child(player)
		_sfx_pool.append(player)
		_pool_busy.append(false)
		_pool_priority.append(0)
		_pool_started_ms.append(0)
		player.finished.connect(_on_sfx_finished.bind(i))

	for i: int in MUSIC_PLAYERS:
		var player := AudioStreamPlayer.new()
		player.name = "Music%02d" % i
		player.bus = GameConfig.BUS_MUSIC
		add_child(player)
		_music_players.append(player)

	Diagnostics.info(
		"audio", "пул SFX: %d, музыкальных плееров: %d" % [SFX_POOL_SIZE, MUSIC_PLAYERS]
	)


func _verify_buses() -> void:
	for bus_name: String in GameConfig.AUDIO_BUSES:
		if AudioServer.get_bus_index(bus_name) < 0:
			(
				Diagnostics
				. error(
					"audio",
					"шина '%s' отсутствует в default_bus_layout.tres" % bus_name,
				)
			)


# ------------------------------------------------------------------- SFX ---


## Проигрывает звук. `volume_db` и `pitch_scale` дают вариативность:
## один и тот же шаг со случайным питчем перестаёт звучать как метроном.
func play_sfx(
	stream: AudioStream,
	volume_db: float = 0.0,
	pitch_scale: float = 1.0,
	priority: SfxPriority = SfxPriority.NORMAL
) -> bool:
	if stream == null:
		Diagnostics.warn("audio", "play_sfx: stream == null")
		return false
	if volume_db <= AUDIBILITY_FLOOR_DB:
		return false
	var index: int = _acquire_player(int(priority))
	if index < 0:
		Diagnostics.count("sfx_dropped")
		return false

	var player: AudioStreamPlayer = _sfx_pool[index]
	player.stream = stream
	player.volume_db = volume_db
	player.pitch_scale = pitch_scale
	player.play()
	_pool_busy[index] = true
	_pool_priority[index] = int(priority)
	_pool_started_ms[index] = Time.get_ticks_msec()
	Diagnostics.count("sfx_played")
	return true


## То же, но со случайным питчем в диапазоне — главный приём против
## «звук повторяется и бесит».
func play_sfx_randomized(
	stream: AudioStream,
	volume_db: float = 0.0,
	pitch_range: float = 0.08,
	priority: SfxPriority = SfxPriority.NORMAL
) -> bool:
	var pitch: float = clampf(1.0 + randf_range(-pitch_range, pitch_range), 0.25, 4.0)
	return play_sfx(stream, volume_db, pitch, priority)


## 3D-звук. Создаётся на месте, потому что AudioStreamPlayer3D привязан
## к позиции в мире и должен жить столько, сколько длится звук.
func play_sfx_3d(
	stream: AudioStream3D, global_position: Vector3, volume_db: float = 0.0
) -> AudioStreamPlayer3D:
	if stream == null:
		return null
	var player := AudioStreamPlayer3D.new()
	player.stream = stream
	player.volume_db = volume_db
	player.bus = GameConfig.BUS_SFX
	player.global_position = global_position
	# Освобождаем сразу по окончании — иначе сцена зарастёт мёртвыми нодами.
	player.finished.connect(player.queue_free)
	get_tree().current_scene.add_child(player)
	player.play()
	return player


func _acquire_player(priority: int) -> int:
	# 1. Свободный плеер.
	for i: int in _sfx_pool.size():
		if not _pool_busy[i]:
			return i
	# 2. Все заняты — вытесняем звук с меньшим приоритетом.
	#    Внутри одного приоритета — самый старый.
	var victim: int = -1
	var best_candidacy: int = -1
	var now_ms: int = Time.get_ticks_msec()
	for i: int in _sfx_pool.size():
		# Чем МЕНЬШЕ приоритет и чем СТАРШЕ звук, тем выше шанс стать жертвой.
		var candidacy: int = (
			(int(SfxPriority.CRITICAL) - _pool_priority[i]) * 1000000
			+ (now_ms - _pool_started_ms[i])
		)
		if candidacy > best_candidacy:
			best_candidacy = candidacy
			victim = i
	if victim < 0:
		return -1
	if _pool_priority[victim] > priority:
		# Новый звук менее важен, чем уже играющий, — не перебиваем.
		return -1
	return victim


func _on_sfx_finished(index: int) -> void:
	if index >= 0 and index < _pool_busy.size():
		_pool_busy[index] = false
		_pool_priority[index] = 0


func pool_stats() -> Dictionary:
	var busy: int = 0
	for is_busy: bool in _pool_busy:
		if is_busy:
			busy += 1
	return {"size": _sfx_pool.size(), "busy": busy, "free": _sfx_pool.size() - busy}


# ---------------------------------------------------------------- музыка ---


## Кроссфейд на новый трек. Два плеера нужны именно для этого: второй
## начинает играть, пока первый затухает. Без второго трека — резкий
## обрыв, который слышно как баг.
func play_music(track_name: String, stream: AudioStream, fade_sec: float = CROSSFADE_SEC) -> void:
	if stream == null:
		Diagnostics.error("audio", "play_music: stream == null для '%s'" % track_name)
		return
	if track_name == _current_track and _music_active() != null:
		return

	var next_index: int = (_music_active_index + 1) % MUSIC_PLAYERS
	var incoming: AudioStreamPlayer = _music_players[next_index]
	var outgoing: AudioStreamPlayer = _music_players[_music_active_index]

	incoming.stream = stream
	incoming.volume_db = GameConfig.VOLUME_DB_MIN
	incoming.play()
	_music_active_index = next_index
	_current_track = track_name

	if _music_tween != null and _music_tween.is_valid():
		_music_tween.kill()
	_music_tween = create_tween().set_parallel(true)
	var target_db: float = GameConfig.volume_linear_to_db(
		SettingsService.get_float("audio/music_volume")
	)
	_music_tween.tween_property(incoming, "volume_db", target_db, fade_sec)
	if outgoing.playing:
		_music_tween.tween_property(outgoing, "volume_db", GameConfig.VOLUME_DB_MIN, fade_sec)
		_music_tween.chain().tween_callback(outgoing.stop)

	EventBus.music_track_changed.emit(track_name)
	Diagnostics.info("audio", "трек: " + track_name)


func stop_music(fade_sec: float = CROSSFADE_SEC) -> void:
	var player: AudioStreamPlayer = _music_active()
	if player == null or not player.playing:
		return
	if _music_tween != null and _music_tween.is_valid():
		_music_tween.kill()
	_music_tween = create_tween()
	_music_tween.tween_property(player, "volume_db", GameConfig.VOLUME_DB_MIN, fade_sec)
	_music_tween.tween_callback(player.stop)
	_music_tween.tween_callback(func() -> void: _current_track = "")


func pause_music() -> void:
	var player: AudioStreamPlayer = _music_active()
	if player == null or not player.playing:
		return
	_music_paused_position[_current_track] = player.get_playback_position()
	player.stream_paused = true


func resume_music() -> void:
	var player: AudioStreamPlayer = _music_active()
	if player != null:
		player.stream_paused = false


func current_track() -> String:
	return _current_track


func _music_active() -> AudioStreamPlayer:
	if _music_players.is_empty():
		return null
	return _music_players[_music_active_index]


# --------------------------------------------------------------- ducking ---


## Приглушает музыку, пока играет речь или важный звук.
## `hold_sec` — сколько держать приглушённой после окончания.
func duck_music(amount_db: float = VOICE_DUCK_DB, hold_sec: float = 0.0) -> void:
	var player: AudioStreamPlayer = _music_active()
	if player == null or not player.playing:
		return
	var base_db: float = GameConfig.volume_linear_to_db(
		SettingsService.get_float("audio/music_volume")
	)
	if _duck_tween != null and _duck_tween.is_valid():
		_duck_tween.kill()
	# Tween живёт на AudioService (PROCESS_MODE_ALWAYS), поэтому ducking
	# доигрывает даже на паузе — иначе на паузе музыка «залипает» тихой.
	_duck_tween = create_tween()
	_duck_tween.tween_property(player, "volume_db", base_db + amount_db, DUCK_RAMP_SEC)
	if hold_sec > 0.0:
		_duck_tween.tween_interval(hold_sec)
	_duck_tween.tween_property(player, "volume_db", base_db, DUCK_RAMP_SEC)


## Речевой плеер с автоматическим ducking'ом музыки.
func play_voice(stream: AudioStream) -> bool:
	if stream == null:
		return false
	var bus_index: int = AudioServer.get_bus_index(GameConfig.BUS_VOICE)
	if bus_index < 0:
		Diagnostics.warn("audio", "шина Voice отсутствует")
		return false
	var player := AudioStreamPlayer.new()
	player.stream = stream
	player.bus = GameConfig.BUS_VOICE
	add_child(player)
	var duration: float = stream.get_length()
	duck_music(VOICE_DUCK_DB, duration)
	player.finished.connect(player.queue_free)
	player.play()
	return true


# ---------------------------------------------------------------- события --


func _on_game_paused(paused: bool) -> void:
	if paused:
		pause_music()
	else:
		resume_music()


## Полная остановка всего звука — при выходе в главное меню, чтобы
## звуки предыдущей сессии не долетали в меню.
func silence_all() -> void:
	for player: AudioStreamPlayer in _sfx_pool:
		player.stop()
	for i: int in _pool_busy.size():
		_pool_busy[i] = false
	stop_music(0.2)
