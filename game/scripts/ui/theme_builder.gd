extends Node
## ThemeService — собирает и поддерживает единую тему интерфейса.
##
## АВТОЛОАД, а не нода внутри boot.tscn: тема нужна и меню, и HUD, и
## диалогам в любой сцене. Нода в boot-сцене умирает вместе с ней, и
## пересобрать тему из меню было бы невозможно.
##
## Вторая обязанность — СЛЕДИТЬ за font_scale. При изменении масштаба
## текста в настройках доступности тема пересобирается и применяется ко
## всему дереву заново. Без этого меню, открытое до изменения настройки,
## осталось бы со старым размером шрифта.
##
## ЗАЧЕМ КОДОМ, А НЕ .tres. Тема в Godot — это сотни свойств, разложенных
## по типам контролов и их вариациям. В .tres её невозможно ни прочитать,
## ни продиффить: изменение цвета кнопки выглядит как правка двадцати строк
## с Resource-ссылками. Здесь вся дизайн-система видна целиком, на одном
## экране, и меняется в одном месте.
##
## ЧТО ЭТО ДАЁТ ПРОЕКТУ. Одна палитра + одна типографская шкала = все меню,
## HUD и диалоги выглядят как части ОДНОЙ игры. Именно отсутствие этого
## и выдаёт «сборную солянку из ассетов», которую принято называть ИИ-слопом:
## каждая кнопка из своего набора, три оттенка серого, четыре размера шрифта.
##
## Доступность заложена сюда же: `font_scale` из настроек масштабирует
## ВСЕ размеры шрифтов, а не один Label, который кто-то не забыл поправить.

## --------------------------------------------------------------------------
##  ПАЛИТРА. Единственное место, где задаются цвета интерфейса.
##  Имена — токены, а не «синий_тёмный»: токен живёт дольше конкретного
##  цвета, и перекраска игры не требует переписывать половину UI.
## --------------------------------------------------------------------------
const COLOR_BACKGROUND_DEEP: Color = Color(0.055, 0.063, 0.082, 1.0)
const COLOR_BACKGROUND_SURFACE: Color = Color(0.086, 0.098, 0.125, 0.92)
const COLOR_BACKGROUND_ELEVATED: Color = Color(0.118, 0.133, 0.169, 0.96)
const COLOR_BACKGROUND_HOVER: Color = Color(0.157, 0.176, 0.220, 0.98)

const COLOR_BORDER_SUBTLE: Color = Color(1.0, 1.0, 1.0, 0.07)
const COLOR_BORDER_STRONG: Color = Color(1.0, 1.0, 1.0, 0.16)
const COLOR_BORDER_FOCUS: Color = Color(0.420, 0.760, 0.920, 0.95)

const COLOR_TEXT_PRIMARY: Color = Color(0.925, 0.937, 0.957, 1.0)
const COLOR_TEXT_SECONDARY: Color = Color(0.643, 0.678, 0.733, 1.0)
const COLOR_TEXT_DISABLED: Color = Color(0.400, 0.427, 0.475, 1.0)
const COLOR_TEXT_ON_ACCENT: Color = Color(0.035, 0.051, 0.071, 1.0)

## Акцент — один на всю игру. Два акцентных цвета в интерфейсе уже читаются
## как беспорядок: игрок перестаёт понимать, что важно.
const COLOR_ACCENT: Color = Color(0.420, 0.760, 0.920, 1.0)
const COLOR_ACCENT_HOVER: Color = Color(0.545, 0.835, 0.965, 1.0)
const COLOR_ACCENT_PRESSED: Color = Color(0.306, 0.631, 0.800, 1.0)

const COLOR_DANGER: Color = Color(0.886, 0.325, 0.302, 1.0)
const COLOR_WARNING: Color = Color(0.937, 0.706, 0.290, 1.0)
const COLOR_SUCCESS: Color = Color(0.400, 0.784, 0.522, 1.0)

## Ползунки и прогресс: фон всегда темнее активного заполнения, иначе
## непонятно, где текущее значение.
const COLOR_TRACK: Color = Color(0.0, 0.0, 0.0, 0.38)
const COLOR_PROGRESS_BACKGROUND: Color = Color(0.0, 0.0, 0.0, 0.42)

