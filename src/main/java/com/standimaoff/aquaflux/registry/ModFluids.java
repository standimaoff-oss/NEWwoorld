package com.standimaoff.aquaflux.registry;

import com.standimaoff.aquaflux.Aquaflux;
import com.standimaoff.aquaflux.fluid.PhysicalWaterFluid;
import com.standimaoff.aquaflux.fluid.PhysicalWaterType;
import net.minecraft.world.level.material.FlowingFluid;
import net.minecraft.world.level.material.Fluid;
import net.minecraftforge.fluids.FluidType;
import net.minecraftforge.fluids.ForgeFlowingFluid;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;

/**
 * Регистрация жидкости.
 *
 * <p>Жидкость полностью пассивна: {@code tick()} не делает ничего, распространением владеет
 * {@link com.standimaoff.aquaflux.world.WaterEngine}. Поэтому у неё физически не может появиться
 * бесконечный источник - массу двигает только решатель.</p>
 */
public final class ModFluids {

    public static final DeferredRegister<FluidType> FLUID_TYPES =
            DeferredRegister.create(ForgeRegistries.Keys.FLUID_TYPES, Aquaflux.MODID);
    public static final DeferredRegister<Fluid> FLUIDS =
            DeferredRegister.create(ForgeRegistries.FLUIDS, Aquaflux.MODID);

    public static final RegistryObject<FluidType> PHYSICAL_WATER_TYPE =
            FLUID_TYPES.register("physical_water", PhysicalWaterType::new);

    public static final RegistryObject<FlowingFluid> SOURCE =
            FLUIDS.register("physical_water", () -> new PhysicalWaterFluid.Source(properties()));
    public static final RegistryObject<FlowingFluid> FLOWING =
            FLUIDS.register("physical_water_flowing", () -> new PhysicalWaterFluid.Flowing(properties()));

    private static ForgeFlowingFluid.Properties properties;

    public static ForgeFlowingFluid.Properties properties() {
        if (properties == null) {
            properties = new ForgeFlowingFluid.Properties(PHYSICAL_WATER_TYPE, SOURCE, FLOWING)
                    .block(ModBlocks.PHYSICAL_WATER)
                    .bucket(ModItems.PHYSICAL_WATER_BUCKET)
                    .slopeFindDistance(4)
                    .levelDecreasePerBlock(1)
                    .tickRate(5)
                    .explosionResistance(100.0F)
                    .canConvertToSource(false);
        }
        return properties;
    }

    private ModFluids() {
    }
}
