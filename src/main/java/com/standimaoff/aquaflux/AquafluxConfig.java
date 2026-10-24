package com.standimaoff.aquaflux;

import com.standimaoff.aquaflux.core.Precision;
import net.minecraftforge.common.ForgeConfigSpec;

/**
 * Конфиги мода.
 *
 * <p>COMMON - физика и мир (одинаково на сервере и клиенте в одиночной игре).
 * CLIENT - только внешний вид: гладкость поверхности, битность текстуры, совместимость с шейдерами.</p>
 *
 * <p>Пресет точности один на физику и на текстуру, но задаётся двумя ключами: игрок может держать
 * физику 16-битной ради TPS, а текстуру 64-битной ради картинки.</p>
 */
public final class AquafluxConfig {

    public static final ForgeConfigSpec SPEC;
    public static final ForgeConfigSpec CLIENT_SPEC;

    // ---------------------------------------------------------------- COMMON

    public static final ForgeConfigSpec.EnumValue<Precision> PHYSICS_PRECISION;
    public static final ForgeConfigSpec.BooleanValue REPLACE_VANILLA;
    public static final ForgeConfigSpec.BooleanValue ENABLED;
    public static final ForgeConfigSpec.DoubleValue CELL_SIZE;
    public static final ForgeConfigSpec.IntValue ACTIVE_RADIUS;
    public static final ForgeConfigSpec.IntValue REGIONS_PER_TICK;
    public static final ForgeConfigSpec.IntValue REGION_SIZE;
    public static final ForgeConfigSpec.DoubleValue WAVE_STRENGTH;
    public static final ForgeConfigSpec.BooleanValue PLAYER_WAVES;
    public static final ForgeConfigSpec.DoubleValue GRAVITY;
    public static final ForgeConfigSpec.DoubleValue BED_FRICTION;
    public static final ForgeConfigSpec.DoubleValue MAX_DEPTH;
    public static final ForgeConfigSpec.IntValue CONVERT_PER_TICK;
    public static final ForgeConfigSpec.DoubleValue BUOYANCY;
    public static final ForgeConfigSpec.IntValue SYNC_INTERVAL;
    public static final ForgeConfigSpec.BooleanValue EXPLOSION_PARTICLES;
    public static final ForgeConfigSpec.DoubleValue FOAM_STRENGTH;

    // ---------------------------------------------------------------- CLIENT

    public static final ForgeConfigSpec.EnumValue<Precision> TEXTURE_PRECISION;
    public static final ForgeConfigSpec.BooleanValue SMOOTH_SURFACE;
    public static final ForgeConfigSpec.IntValue SMOOTH_RADIUS;
    public static final ForgeConfigSpec.IntValue REBUILD_INTERVAL;
    public static final ForgeConfigSpec.DoubleValue WAVE_VISUAL;
    public static final ForgeConfigSpec.EnumValue<ShaderMode> SHADER_MODE;
    public static final ForgeConfigSpec.BooleanValue SHOW_DEBUG;

    public enum ShaderMode {
        /** Авто: Iris/OptiFine с шейдерами - отдать воду шейдерпаку. */
        AUTO,
        /** Всегда рисовать свой гладкий меш. */
        FORCE_SMOOTH,
        /** Никогда не рисовать свой меш (ванильный вид, вода как блоки). */
        VANILLA
    }

