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
 *   <li><b>пена не заливка, а волокна</b>: она модулируется шумом вдоль течения, поэтому
 *       у берега и на порогах видна настоящая белая вода, а не белые пятна;</li>
 *   <li><b>цвет по вершинам</b> с поглощением по глубине - мель светлая, глубина синяя;</li>
 *   <li>стенка рисуется там, где вода реально свисает уступом (обрыв, край ямы, водопад).</li>
 * </ul>
 *
 * <p>Класс чистый: ни Minecraft, ни OpenGL. Его гоняют и клиент, и превью-рендерер,
 * поэтому то, что видно на превью, - это ровно то, что рисует игра.</p>
 */
public final class SurfaceMesher {

    /** Результат: вершины квадов (4 на квад, треугольники 0-1-2 и 0-2-3). */
    public static final class Output {
        public float[] pos = new float[0];
        public float[] nrm = new float[0];
        public float[] uv = new float[0];
        /** Толщина воды в вершине - для поглощения и пены. */
        public float[] depth = new float[0];
        /** Пена в вершине, 0..1 - клиент может рисовать её отдельным слоем. */
        public float[] foam = new float[0];
        /** Течение в вершине (u, v), м/с - для flow-map. */
        public float[] flow = new float[0];
        public int[] color = new int[0];
        public int quads;
        /** Сколько стенок-водопадов построено - для отладки. */
        public int curtains;
        /** Отладка: клетки, отброшенные как сухие, и квады с нечисловыми вершинами. */
        public int skippedDry;
        public int nanQuads;

        public int vertexCount() {
            return quads * 4;
        }

        void reset(int quadCapacity) {
            int needVerts = Math.max(4, quadCapacity * 4);
            if (pos.length < needVerts * 3) {
                pos = new float[needVerts * 3];
                nrm = new float[needVerts * 3];
                uv = new float[needVerts * 2];
                flow = new float[needVerts * 2];
                color = new int[needVerts];
                depth = new float[needVerts];
                foam = new float[needVerts];
            }
            quads = 0;
            curtains = 0;
            skippedDry = 0;
            nanQuads = 0;
        }

        boolean hasRoom() {
            return (quads + 1) * 4 <= color.length && (quads + 1) * 12 <= pos.length;
        }
    }

    /** Насколько плёнка у берега может подняться над землёй - «мениск». */
    private static final double MENISCUS = 0.10;
    private static final double EPS = 1.0e-4;
    /** Максимальная высота стенки воды на обрыве. */
    private static final double MAX_CURTAIN = 4.0;
    /** Стенка нужна только там, где вода действительно глубокая: у берега её нет. */
    private static final double CURTAIN_MIN_DEPTH = 0.55;
    /** И только на настоящем обрыве: у пологого берега вода просто сходит на землю. */
    private static final double CURTAIN_MIN_DROP = 0.9;
    /**
     * Толщина, ниже которой вода считается «сухой».
     *
     * <p>Слой в пару сантиметров - это не вода, а численная плёнка от решателя. Если
     * считать её водой, у водоёма не бывает берега: соседняя вершина всегда «мокрая»,
     * и стенка на обрыве не строится никогда.</p>
     */
    private static final double DRY_DEPTH = 0.02;
    /** Перепад между соседними вершинами, после которого вода уже падает, а не течёт. */
    private static final double CLIFF_DROP = 1.6;
    /**
     * Высота «губы» на перепаде уровня.
     *
     * <p>Высокий водопад - это не стенка, а поток мелких тел: вода разбивается о воздух.
     * Поэтому стенка закрывает только сам перепад у гребня, ниже идут капли.</p>
     */
    private static final double CLIFF_CURTAIN = 1.1;

    private final double[] height;
    /** Копия высоты для сглаживания мелководья (см. {@link #smoothShallows()}). */
    private final double[] scratch;
    private final double[] normalX;
    private final double[] normalY;
    private final double[] normalZ;
    private final double[] foamAt;
    private final double[] speedAt;
    private final double[] flowUX;
    private final double[] flowUZ;

    /** Отладка: выключить стенки на обрывах, чтобы видеть только поверхность. */
    public static boolean drawCurtains = true;
    /** Отладка: почему стенки не построились (0 - построена, 1 - вне поля, 2 - сосед мокрый,
     *  3 - мелко, 4 - берег выше воды, 5 - пологий берег, 6 - слишком тонкая). */
    public static final int[] curtainRejects = new int[8];

