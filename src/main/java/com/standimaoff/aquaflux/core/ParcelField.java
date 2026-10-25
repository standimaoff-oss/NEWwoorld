package com.standimaoff.aquaflux.core;

/**
 * «Много маленьких тел» - слой капель и брызг поверх поля высот.
 *
 * <p>Поле высот ({@link WaterGrid}) идеально для спокойной воды: озеро, река, лужа. Но у него
 * один уровень на колонку, поэтому брызги, капли в полёте, пена и волны-гребни на нём не живут.
 * Здесь появляются настоящие тела: каждая {@link Parcel} - это маленький объём воды со своей
 * массой, скоростью, площадью контакта и временем жизни. Их десятки, они сталкиваются,
 * слипаются в плёнку и снова разлетаются.</p>
 *
 * <p>Ключевое правило баланса: <b>капля либо в поле высот, либо в воздухе, но не в двух местах</b>.
 * Пока капля летит, она не учитывается в глубине ячейки. Как только она касается поверхности
 * (или дна), её объём целиком вливается в ячейку - масса не создаётся и не исчезает.
 * А когда вода в ячейке разгоняется (удар, взрыв, водопад), из неё рождаются новые капли,
 * и ровно на их объём уменьшается глубина. Итог: {@code масса поля + масса капель} постоянна
 * с точностью до прихода/ухода через край региона.</p>
 *
 * <p>Класс чистый: ни одного класса Minecraft, поэтому его гоняют и тесты, и превью-рендерер,
 * и клиент (для интерполяции).</p>
 */
public final class ParcelField {

    /** Предельное число капель в одном поле. Дальше спавн не создаёт новых, а усиливает старые. */
    public static final int DEFAULT_CAPACITY = 256;

    /** Капля: маленькое тело воды. */
    public static final class Parcel {
        /** Идентификатор - по нему клиент склеивает кадры между синхронизациями. */
        public int id;
        /** Позиция в мировых координатах (не локальных!), блоки. */
        public double x;
        public double y;
        public double z;
        /** Скорость, м/с. */
        public double vx;
        public double vy;
        public double vz;
        /** Объём, м³. 0.001 - мелкая брызга, 0.3 - крупная капля. */
        public double volume;
        /** Площадь контакта с воздухом, кв. блоки - от неё зависит сопротивление. */
        public double surface;
        /** Возраст, секунды. */
        public double age;
        /** Пена на капле, 0..1. */
        public double foam;
        /** Уже влилась в поле высот и ждёт удаления. */
        public boolean consumed;

        void reset(int id, double x, double y, double z, double volume, double surface) {
            this.id = id;
            this.x = x;
            this.y = y;
            this.z = z;
            this.vx = 0;
            this.vy = 0;
            this.vz = 0;
            this.volume = volume;
            this.surface = surface;
            this.age = 0;
            this.foam = 0;
            this.consumed = false;
        }

        /** Масса капли, кг. */
        public double mass() {
            return FluidConstants.massOf(volume);
        }

        /** Вес капли, Н. */
        public double weight(double gravity) {
            return FluidConstants.weightOf(mass(), gravity);
        }

        /** Скорость, м/с. */
        public double speed() {
            return Math.sqrt(vx * vx + vy * vy + vz * vz);
        }

        /** Радиус эквивалентного шара, блоки. */
        public double radius() {
            return Math.cbrt(3.0 * volume / (4.0 * Math.PI));
        }

        public boolean alive() {
            return !consumed && volume > 1.0e-5;
        }
    }

    private final Parcel[] pool;
    private int live;
    private int nextId = 1;

    private final double minY;
    private final double maxY;

    private double totalVolume;
    private boolean volumeDirty = true;

    /**
     * Что потерялось: позиция и объём капель, умерших вне симуляции. Копится между шагами,
     * на следующем шаге возвращается в поле высот - так масса остаётся точной.
     */
    private final double[] lostX = new double[256];
    private final double[] lostZ = new double[256];
    private final double[] lostVolume = new double[256];
    private int lostCount;

    // Настройки поведения (не конфиг, а физика слоя)
    private double joinDistance = 0.16;
    private double restSpeed = 0.35;
    private double maxAge = 45.0;
    private double airDrag = 0.55;