    static {
        ForgeConfigSpec.Builder b = new ForgeConfigSpec.Builder();

        b.comment("Физика воды").push("physics");
        ENABLED = b.comment("Включить симуляцию физической воды")
                .define("enabled", true);
        PHYSICS_PRECISION = b.comment("Точность физики: BITS16 (Q8.8), BITS32 (float), BITS64 (double)")
                .defineEnum("precision", Precision.BITS32);
        CELL_SIZE = b.comment("Сторона ячейки симуляции в блоках: 1.0 грубо, 0.5 обычно, 0.25 точно")
                .defineInRange("cellSize", 0.5, 0.25, 1.0);
        GRAVITY = b.comment("Ускорение свободного падения, м/с^2")
                .defineInRange("gravity", 9.81, 1.0, 30.0);
        BED_FRICTION = b.comment("Трение о дно: больше - вода спокойнее")
                .defineInRange("bedFriction", 0.12, 0.0, 2.0);
        MAX_DEPTH = b.comment("Предел глубины в одной ячейке, блоков")
                .defineInRange("maxDepth", 32.0, 1.0, 128.0);
        b.pop();

        b.comment("Мир и производительность").push("world");
        REPLACE_VANILLA = b.comment("ЗАМЕНА ВАНИЛЬНОЙ ВОДЫ: постепенно превращать ванильные источники рядом с игроком",
                        "в физическую воду. По умолчанию выключено - мод живёт со своим ведром и блоком.")
                .define("replaceVanillaWater", false);
        CONVERT_PER_TICK = b.comment("Сколько ванильных блоков воды конвертировать за тик при замене")
                .defineInRange("convertPerTick", 64, 1, 4096);
        ACTIVE_RADIUS = b.comment("Радиус активной симуляции вокруг игрока, блоков")
                .defineInRange("activeRadius", 48, 16, 128);
        REGION_SIZE = b.comment("Сторона региона симуляции, блоков")
                .defineInRange("regionSize", 32, 16, 64);
        REGIONS_PER_TICK = b.comment("Сколько регионов считать за тик (бюджет TPS)")
                .defineInRange("regionsPerTick", 4, 1, 64);
        b.pop();

        b.comment("Сущности на волнах").push("entities");
        BUOYANCY = b.comment("Насколько игроки, мобы и лодки качаются на волнах: 0 - выключено, 1 - обычно, 2 - шторм")
                .defineInRange("buoyancy", 1.0, 0.0, 2.0);
        b.pop();

        b.comment("Взрывы и пена").push("effects");
        EXPLOSION_PARTICLES = b.comment("Брызги и пузыри от взрывов в воде")
                .define("explosionParticles", true);
        FOAM_STRENGTH = b.comment("Множитель пены у берега и от взрывов")
                .defineInRange("foamStrength", 1.0, 0.0, 3.0);
        SYNC_INTERVAL = b.comment("Как часто отправлять волны и пену клиентам, тиков (4 - 5 раз в секунду)")
                .defineInRange("syncInterval", 4, 1, 40);
        b.pop();

        b.comment("Волны").push("waves");
        PLAYER_WAVES = b.comment("Волны и следы от игроков, лодок и мобов")
                .define("fromEntities", true);
        WAVE_STRENGTH = b.comment("Сила волн от игрока: 0 - нет, 1 - заметная рябь, 2 - шторм")
                .defineInRange("strength", 0.45, 0.0, 2.0);
        b.pop();

        SPEC = b.build();

        ForgeConfigSpec.Builder c = new ForgeConfigSpec.Builder();

        c.comment("Поверхность воды").push("surface");
        SMOOTH_SURFACE = c.comment("Рисовать гладкую поверхность вместо кубов")
                .define("smooth", true);
        SMOOTH_RADIUS = c.comment("Радиус построения гладкой поверхности, блоков")
                .defineInRange("radius", 20, 8, 64);
        REBUILD_INTERVAL = c.comment("Перестраивать меш каждые N кадров (1 - каждый кадр)")
                .defineInRange("rebuildInterval", 3, 1, 20);
        TEXTURE_PRECISION = c.comment("Битность текстуры воды: 16 (5-6-5), 32 (RGBA8), 64 (HDR-тон)")
                .defineEnum("texturePrecision", Precision.BITS32);
        WAVE_VISUAL = c.comment("Множитель видимости волн")
                .defineInRange("visualStrength", 1.0, 0.0, 3.0);
        c.pop();

        c.comment("Совместимость").push("compat");
        SHADER_MODE = c.comment("AUTO - подстраиваться под Iris/OptiFine, FORCE_SMOOTH - всегда свой меш, VANILLA - без меша")
                .defineEnum("shaderMode", ShaderMode.AUTO);
        SHOW_DEBUG = c.comment("Показывать отладочную строку воды (F3-стиль)")
                .define("debug", false);
        c.pop();

        CLIENT_SPEC = c.build();
    }

    private AquafluxConfig() {
    }

    private static boolean ready(ForgeConfigSpec spec) {
        return spec.isLoaded();
    }

    public static Precision physicsPrecision() {
        return ready(SPEC) ? PHYSICS_PRECISION.get() : Precision.BITS32;
    }

    public static Precision texturePrecision() {
        return ready(CLIENT_SPEC) ? TEXTURE_PRECISION.get() : Precision.BITS32;
    }

    public static boolean enabled() {
        return !ready(SPEC) || ENABLED.get();
    }

    public static boolean replaceVanilla() {
        return ready(SPEC) && REPLACE_VANILLA.get();
    }

    public static double cellSize() {
        return ready(SPEC) ? CELL_SIZE.get() : 0.5;
    }

    public static int activeRadius() {
        return ready(SPEC) ? ACTIVE_RADIUS.get() : 48;
    }

    public static int regionSize() {
        return ready(SPEC) ? REGION_SIZE.get() : 32;
    }

    public static int regionsPerTick() {
        return ready(SPEC) ? REGIONS_PER_TICK.get() : 4;
    }

    public static double waveStrength() {
        return ready(SPEC) ? WAVE_STRENGTH.get() : 0.45;
    }

    public static boolean playerWaves() {
        return !ready(SPEC) || PLAYER_WAVES.get();
    }

    public static double gravity() {
        return ready(SPEC) ? GRAVITY.get() : 9.81;
    }

    public static double bedFriction() {
        return ready(SPEC) ? BED_FRICTION.get() : 0.12;
    }

    public static double maxDepth() {
        return ready(SPEC) ? MAX_DEPTH.get() : 32.0;
    }

    public static double buoyancy() {
        return ready(SPEC) ? BUOYANCY.get() : 1.0;
    }

    public static int syncInterval() {
        return ready(SPEC) ? SYNC_INTERVAL.get() : 4;
    }

    public static boolean explosionParticles() {
        return !ready(SPEC) || EXPLOSION_PARTICLES.get();
    }

    public static double foamStrength() {
        return ready(SPEC) ? FOAM_STRENGTH.get() : 1.0;
    }

    public static int convertPerTick() {
        return ready(SPEC) ? CONVERT_PER_TICK.get() : 64;
    }

    public static boolean smoothSurface() {
        return !ready(CLIENT_SPEC) || SMOOTH_SURFACE.get();
    }

    public static int smoothRadius() {
        return ready(CLIENT_SPEC) ? SMOOTH_RADIUS.get() : 20;
    }

    public static int rebuildInterval() {
        return ready(CLIENT_SPEC) ? REBUILD_INTERVAL.get() : 3;
    }

    public static double waveVisual() {
        return ready(CLIENT_SPEC) ? WAVE_VISUAL.get() : 1.0;
    }

    public static ShaderMode shaderMode() {
        return ready(CLIENT_SPEC) ? SHADER_MODE.get() : ShaderMode.AUTO;
    }

    public static boolean showDebug() {
        return ready(CLIENT_SPEC) && SHOW_DEBUG.get();
    }
}
