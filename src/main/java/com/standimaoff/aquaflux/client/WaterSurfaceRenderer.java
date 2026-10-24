package com.standimaoff.aquaflux.client;

import com.mojang.blaze3d.vertex.Tesselator;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.standimaoff.aquaflux.Aquaflux;
import com.standimaoff.aquaflux.AquafluxConfig;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.Vec3;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.RenderLevelStageEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

import java.util.ArrayList;
import java.util.List;

/**
 * Рисует гладкую поверхность воды после прозрачных блоков.
 *
 * <p>Меш перестраивается раз в {@code rebuildInterval} кадров, волны от игроков добавляются
 * при отрисовке, волны и пена от сервера приходят пакетами и попадают в меш.</p>
 */
@Mod.EventBusSubscriber(modid = Aquaflux.MODID, bus = Mod.EventBusSubscriber.Bus.FORGE, value = Dist.CLIENT)
public final class WaterSurfaceRenderer {

    private static final SurfaceMesh MESH = new SurfaceMesh();
    private static final List<SurfaceMesh.WaveSource> WAVES = new ArrayList<>();

    private static int frame;
    private static int lastRadius = -1;
    private static BlockPos lastCenter = BlockPos.ZERO;

    private WaterSurfaceRenderer() {
    }

    @SubscribeEvent
    public static void onRenderStage(RenderLevelStageEvent event) {
        if (event.getStage() != RenderLevelStageEvent.Stage.AFTER_TRANSLUCENT_BLOCKS) {
            return;
        }
        Minecraft mc = Minecraft.getInstance();
        ClientLevel level = mc.level;
        if (level == null || mc.player == null) {
            return;
        }
        if (!AquafluxConfig.smoothSurface()
                || AquafluxConfig.shaderMode() == AquafluxConfig.ShaderMode.VANILLA) {
            return;
        }

        BlockPos center = mc.player.blockPosition();
        int radius = AquafluxConfig.smoothRadius();
        boolean moved = Math.abs(center.getX() - lastCenter.getX()) > 1
                || Math.abs(center.getZ() - lastCenter.getZ()) > 1
                || Math.abs(center.getY() - lastCenter.getY()) > 2;

        if (frame++ % Math.max(1, AquafluxConfig.rebuildInterval()) == 0 || moved || radius != lastRadius) {
            MESH.rebuild(level, center, radius, AquafluxConfig.texturePrecision(),
                    AquafluxConfig.regionSize());
            lastCenter = center;
            lastRadius = radius;
        }
        if (MESH.isEmpty()) {
            return;
        }

        collectWaves(level);
        float time = (level.getGameTime() + event.getPartialTick()) / 20.0f;

        RenderType type = WaterRenderTypes.surface();
        MultiBufferSource.BufferSource buffers = MultiBufferSource.immediate(Tesselator.getInstance().getBuilder());
        VertexConsumer vc = buffers.getBuffer(type);
        MESH.render(vc, event.getPoseStack().last().pose(), WaterRenderTypes.sprite(),
                WAVES, time, (float) AquafluxConfig.waveVisual(), 16.0f);
        buffers.endBatch(type);
    }

    private static void collectWaves(ClientLevel level) {
        WAVES.clear();
        if (!AquafluxConfig.playerWaves()) {
            return;
        }
        double strength = AquafluxConfig.waveStrength();
        if (strength <= 0) {
            return;
        }
        for (Player player : level.players()) {
            if (!player.isInWater()) {
                continue;
            }
            Vec3 motion = player.getDeltaMovement();
            double speed = Math.min(1.0, motion.horizontalDistance() * 3.0) + 0.35;
            WAVES.add(new SurfaceMesh.WaveSource(
                    (float) player.getX(), (float) player.getZ(), (float) (strength * speed)));
            if (WAVES.size() >= 6) {
                return;
            }
        }
    }

    /** Сброс кэша при перезагрузке ресурсов. */
    public static void reload() {
        WaterRenderTypes.invalidate();
    }
}
