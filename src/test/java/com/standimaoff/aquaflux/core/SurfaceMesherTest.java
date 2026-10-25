package com.standimaoff.aquaflux.core;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Тесты геометрии: гладкая поверхность, капли и слив с уступа.
 *
 * <p>Водопад - это не «стенка из кубов»: там, где уровень воды у соседей отличается больше
 * чем на {@code CLIFF_DROP}, мешер достраивает вертикальную завесу. Здесь проверяется, что она
 * появляется на настоящем уступе и не появляется на ровной воде.</p>
 */
class SurfaceMesherTest {

    /** Ровное поле: дно 62, одинаковая глубина - уровень везде один. */
    private static HeightField flat(int n, double depth) {
        HeightField f = new HeightField(n, n, 0.5, 0.0, 0.0);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                f.set(i, j, 62.0, depth, 0.0, 0.0);
            }
        }
        return f;
    }

    @Test
    void evenWaterHasNoCurtains() {
        HeightField f = flat(16, 1.0);
        SurfaceMesher.Output out = new SurfaceMesher.Output();
        new SurfaceMesher(f).build(f, Precision.BITS32, false, out);

        assertEquals(0, out.curtains, "на ровной воде завес быть не должно");
        assertTrue(out.quads > 0, "поверхность должна быть построена");
    }

    @Test
    void aStepInTheLevelBuildsAFallingCurtain() {
        int n = 16;
        HeightField f = new HeightField(n, n, 0.5, 0.0, 0.0);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                // Слева уровень 64.0, справа 62.3: перепад 1.7 > CLIFF_DROP.
                f.set(i, j, 62.0, i < 8 ? 2.0 : 0.3, 0.0, 0.0);
            }
        }
        SurfaceMesher.Output out = new SurfaceMesher.Output();
        new SurfaceMesher(f).build(f, Precision.BITS32, false, out);

        assertTrue(out.curtains >= 8, "завеса должна идти вдоль всей кромки: " + out.curtains);
        // Пена на падающей воде - отдельная характеристика вершин.
        assertTrue(out.foam.length > 0);
    }

    @Test
    void impactSplitsWaterIntoManySmallDroplets() {
        ParcelField p = new ParcelField(512, 0.0, 320.0);
        double volume = 0.4;
        double spawned = p.impact(8.0, 64.0, 8.0, 1.5, 5.0, volume, 0.5);

        assertEquals(volume, spawned, 1.0e-9, "удар не должен терять массу");
        assertEquals(volume, p.totalVolume(), 1.0e-9);
        assertTrue(p.count() > 50, "брызги - это много мелких тел, а не одно: " + p.count());
        for (int i = 0; i < p.count(); i++) {
            assertTrue(p.at(i).radius() < 0.2,
                    "капля слишком крупная: " + p.at(i).radius());
        }
    }
}
