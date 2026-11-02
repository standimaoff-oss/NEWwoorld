class_name MaterialLibrary
extends RefCounted
## Общий кэш материалов карты.
##
## ЗАЧЕМ ОТДЕЛЬНЫЙ КЛАСС, А НЕ МЕТОД СТРОИТЕЛЯ ЧАНКОВ. Материал — это ресурс
## GPU. Если строитель чанков и строитель интерьеров кэшируют материалы
## каждый у себя, одна и та же штукатурка существует в двух экземплярах:
## вдвое больше памяти и вдвое больше переключений состояния отрисовки,
## потому что движок не может объединить в один проход объекты с разными
## экземплярами материала, даже если те идентичны.
##
## Поэтому кэш один и передаётся обоим строителям. Карта 500 × 500 м держит
## в памяти 49 чанков одновременно, и дублирование материалов на таком
## объёме — это не «мелочь», а основная статья перерасхода.
##
## ВТОРОЕ НАЗНАЧЕНИЕ — ЕДИНАЯ ПАЛИТРА. ТЗ (раздел 1) требует не более
## семи основных цветов, повторяющихся между объектами: согласованность
## палитры глаз считывает как стиль, а разнобой — как ошибку. Пока цвета
## объявлены в одном месте, это требование проверяемо; разнесённые по
## файлам цвета расходятся незаметно.

## ------------------------------------------------------------------------
##  Палитра карты
## ------------------------------------------------------------------------

## Трава. Основной цвет открытой местности.
const COLOR_GRASS: Color = Color(0.30, 0.36, 0.22)
## Подсохшая трава — вариация для крупных пятен, чтобы поле не было
## однородным ковром одного оттенка.
const COLOR_GRASS_DRY: Color = Color(0.42, 0.40, 0.25)
## Грунт: обочины, дворы, основание построек.
const COLOR_DIRT: Color = Color(0.34, 0.28, 0.20)
## Дорога — утоптанный грунт, не асфальт: деревенская дорога асфальтовой
## не бывает, и серый асфальт посреди поля ломает достоверность.
const COLOR_ROAD: Color = Color(0.40, 0.35, 0.28)
## Камень и скальные выходы.
const COLOR_ROCK: Color = Color(0.36, 0.36, 0.35)
## Дерево: сараи, амбары, рамы, мебель.
const COLOR_WOOD: Color = Color(0.44, 0.33, 0.21)
## Тёмное дерево: половицы, балки, дверные полотна — contraste с COLOR_WOOD.
const COLOR_WOOD_DARK: Color = Color(0.30, 0.22, 0.15)
## Штукатурка жилых домов.
const COLOR_PLASTER: Color = Color(0.62, 0.58, 0.50)
## Кровля — самый тёмный и самый насыщенный элемент дома: крыша читается
## первой, и именно она задаёт силуэт.
const COLOR_ROOF: Color = Color(0.36, 0.24, 0.20)
## Бетон: бункер, фундамент, перекрытия.
const COLOR_CONCRETE: Color = Color(0.46, 0.46, 0.44)
## Хвоя.
const COLOR_FOLIAGE_PINE: Color = Color(0.16, 0.28, 0.16)
## Берёза — светлее и желтее хвои; различие видов без единой текстуры.
const COLOR_FOLIAGE_BIRCH: Color = Color(0.38, 0.48, 0.22)
## Дуб — между хвоей и берёзой.
const COLOR_FOLIAGE_OAK: Color = Color(0.24, 0.34, 0.17)
## Кустарник.
const COLOR_FOLIAGE_BUSH: Color = Color(0.28, 0.38, 0.20)

## ------------------------------------------------------------------------
##  Палитра интерьеров
## ------------------------------------------------------------------------

## Металл: дверные петли, рамы, вентиляция бункера, фурнитура.
const COLOR_METAL: Color = Color(0.32, 0.33, 0.34)
## Тёмный металл: взрывная дверь бункера, оконечности труб.
const COLOR_METAL_DARK: Color = Color(0.18, 0.19, 0.20)
## Ткань: матрасы, занавески, обивка.
const COLOR_FABRIC: Color = Color(0.44, 0.38, 0.32)
## Холодный кафель бункера — отличается от бетона стен, иначе всё
## помещение сливается в одно серое пятно.
const COLOR_TILE_COLD: Color = Color(0.56, 0.58, 0.57)
## Тёплый свет лампы. Эмиссия, а не источник света: настоящая лампа в
## помещении стоит теней и второго прохода отрисовки.
const COLOR_LAMP_WARM: Color = Color(1.00, 0.82, 0.55)
## Стекло — только оттенок; прозрачность задаётся в _make_glass().
const COLOR_GLASS_TINT: Color = Color(0.74, 0.80, 0.83)

