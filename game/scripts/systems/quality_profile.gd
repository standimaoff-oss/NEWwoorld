class_name QualityProfile
extends Resource
## QualityProfile — пресет качества как ДАННЫЕ, а не как код.
##
## Почему Resource, а не enum со switch'ем: пресет можно открыть в
## инспекторе Godot, продублировать, настроить художником без единой
## строчки кода и без риска сломать логику. Добавление пятого пресета
## («Слабый ПК», «Steam Deck») = новый .tres-файл, ноль правок кода.
##
## Файлы: res://resources/quality/quality_{low,medium,high,ultra}.tres

@export_group("Идентификация")
## Машинное имя: "low", "medium", "high", "ultra", "custom".
@export var profile_id: StringName = &"custom"
## Подпись для меню настроек.
@export var display_name: String = "Своё"
## Порядок в списке пресетов.
@export var sort_order: int = 0

@export_group("Тени")
## Размер карты теней направленного света: 0, 1024, 2048, 4096, 8192, 16384.
@export var shadow_map_size: int = 2048
## Дальность теней в метрах. Больше — детальнее вблизи, но «плывёт» вдали.
@export var shadow_max_distance: float = 60.0
## 0 = PSSM2, 1 = PSSM4, 2 = PSSM4 без разделения. См. DirectionalShadowMode.
@export var shadow_split_mode: int = 1
## Мягкость фильтра: 0..4 (Hard, Soft Very Low .. Soft Ultra).
@export var soft_shadow_filter_quality: int = 2
## Включены ли тени у направленного света вообще.
@export var directional_shadows_enabled: bool = true

@export_group("Экранное освещение")
@export var ssao_enabled: bool = true
@export var ssil_enabled: bool = false
@export var ssr_enabled: bool = false
@export var sdfgi_enabled: bool = false
@export var glow_enabled: bool = true
@export var volumetric_fog_enabled: bool = false
## 0 = Linear, 1 = Thin, 2 = Thick — плотность объёмного тумана.
@export var volumetric_fog_quality: int = 1

@export_group("Сглаживание и масштабирование")
## Viewport.MSAA: 0=Disabled, 1=2x, 2=4x, 3=8x.
@export var msaa_3d: int = 1
## Viewport.ScreenSpaceAA: 0=Disabled, 1=FXAA, 2=FSR1.
@export var screen_space_aa: int = 1
@export var use_taa: bool = false
## Viewport.Scaling3DMode: 0=Bilinear, 1=FSR1, 2=FSR2, 3=MetalFX Spatial.
@export var scaling_3d_mode: int = 1
## 0.5 .. 1.0. Ниже 1.0 даёт большой прирост FPS на слабом железе.
@export_range(0.5, 1.0, 0.05) var scaling_3d_scale: float = 1.0
## 0..4 -> анизотропия 1x, 2x, 4x, 8x, 16x.
@export var anisotropic_filtering: int = 2

@export_group("Геометрия и детализация")
## Порог LOD мешей в пикселях: выше = агрессивнее упрощение.
@export var mesh_lod_threshold_pixels: float = 1.0
## Максимальное число видимых decals.
@export var max_visible_decals: int = 64
## Сколько осколков разрушения живёт одновременно (см. GameConfig).
@export var destruction_chunk_budget: int = 512
## Масштаб количества частиц GPU: 0.25 = четверть от заданного в сцене.
@export_range(0.05, 1.0, 0.05) var particle_density: float = 1.0
## Дальность отрисовки в метрах; дальше работает только скайбокс.
@export var render_distance: float = 300.0

@export_group("Постобработка")
## Tonemap: 0=Linear, 1=Reinhard, 2=Filmic, 3=ACES, 4=AgX.
@export var tonemap_mode: int = 3
@export var tonemap_white: float = 6.0
@export_range(0.0, 2.0, 0.05) var tonemap_exposure: float = 1.0
@export var adjustment_enabled: bool = true


## Человекочитаемое описание для debug-оверлея и логов.
func describe() -> String:
	return (
		"%s: shadow=%d/%.0fm msaa=%d scale=%.2f lod=%.1f destr=%d"
		% [
			display_name,
			shadow_map_size,
			shadow_max_distance,
			msaa_3d,
			scaling_3d_scale,
			mesh_lod_threshold_pixels,
			destruction_chunk_budget,
		]
	)


## Быстрая оценка «тяжести» пресета в условных единицах. Нужна
## адаптивному качеству: при просадке FPS понижаем на ступень, а не
## прыгаем сразу в «Низкое».
func cost_estimate() -> float:
	var cost: float = 0.0
	cost += float(shadow_map_size) / 4096.0
	cost += 2.0 if ssao_enabled else 0.0
	cost += 3.0 if ssil_enabled else 0.0
	cost += 4.0 if ssr_enabled else 0.0
	cost += 5.0 if sdfgi_enabled else 0.0
	cost += 4.0 if volumetric_fog_enabled else 0.0
	cost += float(msaa_3d) * 0.75
	cost += 2.0 if use_taa else 0.0
	cost += (1.0 - scaling_3d_scale) * -4.0
	cost += float(destruction_chunk_budget) / 512.0
	cost += float(max_visible_decals) / 64.0
	return snappedf(cost, 0.01)
