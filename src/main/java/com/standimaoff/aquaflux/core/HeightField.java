package com.standimaoff.aquaflux.core;

/**
 * Поле высот для построения поверхности: узловая сетка (вершины), а не ячейки.
 *
 * <p>Полностью чистый Java - ни одного класса Minecraft. Клиент заполняет поле из мира,
 * превью-рендерер заполняет его демо-рельефом; мешер работает с обоими одинаково.</p>
 */
public final class HeightField {

    public final int w;
    public final int h;
    /** Шаг сетки в блоках. */
    public final double step;
    /** Мировые координаты левого-верхнего узла. */
    public final double originX;
    public final double originZ;

    public final double[] bed;
    public final double[] depth;
    public final double[] wave;
    public final double[] foam;
    /** Течение по X, м/с - для пены, штрихов на поверхности и Froude. */
    public final double[] flowU;
    /** Течение по Z, м/с. */
    public final double[] flowV;

    public HeightField(int w, int h, double step, double originX, double originZ) {
        this.w = Math.max(2, w);
        this.h = Math.max(2, h);
        this.step = step;
        this.originX = originX;
        this.originZ = originZ;
        int n = this.w * this.h;
        this.bed = new double[n];
        this.depth = new double[n];
        this.wave = new double[n];
        this.foam = new double[n];
        this.flowU = new double[n];
        this.flowV = new double[n];
    }

    public int index(int i, int j) {
        return i + w * j;
    }

    public boolean inside(int i, int j) {
        return i >= 0 && j >= 0 && i < w && j < h;
    }

    public double worldX(int i) {
        return originX + i * step;
    }

    public double worldZ(int j) {
        return originZ + j * step;
    }

    public boolean wet(int i, int j) {
        return inside(i, j) && depth[index(i, j)] > 1.0e-4;
    }

    /** Высота воды без волны. */
    public double surface(int i, int j) {
        int k = index(i, j);
        return bed[k] + depth[k];
    }

    /**
     * Высота воды с волной (то, что видит игрок).
     *
     * <p>Волна ограничена глубиной: на мелководье гребня выше 0.45·h не бывает, иначе
     * на границе с берегом появлялись бы вертикальные шипы вместо воды.</p>
     */
    public double renderSurface(int i, int j) {
        int k = index(i, j);
        double limit = WaterGrid.waveLimit(depth[k]);
        double w = Math.max(-limit, Math.min(limit, wave[k]));
        return bed[k] + depth[k] + w;
    }

    public void set(int i, int j, double bedY, double depthM, double waveM, double foamK) {
        set(i, j, bedY, depthM, waveM, foamK, 0.0, 0.0);
    }

    /** Полная запись узла, включая течение. */
    public void set(int i, int j, double bedY, double depthM, double waveM, double foamK,
                    double flowX, double flowZ) {
        if (!inside(i, j)) {
            return;
        }
        int k = index(i, j);
        bed[k] = bedY;
        depth[k] = Math.max(0, depthM);
        wave[k] = waveM;
        foam[k] = Math.max(0, foamK);
        flowU[k] = flowX;
        flowV[k] = flowZ;
    }

    /** Модуль течения в узле, м/с. */
    public double speed(int i, int j) {
        int k = index(i, j);
        return Math.hypot(flowU[k], flowV[k]);
    }

    /** Билинейная высота поверхности в произвольной мировой точке (для физики/эффектов). */
    public double surfaceAt(double x, double z) {
        double fx = (x - originX) / step;
        double fz = (z - originZ) / step;
        int i = (int) Math.floor(fx);
        int j = (int) Math.floor(fz);
        if (!inside(i, j) || !inside(i + 1, j + 1)) {
            return Double.NaN;
        }
        double tx = fx - i;
        double tz = fz - j;
        double s00 = renderSurface(i, j);
        double s10 = renderSurface(i + 1, j);
        double s01 = renderSurface(i, j + 1);
        double s11 = renderSurface(i + 1, j + 1);
        double a = s00 + (s10 - s00) * tx;
        double b = s01 + (s11 - s01) * tx;
        return a + (b - a) * tz;
    }

    /** Средняя толщина воды вокруг узла - для цвета и пены. */
    public double averageDepth(int i, int j, int radius) {
        double sum = 0;
        int n = 0;
        for (int dj = -radius; dj <= radius; dj++) {
            for (int di = -radius; di <= radius; di++) {
                if (inside(i + di, j + dj)) {
                    sum += depth[index(i + di, j + dj)];
                    n++;
                }
            }
        }
        return n == 0 ? 0 : sum / n;
    }
}
