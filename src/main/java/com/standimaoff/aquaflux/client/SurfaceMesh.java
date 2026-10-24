package com.standimaoff.aquaflux.client;

import com.mojang.blaze3d.vertex.VertexConsumer;
import com.standimaoff.aquaflux.AquafluxConfig;
import com.standimaoff.aquaflux.core.Precision;
import com.standimaoff.aquaflux.world.WaterRegion;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.renderer.LevelRenderer;
import net.minecraft.core.BlockPos;
import net.minecraft.util.Mth;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;

import java.util.List;

/**
 * Гладкая поверхность воды: сетка квадов по высотам блоков, а не кубы.
 *
 * <p>Высота берётся из хайтмапы ({@code MOTION_BLOCKING} учитывает жидкости), доля верхнего
 * блока - из свойства {@code level}. Углы сглаживаются усреднением четырёх колонок, нормали
 * считаются по градиенту, поэтому поверхность читается как вода, а не как ступеньки.</p>
 *
 * <p>Меш перестраивается по таймеру, а волны от игроков добавляются уже при отрисовке -
 * поэтому рябь живая и не требует перестройки.</p>
 */
public final class SurfaceMesh {

    /** Источник волн (игрок, лодка) в мировых координатах. */
    public record WaveSource(float x, float z, float strength) {
    }

    private int side;
    private int quads;

    private float[] heights = new float[0];
    private float[] depths = new float[0];
    private boolean[] wet = new boolean[0];

    private float[] pos = new float[0];
    private float[] nrm = new float[0];
    private float[] uv = new float[0];
    private int[] col = new int[0];
    private int[] light = new int[0];

    private final BlockPos.MutableBlockPos mutable = new BlockPos.MutableBlockPos();

    public boolean isEmpty() {
        return quads == 0;
    }

    public int quadCount() {
        return quads;
    }

    // ---------------------------------------------------------------- построение

    public void rebuild(ClientLevel level, BlockPos center, int radius, Precision precision) {
        int newSide = radius * 2 + 3;
        if (newSide != side) {
            resize(newSide);
        }
        quads = 0;

        int baseX = center.getX() - radius - 1;
        int baseZ = center.getZ() - radius - 1;
        int minY = level.getMinBuildHeight();

        for (int gz = 0; gz < side; gz++) {
            int wz = baseZ + gz;
            for (int gx = 0; gx < side; gx++) {
                int wx = baseX + gx;
                int idx = gx + side * gz;
                heights[idx] = Float.NaN;
                depths[idx] = 0;
                wet[idx] = false;

                int top = level.getHeight(Heightmap.Types.MOTION_BLOCKING, wx, wz);
                if (top <= minY) {
                    continue;
                }
                mutable.set(wx, top - 1, wz);
                BlockState state = level.getBlockState(mutable);
                if (!WaterRegion.isOurs(state)) {
                    continue;
                }
                float surface = (top - 1) + (float) WaterRegion.fillOf(state);
                heights[idx] = surface;
                wet[idx] = true;

                // глубина: сколько блоков воды до дна (не больше 16 - для цвета хватает)
                int bedY = top - 1;
                int limit = Math.max(minY, top - 18);
                while (bedY - 1 >= limit) {
                    mutable.set(wx, bedY - 1, wz);
                    if (!WaterRegion.isOurs(level.getBlockState(mutable))) {
                        break;
                    }
                    bedY--;
                }
                depths[idx] = Math.max(0.15f, top - bedY);
            }
        }

        for (int gz = 1; gz < side - 1; gz++) {
            for (int gx = 1; gx < side - 1; gx++) {
                int idx = gx + side * gz;
                if (!wet[idx]) {
                    continue;
                }
                int wx = baseX + gx;
                int wz = baseZ + gz;
                float h = heights[idx];
                float depth = depths[idx];

                float h00 = corner(gx - 1, gz - 1, h);
                float h10 = corner(gx, gz - 1, h);
                float h11 = corner(gx, gz, h);
                float h01 = corner(gx - 1, gz, h);

                float nx = (h00 + h01) * 0.5f - (h10 + h11) * 0.5f;
                float nz = (h00 + h10) * 0.5f - (h01 + h11) * 0.5f;
                float ny = 1.0f;
                float len = Mth.sqrt(nx * nx + ny * ny + nz * nz);
                nx /= len;
                ny /= len;
                nz /= len;

                int color = WaterPalette.color(depth, ny, precision);
                int packedLight = LevelRenderer.getLightColor(level, new BlockPos(wx, Mth.floor(h), wz));

                topQuad(wx, wz, h00, h10, h11, h01, nx, ny, nz, color, packedLight);

                // бортики там, где сосед сухой - иначе видно пустоту под поверхностью
                float bottom = (float) Math.floor(h) - 0.02f;
                if (!wet[idx - 1]) {
                    sideQuad(wx, h00, h01, wz, wz + 1, bottom, nx, ny, nz, color, packedLight, true);
                }
                if (!wet[idx + 1]) {
                    sideQuad(wx + 1, h10, h11, wz, wz + 1, bottom, nx, ny, nz, color, packedLight, true);
                }
                if (!wet[idx - side]) {
                    sideQuad(wz, h00, h10, wx, wx + 1, bottom, nx, ny, nz, color, packedLight, false);
                }
                if (!wet[idx + side]) {
                    sideQuad(wz + 1, h01, h11, wx, wx + 1, bottom, nx, ny, nz, color, packedLight, false);
                }
            }
        }
    }

