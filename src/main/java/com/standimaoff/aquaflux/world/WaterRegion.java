package com.standimaoff.aquaflux.world;

import com.standimaoff.aquaflux.core.ParcelField;
import com.standimaoff.aquaflux.core.Precision;
import com.standimaoff.aquaflux.core.WaterGrid;
import com.standimaoff.aquaflux.registry.ModBlocks;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;

/**
 * Один регион симуляции: квадрат {@code regionSize} блоков, внутри - сетка ячеек
 * {@link WaterGrid} и слой капель {@link ParcelField}.
 *
 * <p>Регион сам умеет:</p>
 * <ul>
 *   <li>сэмплировать пол по сетке <b>по колонкам</b>: если под водой есть нависающий камень,
 *       вода встанет на него, а не «провалится» на самое дно;</li>
 *   <li>восстанавливать массу из уже стоящих в мире блоков физической воды;</li>
 *   <li>переносить глубины обратно в блоки, кодируя верхний блок через {@code level}.</li>
 * </ul>
 *
 * <p><b>Колонки вместо карты высот.</b> Раньше пол сэмплировался один раз сверху вниз до
 * первого твёрдого блока - и пещеры, мосты и многоуровневые водоёмы не работали. Теперь при
 * создании региона для каждой колонки собирается профиль «где заканчивается вода»: сканируются
 * все блоки от верха мира вниз, и запоминаются участки воды (несколько ярусов). Регион хранит
 * только активный ярус (самый верхний, на который влияет игрок) и спящие, которые
 * восстанавливаются, когда верхний ярус осушается.</p>
 */
public final class WaterRegion {

    /** Максимум ярусов воды в одной колонке. */
    private static final int MAX_LAYERS = 12;

    /**
     * Ярус воды в колонке: пол (верх твёрдого блока) и глубина.
     */
    public static final class Layer {
        public int bed;
        public double volume;

        public Layer() {
        }

        public Layer(int bed, double volume) {
            this.bed = bed;
            this.volume = volume;
        }
    }

    public final int rx;
    public final int rz;
    public final int regionSize;
    public final double cellSize;
    public final int cellsPerSide;
    public final int cellsPerBlock;
    public final WaterGrid grid;
    /** Капли, брызги и пена в воздухе - «много маленьких тел» над этим регионом. */
    public final ParcelField parcels;

    /** Верх последнего поставленного блока + 1, чтобы убирать хвосты при отливе. */
    private final int[] lastTop;
    /** Сколько блоков воды было в колонке на прошлой записи - чтобы понять, растёт вода или уходит. */
    private final int[] lastCount;
    /** Спящие ярусы воды под активным: вода на нависающих блоках и пещерные озёра. */
    private final Layer[][] sleeping;
    private final int[] sleepingCount;

    public boolean groundDirty = true;
    public int calmTicks;
    public double pendingDt;
    public long lastTick;

    public WaterRegion(int rx, int rz, int regionSize, double cellSize, Precision precision) {
        this.rx = rx;
        this.rz = rz;
        this.regionSize = regionSize;
        this.cellSize = cellSize;
        this.cellsPerSide = (int) Math.round(regionSize / cellSize);
        this.cellsPerBlock = Math.max(1, (int) Math.round(1.0 / cellSize));
        this.grid = new WaterGrid(cellsPerSide, cellsPerSide, cellSize, precision);
        // Границы мира, а не 0..320: иначе капли ниже нуля умирают в первом же шаге.
        this.parcels = new ParcelField(ParcelField.DEFAULT_CAPACITY, -320, 640);
        this.lastTop = new int[regionSize * regionSize];
        this.lastCount = new int[regionSize * regionSize];
        this.sleeping = new Layer[regionSize * regionSize][];
        this.sleepingCount = new int[regionSize * regionSize];
        java.util.Arrays.fill(lastTop, -1);
    }

    public long key() {
        return key(rx, rz);
    }

    public static long key(int rx, int rz) {
        return ((long) rx << 32) ^ (rz & 0xFFFFFFFFL);
    }

    public int originX() {
        return rx * regionSize;
    }

    public int originZ() {
        return rz * regionSize;
    }

    public boolean contains(int x, int z) {
        int ox = originX();
        int oz = originZ();
        return x >= ox && z >= oz && x < ox + regionSize && z < oz + regionSize;
    }

    // ---------------------------------------------------------------- пол

