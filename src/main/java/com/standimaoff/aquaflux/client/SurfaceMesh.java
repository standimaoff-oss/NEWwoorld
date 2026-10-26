package com.standimaoff.aquaflux.client;

import com.mojang.blaze3d.vertex.VertexConsumer;
import com.standimaoff.aquaflux.Aquaflux;
import com.standimaoff.aquaflux.AquafluxConfig;
import com.standimaoff.aquaflux.core.HeightField;
import com.standimaoff.aquaflux.core.Precision;
import com.standimaoff.aquaflux.core.SurfaceMesher;
import com.standimaoff.aquaflux.core.WaveSpectrum;
import com.standimaoff.aquaflux.world.WaterRegion;
import net.minecraft.client.Minecraft;
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
    private boolean lastDoubleSided;

    public String stats() {
        return "перестроек " + rebuilds + ", водных колонок " + wetColumns
                + ", мокрых узлов " + wetNodes + ", NaN " + nanNodes
                + ", первый узел bed=" + String.format("%.2f", firstBed)
                + " depth=" + String.format("%.2f", firstDepth)
                + ", квадов " + output.quads + ", завес " + output.curtains
                + ", сухих клеток " + output.skippedDry + ", NaN-квадов " + output.nanQuads
                + ", изнанка " + (lastDoubleSided ? "да" : "нет");
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
        // Изнанку рисуем только когда на воду смотрят снизу. Иначе она лежит ровно под
        // лицевой стороной и просвечивает сквозь неё: полупрозрачные слои складываются
        // и вода темнеет пятнами вплоть до чёрного.
        lastDoubleSided = Boolean.getBoolean("aquaflux.nocull") || cameraUnderwater();
        mesher.build(field, precision, lastDoubleSided, output, timeSeconds);
        // (cameraUnderwater считает по только что заполненному полю)
        if (DUMP) {
            dumpField();
        }
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
                // Ищем воду С ЗАПАСОМ ВВЕРХ: в выкопанной яме поверхность земли - это дно
                // ямы, а вода стоит выше него. Со сканом от top+2 верхние слои воды не
                // попадали в выборку, колонка считалась сухой - и в меше получалась дырка,
                // сквозь которую было видно неосвещённое дно (чёрные пятна).
                int scanTop = Math.min(maxY, top + 24);
                for (int y = scanTop; y >= floor; y--) {
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
                double s = lerp(lerp(blockSurface[k00], blockSurface[k10], tx),
                        lerp(blockSurface[k01], blockSurface[k11], tx), tz);
                double d = lerp(lerp(blockDepth[k00], blockDepth[k10], tx),
                        lerp(blockDepth[k01], blockDepth[k11], tx), tz);
                if (!wet) {
                    // Суша: поверхность плёнки лежит ровно на земле. Раньше её опускали
                    // на блок ниже - на кромке получался обрыв в бездну, и он рисовался
                    // чёрными «парусами» поверх воды.
                    f.set(i, j, s, 0, 0, 0);
                    continue;
                }
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
        if (dumpRequest) {
            dumpRequest = false;
            dumpQuads();
        }
        if (o.quads == 0) {
            return;
        }
        if (DEBUG_MODE == 7) {
            // Отладка: рисуем без теста глубины. Остались пятна - значит их
            // рисует что-то ПОСЛЕ нас, а не дырки в меше.
            com.mojang.blaze3d.systems.RenderSystem.disableDepthTest();
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
                if (DEBUG_MODE == 4) {
                    y += 3.0f; // сдвиг меша: пятна на месте - значит они не от меша
                }
                float nx = o.nrm[p + v * 3];
                float ny = o.nrm[p + v * 3 + 1];
                float nz = o.nrm[p + v * 3 + 2];

                point.set(x, y, z, 1.0f).mul(model);
                normal.set(nx, ny, nz).mul(normalMatrix).normalize();

                // Свет берём «сверху воды», а не из блока под вершиной: внутри толщи
                // лайтмапа почти нулевая, и поверхность шла чёрными пятнами. Яркость
                // дня учитываем отдельно, чтобы ночью вода не светилась.
                int light = FLAT_LIGHT ? 0x00F000F0 : skyLight(level);
                float u = sprite.getU(frac(x * 0.5f));
                float vv = sprite.getV(frac(z * 0.5f));
                if (DEBUG_MODE == 2) {
                    u = sprite.getU(0.5f);
                    vv = sprite.getV(0.5f);
                }
                int argb = shade(o.color[ci + v], x, y, z, nx, ny, nz);
                if (DEBUG_MODE == 5) {
                    argb = 0xFFFF0000;
                    light = 0x00F000F0;
                    u = sprite.getU(0.5f);
                    vv = sprite.getV(0.5f);
                }
                if (DEBUG_MODE == 7) {
                    argb = 0xFF00FF00;
                    light = 0x00F000F0;
                    u = sprite.getU(0.5f);
                    vv = sprite.getV(0.5f);
                }
                if (DEBUG_MODE == 3) {
                    // Сплошной ярко-зелёный без света и текстуры: сразу видно,
                    // «наши» это пиксели или дырка в меше.
                    argb = 0xFF00FF00;
                    light = 0x00F000F0;
                    u = sprite.getU(0.5f);
                    vv = sprite.getV(0.5f);
                }

                vc.vertex(point.x, point.y, point.z)
                        .color(argb)
                        .uv(u, vv)
                        .overlayCoords(OverlayTexture.NO_OVERLAY)
                        .uv2(light)
                        .normal(normal.x, normal.y, normal.z)
                        .endVertex();
            }
        }
        if (DEBUG_MODE == 7) {
            com.mojang.blaze3d.systems.RenderSystem.enableDepthTest();
        }
    }

    /** Положение камеры в мире: нужно для отражения неба на скользящих углах. */
    private static double viewX = Double.NaN;
    private static double viewY;
    private static double viewZ;
    /** Направление на солнце (день, средние широты) - для блика на гребнях. */
    private static final double SUN_X = 0.35;
    private static final double SUN_Y = 0.86;
    private static final double SUN_Z = 0.37;

    /** Отладка: выгрузить квады текущего кадра по запросу харнесса. */
    private static final boolean DUMP_QUADS = System.getProperty("aquaflux.dumpquads") != null;
    private static volatile boolean dumpRequest;

    /** Попросить выгрузить квады на следующем кадре (ровно тот вид, что на скриншоте). */
    public static void requestQuadDump() {
        dumpRequest = DUMP_QUADS;
    }

    private void dumpQuads() {
        SurfaceMesher.Output o = output;
        try (java.io.PrintWriter w = new java.io.PrintWriter(
                new java.io.FileWriter(new java.io.File("quads-dump.csv")))) {
            w.println("# view " + viewX + " " + viewY + " " + viewZ);
            w.println("# right " + viewRightX + " " + viewRightY + " " + viewRightZ);
            w.println("# up " + viewUpX + " " + viewUpY + " " + viewUpZ);
            w.println("# fwd " + viewFwdX + " " + viewFwdY + " " + viewFwdZ);
            w.println("q,v,x,y,z,nx,ny,nz,argb,depth,foam");
            for (int q = 0; q < o.quads; q++) {
                for (int v = 0; v < 4; v++) {
                    int p3 = q * 12 + v * 3;
                    w.println(q + "," + v + "," + o.pos[p3] + "," + o.pos[p3 + 1] + ","
                            + o.pos[p3 + 2] + "," + o.nrm[p3] + "," + o.nrm[p3 + 1] + ","
                            + o.nrm[p3 + 2] + "," + Integer.toHexString(o.color[q * 4 + v])
                            + "," + o.depth[q * 4 + v] + "," + o.foam[q * 4 + v]);
                }
            }
            Aquaflux.LOGGER.info("[screens] квады выгружены: {}", o.quads);
        } catch (Exception e) {
            Aquaflux.LOGGER.error("[screens] не смог выгрузить квады", e);
        }
    }

    /** Отладка: выгрузить поле высот в CSV, чтобы разобрать кадр по числам. */
    private static final boolean DUMP = System.getProperty("aquaflux.dump") != null;

    /** Смотрит ли камера на эту воду снизу - тогда нужна изнанка. */
    private boolean cameraUnderwater() {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) {
            return false;
        }
        int ci = (int) Math.round((mc.player.getX() - field.originX) / field.step);
        int cj = (int) Math.round((mc.player.getZ() - field.originZ) / field.step);
        if (!field.inside(ci, cj)) {
            return false;
        }
        int k = field.index(ci, cj);
        double surface = field.bed[k] + field.depth[k] + field.wave[k];
        return field.depth[k] > 0.05 && mc.player.getEyeY() < surface - 0.02;
    }

    private void dumpField() {
        try {
            java.io.File out = new java.io.File("field-dump.csv");
            try (java.io.PrintWriter w = new java.io.PrintWriter(new java.io.FileWriter(out))) {
                w.println("i,j,worldX,worldZ,bed,depth,wave,foam,flowU,flowV");
                for (int j = 0; j < field.h; j++) {
                    for (int i = 0; i < field.w; i++) {
                        int k = field.index(i, j);
                        w.println(i + "," + j + "," + field.worldX(i) + "," + field.worldZ(j)
                                + "," + field.bed[k] + "," + field.depth[k] + "," + field.wave[k]
                                + "," + field.foam[k] + "," + field.flowU[k] + "," + field.flowV[k]);
                    }
                }
                w.println("# origin " + field.originX + " " + field.originZ + " step " + field.step);
            }
            Aquaflux.LOGGER.info("[screens] поле выгружено в {}", out.getAbsolutePath());
        } catch (Exception e) {
            Aquaflux.LOGGER.error("[screens] не смог выгрузить поле", e);
        }
    }

    /** Свет неба для воды: полный днём, приглушённый ночью. */
    private static int skyLight(ClientLevel level) {
        int darken = Math.max(0, Math.min(11, level.getSkyDarken()));
        int sky = (int) (240.0 * (1.0 - darken / 12.5));
        int block = (int) (240.0 * (1.0 - darken / 16.0));
        return (block << 16) | sky;
    }

    /** Отладка: ровный свет, чтобы отделить лайтмапу от цвета. */
    private static final boolean FLAT_LIGHT = System.getProperty("aquaflux.flatlight") != null;

    /** Оси камеры в мире (из матрицы вида) - для отладочной проекции квадов. */
    private static float viewRightX = 1;
    private static float viewRightY;
    private static float viewRightZ;
    private static float viewUpX;
    private static float viewUpY = 1;
    private static float viewUpZ;
    private static float viewFwdX;
    private static float viewFwdY;
    private static float viewFwdZ = -1;

    public static void setView(double x, double y, double z) {
        viewX = x;
        viewY = y;
        viewZ = z;
    }

    /** Запомнить оси камеры (из матрицы вида) - нужно отладочной выгрузке квадов. */
    public static void setViewAxes(float rx, float ry, float rz,
                                   float ux, float uy, float uz,
                                   float fx, float fy, float fz) {
        viewRightX = rx;
        viewRightY = ry;
        viewRightZ = rz;
        viewUpX = ux;
        viewUpY = uy;
        viewUpZ = uz;
        viewFwdX = fx;
        viewFwdY = fy;
        viewFwdZ = fz;
    }

    /**
     * Цвет вершины с учётом того, откуда на воду смотрят.
     *
     * <p>Свежеиспечённый цвет считается по толще воды, но настоящее отражение неба
     * зависит от угла зрения: у горизонта вода почти зеркало, под ногами - прозрачная
     * толща. Поэтому Френель и солнечный блик добавляются здесь, когда камера известна.</p>
     */
    private static int shade(int argb, float x, float y, float z, float nx, float ny, float nz) {
        if (Double.isNaN(viewX)) {
            return argb;
        }
        double vx = viewX - x;
        double vy = viewY - y;
        double vz = viewZ - z;
        double len = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (len < 1e-5) {
            return argb;
        }
        vx /= len;
        vy /= len;
        vz /= len;
        double cosine = Math.abs(nx * vx + ny * vy + nz * vz);
        cosine = Math.min(1.0, cosine);
        double g = 1.0 - cosine;
        double fres = g * g * g * g * g;

        // Блик: полпути между взглядом и солнцем, степень 90 - узкий, как у воды.
        double hx = vx + SUN_X;
        double hy = vy + SUN_Y;
        double hz = vz + SUN_Z;
        double hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
        double spec = 0;
        if (hl > 1e-6) {
            double nh = Math.max(0.0, (nx * hx + ny * hy + nz * hz) / hl);
            double n2 = nh * nh;
            double n4 = n2 * n2;
            double n8 = n4 * n4;
            double n16 = n8 * n8;
            double n64 = n16 * n16 * n16 * n16;
            spec = n64 * n16 * n8 * 0.85; // nh^88
        }

        int a = (argb >>> 24) & 0xFF;
        double r = ((argb >> 16) & 0xFF) / 255.0;
        double gg = ((argb >> 8) & 0xFF) / 255.0;
        double b = (argb & 0xFF) / 255.0;
        double k = fres * 0.55;
        r += (0.62 - r) * k;
        gg += (0.78 - gg) * k;
        b += (0.90 - b) * k;
        r += spec;
        gg += spec;
        b += spec;
        // На скользящих углах толща «зеркалит» и потому плотнее.
        int alpha = (int) Math.min(250.0, a + 40.0 * fres);
        return (alpha << 24) | (Math.min(255, (int) (r * 255)) << 16)
                | (Math.min(255, (int) (gg * 255)) << 8) | Math.min(255, (int) (b * 255));
    }

    /** Отладка: 0 - обычно, 1 - не рисовать меш, 2 - брать УФ из центра спрайта. */
    public static volatile int DEBUG_MODE;

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