    public ParcelField(int capacity, double minY, double maxY) {
        int n = Math.max(8, capacity);
        this.pool = new Parcel[n];
        for (int i = 0; i < n; i++) {
            this.pool[i] = new Parcel();
        }
        this.minY = minY;
        this.maxY = maxY;
    }

    public ParcelField() {
        this(DEFAULT_CAPACITY, -320, 640);
    }

    // ---------------------------------------------------------------- состояние

    public int capacity() {
        return pool.length;
    }

    public int count() {
        return live;
    }

    public boolean isEmpty() {
        return live == 0;
    }

    public Parcel at(int index) {
        return index >= 0 && index < live ? pool[index] : null;
    }

    /** Объём всех капель, м³. */
    public double totalVolume() {
        if (volumeDirty) {
            double sum = 0;
            for (int i = 0; i < live; i++) {
                sum += pool[i].volume;
            }
            totalVolume = sum;
            volumeDirty = false;
        }
        return totalVolume;
    }

    /** Масса всех капель, кг - «вес» воды, которая сейчас в воздухе. */
    public double totalMass() {
        return FluidConstants.massOf(totalVolume());
    }

    /** Максимальная скорость среди капель, м/с. */
    public double maxSpeed() {
        double m = 0;
        for (int i = 0; i < live; i++) {
            m = Math.max(m, pool[i].speed());
        }
        return m;
    }

    public double maxFoam() {
        double m = 0;
        for (int i = 0; i < live; i++) {
            m = Math.max(m, pool[i].foam);
        }
        return m;
    }

    public void clear() {
        live = 0;
        lostCount = 0;
        volumeDirty = true;
        nextId = 1;
    }

    public void configure(double joinDistance, double restSpeed, double maxAge, double airDrag) {
        this.joinDistance = Math.max(0.05, joinDistance);
        this.restSpeed = Math.max(0.05, restSpeed);
        this.maxAge = Math.max(2.0, maxAge);
        this.airDrag = Math.max(0.0, airDrag);
    }

    // ---------------------------------------------------------------- спавн

    /**
     * Создать каплю. Если поле заполнено, капля вливается в самую близкую - вода не теряется.
     *
     * @return созданная (или усиленная) капля либо {@code null}, если некуда.
     */
    public Parcel spawn(double x, double y, double z, double vx, double vy, double vz,
                        double volume, double surface) {
        if (volume <= 0) {
            return null;
        }
        if (live >= pool.length) {
            Parcel nearest = nearest(x, z, 2.0);
            if (nearest == null) {
                return null;
            }
            // Складываем объём и импульс: масса сохраняется, тел не становится больше.
            double m1 = nearest.volume;
            double m2 = volume;
            nearest.x = (nearest.x * m1 + x * m2) / (m1 + m2);
            nearest.y = (nearest.y * m1 + y * m2) / (m1 + m2);
            nearest.z = (nearest.z * m1 + z * m2) / (m1 + m2);
            nearest.vx = (nearest.vx * m1 + vx * m2) / (m1 + m2);
            nearest.vy = (nearest.vy * m1 + vy * m2) / (m1 + m2);
            nearest.vz = (nearest.vz * m1 + vz * m2) / (m1 + m2);
            nearest.volume += volume;
            nearest.surface += surface;
            volumeDirty = true;
            return nearest;
        }
        Parcel p = pool[live++];
        p.reset(nextId++, x, y, z, volume, surface);
        p.vx = vx;
        p.vy = vy;
        p.vz = vz;
        volumeDirty = true;
        return p;
    }