    /**
     * Пол колонки - верхняя грань первого твёрдого блока под водой, с учётом нависаний.
     *
     * <p>Сканируем сверху вниз, но останавливаемся на первом блоке, который держит воду:
     * это либо твёрдый блок под поверхностью, либо вода, стоящая на твёрдом блоке.
     * Воздух, листва и высокая трава не держат воду и пропускаются.</p>
     */
    public static int bedHeight(ServerLevel level, int x, int z) {
        return bedHeight(level, x, z, true);
    }

    /**
     * @param useWaterAsFloor считать ли воду полом: при первом создании региона вода -
     *                        это ещё не физическая вода, а ванильная, которую трогать нельзя
     */
    public static int bedHeight(ServerLevel level, int x, int z, boolean useWaterAsFloor) {
        int min = level.getMinBuildHeight();
        int top = level.getHeight(net.minecraft.world.level.levelgen.Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z);
        top = Math.min(level.getMaxBuildHeight() - 1, top);
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        for (int y = top; y > min; y--) {
            p.set(x, y, z);
            BlockState s = level.getBlockState(p);
            if (s.isAir() || !s.getFluidState().isEmpty() && !useWaterAsFloor) {
                continue;
            }
            if (s.blocksMotion() || s.isSolid()) {
                return y + 1;
            }
        }
        return min;
    }

    /** Полная выборка пола по всем ячейкам региона. */
    public void sampleAll(ServerLevel level) {
        int ox = originX();
        int oz = originZ();
        for (int j = 0; j < cellsPerSide; j++) {
            double wz = oz + (j + 0.5) * cellSize;
            for (int i = 0; i < cellsPerSide; i++) {
                double wx = ox + (i + 0.5) * cellSize;
                grid.setGround(i, j, bedHeight(level, (int) Math.floor(wx), (int) Math.floor(wz), true));
            }
        }
        groundDirty = false;
    }

    /** Обновить пол только вокруг изменившегося блока. */
    public void refreshAround(ServerLevel level, int bx, int bz, int pad) {
        int ox = originX();
        int oz = originZ();
        int i0 = Math.max(0, (int) Math.floor((bx - pad - ox) / cellSize));
        int i1 = Math.min(cellsPerSide - 1, (int) Math.floor((bx + pad - ox) / cellSize));
        int j0 = Math.max(0, (int) Math.floor((bz - pad - oz) / cellSize));
        int j1 = Math.min(cellsPerSide - 1, (int) Math.floor((bz + pad - oz) / cellSize));
        for (int j = j0; j <= j1; j++) {
            for (int i = i0; i <= i1; i++) {
                int wx = (int) Math.floor(ox + (i + 0.5) * cellSize);
                int wz = (int) Math.floor(oz + (j + 0.5) * cellSize);
                int bed = bedHeight(level, wx, wz, true);
                if (Math.abs(bed - grid.ground(i, j)) > 1.0e-6) {
                    // Блок поставили/сломали. Глубину не трогаем: это и есть сохранение массы.
                    // Поставили блок в воду - пол поднялся, вода вытесняется вверх и растекается.
                    // Сломали дно под водой - вода проседает вместе с полом, объём тот же.
                    grid.setGround(i, j, bed);
                }
            }
        }
    }

    // ---------------------------------------------------------------- восстановление массы

