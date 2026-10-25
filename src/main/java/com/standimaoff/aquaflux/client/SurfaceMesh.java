package com.standimaoff.aquaflux.client;

import com.mojang.blaze3d.vertex.VertexConsumer;
import com.standimaoff.aquaflux.AquafluxConfig;
import com.standimaoff.aquaflux.core.HeightField;
import com.standimaoff.aquaflux.core.Precision;
import com.standimaoff.aquaflux.core.SurfaceMesher;
import com.standimaoff.aquaflux.core.WaveSpectrum;
import com.standimaoff.aquaflux.world.WaterRegion;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.renderer.LevelRenderer;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.core.BlockPos;
import net.minecraft.util.Mth;
import net.minecraft.world.level.levelgen.Heightmap;
import org.joml.Matrix3f;
import org.joml.Matrix4f;
import org.joml.Vector3f;
import org.joml.Vector4f;

import java.util.List;

/**
 * Гладкая поверхность воды: мост между миром и чистым мешером.
 *
 * <p>Сэмплируем блоки по карте высот, интерполируем на сетку 0.5 блока и отдаём
 * {@link SurfaceMesher}. Узлы общие для соседних ячеек, поэтому вода соседних блоков
 * сливается в одну поверхность, а не в набор кубов. Ветер добавляет спектр волн -
 * тот же, что считает сервер для барашков.</p>
 */
public final class SurfaceMesh {

    /** Волна от игрока/лодки в мировых координатах. */
    public record WaveSource(float x, float z, float strength) {
    }

    private static final int MAX_NODES = 160 * 160;

    private final SurfaceMesher mesher = new SurfaceMesher(MAX_NODES);
    private final SurfaceMesher.Output output = new SurfaceMesher.Output();
    private final BlockPos.MutableBlockPos mutable = new BlockPos.MutableBlockPos();

    private HeightField field;
    private int coarseSide;
    private float[] blockSurface = new float[0];
    private float[] blockDepth = new float[0];
    private boolean[] blockWet = new boolean[0];
    private int baseX;
    private int baseZ;
    private WaveSpectrum spectrum = WaveSpectrum.calm();
    private double buildTime;
    /** Отладка: сколько раз строили меш и сколько водных колонок нашли. */
    private int rebuilds;
    private int wetColumns;
    private int wetNodes;
    private int nanNodes;
    private double firstBed = Double.NaN;
    private double firstDepth = Double.NaN;

    public boolean isEmpty() {
        return output.quads == 0;
    }

    public int quadCount() {
        return output.quads;
    }

    /** Сколько стенок у водопадов и обрывов построено - для отладки. */
    public int curtainCount() {
        return output.curtains;
    }

    public int rebuilds() {
        return rebuilds;
    }

    public int wetColumns() {
        return wetColumns;
    }

    /** Отладочная строка: «перестроек 12, колонок с водой 340, квадов 900». */
    public String stats() {
        return "перестроек " + rebuilds + ", водных колонок " + wetColumns
                + ", мокрых узлов " + wetNodes + ", NaN " + nanNodes
                + ", первый узел bed=" + String.format("%.2f", firstBed)
                + " depth=" + String.format("%.2f", firstDepth)
                + ", квадов " + output.quads + ", завес " + output.curtains;
    }

    // ---------------------------------------------------------------- построение

    public void rebuild(ClientLevel level, BlockPos center, int radius, Precision precision,
                        int regionSize, double timeSeconds) {
        int side = radius * 2 + 3;
        if (side != coarseSide) {
            coarseSide = side;
            blockSurface = new float[side * side];
            blockDepth = new float[side * side];
            blockWet = new boolean[side * side];
            int nodes = (side * 2 - 1);
            if (nodes * nodes > MAX_NODES) {
                nodes = (int) Math.sqrt(MAX_NODES);
            }
            field = new HeightField(nodes, nodes, 0.5,
                    center.getX() - (side - 1) * 0.5, center.getZ() - (side - 1) * 0.5);
        }

        buildTime = timeSeconds;
        rebuilds++;
        baseX = center.getX() - (side - 1) / 2;
        baseZ = center.getZ() - (side - 1) / 2;
        // Центр построения едет за игроком - поле обязано ехать вместе с ним.
        field.moveTo(center.getX() - (side - 1) * 0.5, center.getZ() - (side - 1) * 0.5);
        sampleBlocks(level);
        fillField(regionSize);
        wetNodes = 0;
        nanNodes = 0;
        firstBed = Double.NaN;
        firstDepth = Double.NaN;
        for (int k = 0; k < field.w * field.h; k++) {
            if (field.depth[k] > 0.02) {
                if (wetNodes == 0) {
                    firstBed = field.bed[k];
                    firstDepth = field.depth[k];
                }
                wetNodes++;
            }
            if (!Double.isFinite(field.bed[k] + field.depth[k] + field.wave[k])) {
                nanNodes++;
            }
        }
        mesher.build(field, precision, true, output, timeSeconds);
    }