    private float corner(int a, int b, float fallback) {
        float sum = 0;
        int n = 0;
        for (int dz = -1; dz <= 0; dz++) {
            for (int dx = -1; dx <= 0; dx++) {
                int x = a + dx;
                int z = b + dz;
                if (x < 0 || z < 0 || x >= side || z >= side) {
                    continue;
                }
                int i = x + side * z;
                if (wet[i]) {
                    sum += heights[i];
                    n++;
                }
            }
        }
        return n == 0 ? fallback : sum / n;
    }

    private void topQuad(int wx, int wz, float h00, float h10, float h11, float h01,
                         float nx, float ny, float nz, int color, int packedLight) {
        pushQuad(
                wx, h00, wz,
                wx + 1, h10, wz,
                wx + 1, h11, wz + 1,
                wx, h01, wz + 1,
                nx, ny, nz, color, packedLight);
    }

    private void sideQuad(float a0, float y0, float y1, float b0, float b1, float bottom,
                          float nx, float ny, float nz, int color, int packedLight, boolean alongX) {
        if (alongX) {
            // грань в плоскости X = a0, тянется по Z
            pushQuad(
                    a0, y0, b0,
                    a0, y1, b1,
                    a0, bottom, b1,
                    a0, bottom, b0,
                    nx, ny, nz, color, packedLight);
        } else {
            pushQuad(
                    b0, y0, a0,
                    b1, y1, a0,
                    b1, bottom, a0,
                    b0, bottom, a0,
                    nx, ny, nz, color, packedLight);
        }
    }

    private void pushQuad(float x0, float y0, float z0, float x1, float y1, float z1,
                          float x2, float y2, float z2, float x3, float y3, float z3,
                          float nx, float ny, float nz, int color, int packedLight) {
        if (quads * 12 + 12 > pos.length) {
            return;
        }
        int q = quads++;
        int p = q * 12;
        pos[p] = x0;
        pos[p + 1] = y0;
        pos[p + 2] = z0;
        pos[p + 3] = x1;
        pos[p + 4] = y1;
        pos[p + 5] = z1;
        pos[p + 6] = x2;
        pos[p + 7] = y2;
        pos[p + 8] = z2;
        pos[p + 9] = x3;
        pos[p + 10] = y3;
        pos[p + 11] = z3;

        for (int v = 0; v < 4; v++) {
            int n = p + v * 3;
            nrm[n] = nx;
            nrm[n + 1] = ny;
            nrm[n + 2] = nz;
        }

        int u = q * 8;
        uv[u] = x0 * 0.125f;
        uv[u + 1] = z0 * 0.125f;
        uv[u + 2] = x1 * 0.125f;
        uv[u + 3] = z1 * 0.125f;
        uv[u + 4] = x2 * 0.125f;
        uv[u + 5] = z2 * 0.125f;
        uv[u + 6] = x3 * 0.125f;
        uv[u + 7] = z3 * 0.125f;

        col[q * 4] = color;
        col[q * 4 + 1] = color;
        col[q * 4 + 2] = color;
        col[q * 4 + 3] = color;
        light[q] = packedLight;
    }