## --------------------------------------------------------------------------
##  ТИПОГРАФИКА. Модульная шкала с шагом 1.25.
##  Случайные размеры шрифта — вторая по заметности примета кустарного UI.
## --------------------------------------------------------------------------
const FONT_SIZE_CAPTION: int = 12
const FONT_SIZE_BODY: int = 15
const FONT_SIZE_BODY_LARGE: int = 17
const FONT_SIZE_SUBTITLE: int = 21
const FONT_SIZE_TITLE: int = 27
const FONT_SIZE_DISPLAY: int = 44

const FONT_SCALE_MIN: float = 0.8
const FONT_SCALE_MAX: float = 1.6

## --------------------------------------------------------------------------
##  ГЕОМЕТRIA. Отступы и скругления — тоже токены.
## --------------------------------------------------------------------------
const RADIUS_SMALL: int = 4
const RADIUS_MEDIUM: int = 8
const RADIUS_LARGE: int = 14

const MARGIN_COMPACT: int = 8
const MARGIN_NORMAL: int = 14
const MARGIN_SPACIOUS: int = 22

const SEPARATION_TIGHT: int = 6
const SEPARATION_NORMAL: int = 12
const SEPARATION_LOOSE: int = 24

const BORDER_WIDTH: int = 1
const BUTTON_MIN_HEIGHT: int = 42

## Кандидаты на системный шрифт. Порядок важен: первый найденный wins.
## Системный шрифт (SystemFont) вместо встроенного файла — осознанный выбор
## для стартового набора: он не весит 300 КБ и корректно рисует кириллицу.
## Для релиза сюда нужно положить лицензированный .ttf/.otf и заменить
## _build_font() — см. docs/04_ASSET_SOURCES.md.
const SYSTEM_FONT_CANDIDATES: Array[String] = [
	"Inter",
	"Segoe UI",
	"Noto Sans",
	"DejaVu Sans",
	"Liberation Sans",
	"Roboto",
	"Helvetica Neue",
	"Arial",
]

const MONOSPACE_CANDIDATES: Array[String] = [
	"JetBrains Mono",
	"Cascadia Mono",
	"DejaVu Sans Mono",
	"Consolas",
	"Liberation Mono",
	"monospace",
]

var _applied_scale: float = -1.0
var _theme: Theme = null


## Применяет тему к корню дерева. Вызывается один раз при старте.
func apply_globally() -> bool:
	_theme = build_theme()
	if _theme == null:
		return false
	get_tree().root.theme = _theme
	_applied_scale = _font_scale()
	Diagnostics.info("theme", "тема применена глобально (scale=%.2f)" % _applied_scale)
	return true


## Пересобирает тему, если изменился масштаб шрифта. Возвращает true,
## если пересборка действительно произошла.
func rebuild_if_needed() -> bool:
	var current: float = _font_scale()
	if absf(current - _applied_scale) < 0.001:
		return false
	_theme = build_theme()
	get_tree().root.theme = _theme
	Diagnostics.info("theme", "тема пересобрана: scale %.2f -> %.2f" % [_applied_scale, current])
	_applied_scale = current
	return true


func current_theme() -> Theme:
	return _theme


func applied_scale() -> float:
	return _applied_scale


func build_theme() -> Theme:
	var theme := Theme.new()
	theme.default_font = _build_font(SYSTEM_FONT_CANDIDATES)
	theme.default_font_size = _scaled(FONT_SIZE_BODY)

	_apply_colors(theme)
	_apply_font_sizes(theme)
	_apply_constants(theme)
	_apply_buttons(theme)
	_apply_panels(theme)
	_apply_inputs(theme)
	_apply_labels(theme)
	_apply_scrollbars(theme)

	Diagnostics.info(
		"theme", "тема собрана: scale=%.2f, base=%dpx" % [_font_scale(), theme.default_font_size]
	)
	return theme


## Масштаб шрифта из настроек доступности.
## SettingsService — автолоад, к моменту _ready() Boot он уже жив
## (порядок автозагрузок задан в project.godot).
func _font_scale() -> float:
	var raw: float = SettingsService.get_float("accessibility/font_scale")
	return clampf(raw, FONT_SCALE_MIN, FONT_SCALE_MAX)