    /**
     * Удар по воде: из точки расходится кольцо брызг, уже существующие капли получают импульс.
     *
     * <p>Так выглядят прыжок моба в воду, падение блока, удар весла и взрыв. Волны от удара
     * считает {@link WaterGrid#splash}, а здесь рождаются сами капли.</p>
     *
     * @param x         центр удара
     * @param y         уровень воды в точке удара
     * @param z         центр удара
     * @param radius    радиус, блоки
     * @param speed     сила удара, м/с
     * @param volume    полный объём брызг, м³ (не больше, чем реально есть в воде!)
     * @param foam      сколько пены добавить, 0..1
     * @return фактически выброшенный объём - его надо вычесть из поля высот
     */
    public double impact(double x, double y, double z, double radius, double speed,
                         double volume, double foam) {
        if (volume <= 0 || radius <= 0) {
            return 0;
        }
        // Капель много и они мелкие: 45-литровые «шары» в воздухе - это не брызги.
        // Размер капли задаётся объёмом, поэтому делим объём на мелкие порции.
        int drops = (int) Math.max(8, Math.min(160, Math.round(volume / 0.0008)));
        double each = volume / drops;
        double spawned = 0;
        for (int i = 0; i < drops; i++) {
            double angle = (i / (double) drops) * Math.PI * 2.0 + (i * 0.37);
            double r = radius * (0.45 + 0.55 * ((i * 37 % 11) / 10.0));
            double dx = Math.cos(angle);
            double dz = Math.sin(angle);
            double up = speed * (0.35 + 0.5 * ((i * 53 % 17) / 16.0));
            Parcel p = spawn(x + dx * r * 0.62, y + 0.06, z + dz * r * 0.62,
                    dx * speed * (0.45 + 0.35 * ((i * 29 % 13) / 12.0)), up,
                    dz * speed * (0.45 + 0.35 * ((i * 31 % 11) / 10.0)),
                    each, each * 3.2);
            if (p != null) {
                p.foam = Math.min(1.0, p.foam + foam);
                spawned += each;
            }
        }
        // Уже летящие капли рядом получают толчок - удар «пробивает» завесу брызг.
        for (int i = 0; i < live; i++) {
            Parcel p = pool[i];
            double dx = p.x - x;
            double dz = p.z - z;
            double d2 = dx * dx + dz * dz;
            if (d2 > radius * radius || d2 < 1.0e-6) {
                continue;
            }
            double d = Math.sqrt(d2);
            double fall = 1.0 - d / radius;
            p.vx += dx / d * speed * 0.45 * fall;
            p.vz += dz / d * speed * 0.45 * fall;
            p.vy += speed * 0.30 * fall;
            p.foam = Math.min(1.0, p.foam + foam * fall);
        }
        volumeDirty = true;
        return spawned;
    }

    /** Импульс течения каплям в пятне (ветер, поток, взрывная волна). */
    public void push(double x, double z, double vx, double vz, double radius) {
        double r2 = radius * radius;
        for (int i = 0; i < live; i++) {
            Parcel p = pool[i];
            double dx = p.x - x;
            double dz = p.z - z;
            if (dx * dx + dz * dz > r2) {
                continue;
            }
            p.vx += vx;
            p.vz += vz;
        }
    }

    // ---------------------------------------------------------------- шаг

    /**
     * Шаг полёта: гравитация, сопротивление воздуха по площади, старение, слияние.
     *
     * <p>Сопротивление не «магическое»: сила {@code F = ½·ρ_воздуха·C_d·S·v²}, ускорение
     * {@code a = F/m}. У мелкой брызги площадь приходится на крошечную массу, поэтому она
     * тормозит быстро; крупная капля летит по баллистике. Это и даёт живую картину:
     * мелкая пыль висит в воздухе, а крупные шлепки падают.</p>
     *
     * @param dt      шаг, секунды
     * @param gravity ускорение свободного падения
     */
    public void step(double dt, double gravity) {
        if (dt <= 0) {
            return;
        }
        double g = gravity > 0 ? gravity : FluidConstants.STANDARD_GRAVITY;
        double airDensity = 1.225;
        double dragCoeff = 0.47;
        for (int i = 0; i < live; i++) {
            Parcel p = pool[i];
            p.age += dt;

            double speed = p.speed();
            if (speed > 1.0e-4 && p.volume > 1.0e-6) {
                double area = Math.max(1.0e-4, p.surface);
                double force = 0.5 * airDensity * dragCoeff * area * speed * speed;
                double accel = force / FluidConstants.massOf(p.volume);
                accel = Math.min(accel, airDrag * g);
                double k = accel * dt / speed;
                p.vx -= p.vx * k;
                p.vz -= p.vz * k;
                p.vy -= p.vy * k;
            }

            p.vy -= g * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.z += p.vz * dt;

            p.foam = Math.max(0.0, p.foam - dt * 0.22);
            if (p.y > maxY + 8 || p.y < minY - 16 || p.age > maxAge) {
                recordLoss(p);
                p.consumed = true;
            }
        }
        compact();
        mergeNeighbours();
    }

