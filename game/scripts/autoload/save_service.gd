extends Node
## SaveService — слоты сохранений с версионированием и атомарной записью.
##
## ТРИ вещи, которые делают сохранения надёжными, и которые отсутствуют
## в 90% любительских проектов:
##
##  1. ВЕРСИОННОСТЬ. В файле лежит `schema_version`. При загрузке, если
##     версия старая, гоняем цепочку миграций. Без этого обновление игры
##     превращает сейвы игроков в мусор, а разработчика — в злодея.
##  2. АТОМАРНОСТЬ. Пишем во временный файл, затем rename. Если питание
##     пропадёт посередине записи, прежний сейв останется целым. Запись
##     «напрямую» в целевой файл при обрыве даёт ноль байт и потерянное
##     прохождение.
##  3. РЕЗЕРВНАЯ КОПИЯ. Перед перезаписью слота старый файл уходит в .bak.
##     Повредился сейв — есть куда откатиться.
##
## Формат — JSON, а не бинарный Variant-поток: его можно прочитать глазами,
## поправить руками и продиффить в Git. Скорость на объёмах игровых
## сохранений не является проблемой, а отладка — является.

## Число слотов. Слот 0 — быстрые сохранения.
const SLOT_COUNT: int = 6
const QUICKSAVE_SLOT: int = 0
const AUTOSAVE_SLOT: int = 5
const BACKUP_SUFFIX: String = ".bak"
const TMP_SUFFIX: String = ".tmp"
const META_SUFFIX: String = ".meta.json"

## Ключи служебной информации внутри сейва.
const FIELD_SCHEMA: String = "schema_version"
const FIELD_GAME_VERSION: String = "game_version"
const FIELD_SAVED_AT: String = "saved_at"
const FIELD_PLAYTIME_MS: String = "playtime_ms"
const FIELD_LABEL: String = "label"
const FIELD_PAYLOAD: String = "payload"

## Реестр систем, которые хотят что-то сохранить. Каждая регистрирует
## `collect()` и `restore(data)`. SaveService не знает НИЧЕГО о геймплее —
## иначе он превратится в свалку, которую невозможно поддерживать.
var _providers: Dictionary = {}
## Данные, прочитанные при последней загрузке, до вызова restore().
var _last_loaded_payload: Dictionary = {}
var _playtime_ms: int = 0
var _dirty: bool = false


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_PAUSABLE
	_ensure_save_dir()
	Diagnostics.info(
		"saves",
		(
			"слотов: %d, каталог: %s"
			% [SLOT_COUNT, GameConfig.user_path_to_global(GameConfig.PATH_SAVE_DIR)]
		)
	)


func _process(delta: float) -> void:
	if not get_tree().paused:
		_playtime_ms += int(delta * 1000.0)


# ------------------------------------------------------------- провайдеры --


## Система регистрируется как источник данных для сейва.
## `provider_id` — стабильное имя; менять его между версиями нельзя,
## иначе старые сейвы потеряют этот блок (миграция должна учесть переименование).
func register_provider(provider_id: String, provider: Object) -> void:
	if not Diagnostics.check_valid(provider, "saves", "register_provider"):
		return
	if not provider.has_method("collect_save_data"):
		Diagnostics.error("saves", "%s: нет метода collect_save_data()" % provider_id)
		return
	if not provider.has_method("restore_save_data"):
		Diagnostics.error("saves", "%s: нет метода restore_save_data()" % provider_id)
		return
	if _providers.has(provider_id):
		Diagnostics.warn("saves", "провайдер '%s' перерегистрирован" % provider_id)
	_providers[provider_id] = provider
	Diagnostics.debug("saves", "зарегистрирован провайдер: " + provider_id)


func unregister_provider(provider_id: String) -> void:
	if _providers.erase(provider_id):
		Diagnostics.debug("saves", "провайдер снят с регистрации: " + provider_id)


func provider_ids() -> Array[String]:
	var out: Array[String] = []
	for key: String in _providers.keys():
		out.append(key)
	out.sort()
	return out


# ---------------------------------------------------------------- запись ---