func _scaled(base_size: int) -> int:
	return int(round(float(base_size) * _font_scale()))


func _build_font(candidates: Array[String]) -> Font:
	var font := SystemFont.new()
	var names: PackedStringArray = PackedStringArray()
	for candidate: String in candidates:
		names.append(candidate)
	font.font_names = names
	# Антиалиасинг и хинтинг: без хинтинга мелкий текст на 1080p расплывается.
	font.allow_system_fallback = true
	font.force_autohinter = false
	font.subpixel_positioning = TextServer.SUBPIXEL_POSITIONING_AUTO
	font.hinting = TextServer.HINTING_LIGHT
	return font


func _build_monospace_font() -> Font:
	var font := SystemFont.new()
	var names: PackedStringArray = PackedStringArray()
	for candidate: String in MONOSPACE_CANDIDATES:
		names.append(candidate)
	font.font_names = names
	font.allow_system_fallback = true
	return font


# --------------------------------------------------------------------- цвета


func _apply_colors(theme: Theme) -> void:
	theme.set_color("font_color", "Label", COLOR_TEXT_PRIMARY)
	theme.set_color("font_shadow_color", "Label", Color(0, 0, 0, 0.45))
	theme.set_color("font_color", "Button", COLOR_TEXT_PRIMARY)
	theme.set_color("font_hover_color", "Button", Color.WHITE)
	theme.set_color("font_pressed_color", "Button", COLOR_TEXT_ON_ACCENT)
	theme.set_color("font_focus_color", "Button", Color.WHITE)
	theme.set_color("font_disabled_color", "Button", COLOR_TEXT_DISABLED)
	theme.set_color("font_color", "CheckButton", COLOR_TEXT_PRIMARY)
	theme.set_color("font_color", "CheckBox", COLOR_TEXT_PRIMARY)
	theme.set_color("font_color", "OptionButton", COLOR_TEXT_PRIMARY)
	theme.set_color("font_color", "LineEdit", COLOR_TEXT_PRIMARY)
	theme.set_color("font_placeholder_color", "LineEdit", COLOR_TEXT_DISABLED)
	theme.set_color("font_selected_color", "LineEdit", COLOR_TEXT_ON_ACCENT)
	theme.set_color("selection_color", "LineEdit", COLOR_ACCENT)
	theme.set_color("font_color", "RichTextLabel", COLOR_TEXT_PRIMARY)
	theme.set_color("default_color", "RichTextLabel", COLOR_TEXT_PRIMARY)
	theme.set_color("font_color", "TooltipLabel", COLOR_TEXT_PRIMARY)
	theme.set_color("guide_color", "ItemList", COLOR_BORDER_SUBTLE)
	theme.set_color("font_color", "Tree", COLOR_TEXT_PRIMARY)


func _apply_font_sizes(theme: Theme) -> void:
	# Именованные размеры, чтобы сцены не писали магические числа.
	theme.set_font_size("font_size", "Label", _scaled(FONT_SIZE_BODY))
	theme.set_font_size("font_size", "Button", _scaled(FONT_SIZE_BODY_LARGE))
	theme.set_font_size("font_size", "OptionButton", _scaled(FONT_SIZE_BODY))
	theme.set_font_size("font_size", "LineEdit", _scaled(FONT_SIZE_BODY))
	theme.set_font_size("normal_font_size", "RichTextLabel", _scaled(FONT_SIZE_BODY))
	theme.set_font_size("bold_font_size", "RichTextLabel", _scaled(FONT_SIZE_BODY_LARGE))
	theme.set_font_size("font_size", "TooltipLabel", _scaled(FONT_SIZE_CAPTION))


func _apply_constants(theme: Theme) -> void:
	theme.set_constant("separation", "VBoxContainer", SEPARATION_NORMAL)
	theme.set_constant("separation", "HBoxContainer", SEPARATION_NORMAL)
	theme.set_constant("separation", "GridContainer", SEPARATION_NORMAL)
	theme.set_constant("separation", "MarginContainer", MARGIN_NORMAL)
	theme.set_constant("margin_left", "MarginContainer", MARGIN_NORMAL)
	theme.set_constant("margin_right", "MarginContainer", MARGIN_NORMAL)
	theme.set_constant("margin_top", "MarginContainer", MARGIN_NORMAL)
	theme.set_constant("margin_bottom", "MarginContainer", MARGIN_NORMAL)
	theme.set_constant("scroll_width", "ScrollBar", 10)
	theme.set_constant("grabber_highlight_size", "ScrollBar", 10)


