package com.standimaoff.aquaflux;

import com.mojang.logging.LogUtils;
import com.standimaoff.aquaflux.registry.ModBlocks;
import com.standimaoff.aquaflux.registry.ModFluids;
import com.standimaoff.aquaflux.registry.ModItems;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.fml.ModLoadingContext;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.config.ModConfig;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;
import org.slf4j.Logger;

/**
 * Aquaflux - физическая вода для Forge 1.20.1.
 *
 * <p>Мод состоит из трёх слоёв:</p>
 * <ul>
 *   <li>{@code core} - чистый Java: конечно-объёмный решатель (масса, течение, волны),
 *       пресеты точности 16/32/64, без единого класса Minecraft. Гоняется тестами без игры.</li>
 *   <li>{@code world} - мост в мир: сэмплирование рельефа, регионы, бюджет тика, сохранения.</li>
 *   <li>{@code client} - гладкая поверхность воды (не кубы), совместимость с Iris/OptiFine.</li>
 * </ul>
 */
@Mod(Aquaflux.MODID)
public final class Aquaflux {

    public static final String MODID = "aquaflux";
    public static final String NAME = "Aquaflux";
    public static final Logger LOGGER = LogUtils.getLogger();

    public Aquaflux() {
        IEventBus modBus = FMLJavaModLoadingContext.get().getModEventBus();

        ModFluids.FLUID_TYPES.register(modBus);
        ModFluids.FLUIDS.register(modBus);
        ModBlocks.BLOCKS.register(modBus);
        ModItems.ITEMS.register(modBus);
        ModItems.TABS.register(modBus);

        ModLoadingContext.get().registerConfig(ModConfig.Type.COMMON, AquafluxConfig.SPEC, "aquaflux-common.toml");
        ModLoadingContext.get().registerConfig(ModConfig.Type.CLIENT, AquafluxConfig.CLIENT_SPEC, "aquaflux-client.toml");

        modBus.addListener(com.standimaoff.aquaflux.network.WaterNetworking::setup);
        MinecraftForge.EVENT_BUS.register(this);

        LOGGER.info("{}: физическая вода загружается", NAME);
    }
}
