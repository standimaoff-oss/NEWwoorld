package com.standimaoff.aquaflux.core;

/**
 * Палитра воды: чистая математика, без Minecraft.
 *
 * <p>Цвет зависит от глубины, наклона нормали и пены. Пресет точности квантует каналы
 * (16 бит - 5-6-5, 32 бита - RGBA8, 64 бита - расширенный тон).</p>
 */
public final class WaterPalette {

    /** Базовые цвета: мелководье и глубина. */
    private static final double SHALLOW_R = 0.24;
    private static final double SHALLOW_G = 0.66;
    private static final double SHALLOW_B = 0.72;
    private static final double DEEP_R = 0.02;
    private static final double DEEP_G = 0.12;
    private static final double DEEP_B = 0.30;

    private WaterPalette() {
    }

    /**
     * Цвет вершины воды.
     *
     * @param depth  толщина воды в блоке вершины
     * @param nx     нормаль X (не нормируется заново, ожидается близкой к единичной)
     * @param ny     нормаль Y
     * @param nz     нормаль Z
     * @param foam   0..1 пена
     * @param light  0..1 освещённость (лайтмапа), чтобы вода не была чёрной в темноте
     * @param precision пресет
     * @return ARGB
     */
    public static int color(double depth, double nx, double ny, double nz, double foam,
                            double light, Precision precision) {
        double t = Math.min(1.0, Math.max(0.0, depth / 3.5));
        double r = lerp(SHALLOW_R, DEEP_R, t);
        double g = lerp(SHALLOW_G, DEEP_G, t);
        double b = lerp(SHALLOW_B, DEEP_B, t);

        // Френель: у горизонтальной поверхности видно глубже, у гребней - светлее.
        double fresnel = 0.55 + 0.45 * Math.max(0.0, ny);
        // Блик от наклона волны.
        double sheen = Math.max(0.0, nx * 0.35 + nz * 0.35) * 0.25;
        r = r * fresnel + sheen;
        g = g * fresnel + sheen * 1.1;
        b = b * fresnel + sheen * 1.3;

        // Пена уходит в белый.
        double f = Math.min(1.0, foam);
        r = lerp(r, 0.90, f * 0.85);
        g = lerp(g, 0.96, f * 0.85);
        b = lerp(b, 0.98, f * 0.85);

        // Лайтмапа: без неё вода в пещере выглядела бы чёрной.
        double l = 0.35 + 0.65 * Math.min(1.0, Math.max(0.0, light));
        r *= l;
        g *= l;
        b *= l;

        if (precision == Precision.BITS64) {
            r = Math.pow(clamp01(r), 0.92);
            g = Math.pow(clamp01(g), 0.96);
            b = Math.pow(clamp01(b), 0.90);
        }

        int ri = toByte(r);
        int gi = toByte(g);
        int bi = toByte(b);

        if (precision == Precision.BITS16) {
            ri = quantize(ri, 5);
            gi = quantize(gi, 6);
            bi = quantize(bi, 5);
        }

        int alpha = (int) Math.round(168 + 52 * t - 40 * f);
        alpha = Math.max(90, Math.min(240, alpha));
        return (alpha << 24) | (ri << 16) | (gi << 8) | bi;
    }

    public static int color(double depth, double ny, Precision precision) {
        return color(depth, 0, ny, 0, 0, 1.0, precision);
    }

    private static int quantize(int value, int bits) {
        int levels = (1 << bits) - 1;
        int q = (int) Math.round(value / 255.0 * levels);
        return (int) Math.round(q * 255.0 / levels);
    }

    private static int toByte(double v) {
        int i = (int) Math.round(clamp01(v) * 255.0);
        return Math.max(0, Math.min(255, i));
    }

    private static double clamp01(double v) {
        return v < 0 ? 0 : Math.min(v, 1.0);
    }

    private static double lerp(double a, double b, double t) {
        return a + (b - a) * t;
    }
}
