package com.standimaoff.aquaflux.core;

/**
 * Двумерная мелкая вода на шахматной сетке (shallow water, staggered grid).
 *
 * <p>Состояние ячейки - глубина {@code h} над полом {@code g}; скорость живёт на гранях
 * ({@code u} вдоль X, {@code v} вдоль Z). Шаг:</p>
 * <ol>
 *   <li>скорости граней подталкиваются разностью уровней {@code eta = g + h};</li>
 *   <li>объём через грань = скорость × глубина против потока × ширина × dt;</li>
 *   <li>отток из ячейки ограничен 85% её объёма - масса не может уйти в минус;</li>
 *   <li>глубины обновляются дивергенцией потока.</li>
 * </ol>
 *
 * <p>Схема консервативна: сколько ушло через грань, столько и пришло. Вода не создаётся из
 * ничего (нет бесконечного источника), поэтому выкопанная яма наполняется за счёт соседей,
 * а небольшую реку можно действительно вычерпать.</p>
 *
 * <p>Поверх волн идёт отдельное волновое поле {@code wave} - это визуальная рябь и волны от
 * игрока. Она не переносит массу и не влияет на течение, поэтому не может «сломать» баланс.</p>
 */
public final class WaterGrid {

    private final int w;
    private final int h;
    private final double cell;
    private final double area;
    private final Precision precision;

    private final double[] ground;
    private final double[] depth;
    private final double[] wave;
    private final double[] waveV;
    private final double[] waveNext;

    private final double[] u; // (w+1) * h
    private final double[] v; // w * (h+1)

    private final double[] fx; // объёмы через X-грани за подшаг
    private final double[] fz;
    private final double[] outVol;
    private final double[] factor;

    // объём, ушедший за границу региона за последний step()
    private final double[] outWest;
    private final double[] outEast;
    private final double[] outNorth;
    private final double[] outSouth;

    private boolean empty = true;
    private double cachedMass;
    private boolean massDirty = true;

    public WaterGrid(int cellsX, int cellsZ, double cellSize, Precision precision) {
        this.w = Math.max(1, cellsX);
        this.h = Math.max(1, cellsZ);
        this.cell = cellSize;
        this.area = cellSize * cellSize;
        this.precision = precision;

        int n = w * h;
        this.ground = new double[n];
        this.depth = new double[n];
        this.wave = new double[n];
        this.waveV = new double[n];
        this.waveNext = new double[n];
        this.u = new double[(w + 1) * h];
        this.v = new double[w * (h + 1)];
        this.fx = new double[(w + 1) * h];
        this.fz = new double[w * (h + 1)];
        this.outVol = new double[n];
        this.factor = new double[n];

        this.outWest = new double[h];
        this.outEast = new double[h];
        this.outNorth = new double[w];
        this.outSouth = new double[w];
    }

    // ---------------------------------------------------------------- геометрия

    public int width() {
        return w;
    }

    public int height() {
        return h;
    }

    public double cellSize() {
        return cell;
    }

    public Precision precision() {
        return precision;
    }

    public int index(int i, int j) {
        return i + w * j;
    }

    public boolean inside(int i, int j) {
        return i >= 0 && j >= 0 && i < w && j < h;
    }

    public double ground(int i, int j) {
        return ground[index(i, j)];
    }

    public void setGround(int i, int j, double y) {
        int k = index(i, j);
        if (Math.abs(ground[k] - y) > 1.0e-6) {
            ground[k] = y;
            massDirty = true;
        }
    }

    public void setGroundAll(double[] heights) {
        if (heights.length != ground.length) {
            throw new IllegalArgumentException("ждал " + ground.length + " высот, получил " + heights.length);
        }
        System.arraycopy(heights, 0, ground, 0, ground.length);
        massDirty = true;
    }

    public double depth(int i, int j) {
        return depth[index(i, j)];
    }

    public double surface(int i, int j) {
        int k = index(i, j);
        return ground[k] + depth[k];
    }

    public double waveAt(int i, int j) {
        return wave[index(i, j)];
    }

    /** Абсолютная высота гребня волны для рендера. */
    public double renderSurface(int i, int j) {
        int k = index(i, j);
        return ground[k] + depth[k] + wave[k];
    }

