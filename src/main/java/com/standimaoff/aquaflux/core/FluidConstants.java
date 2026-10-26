package com.standimaoff.aquaflux.core;

/**
 * Физические константы воды в СИ.
 *
 * <p>Мир Minecraft масштабируется как 1 блок = 1 метр, поэтому объём блока - 1 м³,
 * а масса - 1000 кг. Именно из этих чисел считается «вес» воды: ведро - это тонна.
 * В игре такая тонна не роняет игрока, но она реально участвует в давлениях, плавучести
 * и в силах течения (см. {@code WaterEngine.applyCurrent}).</p>
 *
 * <p>Класс чистый: ни одной ссылки на Minecraft, поэтому константы проверяются тестами.</p>
 */
public final class FluidConstants {

    /** Плотность пресной воды, кг/м³. */
    public static final double WATER_DENSITY = 1000.0;

    /** Кинематическая вязкость воды при 20 °C, м²/с. */
    public static final double WATER_KINEMATIC_VISCOSITY = 1.004e-6;

    /** Коэффициент поверхностного натяжения воды, Н/м. */
    public static final double WATER_SURFACE_TENSION = 0.0728;

    /** Стандартное ускорение свободного падения, м/с². */
    public static final double STANDARD_GRAVITY = 9.80665;

    /** Удельная теплоёмкость воды, Дж/(кг·К) - пригодится для льда и пара. */
    public static final double WATER_HEAT_CAPACITY = 4182.0;

    /** Масса 1 м³ воды, кг. */
    public static final double CUBIC_METER_MASS = WATER_DENSITY;

    /** Объём одного ведра Minecraft, м³ (ведро = 1 блок воды). */
    public static final double BUCKET_VOLUME = 1.0;

    /** Масса ведра воды, кг. */
    public static final double BUCKET_MASS = BUCKET_VOLUME * WATER_DENSITY;

    /** Вес ведра воды, Н. */
    public static final double BUCKET_WEIGHT = BUCKET_MASS * STANDARD_GRAVITY;

    private FluidConstants() {
    }

    /** Масса объёма, кг. */
    public static double massOf(double volume) {
        return volume * WATER_DENSITY;
    }

    /** Объём массы, м³. */
    public static double volumeOf(double massKg) {
        return massKg / WATER_DENSITY;
    }

    /** Вес массы при заданной гравитации, Н. */
    public static double weightOf(double massKg, double gravity) {
        return massKg * (gravity > 0 ? gravity : STANDARD_GRAVITY);
    }

    /** Гидростатическое давление на глубине, Па. */
    public static double pressureAt(double depth, double gravity) {
        return WATER_DENSITY * (gravity > 0 ? gravity : STANDARD_GRAVITY) * Math.max(0.0, depth);
    }

    /**
     * Число Фруда: отношение инерции к гравитации. {@code Fr > 0.8} - бурный поток,
     * на нём появляется пена и белая вода.
     */
    public static double froude(double speed, double depth, double gravity) {
        double g = gravity > 0 ? gravity : STANDARD_GRAVITY;
        double h = Math.max(1.0e-3, depth);
        return Math.abs(speed) / Math.sqrt(g * h);
    }

    /**
     * Скорость гравитационной волны на мелкой воде, м/с.
     * Именно она задаёт, как быстро расходятся круги от моба или взрыва.
     */
    public static double shallowWaveSpeed(double depth, double gravity) {
        double g = gravity > 0 ? gravity : STANDARD_GRAVITY;
        return Math.sqrt(g * Math.max(0.02, depth));
    }

    /**
     * Дисперсионное соотношение капиллярно-гравитационных волн: ω² = g·k + σ·k³/ρ.
     * Используется генератором спектра волн ({@link WaveSpectrum}).
     */
    public static double waveOmega(double waveNumber, double gravity) {
        double g = gravity > 0 ? gravity : STANDARD_GRAVITY;
        double k = Math.max(1.0e-6, waveNumber);
        return Math.sqrt(g * k + WATER_SURFACE_TENSION * k * k * k / WATER_DENSITY);
    }

    /** Длина волны по волновому числу, м. */
    public static double wavelength(double waveNumber) {
        return 2.0 * Math.PI / Math.max(1.0e-6, waveNumber);
    }

    /** Человекочитаемая масса: 1.2 т, 850 кг. */
    public static String formatMass(double massKg) {
        if (Math.abs(massKg) >= 1000.0) {
            return String.format(java.util.Locale.ROOT, "%.2f т", massKg / 1000.0);
        }
        return String.format(java.util.Locale.ROOT, "%.0f кг", massKg);
    }

    /** Человекочитаемый объём: 12.5 м³. */
    public static String formatVolume(double volume) {
        return String.format(java.util.Locale.ROOT, "%.2f м³", volume);
    }

    /** Человекочитаемый вес: 11.8 кН. */
    public static String formatWeight(double newtons) {
        if (Math.abs(newtons) >= 1000.0) {
            return String.format(java.util.Locale.ROOT, "%.2f кН", newtons / 1000.0);
        }
        return String.format(java.util.Locale.ROOT, "%.0f Н", newtons);
    }
}
