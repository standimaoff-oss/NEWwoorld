package com.standimaoff.aquaflux.client;

import com.standimaoff.aquaflux.core.Precision;

/**
 * Цвет воды и его квантование под выбранную битность текстуры.
 *
 * <ul>
 *   <li>16 бит - 5-6-5: заметные ступени, «ретро»-градиент;</li>
 *   <li>32 бита - RGBA8: обычная палитра;</li>
 *   <li>64 бита - расширенный тон: больше контраста в глубине и мягче блики.</li>
 * </ul>
 */
public final class WaterPalette {

    private WaterPalette() {
    }

    /** Цвет вершины: глубина в блоках, наклон нормали, точность. */
    public static int color(double depth, double ny, Precision precision) {
        double d = Math.min(1.0, Math.max(0.0, depth / 4.0));
        double shallowR = 0.19;
        double shallowG = 0.58;
        double shallowB = 0.66;
        double deepR = 0.03;
        double deepG = 0.15;
        double deepB = 0.33;

        double sky = 0.35 + 0.65 * Math.max(0.0, ny);
        double r = lerp(shallowR, deepR, d) * sky;
        double g = lerp(shallowG, deepG, d) * sky;
        double b = lerp(shallowB, deepB, d) * sky;

        if (precision == Precision.BITS64) {
            // расширенный тон: чуть больше насыщенности в глубине
            r = Math.pow(r, 0.92);
            g = Math.pow(g, 0.95);
            b = Math.pow(b, 0.88);
        }

        int ri = toByte(r);
        int gi = toByte(g);
        int bi = toByte(b);
        int alpha = (int) Math.round(150 + 70 * (1.0 - d));

        if (precision == Precision.BITS16) {
            ri = quantize(ri, 5);
            gi = quantize(gi, 6);
            bi = quantize(bi, 5);
        }
        return (alpha << 24) | (ri << 16) | (gi << 8) | bi;
    }

    private static int quantize(int value, int bits) {
        int levels = (1 << bits) - 1;
        int q = (int) Math.round(value / 255.0 * levels);
        return (int) Math.round(q * 255.0 / levels);
    }

    private static int toByte(double v) {
        int i = (int) Math.round(v * 255.0);
        return i < 0 ? 0 : Math.min(i, 255);
    }

    private static double lerp(double a, double b, double t) {
        return a + (b - a) * t;
    }
}
