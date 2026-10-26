package com.standimaoff.aquaflux.client;

import com.mojang.blaze3d.vertex.Tesselator;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.standimaoff.aquaflux.Aquaflux;
import com.standimaoff.aquaflux.AquafluxConfig;
import com.standimaoff.aquaflux.core.FluidConstants;
import com.standimaoff.aquaflux.core.ParcelField;
import com.mojang.blaze3d.systems.RenderSystem;
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
        // Рисуем САМЫМИ последними в проходе уровня: всё остальное (жидкость, стекло,
        // частицы мира) уже нарисовано, и ничто не может перекрыть поверхность воды
        // своей геометрией. Полупрозрачной поверхности этого достаточно: глубину она
        // только читает.
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
        // В матрице мира (обратной к виду) оси камеры - это СТОЛБЦЫ, а не строки:
        // со строками «вправо» и «вверх» получались не ортогональными, и билборды
        // капель вырождались в плоские клинья.
        Vec3 right = new Vec3(model.m00(), model.m10(), model.m20()).normalize();
        Vec3 up = new Vec3(model.m01(), model.m11(), model.m21()).normalize();

        // Глубину только читаем: иначе поверхность спорит за неё с тем, что уже
        // нарисовано, и вместо воды проступают чёрные куски.
        RenderSystem.depthMask(false);
        // Отладка: 8 - рисовать совсем без теста глубины, включая сам сброс батча.
        boolean noDepth = SurfaceMesh.DEBUG_MODE == 8;
        if (noDepth) {
            RenderSystem.disableDepthTest();
        }
        RenderType type = WaterRenderTypes.surface();
        MultiBufferSource.BufferSource buffers =
                MultiBufferSource.immediate(Tesselator.getInstance().getBuilder());
        VertexConsumer vc = buffers.getBuffer(type);

        if (!MESH.isEmpty()) {
            SurfaceMesh.setView(eye.x, eye.y, eye.z);
            Vec3 fwd = new Vec3(-model.m02(), -model.m12(), -model.m22()).normalize();
            SurfaceMesh.setViewAxes((float) right.x, (float) right.y, (float) right.z,
                    (float) up.x, (float) up.y, (float) up.z,
                    (float) fwd.x, (float) fwd.y, (float) fwd.z);
            collectWaves(level);
            if (SurfaceMesh.DEBUG_MODE != 1) {
            MESH.render(level, vc, model, WaterRenderTypes.sprite(),
                    WAVES, (float) time, (float) AquafluxConfig.waveVisual());
            }
        }

        if (AquafluxConfig.splashEnabled() && !DropRenderer.isEmpty()) {
            DropRenderer.render(vc, model, WaterRenderTypes.drop(), eye, right, up, partial);
        }
        buffers.endBatch(type);
        if (noDepth) {
            RenderSystem.enableDepthTest();
        }
        RenderSystem.depthMask(true);
    }

    /**
     * Диагностика: пурпурные квадраты без текстуры и без атласа, в поздней стадии.
     * Нужны, чтобы понять, доходят ли вершины капель до экрана вообще.
     */
    @SubscribeEvent
    public static void onDebugDrops(RenderLevelStageEvent event) {
        if (event.getStage() != RenderLevelStageEvent.Stage.AFTER_PARTICLES
                || !DropRenderer.DEBUG_MAGENTA || DropRenderer.isEmpty()) {
            return;
        }
        Vec3 eye = event.getCamera().getPosition();
        Matrix4f model = new Matrix4f(event.getPoseStack().last().pose())
                .translate((float) -eye.x, (float) -eye.y, (float) -eye.z);
        MultiBufferSource.BufferSource buffers =
                MultiBufferSource.immediate(Tesselator.getInstance().getBuilder());
        VertexConsumer dvc = buffers.getBuffer(RenderType.debugQuads());
        Vec3 fwd = new Vec3(-model.m02(), -model.m12(), -model.m22()).normalize();
        Vec3 right = new Vec3(model.m00(), model.m10(), model.m20()).normalize();
        Vec3 up = new Vec3(model.m01(), model.m11(), model.m21()).normalize();
        int drawn = 0;
        for (Map.Entry<Long, ClientWaterCache.Field> entry : ClientWaterCache.fields().entrySet()) {
            var parcels = entry.getValue().parcels;
            for (int i = 0; i < parcels.count() && drawn < 40; i++) {
                var p = parcels.at(i);
                if (p == null) {
                    continue;
                }
                Vec3 c = new Vec3(p.x, p.y, p.z).subtract(eye);
                if (c.lengthSqr() > 900) {
                    continue;
                }
                Vec3 a = right.scale(0.25);
                Vec3 b = up.scale(0.25);
                for (Vec3[] corner : new Vec3[][]{
                        {c.add(a).add(b), c.subtract(a).add(b), c.subtract(a).subtract(b)},
                        {c.add(a).add(b), c.subtract(a).subtract(b), c.add(a).subtract(b)}}) {
                    for (Vec3 v : corner) {
                        dvc.vertex((float) v.x, (float) v.y, (float) v.z)
                                .color(255, 0, 255, 255).endVertex();
                    }
                }
                dvc.vertex((float) (c.x), (float) fwd.x, (float) c.z).color(255, 0, 255, 255).endVertex();
                drawn++;
            }
        }
        buffers.endBatch();
        lastDebugDrawn = drawn;
    }

    public static volatile int lastDebugDrawn;

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

    /** Отладка для снятия кадров: что делает меш. */
    /** Отладка: попросить меш выгрузить квады на следующем кадре. */
    public static void requestQuadDump() {
        SurfaceMesh.requestQuadDump();
    }

    public static String meshStats() {
        return MESH.stats();
    }
}