    /**
     * Собрать глубину из блоков физической воды, уже стоящих в мире (загрузка мира).
     *
     * <p>Всё, что находится ниже верхнего слоя воды, сохраняется как спящий ярус: если игрок
     * вычерпает верхнюю воду, нижние уровни вернутся в симуляцию, а не исчезнут.</p>
     */
    public void scanWater(ServerLevel level) {
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        int ox = originX();
        int oz = originZ();
        for (int bz = 0; bz < regionSize; bz++) {
            for (int bx = 0; bx < regionSize; bx++) {
                int wx = ox + bx;
                int wz = oz + bz;
                int idx = bx + regionSize * bz;
                int top = level.getHeight(net.minecraft.world.level.levelgen.Heightmap.Types.MOTION_BLOCKING, wx, wz);
                int min = level.getMinBuildHeight();
                int y = top - 1;
                int found = 0;
                Layer[] layers = null;
                while (y >= min && found < MAX_LAYERS) {
                    p.set(wx, y, wz);
                    BlockState s = level.getBlockState(p);
                    if (!isOurs(s)) {
                        y--;
                        continue;
                    }
                    int runTop = y;
                    int runBottom = y;
                    double volume = 0;
                    while (runBottom - 1 >= min) {
                        p.set(wx, runBottom - 1, wz);
                        BlockState below = level.getBlockState(p);
                        if (!isOurs(below)) {
                            break;
                        }
                        runBottom--;
                    }
                    for (int by = runBottom; by <= runTop; by++) {
                        p.set(wx, by, wz);
                        volume += fillOf(level.getBlockState(p));
                    }
                    if (layers == null) {
                        layers = new Layer[MAX_LAYERS];
                    }
                    layers[found++] = new Layer(runBottom + 1, volume);
                    y = runBottom - 1;
                }
                if (found == 0) {
                    continue;
                }
                // Верхний ярус - активный: он и заливается в сетку.
                Layer active = layers[0];
                double depth = active.volume / (cellsPerBlock * cellsPerBlock);
                int cpb = cellsPerBlock;
                for (int cj = 0; cj < cpb; cj++) {
                    for (int ci = 0; ci < cpb; ci++) {
                        int i = bx * cpb + ci;
                        int j = bz * cpb + cj;
                        if (grid.inside(i, j)) {
                            grid.setGround(i, j, active.bed);
                            grid.addVolume(i, j, depth * cellSize * cellSize);
                        }
                    }
                }
                if (found > 1) {
                    Layer[] rest = new Layer[found - 1];
                    System.arraycopy(layers, 1, rest, 0, found - 1);
                    sleeping[idx] = rest;
                    sleepingCount[idx] = rest.length;
                }
            }
        }
    }

    /**
     * Вернуть в симуляцию спящий ярус под осушившейся колонкой. Возвращает объём, м³.
     *
     * <p>Так работает вода на мостах и в пещерах: она не испаряется, когда верхний ярус
     * утекает, а опускается на этаж ниже.</p>
     */
    public double wakeSleeping(int bx, int bz) {
        if (bx < 0 || bz < 0 || bx >= regionSize || bz >= regionSize) {
            return 0;
        }
        int idx = bx + regionSize * bz;
        Layer[] layers = sleeping[idx];
        if (layers == null || sleepingCount[idx] <= 0) {
            return 0;
        }
        Layer next = layers[0];
        Layer[] rest = new Layer[sleepingCount[idx] - 1];
        System.arraycopy(layers, 1, rest, 0, rest.length);
        sleeping[idx] = rest.length == 0 ? null : rest;
        sleepingCount[idx] = rest.length;

        int cpb = cellsPerBlock;
        double per = next.volume / (cpb * cpb);
        for (int cj = 0; cj < cpb; cj++) {
            for (int ci = 0; ci < cpb; ci++) {
                int i = bx * cpb + ci;
                int j = bz * cpb + cj;
                if (grid.inside(i, j)) {
                    grid.setGround(i, j, next.bed);
                    grid.addVolume(i, j, per * cellSize * cellSize);
                }
            }
        }
        return next.volume;
    }

    /** Есть ли под колонкой спящая вода. */
    public boolean hasSleeping(int bx, int bz) {
        if (bx < 0 || bz < 0 || bx >= regionSize || bz >= regionSize) {
            return false;
        }
        return sleepingCount[bx + regionSize * bz] > 0;
    }

    // ---------------------------------------------------------------- запись в мир

    /** Сколько воды стоит в блок-колонке (средняя глубина по ячейкам). */
    public double columnDepth(int bx, int bz) {
        int cpb = cellsPerBlock;
        double sum = 0;
        int n = 0;
        for (int cj = 0; cj < cpb; cj++) {
            for (int ci = 0; ci < cpb; ci++) {
                int i = bx * cpb + ci;
                int j = bz * cpb + cj;
                if (grid.inside(i, j)) {
                    sum += grid.depth(i, j);
                    n++;
                }
            }
        }
        return n == 0 ? 0 : sum / n;
    }

    public double columnBed(int bx, int bz) {
        int cpb = cellsPerBlock;
        double max = -1e9;
        for (int cj = 0; cj < cpb; cj++) {
            for (int ci = 0; ci < cpb; ci++) {
                int i = bx * cpb + ci;
                int j = bz * cpb + cj;
                if (grid.inside(i, j)) {
                    max = Math.max(max, grid.ground(i, j));
                }
            }
        }
        return max == -1e9 ? 0 : max;
    }

