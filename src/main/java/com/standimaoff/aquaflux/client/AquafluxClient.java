package com.standimaoff.aquaflux.client;

import com.standimaoff.aquaflux.Aquaflux;
import com.standimaoff.aquaflux.registry.ModFluids;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.RegisterClientExtensionsEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

/** Клиентская инициализация: внешний вид жидкости. */
@Mod.EventBusSubscriber(modid = Aquaflux.MODID, bus = Mod.EventBusSubscriber.Bus.MOD, value = Dist.CLIENT)
public final class AquafluxClient {

    private AquafluxClient() {
    }

    @SubscribeEvent
    public static void onRegisterExtensions(RegisterClientExtensionsEvent event) {
        event.registerFluidType(new PhysicalWaterClientExtensions(), ModFluids.PHYSICAL_WATER_TYPE.get());
    }
}
