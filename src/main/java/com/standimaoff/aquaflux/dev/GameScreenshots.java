package com.standimaoff.aquaflux.dev;

import com.mojang.blaze3d.pipeline.RenderTarget;
import com.standimaoff.aquaflux.Aquaflux;
import com.standimaoff.aquaflux.AquafluxConfig;
import com.standimaoff.aquaflux.client.ClientWaterCache;
import com.standimaoff.aquaflux.client.WaterSurfaceRenderer;
import com.standimaoff.aquaflux.registry.ModBlocks;
import com.standimaoff.aquaflux.world.WaterEngine;
import com.standimaoff.aquaflux.world.WaterRegion;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.phys.Vec3;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.RenderGuiEvent;
import net.minecraftforge.client.event.RenderLevelStageEvent;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Скриншоты прямо из игры: мод сам строит сцены в мире, ставит камеру и снимает кадр.
 *
 * <p>Класс нужен только для проверки и включается системным свойством
 * {@code -Daquaflux.screenshots=<папка>}. Без него он не делает ничего — ни одного лишнего
 * действия в обычной игре.</p>
 *
 * <p>Как это работает: сцены строятся командами сервера (реальные блоки в мире), вода
 * наливается через тот же {@link WaterEngine}, что и у ведра, дальше мир живёт своими
 * тиками — решатель, синхронизация на клиент, мешер. Кадр снимается из настоящего
 * кадрового буфера игры ({@code glReadPixels}) в конце кадра, поэтому на картинке ровно то,
 * что видит игрок: небо, туман, свет, вода мода и HUD.</p>
 */
@Mod.EventBusSubscriber(modid = Aquaflux.MODID, value = Dist.CLIENT, bus = Mod.EventBusSubscriber.Bus.FORGE)
public final class GameScreenshots {

    /** Отладка чёрных пятен: три кадра одной сцены с разными режимами. */
    private static final boolean DEBUG_BLACK = System.getProperty("aquaflux.debugblack") != null;

    private static final File DIR = directory();
    private static final boolean ON = DIR != null;

    /** Сколько тиков сцена живёт до кадра: вода успевает растечься и успокоиться. */
    private static final AtomicInteger SERVER_TASKS = new AtomicInteger();
    private static final List<Step> STEPS = new ArrayList<>();

    private static boolean started;
    private static boolean WATCHDOG_STARTED;
    private static boolean finished;
    private static int index;
    private static int wait;
    private static int screenTicks;
    private static String pendingShot;
    private static boolean pendingShotWithGui;

    private GameScreenshots() {
    }

    private static File directory() {
        String dir = System.getProperty("aquaflux.screenshots");
        if (dir == null || dir.isBlank()) {
            return null;
        }
        File f = new File(dir);
        //noinspection ResultOfMethodCallIgnored
        f.mkdirs();
        return f;
    }

    // ------------------------------------------------------------------ шаги сценария

    /** Один шаг сценария: подождать, сделать, снять кадр. */
    private static final class Step {
        final int waitTicks;
        final Runnable action;
        final String shot;
        final boolean withGui;

        private Step(int waitTicks, Runnable action, String shot, boolean withGui) {
            this.waitTicks = waitTicks;
            this.action = action;
            this.shot = shot;
            this.withGui = withGui;
        }

        static Step wait(int ticks) {
            return new Step(ticks, null, null, false);
        }

        static Step run(Runnable action) {
            return new Step(0, action, null, false);
        }

        static Step shot(String name) {
            return new Step(0, null, name, false);
        }

        static Step shotWithHud(String name) {
            return new Step(0, null, name, true);
        }
    }

    // ------------------------------------------------------------------ события