    /**
     * Перенести глубины в блоки. Возвращает число изменённых блоков.
     *
     * <p>Кодируем глубину целыми блоками плюс верхний блок с {@code level}. Дробная часть
     * меньше восьмой не ставит блок-«пенку»: иначе поверхность выглядела бы ступенями
     * из воздуха, а рендер всё равно берёт высоту из мешера.</p>
     */
    public int apply(ServerLevel level) {
        int changed = 0;
        int ox = originX();
        int oz = originZ();
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        BlockState full = ModBlocks.PHYSICAL_WATER.get().defaultBlockState();
        for (int bz = 0; bz < regionSize; bz++) {
            for (int bx = 0; bx < regionSize; bx++) {
                int idx = bx + regionSize * bz;
                double depth = columnDepth(bx, bz);
                int bed = (int) Math.round(columnBed(bx, bz));
                int wx = ox + bx;
                int wz = oz + bz;

                int top;
                int fracLevel;
                // Ванильная жидкость невидима (альфа 0), но ВСЁ РАВНО пишет глубину:
                // её верхняя грань проходит на (8-level)/9 выше низа блока. Если она
                // окажется выше нашего гладкого меша, она закроет воду - и на кадре
                // появляются чёрные рваные пятна неосвещённого дна. Поэтому блоки
                // ставим так, чтобы их верх всегда был ниже поверхности меша минимум
                // на 0.12 блока, а кромку всегда рисует только меш.
                double surface = bed + depth;
                if (depth < 0.12) {
                    // Тонкая плёнка: блоков не ставим вообще, её рисует меш.
                    top = bed - 1;
                    fracLevel = -1;
                } else {
                    top = Math.max(bed, (int) Math.floor(surface - 0.12));
                    fracLevel = 7; // верх блок-«пенка»: ванильная грань на +0.111
                }

                // Чистим и то, что стояло раньше, и то, что нужно сейчас.
                int hi = Math.max(top, lastTop[idx]);
                int lo = Math.min(bed, lastTop[idx] < 0 ? bed : bed);
                for (int y = lo; y <= hi + 1; y++) {
                    p.set(wx, y, wz);
                    BlockState cur = level.getBlockState(p);
                    BlockState want;
                    if (y < top) {
                        want = full;
                    } else if (y == top && fracLevel >= 0) {
                        want = full.setValue(LiquidBlock.LEVEL, fracLevel);
                    } else {
                        want = null;
                    }
                    if (want == null) {
                        if (isOurs(cur)) {
                            // Флаг 3, а не 2: флаг «только клиентам» не пересчитывает свет, и вода
                        // остаётся с нулевой лайтмапой - чёрные пятна на поверхности и на стенках.
                        level.setBlock(p, Fluids.EMPTY.defaultFluidState().createLegacyBlock(), 3);
                            changed++;
                        }
                    } else if (cur != want) {
                        level.setBlock(p, want, 3);
                        // Флаг 3 обновляет свет «в общем порядке», но для только что
                        // выкопанной ямы этого мало: дно остаётся с нулевой лайтмапой и
                        // рисуется чёрным. Просим световой движок пересчитать клетку.
                        level.getChunkSource().getLightEngine().checkBlock(p.immutable());
                        changed++;
                    }
                }
                int count = top < bed ? 0 : top - bed + (fracLevel >= 0 ? 1 : 0);
                lastCount[idx] = Math.max(0, count);
                lastTop[idx] = top < bed ? -1 : (fracLevel >= 0 ? top + 1 : top);
            }
        }
        return changed;
    }

    /** Сколько блоков воды регион держит в мире сейчас (по последней записи). */
    public long blockWaterCount() {
        long sum = 0;
        for (int c : lastCount) {
            sum += c;
        }
        return sum;
    }

    public static boolean isOurs(BlockState state) {
        return state.getBlock() == ModBlocks.PHYSICAL_WATER.get();
    }

    /** Доля заполнения блока: level 0 - полный, 7 - одна восьмая. */
    public static double fillOf(BlockState state) {
        if (!isOurs(state)) {
            return 0;
        }
        int lvl = state.getValue(LiquidBlock.LEVEL);
        return 1.0 - lvl / 8.0;
    }

    /** Вода ли это вообще (наша или ванильная) - для восстановления после перезапуска. */
    public static boolean isWaterBlock(ServerLevel level, BlockPos pos) {
        BlockState state = level.getBlockState(pos);
        if (isOurs(state)) {
            return true;
        }
        FluidState fluid = state.getFluidState();
        return !fluid.isEmpty() && (fluid.is(Fluids.WATER) || fluid.is(Fluids.FLOWING_WATER));
    }
}
