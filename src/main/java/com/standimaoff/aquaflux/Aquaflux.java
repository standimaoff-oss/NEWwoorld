package com.standimaoff.aquaflux;

import com.mojang.logging.LogUtils;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.fml.common.Mod;
import org.slf4j.Logger;

/** Временная точка входа: проверяет тулчейн Forge 1.20.1 в CI. */
@Mod(Aquaflux.MODID)
public final class Aquaflux {
    public static final String MODID = "aquaflux";
    public static final String NAME = "Aquaflux";
    public static final Logger LOGGER = LogUtils.getLogger();

    public Aquaflux() {
        MinecraftForge.EVENT_BUS.register(this);
        LOGGER.info("{}: каркас загружен", NAME);
    }
}
