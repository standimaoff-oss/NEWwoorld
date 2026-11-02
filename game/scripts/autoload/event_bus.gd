extends Node
## EventBus — глобальная шина сигналов.
##
## ЗАЧЕМ. В Godot сигналы идут «вниз по дереву» или через прямые ссылки.
## Как только систем становится больше трёх, граф ссылок превращается в
## паутину: UI знает про игрока, игрок знает про UI, удаление любой сцены
## рвёт полпроекта. EventBus разрывает эту связь — подписчик не знает,
## кто эмиттер.
##
## ПРАВИЛА (нарушение = ревью-блок):
##   1. Сигнал объявляется ЗДЕСЬ и больше нигде. Один файл = вся карта
##      событий игры. Так её можно прочитать целиком.
##   2. Имя — прошедшее время, глагол: `player_died`, а не `kill_player`.
##      Событие описывает факт, который УЖЕ случился.
##   3. Типизация обязательна для всех аргументов.
##   4. Эмиттер НЕ знает, кто слушает. Никаких возвратов значений.
##   5. Тяжёлые данные передаются по ссылке или словарём; не сериализуем
##      то, что можно прочитать из сцены.
##   6. Подписка в `_ready()`, отписка в `_exit_tree()`. Утечка подписки
##      на freed-объект = краш в релизе.

# ---------------------------------------------------------------- загрузка --
## Boot начал инициализацию сервисов.
signal boot_started
## Boot закончил инициализацию. `ok == false` означает деградацию:
## игра продолжает работать, но часть систем отключена.
signal boot_finished(ok: bool, elapsed_ms: int)
## Запрошен переход между сценами (SceneService).
signal scene_change_requested(path: String)
## Экран загрузки появился/исчез. UI анимирует переход по этим событиям.
signal loading_screen_shown
signal loading_screen_hidden
## Прогресс потоковой загрузки, 0.0 .. 1.0
signal loading_progress(path: String, progress: float)

# ------------------------------------------------------------------ меню ----
signal main_menu_opened
signal main_menu_closed
signal settings_opened
signal settings_closed
signal credits_opened
signal pause_menu_opened
signal pause_menu_closed
## Пункт меню выбран. `action` — машинное имя: "new_game", "continue", ...
signal menu_action_triggered(action: String)

# ------------------------------------------------------------- настройки ----
## Настройки изменены и применены. `section` — "video" / "audio" / "input".
signal settings_changed(section: String)
## Настройки сохранены на диск.
signal settings_saved
## Загружены с диска (в т.ч. при первом запуске — дефолтами).
signal settings_loaded
## Пресет качества переключён: 0..3 (Low..Ultra).
signal quality_preset_changed(preset_index: int)
## Язык интерфейса изменён.
signal language_changed(locale: String)

# ------------------------------------------------------------------ игра ----
signal game_started
signal game_paused(paused: bool)
signal game_finished(result: String)
signal level_loaded(level_id: String)

# ---------------------------------------------------------------- игрок -----
signal player_spawned(player: Node3D)
signal player_died(cause: String)
signal player_respawned
signal player_health_changed(current: float, maximum: float)
signal player_stamina_changed(current: float, maximum: float)
signal player_grounded_changed(is_grounded: bool)
signal player_interacted_with(target: Node)
## Изменился запас метательных снарядов. Отдельный сигнал от здоровья и
## выносливости: HUD показывает счётчик по-своему, а подписываться на общее
## «что-то изменилось» означало бы перерисовывать всё на каждый чих.
signal player_throwable_changed(current: int, maximum: int)
## Игрок посмотрел на интерактивный объект. UI рисует подсказку.
signal interaction_focus_changed(target: Node)

# ------------------------------------------------------------ разрушение ----
## Объект начал разрушаться. `energy` — накопленный урон/импульс.
signal destruction_started(target: Node3D, energy: float)
## Порождено N осколков. PerfMonitor следит за бюджетом по этому событию.
signal destruction_chunks_spawned(count: int, origin: Vector3)
## Осколок завершил жизнь (пул освобождён).
signal destruction_chunk_retired
## Бюджет разрушения превышен — система деградирует, а не падает.
signal destruction_budget_exceeded(active_chunks: int, budget: int)

## Взрыв произошёл. Отдельный сигнал от destruction_started: начало нарезки
## — событие одного объекта, а взрыв — событие мира, на которое подписываются
## тряска камеры, звук и статистика. Смешивать их нельзя: на один взрыв
## приходится десятки нарезок.
signal explosion_occurred(center: Vector3, radius: float, destroyed: int)

# ------------------------------------------------------------------ ветер ---
## Глобальные параметры ветра изменились (направление/сила/порывы).
## Шейдеры читают их через uniform-блок, GDScript — по этому событию.
signal wind_changed(direction: Vector3, strength: float, gustiness: float)

# ------------------------------------------------------------------- звук ---
signal music_track_changed(track_name: String)
signal music_volume_changed(linear: float)

# --------------------------------------------------------------- сохранение -
signal save_started(slot: int)
signal save_finished(slot: int, ok: bool, message: String)
signal load_started(slot: int)
signal load_finished(slot: int, ok: bool, message: String)
signal save_slots_changed

# ------------------------------------------------------------- диагностика --
## Фатальная ошибка, которую мы перехватили и залогировали.
signal fatal_error_occurred(context: String, message: String)
## Производительность упала ниже порога. QualityService может понизить
## пресет автоматически (adaptive quality).
signal performance_degraded(avg_fps: float, threshold_fps: float)
## Отладочный оверлей включён/выключен.
signal debug_overlay_toggled(enabled: bool)


## Число активных подписчиков на сигнал. Нужно тестам: проверяем, что
## объект, вышедший из дерева, действительно отписался.
func subscriber_count(signal_name: StringName) -> int:
	if not has_signal(signal_name):
		push_error("EventBus: нет сигнала '%s'" % signal_name)
		return 0
	return get_signal_connection_list(signal_name).size()


## Безопасно эмитирует сигнал: если сигнала нет — пишет ошибку в лог,
## но НЕ роняет игру. Защита от опечатки, которая в релизе выглядит как
## «иногда ничего не происходит».
func emit_checked(signal_name: StringName, args: Array = []) -> void:
	if not has_signal(signal_name):
		push_error("EventBus.emit_checked: неизвестный сигнал '%s'" % signal_name)
		return
	emit_signal(signal_name, args)


## Возвращает имена всех сигналов шины. Используется генератором
## документации и тестом на «сиротские» сигналы.
func all_signal_names() -> Array[String]:
	var result: Array[String] = []
	for entry: Dictionary in get_signal_list():
		result.append(String(entry["name"]))
	result.sort()
	return result
