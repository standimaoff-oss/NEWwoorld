package com.standimaoff.aquaflux.core;

/**
 * Параметры решателя. Все величины в блоках и секундах (1 блок = 1 м).
 *
 * <p>Объект неизменяемый: движок собирает его из конфига один раз на тик и передаёт в
 * {@link WaterGrid#step(double, SolverSettings)}.</p>
 */
public final class SolverSettings {

    /** Сторона ячейки в блоках. 0.5 - четыре ячейки на блок. */
    public final double cellSize;
    /** Ускорение свободного падения, м/с^2. */
    public final double gravity;
    /** Доля скорости, теряемая за секунду о дно на глубине 1 м. */
    public final double bedFriction;
    /** Турбулентное трение, растёт со скоростью. */
    public final double turbulence;
    /** Ниже этой глубины ячейка считается сухой и обнуляется. */
    public final double dryThreshold;
    /** Предел скорости течения, м/с. */
    public final double maxSpeed;
    /** Предел глубины в ячейке, м (защита от взрыва массива). */
    public final double maxDepth;
    /** Скорость распространения волн, м/с. */
    public final double waveSpeed;
    /** Затухание волн за секунду. */
    public final double waveDamping;
    /** Сколько подшагов максимум разрешено на один шаг. */
    public final int maxSubsteps;

    public SolverSettings(double cellSize, double gravity, double bedFriction, double turbulence,
                          double dryThreshold, double maxSpeed, double maxDepth,
                          double waveSpeed, double waveDamping, int maxSubsteps) {
        this.cellSize = cellSize;
        this.gravity = gravity;
        this.bedFriction = bedFriction;
        this.turbulence = turbulence;
        this.dryThreshold = dryThreshold;
        this.maxSpeed = maxSpeed;
        this.maxDepth = maxDepth;
        this.waveSpeed = waveSpeed;
        this.waveDamping = waveDamping;
        this.maxSubsteps = Math.max(1, maxSubsteps);
    }

    /** Рабочий профиль «2-4 игрока»: 0.5 блока, умеренное трение, волны от игрока. */
    public static SolverSettings balanced() {
        return new SolverSettings(
                0.5,      // cellSize
                9.81,     // gravity
                0.12,     // bedFriction
                0.02,     // turbulence
                1.0e-3,   // dryThreshold
                9.0,      // maxSpeed
                32.0,     // maxDepth
                4.5,      // waveSpeed
                0.55,     // waveDamping
                6         // maxSubsteps
        );
    }

    public SolverSettings withCellSize(double size) {
        return new SolverSettings(size, gravity, bedFriction, turbulence, dryThreshold,
                maxSpeed, maxDepth, waveSpeed, waveDamping, maxSubsteps);
    }

    public SolverSettings withWaves(double speed, double damping) {
        return new SolverSettings(cellSize, gravity, bedFriction, turbulence, dryThreshold,
                maxSpeed, maxDepth, speed, damping, maxSubsteps);
    }
}
