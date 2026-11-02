class_name SurfaceRules
extends RefCounted
## Соответствие роли поверхности материалу и характеру накопления урона.
##
## ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Роль поверхности — это число из RoomLayout
## (SurfaceRole), и у него два последствия, не связанных с геометрией: чем
## красить и как быстро накапливается урон. Здесь они сведены в таблицы, и
## добавить роль, не описав её целиком, не получается.
##
## ПОЧЕМУ ПРОЧНОСТЬ НЕ ЗДЕСЬ. Таблицы прочности ключуются теми же
## перечислениями RoomLayout, а RoomLayout обращается к ним при постройке
## каждой панели. Если положить их сюда, возникнет цикл RoomLayout ->
## SurfaceRules -> RoomLayout. Циклическая зависимость между скриптами с
## class_name разрешается в Godot при загрузке и ломается тяжело: сообщение
## об ошибке приходит не из того файла, где причина. Поэтому прочность
## объявлена в RoomLayout рядом с перечислениями, и зависимость остаётся
## односторонней: SurfaceRules знает RoomLayout, RoomLayout о SurfaceRules
## не знает.
##
## ЗАВИСИМОСТИ: RoomLayout (перечисления) и MaterialLibrary (кэш материалов).

## Способ создания материала.
enum MaterialRecipe {
	STANDARD,
	METAL,
	GLASS,
	EMISSIVE,
}

## Энергия свечения лампы.
const LAMP_EMISSION: float = 2.4

## Рецепты материалов по роли поверхности.
##
## Таблица вместо match на двенадцать ветвей: в ней видна ВСЯ палитра
## интерьеров одним взглядом, а добавление роли — это одна запись, а не
## новая ветка, которую легко забыть согласовать с остальными.
const ROLE_RECIPES: Dictionary = {
	RoomLayout.SurfaceRole.CONCRETE:
	{
		"recipe": MaterialRecipe.STANDARD,
		"key": "wall_concrete",
		"color": MaterialLibrary.COLOR_CONCRETE,
		"roughness": 0.88,
		"specular": 0.82,
	},
	RoomLayout.SurfaceRole.TILE:
	{
		"recipe": MaterialRecipe.STANDARD,
		"key": "floor_tile",
		"color": MaterialLibrary.COLOR_TILE_COLD,
		"roughness": 0.55,
		"specular": 0.85,
	},
	RoomLayout.SurfaceRole.STONE:
	{
		"recipe": MaterialRecipe.STANDARD,
		"key": "wall_stone",
		"color": MaterialLibrary.COLOR_ROCK,
		"roughness": 0.9,
		"specular": 0.85,
	},
	RoomLayout.SurfaceRole.PLASTER:
	{
		"recipe": MaterialRecipe.STANDARD,
		"key": "wall_plaster",
		"color": MaterialLibrary.COLOR_PLASTER,
		"roughness": 0.8,
		"specular": 0.88,
	},
	RoomLayout.SurfaceRole.WOOD:
	{
		"recipe": MaterialRecipe.STANDARD,
		"key": "wood",
		"color": MaterialLibrary.COLOR_WOOD,
		"roughness": 0.85,
		"specular": 0.9,
	},
	RoomLayout.SurfaceRole.WOOD_DARK:
	{
		"recipe": MaterialRecipe.STANDARD,
		"key": "wood_dark",
		"color": MaterialLibrary.COLOR_WOOD_DARK,
		"roughness": 0.82,
		"specular": 0.9,
	},
	RoomLayout.SurfaceRole.FABRIC:
	{
		"recipe": MaterialRecipe.STANDARD,
		"key": "fabric",
		"color": MaterialLibrary.COLOR_FABRIC,
		"roughness": 0.95,
		"specular": 0.6,
	},
	RoomLayout.SurfaceRole.ROOF:
	{
		"recipe": MaterialRecipe.STANDARD,
		"key": "roof",
		"color": MaterialLibrary.COLOR_ROOF,
		"roughness": 0.75,
		"specular": 0.86,
	},
	RoomLayout.SurfaceRole.METAL:
	{
		"recipe": MaterialRecipe.METAL,
		"key": "metal",
		"color": MaterialLibrary.COLOR_METAL,
		"roughness": 0.45,
		"specular": 0.7,
	},
	RoomLayout.SurfaceRole.METAL_DARK:
	{
		"recipe": MaterialRecipe.METAL,
		"key": "metal_dark",
		"color": MaterialLibrary.COLOR_METAL_DARK,
		"roughness": 0.55,
		"specular": 0.7,
	},
	RoomLayout.SurfaceRole.GLASS:
	{
		"recipe": MaterialRecipe.GLASS,
		"key": "glass",
		"color": MaterialLibrary.COLOR_GLASS_TINT,
		"roughness": 0.04,
		"specular": 0.95,
	},
	RoomLayout.SurfaceRole.LAMP:
	{
		"recipe": MaterialRecipe.EMISSIVE,
		"key": "lamp",
		"color": MaterialLibrary.COLOR_LAMP_WARM,
		"roughness": 0.4,
		"specular": 0.5,
	},
}