    private void resize(int newSide) {
        side = newSide;
        int maxQuads = newSide * newSide * 5;
        heights = new float[newSide * newSide];
        depths = new float[newSide * newSide];
        wet = new boolean[newSide * newSide];
        pos = new float[maxQuads * 12];
        nrm = new float[maxQuads * 12];
        uv = new float[maxQuads * 8];
        col = new int[maxQuads * 4];
        light = new int[maxQuads];
    }

    // ---------------------------------------------------------------- отрисовка

    public void render(VertexConsumer vc, List<WaveSource> waves, float time, float visual) {
        boolean hasWaves = !waves.isEmpty() && visual > 0;
        int maxWaves = Math.min(waves.size(), 8);

        for (int q = 0; q < quads; q++) {
            int p = q * 12;
            int u = q * 8;
            int c = col[q * 4];
            int l = light[q];
            float nx = nrm[p];
            float ny = nrm[p + 1];
            float nz = nrm[p + 2];

            for (int pass = 0; pass < 2; pass++) {
                for (int v = 0; v < 4; v++) {
                    int vi = (pass == 0) ? v : 3 - v;
                    float x = pos[p + vi * 3];
                    float y = pos[p + vi * 3 + 1];
                    float z = pos[p + vi * 3 + 2];
                    if (hasWaves) {
                        y += displacement(x, z, waves, maxWaves, time) * visual;
                    }
                    float n = (pass == 0) ? 1.0f : -1.0f;
                    vc.vertex(x, y, z)
                            .color(c)
                            .uv(uv[u + vi * 2], uv[u + vi * 2 + 1])
                            .overlayCoords(net.minecraft.client.renderer.texture.OverlayTexture.NO_OVERLAY)
                            .uv2(l)
                            .normal(nx * n, ny * n, nz * n)
                            .endVertex();
                }
            }
        }
    }

    private static float displacement(float x, float z, List<WaveSource> waves, int count, float time) {
        float sum = 0;
        for (int i = 0; i < count; i++) {
            WaveSource s = waves.get(i);
            float dx = x - s.x();
            float dz = z - s.z();
            float d = Mth.sqrt(dx * dx + dz * dz);
            if (d > 7.0f) {
                continue;
            }
            float falloff = (float) Math.exp(-d * 0.55);
            sum += s.strength() * falloff * 0.045f
                    * Mth.cos(d * 2.3f - time * 4.2f);
        }
        return sum;
    }

    /** Высота поверхности в мировых координатах (для отладки/эффектов). */
    public float heightAt(int wx, int wz) {
        int gx = wx - (int) lastBaseX;
        int gz = wz - (int) lastBaseZ;
        if (gx < 0 || gz < 0 || gx >= side || gz >= side) {
            return Float.NaN;
        }
        int i = gx + side * gz;
        return wet[i] ? heights[i] : Float.NaN;
    }

    private float lastBaseX;
    private float lastBaseZ;

    public void setBase(int baseX, int baseZ) {
        this.lastBaseX = baseX;
        this.lastBaseZ = baseZ;
    }

    public static Precision precision() {
        return AquafluxConfig.texturePrecision();
    }
}
