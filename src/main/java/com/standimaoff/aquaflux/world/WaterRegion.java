package com.standimaoff.aquaflux.world;

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
 * {@link WaterGrid}.
 *
 * <p>Регион сам умеет:</p>
 * <ul>
 *   <li>сэмплировать пол (верх твёрдого блока) по сетке;</li>
 *   <li>восстанавливать массу из уже стоящих в мире блоков физической воды;</li>
 *   <li>переносить глубины обратно в блоки, кодируя верхний блок через {@code level}.</li>
 * </ul>
 */
public final class WaterRegion {

    public final int rx;
    public final int rz;
    public final int regionSize;
    public final double cellSize;
    public final int cellsPerSide;
    public final int cellsPerBlock;
    public final WaterGrid grid;

    /** Верх последнего поставленного блока + 1, чтобы убирать хвосты при отливе. */
    private final int[] lastTop;

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
        this.lastTop = new int[regionSize * regionSize];
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

    /** Абсолютная высота верхней грани твёрдого блока (первый воздух над землёй). */
    public static int bedHeight(ServerLevel level, int x, int z) {
        int top = level.getHeight(net.minecraft.world.level.levelgen.Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z);
        int min = level.getMinBuildHeight();
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        for (int y = top - 1; y > min; y--) {
            p.set(x, y, z);
            BlockState s = level.getBlockState(p);
            if (s.isAir()) {
                continue;
            }
            FluidState fs = s.getFluidState();
            if (!fs.isEmpty()) {
                continue; // вода и лава не считаются дном
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
                grid.setGround(i, j, bedHeight(level, (int) Math.floor(wx), (int) Math.floor(wz)));
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
                grid.setGround(i, j, bedHeight(level, wx, wz));
            }
        }
    }

    // ---------------------------------------------------------------- восстановление массы

    /** Собрать глубину из блоков физической воды, уже стоящих в мире (загрузка мира). */
    public void scanWater(ServerLevel level) {
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        int ox = originX();
        int oz = originZ();
        int maxStack = 64;
        for (int bz = 0; bz < regionSize; bz++) {
            for (int bx = 0; bx < regionSize; bx++) {
                int wx = ox + bx;
                int wz = oz + bz;
                int bed = bedHeight(level, wx, wz);
                p.set(wx, bed, wz);
                if (!isOurs(level.getBlockState(p))) {
                    continue;
                }
                int stack = 0;
                double fill = 1.0;
                for (int y = bed; y < bed + maxStack; y++) {
                    p.set(wx, y, wz);
                    BlockState s = level.getBlockState(p);
                    if (!isOurs(s)) {
                        break;
                    }
                    double f = fillOf(s);
                    stack++;
                    fill = f;
                }
                if (stack > 0) {
                    double depth = (stack - 1) + fill;
                    int cpb = cellsPerBlock;
                    for (int cj = 0; cj < cpb; cj++) {
                        for (int ci = 0; ci < cpb; ci++) {
                            int i = bx * cpb + ci;
                            int j = bz * cpb + cj;
                            if (grid.inside(i, j)) {
                                grid.addVolume(i, j, depth * cellSize * cellSize);
                            }
                        }
                    }
                }
            }
        }
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

    /** Перенести глубины в блоки. Возвращает число изменённых блоков. */
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
                if (depth < 0.05) {
                    top = bed;
                    fracLevel = -1;
                } else {
                    int whole = (int) Math.floor(depth + 1.0e-6);
                    double frac = depth - whole;
                    int lvl = (int) Math.round((1.0 - frac) * 8.0);
                    if (lvl > 7) {
                        lvl = 7;
                    }
                    if (frac < 0.12) {
                        top = bed + whole;
                        fracLevel = -1;
                    } else {
                        top = bed + whole;
                        fracLevel = lvl;
                    }
                }

                int hi = Math.max(top, lastTop[idx]);
                int lo = bed;
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
                            level.setBlock(p, Fluids.EMPTY.defaultFluidState().createLegacyBlock(), 2);
                            changed++;
                        }
                    } else if (cur != want) {
                        level.setBlock(p, want, 2);
                        changed++;
                    }
                }
                lastTop[idx] = fracLevel >= 0 ? top + 1 : top;
            }
        }
        return changed;
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
}