    /**
     * Снять с мира, где вода: столбец за столбцом.
     *
     * <p>Карта высот {@code MOTION_BLOCKING} воду НЕ видит (сквозь неё ходят), поэтому
     * идём вниз от поверхности земли и ищем первый наш блок воды. Так вода видна и на
     * поверхности, и в яме, и в водопаде.</p>
     */
    private void sampleBlocks(ClientLevel level) {
        int minY = level.getMinBuildHeight();
        int maxY = level.getMaxBuildHeight() - 1;
        wetColumns = 0;
        for (int j = 0; j < coarseSide; j++) {
            int wz = baseZ + j;
            for (int i = 0; i < coarseSide; i++) {
                int wx = baseX + i;
                int idx = i + coarseSide * j;
                blockWet[idx] = false;
                int top = Math.max(minY, Math.min(maxY, level.getHeight(Heightmap.Types.MOTION_BLOCKING, wx, wz)));
                int surfaceY = Integer.MIN_VALUE;
                int floor = Math.max(minY, top - 48);
                for (int y = Math.min(maxY, top + 2); y >= floor; y--) {
                    mutable.set(wx, y, wz);
                    if (WaterRegion.isOurs(level.getBlockState(mutable))) {
                        surfaceY = y;
                        break;
                    }
                }
                if (surfaceY == Integer.MIN_VALUE) {
                    // Суша: высота земли - верхняя точка рельефа.
                    blockSurface[idx] = top;
                    blockDepth[idx] = 0;
                    continue;
                }
                mutable.set(wx, surfaceY, wz);
                float surface = surfaceY + (float) WaterRegion.fillOf(level.getBlockState(mutable));
                blockSurface[idx] = surface;
                if (!blockWet[idx]) {
                    wetColumns++;
                }
                blockWet[idx] = true;

                // Толщина: сколько блоков воды подряд лежит под поверхностью.
                int bottom = surfaceY;
                int limit = Math.max(minY, surfaceY - 48);
                while (bottom - 1 >= limit) {
                    mutable.set(wx, bottom - 1, wz);
                    if (!WaterRegion.isOurs(level.getBlockState(mutable))) {
                        break;
                    }
                    bottom--;
                }
                blockDepth[idx] = Math.max(0.25f, surface - bottom);
            }
        }
    }

