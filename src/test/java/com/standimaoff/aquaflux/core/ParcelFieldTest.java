package com.standimaoff.aquaflux.core;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Тесты капель: сеть и сохранение массы.
 *
 * <p>Поле капель уходит на клиент байтами. Раньше {@code encode} писал на байт больше,
 * чем выделял, и сервер падал с {@code ArrayIndexOutOfBoundsException}, как только в воде
 * появлялась хоть одна брызга. Тест держит формат в порядке.</p>
 */
class ParcelFieldTest {

    @Test
    void dropletsSurviveTheNetworkRoundTrip() {
        ParcelField src = new ParcelField(256, 0.0, 320.0);
        double spawned = src.impact(8.0, 64.0, 8.0, 1.5, 5.0, 0.4, 0.5);
        assertTrue(spawned > 0.0);
        assertEquals(0.4, src.totalVolume(), 1.0e-6);

        byte[] data = src.encode(0.0, 0.0);
        ParcelField dst = new ParcelField(256, 0.0, 320.0);
        dst.decode(data, 0.0, 0.0);

        assertEquals(src.count(), dst.count(), "все капли должны доехать до клиента");
        assertEquals(1 + 16 * src.count(), data.length, "одна капля - 16 байт");
        assertTrue(Math.abs(src.totalVolume() - dst.totalVolume()) < src.totalVolume() * 0.05,
                "объём после квантования не должен разъезжаться: " + src.totalVolume()
                        + " против " + dst.totalVolume());
    }

    @Test
    void emptyFieldEncodesToASingleByte() {
        ParcelField empty = new ParcelField(64, 0.0, 320.0);
        byte[] data = empty.encode(0.0, 0.0);
        assertEquals(1, data.length);
        ParcelField back = new ParcelField(64, 0.0, 320.0);
        back.decode(data, 0.0, 0.0);
        assertEquals(0, back.count());
    }
}
