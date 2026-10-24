package com.standimaoff.aquaflux.core;

/**
 * Строит гладкую поверхность воды по {@link HeightField}.
 *
 * <p>Что важно для «не кубической» воды:</p>
 * <ul>
 *   <li><b>высоты интерполируются по узлам</b> - ступенек в 1/8 блока не видно;</li>
 *   <li><b>берег сходится к земле</b>: сухой узел рядом с водой получает тонкую плёнку,
 *       поэтому поверхность плавно прилипает к берегу, а не обрывается стеной;</li>
 *   <li><b>нормали сглажены</b> по центральным разностям - блики идут волной, а не фасетками;</li>
 *   <li><b>соседние ячейки делят узлы</b>, поэтому вода из разных блоков выглядит единой;</li>
 *   <li>стенка рисуется только там, где вода реально свисает уступом (обрыв, край ямы).</li>
 * </ul>
 *
 * <p>Класс чистый: ни Minecraft, ни OpenGL. Его гоняют и клиент, и превью-рендерер.</p>
 */
public final class SurfaceMesher {

    /** Результат: вершины квадов (4 на квад, треугольники 0-1-2 и 0-2-3). */
    public static final class Output {
        public float[] pos = new float[0];
        public float[] nrm = new float[0];
        public float[] uv = new float[0];
        /** Толщина воды в блоке - для поглощения и пены. */
        public float[] depth = new float[0];
        public int[] color = new int[0];
        public int quads;

        public int vertexCount() {
            return quads * 4;
        }

        void reset(int quadCapacity) {
            int needVerts = Math.max(4, quadCapacity * 4);
            if (pos.length < needVerts * 3) {
                pos = new float[needVerts * 3];
                nrm = new float[needVerts * 3];
                uv = new float[needVerts * 2];
                color = new int[needVerts];
                depth = new float[needVerts];
            }
            quads = 0;
        }

        boolean hasRoom() {
            return (quads + 1) * 4 <= color.length && (quads + 1) * 12 <= pos.length;
        }
    }

    private static final double MENISCUS = 0.10;
    private static final double EPS = 1.0e-4;

    private final double[] height;
    private final double[] normalX;
    private final double[] normalY;
    private final double[] normalZ;

    private HeightField field;
    private Output out;
    private Precision precision;

    public SurfaceMesher(int maxNodes) {
        int n = Math.max(8, maxNodes);
        this.height = new double[n];
        this.normalX = new double[n];
        this.normalY = new double[n];
        this.normalZ = new double[n];
    }

    /**
     * Построить меш.
     *
     * @param field       поле высот
     * @param precision   пресет битности цвета
     * @param doubleSided дублировать грани обратной стороной (видно из-под воды)
     * @param output      буфер результата
     */
    public void build(HeightField field, Precision precision, boolean doubleSided, Output output) {
        this.field = field;
        this.out = output;
        this.precision = precision;
        int nodes = field.w * field.h;
        if (height.length < nodes) {
            throw new IllegalArgumentException("мешер мал: " + height.length + " < " + nodes);
        }
        int maxQuads = (field.w - 1) * (field.h - 1) * 3 + 32;
        output.reset(maxQuads);

        computeHeights();
        computeNormals();
        emitCells(doubleSided);
    }

    // ---------------------------------------------------------------- высоты и нормали

    private void computeHeights() {
        HeightField f = field;
        for (int j = 0; j < f.h; j++) {
            for (int i = 0; i < f.w; i++) {
                int k = f.index(i, j);
                double bed = f.bed[k];
                if (f.depth[k] > EPS) {
                    height[k] = Math.max(bed, f.renderSurface(i, j));
                    continue;
                }
                double sum = 0;
                int wet = 0;
                for (int dj = -1; dj <= 1; dj++) {
                    for (int di = -1; di <= 1; di++) {
                        int ii = i + di;
                        int jj = j + dj;
                        if (!f.wet(ii, jj)) {
                            continue;
                        }
                        sum += f.renderSurface(ii, jj);
                        wet++;
                    }
                }
                if (wet == 0) {
                    height[k] = bed;
                } else {
                    double target = sum / wet + 0.02;
                    height[k] = Math.max(bed - 0.30, Math.min(bed + MENISCUS, target));
                }
            }
        }
    }