# -------------------------------------------------------------------- кнопки


func _apply_buttons(theme: Theme) -> void:
	theme.set_stylebox(
		"normal", "Button", _button_style(COLOR_BACKGROUND_ELEVATED, COLOR_BORDER_SUBTLE)
	)
	theme.set_stylebox(
		"hover", "Button", _button_style(COLOR_BACKGROUND_HOVER, COLOR_BORDER_STRONG)
	)
	theme.set_stylebox("pressed", "Button", _button_style(COLOR_ACCENT_PRESSED, COLOR_ACCENT))
	theme.set_stylebox("focus", "Button", _focus_style())
	theme.set_stylebox(
		"disabled", "Button", _button_style(Color(0.1, 0.11, 0.13, 0.6), Color(1, 1, 1, 0.03))
	)

	# Кнопка главного меню — отдельный «тип». В Godot это делается через
	# именованные варианты (theme type variation), а не через дублирование
	# стилей в каждой сцене. Сцена пишет theme_type_variation = "MenuButton".
	theme.set_type_variation("MenuButton", "Button")
	theme.set_stylebox("normal", "MenuButton", _menu_button_style(COLOR_BACKGROUND_SURFACE))
	theme.set_stylebox("hover", "MenuButton", _menu_button_style(COLOR_ACCENT, 0.18))
	theme.set_stylebox("pressed", "MenuButton", _menu_button_style(COLOR_ACCENT, 0.30))
	theme.set_stylebox("focus", "MenuButton", _focus_style())
	theme.set_font_size("font_size", "MenuButton", _scaled(FONT_SIZE_SUBTITLE))

	# Акцентное действие («Играть», «Продолжить») — одно на экран.
	theme.set_type_variation("AccentButton", "Button")
	theme.set_stylebox("normal", "AccentButton", _accent_style(COLOR_ACCENT))
	theme.set_stylebox("hover", "AccentButton", _accent_style(COLOR_ACCENT_HOVER))
	theme.set_stylebox("pressed", "AccentButton", _accent_style(COLOR_ACCENT_PRESSED))
	theme.set_stylebox("focus", "AccentButton", _focus_style())
	theme.set_color("font_color", "AccentButton", COLOR_TEXT_ON_ACCENT)
	theme.set_color("font_hover_color", "AccentButton", COLOR_TEXT_ON_ACCENT)
	theme.set_color("font_pressed_color", "AccentButton", COLOR_TEXT_ON_ACCENT)
	theme.set_font_size("font_size", "AccentButton", _scaled(FONT_SIZE_SUBTITLE))

	# Опасное действие («Удалить сохранение», «Выйти без сохранения»).
	theme.set_type_variation("DangerButton", "Button")
	theme.set_stylebox(
		"normal",
		"DangerButton",
		_button_style(COLOR_BACKGROUND_ELEVATED, COLOR_DANGER * Color(1, 1, 1, 0.55))
	)
	theme.set_stylebox("hover", "DangerButton", _button_style(COLOR_DANGER, COLOR_DANGER))
	theme.set_stylebox("pressed", "DangerButton", _accent_style(COLOR_DANGER.darkened(0.18)))
	theme.set_stylebox("focus", "DangerButton", _focus_style())
	theme.set_color("font_hover_color", "DangerButton", Color.WHITE)

	# Невидимая кнопка-иконка (закрыть панель, свернуть).
	theme.set_type_variation("GhostButton", "Button")
	theme.set_stylebox("normal", "GhostButton", StyleBoxEmpty.new())
	theme.set_stylebox(
		"hover",
		"GhostButton",
		_button_style(COLOR_BACKGROUND_HOVER, COLOR_BORDER_SUBTLE, RADIUS_SMALL)
	)
	theme.set_stylebox(
		"pressed", "GhostButton", _button_style(COLOR_ACCENT_PRESSED, COLOR_ACCENT, RADIUS_SMALL)
	)
	theme.set_stylebox("focus", "GhostButton", _focus_style())