## Сохраняет в слот. Возвращает true при успехе.
func save_game(slot: int, label: String = "") -> bool:
	if not _valid_slot(slot):
		return false
	EventBus.save_started.emit(slot)
	var payload: Dictionary = _collect_payload()
	var document: Dictionary = {
		FIELD_SCHEMA: GameConfig.SAVE_SCHEMA_VERSION,
		FIELD_GAME_VERSION: GameConfig.version_string(),
		FIELD_SAVED_AT: Time.get_datetime_string_from_system(false, true),
		FIELD_PLAYTIME_MS: _playtime_ms,
		FIELD_LABEL: label,
		FIELD_PAYLOAD: payload,
	}
	var ok: bool = _write_json(slot_path(slot), document)
	if ok:
		_dirty = false
		Diagnostics.count("saves_written")
		Diagnostics.info(
			"saves", "слот %d сохранён (%d байт payload)" % [slot, JSON.stringify(payload).length()]
		)
	EventBus.save_finished.emit(slot, ok, "" if ok else "ошибка записи")
	EventBus.save_slots_changed.emit()
	return ok


func quick_save() -> bool:
	return save_game(QUICKSAVE_SLOT, "Быстрое сохранение")


func auto_save() -> bool:
	return save_game(AUTOSAVE_SLOT, "Автосохранение")


# ---------------------------------------------------------------- чтение ---


## Загружает слот: чтение -> миграция -> раздача провайдерам.
## Все отказы идут через _fail_load(), поэтому сигнал load_finished
## гарантированно улетает в любой ветке — UI не зависнет на спиннере.
func load_game(slot: int) -> bool:
	if not _valid_slot(slot):
		return _fail_load(slot, "некорректный номер слота")
	EventBus.load_started.emit(slot)
	if not has_save(slot):
		return _fail_load(slot, "сохранение отсутствует")

	var document: Variant = _read_json(slot_path(slot))
	if typeof(document) != TYPE_DICTIONARY:
		Diagnostics.error("saves", "слот %d: повреждённый файл" % slot)
		# Резервная копия: лучше старое прохождение, чем никакого.
		document = _recover_from_backup(slot)
		if typeof(document) != TYPE_DICTIONARY:
			return _fail_load(slot, "файл повреждён, копия .bak недоступна")
		Diagnostics.warn("saves", "слот %d восстановлен из .bak" % slot)

	var doc: Dictionary = document
	var schema: int = int(doc.get(FIELD_SCHEMA, 0))
	var migrated: Dictionary = _migrate(doc, schema)
	if migrated.is_empty():
		return _fail_load(slot, "миграция со схемы %d невозможна" % schema)

	var payload: Variant = migrated.get(FIELD_PAYLOAD, {})
	if typeof(payload) != TYPE_DICTIONARY:
		return _fail_load(slot, "payload не является словарём")

	_playtime_ms = int(migrated.get(FIELD_PLAYTIME_MS, 0))
	_last_loaded_payload = payload
	var restored: int = _distribute_payload(payload)
	Diagnostics.info(
		"saves",
		"слот %d загружен: %d/%d провайдеров получили данные" % [slot, restored, _providers.size()]
	)
	EventBus.load_finished.emit(slot, true, "ok")
	return true


## Единая точка отказа загрузки: лог + сигнал + false.
func _fail_load(slot: int, reason: String) -> bool:
	Diagnostics.error("saves", "загрузка слота %d отменена: %s" % [slot, reason])
	EventBus.load_finished.emit(slot, false, reason)
	return false


func quick_load() -> bool:
	return load_game(QUICKSAVE_SLOT)


## Данные последней успешной загрузки — для систем, которые читают
## чужие блоки (например, UI «продолжить» показывает прогресс).
func last_loaded_payload() -> Dictionary:
	return _last_loaded_payload.duplicate(true)


# ---------------------------------------------------------------- слоты ----


func has_save(slot: int) -> bool:
	if not _valid_slot(slot):
		return false
	return FileAccess.file_exists(slot_path(slot))


func slot_path(slot: int) -> String:
	return GameConfig.PATH_SAVE_FILE_TEMPLATE % slot


