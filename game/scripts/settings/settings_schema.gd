class_name SettingsSchema
extends RefCounted
## SettingsSchema — ОПИСАНИЕ настроек как данные.
##
## Вынесено из SettingsService по двум причинам:
##   1. Это данные, а не поведение. Смешивать их в одном файле — значит
##      получить файл на 900 строк, где схему настроек физически невозможно
##      просмотреть целиком (gdlint max-file-lines на этом и ловит).
##   2. UI настроек строится из схемы напрямую и не должен тянуть за собой
##      весь сервис с его применением к движку.
##
## Каждый ключ описывается ОДИН раз: секция, тип, границы, дефолт, подпись
## и подсказка. Дальше схема сама порождает и UI, и валидацию, и сохранение,
## и тесты. Добавили настройку в SCHEMA — она появилась в меню, в файле
## настроек и в проверках. Нигде больше править не нужно.
##
## Статические методы: схема не имеет состояния, экземпляр ей не нужен.

enum SettingType { BOOL, INT, FLOAT, ENUM, STRING }

## Секции — они же вкладки в UI настроек.
const SECTION_VIDEO: String = "video"
const SECTION_AUDIO: String = "audio"
const SECTION_INPUT: String = "input"
const SECTION_GAMEPLAY: String = "gameplay"
const SECTION_ACCESSIBILITY: String = "accessibility"

const SECTIONS: Array[String] = [
	SECTION_VIDEO,
	SECTION_AUDIO,
	SECTION_INPUT,
	SECTION_GAMEPLAY,
	SECTION_ACCESSIBILITY,
]

const CONFIG_SECTION: String = "settings"

