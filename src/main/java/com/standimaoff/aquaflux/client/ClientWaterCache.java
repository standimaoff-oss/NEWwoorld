package com.standimaoff.aquaflux.client;

import com.standimaoff.aquaflux.network.WaterSyncPacket;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.api.distmarker.OnlyIn;

import java.util.HashMap;
import java.util.Map;

/**
 * Клиентский кэш волн и пены: то, что сервер прислал для регионов вокруг игрока.
 *
 * <p>Волна хранится как байт: значение/128 блока (шаг 1/128, хватает с запасом).
 * Пена - 0..255.</p>
 */
@OnlyIn(Dist.CLIENT)
public final class ClientWaterCache {

    public static final class Field {
        public final int originX;
        public final int originZ;
        public final int samples;
        public final int step;
        public final byte[] wave;
        public final byte[] foam;

        Field(WaterSyncPacket p) {
            this.originX = p.originX;
            this.originZ = p.originZ;
            this.samples = p.samples;
            this.step = p.step;
            this.wave = p.wave;
            this.foam = p.foam;
        }

        double waveAt(int x, int z) {
            int i = (x - originX) / step;
            int j = (z - originZ) / step;
            if (i < 0 || j < 0 || i >= samples || j >= samples) {
                return 0;
            }
            int idx = i + samples * j;
            if (idx >= wave.length) {
                return 0;
            }
            return wave[idx] / 128.0;
        }

        double foamAt(int x, int z) {
            int i = (x - originX) / step;
            int j = (z - originZ) / step;
            if (i < 0 || j < 0 || i >= samples || j >= samples) {
                return 0;
            }
            int idx = i + samples * j;
            if (idx >= foam.length) {
                return 0;
            }
            return (foam[idx] & 0xFF) / 255.0;
        }
    }

    private static final Map<Long, Field> FIELDS = new HashMap<>();

    private ClientWaterCache() {
    }

    public static void accept(WaterSyncPacket packet) {
        long key = ((long) packet.regionX << 32) ^ (packet.regionZ & 0xFFFFFFFFL);
        FIELDS.put(key, new Field(packet));
    }

    public static void clear() {
        FIELDS.clear();
    }

    public static double wave(int x, int z, int regionSize) {
        Field f = fieldFor(x, z, regionSize);
        return f == null ? 0 : f.waveAt(x, z);
    }

    public static double foam(int x, int z, int regionSize) {
        Field f = fieldFor(x, z, regionSize);
        return f == null ? 0 : f.foamAt(x, z);
    }

    private static Field fieldFor(int x, int z, int regionSize) {
        int rx = Math.floorDiv(x, regionSize);
        int rz = Math.floorDiv(z, regionSize);
        long key = ((long) rx << 32) ^ (rz & 0xFFFFFFFFL);
        return FIELDS.get(key);
    }

    public static int size() {
        return FIELDS.size();
    }
}
