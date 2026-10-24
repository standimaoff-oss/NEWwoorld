package com.standimaoff.aquaflux.core;

/**
 * Внешний край региона: глубины и пол соседних регионов.
 *
 * <p>Нужен, чтобы вода не упиралась в шов региона. Реализация возвращает {@link Double#NaN},
 * если соседа нет - тогда край считается стеной.</p>
 */
public interface BoundarySource {

    int WEST = 0;
    int EAST = 1;
    int NORTH = 2;
    int SOUTH = 3;

    /** Глубина воды в ячейке сразу за краем; NaN - стена. */
    double outsideDepth(int side, int index);

    /** Абсолютная высота пола в ячейке сразу за краем. */
    double outsideGround(int side, int index);

    /** Заглушка: все края - стены. */
    BoundarySource CLOSED = new BoundarySource() {
        @Override
        public double outsideDepth(int side, int index) {
            return Double.NaN;
        }

        @Override
        public double outsideGround(int side, int index) {
            return 0.0;
        }
    };
}
