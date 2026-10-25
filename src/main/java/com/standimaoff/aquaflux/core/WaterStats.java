package com.standimaoff.aquaflux.core;

/**
 * Насколько «живая» вода в решении: используется для сна региона, отладки и рендера.
 *
 * <p>Помимо объёма и скоростей здесь есть масса и вес - то, что пользователь просит
 * буквально: у воды есть объём, масса и вес. {@code totalVolume} - м³,
 * {@code mass()} - кг, {@code weight()} - Н.</p>
 */
public final class WaterStats {

    /** Объём воды в поле высот, м³. */
    public final double totalVolume;
    public final double maxDepth;
    public final double maxSpeed;
    public final double maxWave;
    public final int wetCells;
    /** Сколько капель и брызг в воздухе. */
    public final int parcels;
    /** Объём капель, м³. */
    public final double parcelVolume;
    /** Суммарная пена поля, 0..N. */
    public final double foam;

    public WaterStats(double totalVolume, double maxDepth, double maxSpeed, double maxWave, int wetCells) {
        this(totalVolume, maxDepth, maxSpeed, maxWave, wetCells, 0, 0.0, 0.0);
    }

    public WaterStats(double totalVolume, double maxDepth, double maxSpeed, double maxWave, int wetCells,
                      int parcels, double parcelVolume, double foam) {
        this.totalVolume = totalVolume;
        this.maxDepth = maxDepth;
        this.maxSpeed = maxSpeed;
        this.maxWave = maxWave;
        this.wetCells = wetCells;
        this.parcels = parcels;
        this.parcelVolume = parcelVolume;
        this.foam = foam;
    }

    /** Общая масса воды (поле + капли), кг. */
    public double mass() {
        return FluidConstants.massOf(totalVolume + parcelVolume);
    }

    /** Общий вес воды (поле + капли), Н. */
    public double weight() {
        return FluidConstants.weightOf(mass(), FluidConstants.STANDARD_GRAVITY);
    }

    public boolean isCalm(double speedTolerance, double waveTolerance) {
        return maxSpeed < speedTolerance && maxWave < waveTolerance && parcels == 0;
    }

    public static final WaterStats EMPTY = new WaterStats(0.0, 0.0, 0.0, 0.0, 0);
}
