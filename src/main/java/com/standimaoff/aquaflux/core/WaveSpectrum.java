package com.standimaoff.aquaflux.core;

/**
 * Спектр ветровых волн - «мелкая рябь», которую видно на поверхности.
 *
 * <p>Это не декоративный синус: каждая компонента берётся из реального дисперсионного
 * соотношения капиллярно-гравитационных волн {@code ω² = g·k + σ·k³/ρ} с поправкой на
 * глубину {@code tanh(k·h)}. Поэтому короткие волны (рябь) бегут медленнее длинных,
 * а на мелководье весь спектр замедляется - как в настоящей воде.</p>
 *
 * <p>Амплитуды нормируются: суммарная высота гребня не может превысить
 * {@link #maxAmplitude()}. Волны визуальные - массу они не переносят, поэтому не могут
 * «сломать» баланс решателя. Спектр полностью детерминированный: одинаковый seed даёт
 * одинаковую воду на клиенте, сервере и в превью.</p>
 */
public final class WaveSpectrum {

    /** Сколько компонент по умолчанию. 6 - уже читается как живая вода. */
    public static final int DEFAULT_COMPONENTS = 6;

    private final int count;
    private final double[] dirX;
    private final double[] dirZ;
    private final double[] waveNumber;
    private final double[] omega;
    private final double[] amplitude;
    private final double[] phase;
    private final double[] steepness;
    private final double maxAmplitude;

    private WaveSpectrum(int count) {
        this.count = count;
        this.dirX = new double[count];
        this.dirZ = new double[count];
        this.waveNumber = new double[count];
        this.omega = new double[count];
        this.amplitude = new double[count];
        this.phase = new double[count];
        this.steepness = new double[count];
        this.maxAmplitude = 1.0;
    }

    /**
     * Построить спектр.
     *
     * @param windSpeed   скорость ветра, м/с (0 - штиль, 12 - свежий ветер)
     * @param depth       глубина воды, м
     * @param seed        зерно (разные озёра - разные фазы)
     * @param components  число волн, 1..12
     */
    public static WaveSpectrum wind(double windSpeed, double depth, int seed, int components) {
        int n = Math.max(1, Math.min(12, components));
        WaveSpectrum s = new WaveSpectrum(n);
        double wind = Math.max(0.05, windSpeed);
        double h = Math.max(0.1, depth);

        // Длинные волны появляются от больших скоростей ветра: λ_max ~ 2π·U²/g.
        double maxWavelength = Math.min(16.0, Math.max(1.4, 2.0 * Math.PI * wind * wind
                / FluidConstants.STANDARD_GRAVITY));
        // Самая короткая волна не мельче 1.8 блока: иначе на сетке 0.5 блока она
        // превращается в шум. Такая рябь всё равно видна по наклону нормалей.
        double minWavelength = 1.8;

        // Нормируем не амплитуду, а крутизну: у настоящей воды мелкая рябь почти плоская
        // по высоте, но крутая по наклону - именно поэтому она блестит.
        double windFactor = Math.min(1.8, wind / 6.0);
        double total = 0.0;
        for (int i = 0; i < n; i++) {
            double t = n == 1 ? 0.0 : i / (double) (n - 1);
            // Геометрическая прогрессия длин волн: короткая рябь + длинная зыбь.
            double wavelength = minWavelength * Math.pow(maxWavelength / minWavelength, t);
            double k = 2.0 * Math.PI / wavelength;
            s.waveNumber[i] = k;
            s.omega[i] = FluidConstants.waveOmega(k, FluidConstants.STANDARD_GRAVITY)
                    * Math.sqrt(Math.tanh(Math.min(3.0, k * h)));

            double angle = s.directionOf(i, seed) * 0.9;
            s.dirX[i] = Math.cos(angle);
            s.dirZ[i] = Math.sin(angle);
            s.phase[i] = 2.0 * Math.PI * hash(seed * 131 + i * 17, i * 7 + 3);

            // Крутизна компоненты: длинные волны круче, короткая рябь почти не влияет на высоту.
            double steep = 0.075 * windFactor * (0.55 + 0.75 * t);
            double amp = steep / k;
            s.amplitude[i] = amp;
            s.steepness[i] = steep;
            total += amp;
        }

        // Высоту всё же ограничиваем: в игре волна не должна «съедать» берег.
        double limit = Math.min(0.45, 0.030 + 0.030 * wind);
        if (total > 1.0e-9) {
            double scale = Math.min(1.0, limit / total);
            for (int i = 0; i < n; i++) {
                s.amplitude[i] *= scale;
                s.steepness[i] = s.amplitude[i] * s.waveNumber[i];
            }
        }
        return s;
    }

    /** Полный штиль: спектр без амплитуд. */
    public static WaveSpectrum calm() {
        return wind(0.05, 4.0, 0, DEFAULT_COMPONENTS);
    }

    private double directionOf(int i, int seed) {
        double base = -0.6 + 1.2 * hash(seed * 31 + i, seed + 11);
        return base;
    }

    private static double hash(int a, int b) {
        double v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
        return v - Math.floor(v);
    }

    public int components() {
        return count;
    }

    /** Суммарная максимальная амплитуда - столько волне разрешено поднять поверхность. */
    public double maxAmplitude() {
        double sum = 0;
        for (double a : amplitude) {
            sum += a;
        }
        return sum;
    }

    /** Высота поверхности от ветровых волн в точке, м. */
    public double height(double x, double z, double time) {
        double y = 0.0;
        for (int i = 0; i < count; i++) {
            double k = waveNumber[i];
            double phaseArg = k * (dirX[i] * x + dirZ[i] * z) - omega[i] * time + phase[i];
            y += amplitude[i] * Math.sin(phaseArg);
        }
        return y;
    }

    /** Наклон dY/dX - для нормалей и бликов. */
    public double slopeX(double x, double z, double time) {
        double y = 0.0;
        for (int i = 0; i < count; i++) {
            double k = waveNumber[i];
            double phaseArg = k * (dirX[i] * x + dirZ[i] * z) - omega[i] * time + phase[i];
            y += amplitude[i] * k * dirX[i] * Math.cos(phaseArg);
        }
        return y;
    }

    /** Наклон dY/dZ. */
    public double slopeZ(double x, double z, double time) {
        double y = 0.0;
        for (int i = 0; i < count; i++) {
            double k = waveNumber[i];
            double phaseArg = k * (dirX[i] * x + dirZ[i] * z) - omega[i] * time + phase[i];
            y += amplitude[i] * k * dirZ[i] * Math.cos(phaseArg);
        }
        return y;
    }

    /**
     * Крутизна в точке: если поверхность становится слишком «острой»,
     * там образуются барашки - то же условие выполняется в пене.
     */
    public double steepnessAt(double x, double z, double time) {
        double sx = slopeX(x, z, time);
        double sz = slopeZ(x, z, time);
        return Math.sqrt(sx * sx + sz * sz);
    }

    /**
     * Есть ли в точке барашек (белая пена от крутой волны).
     *
     * <p>Порог не «на глаз»: барашек появляется там, где суммарная крутизна гребня
     * подходит к пределу 1/7, при котором гребень обрушивается. Даже в свежий ветер
     * пена занимает считанные проценты площади - как на настоящей воде.</p>
     */
    public double whitecap(double x, double z, double time) {
        double steep = steepnessAt(x, z, time);
        return Math.max(0.0, Math.min(1.0, (steep - 0.150) * 3.2));
    }
}
