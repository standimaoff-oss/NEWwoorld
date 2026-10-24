package com.standimaoff.aquaflux.network;

import com.standimaoff.aquaflux.Aquaflux;
import net.minecraft.resources.ResourceLocation;
import net.minecraftforge.fml.event.lifecycle.FMLCommonSetupEvent;
import net.minecraftforge.network.NetworkDirection;
import net.minecraftforge.network.NetworkRegistry;
import net.minecraftforge.network.simple.SimpleChannel;

/** Один канал, один пакет: волны и пена на клиент. */
public final class WaterNetworking {

    private static final String VERSION = "1";

    public static final SimpleChannel CHANNEL = NetworkRegistry.ChannelBuilder
            .named(new ResourceLocation(Aquaflux.MODID, "main"))
            .networkProtocolVersion(() -> VERSION)
            .clientAcceptedVersions(VERSION::equals)
            .serverAcceptedVersions(VERSION::equals)
            .simpleChannel();

    private WaterNetworking() {
    }

    public static void setup(FMLCommonSetupEvent event) {
        event.enqueueWork(() -> CHANNEL.messageBuilder(WaterSyncPacket.class, 0, NetworkDirection.PLAY_TO_CLIENT)
                .encoder(WaterSyncPacket::encode)
                .decoder(WaterSyncPacket::decode)
                .consumerMainThread(WaterSyncPacket::handle)
                .add());
    }
}
