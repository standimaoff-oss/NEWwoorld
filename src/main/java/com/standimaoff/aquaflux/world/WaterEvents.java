package com.standimaoff.aquaflux.world;

import com.standimaoff.aquaflux.Aquaflux;
import com.standimaoff.aquaflux.AquafluxConfig;
import com.standimaoff.aquaflux.registry.ModFluids;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.vehicle.Boat;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.Vec3;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.event.entity.living.LivingEvent;
import net.minecraftforge.event.level.BlockEvent;
import net.minecraftforge.event.level.ExplosionEvent;
import net.minecraftforge.event.level.LevelEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.loading.FMLEnvironment;

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
        if (!isOurs(state)) {
            return;
        }
        Vec3 motion = player.getDeltaMovement();
        WaterEngine.of(server).entityWave(player.getX(), player.getZ(), motion.x, motion.z,
                AquafluxConfig.waveStrength());
    }

    /** Игроки, мобы и лодки качаются на волнах. */
    @SubscribeEvent
    public static void onLivingTick(LivingEvent.LivingTickEvent event) {
        LivingEntity entity = event.getEntity();
        if (!(entity.level() instanceof ServerLevel server)) {
            return;
        }
        double strength = AquafluxConfig.buoyancy();
        if (strength <= 0) {
            return;
        }
        if (!isInOurWater(server, entity)) {
            return;
        }
        WaterEngine.of(server).applyBuoyancy(entity, strength);
    }

    @SubscribeEvent
    public static void onBoatTick(net.minecraftforge.event.entity.EntityTickEvent event) {
        if (!(event.getEntity() instanceof Boat boat)) {
            return;
        }
        if (!(boat.level() instanceof ServerLevel server)) {
            return;
        }
        double strength = AquafluxConfig.buoyancy();
        if (strength <= 0 || !isInOurWater(server, boat)) {
            return;
        }
        WaterEngine.of(server).applyBuoyancy(boat, strength * 1.2);
    }

    /** Взрыв в воде даёт всплеск, волны и много пены. */
    @SubscribeEvent
    public static void onExplosion(ExplosionEvent.Detonate event) {
        Level level = event.getLevel();
        if (!(level instanceof ServerLevel server)) {
            return;
        }
        Vec3 center = event.getExplosion().getPosition();
        double power = Math.min(3.0, Math.sqrt(event.getAffectedBlocks().size() + 1) * 0.35);
        WaterEngine engine = WaterEngine.of(server);
        if (!engine.explosion(center, power)) {
            return;
        }
        if (!AquafluxConfig.explosionParticles()) {
            return;
        }
        int count = (int) Math.min(140, 30 + 40 * power);
        for (int i = 0; i < count; i++) {
            double ox = (server.random.nextDouble() - 0.5) * 5.0;
            double oz = (server.random.nextDouble() - 0.5) * 5.0;
            double oy = server.random.nextDouble() * 1.5;
            server.sendParticles(net.minecraft.core.particles.ParticleTypes.SPLASH,
                    center.x + ox, center.y + oy, center.z + oz, 1,
                    0.25, 0.45, 0.25, 0.35);
        }
        for (int i = 0; i < count / 3; i++) {
            double ox = (server.random.nextDouble() - 0.5) * 4.0;
            double oz = (server.random.nextDouble() - 0.5) * 4.0;
            server.sendParticles(net.minecraft.core.particles.ParticleTypes.BUBBLE,
                    center.x + ox, center.y + 0.4, center.z + oz, 1,
                    0.15, 0.2, 0.15, 0.05);
        }
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
        } else if (FMLEnvironment.dist.isClient()) {
            com.standimaoff.aquaflux.client.ClientWaterCache.clear();
        }
    }

    public static boolean isOurs(FluidState state) {
        return state.is(ModFluids.SOURCE.get()) || state.is(ModFluids.FLOWING.get());
    }

    private static boolean isInOurWater(ServerLevel server, net.minecraft.world.entity.Entity entity) {
        BlockPos pos = entity.blockPosition();
        if (isOurs(server.getFluidState(pos))) {
            return true;
        }
        return isOurs(server.getFluidState(pos.above()));
    }
}