    private HeightField field;
    private Output out;
    private Precision precision;
    private double time;

    public SurfaceMesher(int maxNodes) {
        int n = Math.max(8, maxNodes);
        this.height = new double[n];
        this.scratch = new double[n];
        this.normalX = new double[n];
        this.normalY = new double[n];
        this.normalZ = new double[n];
        this.foamAt = new double[n];
        this.speedAt = new double[n];
        this.flowUX = new double[n];
        this.flowUZ = new double[n];
    }

    public SurfaceMesher(HeightField field) {
        this(field.w * field.h + 16);
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
        build(field, precision, doubleSided, output, 0.0);
    }

    /**
     * Построить меш с анимацией пены.
     *
     * @param time время в секундах - по нему текут волокна пены
     */
    public void build(HeightField field, Precision precision, boolean doubleSided, Output output,
                      double time) {
        this.field = field;
        this.out = output;
        this.precision = precision;
        this.time = time;
        int nodes = field.w * field.h;
        if (height.length < nodes) {
            throw new IllegalArgumentException("мешер мал: " + height.length + " < " + nodes);
        }
        int maxQuads = (field.w - 1) * (field.h - 1) * 3 + field.w * field.h * 2 + 64;
        output.reset(maxQuads);

        computeHeights();
        smoothShallows();
        computeNormals();
        computeSurfaceDetails();
        emitCells(doubleSided);
        if (drawCurtains) {
            emitCliffs();
        }
    }

    // ---------------------------------------------------------------- высоты и нормали

    private void computeHeights() {
        HeightField f = field;
        for (int j = 0; j < f.h; j++) {
            for (int i = 0; i < f.w; i++) {
                int k = f.index(i, j);
                double bed = f.bed[k];
                if (f.depth[k] > DRY_DEPTH) {
                    height[k] = Math.max(bed, f.renderSurface(i, j));
                    continue;
                }
                double sum = 0;
                double weightSum = 0;
                int wet = 0;
                // Ищем воду в радиусе 2: сухой узел, у которого нет мокрого соседа,
                // но который всё равно попадает в квад, иначе становится «шипом»
                // на склоне берега.
                for (int radius = 1; radius <= 2 && wet == 0; radius++) {
                    for (int dj = -radius; dj <= radius; dj++) {
                        for (int di = -radius; di <= radius; di++) {
                            if (Math.max(Math.abs(di), Math.abs(dj)) != radius) {
                                continue;
                            }
                            int ii = i + di;
                            int jj = j + dj;
                            if (!f.inside(ii, jj) || f.depth[f.index(ii, jj)] <= DRY_DEPTH) {
                                continue;
                            }
                            double weight = 1.0 / (1.0 + Math.hypot(di, dj));
                            sum += f.renderSurface(ii, jj) * weight;
                            weightSum += weight;
                            wet += 1;
                        }
                    }
                }
                if (wet == 0) {
                    height[k] = bed;
                } else {
                    // Плёнка у берега: чуть ниже уровня воды и всегда не выше земли,
                    // поэтому поверхность плавно съезжает на берег, а не рубится об него.
                    double target = sum / Math.max(1.0e-6, weightSum) - 0.015;
                    height[k] = Math.min(bed - 0.002, Math.min(bed + MENISCUS, target));
                    height[k] = Math.max(height[k], bed - 0.45);
                }
            }
        }
    }