func _button_style(bg: Color, border: Color, radius: int = RADIUS_MEDIUM) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = bg
	style.set_border_width_all(BORDER_WIDTH)
	style.border_color = border
	style.set_corner_radius_all(radius)
	style.content_margin_left = float(MARGIN_NORMAL)
	style.content_margin_right = float(MARGIN_NORMAL)
	style.content_margin_top = float(MARGIN_COMPACT)
	style.content_margin_bottom = float(MARGIN_COMPACT)
	return style


func _menu_button_style(bg: Color, alpha_override: float = -1.0) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = bg if alpha_override < 0.0 else Color(bg.r, bg.g, bg.b, alpha_override)
	style.set_border_width_all(0)
	# Полоса слева — визуальный «курсор» пункта меню. Дешёвый приём, который
	# делает список пунктов похожим на консольный интерфейс, а не на таблицу.
	style.border_width_left = 3
	style.border_color = COLOR_ACCENT if alpha_override < 0.0 else Color(1, 1, 1, 0)
	style.set_corner_radius_all(RADIUS_SMALL)
	style.content_margin_left = float(MARGIN_SPACIOUS)
	style.content_margin_right = float(MARGIN_SPACIOUS)
	style.content_margin_top = float(MARGIN_COMPACT + 2)
	style.content_margin_bottom = float(MARGIN_COMPACT + 2)
	return style


func _accent_style(bg: Color) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = bg
	style.set_border_width_all(0)
	style.set_corner_radius_all(RADIUS_MEDIUM)
	style.content_margin_left = float(MARGIN_SPACIOUS)
	style.content_margin_right = float(MARGIN_SPACIOUS)
	style.content_margin_top = float(MARGIN_COMPACT + 4)
	style.content_margin_bottom = float(MARGIN_COMPACT + 4)
	style.shadow_color = Color(bg.r, bg.g, bg.b, 0.35)
	style.shadow_size = 12
	style.shadow_offset = Vector2(0, 4)
	return style


func _focus_style() -> StyleBoxFlat:
	# Фокус ОБЯЗАН быть видимым: часть игроков ходит по меню с геймпада и
	# без индикатора фокуса просто не понимает, где сейчас курсор.
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0, 0, 0, 0)
	style.set_border_width_all(2)
	style.border_color = COLOR_BORDER_FOCUS
	style.set_corner_radius_all(RADIUS_MEDIUM + 2)
	style.expand_margin_left = 3.0
	style.expand_margin_right = 3.0
	style.expand_margin_top = 3.0
	style.expand_margin_bottom = 3.0
	return style


# -------------------------------------------------------------------- панели


func _apply_panels(theme: Theme) -> void:
	theme.set_stylebox(
		"panel", "Panel", _panel_style(COLOR_BACKGROUND_SURFACE, COLOR_BORDER_SUBTLE, RADIUS_LARGE)
	)
	theme.set_stylebox(
		"panel",
		"PanelContainer",
		_panel_style(COLOR_BACKGROUND_SURFACE, COLOR_BORDER_SUBTLE, RADIUS_LARGE)
	)
	theme.set_stylebox(
		"panel",
		"TooltipPanel",
		_panel_style(COLOR_BACKGROUND_ELEVATED, COLOR_BORDER_STRONG, RADIUS_SMALL)
	)
	theme.set_stylebox(
		"tab_selected",
		"TabContainer",
		_panel_style(COLOR_BACKGROUND_ELEVATED, COLOR_BORDER_SUBTLE, RADIUS_MEDIUM)
	)
	theme.set_stylebox(
		"tab_unselected",
		"TabContainer",
		_panel_style(COLOR_BACKGROUND_SURFACE, Color(0, 0, 0, 0), RADIUS_MEDIUM)
	)
	theme.set_stylebox(
		"panel",
		"TabContainer",
		_panel_style(COLOR_BACKGROUND_SURFACE, COLOR_BORDER_SUBTLE, RADIUS_MEDIUM)
	)

	theme.set_type_variation("DialogPanel", "PanelContainer")
	theme.set_stylebox("panel", "DialogPanel", _dialog_style())

	theme.set_type_variation("InsetPanel", "PanelContainer")
	theme.set_stylebox("panel", "InsetPanel", _inset_style())