    /**
     * Слить близкие капли. «Одно тело из многих маленьких»: две медленные капли рядом
     * физически должны стать одной плёнкой. Масса сохраняется точно.
     */
    public void mergeNeighbours() {
        if (live < 2) {
            return;
        }
        double join2 = joinDistance * joinDistance;
        for (int i = 0; i < live; i++) {
            Parcel a = pool[i];
            if (!a.alive()) {
                continue;
            }
            for (int j = i + 1; j < live; j++) {
                Parcel b = pool[j];
                if (!b.alive()) {
                    continue;
                }
                double dx = b.x - a.x;
                double dy = b.y - a.y;
                double dz = b.z - a.z;
                if (dx * dx + dz * dz > join2 || Math.abs(dy) > joinDistance) {
                    continue;
                }
                double m1 = a.volume;
                double m2 = b.volume;
                double m = m1 + m2;
                if (m <= 0) {
                    continue;
                }
                a.x = (a.x * m1 + b.x * m2) / m;
                a.y = (a.y * m1 + b.y * m2) / m;
                a.z = (a.z * m1 + b.z * m2) / m;
                a.vx = (a.vx * m1 + b.vx * m2) / m;
                a.vy = (a.vy * m1 + b.vy * m2) / m;
                a.vz = (a.vz * m1 + b.vz * m2) / m;
                a.volume = m;
                a.surface = Math.max(a.surface, b.surface) + Math.min(a.surface, b.surface) * 0.35;
                a.foam = Math.max(a.foam, b.foam);
                a.age = Math.min(a.age, b.age);
                b.consumed = true;
                volumeDirty = true;
            }
        }
        compact();
    }

    private void recordLoss(Parcel p) {
        if (lostCount >= lostX.length) {
            return;
        }
        lostX[lostCount] = p.x;
        lostZ[lostCount] = p.z;
        lostVolume[lostCount] = p.volume;
        lostCount++;
    }

    private void compact() {
        int w = 0;
        for (int i = 0; i < live; i++) {
            Parcel p = pool[i];
            if (p.consumed || p.volume <= 1.0e-5) {
                continue;
            }
            if (w != i) {
                Parcel tmp = pool[w];
                pool[w] = pool[i];
                pool[i] = tmp;
                p = pool[w];
            }
            w++;
        }
        live = w;
        volumeDirty = true;
    }

    // ---------------------------------------------------------------- связь с полем высот

    /**
     * Слить капли, которые коснулись воды, в поле высот. Вызывать после {@link #step}.
     *
     * <p>Слияние абсолютно простое, поэтому и точное: объём капли прибавляется к глубине
     * ячейки, капля удаляется. Никакого «наполовину в воде» - баланс массы держится
     * до последней капли.</p>
     *
     * @return объём, влитый в поле, м³
     */
    public double settleInto(WaterGrid grid, double originX, double originZ) {
        if (live == 0) {
            return 0;
        }
        double merged = 0;
        for (int i = 0; i < live; i++) {
            Parcel p = pool[i];
            double lx = p.x - originX;
            double lz = p.z - originZ;
            if (lx < 0 || lz < 0 || lx >= grid.width() * grid.cellSize() || lz >= grid.height() * grid.cellSize()) {
                continue;
            }
            double ground = grid.groundAtLocal(lx, lz);
            double depth = grid.depthAtLocal(lx, lz);
            double surface = ground + depth;
            // Капля сливается с водой, если коснулась поверхности. Если воды нет -
            // с землёй: упавшая на сухое место капля становится плёнкой, которая потом течёт.
            boolean touchedWater = depth > 1.0e-4 && p.y <= surface + 0.02;
            boolean touchedGround = p.y <= ground + 0.015;
            if (!touchedWater && !touchedGround) {
                continue;
            }
            grid.addVolumeAt(lx, lz, p.volume);
            grid.addFoamLocal(lx, lz, p.foam * 0.55, 1.1);
            merged += p.volume;
            p.consumed = true;
        }
        if (merged > 0) {
            compact();
            volumeDirty = true;
        }
        return merged;
    }

