/*
 * Превью-рендерер Aquaflux.
 *
 * Чистый Java: ни Minecraft, ни OpenGL, ни внешних библиотек. Берёт ТОТ ЖЕ решатель,
 * ТОТ ЖЕ слой капель и ТОТ ЖЕ мешер (com.standimaoff.aquaflux.core), что и мод, и рисует
 * их программным растеризатором в PNG. Так видно форму воды без запуска игры.
 *
 * Запуск:  java -cp build/preview PreviewRenderer docs/preview
 */

import com.standimaoff.aquaflux.core.BoundarySource;
import com.standimaoff.aquaflux.core.FluidConstants;
import com.standimaoff.aquaflux.core.HeightField;
import com.standimaoff.aquaflux.core.Noise;
import com.standimaoff.aquaflux.core.ParcelField;
import com.standimaoff.aquaflux.core.Precision;
import com.standimaoff.aquaflux.core.SolverSettings;
import com.standimaoff.aquaflux.core.SurfaceMesher;
import com.standimaoff.aquaflux.core.WaterGrid;
import com.standimaoff.aquaflux.core.WaterPalette;
import com.standimaoff.aquaflux.core.WaveSpectrum;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.zip.CRC32;
import java.util.zip.Deflater;

public final class PreviewRenderer {

    private static final int W = 1600;
    private static final int H = 900;
    /** Отладка: подкрасить воду по толщине, чтобы видеть тонкие плёнки и стенки. */
    private static boolean thicknessDebug;
    /** Сколько вершин отброшено из-за ближней плоскости (отладка). */
    private static long nearDropped;

    // ---------------------------------------------------------------- сцены

    static final class Scene {
        final String name;
        WaterGrid grid;
        ParcelField parcels;
        double[] eye;
        double[] target;
        double fov = 55;
        double sunX = -0.42;
        double sunY = 0.72;
        double sunZ = 0.55;
        double time;
        double wind = 5.0;
        double waterStep = 0.5;
        String note = "";

        Scene(String name) {
            this.name = name;
        }
    }

    /**
     * Проверка геометрии: в меше не должно быть квадов, которые «взлетают» над водой.
     * Режим для CI: {@code java ... PreviewRenderer --check}.
     */
    private static int checkGeometry(List<Scene> scenes) {
        int problems = 0;
        for (Scene scene : scenes) {
            HeightField t = fromGrid(scene.grid, 1.0, scene.time, 0.0);
            double worstSpike = 0;
            int spikeCount = 0;
            for (int j = 1; j < t.h - 1; j++) {
                for (int i = 1; i < t.w - 1; i++) {
                    int k = t.index(i, j);
                    double[] nb = {
                            t.bed[t.index(i - 1, j)], t.bed[t.index(i + 1, j)],
                            t.bed[t.index(i, j - 1)], t.bed[t.index(i, j + 1)]};
                    java.util.Arrays.sort(nb);
                    double median = (nb[1] + nb[2]) * 0.5;
                    double dev = t.bed[k] - median;
                    if (dev > 0.32) {
                        spikeCount++;
                        worstSpike = Math.max(worstSpike, dev);
                        if (Boolean.getBoolean("verbose") && spikeCount <= 6) {
                            System.out.printf("  пик рельефа %.2f в блоке (%d,%d) x=%.1f z=%.1f%n",
                                    dev, i, j, t.worldX(i), t.worldZ(j));
                        }
                    }
                }
            }
            System.out.printf("  рельеф: пиков %d, худший %.2f%n", spikeCount, worstSpike);
            if (Boolean.getBoolean("slice") && scene.name.startsWith("02")) {
                int j = t.h / 3;
                for (int i = t.w / 4; i < t.w / 4 + 22; i++) {
                    int k = t.index(i, j);
                    System.out.printf("    x=%.2f bed=%.2f depth=%.2f level=%.2f%n",
                            t.worldX(i), t.bed[k], t.depth[k], t.bed[k] + t.depth[k]);
                }
            }
            HeightField water = fromGrid(scene.grid, scene.waterStep, scene.time, 0.35);
            SurfaceMesher mesher = new SurfaceMesher(water.w * water.h + 16);
            SurfaceMesher.Output out = new SurfaceMesher.Output();
            mesher.build(water, Precision.BITS64, false, out, scene.time);
            int bad = 0;
            double worst = 0;
            for (int q = 0; q < out.quads; q++) {
                int p = q * 12;
                double lo = 1e9;
                double hi = -1e9;
                for (int v = 0; v < 4; v++) {
                    double y = out.pos[p + v * 3 + 1];
                    lo = Math.min(lo, y);
                    hi = Math.max(hi, y);
                }
                double depthMax = 0;
                for (int v = 0; v < 4; v++) {
                    depthMax = Math.max(depthMax, out.depth[q * 4 + v]);
                }
                // Квад не должен подниматься выше, чем позволяет самая глубокая его вершина.
                if (hi - lo > 0.35 + depthMax * 1.2) {
                    bad++;
                    worst = Math.max(worst, hi - lo);
                    if (Boolean.getBoolean("verbose")) {
                        System.out.printf("  квад %d: y=%.2f..%.2f depth=[%.2f %.2f %.2f %.2f] x=%.1f..%.1f z=%.1f..%.1f%n",
                                q, lo, hi, out.depth[q * 4], out.depth[q * 4 + 1], out.depth[q * 4 + 2], out.depth[q * 4 + 3],
                                Math.min(Math.min(out.pos[p], out.pos[p + 3]), Math.min(out.pos[p + 6], out.pos[p + 9])),
                                Math.max(Math.max(out.pos[p], out.pos[p + 3]), Math.max(out.pos[p + 6], out.pos[p + 9])),
                                Math.min(Math.min(out.pos[p + 2], out.pos[p + 5]), Math.min(out.pos[p + 8], out.pos[p + 11])),
                                Math.max(Math.max(out.pos[p + 2], out.pos[p + 5]), Math.max(out.pos[p + 8], out.pos[p + 11])));
                    }
                }
            }
            System.out.printf("%-14s квадов %6d, подозрительных %4d, худший перепад %.2f%n",
                    scene.name, out.quads, bad, worst);
            problems += bad;
        }
        return problems;
    }

    public static void main(String[] args) throws IOException {
        if (System.getProperty("nocurt") != null) {
            SurfaceMesher.drawCurtains = false;
        }
        thicknessDebug = System.getProperty("thick") != null;
        File outDir = new File(args.length > 0 ? args[0] : "docs/preview");
        if (!outDir.exists() && !outDir.mkdirs()) {
            throw new IOException("не могу создать " + outDir);
        }

        if (args.length > 0 && "--check".equals(args[0])) {
            List<Scene> only = new ArrayList<>();
            only.add(lakeScene());
            only.add(riverScene());
            only.add(pitScene());
            only.add(waterfallScene());
            only.add(shoreScene());
            int problems = checkGeometry(only);
            System.out.println(problems == 0 ? "геометрия в порядке" : "проблемы: " + problems);
            return;
        }

        List<Scene> scenes = new ArrayList<>();
        scenes.add(lakeScene());
        scenes.add(riverScene());
        scenes.add(pitScene());
        scenes.add(explosionScene());
        scenes.add(wakeScene());
        scenes.add(shoreScene());
        scenes.add(waterfallScene());
        scenes.add(crownScene());

        for (Scene scene : scenes) {
            long t0 = System.currentTimeMillis();
            Shot shot = render(scene);
            File file = new File(outDir, scene.name + ".png");
            writePng(file, shot.rgb, W, H);
            System.out.printf("%-14s вода: %6d квадов, капли: %3d, земля: %6d тр., %5d мс -> %s%n",
                    scene.name, shot.waterQuads, shot.drops, shot.terrainTris,
                    System.currentTimeMillis() - t0, file.getName());
        }
        System.out.println("готово: " + scenes.size() + " сцен");
    }

    // ---------------------------------------------------------------- рельеф

    private static double hash(double x, double z, int seed) {
        double v = Math.sin(x * 127.1 + z * 311.7 + seed * 74.7) * 43758.5453;
        return v - Math.floor(v);
    }

    private static double noise(double x, double z, int seed) {
        int xi = (int) Math.floor(x);
        int zi = (int) Math.floor(z);
        double fx = x - xi;
        double fz = z - zi;
        double u = fx * fx * (3 - 2 * fx);
        double v = fz * fz * (3 - 2 * fz);
        double a = hash(xi, zi, seed);
        double b = hash(xi + 1, zi, seed);
        double c = hash(xi, zi + 1, seed);
        double d = hash(xi + 1, zi + 1, seed);
        return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
    }

    /** Плавный переход 0..1 без ступеньки на границе. */
    private static double smoothstep(double t) {
        double x = Math.max(0.0, Math.min(1.0, t));
        return x * x * (3 - 2 * x);
    }

