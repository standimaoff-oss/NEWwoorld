package com.standimaoff.aquaflux.client;

import com.mojang.blaze3d.vertex.VertexConsumer;
import com.standimaoff.aquaflux.AquafluxConfig;
import com.standimaoff.aquaflux.core.FluidConstants;
import com.standimaoff.aquaflux.core.ParcelField;
import com.standimaoff.aquaflux.core.Precision;
import com.standimaoff.aquaflux.core.WaterPalette;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.LevelRenderer;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.core.BlockPos;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;
import org.joml.Matrix4f;
import org.joml.Vector4f;

import java.util.Map;

/**
 * Рисует капли и брызги - «много маленьких тел» - как настоящие капли.
 *
 * <p>Каждая капля - маленький билборд, повёрнутый к камере. Размер берётся из объёма
 * (шар того же объёма), цвет - из общей палитры воды с учётом пены. Чем мельче капля,
 * тем прозрачнее: мелкая водяная пыль почти невидима, крупные шлепки читаются.</p>
 *
 * <p>Сами капли приходят с сервера (пакет {@code WaterSyncPacket}) и дошагиваются на клиенте
 * той же физикой, поэтому полёт выглядит плавно, а не «прыжками раз в 4 тика».</p>
 */
public final class DropRenderer {

    /** Диагностика: рисовать капли сплошным пурпурным, чтобы их было видно на любом фоне. */
    public static volatile boolean DEBUG_MAGENTA;

    private static final float MIN_SIZE = 0.035f;
    private static final float MAX_SIZE = 0.55f;

    private DropRenderer() {
    }

    public static void render(VertexConsumer vc, Matrix4f view, TextureAtlasSprite sprite,
                              Vec3 camera, Vec3 right, Vec3 up, float partialTick) {
        int max = AquafluxConfig.maxDrops();
        lastMax = max;
        lastSkipped = 0;
        lastSeen = 0;
        if (max <= 0) {
            return;
        }
        int drawn = 0;
        Precision precision = AquafluxConfig.texturePrecision();
        for (Map.Entry<Long, ClientWaterCache.Field> entry : ClientWaterCache.fields().entrySet()) {
            ParcelField field = entry.getValue().parcels;
            int n = field.count();
            for (int i = 0; i < n && drawn < max; i++) {
                ParcelField.Parcel p = field.at(i);
                if (p == null || !p.alive()) {
                    continue;
                }
                double dx = p.x - camera.x;
                double dy = p.y - camera.y;
                double dz = p.z - camera.z;
                double dist2 = dx * dx + dy * dy + dz * dz;
                lastSeen++;
                if (dist2 > 48.0 * 48.0 || dist2 < 0.02) {
                    lastSkipped++;
                    continue;
                }
                float px = (float) (p.x + p.vx * partialTick * 0.05);
                float py = (float) (p.y + p.vy * partialTick * 0.05);
                float pz = (float) (p.z + p.vz * partialTick * 0.05);

                float radius = (float) Math.min(MAX_SIZE * 0.5, Math.max(MIN_SIZE,
                        p.radius() * 1.4 + 0.015));
                // Скорость растягивает каплю вдоль движения - получается «штрих», а не точка.
                float speed = (float) p.speed();
                float stretch = Math.min(2.2f, 1.0f + speed * 0.12f);
                Vec3 dir = speed > 1.0e-3
                        ? new Vec3(p.vx / speed, p.vy / speed, p.vz / speed) : new Vec3(0, -1, 0);
                // Билборд поворачиваем к камере по направлению НА эту каплю: при
                // одном общем «right» капли у края экрана вырождаются в иглы.
                Vec3 toCam = new Vec3(camera.x - px, camera.y - py, camera.z - pz);
                if (toCam.lengthSqr() < 1.0e-6) {
                    toCam = right;
                }
                toCam = toCam.normalize();
                Vec3 across = dir.cross(toCam);
                if (across.lengthSqr() < 1.0e-5) {
                    across = dir.cross(up);
                }
                if (across.lengthSqr() < 1.0e-5) {
                    across = new Vec3(1, 0, 0);
                }
                across = across.normalize().scale(radius);
                Vec3 along = dir.scale(radius * stretch);

                // Брызги - это вспененная вода: они светлее толщи, иначе читаются
                // как зелёные бумажки, а не как капли.
                float foam = (float) Math.min(1.0, 0.45 + 0.6 * Math.max(0.0, p.foam));
                int color = WaterPalette.color(0.25, 0.1, 0.85, 0.1, foam, 1.0,
                        (float) Math.min(3.0, p.speed()), precision);
                // Мелкие брызги почти прозрачные, крупные - плотные.
                // Нижняя граница выше прежней: при альфе 60 мелкая капля с нашей
                // полупрозрачной текстурой сливалась с фоном и была не видна.
                int alpha = (int) Mth.clamp(96 + 130 * Math.min(1.0, p.volume * 30.0 + foam * 0.5),
                        96, 226);
                color = (color & 0x00FFFFFF) | (alpha << 24);

                BlockPos lightPos = BlockPos.containing(px, py, pz);
                int light = LevelRenderer.getLightColor(Minecraft.getInstance().level, lightPos);

                if (DEBUG_MAGENTA) {
                    color = 0xFFFF00FF;
                    light = 0x00F000F0;
                }
                quad(vc, view, sprite, px, py, pz, across, along, color, light,
                        Mth.floor(px * 3.0f) * 0.17f, Mth.floor(pz * 3.0f) * 0.17f);
                drawn++;
            }
        }
        lastDrawn = drawn;
        probeOnce(vc, view, camera, right, up);
    }

