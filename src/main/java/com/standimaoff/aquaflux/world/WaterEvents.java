package com.standimaoff.aquaflux.world;

import com.standimaoff.aquaflux.Aquaflux;
import com.standimaoff.aquaflux.AquafluxConfig;
import com.standimaoff.aquaflux.registry.ModFluids;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.Vec3;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.event.level.BlockEvent;
import net.minecraftforge.event.level.LevelEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

/**
 * Мост между событиями Forge и движком воды.
 */
@Mod.EventBusSubscriber(modid = Aquaflux.MODID, bus = Mod.EventBusSubscriber.Bus.FORGE)
public final class WaterEvents {

    private WaterEvents() {
    }

    @SubscribeEvent
    public static void onLevelTick(TickEvent.LevelTickEvent event) {
        if (event.phase != TickEvent.Phase.END) {
            return;
        }
        if (event.level instanceof ServerLevel server) {
            WaterEngine.of(server).tick();
        }
    }

    @SubscribeEvent
    public static void onPlayerTick(TickEvent.PlayerTickEvent event) {
        if (event.phase != TickEvent.Phase.END) {
            return;
        }
        if (!AquafluxConfig.playerWaves()) {
            return;
        }
        Player player = event.player;
        if (!(player.level() instanceof ServerLevel server)) {
            return;
        }
        if ((server.getGameTime() + player.getId()) % 2L != 0L) {
            return;
        }
        if (!player.isInWater()) {
            return;
        }
        FluidState state = server.getFluidState(player.blockPosition());
        if (!state.is(ModFluids.SOURCE.get()) && !state.is(ModFluids.FLOWING.get())) {
            return;
        }
        Vec3 motion = player.getDeltaMovement();
        double strength = AquafluxConfig.waveStrength();
        WaterEngine.of(server).entityWave(player.getX(), player.getZ(), motion.x, motion.z, strength);
    }

    @SubscribeEvent
    public static void onBlockBreak(BlockEvent.BreakEvent event) {
        WaterEngine.markGroundChanged(event.getLevel(), event.getPos());
    }

    @SubscribeEvent
    public static void onBlockPlace(BlockEvent.EntityPlaceEvent event) {
        WaterEngine.markGroundChanged(event.getLevel(), event.getPos());
    }

    @SubscribeEvent
    public static void onLevelUnload(LevelEvent.Unload event) {
        if (event.getLevel() instanceof ServerLevel server) {
            WaterEngine.unload(server);
        }
    }
}