    // ---------------------------------------------------------------- масса

    public double totalVolume() {
        if (massDirty) {
            double sum = 0;
            for (double d : depth) {
                sum += d;
            }
            cachedMass = sum * area;
            massDirty = false;
        }
        return cachedMass;
    }

    public boolean isEmpty() {
        return empty;
    }

    /** Влить объём (м^3) в ячейку под мировой точкой {@code x,z} (локальные координаты региона). */
    public void addVolumeAt(double x, double z, double volume) {
        int i = clampCell((int) Math.floor(x / cell), w);
        int j = clampCell((int) Math.floor(z / cell), h);
        addVolume(i, j, volume);
    }

    public void addVolume(int i, int j, double volume) {
        if (!inside(i, j) || volume == 0) {
            return;
        }
        int k = index(i, j);
        depth[k] = clampDepth(depth[k] + volume / area);
        empty = false;
        massDirty = true;
    }

    /** Забрать объём (м^3) из ячейки, вернуть сколько реально удалось. */
    public double removeVolume(int i, int j, double volume) {
        if (!inside(i, j) || volume <= 0) {
            return 0;
        }
        int k = index(i, j);
        double have = depth[k] * area;
        double taken = Math.min(have, volume);
        depth[k] = clampDepth(depth[k] - taken / area);
        massDirty = true;
        return taken;
    }

    public void clear() {
        java.util.Arrays.fill(depth, 0.0);
        java.util.Arrays.fill(wave, 0.0);
        java.util.Arrays.fill(waveV, 0.0);
        java.util.Arrays.fill(u, 0.0);
        java.util.Arrays.fill(v, 0.0);
        massDirty = true;
        empty = true;
    }

    // ---------------------------------------------------------------- возмущения

    /** Импульс течения в пятне радиуса {@code radius} (локальные координаты). */
    public void impulse(double x, double z, double vx, double vz, double radius) {
        double r2 = radius * radius;
        int i0 = clampCell((int) Math.floor((x - radius) / cell), w);
        int i1 = clampCell((int) Math.floor((x + radius) / cell), w);
        int j0 = clampCell((int) Math.floor((z - radius) / cell), h);
        int j1 = clampCell((int) Math.floor((z + radius) / cell), h);

        for (int j = j0; j <= j1; j++) {
            for (int i = i0; i <= i1; i++) {
                int k = index(i, j);
                if (depth[k] <= 0) {
                    continue;
                }
                double dx = (i + 0.5) * cell - x;
                double dz = (j + 0.5) * cell - z;
                double d2 = dx * dx + dz * dz;
                if (d2 > r2) {
                    continue;
                }
                double fall = 1.0 - Math.sqrt(d2) / radius;
                addVelocity(k, i, j, vx * fall, vz * fall);
            }
        }
    }

    private void addVelocity(int k, int i, int j, double dvx, double dvz) {
        u[i + (w + 1) * j] += dvx;
        if (j + 1 <= h) {
            v[i + w * j] += dvz;
        }
    }

    /** Всплеск: круговое возмущение гребня (визуальные волны от игрока/лодки). */
    public void splash(double x, double z, double strength, double radius) {
        double r2 = radius * radius;
        int i0 = clampCell((int) Math.floor((x - radius) / cell), w);
        int i1 = clampCell((int) Math.floor((x + radius) / cell), w);
        int j0 = clampCell((int) Math.floor((z - radius) / cell), h);
        int j1 = clampCell((int) Math.floor((z + radius) / cell), h);

        for (int j = j0; j <= j1; j++) {
            for (int i = i0; i <= i1; i++) {
                int k = index(i, j);
                if (depth[k] <= 0) {
                    continue;
                }
                double dx = (i + 0.5) * cell - x;
                double dz = (j + 0.5) * cell - z;
                double dist = Math.sqrt(dx * dx + dz * dz);
                if (dist > radius) {
                    continue;
                }
                double fall = 1.0 - dist / radius;
                double dir = dist < 1.0e-4 ? 0.0 : 1.0;
                waveV[k] += strength * fall * dir;
            }
        }
    }

