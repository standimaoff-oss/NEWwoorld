package com.standimaoff.aquaflux.client;

import net.minecraft.Util;

/**
 * Мягкое определение шейдеров. Никаких жёстких зависимостей: если Iris, Oculus или OptiFine
 * нет, классы просто не найдутся и мод останется ванильным.
 *
 * <p>Oculus - форж-порт Iris, поэтому API у него тот же ({@code net.irisshaders.iris.api.v0}),
 * но проверяем и альтернативные имена, чтобы не зависеть от конкретной сборки.</p>
 */
public final class RenderCompat {

    private static final String[] IRIS_API = {
            "net.irisshaders.iris.api.v0.IrisApi",
            "net.oculus.iris.api.v0.IrisApi"
    };
    private static final String[] IRIS_CORE = {
            "net.irisshaders.iris.Iris",
            "net.oculus.Oculus",
            "net.oculus.OculusApi"
    };
    private static final String[] OPTIFINE = {
            "net.optifine.shaders.Shaders",
            "net.optifine.Config"
    };

    private static Boolean cached;
    private static long checkedAt;

    private RenderCompat() {
    }

    /** Активен ли сейчас шейдерпак (Iris, Oculus или OptiFine). */
    public static boolean shadersActive() {
        long now = Util.getMillis();
        if (cached != null && now - checkedAt < 2000L) {
            return cached;
        }
        checkedAt = now;
        cached = detect();
        return cached;
    }

    private static boolean detect() {
        for (String name : IRIS_API) {
            try {
                Class<?> api = Class.forName(name);
                Object instance = api.getMethod("getInstance").invoke(null);
                Object inUse = api.getMethod("isShaderPackInUse").invoke(instance);
                if (Boolean.TRUE.equals(inUse)) {
                    return true;
                }
            } catch (Throwable ignored) {
                // Iris/Oculus нет - это нормально
            }
        }
        for (String name : OPTIFINE) {
            try {
                Class<?> shaders = Class.forName(name);
                Object loaded = shaders.getField("shaderPackLoaded").get(null);
                if (Boolean.TRUE.equals(loaded)) {
                    return true;
                }
            } catch (Throwable ignored) {
                // OptiFine нет - тоже нормально
            }
        }
        return false;
    }

    /** Есть ли вообще Iris / Oculus / OptiFine (без шейдеров они тоже меняют рендер). */
    public static boolean shaderModPresent() {
        for (String name : IRIS_CORE) {
            if (classPresent(name)) {
                return true;
            }
        }
        for (String name : OPTIFINE) {
            if (classPresent(name)) {
                return true;
            }
        }
        return false;
    }

    /** Имя найденного мода шейдеров - для отладочной строки. */
    public static String detectedName() {
        if (classPresent("net.irisshaders.iris.Iris")) {
            return "Iris";
        }
        if (classPresent("net.oculus.Oculus") || classPresent("net.oculus.iris.api.v0.IrisApi")) {
            return "Oculus";
        }
        if (classPresent("net.optifine.shaders.Shaders")) {
            return "OptiFine";
        }
        return "vanilla";
    }

    private static boolean classPresent(String name) {
        try {
            Class.forName(name);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}