## ------------------------------------------------------------- SCHEMA -----
## Каждый ключ: section, type, default, label, hint.
## Для INT/FLOAT — min/max/step. Для ENUM — options (Array[String]).
const SCHEMA: Dictionary = {
	# ---------------- видео ----------------
	"video/quality_preset":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.ENUM,
		"default": 2,
		"options": ["Низкое", "Среднее", "Высокое", "Ультра"],
		"label": "Пресет качества",
		"hint": "Готовый набор параметров. Ручные правки ниже переключают его в «Своё».",
	},
	"video/window_mode":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.ENUM,
		"default": 0,
		"options": ["Оконный", "Без рамки", "Полный экран"],
		"label": "Режим окна",
		"hint": "",
	},
	"video/vsync":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.ENUM,
		"default": 1,
		"options": ["Выкл", "Вкл", "Адаптивный"],
		"label": "Вертикальная синхронизация",
		"hint": "Убирает разрывы кадра. «Выкл» даёт минимальную задержку ввода.",
	},
	"video/max_fps":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.INT,
		"default": 0,
		"min": 0,
		"max": 360,
		"step": 1,
		"label": "Ограничение FPS",
		"hint": "0 = без ограничения.",
	},
	"video/msaa_3d":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.ENUM,
		"default": 2,
		"options": ["Выкл", "2x", "4x", "8x"],
		"label": "MSAA (3D)",
		"hint": "Сглаживание геометрии. Дороже всего на 8x.",
	},
	"video/screen_space_aa":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.ENUM,
		"default": 1,
		"options": ["Выкл", "FXAA", "FSR 1.0"],
		"label": "Экранное сглаживание",
		"hint": "",
	},
	"video/taa":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.BOOL,
		"default": true,
		"label": "TAA",
		"hint": "Временное сглаживание. Может «мылить» в движении.",
	},
	"video/scaling_mode":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.ENUM,
		"default": 1,
		"options": ["Выкл", "Билинейное", "FSR 1.0", "FSR 2.2"],
		"label": "Масштабирование 3D",
		"hint": "Рендер в меньшем разрешении с апскейлом.",
	},
	"video/scaling_scale":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.FLOAT,
		"default": 1.0,
		"min": 0.5,
		"max": 1.0,
		"step": 0.05,
		"label": "Масштаб рендера",
		"hint": "1.0 = нативное разрешение.",
	},
	"video/anisotropic_filtering":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.ENUM,
		"default": 2,
		"options": ["Выкл", "2x", "4x", "8x", "16x"],
		"label": "Анизотропная фильтрация",
		"hint": "",
	},
	"video/shadow_quality":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.ENUM,
		"default": 2,
		"options": ["Выкл", "Низкое", "Среднее", "Высокое", "Ультра"],
		"label": "Качество теней",
		"hint": "",
	},
	"video/occlusion_culling":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.BOOL,
		"default": true,
		"label": "Отсечение невидимого",
		"hint": "Occlusion culling. Требует Occulder3D в сцене, иначе бесполезно.",
	},
	"video/ssao":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.BOOL,
		"default": true,
		"label": "SSAO",
		"hint": "Контактные тени в углах.",
	},
	"video/ssil":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.BOOL,
		"default": false,
		"label": "SSIL",
		"hint": "Экранное непрямое освещение. Дорого.",
	},
	"video/ssr":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.BOOL,
		"default": false,
		"label": "SSR",
		"hint": "Экранные отражения. Дорого.",
	},
	"video/glow":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.BOOL,
		"default": true,
		"label": "Свечение (Bloom)",
		"hint": "",
	},
	"video/volumetric_fog":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.BOOL,
		"default": false,
		"label": "Объёмный туман",
		"hint": "Очень дорого на слабом железе.",
	},
	"video/sdfgi":
	{
		"section": SECTION_VIDEO,
		"type": SettingType.BOOL,
		"default": false,
		"label": "SDFGI",
		"hint": "Глобальное освещение в реальном времени.",
	},
	# ---------------- аудио ----------------
	"audio/master_volume":
	{
		"section": SECTION_AUDIO,
		"type": SettingType.FLOAT,
		"default": 0.9,
		"min": 0.0,
		"max": 1.0,
		"step": 0.01,
		"label": "Общая громкость",
		"hint": "",
	},
	"audio/music_volume":
	{
		"section": SECTION_AUDIO,
		"type": SettingType.FLOAT,
		"default": 0.7,
		"min": 0.0,
		"max": 1.0,
		"step": 0.01,
		"label": "Музыка",
		"hint": "",
	},
	"audio/sfx_volume":
	{
		"section": SECTION_AUDIO,
		"type": SettingType.FLOAT,
		"default": 0.85,
		"min": 0.0,
		"max": 1.0,
		"step": 0.01,
		"label": "Эффекты",
		"hint": "",
	},
	"audio/voice_volume":
	{
		"section": SECTION_AUDIO,
		"type": SettingType.FLOAT,
		"default": 1.0,
		"min": 0.0,
		"max": 1.0,
		"step": 0.01,
		"label": "Голос",
		"hint": "",
	},
	"audio/ambient_volume":
	{
		"section": SECTION_AUDIO,
		"type": SettingType.FLOAT,
		"default": 0.6,
		"min": 0.0,
		"max": 1.0,
		"step": 0.01,
		"label": "Окружение",
		"hint": "",
	},
	"audio/mute":
	{
		"section": SECTION_AUDIO,
		"type": SettingType.BOOL,
		"default": false,
		"label": "Выключить звук",
		"hint": "",
	},
	# ---------------- ввод ----------------
	"input/mouse_sensitivity":
	{
		"section": SECTION_INPUT,
		"type": SettingType.FLOAT,
		"default": 0.35,
		"min": 0.05,
		"max": 2.0,
		"step": 0.01,
		"label": "Чувствительность мыши",
		"hint": "",
	},
	"input/invert_y":
	{
		"section": SECTION_INPUT,
		"type": SettingType.BOOL,
		"default": false,
		"label": "Инвертировать ось Y",
		"hint": "",
	},
	"input/gamepad_deadzone":
	{
		"section": SECTION_INPUT,
		"type": SettingType.FLOAT,
		"default": 0.2,
		"min": 0.05,
		"max": 0.5,
		"step": 0.01,
		"label": "Мёртвая зона геймпада",
		"hint": "",
	},
	"input/gamepad_vibration":
	{
		"section": SECTION_INPUT,
		"type": SettingType.BOOL,
		"default": true,
		"label": "Вибрация геймпада",
		"hint": "",
	},
	# ---------------- геймплей ----------------
	"gameplay/language":
	{
		"section": SECTION_GAMEPLAY,
		"type": SettingType.ENUM,
		"default": 0,
		"options": ["ru", "en"],
		"label": "Язык",
		"hint": "Код локали.",
	},
	"gameplay/difficulty":
	{
		"section": SECTION_GAMEPLAY,
		"type": SettingType.ENUM,
		"default": 1,
		"options": ["Спокойно", "Норма", "Вызов", "Кошмар"],
		"label": "Сложность",
		"hint": "",
	},
	"gameplay/subtitles":
	{
		"section": SECTION_GAMEPLAY,
		"type": SettingType.BOOL,
		"default": true,
		"label": "Субтитры",
		"hint": "",
	},
	"gameplay/show_fps":
	{
		"section": SECTION_GAMEPLAY,
		"type": SettingType.BOOL,
		"default": false,
		"label": "Показывать FPS",
		"hint": "",
	},
	"gameplay/head_bob":
	{
		"section": SECTION_GAMEPLAY,
		"type": SettingType.BOOL,
		"default": true,
		"label": "Покачивание камеры при ходьбе",
		"hint": "Добавляет движения. Отключите при укачивании — камера станет статичной.",
	},
	"gameplay/auto_quality":
	{
		"section": SECTION_GAMEPLAY,
		"type": SettingType.BOOL,
		"default": true,
		"label": "Адаптивное качество",
		"hint": "Автоматически понижает пресет при просадках FPS.",
	},
	# ---------------- доступность ----------------
	"accessibility/fov":
	{
		"section": SECTION_ACCESSIBILITY,
		"type": SettingType.FLOAT,
		"default": 75.0,
		"min": 60.0,
		"max": 110.0,
		"step": 1.0,
		"label": "Угол обзора (FOV)",
		"hint": "",
	},
	"accessibility/screen_shake":
	{
		"section": SECTION_ACCESSIBILITY,
		"type": SettingType.FLOAT,
		"default": 1.0,
		"min": 0.0,
		"max": 1.0,
		"step": 0.05,
		"label": "Тряска камеры",
		"hint": "0 полностью убирает тряску.",
	},
	"accessibility/font_scale":
	{
		"section": SECTION_ACCESSIBILITY,
		"type": SettingType.FLOAT,
		"default": 1.0,
		"min": 0.8,
		"max": 1.6,
		"step": 0.05,
		"label": "Размер текста",
		"hint": "",
	},
	"accessibility/colorblind_mode":
	{
		"section": SECTION_ACCESSIBILITY,
		"type": SettingType.ENUM,
		"default": 0,
		"options": ["Выкл", "Протанопия", "Дейтеранопия", "Тританопия"],
		"label": "Режим дальтонизма",
		"hint": "",
	},
}

