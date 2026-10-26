package com.standimaoff.aquaflux.fluid;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.material.FluidState;
import net.minecraftforge.fluids.ForgeFlowingFluid;

/**
 * Сама жидкость. Ванильный {@code FlowingFluid.tick} отключён: иначе вода начала бы
 * расползаться по правилам Minecraft и снова появились бы бесконечные источники.
 *
 * <p>Глубину, течение и перенос массы считает
 * {@link com.standimaoff.aquaflux.world.WaterEngine} - и только он.</p>
 */
public final class PhysicalWaterFluid {

    private PhysicalWaterFluid() {
    }

    /** Источник: полный блок, 8/8. */
    public static class Source extends ForgeFlowingFluid.Source {
        public Source(ForgeFlowingFluid.Properties properties) {
            super(properties);
        }

        @Override
        public void tick(Level level, BlockPos pos, FluidState state) {
            // намеренно пусто - распространением владеет решатель
        }

        /**
         * Вода не должна задерживать небесный свет.
         *
         * <p>Без этого дно под водой получает нулевую лайтмапу и выглядит чёрной
         * дырой: именно эти пятна и были видны на скриншотах. Ваниль переопределяет
         * это у {@code WaterFluid}, у Forge-жидкости по умолчанию свет не проходит.</p>
         */
        @Override
        public boolean propagatesSkylightDown(FluidState state, BlockGetter reader, BlockPos pos) {
            return true;
        }
    }

    /** Текущая вода: та же жидкость, но с уровнем (для совместимости с модами). */
    public static class Flowing extends ForgeFlowingFluid.Flowing {
        public Flowing(ForgeFlowingFluid.Properties properties) {
            super(properties);
        }

        @Override
        public void tick(Level level, BlockPos pos, FluidState state) {
            // намеренно пусто - распространением владеет решатель
        }

        @Override
        public boolean propagatesSkylightDown(FluidState state, BlockGetter reader, BlockPos pos) {
            return true;
        }
    }
}
