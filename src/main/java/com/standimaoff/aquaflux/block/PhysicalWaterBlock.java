package com.standimaoff.aquaflux.block;

import com.standimaoff.aquaflux.world.WaterEngine;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.RenderShape;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FlowingFluid;

/**
 * Блок физической воды.
 *
 * <p>С точки зрения игры это обычная вода (плавание, утопление, лодки, ведро), но
 * визуально блок невидим: картинку рисует гладкая поверхность на клиенте. Уровень
 * {@code level} кодирует долю заполнения верхнего блока, чтобы рендер знал высоту.</p>
 */
public class PhysicalWaterBlock extends LiquidBlock {

    public PhysicalWaterBlock(FlowingFluid fluid, Properties properties) {
        super(fluid, properties);
    }

    @Override
    public RenderShape getRenderShape(BlockState state) {
        return RenderShape.INVISIBLE;
    }

    @Override
    public void onPlace(BlockState state, Level level, BlockPos pos, BlockState oldState, boolean moving) {
        super.onPlace(state, level, pos, oldState, moving);
        if (!level.isClientSide) {
            WaterEngine.onBlockPlaced(level, pos, oldState, state);
        }
    }

    @Override
    public void onRemove(BlockState state, Level level, BlockPos pos, BlockState newState, boolean moving) {
        super.onRemove(state, level, pos, newState, moving);
        if (!level.isClientSide) {
            WaterEngine.onBlockRemoved(level, pos, state, newState);
        }
    }
}