    private void computeNormals() {
        HeightField f = field;
        double inv = 1.0 / (2.0 * f.step);
        for (int j = 0; j < f.h; j++) {
            for (int i = 0; i < f.w; i++) {
                int k = f.index(i, j);
                int kl = i > 0 ? k - 1 : k;
                int kr = i < f.w - 1 ? k + 1 : k;
                int kd = j > 0 ? k - f.w : k;
                int ku = j < f.h - 1 ? k + f.w : k;
                double nx = (height[kl] - height[kr]) * inv;
                double nz = (height[kd] - height[ku]) * inv;
                double len = Math.sqrt(nx * nx + 1.0 + nz * nz);
                normalX[k] = nx / len;
                normalY[k] = 1.0 / len;
                normalZ[k] = nz / len;
            }
        }
    }

    // ---------------------------------------------------------------- грани

    private void emitCells(boolean doubleSided) {
        HeightField f = field;
        for (int j = 0; j < f.h - 1; j++) {
            for (int i = 0; i < f.w - 1; i++) {
                int k00 = f.index(i, j);
                int k10 = k00 + 1;
                int k01 = k00 + f.w;
                int k11 = k01 + 1;
                if (f.depth[k00] <= EPS && f.depth[k10] <= EPS
                        && f.depth[k01] <= EPS && f.depth[k11] <= EPS) {
                    continue;
                }

                double x0 = f.worldX(i);
                double x1 = f.worldX(i + 1);
                double z0 = f.worldZ(j);
                double z1 = f.worldZ(j + 1);

                double depth = (f.depth[k00] + f.depth[k10] + f.depth[k01] + f.depth[k11]) * 0.25;
                double foam = (f.foam[k00] + f.foam[k10] + f.foam[k01] + f.foam[k11]) * 0.25;
                foam = Math.min(1.0, foam * 0.8 + shoreFoam(i, j) * 0.5);
                double nx = (normalX[k00] + normalX[k11]) * 0.5;
                double ny = (normalY[k00] + normalY[k11]) * 0.5;
                double nz = (normalZ[k00] + normalZ[k11]) * 0.5;
                int color = WaterPalette.color(depth, nx, ny + 0.35, nz, foam, 1.0, precision);

                quad(x0, height[k00], z0, normalX[k00], normalY[k00], normalZ[k00], color, f.depth[k00],
                        x0, height[k01], z1, normalX[k01], normalY[k01], normalZ[k01], color, f.depth[k01],
                        x1, height[k11], z1, normalX[k11], normalY[k11], normalZ[k11], color, f.depth[k11],
                        x1, height[k10], z0, normalX[k10], normalY[k10], normalZ[k10], color, f.depth[k10]);

                if (doubleSided) {
                    quad(x1, height[k10], z0, -normalX[k10], -normalY[k10], -normalZ[k10], color, f.depth[k10],
                            x1, height[k11], z1, -normalX[k11], -normalY[k11], -normalZ[k11], color, f.depth[k11],
                            x0, height[k01], z1, -normalX[k01], -normalY[k01], -normalZ[k01], color, f.depth[k01],
                            x0, height[k00], z0, -normalX[k00], -normalY[k00], -normalZ[k00], color, f.depth[k00]);
                }

                double top = Math.max(height[k00], Math.max(height[k10], Math.max(height[k01], height[k11])));
                curtainIfNeeded(i + 1, j, x1, x1, z0, z1, top, color, 0);
                curtainIfNeeded(i, j, x0, x0, z0, z1, top, color, 1);
                curtainIfNeeded(i, j + 1, x0, x1, z1, z1, top, color, 2);
                curtainIfNeeded(i, j, x0, x1, z0, z0, top, color, 3);
            }
        }
    }

    private void curtainIfNeeded(int ni, int nj, double ax, double bx, double az, double bz,
                                 double top, int color, int side) {
        HeightField f = field;
        if (!f.inside(ni, nj)) {
            return;
        }
        int nk = f.index(ni, nj);
        if (f.depth[nk] > EPS) {
            return;
        }
        double bottom = f.bed[nk];
        if (top - bottom < 0.45) {
            return;
        }
        float t = (float) top;
        float b = (float) (bottom - 0.01);
        switch (side) {
            case 0 -> quad(bx, t, az, 1, 0, 0, color, 0.3,
                    bx, t, bz, 1, 0, 0, color, 0.3,
                    bx, b, bz, 1, 0, 0, color, 0.05,
                    bx, b, az, 1, 0, 0, color, 0.05);
            case 1 -> quad(ax, t, bz, -1, 0, 0, color, 0.3,
                    ax, t, az, -1, 0, 0, color, 0.3,
                    ax, b, az, -1, 0, 0, color, 0.05,
                    ax, b, bz, -1, 0, 0, color, 0.05);
            case 2 -> quad(ax, t, bz, 0, 0, 1, color, 0.3,
                    bx, t, bz, 0, 0, 1, color, 0.3,
                    bx, b, bz, 0, 0, 1, color, 0.05,
                    ax, b, bz, 0, 0, 1, color, 0.05);
            default -> quad(bx, t, az, 0, 0, -1, color, 0.3,
                    ax, t, az, 0, 0, -1, color, 0.3,
                    ax, b, az, 0, 0, -1, color, 0.05,
                    bx, b, az, 0, 0, -1, color, 0.05);
        }
    }

