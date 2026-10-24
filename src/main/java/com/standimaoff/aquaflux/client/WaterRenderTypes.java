package com.standimaoff.aquaflux.client;

import com.standimaoff.aquaflux.Aquaflux;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.resources.ResourceLocation;

/**
 * Слой прозрачности для поверхности воды.
 *
 * <p>Берём ванильный {@code entityTranslucent}: он есть во всех сборках, его знают Iris и
 * OptiFine, и он корректно смешивается с блоками. Поверхность рисуется двусторонне (см.
 * {@link SurfaceMesh#render}), поэтому смотреть на неё можно и сверху, и из-под воды.</p>
 */
public final class WaterRenderTypes {

    private static final ResourceLocation TEXTURE =
            new ResourceLocation(Aquaflux.MODID, "textures/block/water_surface.png");

    private static RenderType surface;

    private WaterRenderTypes() {
    }

    public static RenderType surface() {
        if (surface == null) {
            surface = RenderType.entityTranslucent(TEXTURE);
        }
        return surface;
    }
}
