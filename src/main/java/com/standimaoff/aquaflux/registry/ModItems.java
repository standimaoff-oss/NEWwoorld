package com.standimaoff.aquaflux.registry;

import com.standimaoff.aquaflux.Aquaflux;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.BucketItem;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;

public final class ModItems {

    public static final DeferredRegister<Item> ITEMS =
            DeferredRegister.create(ForgeRegistries.ITEMS, Aquaflux.MODID);

    /**
     * Отдельное ведро физической воды - «обычный» путь мода: ванильная вода остаётся как была,
     * а физическая живёт своей жизнью. Полная замена включается в конфиге.
     */
    public static final RegistryObject<Item> PHYSICAL_WATER_BUCKET = ITEMS.register("physical_water_bucket",
            () -> new BucketItem(ModFluids.SOURCE, new Item.Properties()
                    .stacksTo(1)
                    .craftRemainder(Items.BUCKET)));

    public static final DeferredRegister<CreativeModeTab> TABS =
            DeferredRegister.create(Registries.CREATIVE_MODE_TAB, Aquaflux.MODID);

    public static final RegistryObject<CreativeModeTab> TAB = TABS.register("aquaflux",
            () -> CreativeModeTab.builder()
                    .title(Component.translatable("itemGroup.aquaflux"))
                    .icon(() -> new ItemStack(PHYSICAL_WATER_BUCKET.get()))
                    .displayItems((params, output) -> output.accept(PHYSICAL_WATER_BUCKET.get()))
                    .build());

    private ModItems() {
    }
}
