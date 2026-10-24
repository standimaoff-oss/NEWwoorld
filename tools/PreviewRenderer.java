/*
 * Превью-рендерер Aquaflux.
 *
 * Чистый Java: ни Minecraft, ни OpenGL, ни внешних библиотек. Берёт ТОТ ЖЕ решатель и
 * ТОТ ЖЕ мешер (com.standimaoff.aquaflux.core), что и мод, и рисует их программным
 * растеризатором в PNG. Так видно форму воды без запуска игры.
 *
 * Запуск:  java -cp build/preview PreviewRenderer docs/preview
 */

import com.standimaoff.aquaflux.core.BoundarySource;
import com.standimaoff.aquaflux.core.HeightField;
import com.standimaoff.aquaflux.core.Precision;
import com.standimaoff.aquaflux.core.SolverSettings;
import com.standimaoff.aquaflux.core.SurfaceMesher;
import com.standimaoff.aquaflux.core.WaterGrid;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.CRC32;
import java.util.zip.Deflater;

public final class PreviewRenderer {

    private static final int W = 1280;
    private static final int H = 720;

    // ---------------------------------------------------------------- сцены

    static final class Scene {
        final String name;
        HeightField field;
        double[] eye;
        double[] target;
        double fov = 55;
        double sunX = -0.42;
        double sunY = 0.72;
        double sunZ = 0.55;

        Scene(String name) {
            this.name = name;
        }
    }