    private double shoreFoam(int i, int j) {
        HeightField f = field;
        int dry = 0;
        int total = 0;
        for (int dj = -1; dj <= 1; dj++) {
            for (int di = -1; di <= 1; di++) {
                int ii = i + di;
                int jj = j + dj;
                if (!f.inside(ii, jj)) {
                    continue;
                }
                total++;
                if (f.depth[f.index(ii, jj)] <= EPS) {
                    dry++;
                }
            }
        }
        return total == 0 ? 0 : (double) dry / total;
    }

    private void quad(double x0, double y0, double z0, double nx0, double ny0, double nz0, int c0,
                      double x1, double y1, double z1, double nx1, double ny1, double nz1, int c1,
                      double x2, double y2, double z2, double nx2, double ny2, double nz2, int c2,
                      double x3, double y3, double z3, double nx3, double ny3, double nz3, int c3) {
        quad(x0, y0, z0, nx0, ny0, nz0, c0, 0,
                x1, y1, z1, nx1, ny1, nz1, c1, 0,
                x2, y2, z2, nx2, ny2, nz2, c2, 0,
                x3, y3, z3, nx3, ny3, nz3, c3, 0);
    }

    private void quad(double x0, double y0, double z0, double nx0, double ny0, double nz0, int c0, double d0,
                      double x1, double y1, double z1, double nx1, double ny1, double nz1, int c1, double d1,
                      double x2, double y2, double z2, double nx2, double ny2, double nz2, int c2, double d2,
                      double x3, double y3, double z3, double nx3, double ny3, double nz3, int c3, double d3) {
        Output o = out;
        if (!o.hasRoom()) {
            return;
        }
        int q = o.quads++;
        int p = q * 12;
        o.pos[p] = (float) x0;
        o.pos[p + 1] = (float) y0;
        o.pos[p + 2] = (float) z0;
        o.pos[p + 3] = (float) x1;
        o.pos[p + 4] = (float) y1;
        o.pos[p + 5] = (float) z1;
        o.pos[p + 6] = (float) x2;
        o.pos[p + 7] = (float) y2;
        o.pos[p + 8] = (float) z2;
        o.pos[p + 9] = (float) x3;
        o.pos[p + 10] = (float) y3;
        o.pos[p + 11] = (float) z3;

        o.nrm[p] = (float) nx0;
        o.nrm[p + 1] = (float) ny0;
        o.nrm[p + 2] = (float) nz0;
        o.nrm[p + 3] = (float) nx1;
        o.nrm[p + 4] = (float) ny1;
        o.nrm[p + 5] = (float) nz1;
        o.nrm[p + 6] = (float) nx2;
        o.nrm[p + 7] = (float) ny2;
        o.nrm[p + 8] = (float) nz2;
        o.nrm[p + 9] = (float) nx3;
        o.nrm[p + 10] = (float) ny3;
        o.nrm[p + 11] = (float) nz3;

        int t = q * 8;
        o.uv[t] = (float) x0 * 0.25f;
        o.uv[t + 1] = (float) z0 * 0.25f;
        o.uv[t + 2] = (float) x1 * 0.25f;
        o.uv[t + 3] = (float) z1 * 0.25f;
        o.uv[t + 4] = (float) x2 * 0.25f;
        o.uv[t + 5] = (float) z2 * 0.25f;
        o.uv[t + 6] = (float) x3 * 0.25f;
        o.uv[t + 7] = (float) z3 * 0.25f;

        int ci = q * 4;
        o.color[ci] = c0;
        o.color[ci + 1] = c1;
        o.color[ci + 2] = c2;
        o.color[ci + 3] = c3;
        o.depth[ci] = (float) d0;
        o.depth[ci + 1] = (float) d1;
        o.depth[ci + 2] = (float) d2;
        o.depth[ci + 3] = (float) d3;
    }
}
