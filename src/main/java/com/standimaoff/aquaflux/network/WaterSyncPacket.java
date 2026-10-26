package com.standimaoff.aquaflux.network;

import net.minecraft.network.FriendlyByteBuf;
import net.minecraftforge.network.NetworkEvent;

import java.util.function.Supplier;

/**
 * Волны, пена, течение и капли региона: сервер считает физику, клиент рисует.
 *
 * <p>Передаём только визуальные поля с шагом в 2 блока - глубину клиент и так знает по блокам.
 * На регион 32×32 это 16×16 значений плюс сами капли: ~1.2 КБ, меньше одного чанка.</p>
 */
public class WaterSyncPacket {

    public final int regionX;
    public final int regionZ;
    public final int originX;
    public final int originZ;
    public final int samples;
    public final int step;
    public final byte[] wave;
    public final byte[] foam;
    /** Течение по X: значение/16 м/с. */
    public final byte[] flowU;
    /** Течение по Z: значение/16 м/с. */
    public final byte[] flowV;
    /** Капли в формате {@code ParcelField.encode}. */
    public final byte[] parcels;

    public WaterSyncPacket(int regionX, int regionZ, int originX, int originZ,
                           int samples, int step, byte[] wave, byte[] foam,
                           byte[] flowU, byte[] flowV, byte[] parcels) {
        this.regionX = regionX;
        this.regionZ = regionZ;
        this.originX = originX;
        this.originZ = originZ;
        this.samples = samples;
        this.step = step;
        this.wave = wave;
        this.foam = foam;
        this.flowU = flowU;
        this.flowV = flowV;
        this.parcels = parcels;
    }

    public static void encode(WaterSyncPacket packet, FriendlyByteBuf buf) {
        buf.writeVarInt(packet.regionX);
        buf.writeVarInt(packet.regionZ);
        buf.writeInt(packet.originX);
        buf.writeInt(packet.originZ);
        buf.writeVarInt(packet.samples);
        buf.writeVarInt(packet.step);
        buf.writeByteArray(packet.wave);
        buf.writeByteArray(packet.foam);
        buf.writeByteArray(packet.flowU);
        buf.writeByteArray(packet.flowV);
        buf.writeByteArray(packet.parcels);
    }

    public static WaterSyncPacket decode(FriendlyByteBuf buf) {
        return new WaterSyncPacket(
                buf.readVarInt(),
                buf.readVarInt(),
                buf.readInt(),
                buf.readInt(),
                buf.readVarInt(),
                buf.readVarInt(),
                buf.readByteArray(4096),
                buf.readByteArray(4096),
                buf.readByteArray(4096),
                buf.readByteArray(4096),
                buf.readByteArray(8192));
    }

    public static void handle(WaterSyncPacket packet, Supplier<NetworkEvent.Context> context) {
        NetworkEvent.Context ctx = context.get();
        ctx.enqueueWork(() -> com.standimaoff.aquaflux.client.ClientWaterCache.accept(packet));
        ctx.setPacketHandled(true);
    }
}
