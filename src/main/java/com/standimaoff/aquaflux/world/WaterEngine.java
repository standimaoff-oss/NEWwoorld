package com.standimaoff.aquaflux.world;

import com.standimaoff.aquaflux.AquafluxConfig;
import com.standimaoff.aquaflux.core.BoundarySource;
import com.standimaoff.aquaflux.core.FluidConstants;
import com.standimaoff.aquaflux.core.ParcelField;
import com.standimaoff.aquaflux.core.Precision;
import com.standimaoff.aquaflux.core.SolverSettings;
import com.standimaoff.aquaflux.core.WaterGrid;
import com.standimaoff.aquaflux.core.WaterStats;
import com.standimaoff.aquaflux.core.WaveSpectrum;
import com.standimaoff.aquaflux.network.WaterNetworking;
import com.standimaoff.aquaflux.network.WaterSyncPacket;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import net.minecraft.server.level.ServerPlayer;

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
        List<Map.Entry<Long, Double>> sorted = new ArrayList<>(wanted.entrySet());
        sorted.sort(Comparator.comparingDouble(Map.Entry::getValue));

        // Создание региона - дорогая операция (сэмплинг пола + скан блоков),
        // поэтому не больше двух новых регионов за тик.
        int createBudget = 2;
        for (Map.Entry<Long, Double> e : sorted) {
            long key = e.getKey();
            WaterRegion region = regions.get(key);
            if (region == null) {
                if (createBudget <= 0) {
                    continue;
                }
                createBudget--;
                region = createRegion((int) (key >> 32), (int) (long) key);
            }
            active.add(region);
        }
        if (active.isEmpty()) {
            return;
        }

        if (now % 400L == 0L) {
            prune(now, wanted);
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

        // 3b. Ветер: дрейф, волны и барашки на воде
        applyWind(settings, now);

        // 4. Блоки: один регион за тик
        WaterRegion applyRegion = active.get(applyCursor % active.size());
        applyCursor++;
        apply(applyRegion);

        // 5. Замена ванильной воды
        if (AquafluxConfig.replaceVanilla()) {
            VanillaReplacer.tick(level, players, this);
        }

        // 6. Волны и пена на клиент (для рендера)
        if (now % Math.max(1, AquafluxConfig.syncInterval()) == 0L) {
            syncVisuals(players);
        }
    }

    /**
     * Разослать волны, пену, течение и капли игрокам вокруг регионов.
     *
     * <p>Глубину клиент знает по блокам, поэтому передаём только то, чего в блоках нет:
     * высоту волны, пену, вектор течения и сами капли. Регион 32×32 при шаге 2 блока -
     * это 16×16 значений: 256 + 256 + 512 байт + капли. Меньше одного чанка.</p>
     */
    private void syncVisuals(List<ServerPlayer> players) {
        int step = 2;
        int samples = Math.max(2, AquafluxConfig.regionSize() / step);
        for (WaterRegion r : active) {
            if (r.grid.totalVolume() <= 0 && r.parcels.isEmpty()) {
                continue;
            }
            byte[] wave = new byte[samples * samples];
            byte[] foam = new byte[samples * samples];
            byte[] flowU = new byte[samples * samples];
            byte[] flowV = new byte[samples * samples];
            boolean any = false;
            for (int j = 0; j < samples; j++) {
                double lz = (j + 0.5) * step;
                for (int i = 0; i < samples; i++) {
                    double lx = (i + 0.5) * step;
                    double w = r.grid.waveAtLocal(lx, lz);
                    double f = r.grid.foamAtLocal(lx, lz);
                    double[] vel = r.grid.velocityAtLocal(lx, lz, null);
                    int idx = i + samples * j;
                    int qw = (int) Math.round(Math.max(-1.0, Math.min(1.0, w)) * 128.0);
                    wave[idx] = (byte) Math.max(-127, Math.min(127, qw));
                    foam[idx] = (byte) Math.max(0, Math.min(255, (int) Math.round(f * 255.0)));
                    flowU[idx] = (byte) Math.max(-127, Math.min(127, (int) Math.round(vel[0] * 16.0)));
                    flowV[idx] = (byte) Math.max(-127, Math.min(127, (int) Math.round(vel[1] * 16.0)));
                    if (qw != 0 || foam[idx] != 0 || flowU[idx] != 0 || flowV[idx] != 0) {
                        any = true;
                    }
                }
            }
            byte[] parcels = r.parcels.isEmpty() ? new byte[1]
                    : r.parcels.encode(r.originX(), r.originZ());
            if (parcels.length > 1) {
                any = true;
            }
            if (!any) {
                continue;
            }
            WaterSyncPacket packet = new WaterSyncPacket(r.rx, r.rz, r.originX(), r.originZ(),
                    samples, step, wave, foam, flowU, flowV, parcels);
            double cx = r.originX() + AquafluxConfig.regionSize() * 0.5;
            double cz = r.originZ() + AquafluxConfig.regionSize() * 0.5;
            double maxDist = AquafluxConfig.activeRadius() + AquafluxConfig.regionSize();
            for (ServerPlayer player : players) {
                if (player.distanceToSqr(cx, player.getY(), cz) <= maxDist * maxDist) {
                    WaterNetworking.CHANNEL.sendTo(packet, player.connection.connection,
                            net.minecraftforge.network.NetworkDirection.PLAY_TO_CLIENT);
                }
            }
        }
    }

    // ---------------------------------------------------------------- физика для сущностей

    /**
     * Волны поднимают игроков, мобов и лодки: сущность «катается» на поверхности,
     * а не стоит в воде как в бетоне. Сила мягкая, чтобы не ломать ванильное плавание.
     */
    public void applyBuoyancy(Entity entity, double strength) {
        if (strength <= 0 || entity.isSpectator()) {
            return;
        }
        WaterRegion region = regions.get(WaterRegion.key(
                Math.floorDiv((int) Math.floor(entity.getX()), AquafluxConfig.regionSize()),
                Math.floorDiv((int) Math.floor(entity.getZ()), AquafluxConfig.regionSize())));
        if (region == null) {
            return;
        }
        double lx = entity.getX() - region.originX();
        double lz = entity.getZ() - region.originZ();
        double surface = region.grid.surfaceAtLocal(lx, lz);
        if (Double.isNaN(surface)) {
            return;
        }
        double feet = entity.getY();
        double submerged = surface - feet;
        if (submerged <= 0.02 || submerged > 3.0) {
            return;
        }
        double wave = region.grid.waveAtLocal(lx, lz);
        Vec3 motion = entity.getDeltaMovement();
        double lift = Math.min(0.12, submerged * 0.10) * strength;
        double bob = wave * 0.55 * strength;
        double ny = motion.y + lift + bob;
        if (ny > 0.42) {
            ny = 0.42;
        }
        double nx = motion.x;
        double nz = motion.z;
        if (AquafluxConfig.currents()) {
            // Течение тянет сущность за собой: это тот же поток, что несёт капли.
            double[] vel = region.grid.velocityAtLocal(lx, lz, null);
            double push = 0.035 * strength * Math.min(1.0, submerged);
            nx += vel[0] * push;
            nz += vel[1] * push;
        }
        entity.setDeltaMovement(nx, ny, nz);
        entity.fallDistance = 0;
    }

    /** Взрыв в воде: импульс, волны и пена. Возвращает true, если вода была задета. */
    public boolean explosion(Vec3 position, double power) {
        boolean hit = false;
        int size = AquafluxConfig.regionSize();
        int rx = Math.floorDiv((int) Math.floor(position.x), size);
        int rz = Math.floorDiv((int) Math.floor(position.z), size);
        for (int dz = -1; dz <= 1; dz++) {
            for (int dx = -1; dx <= 1; dx++) {
                WaterRegion region = regions.get(WaterRegion.key(rx + dx, rz + dz));
                if (region == null) {
                    continue;
                }
                double lx = position.x - region.originX();
                double lz = position.z - region.originZ();
                region.grid.explosion(lx, lz, power);
                double surface = region.grid.surfaceAtLocal(lx, lz);
                // Взрыв поднимает воду в воздух настоящими каплями: их объём вычитается
                // из поля, поэтому «вода из ничего» не появляется.
                double speed = 2.0 + 3.0 * Math.min(2.0, power);
                double taken = takeVolumeAround(region, lx, lz, 2.0 + 2.0 * power,
                        Math.min(0.25, 0.05 + 0.10 * power));
                double spawned = region.parcels.impact(position.x,
                        Double.isNaN(surface) ? position.y : surface, position.z,
                        2.0 + 2.5 * Math.min(2.0, power), speed, taken, 0.9);
                if (spawned < taken) {
                    region.grid.addVolumeAt(lx, lz, taken - spawned);
                }
                region.calmTicks = 0;
                region.lastTick = level.getGameTime();
                hit = true;
            }
        }
        return hit;
    }

    /** Существующий регион без создания. */
    public WaterRegion existingRegion(int x, int z) {
        int size = AquafluxConfig.regionSize();
        return regions.get(WaterRegion.key(Math.floorDiv(x, size), Math.floorDiv(z, size)));
    }

    /** Выгрузить регионы, которые давно никто не трогал: массу сохраняют блоки в мире. */
    private void prune(long now, Map<Long, Double> wanted) {
        java.util.Iterator<Map.Entry<Long, WaterRegion>> it = regions.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<Long, WaterRegion> entry = it.next();
            if (wanted.containsKey(entry.getKey())) {
                continue;
            }
            WaterRegion region = entry.getValue();
            if (now - region.lastTick < 600L) {
                continue;
            }
            APPLYING.set(Boolean.TRUE);
            try {
                region.apply(level);
            } catch (RuntimeException ignored) {
                // регион мог попасть в незагруженный чанк - просто выбросим его
            } finally {
                APPLYING.set(Boolean.FALSE);
            }
            it.remove();
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
        double dt = r.pendingDt;
        boolean dry = r.grid.totalVolume() < 1.0e-5 && r.parcels.isEmpty();
        if (dry) {
            r.pendingDt = 0.0;
            r.calmTicks = 0;
            return;
        }

        WaterStats stats = WaterStats.EMPTY;
        if (r.grid.totalVolume() >= 1.0e-5) {
            NeighborBoundary boundary = new NeighborBoundary(r);
            stats = r.grid.step(dt, settings, boundary);
            deliver(r);
        }
        r.pendingDt = 0.0;
        r.lastTick = now;

        // «Много маленьких тел»: капли живут своей жизнью, но масса у них общая с полем.
        stats = stepParcels(r, dt, settings, now, stats);

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

    /**
     * Ветер: касательное напряжение гонит воду, а крутые гребни покрываются барашками.
     *
     * <p>Направление медленно поворачивает за игровой день, сила берётся из конфига.
     * Даже один и тот же регион ведёт себя по-разному: утром рябь, к вечеру - волны.</p>
     */
    private void applyWind(SolverSettings settings, long now) {
        double strength = AquafluxConfig.windStrength();
        if (strength <= 0 || active.isEmpty()) {
            return;
        }
        double dayPhase = (now % 24000L) / 24000.0 * Math.PI * 2.0;
        double seedPhase = (level.getSeed() % 6283L) * 0.001;
        double angle = Math.sin(dayPhase + seedPhase) * 1.1 + Math.cos(dayPhase * 0.37 + seedPhase) * 0.6;
        double gust = 0.75 + 0.25 * Math.sin(now * 0.031 + seedPhase * 5.0);
        double windSpeed = 3.0 + 6.0 * Math.min(1.5, strength) * gust;
        double windX = Math.cos(angle) * windSpeed;
        double windZ = Math.sin(angle) * windSpeed;

        double time = now / 20.0;
        for (WaterRegion r : active) {
            if (r.grid.totalVolume() < 1.0e-5) {
                continue;
            }
            r.grid.windStress(windX, windZ, strength, 0.05);
            double maxDepth = Math.max(0.1, r.grid.stats().maxDepth);
            WaveSpectrum spectrum = WaveSpectrum.wind(windSpeed, maxDepth,
                    (int) (r.key() & 0xFFFF), 5);
            r.grid.whitecaps(spectrum, time, strength);
        }
    }

    // ---------------------------------------------------------------- капли и брызги

    /**
     * Шаг слоя капель: полёт, слияние с водой, рождение новых брызг на порогах и водопадах,
     * передача соседям. Всё делается в той же массе, что и поле высот.
     */
    private WaterStats stepParcels(WaterRegion r, double dt, SolverSettings settings, long now,
                                   WaterStats stats) {
        ParcelField parcels = r.parcels;
        if (dt <= 0) {
            return stats;
        }
        double gravity = settings.gravity;

        parcels.step(dt, gravity);
        parcels.settleInto(r.grid, r.originX(), r.originZ());
        parcels.recycle(r.grid, r.originX(), r.originZ());

        if (AquafluxConfig.splashEnabled()) {
            birthFromTurbulence(r, dt, settings);
            birthAtWaterfalls(r, settings);
        }
        handoff(r);
        return r.grid.stats();
    }

    /**
     * Рождение брызг на бурной воде.
     *
     * <p>Критерий честный - число Фруда: {@code Fr = U/√(g·h)}. При {@code Fr > 0.8} поток
     * бурный, гребни обрушиваются, и вода действительно летит в воздух. На спокойной воде
     * брызг нет вообще, поэтому слой капель почти всегда пуст и ничего не стоит по TPS.</p>
     */
    private void birthFromTurbulence(WaterRegion r, double dt, SolverSettings settings) {
        WaterGrid grid = r.grid;
        if (grid.totalVolume() < 1.0e-5) {
            return;
        }
        int samples = Math.min(10, grid.width() * grid.height());
        long tick = level.getGameTime();
        int cpb = Math.max(1, r.cellsPerBlock);
        double cellArea = grid.cellSize() * grid.cellSize();
        for (int n = 0; n < samples; n++) {
            int i = (int) Math.abs(com.standimaoff.aquaflux.core.Noise.hash(n, (int) (tick & 0xFFFF), 17)
                    * grid.width());
            int j = (int) Math.abs(com.standimaoff.aquaflux.core.Noise.hash(n, (int) (tick & 0xFFFF), 91)
                    * grid.height());
            i = Math.min(grid.width() - 1, Math.max(0, i));
            j = Math.min(grid.height() - 1, Math.max(0, j));
            double depth = grid.depth(i, j);
            if (depth < 0.12) {
                continue;
            }
            double[] vel = grid.velocityAtLocal((i + 0.5) * grid.cellSize(),
                    (j + 0.5) * grid.cellSize(), null);
            double speed = Math.hypot(vel[0], vel[1]);
            double froude = FluidConstants.froude(speed, depth, settings.gravity);
            if (froude < 0.8) {
                continue;
            }
            // Объём брызг - доля от объёма ячейки; больше, чем есть, взять невозможно.
            double want = Math.min(depth * cellArea * 0.12, 0.02);
            double speedUp = Math.min(2.6, 0.55 + froude * 0.8);
            double lifted = r.parcels.liftFrom(grid, r.originX(), r.originZ(),
                    r.originX() + (i + 0.5) * grid.cellSize(),
                    r.originZ() + (j + 0.5) * grid.cellSize(),
                    want, speedUp, vel[0] * 0.45, vel[1] * 0.45);
            if (lifted > 0) {
                grid.addFoamLocal((i + 0.5) * grid.cellSize(), (j + 0.5) * grid.cellSize(),
                        Math.min(0.5, froude * 0.25), 1.2 * cpb * 0.5);
            }
        }
    }

    /**
     * Вода, которая свисает с края региона над обрывом, действительно падает вниз - каплями.
     *
     * <p>Внутри региона перепад высот рисуется мешером как стенка, а на границе региона
     * вода может уйти наружу: там поле высот соседа ещё не знает о воде, и вода уходит
     * каплями, которые при падении вернутся в поле уже внизу.</p>
     */
    private void birthAtWaterfalls(WaterRegion r, SolverSettings settings) {
        WaterGrid grid = r.grid;
        int size = r.regionSize;
        int n = grid.width();
        int perSide = 3;
        for (int side = 0; side < 4; side++) {
            for (int s = 0; s < perSide; s++) {
                double t = (s + 0.5) / perSide;
                int i;
                int j;
                double wx;
                double wz;
                switch (side) {
                    case BoundarySource.WEST -> {
                        i = 0;
                        j = Math.min(n - 1, (int) (t * n));
                        wx = r.originX();
                        wz = r.originZ() + (j + 0.5) * grid.cellSize();
                    }
                    case BoundarySource.EAST -> {
                        i = n - 1;
                        j = Math.min(n - 1, (int) (t * n));
                        wx = r.originX() + size;
                        wz = r.originZ() + (j + 0.5) * grid.cellSize();
                    }
                    case BoundarySource.NORTH -> {
                        i = Math.min(n - 1, (int) (t * n));
                        j = 0;
                        wx = r.originX() + (i + 0.5) * grid.cellSize();
                        wz = r.originZ();
                    }
                    default -> {
                        i = Math.min(n - 1, (int) (t * n));
                        j = n - 1;
                        wx = r.originX() + (i + 0.5) * grid.cellSize();
                        wz = r.originZ() + size;
                    }
                }
                if (!grid.inside(i, j)) {
                    continue;
                }
                double depth = grid.depth(i, j);
                if (depth < 0.3) {
                    continue;
                }
                double surface = grid.ground(i, j) + depth;
                int outsideX = (int) Math.floor(wx);
                int outsideZ = (int) Math.floor(wz);
                if (level.isEmptyBlock(new BlockPos(outsideX, (int) Math.floor(surface - 0.15), outsideZ))) {
                    double want = Math.min(depth * 0.05, 0.03);
                    double vx = switch (side) {
                        case BoundarySource.WEST -> -1.2;
                        case BoundarySource.EAST -> 1.2;
                        default -> 0;
                    };
                    double vz = switch (side) {
                        case BoundarySource.NORTH -> -1.2;
                        case BoundarySource.SOUTH -> 1.2;
                        default -> 0;
                    };
                    r.parcels.liftFrom(grid, r.originX(), r.originZ(), wx, wz, want, 0.15, vx, vz);
                }
            }
        }
    }

    /**
     * Передать капли соседнему региону, если они вышли за его границы.
     *
     * <p>Капля принадлежит тому региону, где она находится. Масса при передаче не меняется:
     * {@link ParcelField#spawn} либо создаёт новую каплю, либо вливает объём в соседнюю.</p>
     */
    private void handoff(WaterRegion r) {
        if (r.parcels.isEmpty()) {
            return;
        }
        int size = r.regionSize;
        double ox = r.originX();
        double oz = r.originZ();
        for (int i = 0; i < r.parcels.count(); i++) {
            ParcelField.Parcel p = r.parcels.at(i);
            if (p == null || !p.alive()) {
                continue;
            }
            if (p.x >= ox && p.x < ox + size && p.z >= oz && p.z < oz + size) {
                continue;
            }
            int rx = Math.floorDiv((int) Math.floor(p.x), size);
            int rz = Math.floorDiv((int) Math.floor(p.z), size);
            WaterRegion neighbour = regions.get(WaterRegion.key(rx, rz));
            if (neighbour == null || neighbour == r) {
                continue;
            }
            ParcelField.Parcel moved = neighbour.parcels.spawn(p.x, p.y, p.z, p.vx, p.vy, p.vz,
                    p.volume, p.surface);
            if (moved != null) {
                moved.foam = p.foam;
                moved.age = p.age;
                p.consumed = true;
                neighbour.lastTick = level.getGameTime();
            }
        }
    }

    /**
     * Удар по воде: брызги, кольцо волн и пена. Единая точка для мобов, падающих блоков,
     * весла, взрывов и чего угодно ещё.
     *
     * @param radius радиус возмущения, блоки
     * @param speed  сила удара, м/с
     * @param foam   сколько пены добавить
     * @return true, если вода была задета
     */
    public boolean impact(double x, double y, double z, double radius, double speed, double foam) {
        WaterRegion r = existingRegion((int) Math.floor(x), (int) Math.floor(z));
        if (r == null) {
            return false;
        }
        double lx = x - r.originX();
        double lz = z - r.originZ();
        double depth = r.grid.depthAtLocal(lx, lz);
        if (depth <= 0.02) {
            return false;
        }
        double cellArea = r.grid.cellSize() * r.grid.cellSize();
        r.grid.splash(lx, lz, Math.min(1.2, speed * 0.22), Math.min(6.0, radius * 1.4));
        r.grid.addFoamLocal(lx, lz, Math.min(1.0, foam), Math.min(6.0, radius * 1.2));

        // Берём объём из воды, а не из воздуха: брызги - это поднятая вода.
        double want = Math.min(depth * cellArea * 0.45, 0.06 * Math.max(1.0, radius));
        double taken = takeVolumeAround(r, lx, lz, radius, want);
        double spawned = r.parcels.impact(x, r.grid.groundAtLocal(lx, lz) + depth, z,
                Math.min(4.0, radius), Math.min(6.0, speed), taken, foam);
        if (spawned < taken) {
            r.grid.addVolumeAt(lx, lz, taken - spawned);
        }
        r.calmTicks = 0;
        r.lastTick = level.getGameTime();
        return true;
    }

    /** Аккуратно забрать объём из ячеек вокруг точки - сумму не больше {@code want}. */
    private double takeVolumeAround(WaterRegion r, double lx, double lz, double radius, double want) {
        if (want <= 0) {
            return 0;
        }
        double cell = r.grid.cellSize();
        int i0 = Math.max(0, (int) Math.floor((lx - radius) / cell));
        int i1 = Math.min(r.grid.width() - 1, (int) Math.floor((lx + radius) / cell));
        int j0 = Math.max(0, (int) Math.floor((lz - radius) / cell));
        int j1 = Math.min(r.grid.height() - 1, (int) Math.floor((lz + radius) / cell));
        if (i1 < i0 || j1 < j0) {
            // Взрыв у самой границы региона: в этом регионе просто нет его ячеек.
            return 0;
        }
        double[] weights = new double[(i1 - i0 + 1) * (j1 - j0 + 1)];
        double total = 0;
        int idx = 0;
        for (int j = j0; j <= j1; j++) {
            for (int i = i0; i <= i1; i++) {
                double dx = (i + 0.5) * cell - lx;
                double dz = (j + 0.5) * cell - lz;
                double w = Math.max(0.0, 1.0 - Math.hypot(dx, dz) / Math.max(0.001, radius));
                weights[idx++] = w;
                total += w;
            }
        }
        if (total <= 0) {
            return 0;
        }
        double taken = 0;
        idx = 0;
        for (int j = j0; j <= j1; j++) {
            for (int i = i0; i <= i1; i++) {
                double share = want * weights[idx++] / total;
                if (share > 0) {
                    taken += r.grid.removeVolume(i, j, share);
                }
            }
        }
        return taken;
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