## Прозрачность стекла. Альфа низкая: окно обязано оставаться видимым как
## поверхность (иначе игрок в него врезается, не понимая почему), но при
## этом достаточно прозрачное, чтобы интерьер читался снаружи.
const GLASS_ALPHA: float = 0.22
## Шероховатость стекла — почти зеркальная.
const GLASS_ROUGHNESS: float = 0.04
## Спекуляр стекла. Высокое значение даёт блик от солнца, по которому окно
## узнаётся на расстоянии; без блика стекло выглядит дырой в стене.
const GLASS_SPECULAR: float = 0.95

var _materials: Dictionary = {}


## Возвращает материал из кэша или создаёт его.
##
## Шероховатость около 0.9 — почти полностью матовая поверхность. Глянец на
## дереве, штукатурке и грунте выглядит как пластик, и это один из самых
## заметных признаков дешёвой графики.
func get_material(
	key: String, albedo: Color, roughness: float, specular: float, cull_disabled: bool = false
) -> StandardMaterial3D:
	if _materials.has(key):
		return _materials[key]
	var material: StandardMaterial3D = StandardMaterial3D.new()
	material.albedo_color = albedo
	material.roughness = roughness
	# Металличность ноль для всех природных и строительных материалов карты.
	# Ненулевая металличность у дерева даёт серые блики, которых в реальности
	# не существует.
	material.metallic = 0.0
	material.metallic_specular = specular
	if cull_disabled:
		material.cull_mode = BaseMaterial3D.CULL_DISABLED
	# Вершинный цвет разрешён: MultiMesh-растительность использует его для
	# вариаций оттенка без дополнительных материалов.
	material.vertex_color_use_as_albedo = true
	material.resource_name = key
	_materials[key] = material
	return material


## Металлическая поверхность.
##
## Здесь металличность ненулевая — единственное исключение в палитре. Петли,
## трубы и фурнитура обязаны отражать окружение, иначе металл выглядит
## крашеным пластиком.
func get_metal(key: String, albedo: Color, roughness: float) -> StandardMaterial3D:
	if _materials.has(key):
		return _materials[key]
	var material: StandardMaterial3D = get_material(key, albedo, roughness, 0.6)
	material.metallic = 0.85
	material.metallic_specular = 0.7
	_materials[key] = material
	return material


## Стекло.
##
## Отдельный метод, а не параметры get_material(): прозрачность требует
## согласованного набора свойств. Ошибка в любом из них даёт не «чуть хуже
## стекло», а невидимое окно или непрозрачную стену.
func get_glass(key: String) -> StandardMaterial3D:
	if _materials.has(key):
		return _materials[key]
	var material: StandardMaterial3D = StandardMaterial3D.new()
	material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	material.albedo_color = Color(
		COLOR_GLASS_TINT.r, COLOR_GLASS_TINT.g, COLOR_GLASS_TINT.b, GLASS_ALPHA
	)
	material.roughness = GLASS_ROUGHNESS
	material.metallic = 0.0
	material.metallic_specular = GLASS_SPECULAR
	# Отключённое отсечение обязательно: оконное стекло — плоскость без
	# толщины, и с отсечением задних граней окно пропадает при взгляде
	# изнутри помещения.
	material.cull_mode = BaseMaterial3D.CULL_DISABLED
	# Запись глубины остаётся «только непрозрачные». Если стекло начнёт
	# писать глубину, предметы за ним будут отсекаться в неверном порядке,
	# и интерьер за окном исчезнет.
	material.depth_draw_mode = BaseMaterial3D.DEPTH_DRAW_OPAQUE_ONLY
	# Преломление намеренно выключено. Оно требует отдельного прохода
	# захвата экрана, а на 500-метровой карте с десятками окон это
	# заметная статья бюджета кадра. Читается стекло не преломлением, а
	# бликом — его даёт высокий спекуляр.
	material.refraction_enabled = false
	material.shading_mode = BaseMaterial3D.SHADING_MODE_PER_PIXEL
	material.resource_name = key
	_materials[key] = material
	return material


## Светящаяся поверхность лампы.
##
## Эмиссия вместо источника света: OmniLight3D в каждом помещении добавляет
## проход теней и освещение, а светящаяся плоскость даёт тот же визуальный
## результат почти бесплатно. Настоящий свет остаётся только там, где он
## влияет на gameplay — у входа в бункер.
func get_emissive(key: String, albedo: Color, energy: float) -> StandardMaterial3D:
	if _materials.has(key):
		return _materials[key]
	var material: StandardMaterial3D = get_material(key, albedo, 0.4, 0.5)
	material.emission_enabled = true
	material.emission = albedo
	material.emission_energy_multiplier = energy
	_materials[key] = material
	return material


## Число материалов в кэше.
func count() -> int:
	return _materials.size()


## Ключи кэша — для диагностики и тестов.
func keys() -> Array:
	return _materials.keys()


## Есть ли материал с таким ключом.
func has_material(key: String) -> bool:
	return _materials.has(key)


## Сводка состояния кэша.
func describe() -> Dictionary:
	return {
		"materials": _materials.size(),
		"palette_colors": 20,
	}
