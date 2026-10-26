package com.standimaoff.aquaflux.client;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.resources.ResourceLocation;

/**
 * Слой воды и её спрайт.
 *
 * <p>Берём ванильный {@code translucent} (атлас блоков, {@code BLOCK}-формат: позиция, цвет,
 * UV, лайтмапа, нормаль). Он:</p>
 * <ul>
 *   <li>гарантированно есть в любой сборке - никаких «чёрных» текстур;</li>
 *   <li>получает лайтмапу и туман от игры;</li>
 *   <li>одинаково понимается Iris и Oculus (они обрабатывают слой прозрачных блоков).</li>
 * </ul>
 *
 * <p>Спрайт берём ванильный {@code minecraft:block/water_still}: он всегда в атласе и
 * затемняется нашим цветом вершины, поэтому вода выглядит как вода, а не как заглушка.</p>
 */
public final class WaterRenderTypes {

    private static final ResourceLocation SPRITE_ID = new ResourceLocation("minecraft", "block/water_still");
    private static TextureAtlasSprite sprite;

    private WaterRenderTypes() {
    }

    public static RenderType surface() {
        // Отладка: 5 - рисовать непрозрачным слоем. Если пятна остаются и на
        // непрозрачной заливке, они не от нашего меша.
        if (SurfaceMesh.DEBUG_MODE == 5) {
            return RenderType.solid();
        }
        return RenderType.translucent();
    }

    public static TextureAtlasSprite sprite() {
        if (sprite == null) {
            sprite = Minecraft.getInstance()
                    .getTextureAtlas(net.minecraft.world.inventory.InventoryMenu.BLOCK_ATLAS)
                    .apply(SPRITE_ID);
        }
        return sprite;
    }

    public static void invalidate() {
        sprite = null;
    }
}
