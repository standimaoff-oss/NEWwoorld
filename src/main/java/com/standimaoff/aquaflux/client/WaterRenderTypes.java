package com.standimaoff.aquaflux.client;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.resources.ResourceLocation;

import java.util.function.Function;

/**
 * Слой воды и её спрайты.
 *
 * <p>Берём ванильный {@code translucent} (атлас блоков, {@code BLOCK}-формат: позиция, цвет,
 * UV, лайтмапа, нормаль). Он гарантированно есть в любой сборке, получает лайтмапу и туман
 * от игры и одинаково понимается Iris/Oculus.</p>
 *
 * <p>Спрайты НЕ кэшируем между кадрами: атлас перезагружается при смене набора ресурсов, и
 * закэшированный «пустой» спрайт потом навсегда остаётся серой шахматкой. Поиск в атласе -
 * это один lookup в HashMap, дешевле любой диагностики.</p>
 */
public final class WaterRenderTypes {

    /**
     * Спрайт поверхности - своя гладкая текстура, а не ванильная вода 16x16:
     * ванильную при растяжении на блок видно «телевизионным снегом» (UV идут
     * каждые полблока, и пиксели текстуры ложатся крупной шахматкой). Здесь
     * только мягкие крупные переливы, цвет даёт палитра.
     */
    private static final ResourceLocation SPRITE_ID = new ResourceLocation("aquaflux", "block/water_smooth");
    /** Фолбэк, если своя текстура почему-то не попала в атлас. */
    private static final ResourceLocation VANILLA_ID = new ResourceLocation("minecraft", "block/water_still");
    /** Круглая капля: один билборд читается как капля, а не как квадратик. */
    private static final ResourceLocation DROP_ID = new ResourceLocation("aquaflux", "block/water_drop");
    private static final ResourceLocation MISSING = new ResourceLocation("minecraft", "missingno");

    private WaterRenderTypes() {
    }

    public static RenderType surface() {
        return RenderType.translucent();
    }

    public static TextureAtlasSprite sprite() {
        TextureAtlasSprite own = atlas().apply(SPRITE_ID);
        if (own.contents().name().equals(MISSING)) {
            return atlas().apply(VANILLA_ID);
        }
        return own;
    }

    /**
     * Спрайт капли. Если наша текстура почему-то не попала в атлас, берём ванильную воду:
     * лучше квадратная полупрозрачная капля, чем серая шахматка «нет текстуры».
     */
    public static TextureAtlasSprite drop() {
        TextureAtlasSprite drop = atlas().apply(DROP_ID);
        if (drop.contents().name().equals(MISSING)) {
            return sprite();
        }
        return drop;
    }

    private static Function<ResourceLocation, TextureAtlasSprite> atlas() {
        return Minecraft.getInstance()
                .getTextureAtlas(net.minecraft.world.inventory.InventoryMenu.BLOCK_ATLAS);
    }

    /** Совместимость: кэша больше нет, сбрасывать нечего. */
    public static void invalidate() {
    }
}