    /**
     * Однократная диагностика: перед камерой рисуется сплошной пурпурный билборд
     * размером в блок и печатаются его клиповые координаты. Если он не виден -
     * дело не в каплях, а в буфере/слое; если виден - виновата геометрия капель.
     */
    private static boolean probed;

    private static void probeOnce(VertexConsumer vc, Matrix4f view, Vec3 camera,
                                  Vec3 right, Vec3 up) {
        if (probed || !DEBUG_MAGENTA) {
            return;
        }
        probed = true;
        Vec3 fwd = new Vec3(-view.m02(), -view.m12(), -view.m22()).normalize();
        float px = (float) (camera.x + fwd.x * 3.0);
        float py = (float) (camera.y + fwd.y * 3.0);
        float pz = (float) (camera.z + fwd.z * 3.0);
        quad(vc, view, spriteOrNull(), px, py, pz, right.scale(0.6), up.scale(0.6),
                0xFFFF00FF, 0x00F000F0, 0.0f, 0.0f);
        Vector4f clip = new Vector4f(px, py, pz, 1.0f).mul(view);
        com.standimaoff.aquaflux.Aquaflux.LOGGER.info(
                "[drops] проба: камера ({}, {}, {}), фокус камеры ({}, {}, {}), билборд ({}, {}, {}), клип ({}, {}, {}, {})",
                camera.x, camera.y, camera.z, fwd.x, fwd.y, fwd.z, px, py, pz,
                clip.x, clip.y, clip.z, clip.w);
    }

    /** Есть ли вообще капли в кэше: без них не стоит открывать батч. */
    public static boolean isEmpty() {
        for (Map.Entry<Long, ClientWaterCache.Field> entry : ClientWaterCache.fields().entrySet()) {
            if (entry.getValue().parcels.count() > 0) {
                return false;
            }
        }
        return true;
    }

    private static TextureAtlasSprite probeSprite;

    private static TextureAtlasSprite spriteOrNull() {
        if (probeSprite == null) {
            probeSprite = WaterRenderTypes.drop();
        }
        return probeSprite;
    }

    /** Диагностика: сколько капель видел/нарисовал последний кадр. */
    public static volatile int lastDrawn;
    public static volatile int lastSeen;
    public static volatile int lastSkipped;
    public static volatile int lastMax;

    private static void quad(VertexConsumer vc, Matrix4f view, TextureAtlasSprite sprite,
                             float x, float y, float z, Vec3 a, Vec3 b, int color, int light,
                             float u0, float v0) {
        // Вся текстура целиком: капля круглая, и её надо брать без обрезки.
        // Раньше брали четверть спрайта - получались квадратики.
        u0 = 0.0f;
        v0 = 0.0f;
        float u1 = 1.0f;
        float v1 = 1.0f;
        // Билборд рисуется ДВУМЯ обходами. Слой {@code translucent} включён с
        // отсечением задних граней, а ориентация билборда зависит от направления
        // полёта капли, поэтому один из обходов всегда отбрасывался и капель не
        // было видно вообще.
        vertex(vc, view, sprite, x - a.x - b.x, y - a.y - b.y, z - a.z - b.z, color, light, u0, v0);
        vertex(vc, view, sprite, x + a.x - b.x, y + a.y - b.y, z + a.z - b.z, color, light, u1, v0);
        vertex(vc, view, sprite, x + a.x + b.x, y + a.y + b.y, z + a.z + b.z, color, light, u1, v1);
        vertex(vc, view, sprite, x - a.x + b.x, y - a.y + b.y, z - a.z + b.z, color, light, u0, v1);

        vertex(vc, view, sprite, x - a.x + b.x, y - a.y + b.y, z - a.z + b.z, color, light, u0, v1);
        vertex(vc, view, sprite, x + a.x + b.x, y + a.y + b.y, z + a.z + b.z, color, light, u1, v1);
        vertex(vc, view, sprite, x + a.x - b.x, y + a.y - b.y, z + a.z - b.z, color, light, u1, v0);
        vertex(vc, view, sprite, x - a.x - b.x, y - a.y - b.y, z - a.z - b.z, color, light, u0, v0);
    }

    private static void vertex(VertexConsumer vc, Matrix4f view, TextureAtlasSprite sprite,
                               double x, double y, double z, int color, int light, float u, float v) {
        // Умножаем вектор на матрицу сами: {@code vc.vertex(matrix, ...)} считает
        // M*v, а в этом рендерере матрица мира применяется как v*M (так же, как у
        // поверхности). Из-за этого капли уезжали за кадр и их не было видно ни при
        // каком цвете и размере.
        Vector4f p = new Vector4f((float) x, (float) y, (float) z, 1.0f).mul(view);
        vc.vertex(p.x, p.y, p.z)
                .color(color)
                .uv(sprite.getU(u), sprite.getV(v))
                .overlayCoords(OverlayTexture.NO_OVERLAY)
                .uv2(light)
                .normal(0.0f, 1.0f, 0.0f)
                .endVertex();
    }

    /** Отладочная строка: сколько капель в воздухе и какая у них масса. */
    public static String debugLine() {
        int count = 0;
        double volume = 0;
        for (Map.Entry<Long, ClientWaterCache.Field> entry : ClientWaterCache.fields().entrySet()) {
            count += entry.getValue().parcels.count();
            volume += entry.getValue().parcels.totalVolume();
        }
        if (count == 0) {
            return "";
        }
        return "Брызги: " + count + " капель, " + FluidConstants.formatVolume(volume)
                + ", " + FluidConstants.formatMass(FluidConstants.massOf(volume));
    }
}
