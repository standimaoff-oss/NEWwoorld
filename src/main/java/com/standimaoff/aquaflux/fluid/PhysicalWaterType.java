package com.standimaoff.aquaflux.fluid;

import com.standimaoff.aquaflux.client.PhysicalWaterClientExtensions;
import net.minecraft.sounds.SoundEvents;
import net.minecraftforge.client.extensions.common.IClientFluidTypeExtensions;
import net.minecraftforge.common.SoundActions;
import net.minecraftforge.fluids.FluidType;

import java.util.function.Consumer;

/**
 * Тип жидкости: плотность и вязкость как у воды, но без превращения в источник.
 */
public class PhysicalWaterType extends FluidType {

    public static final FluidType.Properties PROPERTIES = FluidType.Properties.create()
            .density(1000)
            .viscosity(1000)
            .temperature(300)
            .canConvertToSource(false)
            .canDrown(true)
            .canSwim(true)
            .canPushEntity(true)
            .canHydrate(true)
            .canExtinguish(true)
            .supportsBoating(true)
            .motionScale(0.014)
            .fallDistanceModifier(0.0F)
            .sound(SoundActions.BUCKET_FILL, SoundEvents.BUCKET_FILL)
            .sound(SoundActions.BUCKET_EMPTY, SoundEvents.BUCKET_EMPTY);

    public PhysicalWaterType() {
        super(PROPERTIES);
    }

    @Override
    public void initializeClient(Consumer<IClientFluidTypeExtensions> consumer) {
        consumer.accept(new PhysicalWaterClientExtensions());
    }
}
