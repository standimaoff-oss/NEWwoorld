package com.standimaoff.aquaflux.core;

/**
 * Палитра воды: чистая математика, без Minecraft.
 *
 * <p>Цвет считается как у настоящей воды, а не «синенький блок»:</p>
 * <ul>
 *   <li><b>поглощение по глубине</b> - красный канал гаснет первым (закон Бугера),
 *       поэтому мель светлая и бирюзовая, а глубина уходит в сине-зелёный;</li>
 *   <li><b>Френель</b> - на скользящих углах видно отражение неба, сверху - саму толщу;</li>
 *   <li><b>гребни</b> - наклонённая вверх нормаль ловит блик;</li>
 *   <li><b>пена</b> - белая, но не чисто белая: у неё голубоватый оттенок;</li>
 *   <li><b>скорость</b> - бурный поток (большое число Фруда) пенится сам по себе;</li>
 *   <li><b>лайтмапа</b> - в пещере вода тёмная, а не чёрная.</li>
 * </ul>
 *
 * <p>Пресет точности квантует каналы: 16 бит - 5-6-5, 32 бита - RGBA8, 64 бита - расширенный тон.</p>
 */
public final class WaterPalette {

    /** Цвет мелководья - бирюза с песком на дне. */
    private static final double SHALLOW_R = 0.26;
    private static final double SHALLOW_G = 0.62;
    private static final double SHALLOW_B = 0.64;
    /** Цвет толщи - сине-зелёный, каким он и бывает метров с пяти. */
    private static final double DEEP_R = 0.055;
    private static final double DEEP_G = 0.225;
    private static final double DEEP_B = 0.370;
    /** Цвет неба для отражения на скользящих углах. */
    private static final double SKY_R = 0.62;
    private static final double SKY_G = 0.78;
    private static final double SKY_B = 0.90;

    private WaterPalette() {
    }

    /**
     * Цвет вершины воды.
     *
     * @param depth     толщина воды в блоке вершины
     * @param nx        нормаль X
     * @param ny        нормаль Y (вверх)
     * @param nz        нормаль Z
     * @param foam      0..1 пена
     * @param light     0..1 освещённость (лайтмапа)
     * @param speed     скорость течения, м/с (0 - стоячая вода)
     * @param precision пресет
     * @return ARGB
     */
    public static int color(double depth, double nx, double ny, double nz, double foam,
                            double light, double speed, Precision precision) {
        // Закон Бугера: свет проходит толщу и теряет красный первым.
        double absorbR = Math.exp(-Math.max(0.0, depth) * 0.30);
        double absorbG = Math.exp(-Math.max(0.0, depth) * 0.10);
        double absorbB = Math.exp(-Math.max(0.0, depth) * 0.06);

        // Вода у дна темнее, у поверхности - светлее: смешиваем «мель» и «толщу».
        double deepMix = 1.0 - Math.exp(-Math.max(0.0, depth) * 0.55);
        double bodyR = lerp(SHALLOW_R, DEEP_R, deepMix);
        double bodyG = lerp(SHALLOW_G, DEEP_G, deepMix);
        double bodyB = lerp(SHALLOW_B, DEEP_B, deepMix);

        // То, что видно сквозь воду: дно подсвечивает мелкую воду.
        double transmitted = 0.62 + 0.38 * absorbG;
        bodyR *= transmitted * absorbR;
        bodyG *= transmitted * absorbG;
        bodyB *= transmitted * absorbB;

        // Френель: 0.02 в лоб, почти 1 на горизонте (как у воды с n = 1.33).
        double facing = Math.max(0.0, Math.min(1.0, ny));
        double fresnel = 0.05 + 0.95 * Math.pow(1.0 - facing, 3.5);
        double reflect = fresnel * 0.85;

        double r = lerp(bodyR, SKY_R, reflect);
        double g = lerp(bodyG, SKY_G, reflect);
        double b = lerp(bodyB, SKY_B, reflect);

        // Блик от наклона гребня.
        double sheen = Math.max(0.0, nx * 0.34 + nz * 0.30) * 0.20;
        r += sheen * 0.9;
        g += sheen * 1.0;
        b += sheen * 1.15;

        // Бурный поток сам рождает пену: число Фруда выше 0.8 - белая вода.
        double froudeFoam = Math.max(0.0, Math.min(0.75, (Math.abs(speed) - 1.6) * 0.30));
        double f = Math.min(1.0, Math.max(foam, froudeFoam));

        // Пена: не кипенно-белая, а чуть голубая, как настоящая.
        r = lerp(r, 0.93, f * 0.88);
        g = lerp(g, 0.97, f * 0.88);
        b = lerp(b, 0.99, f * 0.88);

        // Лайтмапа.
        double l = 0.30 + 0.70 * Math.min(1.0, Math.max(0.0, light));
        r *= l;
        g *= l;
        b *= l;

        // 64 бита - расширенный тон: чуть контрастнее и глубже.
        if (precision == Precision.BITS64) {
            r = Math.pow(clamp01(r), 0.90);
            g = Math.pow(clamp01(g), 0.94);
            b = Math.pow(clamp01(b), 0.88);
        }

        int ri = toByte(r);
        int gi = toByte(g);
        int bi = toByte(b);

        if (precision == Precision.BITS16) {
            ri = quantize(ri, 5);
            gi = quantize(gi, 6);
            bi = quantize(bi, 5);
        }

        // Прозрачность: мелкая вода прозрачная, толща плотная, пена почти непрозрачная.
        double alpha = 168.0 + 62.0 * deepMix + 18.0 * fresnel + 26.0 * f;
        int a = (int) Math.round(Math.min(248.0, Math.max(150.0, alpha)));
        return (a << 24) | (ri << 16) | (gi << 8) | bi;
    }

    /** Вариант без скорости - для совместимости. */
    public static int color(double depth, double nx, double ny, double nz, double foam,
                            double light, Precision precision) {
        return color(depth, nx, ny, nz, foam, light, 0.0, precision);
    }

    /** Боковая грань воды: та же вода, чуть плотнее и темнее (видно толщу). */
    public static int sideColor(int argb) {
        int a = Math.min(255, ((argb >>> 24) & 0xFF) + 22);
        int r = (int) (((argb >> 16) & 0xFF) * 0.84);
        int g = (int) (((argb >> 8) & 0xFF) * 0.90);
        int b = (int) ((argb & 0xFF) * 0.95);
        return (a << 24) | (r << 16) | (g << 8) | b;
    }

    /** Цвет падающей воды: светлее и голубее толщи, потому что она перемешана с воздухом. */
    public static int fallColor(int argb) {
        int a = (int) Math.min(255, ((argb >>> 24) & 0xFF) * 0.92 + 26);
        int r = (int) (((argb >> 16) & 0xFF) * 0.80 + 34);
        int g = (int) (((argb >> 8) & 0xFF) * 0.92 + 30);
        int b = (int) ((argb & 0xFF) * 0.98 + 26);
        return (a << 24) | (toByte(r / 255.0) << 16) | (toByte(g / 255.0) << 8)
                | toByte(b / 255.0);
    }

    public static int color(double depth, double ny, Precision precision) {
        return color(depth, 0, ny, 0, 0, 1.0, 0.0, precision);
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
        return a + (b - a) * Math.min(1.0, Math.max(0.0, t));
    }
}