    private static double fbm(double x, double z, int octaves, int seed) {
        double sum = 0;
        double amp = 0.5;
        double freq = 1;
        for (int i = 0; i < octaves; i++) {
            sum += noise(x * freq, z * freq, seed + i) * amp;
            freq *= 2.03;
            amp *= 0.5;
        }
        return sum;
    }

    private static WaterGrid grid(int n, double cell) {
        return new WaterGrid(n, n, cell, Precision.BITS64);
    }

    private static void fillWhere(WaterGrid g, double level, double amount) {
        int n = g.width();
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                if (g.ground(i, j) < level) {
                    g.addVolume(i, j, amount * g.cellSize() * g.cellSize());
                }
            }
        }
    }

    /** Залить впадины до уровня: вода встаёт ровно, как её налила бы физика. */
    /**
     * Налить воду до уровня.
     *
     * <p>{@link WaterGrid#addVolume} принимает ОБЪЁМ в м³, а не глубину: глубину он делит
     * на площадь ячейки. Поэтому слой «на сколько поднять уровень» умножаем на площадь.</p>
     */
    private static void fillToLevel(WaterGrid g, double level) {
        int n = g.width();
        double area = g.cellSize() * g.cellSize();
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double bed = g.ground(i, j);
                if (bed < level) {
                    g.addVolume(i, j, (level - bed) * 0.96 * area);
                }
            }
        }
    }

    private static void settle(WaterGrid g, int steps, SolverSettings s) {
        for (int t = 0; t < steps; t++) {
            g.step(0.05, s, BoundarySource.CLOSED);
        }
    }

    /** Ветер: тот же спектр, что в моде, поэтому картинка совпадает с игрой. */
    private static void applyWind(WaterGrid g, Scene scene, double amplitude) {
        double depth = Math.max(0.2, g.stats().maxDepth);
        WaveSpectrum spectrum = WaveSpectrum.wind(scene.wind, depth, 20240211, 6);
        double time = scene.time;
        for (int j = 0; j < g.height(); j++) {
            for (int i = 0; i < g.width(); i++) {
                double d = g.depth(i, j);
                if (d <= 1.0e-4) {
                    continue;
                }
                double x = (i + 0.5) * g.cellSize();
                double z = (j + 0.5) * g.cellSize();
                double h = spectrum.height(x, z, time) * amplitude * Math.min(1.0, d / 0.4);
                g.setWave(i, j, g.waveAt(i, j) + h);
                // Барашки там, где гребень слишком крутой. Их немного даже в свежий ветер.
                double cap = spectrum.whitecap(x, z, time) * Math.min(1.0, d * 0.5);
                if (cap > 0.02) {
                    g.addFoam(x, z, 0.6, cap * 0.30);
                }
            }
        }
    }

    /** Дождь капель от порогов: капли рождаются из воды, которая реально летит. */
    private static void spawnRapids(WaterGrid g, Scene scene, int samples, double strength) {
        int n = g.width();
        for (int s = 0; s < samples; s++) {
            int i = (int) (Math.abs(Noise.hash(s, 7, 31)) * n);
            int j = (int) (Math.abs(Noise.hash(s, 13, 57)) * n);
            i = Math.min(n - 1, i);
            j = Math.min(n - 1, j);
            double depth = g.depth(i, j);
            if (depth < 0.12) {
                continue;
            }
            double[] vel = g.velocityAtLocal((i + 0.5) * g.cellSize(), (j + 0.5) * g.cellSize(), null);
            double speed = Math.hypot(vel[0], vel[1]);
            double froude = FluidConstants.froude(speed, depth, FluidConstants.STANDARD_GRAVITY);
            if (froude < 0.75) {
                continue;
            }
            double x = (i + 0.5) * g.cellSize();
            double z = (j + 0.5) * g.cellSize();
            scene.parcels.liftFrom(g, 0, 0, x, z, Math.min(0.05, depth * 0.06),
                    0.8 + froude * 1.1, vel[0] * 0.4, vel[1] * 0.4);
        }
    }

    /**
     * Пересэмплировать сетку решателя в более частую сетку мешера.
     *
     * <p>Земля и уровень воды интерполируются билинейно: если брать ближайшую ячейку,
     * на берегу появляются ступеньки в полблока, а на них - треугольные «шипы» из воды.
     * Уровень (bed + depth) интерполируется как единая величина, иначе на мелководье
     * глубина и дно «рассинхронизируются».</p>
     */
    private static HeightField fromGrid(WaterGrid g, double step, double time, double swell) {
        double cell = g.cellSize();
        int nodes = (int) Math.round(g.width() * cell / step) + 1;
        HeightField f = new HeightField(nodes, nodes, step, cell * 0.5, cell * 0.5);
        WaveSpectrum spectrum = WaveSpectrum.wind(4.0 + swell * 6.0, 4.0, 991, 6);
        for (int j = 0; j < nodes; j++) {
            double wz = f.worldZ(j);
            for (int i = 0; i < nodes; i++) {
                double wx = f.worldX(i);
                double fx = wx / cell - 0.5;
                double fz = wz / cell - 0.5;
                int i0 = (int) Math.floor(fx);
                int j0 = (int) Math.floor(fz);
                double tx = fx - i0;
                double tz = fz - j0;
                double bed = 0;
                double level = 0;
                double wave = 0;
                double foam = 0;
                for (int dj = 0; dj <= 1; dj++) {
                    for (int di = 0; di <= 1; di++) {
                        int gi = Math.max(0, Math.min(g.width() - 1, i0 + di));
                        int gj = Math.max(0, Math.min(g.height() - 1, j0 + dj));
                        double bw = (di == 0 ? 1 - tx : tx) * (dj == 0 ? 1 - tz : tz);
                        double b = g.ground(gi, gj);
                        bed += b * bw;
                        level += (b + g.depth(gi, gj)) * bw;
                        wave += g.waveAt(gi, gj) * bw;
                        foam += g.foamAt(gi, gj) * bw;
                    }
                }
                double d = Math.max(0.0, level - bed);
                double[] vel = g.velocityAtLocal(wx, wz, null);
                double breeze = spectrum.height(wx, wz, time) * swell * Math.min(1.0, d / 0.4);
                f.set(i, j, bed, d, wave + breeze, foam, vel[0], vel[1]);
            }
        }
        return f;
    }

    // ---------------------------------------------------------------- сцены

    /** Озеро: гладкая поверхность, ветровые волны, барашки, тёмная толща на глубине. */
    private static Scene lakeScene() {
        int n = 140;
        double cell = 0.5;
        WaterGrid g = grid(n, cell);
        double cx = 35;
        double cz = 35;
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double d = Math.hypot(x - cx, z - cz) + fbm(x * 0.09, z * 0.09, 3, 71) * 4.5 - 2.2;
                double base = 64.0 + fbm(x * 0.11, z * 0.11, 3, 11) * 9.0
                        + fbm(x * 0.42, z * 0.42, 2, 27) * 1.2;
                double bowl = 64.9 - Math.max(0.0, 1.0 - (d / 20.0)) * 4.2;
                double bed = Math.max(bowl + Math.max(0.0, d - 20.0) * 0.75, base - 3.4);
                if (d < 20.0) {
                    bed = Math.min(bed, bowl);
                }
                g.setGround(i, j, bed);
            }
        }
        fillToLevel(g, 64.35);
        SolverSettings s = SolverSettings.balanced();
        settle(g, 900, s);
        for (int t = 0; t < 160; t++) {
            g.decayWaves(0.985);
            g.step(0.05, s, BoundarySource.CLOSED);
        }

        Scene scene = new Scene("01-lake");
        scene.grid = g;
        scene.parcels = new ParcelField();
        scene.time = 12.0;
        scene.wind = 6.0;
        applyWind(g, scene, 0.75);
        autoCamera(scene, 205.0, 0.075, 0.25, 0.0);
        scene.fov = 56;
        scene.note = "ветровые волны, барашки, поглощение по глубине";
        return scene;
    }

    /** Река: уклон, настоящее течение, пена на порогах и летящие брызги. */
    private static Scene riverScene() {
        int n = 150;
        double cell = 0.5;
        WaterGrid g = grid(n, cell);
        double slope = 0.032;
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double meander = 34.0 + Math.sin(z * 0.13) * 7.0 + Math.sin(z * 0.045 + 1.3) * 4.0;
                double dist = Math.abs(x - meander);
                double valley = 66.0 - z * slope;
                // Шум гасим у самой воды: берег, изрезанный шумом на 0.5-1 м,
                // даёт пилообразную кромку, которая издалека читается как «частокол».
                double clean = smoothstep((dist - 4.5) / 9.0);
                double base = valley + 5.0 + fbm(x * 0.22, z * 0.22, 3, 5) * 5.0 * clean;
                double channel = valley - Math.max(0.0, 1.0 - (dist / 5.0)) * 1.5;
                double bed = base;
                if (dist < 12.0) {
                    double t = Math.min(1.0, dist / 12.0);
                    bed = channel * (1 - t) + base * t;
                }
                // Валуны в русле - вокруг них настоящая белая вода. Валун ПОДНИМАЕТ дно
                // (плавно, без порога), а не вырезает яму: иначе на берегу появляются
                // одноклеточные провалы и рваная кромка.
                double rock = fbm(x * 0.55, z * 0.55, 1, 77);
                if (dist < 4.0) {
                    double bump = smoothstep((rock - 0.58) / 0.30);
                    bed = Math.max(bed, channel + 1.05 * bump);
                }
                g.setGround(i, j, bed);
            }
        }
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double z = (j + 0.5) * cell;
                double level = 66.0 - z * slope - 0.42;
                if (g.ground(i, j) < level) {
                    g.addVolume(i, j, (level - g.ground(i, j)) * 0.9
                            * g.cellSize() * g.cellSize());
                }
            }
        }
        SolverSettings s = SolverSettings.balanced();
        settle(g, 900, s);

        Scene scene = new Scene("02-river");
        scene.grid = g;
        scene.parcels = new ParcelField();
        scene.time = 8.0;
        scene.wind = 3.0;
        // Пороги: вода бурлит, брызги реально летят
        for (int t = 0; t < 120; t++) {
            if (t % 4 == 0) {
                spawnRapids(g, scene, 12, 1.0);
                scene.parcels.step(0.2, FluidConstants.STANDARD_GRAVITY);
                scene.parcels.settleInto(g, 0, 0);
            }
            g.step(0.05, s, BoundarySource.CLOSED);
        }
        applyWind(g, scene, 0.25);
        autoCamera(scene, 268.0, 0.05, 0.35, 18.0, 3.2);
        scene.fov = 56;
        scene.waterStep = 0.5;
        scene.note = "уклон, течение, пена на порогах, брызги";
        return scene;
    }

    /** Яма: вылили два ведра, вода стекла по ступеням и встала уровнем. */
    private static Scene pitScene() {
        int n = 80;
        double cell = 0.25;
        WaterGrid g = grid(n, cell);
        double px = 10;
        double pz = 10;
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double bed = 64.0 + fbm(x * 0.25, z * 0.25, 3, 3) * 0.3;
                double d = Math.hypot(x - px, z - pz);
                // Гладкая чаша: ступенчатые уровни дают «бассейн из кубиков».
                bed = 64.0 - 3.6 * smoothstep((3.4 - d) / 2.2);
                g.setGround(i, j, bed);
            }
        }
        SolverSettings s = SolverSettings.balanced();
        // Плеснули шесть кубометров (шесть вёдер) на край ямы.
        g.addVolumeAt(11.2, 10.0, 11000.0);
        Scene scene = new Scene("03-pit");
        scene.parcels = new ParcelField();
        // Вода падает в яму: капли
        for (int t = 0; t < 90; t++) {
            if (t < 22 && t % 2 == 0) {
                scene.parcels.impact(11.6, 63.6, 10.0, 0.9, 2.6, 0.03, 0.5);
            }
            scene.parcels.step(0.05, FluidConstants.STANDARD_GRAVITY);
            scene.parcels.settleInto(g, 0, 0);
            g.step(0.05, s, BoundarySource.CLOSED);
        }
        settle(g, 700, s);
        scene.grid = g;
        scene.time = 6.0;
        scene.wind = 1.5;
        // Смотрим с края ямы вниз, в воду: так видно и стенки, и уровень.
        scene.eye = new double[]{14.6, 66.2, 14.6};
        scene.target = new double[]{10.2, 60.9, 10.2};
        scene.fov = 55;
        scene.waterStep = 0.25;
        scene.note = "конечная масса: сколько налил - столько есть";
        return scene;
    }

    /** Взрыв в воде: расходящееся кольцо, фонтан брызг и пена. */
    private static Scene explosionScene() {
        int n = 120;
        double cell = 0.5;
        WaterGrid g = grid(n, cell);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double d = Math.hypot(x - 30, z - 30);
                // Чаша: к центру глубже, к берегу поднимается.
                double bed = 61.0 + fbm(x * 0.15, z * 0.15, 2, 9) * 0.8
                        + 2.0 * smoothstep((d - 6.0) / 14.0);
                g.setGround(i, j, bed);
            }
        }
        fillToLevel(g, 63.2);
        SolverSettings s = SolverSettings.balanced();
        settle(g, 700, s);

        Scene scene = new Scene("04-explosion");
        scene.parcels = new ParcelField();
        g.explosion(30.0, 30.0, 1.8);
        // Взрыв вырывает воду: настоящие капли, а не текстура.
        double taken = 0;
        for (int dj = -3; dj <= 3; dj++) {
            for (int di = -3; di <= 3; di++) {
                taken += g.removeVolume(60 + di, 60 + dj, 0.006);
            }
        }
        scene.parcels.impact(30.0, 63.2, 30.0, 3.2, 8.0, taken * 2.5, 1.0);
        for (int t = 0; t < 16; t++) {
            scene.parcels.step(0.05, FluidConstants.STANDARD_GRAVITY);
            g.step(0.05, s, BoundarySource.CLOSED);
        }
        scene.grid = g;
        scene.time = 4.5;
        scene.wind = 4.0;
        applyWind(g, scene, 0.35);
        scene.eye = new double[]{30.0, 68.5, 54.0};
        scene.target = new double[]{30.0, 62.6, 30.0};
        scene.fov = 52;
        scene.waterStep = 0.4;
        scene.note = "кольцо волн, фонтан брызг, пена";
        return scene;
    }

    /** Игрок идёт по воде: след, всплески от шагов, волны от тела. */
    private static Scene wakeScene() {
        int n = 120;
        double cell = 0.5;
        WaterGrid g = grid(n, cell);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double d = Math.hypot(x - 28, z - 28);
                g.setGround(i, j, 64.4 - Math.max(0.0, 1.0 - d / 16.0) * 1.9
                        + fbm(x * 0.3, z * 0.3, 2, 17) * 0.3);
            }
        }
        fillToLevel(g, 64.55);
        SolverSettings s = SolverSettings.balanced();
        settle(g, 700, s);

        Scene scene = new Scene("05-wake");
        scene.parcels = new ParcelField();
        double z = 8;
        for (int t = 0; t < 190; t++) {
            if (t % 3 == 0 && t > 4) {
                double x = 27 + Math.sin(t * 0.05) * 2.5;
                g.impulse(x, z, 0.0, 0.30, 2.0);
                g.splash(x, z, 0.40, 2.6);
                g.addFoam(x, z, 2.2, 0.30);
                scene.parcels.impact(x, 64.6, z, 1.0, 1.6, 0.02, 0.45);
            }
            z += 0.115;
            scene.parcels.step(0.05, FluidConstants.STANDARD_GRAVITY);
            scene.parcels.settleInto(g, 0, 0);
            g.step(0.05, s, BoundarySource.CLOSED);
        }
        scene.grid = g;
        scene.time = 9.0;
        scene.wind = 2.5;
        applyWind(g, scene, 0.18);
        // Взгляд с кормы вдоль следа: видно и волны, и всплески, и пену.
        scene.eye = new double[]{34.5, 68.6, 33.0};
        scene.target = new double[]{26.5, 64.6, 20.0};
        scene.fov = 52;
        scene.waterStep = 0.5;
        scene.note = "след за пловцом, всплески, пена";
        return scene;
    }

    /** Кромка: тонкая плёнка, мениск на берегу, пена полосой. */
    private static Scene shoreScene() {
        int n = 140;
        double cell = 0.25;
        WaterGrid g = grid(n, cell);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double shore = 24.0 + Math.sin(z * 0.55) * 1.4 + Math.sin(z * 0.21 + 2.0) * 1.8;
                double bed;
                if (x > shore) {
                    bed = 64.0 + (x - shore) * 0.55;       // сухой пляж
                } else {
                    // Дно уходит вниз от берега: у кромки мель, дальше глубина.
                    bed = 63.95 - (shore - x) * 0.075;
                }
                bed += fbm(x * 0.8, z * 0.8, 1, 23) * 0.10;
                g.setGround(i, j, bed);
            }
        }
        fillToLevel(g, 64.10);
        SolverSettings s = SolverSettings.balanced();
        settle(g, 600, s);

        Scene scene = new Scene("06-shore");
        scene.parcels = new ParcelField();
        // Накат: волна идёт к берегу и разбивается о песок.
        for (int t = 0; t < 190; t++) {
            if (t % 5 == 0) {
                double seg = 6 + (t % 40) * 0.45;
                double shore = 24.0 + Math.sin(seg * 0.55) * 1.4 + Math.sin(seg * 0.21 + 2.0) * 1.8;
                g.impulse(shore - 3.2, seg, 0.55, 0.0, 1.1);
                g.splash(shore - 0.6, seg, 0.35, 1.1);
                g.addFoam(shore - 0.7, seg, 1.5, 0.16);
                scene.parcels.impact(shore - 0.8, 64.1, seg, 0.8, 1.2, 0.02, 0.7);
            }
            scene.parcels.step(0.05, FluidConstants.STANDARD_GRAVITY);
            scene.parcels.settleInto(g, 0, 0);
            g.step(0.05, s, BoundarySource.CLOSED);
        }
        scene.grid = g;
        scene.time = 3.0;
        scene.wind = 3.0;
        applyWind(g, scene, 0.20);
        // Камера на пляже, почти на уровне воды: видно кромку, пену и накат.
        // Стоим на сухом пляже и смотрим ВДОЛЬ кромки: так видно и берег, и накат.
        scene.eye = new double[]{28.6, 65.4, 33.0};
        scene.target = new double[]{23.2, 64.15, 12.0};
        scene.fov = 52;
        scene.waterStep = 0.25;
        scene.note = "накат, мениск у берега, пена на кромке";
        return scene;
    }

    private static Scene waterfallScene() {
        int n = 160;
        double cell = 0.25;
        WaterGrid g = grid(n, cell);
        double cx = 20.0;
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                // Река течёт вдоль +Z и на пороге z=20 срывается вниз на 4.5 блока.
                double drop = 4.5 * smoothstep((z - 19.4) / 2.0);
                double bed = 67.0 - drop;
                // Берега: поднимаем всё, что дальше 4.5 блока от оси реки.
                double bank = 6.0 * smoothstep((Math.abs(x - cx) - 4.5) / 5.0);
                bed += bank + fbm(x * 0.5, z * 0.5, 2, 43) * 0.12;
                // Ниже порога бассейн замыкается: дно поднимается к краю мира.
                if (z > 34.0) {
                    bed += 5.0 * smoothstep((z - 34.0) / 6.0);
                }
                g.setGround(i, j, bed);
            }
        }
        SolverSettings s = SolverSettings.balanced();
        // Вода сверху: полноводная река до порога.
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                if (z > 19.0 || Math.abs(x - cx) > 5.0) {
                    continue;
                }
                if (g.ground(i, j) < 67.4) {
                    g.addVolume(i, j, (67.4 - g.ground(i, j)) * 0.85
                            * g.cellSize() * g.cellSize());
                }
            }
        }
        settle(g, 400, s);

        Scene scene = new Scene("07-waterfall");
        scene.parcels = new ParcelField();
        // Течение через порог: подталкиваем воду у края, брызги - в бассейн.
        for (int t = 0; t < 150; t++) {
            if (t % 2 == 0) {
                for (int k = -2; k <= 2; k++) {
                    g.impulse(cx + k * 1.4, 18.6, 0.0, 2.2, 1.2);
                }
                for (int k = 0; k < 4; k++) {
                    scene.parcels.impact(cx - 2.1 + k * 1.4, 63.6, 21.6, 0.8, 1.8, 0.02, 0.7);
                    g.addFoam(cx - 2.4 + k * 1.6, 22.4, 1.5, 0.10);
                }
            }
            scene.parcels.step(0.05, FluidConstants.STANDARD_GRAVITY);
            scene.parcels.settleInto(g, 0, 0);
            g.step(0.05, s, BoundarySource.CLOSED);
        }
        scene.grid = g;
        scene.time = 7.0;
        scene.wind = 2.0;
        // Смотрим снизу по течению, чуть сбоку: видно и стенку, и кипящий бассейн.
        scene.eye = new double[]{31.5, 74.5, 30.5};
        scene.target = new double[]{19.4, 64.4, 21.0};
        scene.fov = 55;
        scene.waterStep = 0.25;
        scene.note = "стенка воды на пороге, брызги, пена";
        return scene;
    }

    private static Scene crownScene() {
        int n = 90;
        double cell = 0.2;
        WaterGrid g = grid(n, cell);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double bed = 63.6 - Math.max(0.0, 1.0 - Math.hypot(x - 9, z - 9) / 8.0) * 1.2
                        + fbm(x * 0.5, z * 0.5, 2, 61) * 0.08;
                g.setGround(i, j, bed);
            }
        }
        fillToLevel(g, 63.72);
        SolverSettings s = SolverSettings.balanced();
        settle(g, 700, s);

        Scene scene = new Scene("08-crown");
        scene.parcels = new ParcelField();
        // Камень упал: забрали объём из воды и подбросили его вверх каплями.
        double taken = 0;
        for (int dj = -2; dj <= 2; dj++) {
            for (int di = -2; di <= 2; di++) {
                taken += g.removeVolume(45 + di, 45 + dj, 0.015);
            }
        }
        g.addFoam(9.0, 9.0, 2.2, 0.9);
        g.splash(9.0, 9.0, 0.8, 3.0);
        scene.parcels.impact(9.0, 63.72, 9.0, 1.9, 5.2, taken, 0.95);
        for (int t = 0; t < 11; t++) {
            scene.parcels.step(0.05, FluidConstants.STANDARD_GRAVITY);
            g.step(0.05, s, BoundarySource.CLOSED);
        }
        scene.grid = g;
        scene.time = 2.0;
        scene.wind = 1.0;
        scene.eye = new double[]{11.8, 64.5, 11.8};
        scene.target = new double[]{9.0, 63.8, 9.0};
        scene.fov = 50;
        scene.waterStep = 0.25;
        scene.note = "корона брызг: каждое тело - отдельная капля с массой";
        return scene;
    }

    // ---------------------------------------------------------------- рендер

    static final class Shot {
        final int[] rgb = new int[W * H];
        final double[] zbuf = new double[W * H];
        int waterQuads;
        int terrainTris;
        int drops;

        Shot() {
            java.util.Arrays.fill(zbuf, Double.POSITIVE_INFINITY);
        }
    }

    /**
     * Ставит камеру автоматически по маске воды.
     *
     * <p>Находит центр водоёма и его уровень, затем идёт от центра в заданном азимуте
     * до самого берега и встаёт чуть дальше него. Так кадр всегда «смотрит на воду»,
     * какой бы формы ни был водоём - озеро, река или лужа в яме.</p>
     *
     * @param azimuthDeg     направление, в котором стоит камера (0 - +X, 90 - +Z)
     * @param heightFactor   высота камеры над водой как доля размера водоёма
     * @param lift           на сколько поднять точку взгляда над водой
     * @param targetOffset   сдвиг точки взгляда вдоль азимута, в блоках
     */
    private static void autoCamera(Scene scene, double azimuthDeg, double heightFactor,
                                   double lift, double targetOffset) {
        autoCamera(scene, azimuthDeg, heightFactor, lift, targetOffset, 6.0);
    }

    private static void autoCamera(Scene scene, double azimuthDeg, double heightFactor,
                                   double lift, double targetOffset, double margin) {
        WaterGrid g = scene.grid;
        int n = g.width();
        double sx = 0;
        double sz = 0;
        double count = 0;
        double level = 0;
        double minX = 1e9;
        double maxX = -1e9;
        double minZ = 1e9;
        double maxZ = -1e9;
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double d = g.depth(i, j);
                if (d <= 0.05) {
                    continue;
                }
                double x = (i + 0.5) * g.cellSize();
                double z = (j + 0.5) * g.cellSize();
                sx += x;
                sz += z;
                level += g.ground(i, j) + d;
                count++;
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minZ = Math.min(minZ, z);
                maxZ = Math.max(maxZ, z);
            }
        }
        if (count < 1) {
            return;
        }
        sx /= count;
        sz /= count;
        level /= count;
        double extent = Math.max(maxX - minX, maxZ - minZ);
        if (Boolean.getBoolean("cameraDebug")) {
            System.out.printf("  [cam] %s cells=%.0f x=%.1f..%.1f z=%.1f..%.1f level=%.2f%n",
                    scene.name, count, minX, maxX, minZ, maxZ, level);
        }

        double az = Math.toRadians(azimuthDeg);
        double dirX = Math.cos(az);
        double dirZ = Math.sin(az);
        double tx = sx + dirX * targetOffset;
        double tz = sz + dirZ * targetOffset;
        double ty = level + lift;

        // Идём от точки взгляда наружу, пока не выйдем с воды на берег.
        double step = g.cellSize() * 0.5;
        double reach = extent * 0.75 + 4.0;
        double shoreX = sx;
        double shoreZ = sz;
        boolean found = false;
        for (double t = 0; t <= reach; t += step) {
            double px = tx + dirX * t;
            double pz = tz + dirZ * t;
            int i = (int) (px / g.cellSize());
            int j = (int) (pz / g.cellSize());
            if (i < 0 || j < 0 || i >= n || j >= n) {
                found = true;
                shoreX = px;
                shoreZ = pz;
                break;
            }
            if (g.depth(i, j) <= 0.05) {
                found = true;
                shoreX = px;
                shoreZ = pz;
                break;
            }
        }
        if (!found) {
            shoreX = tx + dirX * extent * 0.6;
            shoreZ = tz + dirZ * extent * 0.6;
        }
        // Отступаем от берега: стоящий вплотную к склону глаз «режет» ближнюю
        // геометрию, и на кадре появляются дыры по кромке ближней плоскости.
        double ex = shoreX + dirX * margin;
        double ez = shoreZ + dirZ * margin;
        double ey = level + Math.max(1.3, extent * heightFactor);

        int ei = Math.max(0, Math.min(n - 1, (int) (ex / g.cellSize())));
        int ej = Math.max(0, Math.min(n - 1, (int) (ez / g.cellSize())));
        ey = Math.max(ey, g.ground(ei, ej) + 1.1);
        scene.eye = new double[]{ex, ey, ez};
        scene.target = new double[]{tx, ty, tz};
    }

    private static double probeBed(HeightField f, double x, double z) {
        int i = (int) Math.round((x - f.originX) / f.step);
        int j = (int) Math.round((z - f.originZ) / f.step);
        if (!f.inside(i, j)) {
            return Double.NaN;
        }
        return f.bed[f.index(i, j)];
    }

    /** Камера не должна оказаться под землёй: поднимаем её над локальным рельефом. */
    private static void fixEye(Scene scene) {
        HeightField f = fromGrid(scene.grid, 0.5, scene.time, 0.0);
        double ex = scene.eye[0];
        double ez = scene.eye[2];
        int i = (int) Math.round((ex - f.originX) / f.step);
        int j = (int) Math.round((ez - f.originZ) / f.step);
        double ground = 60;
        if (f.inside(i, j)) {
            ground = f.bed[f.index(i, j)];
        }
        double minY = ground + 1.2;
        if (scene.eye[1] < minY) {
            scene.eye[1] = minY;
        }
        if (scene.target[1] < ground) {
            scene.target[1] = ground;
        }
    }

    private static Shot render(Scene scene) {
        fixEye(scene);
        HeightField probe = fromGrid(scene.grid, 0.5, scene.time, 0.0);
        System.out.printf("  камера %s: земля %.2f, цель земля %.2f%n",
                scene.name, probeBed(probe, scene.eye[0], scene.eye[2]),
                probeBed(probe, scene.target[0], scene.target[2]));
        HeightField surfaceProbe = fromGrid(scene.grid, 0.5, scene.time, 0.0);
        int pj = (int) Math.round((scene.eye[2] - surfaceProbe.originZ) / surfaceProbe.step);
        int pi = (int) Math.round((scene.eye[0] - surfaceProbe.originX) / surfaceProbe.step);
        if (surfaceProbe.inside(pi, pj)) {
            int pk = surfaceProbe.index(pi, pj);
            double level = surfaceProbe.bed[pk] + surfaceProbe.depth[pk];
            if (scene.eye[1] < level + 0.25) {
                System.out.printf("  ВНИМАНИЕ: камера %s под водой (%.2f < %.2f)%n",
                        scene.name, scene.eye[1], level);
            }
        }
        System.out.printf("  eye=(%.1f, %.1f, %.1f) target=(%.1f, %.1f, %.1f)%n",
                scene.eye[0], scene.eye[1], scene.eye[2],
                scene.target[0], scene.target[1], scene.target[2]);
        Shot shot = new Shot();
        double[] eye = scene.eye;
        double[] forward = normalize(sub(scene.target, eye));
        double[] right = normalize(cross(forward, new double[]{0, 1, 0}));
        double[] up = cross(right, forward);
        double[] sun = normalize(new double[]{scene.sunX, scene.sunY, scene.sunZ});

        drawSky(shot, eye, forward, right, up, scene.fov, sun);

        HeightField terrain = fromGrid(scene.grid, 0.75, scene.time, 0.0);
        drawTerrain(shot, terrain, eye, forward, right, up, sun, scene.fov);
        shot.terrainTris = (terrain.w - 1) * (terrain.h - 1) * 2;

        if (Boolean.getBoolean("nowater")) {
            return shot;
        }
        System.out.println("  отброшено по ближней плоскости: " + nearDropped);
        HeightField water = fromGrid(scene.grid, scene.waterStep, scene.time, 0.35);
        SurfaceMesher mesher = new SurfaceMesher(water.w * water.h + 16);
        SurfaceMesher.Output out = new SurfaceMesher.Output();
        mesher.build(water, Precision.BITS64, false, out, scene.time);
        shot.waterQuads = out.quads;
        drawWater(shot, out, eye, forward, right, up, sun, scene.fov);

        shot.drops = drawDrops(shot, scene, eye, forward, right, up, sun, scene.fov);
        return shot;
    }

    private static void drawSky(Shot shot, double[] eye, double[] forward, double[] right,
                                double[] up, double fov, double[] sun) {
        double f = 1.0 / Math.tan(Math.toRadians(fov) * 0.5);
        double aspect = (double) W / H;
        for (int y = 0; y < H; y++) {
            for (int x = 0; x < W; x++) {
                double sx = ((x + 0.5) / W * 2 - 1) * aspect / f;
                double sy = (1 - (y + 0.5) / H * 2) / f;
                double dx = forward[0] + right[0] * sx + up[0] * sy;
                double dy = forward[1] + right[1] * sx + up[1] * sy;
                double dz = forward[2] + right[2] * sx + up[2] * sy;
                double len = Math.sqrt(dx * dx + dy * dy + dz * dz);
                shot.rgb[x + y * W] = skyColor(dx / len, dy / len, dz / len, sun);
            }
        }
    }

    private static int skyColor(double dx, double dy, double dz, double[] sun) {
        if (dy < 0.03) {
            // Ниже горизонта - не пустота, а дальняя земля в дымке; переход плавный,
            // иначе на горизонте видна резкая линия.
            double k = smoothstep(0.03, -0.06, dy);
            double hazeR = mix(0.60, FOG_R, k);
            double hazeG = mix(0.73, FOG_G, k);
            double hazeB = mix(0.85, FOG_B, k);
            double up = smoothstep(-0.03, 0.03, dy);
            double skyT = Math.max(0.0, Math.min(1.0, dy * 0.5 + 0.5));
            double sr = mix(0.64, 0.19, smoothstep(0.45, 1.0, skyT));
            double sg = mix(0.78, 0.41, smoothstep(0.45, 1.0, skyT));
            double sb = mix(0.90, 0.78, smoothstep(0.45, 1.0, skyT));
            return pack(mix(hazeR, sr, up), mix(hazeG, sg, up), mix(hazeB, sb, up));
        }
        double t = Math.max(0.0, Math.min(1.0, dy * 0.5 + 0.5));
        double r = mix(0.64, 0.19, smoothstep(0.45, 1.0, t));
        double g = mix(0.78, 0.41, smoothstep(0.45, 1.0, t));
        double b = mix(0.90, 0.78, smoothstep(0.45, 1.0, t));

        double cos = dx * sun[0] + dy * sun[1] + dz * sun[2];
        if (cos > 0) {
            double glow = Math.pow(cos, 140.0) * 1.2 + Math.pow(cos, 9.0) * 0.16;
            r += glow;
            g += glow * 0.96;
            b += glow * 0.84;
        }
        double cloud = fbm(dx * 3.2 + 5, dz * 3.2 + 7, 4, 3);
        if (dy > 0.02) {
            double band = Math.max(0.0, (cloud - 0.55) * 2.4) * Math.min(1.0, dy * 4.0) * 0.5;
            r = mix(r, 0.97, band);
            g = mix(g, 0.98, band);
            b = mix(b, 1.0, band);
        }
        return pack(clamp01(r), clamp01(g), clamp01(b));
    }

    private static void drawTerrain(Shot shot, HeightField f, double[] eye, double[] forward,
                                    double[] right, double[] up, double[] sun, double fov) {
        double[] p0 = new double[3];
        double[] p1 = new double[3];
        double[] p2 = new double[3];
        double[] p3 = new double[3];
        double[] nodeNx = new double[f.w * f.h];
        double[] nodeNy = new double[f.w * f.h];
        double[] nodeNz = new double[f.w * f.h];
        int[] nodeColor = new int[f.w * f.h];
        for (int j = 0; j < f.h; j++) {
            for (int i = 0; i < f.w; i++) {
                int k = f.index(i, j);
                int kl = i > 0 ? k - 1 : k;
                int kr = i < f.w - 1 ? k + 1 : k;
                int kd = j > 0 ? k - f.w : k;
                int ku = j < f.h - 1 ? k + f.w : k;
                double nx = (f.bed[kl] - f.bed[kr]) / (2 * f.step);
                double nz = (f.bed[kd] - f.bed[ku]) / (2 * f.step);
                double len = Math.sqrt(nx * nx + 1 + nz * nz);
                nodeNx[k] = nx / len;
                nodeNy[k] = 1 / len;
                nodeNz[k] = nz / len;
                nodeColor[k] = terrainColor(f.worldX(i), f.bed[k], f.worldZ(j), nodeNy[k], waterLevel(f));
            }
        }

        int[] vertexColor = new int[4];
        for (int j = 0; j < f.h - 1; j++) {
            for (int i = 0; i < f.w - 1; i++) {
                int k00 = f.index(i, j);
                int k10 = k00 + 1;
                int k01 = k00 + f.w;
                int k11 = k01 + 1;

                p0[0] = f.worldX(i);
                p0[2] = f.worldZ(j);
                p0[1] = f.bed[k00];
                p1[0] = f.worldX(i + 1);
                p1[2] = f.worldZ(j);
                p1[1] = f.bed[k10];
                p2[0] = f.worldX(i + 1);
                p2[2] = f.worldZ(j + 1);
                p2[1] = f.bed[k11];
                p3[0] = f.worldX(i);
                p3[2] = f.worldZ(j + 1);
                p3[1] = f.bed[k01];

                // Под водой дно темнее и синее: свет проходит через толщу. Тонируем
                // ПО ВЕРШИНАМ: если брать максимум по кваду, соседние квады красятся
                // по-разному и на склоне появляются тёмные треугольные «заплатки».
                vertexColor[0] = underwaterTint(shade(nodeColor[k00], nodeNy[k00], sun), f.depth[k00]);
                vertexColor[1] = underwaterTint(shade(nodeColor[k10], nodeNy[k10], sun), f.depth[k10]);
                vertexColor[2] = underwaterTint(shade(nodeColor[k11], nodeNy[k11], sun), f.depth[k11]);
                vertexColor[3] = underwaterTint(shade(nodeColor[k01], nodeNy[k01], sun), f.depth[k01]);

                triGouraud(shot, eye, forward, right, up, fov, p0, p1, p2,
                        vertexColor[0], vertexColor[1], vertexColor[2]);
                triGouraud(shot, eye, forward, right, up, fov, p0, p2, p3,
                        vertexColor[0], vertexColor[2], vertexColor[3]);
                shot.terrainTris += 0;
            }
        }
    }

    private static int underwaterTint(int color, double depth) {
        double k = 1.0 - Math.exp(-Math.max(0.0, depth) * 0.55);
        int r = (int) (((color >> 16) & 0xFF) * (1.0 - 0.55 * k));
        int g = (int) (((color >> 8) & 0xFF) * (1.0 - 0.34 * k));
        int b = (int) ((color & 0xFF) * (1.0 - 0.20 * k) + 40 * k);
        return (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);
    }

    /** Уровень воды сцены: по нему красится песок на берегу и трава выше. */
    private static double waterLevel(HeightField f) {
        double max = Double.NEGATIVE_INFINITY;
        for (int k = 0; k < f.bed.length; k++) {
            if (f.depth[k] > 0.05) {
                max = Math.max(max, f.bed[k] + f.depth[k]);
            }
        }
        return max == Double.NEGATIVE_INFINITY ? 64.0 : max;
    }

    private static int terrainColor(double x, double y, double z, double ny, double level) {
        double rocky = Math.max(0.0, Math.min(1.0, 1.0 - (ny - 0.72) * 5.0));
        double sand = Math.max(0.0, Math.min(1.0, (level + 0.22 - y) * 3.2));
        double n = fbm(x * 0.5, z * 0.5, 3, 41);
        double fine = fbm(x * 3.1, z * 3.1, 2, 43);
        double patch = fbm(x * 0.14, z * 0.14, 2, 47);

        double grassR = 0.24 + n * 0.10 + fine * 0.06 + patch * 0.05;
        double grassG = 0.37 + n * 0.13 + fine * 0.07 + patch * 0.06;
        double grassB = 0.17 + n * 0.06 + fine * 0.03;
        double sandR = 0.60;
        double sandG = 0.55;
        double sandB = 0.38;
        double rockR = 0.38;
        double rockG = 0.37;
        double rockB = 0.36;

        double t = Math.max(0.0, Math.min(1.0, sand));
        double r = mix(grassR, sandR, t);
        double g = mix(grassG, sandG, t);
        double b = mix(grassB, sandB, t);
        r = mix(r, rockR, rocky);
        g = mix(g, rockG, rocky);
        b = mix(b, rockB, rocky);
        return pack(clamp01(r), clamp01(g), clamp01(b));
    }

    private static int shade(int color, double ny, double[] sun) {
        double diff = Math.max(0.0, ny * sun[1] + 0.55);
        // Верхняя граница обязательна: без неё плоские светлые участки выцветают в белое.
        double shade = Math.min(1.18, 0.42 + 0.72 * diff);
        shade *= 0.88 + 0.18 * ny;
        int r = clamp((int) (((color >> 16) & 0xFF) * shade));
        int g = clamp((int) (((color >> 8) & 0xFF) * shade));
        int b = clamp((int) ((color & 0xFF) * shade));
        return (r << 16) | (g << 8) | b;
    }

    /** Вода: Френель, блик, поглощение, пена и глубина. */
    private static void drawWater(Shot shot, SurfaceMesher.Output out, double[] eye,
                                  double[] forward, double[] right, double[] up, double[] sun,
                                  double fov) {
        double[] w0 = new double[3];
        double[] w1 = new double[3];
        double[] w2 = new double[3];
        double[] w3 = new double[3];
        double[] n0 = new double[3];
        double[] n1 = new double[3];
        double[] n2 = new double[3];
        double[] n3 = new double[3];

        for (int q = 0; q < out.quads; q++) {
            int p = q * 12;
            int ci = q * 4;
            for (int v = 0; v < 4; v++) {
                double[] target = switch (v) {
                    case 0 -> w0;
                    case 1 -> w1;
                    case 2 -> w2;
                    default -> w3;
                };
                target[0] = out.pos[p + v * 3];
                target[1] = out.pos[p + v * 3 + 1];
                target[2] = out.pos[p + v * 3 + 2];
            }
            for (int v = 0; v < 4; v++) {
                double[] target = switch (v) {
                    case 0 -> n0;
                    case 1 -> n1;
                    case 2 -> n2;
                    default -> n3;
                };
                target[0] = out.nrm[p + v * 3];
                target[1] = out.nrm[p + v * 3 + 1];
                target[2] = out.nrm[p + v * 3 + 2];
            }
            int c0 = out.color[ci];
            int c1 = out.color[ci + 1];
            int c2 = out.color[ci + 2];
            int c3 = out.color[ci + 3];
            double[] d = {out.depth[ci], out.depth[ci + 1], out.depth[ci + 2], out.depth[ci + 3]};
            double[] f = {out.foam[ci], out.foam[ci + 1], out.foam[ci + 2], out.foam[ci + 3]};

            waterTri(shot, eye, forward, right, up, fov, sun, w0, w1, w2, n0, n1, n2,
                    c0, c1, c2, d[0], d[1], d[2], f[0], f[1], f[2]);
            waterTri(shot, eye, forward, right, up, fov, sun, w0, w2, w3, n0, n2, n3,
                    c0, c2, c3, d[0], d[2], d[3], f[0], f[2], f[3]);
        }
    }

    private static void waterTri(Shot shot, double[] eye, double[] forward, double[] right,
                                 double[] up, double fov, double[] sun,
                                 double[] a3, double[] b3, double[] c3,
                                 double[] na, double[] nb, double[] nc,
                                 int ca, int cb, int cc,
                                 double da, double db, double dc,
                                 double fa, double fb, double fc) {
        double[] a = project(a3, eye, forward, right, up, fov);
        double[] b = project(b3, eye, forward, right, up, fov);
        double[] c = project(c3, eye, forward, right, up, fov);
        if (a == null || b == null || c == null) {
            return;
        }
        double area = edge(a[0], a[1], b[0], b[1], c[0], c[1]);
        if (Math.abs(area) < 1e-9) {
            return;
        }
        double invArea = 1.0 / area;
        int x0 = Math.max(0, (int) Math.floor(Math.min(a[0], Math.min(b[0], c[0]))));
        int x1 = Math.min(W - 1, (int) Math.ceil(Math.max(a[0], Math.max(b[0], c[0]))));
        int y0 = Math.max(0, (int) Math.floor(Math.min(a[1], Math.min(b[1], c[1]))));
        int y1 = Math.min(H - 1, (int) Math.ceil(Math.max(a[1], Math.max(b[1], c[1]))));
        if (x1 < x0 || y1 < y0) {
            return;
        }

        for (int y = y0; y <= y1; y++) {
            double py = y + 0.5;
            for (int x = x0; x <= x1; x++) {
                double px = x + 0.5;
                double w0 = edge(b[0], b[1], c[0], c[1], px, py) * invArea;
                double w1 = edge(c[0], c[1], a[0], a[1], px, py) * invArea;
                double w2 = 1.0 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) {
                    continue;
                }
                double invZ = w0 / a[2] + w1 / b[2] + w2 / c[2];
                if (invZ <= 1e-9) {
                    continue;
                }
                double depthZ = 1.0 / invZ;
                int idx = x + y * W;
                if (depthZ >= shot.zbuf[idx] + 1e-4) {
                    continue;
                }

                double nx = na[0] * w0 + nb[0] * w1 + nc[0] * w2;
                double ny = na[1] * w0 + nb[1] * w1 + nc[1] * w2;
                double nz = na[2] * w0 + nb[2] * w1 + nc[2] * w2;
                double nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (nlen < 1e-6) {
                    nlen = 1;
                }
                nx /= nlen;
                ny /= nlen;
                nz /= nlen;

                double thickness = Math.max(0.0, da * w0 + db * w1 + dc * w2);
                double foam = Math.min(1.0, fa * w0 + fb * w1 + fc * w2);

                // Цвет тела считает та же палитра, что и в моде: поглощение по глубине,
                // Френель, гребни, пена. Поэтому превью - честная картинка.
                int body = WaterPalette.color(thickness, nx, ny, nz, foam, 1.0, 0.0, Precision.BITS64);
                double wr = ((body >> 16) & 0xFF) / 255.0;
                double wg = ((body >> 8) & 0xFF) / 255.0;
                double wb = (body & 0xFF) / 255.0;
                double bodyAlpha = ((body >>> 24) & 0xFF) / 255.0;

                // направление на камеру
                double vx = eye[0] - (a3[0] * w0 + b3[0] * w1 + c3[0] * w2);
                double vy = eye[1] - (a3[1] * w0 + b3[1] * w1 + c3[1] * w2);
                double vz = eye[2] - (a3[2] * w0 + b3[2] * w1 + c3[2] * w2);
                double vlen = Math.sqrt(vx * vx + vy * vy + vz * vz);
                vx /= vlen;
                vy /= vlen;
                vz /= vlen;

                double facing = Math.abs(nx * vx + ny * vy + nz * vz);
                double fresnel = 0.02 + 0.98 * Math.pow(1.0 - facing, 5.0);

                double rdx = 2 * (nx * vx + ny * vy + nz * vz) * nx - vx;
                double rdy = 2 * (nx * vx + ny * vy + nz * vz) * ny - vy;
                double rdz = 2 * (nx * vx + ny * vy + nz * vz) * nz - vz;
                int skyPacked = skyColor(rdx, Math.max(0.04, rdy), rdz, sun);
                double skyR = ((skyPacked >> 16) & 0xFF) / 255.0;
                double skyG = ((skyPacked >> 8) & 0xFF) / 255.0;
                double skyB = (skyPacked & 0xFF) / 255.0;

                double diff = Math.max(0.0, nx * sun[0] + ny * sun[1] + nz * sun[2]);
                double hx = sun[0] + vx;
                double hy = sun[1] + vy;
                double hz = sun[2] + vz;
                double hlen = Math.sqrt(hx * hx + hy * hy + hz * hz);
                double ndoth = Math.max(0.0, (nx * hx + ny * hy + nz * hz) / hlen);
                double spec = Math.pow(ndoth, 260.0) * 2.2 + Math.pow(ndoth, 34.0) * 0.10;

                if (thicknessDebug) {
                    double k = thickness;
                    int rr0 = clamp((int) (255 * Math.min(1.0, Math.max(0.0, 1.0 - k * 4.0))));
                    int gg0 = clamp((int) (255 * Math.min(1.0, Math.max(0.0, 1.0 - Math.abs(k - 0.15) * 6.0))));
                    int bb0 = clamp((int) (255 * Math.min(1.0, Math.max(0.0, (k - 0.3) * 3.0))));
                    int dst0 = shot.rgb[x + y * W];
                    shot.rgb[x + y * W] = (mix(((dst0 >> 16) & 0xFF) / 255.0, rr0 / 255.0, 0.85) > 0 ? 0 : 0)
                            | (clamp((int) (rr0 * 0.9)) << 16)
                            | (clamp((int) (gg0 * 0.9)) << 8)
                            | clamp((int) (bb0 * 0.9));
                    shot.zbuf[idx] = Math.min(shot.zbuf[idx], depthZ);
                    continue;
                }

                double mixK = fresnel * 0.92 + 0.015;
                double outR = mix(wr * (0.62 + 0.45 * diff), skyR * 1.03, mixK) + spec;
                double outG = mix(wg * (0.62 + 0.45 * diff), skyG * 1.03, mixK) + spec * 1.01;
                double outB = mix(wb * (0.62 + 0.45 * diff), skyB * 1.04, mixK) + spec * 1.04;

                // Пена: белая, с волокнистой структурой по шуму мира.
                if (foam > 0.01) {
                    double grain = Noise.fbm(a3[0] * w0 + b3[0] * w1 + c3[0] * w2,
                            a3[2] * w0 + b3[2] * w1 + c3[2] * w2, 3, 17);
                    double foamK = foam * (0.72 + 0.5 * grain);
                    outR = mix(outR, 0.97, foamK * 0.9);
                    outG = mix(outG, 0.99, foamK * 0.9);
                    outB = mix(outB, 1.0, foamK * 0.9);
                }

                int dst = shot.rgb[idx];
                double bgR = ((dst >> 16) & 0xFF) / 255.0;
                double bgG = ((dst >> 8) & 0xFF) / 255.0;
                double bgB = (dst & 0xFF) / 255.0;

                double fog = fogK(depthZ);
                outR = mix(outR, FOG_R, fog);
                outG = mix(outG, FOG_G, fog);
                outB = mix(outB, FOG_B, fog);

                double depthAlpha = 1.0 - Math.exp(-thickness * 0.9);
                double mixAlpha = 0.20 + 0.42 * bodyAlpha + 0.35 * depthAlpha
                        + fresnel * 0.36 + foam * 0.45 + fog * 0.5;
                mixAlpha = Math.min(0.98, Math.max(0.18, mixAlpha));
                int rr = clamp((int) ((outR * mixAlpha + bgR * (1 - mixAlpha)) * 255));
                int gg = clamp((int) ((outG * mixAlpha + bgG * (1 - mixAlpha)) * 255));
                int bb = clamp((int) ((outB * mixAlpha + bgB * (1 - mixAlpha)) * 255));
                shot.rgb[idx] = (rr << 16) | (gg << 8) | bb;
                shot.zbuf[idx] = Math.min(shot.zbuf[idx], depthZ);
            }
        }
    }

    /** Капли: маленькие тела, нарисованные как капли, а не как точки. */
    private static int drawDrops(Shot shot, Scene scene, double[] eye, double[] forward,
                                 double[] right, double[] up, double[] sun, double fov) {
        ParcelField parcels = scene.parcels;
        if (parcels == null || parcels.isEmpty()) {
            return 0;
        }
        record Drop(double[] screen, double depth, double radius, double foam, double speed) {
        }
        List<Drop> drops = new ArrayList<>();
        for (int i = 0; i < parcels.count(); i++) {
            ParcelField.Parcel p = parcels.at(i);
            if (p == null || !p.alive()) {
                continue;
            }
            double[] projected = project(new double[]{p.x, p.y, p.z}, eye, forward, right, up, fov);
            if (projected == null) {
                continue;
            }
            int px = (int) projected[0];
            int py = (int) projected[1];
            if (px < -40 || py < -40 || px >= W + 40 || py >= H + 40) {
                continue;
            }
            double focal = H / (2.0 * Math.tan(Math.toRadians(fov) * 0.5));
            double pixels = Math.max(1.0, p.radius() * 1.9 * focal / Math.max(0.3, projected[2]));
            drops.add(new Drop(projected, projected[2], Math.min(9.0, Math.max(0.8, pixels)), p.foam, p.speed()));
        }
        drops.sort(Comparator.comparingDouble(Drop::depth).reversed());
        int drawn = 0;
        for (Drop drop : drops) {
            int cx = (int) Math.round(drop.screen()[0]);
            int cy = (int) Math.round(drop.screen()[1]);
            int r = (int) Math.max(1.0, drop.radius());
            double alpha = Math.min(0.95, 0.30 + 0.05 * drop.radius() + drop.foam() * 0.5);
            // Летящая капля смазывается по вертикали: это читается как движение,
            // а не как висящий в воздухе шарик.
            int ry = r + (int) Math.min(4.0, drop.speed() * 0.35);
            for (int dy = -ry; dy <= ry; dy++) {
                for (int dx = -r; dx <= r; dx++) {
                    double dist = Math.sqrt((dx * dx) / (double) (r * r)
                            + (dy * dy) / (double) (ry * ry));
                    if (dist > 1.0) {
                        continue;
                    }
                    int x = cx + dx;
                    int y = cy + dy;
                    if (x < 0 || y < 0 || x >= W || y >= H) {
                        continue;
                    }
                    int idx = x + y * W;
                    if (drop.depth() > shot.zbuf[idx] + 0.5) {
                        continue;
                    }
                    // Капля: тёмный низ, светлый верх, блик от солнца.
                    double shadeK = 0.45 + 0.55 * (1.0 - (dy + ry) / (2.0 * ry + 1e-6));
                    double highlight = Math.max(0.0, 1.0 - Math.hypot(dx + r * 0.35, dy + ry * 0.45)
                            / Math.max(0.8, r * 0.55));
                    double wr = mix(0.36 + 0.5 * drop.foam(), 1.0, highlight) * (0.7 + 0.4 * shadeK);
                    double wg = mix(0.55 + 0.42 * drop.foam(), 1.0, highlight) * (0.7 + 0.4 * shadeK);
                    double wb = mix(0.62 + 0.38 * drop.foam(), 1.0, highlight) * (0.7 + 0.4 * shadeK);
                    double a = alpha * (1.0 - dist * dist * 0.25);
                    int dst = shot.rgb[idx];
                    int rr = clamp((int) (mix(((dst >> 16) & 0xFF) / 255.0, wr, a) * 255));
                    int gg = clamp((int) (mix(((dst >> 8) & 0xFF) / 255.0, wg, a) * 255));
                    int bb = clamp((int) (mix((dst & 0xFF) / 255.0, wb, a) * 255));
                    shot.rgb[idx] = (rr << 16) | (gg << 8) | bb;
                    if (a > 0.6) {
                        shot.zbuf[idx] = Math.min(shot.zbuf[idx], drop.depth());
                    }
                }
            }
            drawn++;
        }
        return drawn;
    }

    // ---------------------------------------------------------------- растеризация

    private static double[] project(double[] p, double[] eye, double[] forward, double[] right,
                                    double[] up, double fov) {
        double dx = p[0] - eye[0];
        double dy = p[1] - eye[1];
        double dz = p[2] - eye[2];
        double cz = dx * forward[0] + dy * forward[1] + dz * forward[2];
        if (cz < 0.05) {
            nearDropped++;
            return null;
        }
        double cx = dx * right[0] + dy * right[1] + dz * right[2];
        double cy = dx * up[0] + dy * up[1] + dz * up[2];
        double f = 1.0 / Math.tan(Math.toRadians(fov) * 0.5);
        double aspect = (double) W / H;
        double[] out = new double[3];
        out[0] = ((cx * f / aspect) / cz * 0.5 + 0.5) * W;
        out[1] = (0.5 - (cy * f / cz) * 0.5) * H;
        out[2] = cz;
        return out;
    }

    private static void triGouraud(Shot shot, double[] eye, double[] forward, double[] right, double[] up,
                                   double fov, double[] a3, double[] b3, double[] c3,
                                   int ca, int cb, int cc) {
        double[] a = project(a3, eye, forward, right, up, fov);
        double[] b = project(b3, eye, forward, right, up, fov);
        double[] c = project(c3, eye, forward, right, up, fov);
        if (a == null || b == null || c == null) {
            return;
        }
        double area = edge(a[0], a[1], b[0], b[1], c[0], c[1]);
        if (Math.abs(area) < 1e-9) {
            return;
        }
        double invArea = 1.0 / area;
        int x0 = Math.max(0, (int) Math.floor(Math.min(a[0], Math.min(b[0], c[0]))));
        int x1 = Math.min(W - 1, (int) Math.ceil(Math.max(a[0], Math.max(b[0], c[0]))));
        int y0 = Math.max(0, (int) Math.floor(Math.min(a[1], Math.min(b[1], c[1]))));
        int y1 = Math.min(H - 1, (int) Math.ceil(Math.max(a[1], Math.max(b[1], c[1]))));
        if (x1 < x0 || y1 < y0) {
            return;
        }
        double ar = ((ca >> 16) & 0xFF) / 255.0;
        double ag = ((ca >> 8) & 0xFF) / 255.0;
        double ab = (ca & 0xFF) / 255.0;
        double br = ((cb >> 16) & 0xFF) / 255.0;
        double bg = ((cb >> 8) & 0xFF) / 255.0;
        double bb = (cb & 0xFF) / 255.0;
        double cr = ((cc >> 16) & 0xFF) / 255.0;
        double cg = ((cc >> 8) & 0xFF) / 255.0;
        double cbv = (cc & 0xFF) / 255.0;

        for (int y = y0; y <= y1; y++) {
            double py = y + 0.5;
            for (int x = x0; x <= x1; x++) {
                double px = x + 0.5;
                double w0 = edge(b[0], b[1], c[0], c[1], px, py) * invArea;
                double w1 = edge(c[0], c[1], a[0], a[1], px, py) * invArea;
                double w2 = 1.0 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) {
                    continue;
                }
                double invZ = w0 / a[2] + w1 / b[2] + w2 / c[2];
                if (invZ <= 1e-9) {
                    continue;
                }
                double depth = 1.0 / invZ;
                int idx = x + y * W;
                if (depth >= shot.zbuf[idx] + 1e-4) {
                    continue;
                }
                double rr = ar * w0 + br * w1 + cr * w2;
                double gg = ag * w0 + bg * w1 + cg * w2;
                double bbb = ab * w0 + bb * w1 + cbv * w2;
                double fog = fogK(depth);
                rr = mix(rr, FOG_R, fog);
                gg = mix(gg, FOG_G, fog);
                bbb = mix(bbb, FOG_B, fog);
                shot.rgb[idx] = (clamp((int) (rr * 255)) << 16)
                        | (clamp((int) (gg * 255)) << 8)
                        | clamp((int) (bbb * 255));
                shot.zbuf[idx] = depth;
            }
        }
    }

    // ---------------------------------------------------------------- утилиты

    /** Цвет дымки у горизонта: в него уходит и небо, и дальняя земля, и дальняя вода. */
    private static final double FOG_R = 0.64;
    private static final double FOG_G = 0.77;
    private static final double FOG_B = 0.88;

    private static double fogK(double distance) {
        return 1.0 - Math.exp(-Math.max(0.0, distance) * 0.0042);
    }

    private static double edge(double ax, double ay, double bx, double by, double px, double py) {
        return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    }

    private static double mix(double a, double b, double t) {
        return a + (b - a) * Math.min(1.0, Math.max(0.0, t));
    }

    private static double smoothstep(double e0, double e1, double x) {
        double t = Math.min(1.0, Math.max(0.0, (x - e0) / (e1 - e0)));
        return t * t * (3 - 2 * t);
    }

    private static double clamp01(double v) {
        return v < 0 ? 0 : Math.min(v, 1.0);
    }

    private static int clamp(int v) {
        return v < 0 ? 0 : Math.min(255, v);
    }

    private static int pack(double r, double g, double b) {
        return (clamp((int) (r * 255)) << 16) | (clamp((int) (g * 255)) << 8) | clamp((int) (b * 255));
    }

    private static double[] sub(double[] a, double[] b) {
        return new double[]{a[0] - b[0], a[1] - b[1], a[2] - b[2]};
    }

    private static double[] cross(double[] a, double[] b) {
        return new double[]{
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0]
        };
    }

    private static double[] normalize(double[] v) {
        double len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        if (len < 1e-9) {
            return new double[]{0, 1, 0};
        }
        return new double[]{v[0] / len, v[1] / len, v[2] / len};
    }

    // ---------------------------------------------------------------- PNG

    private static void writePng(File file, int[] rgb, int width, int height) throws IOException {
        byte[] raw = new byte[(width * 3 + 1) * height];
        int p = 0;
        for (int y = 0; y < height; y++) {
            raw[p++] = 0;
            for (int x = 0; x < width; x++) {
                int c = rgb[x + y * width];
                raw[p++] = (byte) ((c >> 16) & 0xFF);
                raw[p++] = (byte) ((c >> 8) & 0xFF);
                raw[p++] = (byte) (c & 0xFF);
            }
        }
        byte[] compressed = deflate(raw);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(new byte[]{(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'});
        byte[] ihdr = new byte[13];
        writeInt(ihdr, 0, width);
        writeInt(ihdr, 4, height);
        ihdr[8] = 8;
        ihdr[9] = 2;
        chunk(out, "IHDR", ihdr);
        chunk(out, "IDAT", compressed);
        chunk(out, "IEND", new byte[0]);
        try (FileOutputStream fos = new FileOutputStream(file)) {
            fos.write(out.toByteArray());
        }
    }

    private static byte[] deflate(byte[] data) {
        Deflater deflater = new Deflater(Deflater.BEST_COMPRESSION);
        deflater.setInput(data);
        deflater.finish();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[1 << 16];
        while (!deflater.finished()) {
            int n = deflater.deflate(buf);
            out.write(buf, 0, n);
        }
        deflater.end();
        return out.toByteArray();
    }

    private static void writeInt(byte[] out, int offset, int value) {
        out[offset] = (byte) (value >>> 24);
        out[offset + 1] = (byte) (value >>> 16);
        out[offset + 2] = (byte) (value >>> 8);
        out[offset + 3] = (byte) value;
    }

    private static void chunk(ByteArrayOutputStream out, String type, byte[] data) throws IOException {
        byte[] length = new byte[4];
        writeInt(length, 0, data.length);
        out.write(length);
        byte[] typeBytes = type.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        out.write(typeBytes);
        out.write(data);
        CRC32 crc = new CRC32();
        crc.update(typeBytes);
        crc.update(data);
        byte[] crcBytes = new byte[4];
        writeInt(crcBytes, 0, (int) crc.getValue());
        out.write(crcBytes);
    }
}