    /**
     * Спасти капли, которые улетели за пределы симуляции (упали в бездну или за край региона),
     * вернув их объём в поле высот. Нужно, чтобы «масса сохраняется» было правдой, а не
     * лозунгом: даже капля, улетевшая с водопада за край активной зоны, возвращается в воду.
     *
     * @return объём, который удалось вернуть, м³
     */
    public double recycle(WaterGrid grid, double originX, double originZ) {
        if (lostCount == 0) {
            return 0;
        }
        double returned = 0;
        double w = grid.width() * grid.cellSize();
        double h = grid.height() * grid.cellSize();
        for (int i = 0; i < lostCount; i++) {
            double lx = Math.max(0.0, Math.min(w - 1.0e-4, lostX[i] - originX));
            double lz = Math.max(0.0, Math.min(h - 1.0e-4, lostZ[i] - originZ));
            grid.addVolumeAt(lx, lz, lostVolume[i]);
            returned += lostVolume[i];
        }
        lostCount = 0;
        volumeDirty = true;
        return returned;
    }

    /** Объём, потерянный с прошлого {@link #recycle} - для отладки баланса. */
    public double pendingLoss() {
        double sum = 0;
        for (int i = 0; i < lostCount; i++) {
            sum += lostVolume[i];
        }
        return sum;
    }

    /**
     * Родить капли из воды, которая сейчас нарушает покой: гребень волны, водопад, удар.
     *
     * <p>Забирает объём из ячейки ({@code grid.removeVolume}) и создаёт капли с тем же
     * объёмом - вода не появляется из воздуха, она просто поднимается в воздух.</p>
     *
     * @param grid    поле высот
     * @param originX мировая координата левого края региона
     * @param originZ то же по Z
     * @param x       мировая X, где рождается брызг
     * @param z       мировая Z
     * @param volume  желаемый объём, м³
     * @param speed   начальная скорость вверх, м/с
     * @param vx      горизонтальная скорость
     * @param vz      горизонтальная скорость
     * @return фактически поднятый объём
     */
    public double liftFrom(WaterGrid grid, double originX, double originZ,
                           double x, double z, double volume, double speed, double vx, double vz) {
        if (volume <= 0) {
            return 0;
        }
        double lx = x - originX;
        double lz = z - originZ;
        int i = (int) Math.floor(lx / grid.cellSize());
        int j = (int) Math.floor(lz / grid.cellSize());
        if (!grid.inside(i, j)) {
            return 0;
        }
        double taken = grid.removeVolume(i, j, volume);
        if (taken <= 0) {
            return 0;
        }
        double surface = grid.ground(i, j) + grid.depth(i, j);
        int drops = taken > 0.08 ? 3 : 1;
        double each = taken / drops;
        double spawned = 0;
        for (int d = 0; d < drops; d++) {
            double ox = (d - (drops - 1) * 0.5) * 0.12;
            Parcel p = spawn(x + ox, surface + 0.05, z + ox * 0.5,
                    vx * (0.6 + 0.2 * d), speed * (0.75 + 0.25 * d), vz * (0.6 + 0.2 * d),
                    each, each * 3.5);
            if (p != null) {
                p.foam = 0.55;
                spawned += each;
            }
        }
        if (spawned < taken) {
            // некуда было деть остаток - возвращаем в воду, чтобы не потерять массу
            grid.addVolumeAt(lx, lz, taken - spawned);
        }
        volumeDirty = true;
        return spawned;
    }

    // ---------------------------------------------------------------- поиск

    public Parcel nearest(double x, double z, double maxDistance) {
        Parcel best = null;
        double bestD2 = maxDistance * maxDistance;
        for (int i = 0; i < live; i++) {
            Parcel p = pool[i];
            double dx = p.x - x;
            double dz = p.z - z;
            double d2 = dx * dx + dz * dz;
            if (d2 <= bestD2) {
                bestD2 = d2;
                best = p;
            }
        }
        return best;
    }

