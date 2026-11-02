extends Node
## GameConfig — единственный источник правды о константах проекта.
##
## Автолоад. Инициализируется ПЕРВЫМ, поэтому на него могут safely
## опираться все остальные сервисы.
##
## Правило проекта: никакая «магическая» строка пути и никакое числовое
## значение баланса не должны жить в геймплейных скриптах. Всё — сюда
## или в .tres-ресурсы. Это то, что отличает поддерживаемый проект от
## прототипа, который разваливается при первом же рефакторинге.

## ---------------------------------------------------------------- слои ----
## Совпадают с [layer_names] в project.godot. Держим константами, чтобы
## битовые маски не были размазаны по коду магическими числами.
enum PhysicsLayer {
	WORLD = 1,
	PLAYER = 2,
	ENEMY = 3,
	PROJECTILE = 4,
	INTERACTABLE = 5,
	DEBRIS = 6,
	TRIGGER = 7,
	RAGDOLL = 8,
}
enum RenderLayer {
	DEFAULT = 1,
	FIRST_PERSON = 2,
	GHOST = 3,
	OUTLINE = 4,
	FX = 5,
}

## Версия проекта. Пишется в сохранения и в лог; нужна, чтобы миграция
## старых сейвов не была гаданием.
const VERSION_MAJOR: int = 0
const VERSION_MINOR: int = 1
const VERSION_PATCH: int = 0

## Схема сейва. Поднимается при КАЖДОМ несовместимом изменении формата.
## SaveService использует её, чтобы решить: мигрировать или начать заново.
const SAVE_SCHEMA_VERSION: int = 1

## Минимальная версия схемы, из которой мы ещё умее мигрировать.
const SAVE_SCHEMA_MIN_SUPPORTED: int = 1

## ---------------------------------------------------------------- пути ----
const PATH_SETTINGS: String = "user://settings.cfg"
const PATH_SAVE_DIR: String = "user://saves"
const PATH_SAVE_FILE_TEMPLATE: String = "user://saves/save_%d.dat"
const PATH_LOG_FILE: String = "user://logs/session.log"
const PATH_CREDITS_DATA: String = "res://data/credits.json"

## ---------------------------------------------------------------- сцены ---
const SCENE_BOOT: String = "res://scenes/boot/boot.tscn"
const SCENE_MAIN_MENU: String = "res://scenes/menu/main_menu.tscn"
const SCENE_WORLD: String = "res://scenes/game/world.tscn"
const SCENE_LOADING: String = "res://scenes/common/loading_screen.tscn"

## Маска того, с чем сталкивается игрок: мир + интерактив + мусор.
const PLAYER_COLLISION_MASK: int = (
	(1 << (PhysicsLayer.WORLD - 1))
	| (1 << (PhysicsLayer.INTERACTABLE - 1))
	| (1 << (PhysicsLayer.DEBRIS - 1))
)

## ---------------------------------------------------------------- видео ---
const DESIGN_RESOLUTION: Vector2i = Vector2i(1920, 1080)
const MIN_WINDOW_SIZE: Vector2i = Vector2i(960, 540)
const DEFAULT_MAX_FPS: int = 0  # 0 = без ограничения (vsync рулит)
const MOUSE_SENSITIVITY_DEFAULT: float = 0.35
const MOUSE_SENSITIVITY_RANGE: Vector2 = Vector2(0.05, 2.0)

## ------------------------------------------------------------- аудио ------
const BUS_MASTER: String = "Master"
const BUS_MUSIC: String = "Music"
const BUS_SFX: String = "SFX"
const BUS_VOICE: String = "Voice"
const BUS_AMBIENT: String = "Ambient"

## Все шины, которыми управляет меню настроек. Порядок = порядок в UI.
const AUDIO_BUSES: Array[String] = [
	BUS_MASTER,
	BUS_MUSIC,
	BUS_SFX,
	BUS_VOICE,
	BUS_AMBIENT,
]

## Нормированная громкость 0..1 -> децибелы.
## MIN_VOLUME_DB — фактически «выключено», но без щелчка от mute.
const VOLUME_DB_MIN: float = -60.0
const VOLUME_DB_MAX: float = 6.0

## ------------------------------------------------------------ геймплей ----
const GRAVITY: float = 9.81
const PLAYER_EYE_HEIGHT: float = 1.62
const PLAYER_RADIUS: float = 0.35
const PLAYER_HEIGHT: float = 1.8
const INTERACT_MAX_DISTANCE: float = 3.0
const INTERACT_MAX_ANGLE_DEG: float = 45.0

## Разрушение. Бюджеты жёсткие — их нарушение ломает фреймрейт, поэтому
## они вынесены сюда и покрыты тестами (tests/unit/test_budgets.gd).
const DESTRUCTION_MAX_ACTIVE_CHUNKS: int = 1024
const DESTRUCTION_MAX_CONCURRENT_BREAKS: int = 4
const DESTRUCTION_DEBRIS_LIFETIME: float = 12.0
const DESTRUCTION_CELL_SIZE: float = 0.5

## ------------------------------------------------------------- отладка ----
## Всё, что должно быть ВЫКЛЮЧЕНО в релизном экспорте.
const DEBUG_OVERLAY_ENABLED_DEFAULT: bool = false
const DEBUG_CONSOLE_ENABLED_DEFAULT: bool = false


## Полный текст версии: "0.1.0"
static func version_string() -> String:
	return "%d.%d.%d" % [VERSION_MAJOR, VERSION_MINOR, VERSION_PATCH]


## Полный текст версии со схемой сейва: "0.1.0 (schema 1)"
static func version_full() -> String:
	return "%s (schema %d)" % [version_string(), SAVE_SCHEMA_VERSION]


## true, если сейчас debug-сборка (запуск из редактора или template_debug).
static func is_debug_runtime() -> bool:
	return OS.is_debug_build()


## Нормированную громкость (0..1) переводит в децибелы по логарифмической
## кривой. Линейная шкала в дБ ощущается игроком как «первые 80% ползунка
## не делают ничего» — поэтому clamp + линейная интерполяция в дБ.
static func volume_linear_to_db(linear: float) -> float:
	var clamped: float = clampf(linear, 0.0, 1.0)
	if clamped <= 0.0001:
		return VOLUME_DB_MIN
	return lerpf(VOLUME_DB_MIN, VOLUME_DB_MAX, clamped)


## Обратное преобразование — нужно, чтобы показать значение в UI.
static func volume_db_to_linear(db: float) -> float:
	if db <= VOLUME_DB_MIN:
		return 0.0
	return clampf(inverse_lerp(VOLUME_DB_MIN, VOLUME_DB_MAX, db), 0.0, 1.0)


## Номер бита слоя по имени enum'а. Удобно для масок в инспекторе.
static func physics_layer_bit(layer: PhysicsLayer) -> int:
	return 1 << (layer - 1)


## Проверяет, что путь существует в файловой системе проекта/пользователя.
## Используется в тестах и валидаторе, чтобы опечатка в пути не долетела
## до релиза как «чёрный экран при загрузке».
static func resource_exists_at(path: String) -> bool:
	if path.is_empty():
		return false
	return ResourceLoader.exists(path)


## Абсолютный путь на диске для user:// — нужен логам и багрепортам.
static func user_path_to_global(path: String) -> String:
	return ProjectSettings.globalize_path(path)
