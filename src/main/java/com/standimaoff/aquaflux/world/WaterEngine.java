package com.standimaoff.aquaflux.world;

import com.standimaoff.aquaflux.AquafluxConfig;
import com.standimaoff.aquaflux.core.BoundarySource;
import com.standimaoff.aquaflux.core.Precision;
import com.standimaoff.aquaflux.core.SolverSettings;
import com.standimaoff.aquaflux.core.WaterStats;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.state.BlockState;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Движок физической воды для одного измерения.
 *
 * <p>Бюджет: за тик считается не больше {@code regionsPerTick} регионов, блоки обновляются
 * максимум в одном регионе. Регионы, в которых вода успокоилась, засыпают и не тратят время.
 * Активность привязана к игрокам: за пределами радиуса ничего не считается.</p>
 */
public final class WaterEngine {

    private static final Map<ServerLevel, WaterEngine> ENGINES = new HashMap<>();
    private static final ThreadLocal<Boolean> APPLYING = ThreadLocal.withInitial(() -> Boolean.FALSE);

    private final ServerLevel level;
    private final Map<Long, WaterRegion> regions = new HashMap<>();
    private final ArrayDeque<BlockPos> groundQueue = new ArrayDeque<>();
    private final List<WaterRegion> active = new ArrayList<>();
    private int cursor;
    private int applyCursor;

    private WaterEngine(ServerLevel level) {
        this.level = level;
    }

    public static WaterEngine of(ServerLevel level) {
        return ENGINES.computeIfAbsent(level, WaterEngine::new);
    }

    public static void unload(ServerLevel level) {
        ENGINES.remove(level);
    }

    public static boolean isApplying() {
        return APPLYING.get();
    }

    // ---------------------------------------------------------------- события мира

    public static void onBlockPlaced(net.minecraft.world.level.Level level, BlockPos pos,
                                     BlockState oldState, BlockState newState) {
        if (APPLYING.get() || !(level instanceof ServerLevel server)) {
            return;
        }
        WaterEngine engine = of(server);
        boolean wasOurs = WaterRegion.isOurs(oldState);
        boolean nowOurs = WaterRegion.isOurs(newState);
        if (nowOurs && !wasOurs) {
            engine.addBlockVolume(pos);
        }
        engine.markGround(pos);
    }

    public static void onBlockRemoved(net.minecraft.world.level.Level level, BlockPos pos,
                                      BlockState oldState, BlockState newState) {
        if (APPLYING.get() || !(level instanceof ServerLevel server)) {
            return;
        }
        WaterEngine engine = of(server);
        if (WaterRegion.isOurs(oldState) && !WaterRegion.isOurs(newState)) {
            engine.removeBlockVolume(pos);
        }
        engine.markGround(pos);
    }

    /** Любое изменение рельефа рядом (копка, взрыв, постройка) - пересэмплировать пол. */
    public static void markGroundChanged(net.minecraft.world.level.LevelAccessor level, BlockPos pos) {
        if (APPLYING.get() || !(level instanceof ServerLevel server)) {
            return;
        }
        of(server).markGround(pos);
    }

    private void markGround(BlockPos pos) {
        if (groundQueue.size() > 2048) {
            groundQueue.poll();
        }
        groundQueue.add(pos.immutable());
        // регионы, которых ещё нет, создадутся при следующем тике рядом с игроком
        for (WaterRegion r : overlapping(pos)) {
            r.groundDirty = true;
        }
    }

    private List<WaterRegion> overlapping(BlockPos pos) {
        List<WaterRegion> out = new ArrayList<>(4);
        int size = AquafluxConfig.regionSize();
        int rx0 = Math.floorDiv(pos.getX() - 1, size);
        int rx1 = Math.floorDiv(pos.getX() + 1, size);
        int rz0 = Math.floorDiv(pos.getZ() - 1, size);
        int rz1 = Math.floorDiv(pos.getZ() + 1, size);
        for (int rz = rz0; rz <= rz1; rz++) {
            for (int rx = rx0; rx <= rx1; rx++) {
                WaterRegion r = regions.get(WaterRegion.key(rx, rz));
                if (r != null) {
                    out.add(r);
                }
            }
        }
        return out;
    }

    // ---------------------------------------------------------------- масса от блоков

    private void addBlockVolume(BlockPos pos) {
        WaterRegion r = regionAt(pos.getX(), pos.getZ());
        if (r == null) {
            return;
        }
        double lx = pos.getX() + 0.5 - r.originX();
        double lz = pos.getZ() + 0.5 - r.originZ();
        int cpb = r.cellsPerBlock;
        // 1 блок = 1 м^3, распределяем по ячейкам колонки
        double each = 1.0 / (cpb * cpb);
        for (int cj = 0; cj < cpb; cj++) {
            for (int ci = 0; ci < cpb; ci++) {
                int i = (int) Math.floor(lx / r.cellSize) - cpb / 2 + ci;
                int j = (int) Math.floor(lz / r.cellSize) - cpb / 2 + cj;
                if (r.grid.inside(i, j)) {
                    r.grid.addVolume(i, j, each);
                }
            }
        }
        r.lastTick = level.getGameTime();
    }

