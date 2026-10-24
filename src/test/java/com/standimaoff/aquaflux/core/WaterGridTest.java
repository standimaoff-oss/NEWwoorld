package com.standimaoff.aquaflux.core;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Тесты решателя: масса, стекание в яму, отсутствие воды из ничего, волны.
 * Игровые классы не нужны - ядро чистое.
 */
class WaterGridTest {

    private static WaterGrid flat(int n, double ground, Precision precision) {
        WaterGrid g = new WaterGrid(n, n, 0.5, precision);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                g.setGround(i, j, ground);
            }
        }
        return g;
    }

    @Test
    void emptyGridNeverCreatesWater() {
        WaterGrid g = flat(16, 64.0, Precision.BITS32);
        SolverSettings s = SolverSettings.balanced();
        for (int t = 0; t < 100; t++) {
            g.step(0.05, s, BoundarySource.CLOSED);
        }
        assertEquals(0.0, g.totalVolume(), 1e-12);
        assertTrue(g.stats().maxSpeed < 1e-9);
    }

    @Test
    void massIsConservedWhileSpreading() {
        WaterGrid g = flat(16, 64.0, Precision.BITS64);
        SolverSettings s = SolverSettings.balanced();
        // лужа в центре
        for (int j = 7; j <= 8; j++) {
            for (int i = 7; i <= 8; i++) {
                g.addVolume(i, j, 2.0);
            }
        }
        double start = g.totalVolume();
        assertEquals(8.0, start, 1e-9);

        for (int t = 0; t < 400; t++) {
            g.step(0.05, s, BoundarySource.CLOSED);
        }
        assertEquals(start, g.totalVolume(), start * 1e-6, "масса не должна меняться");
        assertTrue(g.stats().maxDepth < 1.0, "вода должна растенься, а не стоять столбом");
    }

    @Test
    void waterFillsADugHoleAndStaysConserved() {
        WaterGrid g = flat(16, 64.0, Precision.BITS64);
        for (int j = 6; j <= 9; j++) {
            for (int i = 6; i <= 9; i++) {
                g.setGround(i, j, 60.0); // яма глубиной 4 блока
            }
        }
        SolverSettings s = SolverSettings.balanced();
        for (int j = 2; j <= 5; j++) {
            for (int i = 2; i <= 13; i++) {
                g.addVolume(i, j, 0.8);
            }
        }
        double start = g.totalVolume();

        for (int t = 0; t < 800; t++) {
            g.step(0.05, s, BoundarySource.CLOSED);
        }

        double pit = 0;
        for (int j = 6; j <= 9; j++) {
            for (int i = 6; i <= 9; i++) {
                pit += g.depth(i, j);
            }
        }
        assertTrue(pit > 1.0, "вода должна уйти в яму, а не остаться наверху: " + pit);
        assertEquals(start, g.totalVolume(), start * 1e-5);
    }

    @Test
    void waterDoesNotClimbAWall() {
        WaterGrid g = flat(8, 64.0, Precision.BITS32);
        for (int j = 0; j < 4; j++) {
            for (int i = 0; i < 4; i++) {
                g.setGround(i, j, 70.0); // плато
            }
        }
        for (int j = 5; j < 8; j++) {
            for (int i = 0; i < 8; i++) {
                g.addVolume(i, j, 1.0);
            }
        }
        SolverSettings s = SolverSettings.balanced();
        for (int t = 0; t < 200; t++) {
            g.step(0.05, s, BoundarySource.CLOSED);
        }
        double onPlateau = 0;
        for (int j = 0; j < 4; j++) {
            for (int i = 0; i < 4; i++) {
                onPlateau += g.depth(i, j);
            }
        }
        assertEquals(0.0, onPlateau, 1e-6, "вода не должна затекать на высокое плато");
    }

    @Test
    void wavesDecayOverTime() {
        WaterGrid g = flat(16, 64.0, Precision.BITS32);
        for (int j = 0; j < 16; j++) {
            for (int i = 0; i < 16; i++) {
                g.addVolume(i, j, 1.0);
            }
        }
        SolverSettings s = SolverSettings.balanced();
        g.splash(4.0, 4.0, 1.0, 3.0);
        double before = g.stats().maxWave;
        assertTrue(before > 0.0);
        for (int t = 0; t < 400; t++) {
            g.step(0.05, s, BoundarySource.CLOSED);
        }
        double after = g.stats().maxWave;
        assertTrue(after < before * 0.2, "волны должны затухать: " + before + " -> " + after);
    }

    @Test
    void waterLeavesThroughAnOpenBoundary() {
        WaterGrid g = flat(8, 64.0, Precision.BITS32);
        for (int j = 0; j < 8; j++) {
            for (int i = 0; i < 8; i++) {
                g.addVolume(i, j, 2.0);
            }
        }
        SolverSettings s = SolverSettings.balanced();
        BoundarySource open = new BoundarySource() {
            @Override
            public double outsideDepth(int side, int index) {
                return 0.0;
            }

            @Override
            public double outsideGround(int side, int index) {
                return 60.0; // ниже нашего пола - вода должна уходить
            }
        };
        double start = g.totalVolume();
        double out;
        for (int t = 0; t < 200; t++) {
            g.step(0.05, s, open);
        }
        out = g.outEast()[0] + g.outWest()[0] + g.outNorth()[0] + g.outSouth()[0];
        assertTrue(out > 0.0, "через открытый край вода должна уходить");
        assertTrue(g.totalVolume() < start);
    }

    @Test
    void precisionQuantizesHeights() {
        assertEquals(0.0, Precision.BITS16.quantize(0.001), 1e-12);
        assertEquals(1.0 / 256.0, Precision.BITS16.quantize(1.0 / 256.0), 1e-12);
        assertEquals(Precision.BITS16, Precision.byBits(16));
        assertEquals(Precision.BITS64, Precision.byName("64"));
    }

    @Test
    void settingsAreImmutable() {
        SolverSettings a = SolverSettings.balanced();
        SolverSettings b = a.withCellSize(0.25);
        assertEquals(0.5, a.cellSize, 1e-12);
        assertEquals(0.25, b.cellSize, 1e-12);
    }
}
