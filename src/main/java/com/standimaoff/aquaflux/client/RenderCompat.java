package com.standimaoff.aquaflux.client;

import net.minecraft.Util;

/**
 * Мягкое определение шейдеров. Никаких жёстких зависимостей: если Iris или OptiFine нет,
 * классы просто не найдутся и мод останется ванильным.
 */
public final class RenderCompat {

    private static Boolean cached;
    private static long checkedAt;

    private RenderCompat() {
    }

    /** Активен ли шейдерпак (Iris или OptiFine). */
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
        try {
            Class<?> api = Class.forName("net.irisshaders.iris.api.v0.IrisApi");
            Object instance = api.getMethod("getInstance").invoke(null);
            Object inUse = api.getMethod("isShaderPackInUse").invoke(instance);
            if (Boolean.TRUE.equals(inUse)) {
                return true;
            }
        } catch (Throwable ignored) {
            // Iris нет - это нормально
        }
        try {
            Class<?> shaders = Class.forName("net.optifine.shaders.Shaders");
            Object loaded = shaders.getField("shaderPackLoaded").get(null);
            if (Boolean.TRUE.equals(loaded)) {
                return true;
            }
        } catch (Throwable ignored) {
            // OptiFine нет - тоже нормально
        }
        return false;
    }

    /** Есть ли вообще OptiFine или Iris (без шейдеров они тоже меняют рендер). */
    public static boolean optifineOrIrisPresent() {
        return classPresent("net.optifine.Config") || classPresent("net.irisshaders.iris.Iris");
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