    public static void main(String[] args) throws IOException {
        File outDir = new File(args.length > 0 ? args[0] : "docs/preview");
        if (!outDir.exists() && !outDir.mkdirs()) {
            throw new IOException("не могу создать " + outDir);
        }

        List<Scene> scenes = new ArrayList<>();
        scenes.add(lakeScene());
        scenes.add(riverScene());
        scenes.add(pitScene());
        scenes.add(explosionScene());
        scenes.add(wavesScene());
        scenes.add(shoreScene());

        for (Scene scene : scenes) {
            long t0 = System.currentTimeMillis();
            Shot shot = render(scene);
            File file = new File(outDir, scene.name + ".png");
            writePng(file, shot.rgb, W, H);
            System.out.printf("%-12s вода: %5d квадов, земля: %6d треугольников, %5d мс -> %s%n",
                    scene.name, shot.waterQuads, shot.terrainTris,
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

    /** Лёгкая ветровая рябь: несколько наложенных волн, чтобы поверхность читалась. */
    private static void addRipples(HeightField f, double amplitude, int seed) {
        for (int j = 0; j < f.h; j++) {
            double z = f.worldZ(j);
            for (int i = 0; i < f.w; i++) {
                double x = f.worldX(i);
                int k = f.index(i, j);
                if (f.depth[k] <= 1.0e-4) {
                    continue;
                }
                double r = Math.sin(x * 0.9 + z * 0.35 + seed * 0.7) * 0.55
                        + Math.sin(x * 0.31 - z * 1.15 + seed) * 0.3
                        + Math.sin(x * 2.3 + z * 1.9) * 0.15;
                f.wave[k] += amplitude * r;
            }
        }
    }

    private static HeightField fromGrid(WaterGrid grid, double originX, double originZ) {
        int n = grid.width();
        HeightField f = new HeightField(n, n, grid.cellSize(),
                originX + grid.cellSize() * 0.5, originZ + grid.cellSize() * 0.5);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                f.set(i, j, grid.ground(i, j), grid.depth(i, j), grid.waveAt(i, j), grid.foamAt(i, j));
            }
        }
        return f;
    }

    private static WaterGrid grid(int n, double cell) {
        return new WaterGrid(n, n, cell, Precision.BITS64);
    }

    private static void fillWhere(WaterGrid g, double level, double amount) {
        int n = g.width();
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                if (g.ground(i, j) < level) {
                    g.addVolume(i, j, amount);
                }
            }
        }
    }

    private static void settle(WaterGrid g, int steps, SolverSettings s) {
        for (int t = 0; t < steps; t++) {
            g.step(0.05, s, BoundarySource.CLOSED);
        }
    }

    // ---------------------------------------------------------------- сцены

    private static Scene lakeScene() {
        int n = 128;
        double cell = 0.5;
        WaterGrid g = grid(n, cell);
        double cx = 32;
        double cz = 32;
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double d = Math.hypot(x - cx, z - cz) + fbm(x * 0.09, z * 0.09, 3, 71) * 4.5 - 2.2;
                double base = 64.0 + fbm(x * 0.11, z * 0.11, 4, 11) * 9.0 + fbm(x * 0.42, z * 0.42, 3, 27) * 1.2;
                double bowl = 64.9 - Math.max(0.0, 1.0 - (d / 20.0)) * 4.2;
                double bed = Math.max(bowl + Math.max(0.0, d - 20.0) * 0.75, base - 3.4);
                if (d < 20.0) {
                    bed = Math.min(bed, bowl);
                }
                g.setGround(i, j, bed);
            }
        }
        fillWhere(g, 64.35, 0.55);
        SolverSettings s = SolverSettings.balanced();
        settle(g, 900, s);
        for (int t = 0; t < 200; t++) {
            g.decayWaves(0.985);
            g.step(0.05, s, BoundarySource.CLOSED);
        }

        Scene scene = new Scene("01-lake");
        scene.field = fromGrid(g, 0, 0);
        addRipples(scene.field, 0.035, 3);
        scene.eye = new double[]{14, 67.4, 6};
        scene.target = new double[]{36, 63.6, 40};
        scene.fov = 58;
        return scene;
    }

    private static Scene riverScene() {
        int n = 140;
        double cell = 0.5;
        WaterGrid g = grid(n, cell);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double meander = 35.0 + Math.sin(z * 0.13) * 7.0 + Math.sin(z * 0.045 + 1.3) * 4.0;
                double dist = Math.abs(x - meander);
                double valley = 64.0 + z * 0.055;
                double base = valley + 5.5 + fbm(x * 0.22, z * 0.22, 4, 5) * 6.0;
                double channel = valley - Math.max(0.0, 1.0 - (dist / 5.0)) * 1.6;
                double bed = base;
                if (dist < 12.0) {
                    double t = Math.min(1.0, dist / 12.0);
                    bed = channel * (1 - t) + base * t;
                }
                g.setGround(i, j, bed);
            }
        }
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double level = 64.0 + z * 0.055 - 0.45;
                if (g.ground(i, j) < level) {
                    g.addVolume(i, j, (level - g.ground(i, j)) * 0.98);
                }
            }
        }
        SolverSettings s = SolverSettings.balanced();
        settle(g, 700, s);
        // рябь от камней и течения
        for (int t = 0; t < 260; t++) {
            if (t % 9 == 0) {
                double z = 6 + (t % 200) * 0.6;
                double meander = 35.0 + Math.sin(z * 0.13) * 7.0 + Math.sin(z * 0.045 + 1.3) * 4.0;
                g.splash(meander + Math.sin(t * 0.7) * 2.4, z, -0.02, 2.2);
            }
            g.step(0.05, s, BoundarySource.CLOSED);
        }

        Scene scene = new Scene("02-river");
        scene.field = fromGrid(g, 0, 0);
        addRipples(scene.field, 0.045, 7);
        scene.eye = new double[]{14, 72.5, 1.5};
        scene.target = new double[]{36, 65.2, 42};
        scene.fov = 56;
        return scene;
    }

    private static Scene pitScene() {
        // Небольшой участок: ровная земля, выкопанная яма и ведро воды, вылитое рядом.
        int n = 72;
        double cell = 0.5;
        WaterGrid g = grid(n, cell);
        double px = 18;
        double pz = 18;
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double bed = 64.0 + fbm(x * 0.25, z * 0.25, 3, 3) * 0.35;
                double d = Math.max(Math.abs(x - px), Math.abs(z - pz));
                if (d < 2.0) {
                    bed = 59.6;
                } else if (d < 3.2) {
                    bed = 61.4;
                } else if (d < 4.4) {
                    bed = 63.0;
                }
                g.setGround(i, j, bed);
            }
        }
        // вылили ведро (1 м^3) на край ямы и ещё одно внутрь
        g.addVolumeAt(20.5, 18.0, 1000.0);
        g.addVolumeAt(18.0, 20.5, 1000.0);
        SolverSettings s = SolverSettings.balanced();
        settle(g, 900, s);

        Scene scene = new Scene("03-pit");
        scene.field = fromGrid(g, 0, 0);
        addRipples(scene.field, 0.010, 5);
        scene.eye = new double[]{18 - 9.5, 66.2, 18 - 10.5};
        scene.target = new double[]{18.4, 61.6, 18.4};
        scene.fov = 62;
        return scene;
    }

    private static Scene explosionScene() {
        int n = 128;
        double cell = 0.5;
        WaterGrid g = grid(n, cell);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double d = Math.hypot(x - 32, z - 32);
                double bed = 62.0 + fbm(x * 0.15, z * 0.15, 3, 9) * 2.0
                        + Math.max(0.0, 2.2 - (1.0 - d / 22.0) * 2.2);
                g.setGround(i, j, bed);
            }
        }
        fillWhere(g, 63.1, 0.6);
        SolverSettings s = SolverSettings.balanced();
        settle(g, 600, s);
        g.explosion(32.0, 32.0, 1.7);
        for (int t = 0; t < 14; t++) {
            g.step(0.05, s, BoundarySource.CLOSED);
        }

        Scene scene = new Scene("04-explosion");
        scene.field = fromGrid(g, 0, 0);
        scene.eye = new double[]{32, 68.0, 4};
        scene.target = new double[]{32, 62.6, 32};
        scene.fov = 58;
        return scene;
    }

    private static Scene wavesScene() {
        int n = 110;
        double cell = 0.5;
        WaterGrid g = grid(n, cell);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double d = Math.hypot(x - 27, z - 27);
                g.setGround(i, j, 64.0 - Math.max(0.0, 1.0 - d / 15.0) * 1.9
                        + fbm(x * 0.3, z * 0.3, 3, 17) * 0.35);
            }
        }
        fillWhere(g, 64.2, 0.6);
        SolverSettings s = SolverSettings.balanced();
        settle(g, 700, s);
        // пловец идёт через воду: импульс + всплеск, как в игре
        for (int t = 0; t < 150; t++) {
            double z = 8 + t * 0.13;
            double x = 27 + Math.sin(t * 0.05) * 3.0;
            if (t % 3 == 0) {
                g.impulse(x, z, 0.0, 0.35, 2.2);
                g.splash(x, z, 0.45, 2.6);
                g.addFoam(x, z, 2.0, 0.35);
            }
            g.step(0.05, s, BoundarySource.CLOSED);
        }

        Scene scene = new Scene("05-waves");
        scene.field = fromGrid(g, 0, 0);
        scene.eye = new double[]{6, 67.5, 5};
        scene.target = new double[]{27, 63.0, 26};
        scene.fov = 54;
        return scene;
    }

    private static Scene shoreScene() {
        int n = 120;
        double cell = 0.25;
        WaterGrid g = grid(n, cell);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double shore = 12.0 + Math.sin(z * 0.55) * 1.6 + Math.sin(z * 0.21 + 2.0) * 2.2;
                double bed = 64.0 + Math.max(0.0, x - shore) * 0.62;
                bed += fbm(x * 0.8, z * 0.8, 3, 23) * 0.22;
                g.setGround(i, j, bed);
            }
        }
        fillWhere(g, 64.25, 0.5);
        SolverSettings s = SolverSettings.balanced();
        settle(g, 900, s);
        for (int t = 0; t < 160; t++) {
            if (t % 6 == 0) {
                g.splash(6 + Math.sin(t * 0.3) * 1.5, 5 + (t % 40) * 0.55, 0.06, 2.0);
            }
            g.step(0.05, s, BoundarySource.CLOSED);
        }

        Scene scene = new Scene("06-shore");
        scene.field = fromGrid(g, 0, 0);
        addRipples(scene.field, 0.012, 11);
        scene.eye = new double[]{2.0, 64.9, 1.5};
        scene.target = new double[]{11.0, 64.1, 10.0};
        scene.fov = 48;
        return scene;
    }

    // ---------------------------------------------------------------- рендер

    static final class Shot {
        final int[] rgb = new int[W * H];
        final double[] zbuf = new double[W * H];
        int waterQuads;
        int terrainTris;

        Shot() {
            java.util.Arrays.fill(zbuf, Double.POSITIVE_INFINITY);
        }
    }

    /** Камера не должна оказаться под землёй: поднимаем её над локальным рельефом. */
    private static void fixEye(Scene scene) {
        HeightField f = scene.field;
        double ex = scene.eye[0];
        double ez = scene.eye[2];
        int i = (int) Math.round((ex - f.originX) / f.step);
        int j = (int) Math.round((ez - f.originZ) / f.step);
        double ground = 60;
        if (f.inside(i, j)) {
            ground = f.bed[f.index(i, j)];
        }
        double minY = ground + 2.2;
        if (scene.eye[1] < minY) {
            scene.eye[1] = minY;
        }
        if (scene.target[1] < ground) {
            scene.target[1] = ground;
        }
    }

    private static Shot render(Scene scene) {
        fixEye(scene);
        Shot shot = new Shot();
        double[] eye = scene.eye;
        double[] forward = normalize(sub(scene.target, eye));
        double[] right = normalize(cross(forward, new double[]{0, 1, 0}));
        double[] up = cross(right, forward);
        double[] sun = normalize(new double[]{scene.sunX, scene.sunY, scene.sunZ});

        drawSky(shot, eye, forward, right, up, scene.fov, sun);

        HeightField f = scene.field;
        double[] p0 = new double[3];
        double[] p1 = new double[3];
        double[] p2 = new double[3];
        double[] p3 = new double[3];

        // нормали и цвет в узлах: соседние треугольники дают гладкую заливку (Гуро)
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
                nodeColor[k] = terrainColor(f.worldX(i), f.bed[k], f.worldZ(j), nodeNy[k], f);
            }
        }

        int[] cellVertexColor = new int[4];
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

                cellVertexColor[0] = shade(nodeColor[k00], nodeNy[k00], sun);
                cellVertexColor[1] = shade(nodeColor[k10], nodeNy[k10], sun);
                cellVertexColor[2] = shade(nodeColor[k11], nodeNy[k11], sun);
                cellVertexColor[3] = shade(nodeColor[k01], nodeNy[k01], sun);

                triGouraud(shot, eye, forward, right, up, scene.fov,
                        p0, p1, p2, cellVertexColor[0], cellVertexColor[1], cellVertexColor[2]);
                triGouraud(shot, eye, forward, right, up, scene.fov,
                        p0, p2, p3, cellVertexColor[0], cellVertexColor[2], cellVertexColor[3]);
                shot.terrainTris += 2;
            }
        }

        SurfaceMesher mesher = new SurfaceMesher(f.w * f.h + 16);
        SurfaceMesher.Output out = new SurfaceMesher.Output();
        mesher.build(f, Precision.BITS64, false, out);
        shot.waterQuads = out.quads;

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
            w0[0] = out.pos[p];
            w0[1] = out.pos[p + 1];
            w0[2] = out.pos[p + 2];
            w1[0] = out.pos[p + 3];
            w1[1] = out.pos[p + 4];
            w1[2] = out.pos[p + 5];
            w2[0] = out.pos[p + 6];
            w2[1] = out.pos[p + 7];
            w2[2] = out.pos[p + 8];
            w3[0] = out.pos[p + 9];
            w3[1] = out.pos[p + 10];
            w3[2] = out.pos[p + 11];

            n0[0] = out.nrm[p];
            n0[1] = out.nrm[p + 1];
            n0[2] = out.nrm[p + 2];
            n1[0] = out.nrm[p + 3];
            n1[1] = out.nrm[p + 4];
            n1[2] = out.nrm[p + 5];
            n2[0] = out.nrm[p + 6];
            n2[1] = out.nrm[p + 7];
            n2[2] = out.nrm[p + 8];
            n3[0] = out.nrm[p + 9];
            n3[1] = out.nrm[p + 10];
            n3[2] = out.nrm[p + 11];

            int c0 = out.color[ci];
            int c1 = out.color[ci + 1];
            int c2 = out.color[ci + 2];
            int c3 = out.color[ci + 3];
            double d0 = out.depth[ci];
            double d1 = out.depth[ci + 1];
            double d2 = out.depth[ci + 2];
            double d3 = out.depth[ci + 3];

            waterTri(shot, eye, forward, right, up, scene.fov, sun, w0, w1, w2, n0, n1, n2, c0, c1, c2, d0, d1, d2);
            waterTri(shot, eye, forward, right, up, scene.fov, sun, w0, w2, w3, n0, n2, n3, c0, c2, c3, d0, d2, d3);
        }
        return shot;
    }

    private static int terrainColor(double x, double y, double z, double ny, HeightField f) {
        double rocky = Math.max(0.0, 1.0 - (ny - 0.72) * 5.0);
        double wet = Math.max(0.0, Math.min(1.0, (y - 63.4) * 1.6));
        double n = fbm(x * 0.5, z * 0.5, 3, 41);

        double grassR = 0.27 + n * 0.13;
        double grassG = 0.40 + n * 0.17;
        double grassB = 0.20 + n * 0.08;

        double sandR = 0.68;
        double sandG = 0.62;
        double sandB = 0.44;

        double rockR = 0.36;
        double rockG = 0.35;
        double rockB = 0.34;

        double t = Math.max(0.0, Math.min(1.0, 1.0 - wet));
        double r = mix(grassR, sandR, t * 0.9);
        double g = mix(grassG, sandG, t * 0.9);
        double b = mix(grassB, sandB, t * 0.9);

        r = mix(r, rockR, rocky);
        g = mix(g, rockG, rocky);
        b = mix(b, rockB, rocky);

        return pack(clamp01(r), clamp01(g), clamp01(b));
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
                dx /= len;
                dy /= len;
                dz /= len;
                shot.rgb[x + y * W] = skyColor(dx, dy, dz, sun);
            }
        }
    }

    private static int skyColor(double dx, double dy, double dz, double[] sun) {
        double t = Math.max(0.0, Math.min(1.0, dy * 0.5 + 0.5));
        double r = mix(0.62, 0.20, smoothstep(0.45, 1.0, t));
        double g = mix(0.76, 0.42, smoothstep(0.45, 1.0, t));
        double b = mix(0.88, 0.78, smoothstep(0.45, 1.0, t));

        double cos = dx * sun[0] + dy * sun[1] + dz * sun[2];
        if (cos > 0) {
            double glow = Math.pow(cos, 90.0) * 0.9 + Math.pow(cos, 8.0) * 0.18;
            r += glow;
            g += glow * 0.95;
            b += glow * 0.82;
        }
        // облачные полосы
        double cloud = fbm(dx * 3.2 + 5, dz * 3.2 + 7, 4, 3);
        if (dy > 0.02) {
            double band = Math.max(0.0, (cloud - 0.55) * 2.4) * Math.min(1.0, dy * 4.0) * 0.55;
            r = mix(r, 0.96, band);
            g = mix(g, 0.97, band);
            b = mix(b, 0.99, band);
        }
        return pack(clamp01(r), clamp01(g), clamp01(b));
    }

    private static double[] project(double[] p, double[] eye, double[] forward, double[] right,
                                    double[] up, double fov) {
        double dx = p[0] - eye[0];
        double dy = p[1] - eye[1];
        double dz = p[2] - eye[2];
        double cz = dx * forward[0] + dy * forward[1] + dz * forward[2];
        if (cz < 0.05) {
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

    /** Цвет узла с учётом наклона: крутые склоны - скалы, низины - темнее. */
    private static int shade(int color, double ny, double[] sun) {
        double diff = Math.max(0.0, ny * sun[1] + 0.55);
        double shade = 0.42 + 0.72 * diff;
        shade *= 0.88 + 0.18 * ny;
        int r = clamp((int) (((color >> 16) & 0xFF) * shade));
        int g = clamp((int) (((color >> 8) & 0xFF) * shade));
        int b = clamp((int) ((color & 0xFF) * shade));
        return (r << 16) | (g << 8) | b;
    }

    /** Треугольник с интерполяцией цвета вершин. */
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
                shot.rgb[idx] = (clamp((int) (rr * 255)) << 16)
                        | (clamp((int) (gg * 255)) << 8)
                        | clamp((int) (bbb * 255));
                shot.zbuf[idx] = depth;
            }
        }
    }

    private static void tri(Shot shot, double[] eye, double[] forward, double[] right, double[] up,
                            double fov, double[] sun, double[] a3, double[] b3, double[] c3,
                            int color, double alpha, boolean unused, double ny) {
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
        int cr = (color >> 16) & 0xFF;
        int cg = (color >> 8) & 0xFF;
        int cb = color & 0xFF;

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
                // освещение по нормали (у нас плоскость - берём наклон из ny) + AO низин
                double shade = 0.55 + 0.62 * Math.max(0.0, ny * 0.55 + sun[1] * 0.45);
                shade *= 0.94 + 0.10 * ny;
                int tr = clamp((int) (cr * shade));
                int tg = clamp((int) (cg * shade));
                int tb = clamp((int) (cb * shade));
                shot.rgb[idx] = (tr << 16) | (tg << 8) | tb;
                shot.zbuf[idx] = depth;
            }
        }
    }

    private static void waterTri(Shot shot, double[] eye, double[] forward, double[] right,
                                 double[] up, double fov, double[] sun,
                                 double[] a3, double[] b3, double[] c3,
                                 double[] na, double[] nb, double[] nc,
                                 int ca, int cb, int cc,
                                 double da, double db, double dc) {
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

                double wr = (((w0 * ((ca >> 16) & 0xFF)) + w1 * ((cb >> 16) & 0xFF) + w2 * ((cc >> 16) & 0xFF))) / 255.0;
                double wg = (((w0 * ((ca >> 8) & 0xFF)) + w1 * ((cb >> 8) & 0xFF) + w2 * ((cc >> 8) & 0xFF))) / 255.0;
                double wb = (((w0 * (ca & 0xFF)) + w1 * (cb & 0xFF) + w2 * (cc & 0xFF))) / 255.0;
                double alpha = ((ca >>> 24) & 0xFF) / 255.0;

                // направление на камеру
                double vx = eye[0] - (a3[0] * w0 + b3[0] * w1 + c3[0] * w2);
                double vy = eye[1] - (a3[1] * w0 + b3[1] * w1 + c3[1] * w2);
                double vz = eye[2] - (a3[2] * w0 + b3[2] * w1 + c3[2] * w2);
                double vlen = Math.sqrt(vx * vx + vy * vy + vz * vz);
                if (vlen < 1e-6) {
                    vlen = 1;
                }
                vx /= vlen;
                vy /= vlen;
                vz /= vlen;

                double facing = Math.abs(nx * vx + ny * vy + nz * vz);
                // Шлик с F0 = 0.02 (вода), а не «всё отражает»: иначе поверхность выцветает.
                double fresnel = 0.02 + 0.98 * Math.pow(1.0 - facing, 5.0);

                double rx = 2 * (nx * vx + ny * vy + nz * vz) * nx - vx;
                double ry = 2 * (nx * vx + ny * vy + nz * vz) * ny - vy;
                double rz = 2 * (nx * vx + ny * vy + nz * vz) * nz - vz;
                int skyPacked = skyColor(rx, Math.abs(ry), rz, sun);
                double skyR = ((skyPacked >> 16) & 0xFF) / 255.0;
                double skyG = ((skyPacked >> 8) & 0xFF) / 255.0;
                double skyB = (skyPacked & 0xFF) / 255.0;

                double diff = Math.max(0.0, nx * sun[0] + ny * sun[1] + nz * sun[2]);
                double hx = sun[0] + vx;
                double hy = sun[1] + vy;
                double hz = sun[2] + vz;
                double hlen = Math.sqrt(hx * hx + hy * hy + hz * hz);
                if (hlen < 1e-6) {
                    hlen = 1;
                }
                double spec = Math.pow(Math.max(0.0, (nx * hx + ny * hy + nz * hz) / hlen), 220.0) * 1.6;
                spec += Math.pow(Math.max(0.0, (nx * hx + ny * hy + nz * hz) / hlen), 30.0) * 0.10;

                // Толщина воды под пикселем -> закон Бугера для фона и для цвета воды.
                double thickness = Math.max(0.0, da * w0 + db * w1 + dc * w2);
                double transmit = Math.exp(-thickness * 0.62);

                double foam = Math.max(0.0, Math.min(1.0, (Math.min(wr, Math.min(wg, wb)) - 0.72) * 5.0));
                foam *= Math.max(0.0, 1.0 - thickness * 0.55);
                double bodyR = 0.030 * (0.45 + 0.55 * diff);
                double bodyG = 0.235 * (0.45 + 0.55 * diff);
                double bodyB = 0.300 * (0.45 + 0.55 * diff);
                double baseR = bodyR * (1 - transmit) + wr * transmit * 0.30;
                double baseG = bodyG * (1 - transmit) + wg * transmit * 0.55;
                double baseB = bodyB * (1 - transmit) + wb * transmit * 0.60;

                double mixK = fresnel * 0.88 + 0.012;
                double outR = mix(baseR, skyR * 1.02, mixK) + spec;
                double outG = mix(baseG, skyG * 1.02, mixK) + spec * 1.02;
                double outB = mix(baseB, skyB * 1.02, mixK) + spec * 1.05;

                outR = mix(outR, 0.97, foam * 0.8);
                outG = mix(outG, 0.99, foam * 0.8);
                outB = mix(outB, 1.0, foam * 0.8);

                int dst = shot.rgb[idx];
                double bgR = ((dst >> 16) & 0xFF) / 255.0;
                double bgG = ((dst >> 8) & 0xFF) / 255.0;
                double bgB = (dst & 0xFF) / 255.0;

                // под водой цвет гуще: чем больше воды над дном, тем плотнее
                double depthAlpha = 1.0 - Math.exp(-thickness * 0.85);
                double mixAlpha = 0.30 + 0.66 * depthAlpha + fresnel * 0.30;
                mixAlpha = Math.min(0.97, Math.max(0.22, mixAlpha));
                int rr = clamp((int) ((outR * mixAlpha + bgR * (1 - mixAlpha)) * 255));
                int gg = clamp((int) ((outG * mixAlpha + bgG * (1 - mixAlpha)) * 255));
                int bb = clamp((int) ((outB * mixAlpha + bgB * (1 - mixAlpha)) * 255));
                shot.rgb[idx] = (rr << 16) | (gg << 8) | bb;
            }
        }
    }

    // ---------------------------------------------------------------- утилиты

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
        return v < 0 ? 0 : Math.min(v, 255);
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
        ByteArrayOutputStream compressed = new ByteArrayOutputStream();
        Deflater deflater = new Deflater(9);
        deflater.setInput(raw);
        deflater.finish();
        byte[] buf = new byte[1 << 16];
        while (!deflater.finished()) {
            int n = deflater.deflate(buf);
            compressed.write(buf, 0, n);
        }
        deflater.end();

        ByteArrayOutputStream png = new ByteArrayOutputStream();
        png.write(new byte[]{(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'});
        ByteArrayOutputStream ihdr = new ByteArrayOutputStream();
        writeInt(ihdr, width);
        writeInt(ihdr, height);
        ihdr.write(8);
        ihdr.write(2);
        ihdr.write(0);
        ihdr.write(0);
        ihdr.write(0);
        chunk(png, "IHDR", ihdr.toByteArray());
        chunk(png, "IDAT", compressed.toByteArray());
        chunk(png, "IEND", new byte[0]);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(png.toByteArray());
        }
    }

    private static void writeInt(ByteArrayOutputStream out, int value) {
        out.write((value >>> 24) & 0xFF);
        out.write((value >>> 16) & 0xFF);
        out.write((value >>> 8) & 0xFF);
        out.write(value & 0xFF);
    }

    private static void chunk(ByteArrayOutputStream out, String type, byte[] data) throws IOException {
        writeInt(out, data.length);
        byte[] typeBytes = type.getBytes(StandardCharsets.US_ASCII);
        out.write(typeBytes);
        out.write(data);
        CRC32 crc = new CRC32();
        crc.update(typeBytes);
        crc.update(data);
        writeInt(out, (int) crc.getValue());
    }

    private PreviewRenderer() {
    }
}