    @SubscribeEvent
    public static void onClientTick(TickEvent.ClientTickEvent event) {
        if (!ON || event.phase != TickEvent.Phase.END || finished) {
            return;
        }
        Minecraft mc = Minecraft.getInstance();
        startWatchdog();
        // В headless-е окно без фокуса: иначе игра встаёт на паузу и кадры не снять.
        mc.options.pauseOnLostFocus = false;
        if (mc.screen instanceof PauseScreen) {
            Aquaflux.LOGGER.info("[screens] снимаю паузу (окно без фокуса)");
            mc.setScreen(null);
            return;
        }
        if (mc.screen != null) {
            // Любое окно (предупреждение о мире, пауза) не даёт жить сцене: закрываем.
            screenTicks++;
            if (screenTicks > 60) {
                Aquaflux.LOGGER.info("[screens] закрываю окно {} (висит {} тиков)",
                        mc.screen.getClass().getSimpleName(), screenTicks);
                mc.setScreen(null);
                screenTicks = 0;
            }
            return;
        }
        screenTicks = 0;
        if (mc.level == null || mc.player == null) {
            return;
        }
        if (!started) {
            startWatchdog();
            start(mc);
            return;
        }
        if (SERVER_TASKS.get() > 0) {
            return;
        }
        if (wait > 0) {
            wait--;
            return;
        }
        if (index >= STEPS.size()) {
            stop(mc);
            return;
        }
        Step step = STEPS.get(index++);
        if (step.action != null) {
            step.action.run();
        }
        if (step.shot != null) {
            pendingShot = step.shot;
            pendingShotWithGui = step.withGui;
        }
        wait = step.waitTicks;
    }

    /** Кадр без интерфейса — сразу после того, как мир полностью нарисован. */
    @SubscribeEvent
    public static void onRenderLevel(RenderLevelStageEvent event) {
        if (!ON || pendingShot == null || pendingShotWithGui) {
            return;
        }
        if (event.getStage() != RenderLevelStageEvent.Stage.AFTER_LEVEL) {
            return;
        }
        grab(pendingShot);
        pendingShot = null;
    }

    /** Кадр с интерфейсом — после отрисовки HUD. */
    @SubscribeEvent
    public static void onRenderGui(RenderGuiEvent.Post event) {
        if (!ON || pendingShot == null || !pendingShotWithGui) {
            return;
        }
        grab(pendingShot);
        pendingShot = null;
        pendingShotWithGui = false;
    }

    // ------------------------------------------------------------------ запуск

