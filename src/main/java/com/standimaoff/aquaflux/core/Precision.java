package com.standimaoff.aquaflux.core;

/**
 * Точность чисел в симуляции.
 *
 * <p>Пресет задаёт, как округляются высоты и скорости после каждого шага:</p>
 * <ul>
 *   <li>{@link #BITS16} - Q8.8: шаг 1/256 блока. Меньше шума, вода «успокаивается» быстрее,
 *       регион засыпает раньше и не жжёт TPS.</li>
 *   <li>{@link #BITS32} - float (24 бита мантиссы). Рабочий режим по умолчанию.</li>
 *   <li>{@link #BITS64} - double, без округления. Для кино-скриншотов и больших напоров.</li>
 * </ul>
 *
 * <p>Тот же пресет задаёт битность цвета в рендере (см. {@code com.standimaoff.aquaflux.core.WaterPalette}):
 * 16 бит - 5-6-5, 32 бита - RGBA8, 64 бита - плавающий HDR-тон.</p>
 */
public enum Precision {

    BITS16(16, 1.0 / 256.0),
    BITS32(32, 0.0),
    BITS64(64, 0.0);

    private final int bits;
    private final double quantum;

    Precision(int bits, double quantum) {
        this.bits = bits;
        this.quantum = quantum;
    }

    public int bits() {
        return bits;
    }

    /** Шаг квантования в блоках; 0 - без квантования. */
    public double quantum() {
        return quantum;
    }

    /** Округление значения под выбранную точность. */
    public double quantize(double value) {
        if (quantum == 0.0) {
            return (float) value;
        }
        return Math.rint(value / quantum) * quantum;
    }

    /** Округление скорости: у 16-битного режима шаг мельче, чем у высот. */
    public double quantizeVelocity(double value) {
        if (quantum == 0.0) {
            return (float) value;
        }
        double q = quantum * 4.0;
        return Math.rint(value / q) * q;
    }

    /** Насколько режим «шумный»: 16-битному проще уснуть. */
    public double sleepTolerance() {
        return switch (this) {
            case BITS16 -> 2.5e-3;
            case BITS32 -> 1.0e-3;
            case BITS64 -> 4.0e-4;
        };
    }

    public static Precision byBits(int bits) {
        for (Precision p : values()) {
            if (p.bits == bits) {
                return p;
            }
        }
        return BITS32;
    }

    public static Precision byName(String name) {
        if (name == null) {
            return BITS32;
        }
        return switch (name.trim().toLowerCase()) {
            case "16", "16bit", "16-bit", "low" -> BITS16;
            case "64", "64bit", "64-bit", "ultra" -> BITS64;
            default -> BITS32;
        };
    }
}
