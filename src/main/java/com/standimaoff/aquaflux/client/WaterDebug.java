package com.standimaoff.aquaflux.client;

import com.standimaoff.aquaflux.Aquaflux;
import com.standimaoff.aquaflux.AquafluxConfig;
import com.standimaoff.aquaflux.core.FluidConstants;
import com.standimaoff.aquaflux.world.WaterRegion;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.CustomizeGuiOverlayEvent;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

/**
 * Отладочная строка: сколько воды рядом, сколько она весит и сколько капель в воздухе.
 *
 * <p>Пользователь просил «вес, объём и массу» - значит это должно быть видно в игре, а не
 * только в коде. Строка появляется в F3-меню, когда в конфиге включён {@code compat.debug},
 * и обновляется раз в полсекунды, чтобы не тратить кадры.</p>
 */
@Mod.EventBusSubscriber(modid = Aquaflux.MODID, bus = Mod.EventBusSubscriber.Bus.FORGE, value = Dist.CLIENT)
public final class WaterDebug {

    private static String line = "";
    private static int countdown;

    private WaterDebug() {
    }

    @SubscribeEvent
    public static void onClientTick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END) {
            return;
        }
        if (countdown-- > 0) {
            return;
        }
        countdown = 10;
        Minecraft mc = Minecraft.getInstance();
        ClientLevel level = mc.level;
        if (level == null || mc.player == null || !AquafluxConfig.showDebug()) {
            line = "";
            return;
        }
        BlockPos center = mc.player.blockPosition();
        int radius = 10;
        double volume = 0;
        int blocks = 0;
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        for (int dy = -8; dy <= 4; dy++) {
            for (int dz = -radius; dz <= radius; dz++) {
                for (int dx = -radius; dx <= radius; dx++) {
                    p.set(center.getX() + dx, center.getY() + dy, center.getZ() + dz);
                    BlockState state = level.getBlockState(p);
                    if (!WaterRegion.isOurs(state)) {
                        continue;
                    }
                    volume += WaterRegion.fillOf(state);
                    blocks++;
                }
            }
        }
        double mass = FluidConstants.massOf(volume);
        double weight = FluidConstants.weightOf(mass, FluidConstants.STANDARD_GRAVITY);
        StringBuilder sb = new StringBuilder();
        sb.append("Aquaflux: ").append(FluidConstants.formatVolume(volume))
                .append(", ").append(FluidConstants.formatMass(mass))
                .append(", ").append(FluidConstants.formatWeight(weight))
                .append(" (").append(blocks).append(" блоков, r=").append(radius).append(')');
        if (AquafluxConfig.showWeight()) {
            sb.append(" | плотность ").append((int) FluidConstants.WATER_DENSITY).append(" кг/м³");
        }
        String drops = DropRenderer.debugLine();
        if (!drops.isEmpty()) {
            sb.append(" | ").append(drops);
        }
        sb.append(" | квадов: ").append(WaterSurfaceRenderer.quadCount());
        line = sb.toString();
    }

    @SubscribeEvent
    public static void onDebugText(CustomizeGuiOverlayEvent.DebugText event) {
        if (line.isEmpty()) {
            return;
        }
        event.getLeft().add(line);
    }
}
