package com.standimaoff.aquaflux.client;

import com.mojang.blaze3d.vertex.Tesselator;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.standimaoff.aquaflux.Aquaflux;
import com.standimaoff.aquaflux.AquafluxConfig;
import com.standimaoff.aquaflux.core.FluidConstants;
import com.standimaoff.aquaflux.core.ParcelField;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.Vec3;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.RenderLevelStageEvent;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

import org.joml.Matrix4f;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Рисует гладкую поверхность воды и брызги.
 *
 * <p>Меш перестраивается раз в {@code rebuildInterval} кадров, волны от игроков добавляются
 * при отрисовке, волны, пена, течение и капли от сервера приходят пакетами и попадают в меш.
 * Слой капель дошагивается на клиенте каждый кадр, поэтому брызги летят плавно.</p>
 */
@Mod.EventBusSubscriber(modid = Aquaflux.MODID, bus = Mod.EventBusSubscriber.Bus.FORGE, value = Dist.CLIENT)
public final class WaterSurfaceRenderer {

    private static final SurfaceMesh MESH = new SurfaceMesh();
    private static final List<SurfaceMesh.WaveSource> WAVES = new ArrayList<>();

    private static int frame;
    private static int lastRadius = -1;
    private static BlockPos lastCenter = BlockPos.ZERO;
    private static long lastTick = -1;

    private WaterSurfaceRenderer() {
    }

    /** Клиентский тик: старое выкидываем, капли дошагиваем. */
    @SubscribeEvent
    public static void onClientTick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END) {
            return;
        }
        ClientLevel level = Minecraft.getInstance().level;
        if (level == null) {
            ClientWaterCache.clear();
            return;
        }
        long time = level.getGameTime();
        if (time == lastTick) {
            return;
        }
        lastTick = time;
        ClientWaterCache.tick(time);
        for (Map.Entry<Long, ClientWaterCache.Field> entry : ClientWaterCache.fields().entrySet()) {
            ParcelField parcels = entry.getValue().parcels;
            if (!parcels.isEmpty()) {
                // Полёт брызг дошагивается на клиенте той же физикой: между пакетами
                // (раз в 4 тика) капли не висят в воздухе.
                parcels.step(0.05, FluidConstants.STANDARD_GRAVITY);
            }
        }
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

        float partial = event.getPartialTick();
        double time = (level.getGameTime() + partial) / 20.0;

        if (frame++ % Math.max(1, AquafluxConfig.rebuildInterval()) == 0 || moved || radius != lastRadius) {
            MESH.rebuild(level, center, radius, AquafluxConfig.texturePrecision(),
                    AquafluxConfig.regionSize(), time);
            lastCenter = center;
            lastRadius = radius;
        }

        Vec3 eye = event.getCamera().getPosition();
        // Матрица уровня содержит только поворот камеры: мировые координаты в неё
        // надо подавать уже сдвинутыми на -камеру, иначе вода уезжает от мира.
        Matrix4f model = new Matrix4f(event.getPoseStack().last().pose())
                .translate((float) -eye.x, (float) -eye.y, (float) -eye.z);
        // Оси камеры берём прямо из матрицы: это надёжнее, чем дёргать Camera.
        Vec3 right = new Vec3(model.m00(), model.m01(), model.m02()).normalize();
        Vec3 up = new Vec3(model.m10(), model.m11(), model.m12()).normalize();

        RenderType type = WaterRenderTypes.surface();
        MultiBufferSource.BufferSource buffers =
                MultiBufferSource.immediate(Tesselator.getInstance().getBuilder());
        VertexConsumer vc = buffers.getBuffer(type);

        if (!MESH.isEmpty()) {
            collectWaves(level);
            MESH.render(level, vc, model, WaterRenderTypes.sprite(),
                    WAVES, (float) time, (float) AquafluxConfig.waveVisual());
        }

        // Брызги поверх воды: маленькие тела, которые живут своей жизнью.
        if (AquafluxConfig.splashEnabled()) {
            DropRenderer.render(vc, model, WaterRenderTypes.sprite(), eye, right, up, partial);
        }
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

    public static int quadCount() {
        return MESH.quadCount();
    }
}