func _panel_style(bg: Color, border: Color, radius: int) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = bg
	style.set_border_width_all(BORDER_WIDTH)
	style.border_color = border
	style.set_corner_radius_all(radius)
	style.content_margin_left = float(MARGIN_SPACIOUS)
	style.content_margin_right = float(MARGIN_SPACIOUS)
	style.content_margin_top = float(MARGIN_NORMAL)
	style.content_margin_bottom = float(MARGIN_NORMAL)
	# Тень под панелью отделяет её от 3D-фона меню. Без тени панель
	# «прилипает» к фону и теряет ощущение глубины.
	style.shadow_color = Color(0, 0, 0, 0.45)
	style.shadow_size = 18
	style.shadow_offset = Vector2(0, 6)
	return style


func _dialog_style() -> StyleBoxFlat:
	var style := _panel_style(COLOR_BACKGROUND_SURFACE, COLOR_BORDER_STRONG, RADIUS_LARGE)
	style.content_margin_left = float(MARGIN_SPACIOUS + 8)
	style.content_margin_right = float(MARGIN_SPACIOUS + 8)
	style.content_margin_top = float(MARGIN_SPACIOUS)
	style.content_margin_bottom = float(MARGIN_SPACIOUS)
	# Верхняя акцентная полоса: отличает модальный диалог от обычной панели.
	style.border_width_top = 2
	style.border_color = COLOR_ACCENT
	style.shadow_size = 28
	return style


func _inset_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0, 0, 0, 0.28)
	style.set_border_width_all(BORDER_WIDTH)
	style.border_color = Color(0, 0, 0, 0.35)
	style.set_corner_radius_all(RADIUS_SMALL)
	style.content_margin_left = float(MARGIN_NORMAL)
	style.content_margin_right = float(MARGIN_NORMAL)
	style.content_margin_top = float(MARGIN_COMPACT)
	style.content_margin_bottom = float(MARGIN_COMPACT)
	return style


# --------------------------------------------------------------------- ввод


func _apply_inputs(theme: Theme) -> void:
	theme.set_stylebox("normal", "LineEdit", _field_style(COLOR_TRACK))
	theme.set_stylebox("focus", "LineEdit", _field_style(COLOR_TRACK, COLOR_BORDER_FOCUS))
	# SpinBox содержит LineEdit внутри, поэтому отдельный стиль ему не нужен:
	# он наследует стиль вложенного поля ввода.

	theme.set_stylebox("slider", "HSlider", _slider_track_style())
	theme.set_stylebox("grabber_area", "HSlider", _slider_fill_style())
	theme.set_stylebox("grabber_area_highlight", "HSlider", _slider_fill_style(true))
	theme.set_stylebox("grabber_highlight", "HSlider", StyleBoxEmpty.new())
	theme.set_stylebox("focus", "HSlider", _focus_style())
	theme.set_constant("grabber_offset", "HSlider", 0)

	theme.set_stylebox("background", "ProgressBar", _progress_background_style())
	theme.set_stylebox("fill", "ProgressBar", _progress_fill_style())

	theme.set_stylebox(
		"panel",
		"PopupMenu",
		_panel_style(COLOR_BACKGROUND_ELEVATED, COLOR_BORDER_STRONG, RADIUS_MEDIUM)
	)
	theme.set_stylebox("hover", "PopupMenu", _button_style(COLOR_ACCENT, COLOR_ACCENT, 0))
	theme.set_stylebox("labeled_separator_left", "PopupMenu", _separator_style())
	theme.set_stylebox("separator", "HSeparator", _separator_style())
	theme.set_stylebox("separator", "VSeparator", _separator_style())


func _field_style(bg: Color, border: Color = Color(0, 0, 0, 0)) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = bg
	style.set_border_width_all(BORDER_WIDTH)
	style.border_color = border
	style.set_corner_radius_all(RADIUS_SMALL)
	style.content_margin_left = float(MARGIN_COMPACT + 2)
	style.content_margin_right = float(MARGIN_COMPACT + 2)
	style.content_margin_top = 6.0
	style.content_margin_bottom = 6.0
	return style