## Множитель накопления урона по роли поверхности.
##
## Прочность уже различает материалы, поэтому множитель не дублирует её, а
## задаёт ХАРАКТЕР реакции: стекло разлетается от малого попадания, бетон
## держит очередь. Без множителя разница сводилась бы только к числу
## попаданий, и все материалы ощущались одинаково «плотными».
const ROLE_DAMAGE_MULTIPLIER: Dictionary = {
	RoomLayout.SurfaceRole.GLASS: 4.0,
	RoomLayout.SurfaceRole.FABRIC: 1.5,
	RoomLayout.SurfaceRole.WOOD: 1.25,
	RoomLayout.SurfaceRole.WOOD_DARK: 1.25,
	RoomLayout.SurfaceRole.TILE: 0.9,
	RoomLayout.SurfaceRole.CONCRETE: 0.55,
	RoomLayout.SurfaceRole.METAL: 0.45,
	RoomLayout.SurfaceRole.METAL_DARK: 0.35,
}


## Материал по роли поверхности.
##
## Неизвестная роль получает рецепт дерева. Молчаливая подмена здесь
## допустима, в отличие от прочности: неверный цвет виден сразу и не ломает
## поведение, а падение на месте отсутствующего рецепта уронило бы сборку
## целого дома из-за одной новой роли.
static func material_for_role(materials: MaterialLibrary, role: int) -> StandardMaterial3D:
	var recipe: Dictionary = ROLE_RECIPES.get(role, ROLE_RECIPES[RoomLayout.SurfaceRole.WOOD])
	var key: String = recipe["key"]
	var color: Color = recipe["color"]
	var roughness: float = recipe["roughness"]
	match int(recipe["recipe"]):
		MaterialRecipe.METAL:
			return materials.get_metal(key, color, roughness)
		MaterialRecipe.GLASS:
			return materials.get_glass(key)
		MaterialRecipe.EMISSIVE:
			return materials.get_emissive(key, color, LAMP_EMISSION)
	return materials.get_material(key, color, roughness, recipe["specular"])


## Множитель накопления урона.
##
## Неизвестная роль получает единицу: материал без настроенной реакции
## обязан вести себя нейтрально, а не исчезать от первого попадания.
static func damage_multiplier(role: int) -> float:
	return float(ROLE_DAMAGE_MULTIPLIER.get(role, 1.0))


## Все роли, для которых задан рецепт материала.
static func known_roles() -> Array:
	return ROLE_RECIPES.keys()


## Сводка таблиц — для тестов согласованности.
static func describe() -> Dictionary:
	return {
		"recipes": ROLE_RECIPES.size(),
		"damage": ROLE_DAMAGE_MULTIPLIER.size(),
		"roles": known_roles().size(),
	}