## Значения, загруженные из файла, но отсутствующие в SCHEMA. Не выбрасываем
## их молча: при сохранении пишем обратно, чтобы обновление версии не стирало
## пользовательские данные, которых эта версия просто не знает.


## Все ключи схемы, отсортированные. Порядок стабилен — важно и для UI,
## и для воспроизводимости тестов.
static func all_keys() -> Array[String]:
	var out: Array[String] = []
	for key: String in SCHEMA.keys():
		out.append(key)
	out.sort()
	return out


## Ключи одной секции. Секция = вкладка в меню настроек.
static func keys_in_section(section: String) -> Array[String]:
	var out: Array[String] = []
	for key: String in all_keys():
		if str(SCHEMA[key]["section"]) == section:
			out.append(key)
	return out


## Значения по умолчанию для всей схемы.
static func defaults() -> Dictionary:
	var out: Dictionary = {}
	for key: String in all_keys():
		out[key] = SCHEMA[key]["default"]
	return out


## Полное описание настройки для построения UI.
static func describe(key: String) -> Dictionary:
	if not SCHEMA.has(key):
		return {}
	var meta: Dictionary = SCHEMA[key].duplicate(true)
	meta["key"] = key
	return meta


## Самопроверка схемы. Гоняется тестом на каждом прогоне CI: опечатка
## в SCHEMA должна падать в пайплайне, а не у игрока в меню настроек.
static func validate() -> Array[String]:
	var problems: Array[String] = []
	for key: String in all_keys():
		var meta: Dictionary = SCHEMA[key]
		for required: String in ["section", "type", "default", "label", "hint"]:
			if not meta.has(required):
				problems.append("%s: нет поля '%s'" % [key, required])
		if not SECTIONS.has(str(meta.get("section", ""))):
			problems.append("%s: неизвестная секция '%s'" % [key, str(meta["section"])])
		var type_id: int = int(meta.get("type", -1))
		if type_id < 0 or type_id > SettingType.STRING:
			problems.append("%s: некорректный type=%d" % [key, type_id])
		if type_id == SettingType.ENUM and not meta.has("options"):
			problems.append("%s: ENUM без options" % key)
		if not meta.has("default"):
			continue
		if not _default_is_valid(meta):
			problems.append("%s: дефолт не проходит собственную валидацию" % key)
	return problems


## Дефолт обязан попадать в собственные границы. Проверяем здесь, а не
## через SettingsService, чтобы схема не зависела от сервиса.
static func _default_is_valid(meta: Dictionary) -> bool:
	var value: Variant = meta["default"]
	match int(meta["type"]):
		SettingType.BOOL:
			return value is bool
		SettingType.INT:
			return (
				(value is int or value is float)
				and int(value) >= int(meta.get("min", -2147483648))
				and int(value) <= int(meta.get("max", 2147483647))
			)
		SettingType.FLOAT:
			return (
				(value is int or value is float)
				and float(value) >= float(meta.get("min", 0.0))
				and float(value) <= float(meta.get("max", 1.0))
			)
		SettingType.ENUM:
			var options: Array = meta.get("options", [])
			return int(value) >= 0 and int(value) < options.size()
		SettingType.STRING:
			return value is String
	return false