    private void fillField(int regionSize) {
        HeightField f = field;
        double ox = f.originX;
        double oz = f.originZ;

        // Спектр ветра: один на всю видимую область, амплитуда из конфига.
        double windSpeed = 2.0 + 9.0 * AquafluxConfig.windStrength();
        spectrum = WaveSpectrum.wind(windSpeed, 4.0, 20240211, 6);
        double swell = AquafluxConfig.swell();

        for (int j = 0; j < f.h; j++) {
            double wz = f.worldZ(j);
            for (int i = 0; i < f.w; i++) {
                double wx = f.worldX(i);
                double gx = (wx - baseX);
                double gz = (wz - baseZ);
                int i0 = Mth.floor(gx);
                int j0 = Mth.floor(gz);
                if (i0 < 0 || j0 < 0 || i0 >= coarseSide - 1 || j0 >= coarseSide - 1) {
                    f.set(i, j, 0, 0, 0, 0);
                    continue;
                }
                double tx = gx - i0;
                double tz = gz - j0;
                int k00 = i0 + coarseSide * j0;
                int k10 = k00 + 1;
                int k01 = k00 + coarseSide;
                int k11 = k01 + 1;

                boolean wet = blockWet[k00] || blockWet[k10] || blockWet[k01] || blockWet[k11];
                if (!wet) {
                    double bed = lerp(lerp(blockSurface[k00], blockSurface[k10], tx),
                            lerp(blockSurface[k01], blockSurface[k11], tx), tz) - 1.0;
                    f.set(i, j, bed, 0, 0, 0);
                    continue;
                }
                double s = lerp(lerp(blockSurface[k00], blockSurface[k10], tx),
                        lerp(blockSurface[k01], blockSurface[k11], tx), tz);
                double d = lerp(lerp(blockDepth[k00], blockDepth[k10], tx),
                        lerp(blockDepth[k01], blockDepth[k11], tx), tz);
                double bed = s - d;

                int bx = Mth.floor(wx);
                int bz = Mth.floor(wz);
                double wave = ClientWaterCache.wave(bx, bz, regionSize);
                double foam = ClientWaterCache.foam(bx, bz, regionSize);
                // Ветер: мелкая рябь поверх серверных волн. Она не несёт массу.
                double breeze = spectrum.height(wx, wz, buildTime) * swell;
                if (d > 0.35) {
                    wave += breeze;
                } else {
                    // На мелководье волна «садится» на дно - так же, как в жизни.
                    wave += breeze * Math.max(0.0, d / 0.35);
                }
                f.set(i, j, bed, d, wave, foam,
                        ClientWaterCache.flowU(bx, bz, regionSize),
                        ClientWaterCache.flowV(bx, bz, regionSize));
            }
        }
    }

    private static double lerp(double a, double b, double t) {
        return a + (b - a) * t;
    }

    // ---------------------------------------------------------------- отрисовка

    public void render(ClientLevel level, VertexConsumer vc, Matrix4f model, TextureAtlasSprite sprite,
                       List<WaveSource> waves, float time, float visual) {
        SurfaceMesher.Output o = output;
        if (o.quads == 0) {
            return;
        }
        Matrix3f normalMatrix = new Matrix3f(model);
        Vector4f point = new Vector4f();
        Vector3f normal = new Vector3f();
        boolean hasWaves = !waves.isEmpty() && visual > 0;
        int maxWaves = Math.min(waves.size(), 6);

        for (int q = 0; q < o.quads; q++) {
            int p = q * 12;
            int ci = q * 4;
            for (int v = 0; v < 4; v++) {
                float x = o.pos[p + v * 3];
                float y = o.pos[p + v * 3 + 1];
                float z = o.pos[p + v * 3 + 2];
                if (hasWaves) {
                    y += displacement(x, z, waves, maxWaves, time) * visual;
                }
                float nx = o.nrm[p + v * 3];
                float ny = o.nrm[p + v * 3 + 1];
                float nz = o.nrm[p + v * 3 + 2];

                point.set(x, y, z, 1.0f).mul(model);
                normal.set(nx, ny, nz).mul(normalMatrix).normalize();

                mutable.set(Mth.floor(x), Mth.floor(y) + 1, Mth.floor(z));
                int light = LevelRenderer.getLightColor(level, mutable);
                float u = sprite.getU(frac(x * 0.5f));
                float vv = sprite.getV(frac(z * 0.5f));

                vc.vertex(point.x, point.y, point.z)
                        .color(o.color[ci + v])
                        .uv(u, vv)
                        .overlayCoords(OverlayTexture.NO_OVERLAY)
                        .uv2(light)
                        .normal(normal.x, normal.y, normal.z)
                        .endVertex();
            }
        }
    }

    private static float frac(float v) {
        float f = v - Mth.floor(v);
        return f < 0 ? f + 1 : f;
    }

    private static float displacement(float x, float z, List<WaveSource> waves, int count, float time) {
        float sum = 0;
        for (int i = 0; i < count; i++) {
            WaveSource s = waves.get(i);
            float dx = x - s.x();
            float dz = z - s.z();
            float d = Mth.sqrt(dx * dx + dz * dz);
            if (d > 8.0f) {
                continue;
            }
            float falloff = (float) Math.exp(-d * 0.5);
            sum += s.strength() * falloff * 0.05f * Mth.cos(d * 2.1f - time * 4.0f);
        }
        return sum;
    }
}