    // ---------------------------------------------------------------- шаг

    public WaterStats step(double dt, SolverSettings s, BoundarySource boundary) {
        if (dt <= 0) {
            return stats();
        }
        double maxD = 0.0;
        for (double d : depth) {
            if (d > maxD) {
                maxD = d;
            }
        }
        double dtGravity = 0.45 * cell / Math.sqrt(s.gravity * Math.max(maxD, 0.25));
        double dtWave = 0.35 * cell / (s.waveSpeed * Math.sqrt(2.0));
        double limit = Math.min(dtGravity, dtWave);
        int substeps = (int) Math.ceil(dt / Math.max(limit, 1.0e-4));
        substeps = Math.max(1, Math.min(substeps, s.maxSubsteps));
        double sub = dt / substeps;

        java.util.Arrays.fill(outWest, 0.0);
        java.util.Arrays.fill(outEast, 0.0);
        java.util.Arrays.fill(outNorth, 0.0);
        java.util.Arrays.fill(outSouth, 0.0);

        for (int k = 0; k < substeps; k++) {
            substep(sub, s, boundary);
        }
        return stats();
    }

    private void substep(double dt, SolverSettings s, BoundarySource b) {
        // 1. Скорости граней
        for (int j = 0; j < h; j++) {
            for (int fi = 0; fi <= w; fi++) {
                int f = fi + (w + 1) * j;
                double etaL;
                double etaR;
                if (fi == 0) {
                    double od = b.outsideDepth(BoundarySource.WEST, j);
                    if (Double.isNaN(od)) {
                        u[f] = 0;
                        continue;
                    }
                    etaL = b.outsideGround(BoundarySource.WEST, j) + od;
                } else {
                    etaL = surface(fi - 1, j);
                }
                if (fi == w) {
                    double od = b.outsideDepth(BoundarySource.EAST, j);
                    if (Double.isNaN(od)) {
                        u[f] = 0;
                        continue;
                    }
                    etaR = b.outsideGround(BoundarySource.EAST, j) + od;
                } else {
                    etaR = surface(fi, j);
                }
                double hL = fi > 0 ? depth[fi - 1 + w * j] : b.outsideDepth(BoundarySource.WEST, j);
                double hR = fi < w ? depth[fi + w * j] : b.outsideDepth(BoundarySource.EAST, j);
                integrateFace(u, f, etaL, etaR, hL, hR, dt, s);
            }
        }

        for (int fj = 0; fj <= h; fj++) {
            for (int i = 0; i < w; i++) {
                int f = i + w * fj;
                double etaL;
                double etaR;
                if (fj == 0) {
                    double od = b.outsideDepth(BoundarySource.NORTH, i);
                    if (Double.isNaN(od)) {
                        v[f] = 0;
                        continue;
                    }
                    etaL = b.outsideGround(BoundarySource.NORTH, i) + od;
                } else {
                    etaL = surface(i, fj - 1);
                }
                if (fj == h) {
                    double od = b.outsideDepth(BoundarySource.SOUTH, i);
                    if (Double.isNaN(od)) {
                        v[f] = 0;
                        continue;
                    }
                    etaR = b.outsideGround(BoundarySource.SOUTH, i) + od;
                } else {
                    etaR = surface(i, fj);
                }
                double hL = fj > 0 ? depth[i + w * (fj - 1)] : b.outsideDepth(BoundarySource.NORTH, i);
                double hR = fj < h ? depth[i + w * fj] : b.outsideDepth(BoundarySource.SOUTH, i);
                integrateFace(v, f, etaL, etaR, hL, hR, dt, s);
            }
        }

        // 2. Объёмы через грани, отток ограничиваем долей объёма ячейки
        java.util.Arrays.fill(outVol, 0.0);
        java.util.Arrays.fill(factor, 1.0);

        for (int j = 0; j < h; j++) {
            for (int fi = 0; fi <= w; fi++) {
                int f = fi + (w + 1) * j;
                double uu = u[f];
                if (uu == 0) {
                    fx[f] = 0;
                    continue;
                }
                boolean out = uu > 0;
                double hUp = out ? (fi > 0 ? depth[fi - 1 + w * j] : 0) : (fi < w ? depth[fi + w * j] : 0);
                double vol = hUp <= 0 ? 0 : uu * hUp * cell * dt;
                if (out) {
                    if (fi == 0) {
                        vol = 0; // внешний край: отдаёт только соседний регион
                    } else if (fi == w) {
                        vol = 0;
                    } else {
                        outVol[fi - 1 + w * j] += vol;
                    }
                } else {
                    if (fi == 0 || fi == w) {
                        vol = 0;
                    } else {
                        outVol[fi + w * j] += -vol;
                    }
                }
                fx[f] = vol;
            }
        }

        for (int fj = 0; fj <= h; fj++) {
            for (int i = 0; i < w; i++) {
                int f = i + w * fj;
                double vv = v[f];
                if (vv == 0) {
                    fz[f] = 0;
                    continue;
                }
                boolean out = vv > 0;
                double hUp = out ? (fj > 0 ? depth[i + w * (fj - 1)] : 0) : (fj < h ? depth[i + w * fj] : 0);
                double vol = hUp <= 0 ? 0 : vv * hUp * cell * dt;
                if (out) {
                    if (fj == 0 || fj == h) {
                        vol = 0;
                    } else {
                        outVol[i + w * (fj - 1)] += vol;
                    }
                } else {
                    if (fj == 0 || fj == h) {
                        vol = 0;
                    } else {
                        outVol[i + w * fj] += -vol;
                    }
                }
                fz[f] = vol;
            }
        }

        for (int k = 0; k < outVol.length; k++) {
            double have = depth[k] * area;
            if (outVol[k] > have * 0.85 && outVol[k] > 0) {
                factor[k] = have * 0.85 / outVol[k];
            }
        }

        // 3. Применяем
        for (int j = 0; j < h; j++) {
            for (int fi = 1; fi < w; fi++) {
                int f = fi + (w + 1) * j;
                double vol = fx[f];
                if (vol == 0) {
                    continue;
                }
                if (vol > 0) {
                    double sc = factor[fi - 1 + w * j];
                    vol *= sc;
                    u[f] *= sc;
                    depth[fi - 1 + w * j] -= vol / area;
                    depth[fi + w * j] += vol / area;
                } else {
                    double sc = factor[fi + w * j];
                    vol *= sc;
                    u[f] *= sc;
                    depth[fi + w * j] += vol / area;
                    depth[fi - 1 + w * j] -= vol / area;
                }
            }
        }
        for (int fj = 1; fj < h; fj++) {
            for (int i = 0; i < w; i++) {
                int f = i + w * fj;
                double vol = fz[f];
                if (vol == 0) {
                    continue;
                }
                if (vol > 0) {
                    double sc = factor[i + w * (fj - 1)];
                    vol *= sc;
                    v[f] *= sc;
                    depth[i + w * (fj - 1)] -= vol / area;
                    depth[i + w * fj] += vol / area;
                } else {
                    double sc = factor[i + w * fj];
                    vol *= sc;
                    v[f] *= sc;
                    depth[i + w * fj] += vol / area;
                    depth[i + w * (fj - 1)] -= vol / area;
                }
            }
        }

        // 4. Границы: отдаём только наружу, приход придёт от соседа
        java.util.Arrays.fill(fx, 0.0);
        java.util.Arrays.fill(fz, 0.0);
        for (int j = 0; j < h; j++) {
            double od = b.outsideDepth(BoundarySource.WEST, j);
            if (!Double.isNaN(od)) {
                double uu = u[(w + 1) * j];
                if (uu < 0) {
                    double hUp = depth[w * j];
                    double vol = -uu * hUp * cell * dt;
                    vol = Math.min(vol, depth[w * j] * area * 0.85);
                    outWest[j] += vol;
                    depth[w * j] -= vol / area;
                    u[(w + 1) * j] = 0;
                }
            }
            double oe = b.outsideDepth(BoundarySource.EAST, j);
            if (!Double.isNaN(oe)) {
                int f = w + (w + 1) * j;
                double uu = u[f];
                if (uu > 0) {
                    double hUp = depth[w - 1 + w * j];
                    double vol = uu * hUp * cell * dt;
                    vol = Math.min(vol, depth[w - 1 + w * j] * area * 0.85);
                    outEast[j] += vol;
                    depth[w - 1 + w * j] -= vol / area;
                    u[f] = 0;
                }
            }
        }
        for (int i = 0; i < w; i++) {
            double on = b.outsideDepth(BoundarySource.NORTH, i);
            if (!Double.isNaN(on)) {
                double vv = v[i];
                if (vv < 0) {
                    double hUp = depth[i];
                    double vol = -vv * hUp * cell * dt;
                    vol = Math.min(vol, depth[i] * area * 0.85);
                    outNorth[i] += vol;
                    depth[i] -= vol / area;
                    v[i] = 0;
                }
            }
            double os = b.outsideDepth(BoundarySource.SOUTH, i);
            if (!Double.isNaN(os)) {
                int f = i + w * h;
                double vv = v[f];
                if (vv > 0) {
                    double hUp = depth[i + w * (h - 1)];
                    double vol = vv * hUp * cell * dt;
                    vol = Math.min(vol, depth[i + w * (h - 1)] * area * 0.85);
                    outSouth[i] += vol;
                    depth[i + w * (h - 1)] -= vol / area;
                    v[f] = 0;
                }
            }
        }

        // 5. Чистим отрицательные хвосты и глубину сверх предела
        for (int k = 0; k < depth.length; k++) {
            if (depth[k] < 0) {
                depth[k] = 0;
            } else if (depth[k] > s.maxDepth) {
                depth[k] = s.maxDepth;
            }
        }

        // 6. Волны (визуальные, массу не переносят)
        propagateWaves(dt, s);

        massDirty = true;
        empty = false;
    }

