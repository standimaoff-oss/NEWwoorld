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

    private static final float MIN_SIZE = 0.035f;
    private static final float MAX_SIZE = 0.55f;

    private DropRenderer() {
    }

    public static void render(VertexConsumer vc, Matrix4f view, TextureAtlasSprite sprite,
                              Vec3 camera, Vec3 right, Vec3 up, float partialTick) {
        int max = AquafluxConfig.maxDrops();
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
                if (dist2 > 48.0 * 48.0 || dist2 < 0.02) {
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
                Vec3 across = dir.cross(right);
                if (across.lengthSqr() < 1.0e-6) {
                    across = new Vec3(0, 0, 1);
                }
                across = across.normalize().scale(radius);
                Vec3 along = dir.scale(radius * stretch);

                float foam = (float) Math.min(1.0, Math.max(0.0, p.foam));
                int color = WaterPalette.color(0.25, 0.1, 0.85, 0.1, foam, 1.0,
                        (float) Math.min(3.0, p.speed()), precision);
                // Мелкие брызги почти прозрачные, крупные - плотные.
                int alpha = (int) Mth.clamp(70 + 150 * Math.min(1.0, p.volume * 30.0 + foam * 0.5),
                        60, 220);
                color = (color & 0x00FFFFFF) | (alpha << 24);

                BlockPos lightPos = BlockPos.containing(px, py, pz);
                int light = LevelRenderer.getLightColor(Minecraft.getInstance().level, lightPos);

                quad(vc, view, sprite, px, py, pz, across, along, color, light,
                        Mth.floor(px * 3.0f) * 0.17f, Mth.floor(pz * 3.0f) * 0.17f);
                drawn++;
            }
        }
    }

    private static void quad(VertexConsumer vc, Matrix4f view, TextureAtlasSprite sprite,
                             float x, float y, float z, Vec3 a, Vec3 b, int color, int light,
                             float u0, float v0) {
        float u1 = u0 + 0.25f;
        float v1 = v0 + 0.25f;
        vertex(vc, view, sprite, x - a.x - b.x, y - a.y - b.y, z - a.z - b.z, color, light, u0, v0);
        vertex(vc, view, sprite, x + a.x - b.x, y + a.y - b.y, z + a.z - b.z, color, light, u1, v0);
        vertex(vc, view, sprite, x + a.x + b.x, y + a.y + b.y, z + a.z + b.z, color, light, u1, v1);
        vertex(vc, view, sprite, x - a.x + b.x, y - a.y + b.y, z - a.z + b.z, color, light, u0, v1);
    }

    private static void vertex(VertexConsumer vc, Matrix4f view, TextureAtlasSprite sprite,
                               double x, double y, double z, int color, int light, float u, float v) {
        vc.vertex(view, (float) x, (float) y, (float) z)
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