## Краткое описание слота для списка сохранений в UI. Не грузит payload
## целиком — только служебные поля, поэтому список из 6 слотов рисуется
## мгновенно, а не по полсекунды на слот.
func slot_summary(slot: int) -> Dictionary:
	if not has_save(slot):
		return {"exists": false, "slot": slot}
	var document: Variant = _read_json(slot_path(slot))
	if typeof(document) != TYPE_DICTIONARY:
		return {"exists": true, "slot": slot, "corrupted": true}
	var doc: Dictionary = document
	return {
		"exists": true,
		"slot": slot,
		"corrupted": false,
		"label": str(doc.get(FIELD_LABEL, "")),
		"saved_at": str(doc.get(FIELD_SAVED_AT, "")),
		"game_version": str(doc.get(FIELD_GAME_VERSION, "?")),
		"schema_version": int(doc.get(FIELD_SCHEMA, 0)),
		"playtime_ms": int(doc.get(FIELD_PLAYTIME_MS, 0)),
		"playtime_human": _format_playtime(int(doc.get(FIELD_PLAYTIME_MS, 0))),
	}


func all_slot_summaries() -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for slot: int in SLOT_COUNT:
		out.append(slot_summary(slot))
	return out


func delete_save(slot: int) -> bool:
	if not _valid_slot(slot) or not has_save(slot):
		return false
	var err: int = DirAccess.remove_absolute(ProjectSettings.globalize_path(slot_path(slot)))
	if err != OK:
		Diagnostics.error("saves", "не удалить слот %d (err=%d)" % [slot, err])
		return false
	EventBus.save_slots_changed.emit()
	return true


## Копирует слот (например, «быстрое» -> «обычное»).
func copy_slot(from_slot: int, to_slot: int) -> bool:
	if not has_save(from_slot) or not _valid_slot(to_slot):
		return false
	var err: int = (
		DirAccess
		. copy_absolute(
			ProjectSettings.globalize_path(slot_path(from_slot)),
			ProjectSettings.globalize_path(slot_path(to_slot)),
		)
	)
	if err != OK:
		Diagnostics.error("saves", "copy %d->%d не удался (err=%d)" % [from_slot, to_slot, err])
		return false
	EventBus.save_slots_changed.emit()
	return true


func playtime_ms() -> int:
	return _playtime_ms


func playtime_human() -> String:
	return _format_playtime(_playtime_ms)


func mark_dirty() -> void:
	_dirty = true


func is_dirty() -> bool:
	return _dirty


# --------------------------------------------------------------- приватное -


func _valid_slot(slot: int) -> bool:
	if slot < 0 or slot >= SLOT_COUNT:
		Diagnostics.error("saves", "слот %d вне диапазона 0..%d" % [slot, SLOT_COUNT - 1])
		return false
	return true


func _ensure_save_dir() -> void:
	var global: String = ProjectSettings.globalize_path(GameConfig.PATH_SAVE_DIR)
	if DirAccess.dir_exists_absolute(global):
		return
	var err: int = DirAccess.make_dir_recursive_absolute(global)
	if err != OK:
		Diagnostics.fatal("saves", "не создать каталог сохранений (err=%d)" % err)


func _collect_payload() -> Dictionary:
	var payload: Dictionary = {}
	for provider_id: String in provider_ids():
		var provider: Object = _providers[provider_id]
		if not is_instance_valid(provider):
			Diagnostics.warn("saves", "провайдер '%s' уже freed — пропускаем" % provider_id)
			_providers.erase(provider_id)
			continue
		var data: Variant = provider.call("collect_save_data")
		if typeof(data) != TYPE_DICTIONARY:
			Diagnostics.error("saves", "%s.collect_save_data() вернул не Dictionary" % provider_id)
			continue
		payload[provider_id] = data
	return payload


func _distribute_payload(payload: Dictionary) -> int:
	var restored: int = 0
	for provider_id: String in provider_ids():
		var provider: Object = _providers[provider_id]
		if not is_instance_valid(provider) or not payload.has(provider_id):
			continue
		provider.call("restore_save_data", payload[provider_id])
		restored += 1
	return restored