    private void integrateFace(double[] arr, int f, double etaL, double etaR,
                               double hL, double hR, double dt, SolverSettings s) {
        double hMean = 0.5 * (hL + hR);
        if (hMean < 1.0e-4) {
            arr[f] = 0;
            return;
        }
        double vel = arr[f];
        double dEta = etaR - etaL;
        double friction = s.bedFriction / Math.max(0.15, hMean) + s.turbulence * Math.abs(vel);
        vel = (vel - dt * s.gravity * dEta / cell) / (1.0 + dt * friction);
        if (vel > s.maxSpeed) {
            vel = s.maxSpeed;
        } else if (vel < -s.maxSpeed) {
            vel = -s.maxSpeed;
        }
        arr[f] = vel;
    }

    /**
     * Волновое поле: symplectic Euler с двойной буферизацией (схема Якоби).
     *
     * <p>Важно не читать уже обновлённые соседи: иначе схема теряет симметрию и разгоняется.
     * Устойчивость держится условием {@code waveSpeed * dt / cell <= 1/sqrt(2)}, а амплитуда
     * дополнительно ограничена - визуальная рябь не имеет права «взорвать» массив.</p>
     */
    private void propagateWaves(double dt, SolverSettings s) {
        double inv = 1.0 / (cell * cell);
        double c2 = s.waveSpeed * s.waveSpeed;
        double damp = 1.0 / (1.0 + dt * s.waveDamping);
        double speedLimit = s.maxSpeed * 4.0;

        for (int j = 0; j < h; j++) {
            for (int i = 0; i < w; i++) {
                int k = i + w * j;
                double self = wave[k];
                double left = i > 0 ? wave[k - 1] : self;
                double right = i < w - 1 ? wave[k + 1] : self;
                double up = j > 0 ? wave[k - w] : self;
                double down = j < h - 1 ? wave[k + w] : self;
                double lap = (left + right + up + down - 4.0 * self) * inv;
                double vel = (waveV[k] + c2 * lap * dt) * damp;
                if (vel > speedLimit) {
                    vel = speedLimit;
                } else if (vel < -speedLimit) {
                    vel = -speedLimit;
                }
                waveNext[k] = vel;
            }
        }

        for (int k = 0; k < wave.length; k++) {
            double vel = waveNext[k];
            waveV[k] = vel;
            double next = wave[k] + vel * dt;
            if (next > 0.75) {
                next = 0.75;
            } else if (next < -0.75) {
                next = -0.75;
            }
            wave[k] = next;
        }
    }