    /** Капля, ближайшая к точке в трёх измерениях - для столкновений (например, с игроком). */
    public Parcel nearest3d(double x, double y, double z, double maxDistance) {
        Parcel best = null;
        double bestD2 = maxDistance * maxDistance;
        for (int i = 0; i < live; i++) {
            Parcel p = pool[i];
            double dx = p.x - x;
            double dy = p.y - y;
            double dz = p.z - z;
            double d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= bestD2) {
                bestD2 = d2;
                best = p;
            }
        }
        return best;
    }

    // ---------------------------------------------------------------- сеть

    /**
     * Сжать поле в байты для сети.
     *
     * <p>Формат: {@code [count:1][id:1][flags:1][x,y,z:3×2][vx,vy,vz:3×2][vol:1][surf:1]}.
     * Позиции - в 1/32 блока (смещение от края региона), скорости - в 1/64 м/с.
     * Одна капля - 16 байт, 40 капель - 640 байт. Это дешевле одного чанка.</p>
     */
    public byte[] encode(double originX, double originZ) {
        int n = Math.min(live, 255);
        byte[] out = new byte[1 + n * 16];
        out[0] = (byte) n;
        int p = 1;
        for (int i = 0; i < n; i++) {
            Parcel d = pool[i];
            out[p] = (byte) (d.id & 0xFF);
            int flags = (int) Math.round(Math.min(1.0, Math.max(0.0, d.foam)) * 15.0);
            out[p + 1] = (byte) flags;
            p += 2;
            p = putShort(out, p, quantize(d.x - originX, 32.0));
            p = putShort(out, p, quantize(d.y, 32.0));
            p = putShort(out, p, quantize(d.z - originZ, 32.0));
            p = putShort(out, p, quantize(d.vx, 64.0));
            p = putShort(out, p, quantize(d.vy, 64.0));
            p = putShort(out, p, quantize(d.vz, 64.0));
            out[p++] = (byte) Math.max(1, Math.min(255, (int) Math.round(d.volume * 1000.0)));
            out[p++] = (byte) Math.max(1, Math.min(255, (int) Math.round(d.surface * 64.0)));
        }
        return out;
    }

    /** Принять поле из сети (на клиенте - для чисто визуального слоя брызг). */
    public void decode(byte[] data, double originX, double originZ) {
        clear();
        if (data.length < 1) {
            return;
        }
        int n = data[0] & 0xFF;
        int p = 1;
        for (int i = 0; i < n && p + 16 <= data.length; i++) {
            int id = data[p] & 0xFF;
            int flags = data[p + 1] & 0xFF;
            p += 2;
            double x = originX + readShort(data, p) / 32.0;
            p += 2;
            double y = readShort(data, p) / 32.0;
            p += 2;
            double z = originZ + readShort(data, p) / 32.0;
            p += 2;
            double vx = readShort(data, p) / 64.0;
            p += 2;
            double vy = readShort(data, p) / 64.0;
            p += 2;
            double vz = readShort(data, p) / 64.0;
            p += 2;
            double vol = (data[p] & 0xFF) / 1000.0;
            p++;
            double surf = (data[p] & 0xFF) / 64.0;
            p++;
            Parcel parcel = spawn(x, y, z, vx, vy, vz, Math.max(0.004, vol), Math.max(0.01, surf));
            if (parcel != null) {
                parcel.id = id;
                parcel.foam = flags / 15.0;
            }
        }
    }

    private static int quantize(double value, double scale) {
        int q = (int) Math.round(value * scale);
        return Math.max(-32768, Math.min(32767, q));
    }

    private static int putShort(byte[] out, int p, int value) {
        out[p] = (byte) (value >> 8);
        out[p + 1] = (byte) value;
        return p + 2;
    }

    private static int readShort(byte[] in, int p) {
        return (short) (((in[p] & 0xFF) << 8) | (in[p + 1] & 0xFF));
    }

    /** Отладочная сводка: «12 капель, 3.4 м³, 3.4 т». */
    public String describe() {
        return count() + " капель, " + FluidConstants.formatVolume(totalVolume())
                + ", " + FluidConstants.formatMass(totalMass());
    }
}
