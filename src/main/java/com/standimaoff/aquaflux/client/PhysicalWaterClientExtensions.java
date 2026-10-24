package com.standimaoff.aquaflux.client;

import com.standimaoff.aquaflux.Aquaflux;
import net.minecraft.client.Minecraft;
import net.minecraft.resources.ResourceLocation;
import net.minecraftforge.client.extensions.common.IClientFluidTypeExtensions;

/**
 * Клиентский вид жидкости.
 *
 * <p>Текстура самого блока прозрачная: кубы не должны быть видны, гладкую поверхность рисует
 * {@link WaterSurfaceRenderer}. Подводный оверлей берём ванильный, чтобы привычно синело в глазах.</p>
 */
public final class PhysicalWaterClientExtensions implements IClientFluidTypeExtensions {

    private static final ResourceLocation STILL = new ResourceLocation(Aquaflux.MODID, "block/water_still");
    private static final ResourceLocation FLOW = new ResourceLocation(Aquaflux.MODID, "block/water_flow");
    private static final ResourceLocation UNDERWATER =
            new ResourceLocation("minecraft", "textures/misc/underwater.png");

    @Override
    public ResourceLocation getStillTexture() {
        return STILL;
    }

    @Override
    public ResourceLocation getFlowingTexture() {
        return FLOW;
    }

    @Override
    public int getTintColor() {
        return 0xFFFFFFFF;
    }

    @Override
    public ResourceLocation getRenderOverlayTexture(Minecraft mc) {
        return UNDERWATER;
    }
}