    // ---------------------------------------------------------------- статистика

    public WaterStats stats() {
        double total = 0;
        double maxD = 0;
        double maxWave = 0;
        int wet = 0;
        for (int k = 0; k < depth.length; k++) {
            double d = depth[k];
            total += d;
            if (d > maxD) {
                maxD = d;
            }
            if (d > 1.0e-4) {
                wet++;
            }
            double aw = Math.abs(wave[k]);
            if (aw > maxWave) {
                maxWave = aw;
            }
        }
        double maxSpeed = 0;
        for (double s : u) {
            double a = Math.abs(s);
            if (a > maxSpeed) {
                maxSpeed = a;
            }
        }
        for (double s : v) {
            double a = Math.abs(s);
            if (a > maxSpeed) {
                maxSpeed = a;
            }
        }
        return new WaterStats(total * area, maxD, maxSpeed, maxWave, wet);
    }

    // ---------------------------------------------------------------- край

    public double[] outWest() {
        return outWest;
    }

    public double[] outEast() {
        return outEast;
    }

    public double[] outNorth() {
        return outNorth;
    }

    public double[] outSouth() {
        return outSouth;
    }

    /** Принять объём от соседнего региона в крайнюю ячейку. */
    public void receive(int side, int index, double volume) {
        if (volume <= 0) {
            return;
        }
        switch (side) {
            case BoundarySource.WEST -> {
                if (index >= 0 && index < h) {
                    depth[w * index] = clampDepth(depth[w * index] + volume / area);
                }
            }
            case BoundarySource.EAST -> {
                if (index >= 0 && index < h) {
                    depth[w - 1 + w * index] = clampDepth(depth[w - 1 + w * index] + volume / area);
                }
            }
            case BoundarySource.NORTH -> {
                if (index >= 0 && index < w) {
                    depth[index] = clampDepth(depth[index] + volume / area);
                }
            }
            case BoundarySource.SOUTH -> {
                if (index >= 0 && index < w) {
                    depth[index + w * (h - 1)] = clampDepth(depth[index + w * (h - 1)] + volume / area);
                }
            }
            default -> {
            }
        }
        massDirty = true;
        empty = false;
    }

