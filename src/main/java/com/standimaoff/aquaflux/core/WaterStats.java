package com.standimaoff.aquaflux.core;

/**
 * Насколько «живая» вода в решении: используется для сна региона и для рендера.
 */
public final class WaterStats {

    public final double totalVolume;
    public final double maxDepth;
    public final double maxSpeed;
    public final double maxWave;
    public final int wetCells;

    public WaterStats(double totalVolume, double maxDepth, double maxSpeed, double maxWave, int wetCells) {
        this.totalVolume = totalVolume;
        this.maxDepth = maxDepth;
        this.maxSpeed = maxSpeed;
        this.maxWave = maxWave;
        this.wetCells = wetCells;
    }

    public boolean isCalm(double speedTolerance, double waveTolerance) {
        return maxSpeed < speedTolerance && maxWave < waveTolerance;
    }

    public static final WaterStats EMPTY = new WaterStats(0.0, 0.0, 0.0, 0.0, 0);
}