    private void removeBlockVolume(BlockPos pos) {
        WaterRegion r = regionAt(pos.getX(), pos.getZ());
        if (r == null) {
            return;
        }
        int cpb = r.cellsPerBlock;
        int i0 = (int) Math.floor((pos.getX() + 0.5 - r.originX()) / r.cellSize) - cpb / 2;
        int j0 = (int) Math.floor((pos.getZ() + 0.5 - r.originZ()) / r.cellSize) - cpb / 2;
        for (int cj = 0; cj < cpb; cj++) {
            for (int ci = 0; ci < cpb; ci++) {
                r.grid.removeVolume(i0 + ci, j0 + cj, 1.0 / (cpb * cpb));
            }
        }
    }

    // ---------------------------------------------------------------- регионы

    public WaterRegion regionAt(int x, int z) {
        int size = AquafluxConfig.regionSize();
        int rx = Math.floorDiv(x, size);
        int rz = Math.floorDiv(z, size);
        WaterRegion r = regions.get(WaterRegion.key(rx, rz));
        if (r == null) {
            r = createRegion(rx, rz);
        }
        return r;
    }

    private WaterRegion createRegion(int rx, int rz) {
        Precision precision = AquafluxConfig.physicsPrecision();
        WaterRegion r = new WaterRegion(rx, rz, AquafluxConfig.regionSize(),
                AquafluxConfig.cellSize(), precision);
        regions.put(r.key(), r);
        r.sampleAll(level);
        r.scanWater(level);
        return r;
    }

    private void ensureRegion(int rx, int rz) {
        long k = WaterRegion.key(rx, rz);
        if (!regions.containsKey(k)) {
            createRegion(rx, rz);
        }
    }

    // ---------------------------------------------------------------- тик

    public void tick() {
        if (!AquafluxConfig.enabled()) {
            return;
        }
        List<ServerPlayer> players = level.players();
        if (players.isEmpty()) {
            return;
        }
        long now = level.getGameTime();

        // 1. Рельеф, изменившийся после копки/строительства
        drainGroundQueue();

        // 2. Активные регионы вокруг игроков
        int size = AquafluxConfig.regionSize();
        int radius = AquafluxConfig.activeRadius();
        Map<Long, Double> wanted = new HashMap<>();
        for (ServerPlayer p : players) {
            int px = p.getBlockX();
            int pz = p.getBlockZ();
            int rx0 = Math.floorDiv(px - radius, size);
            int rx1 = Math.floorDiv(px + radius, size);
            int rz0 = Math.floorDiv(pz - radius, size);
            int rz1 = Math.floorDiv(pz + radius, size);
            for (int rz = rz0; rz <= rz1; rz++) {
                for (int rx = rx0; rx <= rx1; rx++) {
                    double cx = rx * size + size * 0.5;
                    double cz = rz * size + size * 0.5;
                    double d = Math.hypot(cx - px, cz - pz);
                    wanted.merge(WaterRegion.key(rx, rz), d, Math::min);
                }
            }
        }

        active.clear();
        wanted.entrySet().stream()
                .sorted(Comparator.comparingDouble(Map.Entry::getValue))
                .forEach(e -> {
                    int rx = (int) (e.getKey() >> 32);
                    int rz = (int) (long) e.getKey();
                    ensureRegion(rx, rz);
                    WaterRegion r = regions.get(e.getKey());
                    if (r != null) {
                        active.add(r);
                    }
                });
        if (active.isEmpty()) {
            return;
        }

        // 3. Шаг: бюджет регионов, у которых есть вода или ожидание
        SolverSettings settings = new SolverSettings(
                AquafluxConfig.cellSize(), AquafluxConfig.gravity(), AquafluxConfig.bedFriction(),
                0.02, 1.0e-3, 9.0, AquafluxConfig.maxDepth(), 4.5, 0.55, 6);

        int budget = Math.min(AquafluxConfig.regionsPerTick(), active.size());
        for (int n = 0; n < budget; n++) {
            WaterRegion r = active.get((cursor + n) % active.size());
            stepRegion(r, settings, now);
        }
        cursor = (cursor + budget) % active.size();

        // 4. Блоки: один регион за тик
        WaterRegion applyRegion = active.get(applyCursor % active.size());
        applyCursor++;
        apply(applyRegion);

        // 5. Замена ванильной воды
        if (AquafluxConfig.replaceVanilla()) {
            VanillaReplacer.tick(level, players, this);
        }
    }

