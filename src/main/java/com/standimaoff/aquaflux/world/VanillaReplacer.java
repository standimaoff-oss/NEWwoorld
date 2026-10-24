package com.standimaoff.aquaflux.world;

import com.standimaoff.aquaflux.AquafluxConfig;
import com.standimaoff.aquaflux.registry.ModBlocks;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

import java.util.List;

/**
 * Постепенная замена ванильной воды физической.
 *
 * <p>Включается ключом {@code replaceVanillaWater}. Работает мягко: каждый десятый тик
 * трогает ограниченное число блоков рядом с игроками, чтобы не просадить TPS и не перестраивать
 * половину мира сразу. Ванильные источники превращаются в блоки мода и получают массу 1 м^3.</p>
 */
final class VanillaReplacer {

    private static int cooldown;

    private VanillaReplacer() {
    }

    static void tick(ServerLevel level, List<ServerPlayer> players, WaterEngine engine) {
        if (++cooldown % 10 != 0) {
            return;
        }
        int budget = AquafluxConfig.convertPerTick();
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        BlockState replacement = ModBlocks.PHYSICAL_WATER.get().defaultBlockState();

        for (ServerPlayer player : players) {
            if (budget <= 0) {
                return;
            }
            BlockPos c = player.blockPosition();
            int r = 12;
            int dy = 8;
            for (int oy = -dy; oy <= dy && budget > 0; oy++) {
                for (int oz = -r; oz <= r && budget > 0; oz++) {
                    for (int ox = -r; ox <= r && budget > 0; ox++) {
                        p.set(c.getX() + ox, c.getY() + oy, c.getZ() + oz);
                        BlockState s = level.getBlockState(p);
                        if (s.getBlock() == Blocks.WATER && s.getFluidState().isSource()) {
                            // onPlace у блока сам зарегистрирует массу
                            level.setBlock(p, replacement, 3);
                            budget--;
                        }
                    }
                }
            }
        }
    }
}