    /**
     * Разглаживает высоту поверхности на мелководье.
     *
     * <p>У кромки глубина по клеткам скачет (0.05 м рядом с 0.5 м), а вместе с ней и
     * предел волны. Поверхность получается пилой - издалека это выглядит как частокол
     * белых зубцов на границе воды. Один проход по сетке убирает эту пилу, не трогая
     * глубокую воду, где волны должны остаться волнами.</p>
     */
    private void smoothShallows() {
        HeightField f = field;
        if (scratch.length < height.length) {
            return;
        }
        System.arraycopy(height, 0, scratch, 0, height.length);
        for (int j = 1; j < f.h - 1; j++) {
            for (int i = 1; i < f.w - 1; i++) {
                int k = f.index(i, j);
                if (f.depth[k] > 1.2) {
                    continue; // глубокая вода: волны не трогаем
                }
                double sum = 0;
                double weight = 0;
                for (int dj = -1; dj <= 1; dj++) {
                    for (int di = -1; di <= 1; di++) {
                        int kk = f.index(i + di, j + dj);
                        if (f.depth[kk] <= DRY_DEPTH) {
                            continue;
                        }
                        double w = (di == 0 && dj == 0) ? 2.0 : 1.0;
                        sum += scratch[kk] * w;
                        weight += w;
                    }
                }
                if (weight > 0) {
                    // Смешиваем не больше чем наполовину: кромка должна остаться кромкой.
                    height[k] = 0.45 * height[k] + 0.55 * (sum / weight);
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

    /** Пена и скорость по вершинам: то, из чего получаются волокна и белая вода. */
    private void computeSurfaceDetails() {
        HeightField f = field;
        for (int j = 0; j < f.h; j++) {
            for (int i = 0; i < f.w; i++) {
                int k = f.index(i, j);
                double wet = f.depth[k] > DRY_DEPTH ? 1.0 : 0.0;
                if (wet == 0) {
                    // Сухой узел у воды: это «плёнка» на берегу. Пены на нём нет -
                    // иначе кромка воды становится белой стеной, торчащей из склона.
                    foamAt[k] = 0;
                    speedAt[k] = 0;
                    flowUX[k] = 0;
                    flowUZ[k] = 0;
                    continue;
                }
                double speed = Math.hypot(f.flowU[k], f.flowV[k]);
                double x = f.worldX(i);
                double z = f.worldZ(j);
                // Пена: серверная (взрывы, берег) + собственные барашки от крутизны волны.
                double base = Math.min(1.0, f.foam[k] * 1.15);
                double steep = Math.max(0.0, Math.min(1.0, (1.0 - normalY[k]) * 9.0));
                // Барашек зависит от крутизны и от того, есть ли поток: стоячая вода
                // пенится только на самом гребне, бурная - сильнее.
                double whitecap = steep * (0.22 + 0.78 * Math.min(1.0, Math.max(0.0, speed * 0.8)));
                double froude = Math.max(0.0, Math.min(0.6,
                        (FluidConstants.froude(speed, Math.max(0.05, f.depth[k]),
                                FluidConstants.STANDARD_GRAVITY) - 0.8) * 0.55));
                // У самой кромки воды пены не бывает: там плёнка в сантиметр, ей нечем
                // пузыриться. Без этого ограничения кромка превращается в белую пилу.
                double shallowGate = Math.min(1.0, f.depth[k] / 0.28);
                whitecap *= shallowGate;
                froude *= shallowGate;
                // Пена у берега: у самой кромки глубины нет, и пена там превращается
                // в белую пилу по границе - поэтому гасим её на мелководье.
                double shore = shoreFoam(i, j) * 0.30 * Math.min(1.0, f.depth[k] / 0.30);
                double total = Math.min(1.0, base + whitecap + froude + shore);

                if (total > 0.01) {
                    // Волокна: пена вытягивается вдоль течения и течёт по времени.
                    double angle = Math.atan2(f.flowV[k], f.flowU[k]);
                    double along = Math.cos(angle) * x + Math.sin(angle) * z;
                    double across = -Math.sin(angle) * x + Math.cos(angle) * z;
                    double streak = Noise.streaks(along * 2.2, across * 2.2, time, 1.0);
                    double grain = Noise.fbm(x * 1.9 + 11, z * 1.9 + 7, 3, 53);
                    total *= 0.45 + 0.75 * streak * (0.55 + 0.45 * grain);
                }
                foamAt[k] = Math.min(1.0, total);
                speedAt[k] = speed;
                flowUX[k] = f.flowU[k];
                flowUZ[k] = f.flowV[k];
            }
        }
        blurFoam();
    }

    /** Один проход размытия пены по мокрым узлам: граница пятен перестаёт быть рваной. */
    private void blurFoam() {
        HeightField f = field;
        System.arraycopy(foamAt, 0, scratch, 0, Math.min(scratch.length, foamAt.length));
        for (int j = 1; j < f.h - 1; j++) {
            for (int i = 1; i < f.w - 1; i++) {
                int k = f.index(i, j);
                if (f.depth[k] <= DRY_DEPTH) {
                    continue;
                }
                double sum = 0;
                double weight = 0;
                for (int dj = -1; dj <= 1; dj++) {
                    for (int di = -1; di <= 1; di++) {
                        int kk = f.index(i + di, j + dj);
                        double w = (di == 0 && dj == 0) ? 2.0 : 1.0;
                        sum += scratch[kk] * w;
                        weight += w;
                    }
                }
                foamAt[k] = 0.35 * foamAt[k] + 0.65 * (sum / weight);
            }
        }
    }

    // ---------------------------------------------------------------- грани

    /**
     * Стенки на перепаде САМОЙ поверхности (порог водопада).
     *
     * <p>Обычная стенка строится там, где вода кончается и начинается суша. На пороге
     * вода есть с обеих сторон, просто ниже она на несколько метров ниже - и мешер
     * соединяет верх и низ наклонным «жёлобом». Настоящая вода так не течёт: она
     * срывается вниз отвесно. Поэтому там, где перепад между соседними вершинами
     * больше {@link #CLIFF_DROP}, достраиваем вертикальную стену.</p>
     */
    private void emitCliffs() {
        HeightField f = field;
        int sideColor;
        for (int j = 0; j < f.h; j++) {
            for (int i = 0; i < f.w; i++) {
                int k = f.index(i, j);
                if (f.depth[k] <= DRY_DEPTH) {
                    continue;
                }
                // Падающая вода светлее и голубее толщи: она перемешана с воздухом.
                sideColor = WaterPalette.fallColor(colorAt(k));
                double stillHere = f.bed[k] + f.depth[k];
                if (i + 1 < f.w) {
                    int kx = f.index(i + 1, j);
                    double stillThere = f.bed[kx] + f.depth[kx];
                    if (f.depth[kx] > DRY_DEPTH && Math.abs(stillHere - stillThere) > CLIFF_DROP) {
                        double x = f.worldX(i) + f.step * 0.5;
                        double z0 = f.worldZ(j);
                        double z1 = z0 + f.step;
                        double lo = Math.max(Math.min(stillHere, stillThere), hiOf(stillHere, stillThere) - CLIFF_CURTAIN);
                        double hi = hiOf(stillHere, stillThere);
                        // Струи: пена вдоль падения идёт полосами - живая вода, а не щит.
                        float fa = (float) (0.10 + 0.16 * Noise.fbm(x * 3.1, z0 * 1.2, 2, 91));
                        float fb = (float) (0.10 + 0.16 * Noise.fbm(x * 3.1, z1 * 1.2, 2, 91));
                        out.curtains++;
                        quadRaw(x, hi, z0, 1, 0, 0, sideColor, 2.8f, fa, 0, 0,
                                x, hi, z1, 1, 0, 0, sideColor, 2.8f, fb, 0, 0,
                                x, lo, z1, 1, 0, 0, sideColor, 2.2f, fb * 0.5f, 0, 0,
                                x, lo, z0, 1, 0, 0, sideColor, 2.2f, fa * 0.5f, 0, 0);
                    }
                }
                if (j + 1 < f.h) {
                    int kz = f.index(i, j + 1);
                    double stillThere = f.bed[kz] + f.depth[kz];
                    if (f.depth[kz] > DRY_DEPTH && Math.abs(stillHere - stillThere) > CLIFF_DROP) {
                        double z = f.worldZ(j) + f.step * 0.5;
                        double x0 = f.worldX(i);
                        double x1 = x0 + f.step;
                        double lo = Math.max(Math.min(stillHere, stillThere), hiOf(stillHere, stillThere) - CLIFF_CURTAIN);
                        double hi = hiOf(stillHere, stillThere);
                        float fa = (float) (0.10 + 0.16 * Noise.fbm(x0 * 1.2, z * 3.1, 2, 93));
                        float fb = (float) (0.10 + 0.16 * Noise.fbm(x1 * 1.2, z * 3.1, 2, 93));
                        out.curtains++;
                        quadRaw(x0, hi, z, 0, 0, 1, sideColor, 2.8f, fa, 0, 0,
                                x1, hi, z, 0, 0, 1, sideColor, 2.8f, fb, 0, 0,
                                x1, lo, z, 0, 0, 1, sideColor, 2.2f, fb * 0.5f, 0, 0,
                                x0, lo, z, 0, 0, 1, sideColor, 2.2f, fa * 0.5f, 0, 0);
                    }
                }
            }
        }
    }

    private static double hiOf(double a, double b) {
        return Math.max(a, b);
    }

    private void emitCells(boolean doubleSided) {
        HeightField f = field;
        for (int j = 0; j < f.h - 1; j++) {
            for (int i = 0; i < f.w - 1; i++) {
                int k00 = f.index(i, j);
                int k10 = k00 + 1;
                int k01 = k00 + f.w;
                int k11 = k01 + 1;
                // Квад рисуется, только если в нём есть настоящая вода. Чистая плёнка
                // у берега не нужна: поверхность и так сходится к земле.
                // Отладка: рисуем ВСЕ клетки, включая «сухие» - если чёрные пятна
                // исчезают, значит это дырки в меше, а не чужая отрисовка.
                boolean fillAll = System.getProperty("aquaflux.fillall") != null;
                if (!fillAll && Math.max(Math.max(f.depth[k00], f.depth[k10]),
                        Math.max(f.depth[k01], f.depth[k11])) <= 0.02) {
                    out.skippedDry++;
                    continue;
                }

                double x0 = f.worldX(i);
                double x1 = f.worldX(i + 1);
                double z0 = f.worldZ(j);
                double z1 = f.worldZ(j + 1);

                int c00 = colorAt(k00);
                int c10 = colorAt(k10);
                int c01 = colorAt(k01);
                int c11 = colorAt(k11);

                quad(x0, height[k00], z0, normalX[k00], normalY[k00], normalZ[k00], c00, k00,
                        x0, height[k01], z1, normalX[k01], normalY[k01], normalZ[k01], c01, k01,
                        x1, height[k11], z1, normalX[k11], normalY[k11], normalZ[k11], c11, k11,
                        x1, height[k10], z0, normalX[k10], normalY[k10], normalZ[k10], c10, k10);

                if (doubleSided) {
                    // Изнанка сдвинута вниз на 4 мм: без сдвига она лежит ровно на лицевой
                    // стороне и глубинный буфер «мигает», давая чёрные пятна на воде.
                    double under = -0.004;
                    quad(x1, height[k10] + under, z0, -normalX[k10], -normalY[k10], -normalZ[k10], c10, k10,
                            x1, height[k11] + under, z1, -normalX[k11], -normalY[k11], -normalZ[k11], c11, k11,
                            x0, height[k01] + under, z1, -normalX[k01], -normalY[k01], -normalZ[k01], c01, k01,
                            x0, height[k00] + under, z0, -normalX[k00], -normalY[k00], -normalZ[k00], c00, k00);
                }

                double top = Math.max(height[k00], Math.max(height[k10], Math.max(height[k01], height[k11])));
                // Верх стенки - СПОКОЙНЫЙ уровень воды без волны: иначе кромка стенки
                // повторяет пилу волн и издалека читается как частокол. Считаем только
                // по мокрым вершинам: у сухой «bed + 0» совсем другой масштаб.
                double stillSum = 0;
                int stillCount = 0;
                int[] corners = {k00, k10, k01, k11};
                for (int kc : corners) {
                    if (f.depth[kc] > EPS) {
                        stillSum += f.bed[kc] + f.depth[kc];
                        stillCount++;
                    }
                }
                if (stillCount > 0) {
                    top = Math.min(top, stillSum / stillCount + 0.03);
                }
                // Вода у грани: стенка опускается до её собственного дна, а не до берега.
                double wallBottom = Math.min(f.bed[k00], Math.min(f.bed[k10],
                        Math.min(f.bed[k01], f.bed[k11])));
                // Для стенки берём самую глубокую вершину: у кромки водопада глубина
                // по клеткам скачет, и по минимуму стенка получается «расчёской».
                double wetDepth = Math.max(f.depth[k00], Math.max(f.depth[k10],
                        Math.max(f.depth[k01], f.depth[k11])));
                double foamMax = Math.max(foamAt[k00], Math.max(foamAt[k10], Math.max(foamAt[k01], foamAt[k11])));
                int sideColor = WaterPalette.sideColor(c00);
                if (drawCurtains) {
                    curtainIfNeeded(i + 1, j, x1, x1, z0, z1, top, wallBottom, wetDepth, sideColor, 0, foamMax);
                    curtainIfNeeded(i, j, x0, x0, z0, z1, top, wallBottom, wetDepth, sideColor, 1, foamMax);
                    curtainIfNeeded(i, j + 1, x0, x1, z1, z1, top, wallBottom, wetDepth, sideColor, 2, foamMax);
                    curtainIfNeeded(i, j, x0, x1, z0, z0, top, wallBottom, wetDepth, sideColor, 3, foamMax);
                }
            }
        }
    }

    private int colorAt(int k) {
        // Одно NaN-значение в поле красит целую клетку в чёрный: не пускаем.
        double depth = safe(field.depth[k]);
        double foam = safe(foamAt[k]);
        double speed = safe(speedAt[k]);
        int color = WaterPalette.color(depth, normalX[k], normalY[k] + 0.35, normalZ[k],
                foam, 1.0, speed, precision);
        if (field.depth[k] <= EPS) {
            // Тонкая плёнка на берегу почти прозрачная: она нужна только чтобы
            // поверхность прилипала к земле, а не обрывалась.
            int alpha = Math.min(56, (color >>> 24) & 0xFF);
            color = (color & 0x00FFFFFF) | (alpha << 24);
        }
        return color;
    }

    private void curtainIfNeeded(int ni, int nj, double ax, double bx, double az, double bz,
                                 double top, double wallBottom, double wetDepth,
                                 int color, int side, double foam) {
        HeightField f = field;
        if (!f.inside(ni, nj)) {
            curtainRejects[1]++;
            return;
        }
        int nk = f.index(ni, nj);
        if (f.depth[nk] > DRY_DEPTH) {
            curtainRejects[2]++;
            return;
        }
        if (wetDepth < CURTAIN_MIN_DEPTH) {
            curtainRejects[3]++;
            return;
        }
        double ground = f.bed[nk];
        if (ground >= top - 0.06) {
            curtainRejects[4]++;
            return; // берег не ниже воды: стенки не видно, её закрывает земля
        }
        double drop = top - ground;
        if (drop < CURTAIN_MIN_DROP) {
            curtainRejects[5]++;
            return; // пологий берег: вода сходит на песок плёнкой, стенка не нужна
        }
        // Стенка - это вода, свисающая от поверхности вниз. Снизу её обрезает земля
        // соседней колонки: иначе полигоны уходят внутрь рельефа и торчат из него
        // треугольными «парусами». Если земля ниже дна воды - вода свисает по-настоящему.
        double bottom = Math.max(wallBottom, ground - 0.02);
        // Над обрывом (водопад) вода не висит простынёй до самого дна: она срывается
        // и распадается на капли. Стенка закрывает только кромку.
        double limit = drop > 2.0 ? CLIFF_CURTAIN : MAX_CURTAIN;
        double b = Math.max(bottom, top - limit) - 0.01;
        if (top - b < 0.3) {
            curtainRejects[6]++;
            return;
        }
        curtainRejects[0]++;
        color = WaterPalette.sideColor(color);
        // Пена на стенке - только половина от поверхностной: иначе кромка воды
        // становится белой полосой, которая перекрывает цвет.
        float topFoam = (float) Math.min(1.0, foam * 0.45 + 0.05);
        out.curtains++;
        switch (side) {
            case 0 -> quadRaw(bx, top, az, 1, 0, 0, color, 0.30f, topFoam, 0, 0,
                    bx, top, bz, 1, 0, 0, color, 0.30f, topFoam, 0, 0,
                    bx, b, bz, 1, 0, 0, color, 0.05f, topFoam * 0.25f, 0, 0,
                    bx, b, az, 1, 0, 0, color, 0.05f, topFoam * 0.25f, 0, 0);
            case 1 -> quadRaw(ax, top, bz, -1, 0, 0, color, 0.30f, topFoam, 0, 0,
                    ax, top, az, -1, 0, 0, color, 0.30f, topFoam, 0, 0,
                    ax, b, az, -1, 0, 0, color, 0.05f, topFoam * 0.25f, 0, 0,
                    ax, b, bz, -1, 0, 0, color, 0.05f, topFoam * 0.25f, 0, 0);
            case 2 -> quadRaw(ax, top, bz, 0, 0, 1, color, 0.30f, topFoam, 0, 0,
                    bx, top, bz, 0, 0, 1, color, 0.30f, topFoam, 0, 0,
                    bx, b, bz, 0, 0, 1, color, 0.05f, topFoam * 0.25f, 0, 0,
                    ax, b, bz, 0, 0, 1, color, 0.05f, topFoam * 0.25f, 0, 0);
            default -> quadRaw(bx, top, az, 0, 0, -1, color, 0.30f, topFoam, 0, 0,
                    ax, top, az, 0, 0, -1, color, 0.30f, topFoam, 0, 0,
                    ax, b, az, 0, 0, -1, color, 0.05f, topFoam * 0.25f, 0, 0,
                    bx, b, az, 0, 0, -1, color, 0.05f, topFoam * 0.25f, 0, 0);
        }
    }

    private static double safe(double v) {
        return Double.isFinite(v) && v > -1.0e6 ? v : 0.0;
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
                if (f.depth[f.index(ii, jj)] <= DRY_DEPTH) {
                    dry++;
                }
            }
        }
        return total == 0 ? 0 : (double) dry / total;
    }

    // ---------------------------------------------------------------- запись квада

    /** Квад поверхности: значения берутся по индексам узлов. */
    private void quad(double x0, double y0, double z0, double nx0, double ny0, double nz0, int c0, int k0,
                      double x1, double y1, double z1, double nx1, double ny1, double nz1, int c1, int k1,
                      double x2, double y2, double z2, double nx2, double ny2, double nz2, int c2, int k2,
                      double x3, double y3, double z3, double nx3, double ny3, double nz3, int c3, int k3) {
        writeQuad(x0, y0, z0, nx0, ny0, nz0, c0, field.depth[k0], foamAt[k0], flowUX[k0], flowUZ[k0],
                x1, y1, z1, nx1, ny1, nz1, c1, field.depth[k1], foamAt[k1], flowUX[k1], flowUZ[k1],
                x2, y2, z2, nx2, ny2, nz2, c2, field.depth[k2], foamAt[k2], flowUX[k2], flowUZ[k2],
                x3, y3, z3, nx3, ny3, nz3, c3, field.depth[k3], foamAt[k3], flowUX[k3], flowUZ[k3]);
    }

    /** Квад стенки: все значения заданы явно, узлов у него нет. */
    private void quadRaw(double x0, double y0, double z0, double nx0, double ny0, double nz0, int c0,
                         float d0, float f0, float u0, float v0,
                         double x1, double y1, double z1, double nx1, double ny1, double nz1, int c1,
                         float d1, float f1, float u1, float v1,
                         double x2, double y2, double z2, double nx2, double ny2, double nz2, int c2,
                         float d2, float f2, float u2, float v2,
                         double x3, double y3, double z3, double nx3, double ny3, double nz3, int c3,
                         float d3, float f3, float u3, float v3) {
        writeQuad(x0, y0, z0, nx0, ny0, nz0, c0, d0, f0, u0, v0,
                x1, y1, z1, nx1, ny1, nz1, c1, d1, f1, u1, v1,
                x2, y2, z2, nx2, ny2, nz2, c2, d2, f2, u2, v2,
                x3, y3, z3, nx3, ny3, nz3, c3, d3, f3, u3, v3);
    }

    private void writeQuad(double x0, double y0, double z0, double nx0, double ny0, double nz0, int c0,
                           double d0, double f0, double fu0, double fv0,
                           double x1, double y1, double z1, double nx1, double ny1, double nz1, int c1,
                           double d1, double f1, double fu1, double fv1,
                           double x2, double y2, double z2, double nx2, double ny2, double nz2, int c2,
                           double d2, double f2, double fu2, double fv2,
                           double x3, double y3, double z3, double nx3, double ny3, double nz3, int c3,
                           double d3, double f3, double fu3, double fv3) {
        Output o = out;
        if (!o.hasRoom()) {
            return;
        }
        if (!(Double.isFinite(x0) && Double.isFinite(y0) && Double.isFinite(z0)
                && Double.isFinite(x1) && Double.isFinite(y1) && Double.isFinite(z1)
                && Double.isFinite(x2) && Double.isFinite(y2) && Double.isFinite(z2)
                && Double.isFinite(x3) && Double.isFinite(y3) && Double.isFinite(z3))) {
            o.nanQuads++;
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
        o.foam[ci] = (float) f0;
        o.foam[ci + 1] = (float) f1;
        o.foam[ci + 2] = (float) f2;
        o.foam[ci + 3] = (float) f3;
        int fi = q * 8;
        o.flow[fi] = (float) fu0;
        o.flow[fi + 1] = (float) fv0;
        o.flow[fi + 2] = (float) fu1;
        o.flow[fi + 3] = (float) fv1;
        o.flow[fi + 4] = (float) fu2;
        o.flow[fi + 5] = (float) fv2;
        o.flow[fi + 6] = (float) fu3;
        o.flow[fi + 7] = (float) fv3;
    }
}