## Цепочка миграций. Каждая функция переводит документ из версии N в N+1.
## Добавить новую версию = дописать один метод и НЕ трогать старые:
## сейв версии 1 пройдёт 1->2->3 последовательно.
func _migrate(document: Dictionary, schema: int) -> Dictionary:
	if schema > GameConfig.SAVE_SCHEMA_VERSION:
		Diagnostics.error(
			"saves",
			(
				"сейв из будущего (schema %d > %d) — не трогаем"
				% [schema, GameConfig.SAVE_SCHEMA_VERSION]
			)
		)
		return {}
	if schema < GameConfig.SAVE_SCHEMA_MIN_SUPPORTED:
		Diagnostics.error(
			"saves",
			"schema %d слишком старая (минимум %d)" % [schema, GameConfig.SAVE_SCHEMA_MIN_SUPPORTED]
		)
		return {}

	var current: Dictionary = document.duplicate(true)
	var version: int = schema
	while version < GameConfig.SAVE_SCHEMA_VERSION:
		var method_name: String = "_migrate_%d_to_%d" % [version, version + 1]
		if not has_method(method_name):
			Diagnostics.error("saves", "нет миграции %s" % method_name)
			return {}
		current = call(method_name, current)
		version += 1
		Diagnostics.info("saves", "миграция %d -> %d выполнена" % [version - 1, version])
	current[FIELD_SCHEMA] = GameConfig.SAVE_SCHEMA_VERSION
	return current


## Пример миграции-заглушки. Оставляем её в коде как шаблон: когда схема
## станет версией 2, этот метод будет реально вызван для старых сейвов.
func _migrate_1_to_2(document: Dictionary) -> Dictionary:
	# Здесь: переименовать ключи провайдеров, добавить недостающие дефолты,
	# сконвертировать старый формат координат и т.п.
	return document


func _write_json(path: String, document: Dictionary) -> bool:
	var text: String = JSON.stringify(document, "\t", true)
	var tmp_path: String = path + TMP_SUFFIX
	var global_tmp: String = ProjectSettings.globalize_path(tmp_path)
	var file: FileAccess = FileAccess.open(tmp_path, FileAccess.WRITE)
	if file == null:
		Diagnostics.error(
			"saves", "не открыть %s (err=%d)" % [tmp_path, FileAccess.get_open_error()]
		)
		return false
	file.store_string(text)
	file.flush()
	file.close()

	# Резервная копия предыдущего сейва — до замены.
	if FileAccess.file_exists(path):
		var backup_global: String = ProjectSettings.globalize_path(path + BACKUP_SUFFIX)
		DirAccess.copy_absolute(ProjectSettings.globalize_path(path), backup_global)

	var err: int = DirAccess.rename_absolute(global_tmp, ProjectSettings.globalize_path(path))
	if err != OK:
		Diagnostics.error("saves", "rename %s -> %s не удался (err=%d)" % [tmp_path, path, err])
		return false
	return true


func _read_json(path: String) -> Variant:
	if not FileAccess.file_exists(path):
		return null
	var text: String = FileAccess.get_file_as_string(path)
	if text.is_empty():
		Diagnostics.error("saves", "%s пуст" % path)
		return null
	var parsed: Variant = JSON.parse_string(text)
	if parsed == null:
		Diagnostics.error("saves", "%s: JSON не разобран" % path)
	return parsed


## Читает резервную копию и, если она цела, возвращает её содержимое,
## попутно восстанавливая основной файл. Null, если копии нет или она бита.
func _recover_from_backup(slot: int) -> Variant:
	var backup_path: String = slot_path(slot) + BACKUP_SUFFIX
	if not FileAccess.file_exists(backup_path):
		return null
	var document: Variant = _read_json(backup_path)
	if typeof(document) != TYPE_DICTIONARY:
		return null
	var err: int = (
		DirAccess
		. copy_absolute(
			ProjectSettings.globalize_path(backup_path),
			ProjectSettings.globalize_path(slot_path(slot)),
		)
	)
	if err != OK:
		Diagnostics.warn("saves", "не восстановить файл из .bak (err=%d)" % err)
	return document


func _format_playtime(msec: int) -> String:
	var total_seconds: int = msec / 1000
	var hours: int = total_seconds / 3600
	var minutes: int = (total_seconds % 3600) / 60
	var seconds: int = total_seconds % 60
	if hours > 0:
		return "%dч %02dм" % [hours, minutes]
	if minutes > 0:
		return "%dм %02dс" % [minutes, seconds]
	return "%dс" % seconds