    private static void startWatchdog() {
        if (WATCHDOG_STARTED) {
            return;
        }
        WATCHDOG_STARTED = true;
        Thread watchdog = new Thread(() -> {
            try {
                Thread.sleep(25L * 60L * 1000L);
            } catch (InterruptedException ignored) {
                return;
            }
            Aquaflux.LOGGER.error("[screens] сторож: игра не успела снять кадры за 25 минут");
            Runtime.getRuntime().halt(3);
        }, "aquaflux-screens-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
    }

    private static void start(Minecraft mc) {
        started = true;
        mc.options.hideGui = true;
        mc.options.pauseOnLostFocus = false;
        Aquaflux.LOGGER.info("[screens] старт, папка {}", DIR.getAbsolutePath());

        MinecraftServer server = server();
        if (server == null) {
            started = false;
            return;
        }
        ServerLevel level = server.overworld();
        level.setDayTime(4000L);
        level.setWeatherParameters(6000, 0, false, false);
        server.setDifficulty(Difficulty.PEACEFUL, true);

        int ground = level.getHeight(Heightmap.Types.WORLD_SURFACE, 0, 0);
        Aquaflux.LOGGER.info("[screens] уровень земли y={}", ground);
        buildScript(level, ground);
    }

    private static void stop(Minecraft mc) {
        finished = true;
        mc.options.hideGui = false;
        Aquaflux.LOGGER.info("[screens] готово, кадров: {}", index);
        // Выходим из игры, чтобы CI-джоба завершилась сама.
        new Thread(() -> {
            try {
                Thread.sleep(1500L);
            } catch (InterruptedException ignored) {
                // всё равно выходим
            }
            Aquaflux.LOGGER.info("[screens] выхожу из игры");
            Runtime.getRuntime().halt(0);
        }, "aquaflux-screens-exit").start();
    }

    private static MinecraftServer server() {
        return Minecraft.getInstance().getSingleplayerServer();
    }

    // ------------------------------------------------------------------ сценарий

    private static void buildScript(ServerLevel level, int ground) {
        STEPS.clear();

        pitScene(level, ground);
        pitVariantsScene(level, ground);
        lakeScene(level, ground);
        waterfallScene(level, ground);
        explosionScene(level, ground);
        wakeScene(level, ground);
        hudScene(ground);
        sprayScene(level, ground);
        rainScene(level, ground);
        litPitScene(level, ground);

        Aquaflux.LOGGER.info("[screens] шагов в сценарии: {}", STEPS.size());
    }

    /** Сцена 1: выкопали яму, налили воду. */
    private static void pitScene(ServerLevel level, int ground) {
        int cx = 0;
        int cz = 0;
        int half = 7;
        STEPS.add(Step.run(() -> onServer(() -> {
            carve(level, cx - half, cz - half, cx + half, cz + half, ground, 4);
            resample(level, cx, cz, 24);
            pour(level, cx - half, cz - half, cx + half, cz + half, ground - 0.35);
        })));
        STEPS.add(Step.wait(10));
        STEPS.add(Step.run(() -> teleport(level, cx + 9.5, ground + 7.5, cz + 9.5,
                cx, ground - 1.0, cz)));
        STEPS.add(Step.wait(140));
        STEPS.add(Step.shot("ingame-01-pit"));
        if (DEBUG_BLACK) {
            STEPS.add(Step.run(() -> com.standimaoff.aquaflux.client.SurfaceMesh.DEBUG_MODE = 4));
            STEPS.add(Step.wait(4));
            STEPS.add(Step.shot("dbg-d-raised"));
            STEPS.add(Step.run(() -> com.standimaoff.aquaflux.client.SurfaceMesh.DEBUG_MODE = 3));
            STEPS.add(Step.wait(4));
            STEPS.add(Step.shot("dbg-c-flatcolor"));
            STEPS.add(Step.run(() -> com.standimaoff.aquaflux.client.SurfaceMesh.DEBUG_MODE = 1));
            STEPS.add(Step.wait(4));
            STEPS.add(Step.shot("dbg-a-nomesh"));
            STEPS.add(Step.run(() -> com.standimaoff.aquaflux.client.SurfaceMesh.DEBUG_MODE = 0));
            STEPS.add(Step.wait(4));
        }
    }

    /** Отладка: та же яма в нескольких режимах отрисовки - ищем причину чёрных пятен. */
    private static void pitVariantsScene(ServerLevel level, int ground) {
        int cx = 0;
        int cz = 0;
        int half = 7;
        STEPS.add(Step.run(() -> onServer(() -> {
            carve(level, cx - half, cz - half, cx + half, cz + half, ground, 4);
            resample(level, cx, cz, 24);
            pour(level, cx - half, cz - half, cx + half, cz + half, ground - 0.35);
        })));
        STEPS.add(Step.wait(10));
        STEPS.add(Step.run(() -> teleport(level, cx + 9.5, ground + 7.5, cz + 9.5,
                cx, ground - 1.0, cz)));
        STEPS.add(Step.wait(120));
        int[][] modes = {{3, 3}, {7, 7}};
        for (int[] m : modes) {
            final int mode = m[1];
            STEPS.add(Step.run(() -> com.standimaoff.aquaflux.client.SurfaceMesh.DEBUG_MODE = mode));
            STEPS.add(Step.wait(2));
            STEPS.add(Step.shot("dbg-mode-" + mode));
        }
        STEPS.add(Step.run(() -> com.standimaoff.aquaflux.client.SurfaceMesh.DEBUG_MODE = 0));
    }

    /** Сцена 2: озеро в низине, взгляд почти по воде. */
    private static void lakeScene(ServerLevel level, int ground) {
        int cx = 256;
        int cz = 0;
        int half = 14;
        STEPS.add(Step.run(() -> onServer(() -> {
            carve(level, cx - half, cz - half, cx + half, cz + half, ground, 3);
            resample(level, cx, cz, 40);
            pour(level, cx - half, cz - half, cx + half, cz + half, ground - 0.25);
        })));
        STEPS.add(Step.wait(10));
        STEPS.add(Step.run(() -> teleport(level, cx + 20.5, ground + 2.2, cz + 20.5,
                cx, ground - 0.6, cz)));
        STEPS.add(Step.wait(160));
        STEPS.add(Step.shot("ingame-02-lake"));
    }

    /** Сцена 3: водопад — вода уходит с каменного уступа в чашу под ним. */
    private static void waterfallScene(ServerLevel level, int ground) {
        int cx = 512;
        int cz = 0;
        int top = ground + 5;
        STEPS.add(Step.run(() -> onServer(() -> {
            // Уступ: площадка 10x10 высотой 5 блоков и чаша перед ней.
            fill(level, cx - 5, ground + 1, cz - 5, cx + 5, top, cz + 5, Blocks.STONE);
            carve(level, cx - 6, cz + 6, cx + 6, cz + 14, ground, 3);
            resample(level, cx, cz + 6, 32);
            pour(level, cx - 4, cz - 4, cx + 4, cz + 4, top + 1.15);
            pour(level, cx - 5, cz + 6, cx + 5, cz + 13, ground - 0.30);
        })));
        STEPS.add(Step.wait(10));
        STEPS.add(Step.run(() -> teleport(level, cx + 15.5, top + 4.5, cz + 14.5,
                cx, ground + 1.0, cz + 3)));
        STEPS.add(Step.wait(170));
        STEPS.add(Step.shot("ingame-03-waterfall"));
    }

    /** Сцена 4: взрыв в пруду. */
    private static void explosionScene(ServerLevel level, int ground) {
        int cx = 768;
        int cz = 0;
        int half = 11;
        STEPS.add(Step.run(() -> onServer(() -> {
            carve(level, cx - half, cz - half, cx + half, cz + half, ground, 3);
            resample(level, cx, cz, 40);
            pour(level, cx - half, cz - half, cx + half, cz + half, ground - 0.30);
        })));
        STEPS.add(Step.wait(10));
        STEPS.add(Step.run(() -> teleport(level, cx + 13.5, ground + 8.5, cz + 13.5,
                cx, ground - 1.5, cz)));
        STEPS.add(Step.wait(150));
        STEPS.add(Step.run(() -> onServer(() ->
                WaterEngine.of(level).explosion(new Vec3(cx, ground - 0.3, cz), 4.0))));
        STEPS.add(Step.wait(9));
        STEPS.add(Step.shot("ingame-04-explosion"));
    }

    /** Сцена 5: след пловца — настоящие удары по воде, пена и кольца. */
    private static void wakeScene(ServerLevel level, int ground) {
        int cx = 1024;
        int cz = 0;
        STEPS.add(Step.run(() -> onServer(() -> {
            carve(level, cx - 16, cz - 9, cx + 16, cz + 9, ground, 3);
            resample(level, cx, cz, 48);
            pour(level, cx - 16, cz - 9, cx + 16, cz + 9, ground - 0.25);
        })));
        STEPS.add(Step.wait(10));
        STEPS.add(Step.run(() -> teleport(level, cx + 18.5, ground + 4.6, cz + 15.0,
                cx - 2, ground - 0.4, cz - 8)));
        STEPS.add(Step.wait(140));
        STEPS.add(Step.run(() -> onServer(() -> {
            WaterEngine engine = WaterEngine.of(level);
            for (int i = 0; i < 14; i++) {
                double t = i / 13.0;
                double x = cx - 12 + t * 24.0;
                double z = cz - 4 + Math.sin(t * 6.0) * 3.0;
                engine.impact(x, ground - 0.25, z, 0.55, 2.0, 0.30);
            }
        })));
        STEPS.add(Step.wait(12));
        STEPS.add(Step.shot("ingame-05-wake"));
    }

    /** Сцена 6: общий вид с интерфейсом — доказательство, что это игра, а не рендер. */
    private static void hudScene(int ground) {
        int cx = 256;
        int cz = 0;
        STEPS.add(Step.run(() -> onServer(() -> {
            MinecraftServer server = server();
            if (server == null || server.getPlayerList().getPlayers().isEmpty()) {
                return;
            }
            ServerPlayer sp = server.getPlayerList().getPlayers().get(0);
            sp.teleportTo((ServerLevel) sp.level(), cx + 12.5, ground + 3.2, cz + 12.5, 225.0f, 28.0f);
        })));
        STEPS.add(Step.wait(30));
        STEPS.add(Step.run(() -> Minecraft.getInstance().options.hideGui = false));
        STEPS.add(Step.wait(10));
        STEPS.add(Step.shotWithHud("ingame-06-hud"));
        STEPS.add(Step.run(() -> Minecraft.getInstance().options.hideGui = true));
    }

    /**
     * Сцена 9: яма со светящимся дном.
     *
     * <p>Проверка «а не чёрное ли дно»: если под водой светло, вода обязана быть
     * бирюзовой, и любое чёрное пятно - это дырка в меше, а не тёмное дно.</p>
     */
    private static void litPitScene(ServerLevel level, int ground) {
        int cx = 1792;
        int cz = 0;
        int half = 7;
        STEPS.add(Step.run(() -> onServer(() -> {
            carve(level, cx - half, cz - half, cx + half, cz + half, ground, 4);
            fill(level, cx - half, ground - 4, cz - half, cx + half, ground - 4, cz + half,
                    Blocks.SEA_LANTERN);
            resample(level, cx, cz, 24);
            pour(level, cx - half, cz - half, cx + half, cz + half, ground - 0.35);
        })));
        STEPS.add(Step.wait(10));
        STEPS.add(Step.run(() -> teleport(level, cx + 9.5, ground + 7.5, cz + 9.5,
                cx, ground - 1.0, cz)));
        STEPS.add(Step.wait(120));
        STEPS.add(Step.shot("ingame-09-litpit"));
    }

    /** Сцена 7: крупный план - капли летят, по воде расходится кольцо пены. */
    private static void sprayScene(ServerLevel level, int ground) {
        int cx = 1280;
        int cz = 0;
        int half = 5;
        STEPS.add(Step.run(() -> onServer(() -> {
            carve(level, cx - half, cz - half, cx + half, cz + half, ground, 4);
            resample(level, cx, cz, 24);
            pour(level, cx - half, cz - half, cx + half, cz + half, ground - 0.30);
        })));
        STEPS.add(Step.wait(120));
        // Взгляд почти по воде: так видно и отражение неба, и толщу.
        STEPS.add(Step.run(() -> teleport(level, cx + 4.8, ground + 1.05, cz + 4.8,
                cx - 0.8, ground - 0.30, cz - 0.8)));
        STEPS.add(Step.wait(24));
        STEPS.add(Step.run(() -> onServer(() -> {
            WaterEngine engine = WaterEngine.of(level);
            engine.impact(cx - 0.8, ground - 0.30, cz - 0.8, 0.9, 4.2, 0.85);
            engine.impact(cx + 0.9, ground - 0.30, cz - 0.6, 0.7, 3.6, 0.70);
            engine.impact(cx - 0.4, ground - 0.30, cz + 1.1, 0.7, 3.9, 0.75);
        })));
        // Два тика - капли ещё в воздухе, пена уже легла на воду.
        STEPS.add(Step.wait(2));
        STEPS.add(Step.shot("ingame-07-spray"));
    }

    /** Сцена 8: дождь по воде - много маленьких тел сразу. */
    private static void rainScene(ServerLevel level, int ground) {
        int cx = 1536;
        int cz = 0;
        int half = 8;
        STEPS.add(Step.run(() -> onServer(() -> {
            carve(level, cx - half, cz - half, cx + half, cz + half, ground, 3);
            resample(level, cx, cz, 32);
            pour(level, cx - half, cz - half, cx + half, cz + half, ground - 0.30);
        })));
        STEPS.add(Step.wait(110));
        STEPS.add(Step.run(() -> teleport(level, cx + 11.5, ground + 8.5, cz + 11.5,
                cx, ground - 0.30, cz)));
        STEPS.add(Step.wait(30));
        for (int wave = 0; wave < 3; wave++) {
            final int seed = wave;
            STEPS.add(Step.run(() -> onServer(() -> {
                WaterEngine engine = WaterEngine.of(level);
                for (int i = 0; i < 14; i++) {
                    double a = (i * 2.399 + seed * 0.7) % (Math.PI * 2.0);
                    double r = 1.0 + ((i * 37 + seed * 13) % 60) / 10.0;
                    engine.impact(cx + Math.cos(a) * r, ground - 0.30, cz + Math.sin(a) * r,
                            0.45, 3.0, 0.55);
                }
            })));
            STEPS.add(Step.wait(3));
        }
        STEPS.add(Step.shot("ingame-08-rain"));
    }

    // ------------------------------------------------------------------ мир: блоки и вода

    private static void onServer(Runnable task) {
        MinecraftServer server = server();
        if (server == null) {
            return;
        }
        SERVER_TASKS.incrementAndGet();
        server.execute(() -> {
            try {
                task.run();
            } catch (Throwable t) {
                Aquaflux.LOGGER.error("[screens] шаг сцены упал", t);
            } finally {
                SERVER_TASKS.decrementAndGet();
            }
        });
    }

    private static void fill(ServerLevel level, int x0, int y0, int z0, int x1, int y1, int z1,
                             net.minecraft.world.level.block.Block block) {
        BlockState state = block.defaultBlockState();
        BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
        for (int y = y0; y <= y1; y++) {
            for (int z = z0; z <= z1; z++) {
                for (int x = x0; x <= x1; x++) {
                    level.setBlock(pos.set(x, y, z), state, 2);
                }
            }
        }
    }

    private static void carve(ServerLevel level, int x0, int z0, int x1, int z1, int ground, int depth) {
        BlockState air = Blocks.AIR.defaultBlockState();
        BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
        for (int y = ground; y > ground - depth; y--) {
            for (int z = z0; z <= z1; z++) {
                for (int x = x0; x <= x1; x++) {
                    level.setBlock(pos.set(x, y, z), air, 2);
                }
            }
        }
    }

    /** Пересэмплировать пол регионов после стройки: иначе вода считает старое дно. */
    private static void resample(ServerLevel level, int cx, int cz, int pad) {
        WaterEngine engine = WaterEngine.of(level);
        int size = 32;
        for (int rx = Math.floorDiv(cx - pad, size); rx <= Math.floorDiv(cx + pad, size); rx++) {
            for (int rz = Math.floorDiv(cz - pad, size); rz <= Math.floorDiv(cz + pad, size); rz++) {
                WaterRegion region = engine.regionAt(rx * size + size / 2, rz * size + size / 2);
                region.refreshAround(level, rx * size + size / 2, rz * size + size / 2, size);
            }
        }
    }

    /** Налить воду до уровня {@code levelY} в прямоугольнике блоков. */
    private static void pour(ServerLevel level, int x0, int z0, int x1, int z1, double levelY) {
        WaterEngine engine = WaterEngine.of(level);
        int size = 32;
        double total = 0;
        int cells = 0;
        for (int rx = Math.floorDiv(x0, size); rx <= Math.floorDiv(x1, size); rx++) {
            for (int rz = Math.floorDiv(z0, size); rz <= Math.floorDiv(z1, size); rz++) {
                WaterRegion region = engine.regionAt(rx * size + size / 2, rz * size + size / 2);
                for (int j = 0; j < region.grid.height(); j++) {
                    for (int i = 0; i < region.grid.width(); i++) {
                        double wx = region.originX() + (i + 0.5) * region.cellSize;
                        double wz = region.originZ() + (j + 0.5) * region.cellSize;
                        if (wx < x0 - 0.5 || wx > x1 + 1.5 || wz < z0 - 0.5 || wz > z1 + 1.5) {
                            continue;
                        }
                        double want = levelY - region.grid.ground(i, j);
                        if (want <= 0.02) {
                            continue;
                        }
                        double have = region.grid.depth(i, j);
                        if (have + 0.001 < want) {
                            double add = (want - have) * region.cellSize * region.cellSize;
                            region.grid.addVolume(i, j, add);
                            total += add;
                            cells++;
                        }
                    }
                }
            }
        }
        Aquaflux.LOGGER.info("[screens] налито {} м3 в {} ячеек, уровень {}", String.format("%.1f", total), cells, levelY);
    }

    private static void teleport(ServerLevel level, double x, double y, double z,
                                 double tx, double ty, double tz) {
        onServer(() -> {
            MinecraftServer server = server();
            if (server.getPlayerList().getPlayers().isEmpty()) {
                return;
            }
            ServerPlayer sp = server.getPlayerList().getPlayers().get(0);
            sp.setGameMode(GameType.CREATIVE);
            sp.getAbilities().mayfly = true;
            sp.getAbilities().flying = true;
            sp.onUpdateAbilities();
            double dx = tx - x;
            double dy = ty - y;
            double dz = tz - z;
            double flat = Math.sqrt(dx * dx + dz * dz);
            float yaw = (float) (Math.toDegrees(Math.atan2(-dx, dz)));
            float pitch = (float) (-Math.atan2(dy, flat) * 180.0 / Math.PI);
            sp.setDeltaMovement(0, 0, 0);
            sp.teleportTo(level, x, y, z, yaw, pitch);
            Aquaflux.LOGGER.info("[screens] камера {} {} {} -> yaw {} pitch {}",
                    String.format("%.1f", x), String.format("%.1f", y), String.format("%.1f", z),
                    String.format("%.1f", yaw), String.format("%.1f", pitch));
        });
    }

    // ------------------------------------------------------------------ кадр

    /** Диагностика перед кадром: видит ли клиент воду и строит ли меш. */
    private static void logDiagnostics(String name) {
        Minecraft mc = Minecraft.getInstance();
        ClientLevel level = mc.level;
        if (level == null || mc.player == null) {
            return;
        }
        BlockPos center = mc.player.blockPosition();
        int blocks = 0;
        int top = 0;
        for (BlockPos p : BlockPos.betweenClosed(center.offset(-24, -10, -24), center.offset(24, 10, 24))) {
            if (level.getBlockState(p).is(ModBlocks.PHYSICAL_WATER.get())) {
                blocks++;
            }
        }
        // Свет и блоки под игроком: видно, освещено ли дно и что там за блоки.
        StringBuilder probe = new StringBuilder();
        BlockPos below = center.below(2);
        for (int dy = 0; dy < 9; dy++) {
            BlockPos q = below.below(dy);
            int sky = level.getBrightness(net.minecraft.world.level.LightLayer.SKY, q);
            int blk = level.getBrightness(net.minecraft.world.level.LightLayer.BLOCK, q);
            probe.append(q.toShortString()).append('=')
                    .append(level.getBlockState(q).getBlock()).append("[sky").append(sky)
                    .append(",blk").append(blk).append("] ");
        }
        Aquaflux.LOGGER.info("[screens] проба света: {}", probe);

        // Карта блоков и глубин вокруг игрока: видно, совпадают ли чёрные пятна
        // с клетками, где блок воды не поставлен или дно выше воды.
        StringBuilder map = new StringBuilder("\n");
        for (int dz = -8; dz <= 8; dz++) {
            for (int dx = -8; dx <= 8; dx++) {
                BlockPos waterTop = null;
                for (int dy = 8; dy >= -12; dy--) {
                    BlockPos c = center.offset(dx, dy, dz);
                    if (level.getBlockState(c).is(ModBlocks.PHYSICAL_WATER.get())) {
                        waterTop = c;
                        break;
                    }
                }
                if (waterTop == null) {
                    map.append('.');
                } else {
                    int sky = level.getBrightness(net.minecraft.world.level.LightLayer.SKY, waterTop.above());
                    map.append(sky >= 10 ? 'W' : 'w');
                }
            }
            map.append('\n');
        }
        Aquaflux.LOGGER.info("[screens] карта воды W/w/.: {}", map);
        int drops = 0;
        for (ClientWaterCache.Field f : ClientWaterCache.fields().values()) {
            drops += f.parcels.count();
        }
        Aquaflux.LOGGER.info("[screens] {}: блоков воды {}, капель {}, меш [{}], полей {}, smooth={}, radius={},"
                        + " shader={}, поз={}", name, blocks, drops, WaterSurfaceRenderer.meshStats(),
                ClientWaterCache.fields().size(), AquafluxConfig.smoothSurface(),
                AquafluxConfig.smoothRadius(), AquafluxConfig.shaderMode(), center.toShortString());
    }

    private static void grab(String name) {
        Minecraft mc = Minecraft.getInstance();
        logDiagnostics(name);
        if (name.endsWith("01-pit")) {
            // Следующий кадр выгрузит квады ровно этого вида - по ним разбираем картинку.
            WaterSurfaceRenderer.requestQuadDump();
        }
        try {
            RenderTarget target = mc.getMainRenderTarget();
            int w = mc.getWindow().getWidth();
            int h = mc.getWindow().getHeight();
            if (w <= 0 || h <= 0) {
                w = target.width;
                h = target.height;
            }
            ByteBuffer buffer = BufferUtils.createByteBuffer(w * h * 4);
            GL11.glReadPixels(0, 0, w, h, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, buffer);
            BufferedImage image = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
            for (int y = 0; y < h; y++) {
                int row = (h - 1 - y) * w * 4;
                for (int x = 0; x < w; x++) {
                    int i = row + x * 4;
                    int r = buffer.get(i) & 0xFF;
                    int g = buffer.get(i + 1) & 0xFF;
                    int b = buffer.get(i + 2) & 0xFF;
                    image.setRGB(x, y, (r << 16) | (g << 8) | b);
                }
            }
            File file = new File(DIR, name + ".png");
            ImageIO.write(image, "png", file);
            Aquaflux.LOGGER.info("[screens] кадр {} ({}x{})", file.getAbsolutePath(), w, h);
        } catch (Throwable t) {
            Aquaflux.LOGGER.error("[screens] не смог снять кадр {}", name, t);
        }
    }
}
