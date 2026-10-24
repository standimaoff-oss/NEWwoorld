/*
 * Превью-рендерер Aquaflux.
 *
 * Чистый Java: ни Minecraft, ни OpenGL, ни внешних библиотек. Берёт ТОТ ЖЕ решатель и
 * ТОТ ЖЕ мешер (com.standimaoff.aquaflux.core), что и мод, и рисует их программным
 * растеризатором в PNG. Так можно увидеть форму воды без запуска игры.
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

    private static final int WIDTH = 960;
    private static final int HEIGHT = 540;

    // ---------------------------------------------------------------- сцена

    static final class Scene {
        final String name;
        final String caption;
        HeightField field;
        double eyeX;
        double eyeY;
        double eyeZ;
        double targetX;
        double targetY;
        double targetZ;
        double sunX = -0.45;
        double sunY = 0.78;
        double sunZ = 0.42;

        Scene(String name, String caption) {
            this.name = name;
            this.caption = caption;
        }
    }

    public static void main(String[] args) throws IOException {
        File outDir = new File(args.length > 0 ? args[0] : "docs/preview");
        if (!outDir.exists() && !outDir.mkdirs()) {
            throw new IOException("не могу создать " + outDir);
        }

        List<Scene> scenes = new ArrayList<>();
        scenes.add(lake());
        scenes.add(river());
        scenes.add(hole());
        scenes.add(explosion());
        scenes.add(shore());

        for (Scene scene : scenes) {
            long start = System.currentTimeMillis();
            Shot shot = render(scene);
            File file = new File(outDir, scene.name + ".png");
            writePng(file, shot.rgb, WIDTH, HEIGHT);
            System.out.printf("%-14s квадов воды: %5d, треугольников земли: %6d, %4d мс -> %s%n",
                    scene.name, shot.waterQuads, shot.terrainTris, System.currentTimeMillis() - start, file);
        }
        System.out.println("готово: " + scenes.size() + " сцен в " + outDir.getAbsolutePath());
    }

    // ---------------------------------------------------------------- сцены

    private static HeightField fromGrid(WaterGrid grid, int regionOriginX, int regionOriginZ) {
        int n = grid.width();
        HeightField f = new HeightField(n, n, grid.cellSize(),
                regionOriginX + grid.cellSize() * 0.5, regionOriginZ + grid.cellSize() * 0.5);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                f.set(i, j, grid.ground(i, j), grid.depth(i, j), grid.waveAt(i, j), grid.foamAt(i, j));
            }
        }
        return f;
    }

    private static HeightField flatField(int n, double step, double bed, double originX, double originZ) {
        HeightField f = new HeightField(n, n, step, originX, originZ);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                f.set(i, j, bed, 0, 0, 0);
            }
        }
        return f;
    }

    private static Scene lake() {
        int n = 96;
        double cell = 0.5;
        WaterGrid grid = new WaterGrid(n, n, cell, Precision.BITS32);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double d = Math.hypot(x - 24.0, z - 24.0);
                double bed = 64.0 + Math.max(0.0, d - 11.0) * 0.9;
                if (d < 9.5) {
                    bed = 64.0 - (1.0 - d / 9.5) * 3.2;
                }
                grid.setGround(i, j, bed);
            }
        }
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                if (Math.hypot(x - 24.0, z - 24.0) < 9.0) {
                    grid.addVolume(i, j, 0.5);
                }
            }
        }
        SolverSettings s = SolverSettings.balanced();
        for (int t = 0; t < 700; t++) {
            grid.step(0.05, s, BoundarySource.CLOSED);
        }
        for (int t = 0; t < 120; t++) {
            grid.decayWaves(0.99);
            grid.step(0.05, s, BoundarySource.CLOSED);
        }

        Scene scene = new Scene("01-lake", "Озеро: гладкая поверхность, округлый берег, пена на кромке");
        scene.field = fromGrid(grid, 0, 0);
        scene.eyeX = 24 - 15;
        scene.eyeY = 76;
        scene.eyeZ = 24 - 15;
        scene.targetX = 24;
        scene.targetY = 63.0;
        scene.targetZ = 24;
        return scene;
    }

    private static Scene river() {
        int n = 96;
        double cell = 0.5;
        WaterGrid grid = new WaterGrid(n, n, cell, Precision.BITS32);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double meander = 24.0 + Math.sin(z * 0.28) * 3.4;
                double dist = Math.abs(x - meander);
                double bed = 66.0 + (z * 0.045);
                if (dist < 3.2) {
                    bed = 66.0 + (z * 0.045) - (1.0 - dist / 3.2) * 1.5;
                }
                grid.setGround(i, j, bed);
            }
        }
        for (int z = 0; z < 6; z++) {
            for (int j = 0; j < 12; j++) {
                for (int i = 0; i < n; i++) {
                    int jj = (int) (j * (n / 12.0)) + z * 4;
                    if (jj >= n) {
                        continue;
                    }
                    grid.addVolume(i, jj, 0.35);
                }
            }
        }
        SolverSettings s = SolverSettings.balanced();
        for (int t = 0; t < 1400; t++) {
            grid.step(0.05, s, BoundarySource.CLOSED);
        }

        Scene scene = new Scene("02-river", "Река: уклон, течение и водовороты у берегов");
        scene.field = fromGrid(grid, 0, 0);
        scene.eyeX = 6;
        scene.eyeY = 74;
        scene.eyeZ = 5;
        scene.targetX = 24;
        scene.targetY = 66.0;
        scene.targetZ = 34;
        return scene;
    }

    private static Scene hole() {
        int n = 80;
        double cell = 0.5;
        WaterGrid grid = new WaterGrid(n, n, cell, Precision.BITS32);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double bed = 64.0;
                if (Math.abs(x - 20) < 5 && Math.abs(z - 20) < 5) {
                    bed = 60.0;
                }
                grid.setGround(i, j, bed);
            }
        }
        // ведро воды рядом с ямой
        for (int k = 0; k < 6; k++) {
            grid.addVolumeAt(26.0, 20.0, 250.0);
        }
        SolverSettings s = SolverSettings.balanced();
        for (int t = 0; t < 900; t++) {
            grid.step(0.05, s, BoundarySource.CLOSED);
        }

        Scene scene = new Scene("03-hole", "Выкопали яму и вылили ведро: вода стекла вниз и заполнила её");
        scene.field = fromGrid(grid, 0, 0);
        scene.eyeX = 4;
        scene.eyeY = 72;
        scene.eyeZ = 6;
        scene.targetX = 20;
        scene.targetY = 62.5;
        scene.targetZ = 20;
        return scene;
    }

    private static Scene explosion() {
        int n = 96;
        double cell = 0.5;
        WaterGrid grid = new WaterGrid(n, n, cell, Precision.BITS32);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = (i + 0.5) * cell;
                double z = (j + 0.5) * cell;
                double d = Math.hypot(x - 24.0, z - 24.0);
                grid.setGround(i, j, 64.0 - Math.max(0.0, 2.6 - d * 0.28));
            }
        }
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                grid.addVolume(i, j, 0.42);
            }
        }
        SolverSettings s = SolverSettings.balanced();
        for (int t = 0; t < 300; t++) {
            grid.step(0.05, s, BoundarySource.CLOSED);
        }
        grid.explosion(24.0, 24.0, 1.6);
        for (int t = 0; t < 10; t++) {
            grid.step(0.05, s, BoundarySource.CLOSED);
        }

        Scene scene = new Scene("04-explosion", "Взрыв в воде: расходящееся кольцо волн и пена");
        scene.field = fromGrid(grid, 0, 0);
        scene.eyeX = 24;
        scene.eyeY = 79;
        scene.eyeZ = 6;
        scene.targetX = 24;
        scene.targetY = 62.0;
        scene.targetZ = 26;
        return scene;
    }

    private static Scene shore() {
        int n = 64;
        double cell = 0.25;
        HeightField f = flatField(n, cell, 64.0, 0, 0);
        for (int j = 0; j < n; j++) {
            for (int i = 0; i < n; i++) {
                double x = f.worldX(i);
                double z = f.worldZ(j);
                double bank = 64.0 + Math.max(0.0, (x - 9.0)) * 0.55;
                double wobble = Math.sin(x * 1.7) * 0.12 + Math.cos(z * 1.3) * 0.1;
                double bed = bank + wobble;
                double depth = Math.max(0.0, (1.0 - (bed - 64.0) / 0.9)) * 1.5;
                if (x > 12.0) {
                    depth = 0;
                }
                f.set(i, j, bed, depth, 0.01 * Math.sin(x * 2.0 + z), 0);
            }
        }
        Scene scene = new Scene("05-shore", "Кромка воды крупно: плёнка на берегу, сглаженные нормали");
        scene.field = f;
        scene.eyeX = 4.5;
        scene.eyeY = 66.2;
        scene.eyeZ = 4.0;
        scene.targetX = 9.5;
        scene.targetY = 64.2;
        scene.targetZ = 8.0;
        return scene;
    }

    // ---------------------------------------------------------------- рендер

    static final class Shot {
        int[] rgb = new int[WIDTH * HEIGHT];
        int waterQuads;
        int terrainTris;
    }

    private static Shot render(Scene scene) {
        Shot shot = new Shot();
        double[] zbuf = new double[WIDTH * HEIGHT];
        java.util.Arrays.fill(zbuf, Double.POSITIVE_INFINITY);

        // небо
        for (int y = 0; y < HEIGHT; y++) {
            double t = (double) y / HEIGHT;
            int r = (int) (150 + 70 * (1 - t));
            int g = (int) (185 + 55 * (1 - t));
            int b = (int) (215 + 35 * (1 - t));
            int c = (r << 16) | (g << 8) | b;
            for (int x = 0; x < WIDTH; x++) {
                shot.rgb[x + y * WIDTH] = c;
            }
        }

        HeightField f = scene.field;
        double[] eye = {scene.eyeX, scene.eyeY, scene.eyeZ};
        double[] target = {scene.targetX, scene.targetY, scene.targetZ};
        double[] forward = normalize(sub(target, eye));
        double[] up0 = {0, 1, 0};
        double[] right = normalize(cross(forward, up0));
        double[] up = cross(right, forward);
        double fov = Math.toRadians(58);

        // земля: две сетки на ячейку
        int quads = 0;
        for (int j = 0; j < f.h - 1; j++) {
            for (int i = 0; i < f.w - 1; i++) {
                double x0 = f.worldX(i);
                double x1 = f.worldX(i + 1);
                double z0 = f.worldZ(j);
                double z1 = f.worldZ(j + 1);
                double h00 = f.bed[f.index(i, j)];
                double h10 = f.bed[f.index(i + 1, j)];
                double h01 = f.bed[f.index(i, j + 1)];
                double h11 = f.bed[f.index(i + 1, j + 1)];
                double nx = (h00 + h01 - h10 - h11) * 0.5;
                double nz = (h00 + h10 - h01 - h11) * 0.5;
                double ny = 2.0 * f.step;
                double len = Math.sqrt(nx * nx + ny * ny + nz * nz);
                nx /= len;
                ny /= len;
                nz /= len;

                double shade = 0.30 + 0.7 * Math.max(0, nx * scene.sunX + ny * scene.sunY + nz * scene.sunZ);
                double height = (h00 + h10 + h01 + h11) * 0.25;
                double sand = Math.min(1.0, Math.max(0.0, (height - 63.2) * 0.9));
                int r = (int) (110 + 55 * sand);
                int g = (int) (150 + 30 * sand);
                int b = (int) (105 + 20 * sand);
                r = clamp((int) (r * shade));
                g = clamp((int) (g * shade));
                b = clamp((int) (b * shade));
                int color = (r << 16) | (g << 8) | b;

                tri(x0, h00, z0, x0, h01, z1, x1, h11, z1, color, zbuf, shot, eye, forward, right, up, fov);
                tri(x0, h00, z0, x1, h11, z1, x1, h10, z0, color, zbuf, shot, eye, forward, right, up, fov);
                quads += 2;
            }
        }
        shot.terrainTris = quads;

        // вода
        SurfaceMesher mesher = new SurfaceMesher(f.w * f.h);
        SurfaceMesher.Output out = new SurfaceMesher.Output();
        mesher.build(f, Precision.BITS64, false, out);
        shot.waterQuads = out.quads;

        double[] wave = normalize(new double[]{0.35, 0.25, 0.9});
        for (int q = 0; q < out.quads; q++) {
            int p = q * 12;
            int ci = q * 4;
            float[] px = new float[4];
            float[] py = new float[4];
            float[] pz = new float[4];
            for (int v = 0; v < 4; v++) {
                px[v] = out.pos[p + v * 3];
                py[v] = out.pos[p + v * 3 + 1];
                pz[v] = out.pos[p + v * 3 + 2];
            }
            int argb = out.color[ci];
            int baseR = (argb >> 16) & 0xFF;
            int baseG = (argb >> 8) & 0xFF;
            int baseB = argb & 0xFF;
            double alpha = ((argb >>> 24) & 0xFF) / 255.0;

            double nx = out.nrm[p + 3];
            double ny = out.nrm[p + 4];
            double nz = out.nrm[p + 5];
            double diff = Math.max(0, nx * scene.sunX + ny * scene.sunY + nz * scene.sunZ);
            double spec = Math.pow(Math.max(0, nx * wave[0] + ny * wave[1] + nz * wave[2]), 24.0);

            int r = clamp((int) (baseR * (0.78 + 0.5 * diff) + 90 * spec));
            int g = clamp((int) (baseG * (0.78 + 0.5 * diff) + 110 * spec));
            int b = clamp((int) (baseB * (0.82 + 0.5 * diff) + 130 * spec));

            waterTri(px[0], py[0], pz[0], px[1], py[1], pz[1], px[2], py[2], pz[2],
                    r, g, b, alpha, zbuf, shot, eye, forward, right, up, fov);
            waterTri(px[0], py[0], pz[0], px[2], py[2], pz[2], px[3], py[3], pz[3],
                    r, g, b, alpha, zbuf, shot, eye, forward, right, up, fov);
        }
        return shot;
    }

    private static void tri(double x0, double y0, double z0,
                            double x1, double y1, double z1,
                            double x2, double y2, double z2,
                            int color, double[] zbuf, Shot shot,
                            double[] eye, double[] forward, double[] right, double[] up, double fov) {
        double[] a = project(x0, y0, z0, eye, forward, right, up, fov);
        double[] b = project(x1, y1, z1, eye, forward, right, up, fov);
        double[] c = project(x2, y2, z2, eye, forward, right, up, fov);
        if (a == null || b == null || c == null) {
            return;
        }
        raster(a, b, c, color, 1.0, zbuf, shot, false);
    }

    private static void waterTri(double x0, double y0, double z0,
                                 double x1, double y1, double z1,
                                 double x2, double y2, double z2,
                                 int red, int green, int blue, double alpha, double[] zbuf, Shot shot,
                                 double[] eye, double[] forward, double[] right, double[] up, double fov) {
        double[] a = project(x0, y0, z0, eye, forward, right, up, fov);
        double[] b = project(x1, y1, z1, eye, forward, right, up, fov);
        double[] c = project(x2, y2, z2, eye, forward, right, up, fov);
        if (a == null || b == null || c == null) {
            return;
        }
        raster(a, b, c, (red << 16) | (green << 8) | blue, alpha, zbuf, shot, true);
    }

    private static double[] project(double x, double y, double z,
                                    double[] eye, double[] forward, double[] right, double[] up, double fov) {
        double dx = x - eye[0];
        double dy = y - eye[1];
        double dz = z - eye[2];
        double cz = dx * forward[0] + dy * forward[1] + dz * forward[2];
        if (cz < 0.08) {
            return null;
        }
        double cx = dx * right[0] + dy * right[1] + dz * right[2];
        double cy = dx * up[0] + dy * up[1] + dz * up[2];
        double f = 1.0 / Math.tan(fov * 0.5);
        double aspect = (double) WIDTH / HEIGHT;
        double sx = (cx * f / aspect) / cz;
        double sy = (cy * f) / cz;
        double[] p = new double[4];
        p[0] = (sx * 0.5 + 0.5) * WIDTH;
        p[1] = (0.5 - sy * 0.5) * HEIGHT;
        p[2] = cz;
        p[3] = 1.0;
        return p;
    }

    private static void raster(double[] a, double[] b, double[] c, int color, double alpha,
                               double[] zbuf, Shot shot, boolean water) {
        double minX = Math.min(a[0], Math.min(b[0], c[0]));
        double maxX = Math.max(a[0], Math.max(b[0], c[0]));
        double minY = Math.min(a[1], Math.min(b[1], c[1]));
        double maxY = Math.max(a[1], Math.max(b[1], c[1]));
        int x0 = Math.max(0, (int) Math.floor(minX));
        int x1 = Math.min(WIDTH - 1, (int) Math.ceil(maxX));
        int y0 = Math.max(0, (int) Math.floor(minY));
        int y1 = Math.min(HEIGHT - 1, (int) Math.ceil(maxY));
        if (x1 < x0 || y1 < y0) {
            return;
        }
        double area = edge(a[0], a[1], b[0], b[1], c[0], c[1]);
        if (Math.abs(area) < 1e-9) {
            return;
        }
        double invArea = 1.0 / area;
        int r = (color >> 16) & 0xFF;
        int g = (color >> 8) & 0xFF;
        int bl = color & 0xFF;

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
                int idx = x + y * WIDTH;
                if (depth >= zbuf[idx] + 1e-4) {
                    continue;
                }
                if (water) {
                    int dst = shot.rgb[idx];
                    int dr = (dst >> 16) & 0xFF;
                    int dg = (dst >> 8) & 0xFF;
                    int db = dst & 0xFF;
                    int nr = clamp((int) (r * alpha + dr * (1 - alpha)));
                    int ng = clamp((int) (g * alpha + dg * (1 - alpha)));
                    int nb = clamp((int) (bl * alpha + db * (1 - alpha)));
                    shot.rgb[idx] = (nr << 16) | (ng << 8) | nb;
                } else {
                    shot.rgb[idx] = color;
                    zbuf[idx] = depth;
                }
            }
        }
    }

    private static double edge(double ax, double ay, double bx, double by, double px, double py) {
        return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    }

    private static int clamp(int v) {
        return v < 0 ? 0 : Math.min(v, 255);
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
        byte[] buf = new byte[65536];
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
