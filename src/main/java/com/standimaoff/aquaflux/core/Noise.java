package com.standimaoff.aquaflux.core;

/**
 * Детерминированный шум для воды: пена, штрихи течения, неоднородность цвета.
 *
 * <p>Никаких случайных чисел - только целочисленный хэш. Поэтому клиент, сервер и
 * превью-рендерер рисуют одну и ту же воду, а картинка не «мерцает» между кадрами.
 * Класс чистый, без Minecraft.</p>
 */
public final class Noise {

    private Noise() {
    }

    /** Хэш пары целых в [0,1). */
    public static double hash(int x, int z, int seed) {
        int h = x * 374761393 + z * 668265263 + seed * 1442695041;
        h = (h ^ (h >>> 13)) * 1274126177;
        h ^= h >>> 16;
        return (h & 0x7FFFFFFF) / (double) 0x7FFFFFFF;
    }

    /** Сглаженный value-noise в точке. */
    public static double value(double x, double z, int seed) {
        int xi = (int) Math.floor(x);
        int zi = (int) Math.floor(z);
        double fx = x - xi;
        double fz = z - zi;
        double u = fx * fx * (3 - 2 * fx);
        double v = fz * fz * (3 - 2 * fz);
        double a = hash(xi, zi, seed);
        double b = hash(xi + 1, zi, seed);
        double c = hash(xi, zi + 1, seed);
        double d = hash(xi + 1, zi + 1, seed);
        return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
    }

    /** Фрактальный шум: несколько октав, амплитуда падает вдвое. */
    public static double fbm(double x, double z, int octaves, int seed) {
        double sum = 0;
        double amp = 0.5;
        double freq = 1.0;
        double norm = 0.0;
        for (int i = 0; i < octaves; i++) {
            sum += value(x * freq, z * freq, seed + i * 31) * amp;
            norm += amp;
            freq *= 2.03;
            amp *= 0.5;
        }
        return norm > 0 ? sum / norm : 0.0;
    }

    /**
     * Полосы пены: вытянутые вдоль течения волокна, как у настоящей белой воды.
     *
     * @param x     координата вдоль течения
     * @param z     поперёк
     * @param time  время, секунды - полосы текут
     */
    public static double streaks(double x, double z, double time, double scale) {
        double along = (x - time * 0.55) * scale;
        double across = z * scale * 2.4;
        double n = fbm(along, across, 3, 977);
        double ridge = Math.abs(n - 0.5) * 2.0;
        return 1.0 - Math.min(1.0, ridge * 1.25);
    }
}