func _slider_track_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = COLOR_TRACK
	style.set_corner_radius_all(RADIUS_SMALL)
	style.content_margin_top = 3.0
	style.content_margin_bottom = 3.0
	return style


func _slider_fill_style(highlight: bool = false) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = COLOR_ACCENT_HOVER if highlight else COLOR_ACCENT
	style.set_corner_radius_all(RADIUS_SMALL)
	style.content_margin_top = 3.0
	style.content_margin_bottom = 3.0
	return style


func _progress_background_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = COLOR_PROGRESS_BACKGROUND
	style.set_corner_radius_all(RADIUS_SMALL)
	return style


func _progress_fill_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = COLOR_ACCENT
	style.set_corner_radius_all(RADIUS_SMALL)
	return style


func _separator_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = COLOR_BORDER_SUBTLE
	style.content_margin_top = 1.0
	style.content_margin_bottom = 1.0
	return style


# ------------------------------------------------------------------ подписи


func _apply_labels(theme: Theme) -> void:
	# Именованные варианты подписей — сцена берёт их вместо ручного
	# add_theme_font_size_override в каждом Label.
	theme.set_type_variation("DisplayLabel", "Label")
	theme.set_font_size("font_size", "DisplayLabel", _scaled(FONT_SIZE_DISPLAY))
	theme.set_color("font_color", "DisplayLabel", COLOR_TEXT_PRIMARY)

	theme.set_type_variation("TitleLabel", "Label")
	theme.set_font_size("font_size", "TitleLabel", _scaled(FONT_SIZE_TITLE))
	theme.set_color("font_color", "TitleLabel", COLOR_TEXT_PRIMARY)

	theme.set_type_variation("SubtitleLabel", "Label")
	theme.set_font_size("font_size", "SubtitleLabel", _scaled(FONT_SIZE_SUBTITLE))
	theme.set_color("font_color", "SubtitleLabel", COLOR_TEXT_PRIMARY)

	theme.set_type_variation("SecondaryLabel", "Label")
	theme.set_font_size("font_size", "SecondaryLabel", _scaled(FONT_SIZE_BODY))
	theme.set_color("font_color", "SecondaryLabel", COLOR_TEXT_SECONDARY)

	theme.set_type_variation("CaptionLabel", "Label")
	theme.set_font_size("font_size", "CaptionLabel", _scaled(FONT_SIZE_CAPTION))
	theme.set_color("font_color", "CaptionLabel", COLOR_TEXT_SECONDARY)

	theme.set_type_variation("HintLabel", "Label")
	theme.set_font_size("font_size", "HintLabel", _scaled(FONT_SIZE_CAPTION))
	theme.set_color("font_color", "HintLabel", COLOR_TEXT_DISABLED)

	theme.set_type_variation("MonoLabel", "Label")
	theme.set_font("font", "MonoLabel", _build_monospace_font())
	theme.set_font_size("font_size", "MonoLabel", _scaled(FONT_SIZE_CAPTION))
	theme.set_color("font_color", "MonoLabel", COLOR_ACCENT)


# ------------------------------------------------------------------ скролл


func _apply_scrollbars(theme: Theme) -> void:
	var track := StyleBoxFlat.new()
	track.bg_color = Color(0, 0, 0, 0.22)
	track.set_corner_radius_all(RADIUS_SMALL)

	var grabber := StyleBoxFlat.new()
	grabber.bg_color = COLOR_BORDER_STRONG
	grabber.set_corner_radius_all(RADIUS_SMALL)

	var grabber_hover := StyleBoxFlat.new()
	grabber_hover.bg_color = COLOR_ACCENT * Color(1, 1, 1, 0.7)
	grabber_hover.set_corner_radius_all(RADIUS_SMALL)

	for control: String in ["VScrollBar", "HScrollBar"]:
		theme.set_stylebox("scroll", control, track)
		theme.set_stylebox("grabber", control, grabber)
		theme.set_stylebox("grabber_highlight", control, grabber_hover)
		theme.set_stylebox("grabber_pressed", control, grabber_hover)
