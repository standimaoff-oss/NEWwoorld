package com.standimaoff.aquaflux.client;

import com.standimaoff.aquaflux.core.ParcelField;
import com.standimaoff.aquaflux.network.WaterSyncPacket;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.api.distmarker.OnlyIn;

import java.util.HashMap;
import java.util.Map;

/**
 * Клиентский кэш того, что сервер прислал для регионов вокруг игрока: волны, пена,
 * течение и капли.
 *
 * <p>Сжатие: волна - байт (значение/128 блока), пена - 0..255, течение - байт (значение/16 м/с).
 * Капли хранятся своим полем - клиент дошагивает их той же физикой, что и сервер, поэтому
 * между пакетами брызги не «телепортируются».</p>
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
        public final byte[] flowU;
        public final byte[] flowV;
        public final ParcelField parcels;
        /** Высота поверхности, {@code (y + 64) * 32}; 0 - данных нет. */
        public final byte[] surface;

        Field(WaterSyncPacket p) {
            this.originX = p.originX;
            this.originZ = p.originZ;
            this.samples = p.samples;
            this.step = p.step;
            this.wave = p.wave;
            this.foam = p.foam;
            this.flowU = p.flowU;
            this.flowV = p.flowV;
            this.surface = p.surface;
            // Те же границы, что и на сервере: вода бывает и под нулём.
            this.parcels = new ParcelField(ParcelField.DEFAULT_CAPACITY, -320, 640);
            if (p.parcels != null && p.parcels.length > 1) {
                this.parcels.decode(p.parcels, originX, originZ);
            }
        }

        int index(int x, int z) {
            int i = Math.floorDiv(x - originX, step);
            int j = Math.floorDiv(z - originZ, step);
            if (i < 0 || j < 0 || i >= samples || j >= samples) {
                return -1;
            }
            int idx = i + samples * j;
            return idx < wave.length ? idx : -1;
        }

        double waveAt(int x, int z) {
            int idx = index(x, z);
            return idx < 0 ? 0 : wave[idx] / 128.0;
        }

        double foamAt(int x, int z) {
            int idx = index(x, z);
            return idx < 0 ? 0 : (foam[idx] & 0xFF) / 255.0;
        }

        /** Высота поверхности по серверу или {@code NaN}, если данных нет. */
        double surfaceAt(double x, double z) {
            return heightAt(x, z, 0);
        }

        /** Дно воды по серверу или {@code NaN}, если данных нет. */
        double bedAt(double x, double z) {
            return heightAt(x, z, 2);
        }

        private double heightAt(double x, double z, int offset) {
            if (surface == null || surface.length < samples * samples * 4) {
                return Double.NaN;
            }
            int i = (int) Math.floor((x - originX) / step);
            int j = (int) Math.floor((z - originZ) / step);
            if (i < 0 || j < 0 || i >= samples || j >= samples) {
                return Double.NaN;
            }
            int idx = (i + samples * j) * 4 + offset;
            int q = ((surface[idx] & 0xFF) << 8) | (surface[idx + 1] & 0xFF);
            return q == 0 ? Double.NaN : q / 32.0 - 64.0;
        }

        double flowUAt(int x, int z) {
            int idx = index(x, z);
            return idx < 0 ? 0 : flowU[idx] / 16.0;
        }

        double flowVAt(int x, int z) {
            int idx = index(x, z);
            return idx < 0 ? 0 : flowV[idx] / 16.0;
        }
    }

    private static final Map<Long, Field> FIELDS = new HashMap<>();
    /** Когда пришёл пакет по региону - чтобы выкидывать мёртвые регионы. */
    private static final Map<Long, Long> STAMPS = new HashMap<>();
    private static long now;

    private ClientWaterCache() {
    }

    public static void accept(WaterSyncPacket packet) {
        long key = ((long) packet.regionX << 32) ^ (packet.regionZ & 0xFFFFFFFFL);
        FIELDS.put(key, new Field(packet));
        STAMPS.put(key, now);
    }

    public static void clear() {
        FIELDS.clear();
        STAMPS.clear();
    }

    /** Раз в секунду: старые регионы (дальше 4 секунд молчания) удаляются. */
    public static void tick(long gameTime) {
        now = gameTime;
        if (FIELDS.isEmpty()) {
            return;
        }
        java.util.Iterator<Map.Entry<Long, Long>> it = STAMPS.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<Long, Long> e = it.next();
            if (now - e.getValue() > 80L) {
                FIELDS.remove(e.getKey());
                it.remove();
            }
        }
    }

    public static int size() {
        return FIELDS.size();
    }

    public static double wave(int x, int z, int regionSize) {
        Field f = fieldFor(x, z, regionSize);
        return f == null ? 0 : f.waveAt(x, z);
    }

    public static double foam(int x, int z, int regionSize) {
        Field f = fieldFor(x, z, regionSize);
        return f == null ? 0 : f.foamAt(x, z);
    }

    /** Высота поверхности воды рядом с точкой (с сервера). */
    public static double surface(double x, double z, int regionSize) {
        Field f = fieldFor((int) Math.floor(x), (int) Math.floor(z), regionSize);
        return f == null ? Double.NaN : f.surfaceAt(x, z);
    }

    /** Дно воды рядом с точкой (с сервера). */
    public static double bed(double x, double z, int regionSize) {
        Field f = fieldFor((int) Math.floor(x), (int) Math.floor(z), regionSize);
        return f == null ? Double.NaN : f.bedAt(x, z);
    }

    public static double flowU(int x, int z, int regionSize) {
        Field f = fieldFor(x, z, regionSize);
        return f == null ? 0 : f.flowUAt(x, z);
    }

    public static double flowV(int x, int z, int regionSize) {
        Field f = fieldFor(x, z, regionSize);
        return f == null ? 0 : f.flowVAt(x, z);
    }

    /** Поля всех регионов рядом - для отрисовки капель. */
    public static Map<Long, Field> fields() {
        return FIELDS;
    }

    public static Field fieldFor(int x, int z, int regionSize) {
        int rx = Math.floorDiv(x, regionSize);
        int rz = Math.floorDiv(z, regionSize);
        long key = ((long) rx << 32) ^ (rz & 0xFFFFFFFFL);
        return FIELDS.get(key);
    }
}