    private void drainGroundQueue() {
        int n = 0;
        while (!groundQueue.isEmpty() && n < 128) {
            BlockPos pos = groundQueue.poll();
            n++;
            for (WaterRegion r : overlapping(pos)) {
                r.refreshAround(level, pos.getX(), pos.getZ(), 2);
            }
        }
    }

    private void stepRegion(WaterRegion r, SolverSettings settings, long now) {
        r.pendingDt += 0.05;
        if (r.pendingDt > 0.25) {
            r.pendingDt = 0.25;
        }
        if (r.grid.totalVolume() < 1.0e-5) {
            r.pendingDt = 0.0;
            r.calmTicks = 0;
            return;
        }

        NeighborBoundary boundary = new NeighborBoundary(r);
        WaterStats stats = r.grid.step(r.pendingDt, settings, boundary);
        r.pendingDt = 0.0;
        r.lastTick = now;

        deliver(r);

        double tol = r.grid.precision().sleepTolerance();
        if (stats.isCalm(0.02, tol * 20)) {
            r.calmTicks++;
        } else {
            r.calmTicks = 0;
        }

        if (r.calmTicks > 6) {
            r.grid.decayWaves(0.98);
        }
    }

    private void deliver(WaterRegion r) {
        int size = AquafluxConfig.regionSize();
        transfer(r, 1, 0, BoundarySource.WEST, r.grid.outEast());
        transfer(r, -1, 0, BoundarySource.EAST, r.grid.outWest());
        transfer(r, 0, 1, BoundarySource.NORTH, r.grid.outSouth());
        transfer(r, 0, -1, BoundarySource.SOUTH, r.grid.outNorth());
    }

    private void transfer(WaterRegion from, int dx, int dz, int side, double[] volumes) {
        if (volumes == null) {
            return;
        }
        WaterRegion to = regions.get(WaterRegion.key(from.rx + dx, from.rz + dz));
        if (to == null) {
            return;
        }
        boolean any = false;
        for (double v : volumes) {
            if (v > 1.0e-9) {
                any = true;
                break;
            }
        }
        if (!any) {
            return;
        }
        for (int i = 0; i < volumes.length; i++) {
            if (volumes[i] > 0) {
                to.grid.receive(side, i, volumes[i]);
            }
        }
        to.lastTick = level.getGameTime();
    }

    private void apply(WaterRegion r) {
        APPLYING.set(Boolean.TRUE);
        try {
            r.apply(level);
        } finally {
            APPLYING.set(Boolean.FALSE);
            r.groundDirty = false;
        }
    }

    /** Реакция на игрока/лодку в воде: слабые волны и подталкивание течения. */
    public void entityWave(double x, double z, double vx, double vz, double strength) {
        if (strength <= 0) {
            return;
        }
        int size = AquafluxConfig.regionSize();
        WaterRegion r = regions.get(WaterRegion.key(Math.floorDiv((int) Math.floor(x), size),
                Math.floorDiv((int) Math.floor(z), size)));
        if (r == null) {
            return;
        }
        double lx = x - r.originX();
        double lz = z - r.originZ();
        r.grid.impulse(lx, lz, vx * strength * 0.6, vz * strength * 0.6, 2.5);
        r.grid.splash(lx, lz, strength * 0.35, 3.0);
        r.calmTicks = 0;
        r.lastTick = level.getGameTime();
    }

    /** Зарегистрировать воду, поставленную не блоком мода (конвертация ванильной). */
    public void registerPlacedWater(BlockPos pos) {
        addBlockVolume(pos);
    }

    public int regionCount() {
        return regions.size();
    }

    // ---------------------------------------------------------------- край региона

    private final class NeighborBoundary implements BoundarySource {
        private final double[][] depth = new double[4][];
        private final double[][] ground = new double[4][];

        NeighborBoundary(WaterRegion r) {
            int size = AquafluxConfig.regionSize();
            load(r, -1, 0, WEST, size);
            load(r, 1, 0, EAST, size);
            load(r, 0, -1, NORTH, size);
            load(r, 0, 1, SOUTH, size);
        }

        private void load(WaterRegion r, int dx, int dz, int side, int size) {
            WaterRegion n = regions.get(WaterRegion.key(r.rx + dx, r.rz + dz));
            if (n == null) {
                return;
            }
            int opposite = switch (side) {
                case WEST -> EAST;
                case EAST -> WEST;
                case NORTH -> SOUTH;
                default -> NORTH;
            };
            depth[side] = n.grid.edge(opposite);
            ground[side] = n.grid.groundEdge(opposite);
        }

        @Override
        public double outsideDepth(int side, int index) {
            double[] d = depth[side];
            if (d == null || index < 0 || index >= d.length) {
                return Double.NaN;
            }
            return d[index];
        }

        @Override
        public double outsideGround(int side, int index) {
            double[] g = ground[side];
            if (g == null || index < 0 || index >= g.length) {
                return 0;
            }
            return g[index];
        }
    }
}