    /** Скопировать крайние ячейки (для синхронизации шва соседей). */
    public double[] edge(int side) {
        return switch (side) {
            case BoundarySource.WEST -> {
                double[] out = new double[h];
                for (int j = 0; j < h; j++) {
                    out[j] = depth[w * j];
                }
                yield out;
            }
            case BoundarySource.EAST -> {
                double[] out = new double[h];
                for (int j = 0; j < h; j++) {
                    out[j] = depth[w - 1 + w * j];
                }
                yield out;
            }
            case BoundarySource.NORTH -> java.util.Arrays.copyOfRange(depth, 0, w);
            default -> java.util.Arrays.copyOfRange(depth, w * (h - 1), w * h);
        };
    }

    public double[] groundEdge(int side) {
        return switch (side) {
            case BoundarySource.WEST -> {
                double[] out = new double[h];
                for (int j = 0; j < h; j++) {
                    out[j] = ground[w * j];
                }
                yield out;
            }
            case BoundarySource.EAST -> {
                double[] out = new double[h];
                for (int j = 0; j < h; j++) {
                    out[j] = ground[w - 1 + w * j];
                }
                yield out;
            }
            case BoundarySource.NORTH -> java.util.Arrays.copyOfRange(ground, 0, w);
            default -> java.util.Arrays.copyOfRange(ground, w * (h - 1), w * h);
        };
    }

    /** Волновая активность - для рендера и сна. */
    public void decayWaves(double factor) {
        for (int k = 0; k < wave.length; k++) {
            wave[k] *= factor;
            waveV[k] *= factor;
        }
    }

    private double clampDepth(double d) {
        if (d < 0) {
            return 0;
        }
        return precision.quantize(d);
    }

    private static int clampCell(int v, int max) {
        if (v < 0) {
            return 0;
        }
        return v >= max ? max - 1 : v;
    }
}
