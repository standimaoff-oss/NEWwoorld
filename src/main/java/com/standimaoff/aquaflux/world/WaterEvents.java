package com.standimaoff.aquaflux.world;

import com.standimaoff.aquaflux.Aquaflux;
import com.standimaoff.aquaflux.AquafluxConfig;
import com.standimaoff.aquaflux.core.FluidConstants;
import com.standimaoff.aquaflux.registry.ModFluids;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.FallingBlockEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.entity.vehicle.Boat;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.event.entity.ProjectileImpactEvent;
import net.minecraftforge.event.entity.living.LivingEvent;
import net.minecraftforge.event.level.BlockEvent;
import net.minecraftforge.event.level.ExplosionEvent;
import net.minecraftforge.event.level.LevelEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.loading.FMLEnvironment;

/**
 * Мост между событиями Forge и движком воды.
 *
 * <p>Именно здесь вода начинает реагировать на мир: моб упал - брызги и кольцо волн,
 * поставили блок в воду - вода вытесняется, сломали берег - вода устремляется в дыру,
 * взрыв - столб воды и пена, лодка гребёт - кильватер.</p>
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

    /** Пловец: след за игроком и всплески от гребков. */
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
        if (!isInOurWater(server, player)) {
            return;
        }
        Vec3 motion = player.getDeltaMovement();
        double speed = motion.horizontalDistance();
        WaterEngine engine = WaterEngine.of(server);
        engine.entityWave(player.getX(), player.getZ(), motion.x, motion.z,
                AquafluxConfig.waveStrength());
        // Плывущий человек поднимает брызги: чем быстрее гребок, тем выше.
        if (AquafluxConfig.splashEnabled() && speed > 0.06) {
            engine.impact(player.getX(), player.getY(), player.getZ(), 1.1,
                    Math.min(3.0, 0.5 + speed * 3.5), 0.35 * AquafluxConfig.splashDensity());
        }
    }

    /**
     * Живые сущности: падение в воду, плавучесть и течение.
     *
     * <p>Скорость входа считается честно: {@code v = √(2·g·h)} по высоте падения.
     * Поэтому моб, упавший с десяти блоков, поднимает настоящий столб брызг, а шагнувший
     * с берега - только круги.</p>
     */
    @SubscribeEvent
    public static void onLivingTick(LivingEvent.LivingTickEvent event) {
        LivingEntity entity = event.getEntity();
        if (!(entity.level() instanceof ServerLevel server)) {
            return;
        }
        if (isInOurWater(server, entity)) {
            if (entity.fallDistance > 0.4 && AquafluxConfig.splashEnabled()) {
                double speed = Math.sqrt(2.0 * FluidConstants.STANDARD_GRAVITY * entity.fallDistance);
                double radius = Math.max(0.7, Math.min(3.0, entity.getBbWidth() * 1.6 + speed * 0.18));
                WaterEngine.of(server).impact(entity.getX(), entity.getY(), entity.getZ(),
                        radius, Math.min(12.0, speed), 0.55 * AquafluxConfig.splashDensity());
                entity.fallDistance = 0;
            }
            double strength = AquafluxConfig.buoyancy();
            if (strength > 0) {
                WaterEngine.of(server).applyBuoyancy(entity, strength);
            }
        }
    }

    /** Лодки: кильватер, а при разгоне - брызги из-под носа. */
    @SubscribeEvent
    public static void onServerTick(TickEvent.ServerTickEvent event) {
        if (event.phase != TickEvent.Phase.END) {
            return;
        }
        net.minecraft.server.MinecraftServer server =
                net.minecraftforge.server.ServerLifecycleHooks.getCurrentServer();
        if (server == null || server.getTickCount() % 3 != 0) {
            return;
        }
        double strength = AquafluxConfig.buoyancy();
        AABB everywhere = new AABB(-3.0e7, -256, -3.0e7, 3.0e7, 512, 3.0e7);
        for (ServerLevel level : server.getAllLevels()) {
            for (Boat boat : level.getEntitiesOfClass(Boat.class, everywhere, Boat::isInWater)) {
                if (!isInOurWater(level, boat)) {
                    continue;
                }
                WaterEngine engine = WaterEngine.of(level);
                if (strength > 0) {
                    engine.applyBuoyancy(boat, strength * 1.2);
                }
                Vec3 motion = boat.getDeltaMovement();
                double speed = motion.horizontalDistance();
                if (speed > 0.12) {
                    engine.entityWave(boat.getX(), boat.getZ(), motion.x, motion.z, strength * 0.8);
                    if (AquafluxConfig.splashEnabled() && level.getGameTime() % 4 == 0) {
                        engine.impact(boat.getX() + motion.x * 1.4, boat.getY(),
                                boat.getZ() + motion.z * 1.4, 1.0 + speed,
                                Math.min(4.0, speed * 5.0), 0.30 * AquafluxConfig.splashDensity());
                    }
                }
            }
            // Падающие блоки и предметы тоже поднимают воду.
            if (AquafluxConfig.splashEnabled() && level.getGameTime() % 2 == 0) {
                for (Entity e : level.getEntitiesOfClass(FallingBlockEntity.class, everywhere)) {
                    if (!isInOurWater(level, e)) {
                        continue;
                    }
                    double speed = Math.sqrt(2.0 * FluidConstants.STANDARD_GRAVITY
                            * Math.max(0.5, e.fallDistance));
                    WaterEngine.of(level).impact(e.getX(), e.getY(), e.getZ(), 1.3,
                            Math.min(8.0, speed), 0.5 * AquafluxConfig.splashDensity());
                }
                for (ItemEntity e : level.getEntitiesOfClass(ItemEntity.class, everywhere)) {
                    if (!isInOurWater(level, e)) {
                        continue;
                    }
                    WaterEngine.of(level).impact(e.getX(), e.getY(), e.getZ(), 0.6, 1.2, 0.15);
                }
            }
        }
    }

    /** Стрелы и трезубцы: точечный всплеск. */
    @SubscribeEvent
    public static void onProjectileImpact(ProjectileImpactEvent event) {
        if (!AquafluxConfig.splashEnabled()) {
            return;
        }
        Projectile projectile = event.getProjectile();
        if (!(projectile.level() instanceof ServerLevel server)) {
            return;
        }
        if (!isInOurWater(server, projectile)) {
            return;
        }
        Vec3 motion = projectile.getDeltaMovement();
        double speed = motion.length();
        WaterEngine.of(server).impact(projectile.getX(), projectile.getY(), projectile.getZ(),
                0.7, Math.min(6.0, speed), 0.35);
    }

    /** Взрыв в воде: импульс, волны, пена, брызги и пузыри. */
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
        int count = (int) Math.min(160, 30 + 45 * power);
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

    /** Копка рядом с водой: вода устремляется в новую яму - брызги и пена. */
    @SubscribeEvent
    public static void onBlockBreak(BlockEvent.BreakEvent event) {
        WaterEngine.markGroundChanged(event.getLevel(), event.getPos());
        if (event.getLevel() instanceof ServerLevel server && AquafluxConfig.splashEnabled()) {
            splashNear(server, event.getPos(), 1.6, 1.4, 0.35);
        }
    }

    @SubscribeEvent
    public static void onBlockPlace(BlockEvent.EntityPlaceEvent event) {
        WaterEngine.markGroundChanged(event.getLevel(), event.getPos());
        if (event.getLevel() instanceof ServerLevel server) {
            // Блок, поставленный в воду, вытесняет её: всплеск у поверхности.
            BlockState placed = event.getPlacedBlock();
            if (!placed.getFluidState().isEmpty()) {
                return;
            }
            splashNear(server, event.getPos(), 1.2, 1.2, 0.30);
        }
    }

    @SubscribeEvent
    public static void onLevelUnload(LevelEvent.Unload event) {
        if (event.getLevel() instanceof ServerLevel server) {
            WaterEngine.unload(server);
        } else if (FMLEnvironment.dist.isClient()) {
            com.standimaoff.aquaflux.client.ClientWaterCache.clear();
        }
    }

    // ---------------------------------------------------------------- утилиты

    /** Небольшой всплеск в воде рядом с позицией (если вода там есть). */
    private static void splashNear(ServerLevel server, BlockPos pos, double speed, double radius,
                                   double foam) {
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        for (int dy = -1; dy <= 1; dy++) {
            for (int dz = -1; dz <= 1; dz++) {
                for (int dx = -1; dx <= 1; dx++) {
                    p.set(pos.getX() + dx, pos.getY() + dy, pos.getZ() + dz);
                    if (isOurs(server.getFluidState(p))) {
                        WaterEngine.of(server).impact(p.getX() + 0.5, p.getY() + 0.9,
                                p.getZ() + 0.5, radius, speed, foam);
                        return;
                    }
                }
            }
        }
    }

    public static boolean isOurs(FluidState state) {
        return state.is(ModFluids.SOURCE.get()) || state.is(ModFluids.FLOWING.get());
    }

    private static boolean isInOurWater(ServerLevel server, Entity entity) {
        AABB box = entity.getBoundingBox();
        BlockPos min = BlockPos.containing(box.minX + 0.05, box.minY + 0.05, box.minZ + 0.05);
        BlockPos max = BlockPos.containing(box.maxX - 0.05, box.maxY - 0.05, box.maxZ - 0.05);
        if (isOurs(server.getFluidState(min)) || isOurs(server.getFluidState(max))) {
            return true;
        }
        BlockPos pos = entity.blockPosition();
        for (int dy = 0; dy <= 1; dy++) {
            if (isOurs(server.getFluidState(pos.above(dy)))) {
                return true;
            }
        }
        return isOurs(server.getFluidState(pos));
    }
}
