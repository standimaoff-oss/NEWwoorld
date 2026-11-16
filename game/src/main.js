/* ShopSim 0.6 — точка входа: сборка мира, цикл, режимы. */
import * as THREE from 'three';
import { Renderer } from './gfx/renderer.js';
import { Sky } from './gfx/sky.js';
import { Water } from './gfx/water.js';
import { GrassField } from './gfx/grass.js';
import { City } from './world/city.js';
import { Weather } from './world/weather.js';
import { settings, applyCliOverrides, q, saveSettings, platform, VERSION } from './core/settings.js';
import { Input } from './core/input.js';
import { UI } from './core/ui.js';
import { Player } from './player/player.js';
import { Gameplay } from './game/gameplay.js';
import { Traffic } from './world/traffic.js';
import { Effects } from './gfx/effects.js';
import { AudioSys } from './core/audio.js';
import { PostFX } from './gfx/post.js';

const params = new URLSearchParams(location.search);
// Electron передаёт аргументы через window.__argv
if (window.__argv && window.__argv.length) {
  for (const a of window.__argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) params.set(m[1], m[2] === undefined ? '1' : m[2]);
  }
}
applyCliOverrides(params);
const TEST_MODE = params.has('test') || params.has('headless');


const canvas = document.getElementById('scene');
const renderer = new Renderer(canvas);
const ui = new UI({ input: null });
const input = new Input(canvas);
ui.game = null;
const clock = new THREE.Clock();

const game = {
  renderer, ui, input, settings, params,
  mode: 'walk', paused: false,
  time: 0, day: 1, money: 62000,
  shops: [], ownedShop: null, nearShop: null,
  stats: { served: 0, revenue: 0 },
  panelOpen: null,
  toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  },
  togglePanel(id) { this.closePanel(this.panelOpen); if (this.panelOpen !== id) this.openPanel(id); },
  openPanel(id) {
    this.panelOpen = id;
    ui.openPanel(id);
    input.unlock();
    if (id === 'catalog') this.gameplay.openCatalog();
    if (id === 'map') this.gameplay.openMap();
    if (id === 'graphics') ui.graphicsPanel();
    if (id === 'pause') this.gameplay.openPause();
    if (id === 'shop') this.gameplay.openShopPanel();
  },
  closePanel(id) {
    if (!id) return;
    ui.closePanel(id);
    if (this.panelOpen === id) this.panelOpen = null;
  },
  touchAction(act, on) {
    if (act === 'run') input.touch.run = on;
    if (act === 'use' && on) input.queueAction('use');
    if (act === 'map' && on) this.togglePanel('map');
    if (act === 'cat' && on) this.togglePanel('catalog');
  },
  setQuality(k) { settings.quality = k; saveSettings(); this.applyGraphics(); },
  setSeason(s) { settings.season = s; saveSettings(); this.applySeason(); },
  applyGraphics() {
    renderer.applyQuality();
    grass.setQuality();
    sky.setCloudQuality();
    saveSettings();
  },
  applyWeather() { weather.applySettings(); },
  applySeason() { applySeasonToWorld(this, settings.season); },
  notify(t, k) { ui.notify(t, k); },
};
ui.game = game;

let sky, water, grass, city, weather, player, gameplay, traffic, effects, audio;

function applySeasonToWorld(g, season) {
  sky.setSeasonColors?.(season);
  if (g.grass) g.grass.applySeason(season);
}

async function boot() {
  ui.boot(0.02, 'движок');
  const scene = renderer.scene;
  scene.fog = new THREE.FogExp2(0xc0cdd8, 0.0011);

  sky = new Sky(scene);
  ui.boot(0.08, 'небо');
  weather = new Weather(scene);
  weather.camera = renderer.camera;
  city = new City(scene, renderer);
  game.city = city;
  await city.build((p, txt) => ui.boot(0.1 + p * 0.6, txt));
  ui.boot(0.72, 'воду и траву');
  water = new Water(scene, city);
  grass = new GrassField(scene, city);
  game.water = water; game.grass = grass;
  grass.setQuality();
  effects = new Effects(scene, renderer);
  traffic = new Traffic(scene, city, weather);
  audio = new AudioSys(settings);

  ui.boot(0.8, 'свет');
  const hemi = new THREE.HemisphereLight(0xbcd6ff, 0x55503f, 0.6);
  scene.add(hemi);
  hemi.name = 'hemi-light';
  const sun = new THREE.DirectionalLight(0xfff3dc, 2.0);
  sun.castShadow = settings.shadows && q().shadows;
  sun.shadow.mapSize.set(q().shadowSize || 2048, q().shadowSize || 2048);
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 260;
  const S = 62;
  sun.shadow.camera.left = -S; sun.shadow.camera.right = S; sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  scene.add(sun);
  scene.add(sun.target);
  const amb = new THREE.AmbientLight(0x8fa8c0, 0.35);
  scene.add(amb);
  game.sun = sun; game.hemi = hemi; game.amb = amb;

  // окружение: запекаем небо (и облака-градиент) для отражений в стекле, металле и воде
  const pmrem = new THREE.PMREMGenerator(renderer.renderer);
  pmrem.compileEquirectangularShader();
  const envScene = new THREE.Scene();
  const envMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      uTop: { value: new THREE.Color(0.28, 0.5, 0.86) },
      uHor: { value: new THREE.Color(0.78, 0.86, 0.95) },
      uGnd: { value: new THREE.Color(0.22, 0.23, 0.19) },
      uSun: { value: new THREE.Color(1, 0.95, 0.85) },
    },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 uTop,uHor,uGnd,uSun; varying vec3 vD;
      void main(){ vec3 d = normalize(vD); float h = clamp(d.y,0.0,1.0);
        vec3 c = mix(uHor, uTop, pow(h,0.6));
        c = mix(uGnd, c, smoothstep(-0.12,0.05,d.y));
        c += uSun * pow(max(dot(d, normalize(vec3(0.35,0.65,0.5))),0.0), 8.0) * 0.35;
        gl_FragColor = vec4(c,1.0); }`,
  });
  const envSphere = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 16), envMat);
  envScene.add(envSphere);
  const envRT = pmrem.fromScene(envScene, 0.04);
  renderer.scene.environment = envRT.texture;
  game.envMat = envMat;
  renderer.scene.environmentIntensity = 1.0;

  ui.boot(0.85, 'персонаж');
  player = new Player(scene, city, input, renderer.camera);
  game.player = player;
  gameplay = new Gameplay(game);
  game.gameplay = gameplay;
  gameplay.init(city.data);
  if (!params.has('newgame') && !params.has('fresh')) gameplay.load();
  game.weather = weather;

  ui.boot(0.92, 'город наполняется');
  traffic.build();
  traffic.game = game;
  traffic.playerX = 0; traffic.playerZ = 0;
  // стартовая позиция: пешеходная часть проспекта К. Маркса
  const st0 = gameplay.shopsys.spawn;
  const spawn = params.has('spawn') ? params.get('spawn').split(',').map(Number) : [st0 ? st0.x : 21, 0.2, st0 ? st0.z : 96];
  player.teleport(spawn[0], spawn[2]);
  if (spawn[3]) player.yaw = spawn[3] * Math.PI / 180;
  else {
    const st = gameplay.shopsys.starter;
    if (st) player.yaw = Math.atan2(-(st.x - spawn[0]), -(st.z - spawn[2]));
  }

  if (params.has('hour')) weather.setHour(parseFloat(params.get('hour')));
  if (params.has('night')) weather.setHour(22);
  if (params.has('morning')) weather.setHour(7.6);
  if (params.has('beijing') || params.has('bj')) teleportBeijing(game, parseFloat(params.get('bj')) || 0);
  if (params.has('grass')) grass.uniforms.uFar.value = parseFloat(params.get('grass'));
  // свободная камера для снимков: --cam=x,y,z,yaw°,pitch°
  if (params.has('cam')) {
    const c = params.get('cam').split(',').map(Number);
    game.freeCam = { x: c[0], y: c[1], z: c[2], yaw: (c[3] || 0) * Math.PI / 180, pitch: (c[4] || 0) * Math.PI / 180 };
  }

  // постобработка: HDR + FXAA
  const post = new PostFX(renderer.renderer, renderer.scene, renderer.camera);
  renderer.post = post;
  post.setSize(window.innerWidth, window.innerHeight, renderer.renderer.getPixelRatio());
  post.uniforms.uAa.value = q().aa ? 1 : 0;
  game.post = post;

  renderer.onFrame = onFrame;
  renderer.start();
  ui.boot(1, 'готово');
  setTimeout(() => {
    ui.bootDone();
    if (params.has('nohud')) { const h = document.getElementById('hud'); if (h) h.classList.add('hidden'); }
  }, 180);
  console.log('SHOPSIM READY v' + VERSION, JSON.stringify(city.statistics()));
  window.__ready = true;

  // автотест: печатает отчёт в консоль
  if (TEST_MODE) runSelfTest();
}

function teleportBeijing(g, dz) {
  const { PARK_BAMBOO } = window.__gen || {};
  const cx = 665, cz = -665;
  g.player.teleport(cx + 20, cz + 30 + (dz || 0));
  g.notify('Бамбуковый парк — Пекин', 'good');
}

function updateSun() {
  const w = weather;
  // солнце и свет
  // тень следит за игроком, но карта теней пересчитывается не каждый кадр:
  // только когда игрок сдвинулся на 6 м или солнце ушло на 1.5°
  const shadowMoved = !game._shadowAnchor
    || Math.hypot(player.pos.x - game._shadowAnchor.x, player.pos.z - game._shadowAnchor.z) > 6
    || Math.abs((w.sunDir.x + w.sunDir.y) - (game._shadowAnchor.sx + game._shadowAnchor.sy)) > 0.026;
  game._shadowAnchor = { x: player.pos.x, z: player.pos.z, sx: w.sunDir.x, sy: w.sunDir.y };
  if (shadowMoved) game._shadowDirty = true;
  renderer.renderer.shadowMap.autoUpdate = false;
  renderer.renderer.shadowMap.needsUpdate = !!game._shadowDirty;
  if (game._shadowDirty) game._shadowDirty = false;
  game.sun.position.copy(w.sunDir).multiplyScalar(180).add(new THREE.Vector3(player.pos.x, 0, player.pos.z));
  game.sun.target.position.set(player.pos.x, 0, player.pos.z);
  game.sun.color.copy(w.sunColor);
  game.sun.intensity = w.lightIntensity;
  game.sun.castShadow = (settings.shadows && q().shadows) && !w.isNight();
  game.hemi.color.copy(w.skyHor);
  game.hemi.groundColor.copy(w.groundAmb);
  game.hemi.intensity = w.ambientIntensity;
  game.amb.intensity = w.ambientIntensity * 0.4;
  sky.setSun(w.sunDir, w.sunColor, w.night);
  sky.setSkyColors(w.skyTop, w.skyHor, w.groundAmb);
  sky.setClouds(w.cloudCoverage, w.cloudDensity, w.night);
  sky.setDusk(w.dusk);
  water.setSun(w.sunDir, w.sunColor, w.skyTop, w.skyHor);
  water.setFog(80, 900, w.fogColor);
  water.setNight(w.night);
  water.setRain(w.rain);
  water.setWaves(0.42 + w.rain * 0.75);
  grass.setSun(w.sunDir, w.sunColor, w.skyHor, w.groundAmb);
  const fogNear = 40 - w.rain * 22, fogFar = 380 - w.rain * 160;
  grass.setFog(fogNear, fogFar, w.fogColor);
  grass.setWet(w.wetness);
  grass.uniforms.uAmbient.value = 0.55 + w.ambientIntensity * 0.6;
  grass.uniforms.uSkyColor.value.copy(w.skyHor).multiplyScalar(0.9);
  grass.uniforms.uGroundColor.value.copy(w.groundAmb);
  grass.setWind(0.75 + w.rain * 0.5, 0.55, 0.75 + w.rain * 0.85);
  renderer.scene.fog.color.copy(w.fogColor);
  renderer.scene.fog.density = 0.0012 + w.rain * 0.0022;
  renderer.renderer.toneMappingExposure = 0.9 + (1 - w.night) * 0.25;
  city.setNight(w.night);
  city.setWet(w.wetness);
  if (game.post) {
    game.post.uniforms.uNight.value = w.night;
    game.post.uniforms.uRain.value = w.rain;
    game.post.uniforms.uAa.value = q().aa ? 1 : 0;
    game.post.uniforms.uExposure.value = renderer.renderer.toneMappingExposure;
  }
  if (game.envMat) {
    game.envMat.uniforms.uTop.value.copy(w.skyTop);
    game.envMat.uniforms.uHor.value.copy(w.skyHor);
    game.envMat.uniforms.uGnd.value.copy(w.groundAmb);
    game.envMat.uniforms.uSun.value.copy(w.sunColor);
    renderer.scene.environmentIntensity = 0.65 - w.night * 0.35;
  }
}

/* Авто-качество: на слабом устройстве/GPU снижаем плотность травы, чтобы игра не тормозила.
   Никогда не повышаем автоматически выше выбранного уровня — только понижаем. */
const autoQuality = {
  samples: [], cooldown: 2.5, base: null,
  tick(dt, grassObj) {
    if (!grassObj || !grassObj.enabled) return;
    this.samples.push(dt);
    if (this.samples.length < 30) return;
    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    this.samples.length = 0;
    if (this.cooldown > 0) { this.cooldown -= 1; return; }
    if (avg > 0.055) {                 // < ~18 fps — режем
      const next = Math.max(0.25, (grassObj.budget || 1) * 0.75);
      if (next < (grassObj.budget || 1) - 0.01) {
        grassObj.budget = next;
        grassObj.rebuild?.();
        this.cooldown = 3;
        window.ShopLog?.info?.(`авто-качество: трава ${Math.round(next * 100)}%`);
      }
    }
  },
};

let frameCount = 0;
function onFrame(dt, t) {
  game.time += dt;
  weather.update(dt);
  updateSun();
  if (!game.paused) {
    // фиксированный шаг: на слабых устройствах симуляция всё равно идёт в реальном времени
    game._acc = (game._acc || 0) + dt;
    const STEP = 1 / 30;
    let steps = 0;
    while (game._acc >= STEP && steps < 6) {
      player.update(STEP, game.mode);
      gameplay.update(STEP);
      game._acc -= STEP; steps++;
    }
    if (steps === 6) game._acc = 0; // не копим долг, если совсем не тянет
  }
  if (game.freeCam) {
    const c = game.freeCam;
    renderer.camera.position.set(c.x, c.y, c.z);
    renderer.camera.rotation.set(0, 0, 0);
    renderer.camera.rotateY(c.yaw);
    renderer.camera.rotateX(c.pitch);
    player.pos.set(c.x, 0.2, c.z);
  }
  city.cullVegetation?.(renderer.camera);
  autoQuality.tick(dt, grass);
  grass.update(dt, renderer.camera, player.pos);
  water.update(dt);
  sky.update(dt, renderer.camera);
  traffic.update(dt);
  effects.update(dt);
  renderer.camera.updateMatrixWorld();
  ui.hud({
    money: game.money, clockText: weather.clockText(), day: weather.day, fps: renderer.fps,
    paused: game.paused, zone: ui.zoneHTML(require_zone_name(), weather.isNight() ? 'ночь' : ''),
  });
  frameCount++;
  input.endFrame();
}
function require_zone_name() {
  return game.gameplay ? game.gameplay.zoneName() : 'Самара';
}

/* ---------- автотест ---------- */
async function runSelfTest() {
  const { runTests } = await import('./test/selftest.js');
  setTimeout(() => runTests(game, { sky, water, grass, city, weather, player, gameplay, traffic, effects }), 500);
}

boot().catch((e) => { console.error(e); window.ShopLog?.error?.('boot: ' + (e.stack || e.message)); });

window.__game = game;
window.__renderer = renderer;
window.__grass = () => grass;
window.__sky = () => sky;

/* --- API для автотестов и снимков --- */
window.__api = {
  setCam(x, y, z, yawDeg = 0, pitchDeg = 0) {
    game.freeCam = { x, y, z, yaw: yawDeg * Math.PI / 180, pitch: pitchDeg * Math.PI / 180 };
  },
  freecamOff() { game.freeCam = null; },
  setHour(h) { weather.setHour(h); },
  setWeather(mode) { settings.weather = mode; weather.applySettings(); },
  setSeason(season) { settings.season = season; game.applySeason(); },
  stats() {
    return {
      fps: renderer.fps, calls: renderer.drawCalls, tris: renderer.triangles,
      grass: grass ? grass.stats() : null, hour: weather ? +weather.hour.toFixed(2) : null,
      rain: weather ? +weather.rain.toFixed(2) : null, night: weather ? +weather.night.toFixed(2) : null,
    };
  },
  world() { return city ? city.statistics() : null; },
  player() { return { x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw }; },
  teleport(x, z) { player.teleport(x, z); },
  shopList() { return game.shops.map((s) => ({ id: s.id, name: s.name, x: s.x, z: s.z, owned: s.owned, rented: s.rented, open: s.open, stock: s.stockLevel })); },
  logs() { return window.ShopLog?.dump?.() || { errors: [], warns: [], info: [] }; },
  grassInfo() { return grass ? grass.debugInfo() : null; },
  clouds() { return sky ? sky.debugClouds() : null; },
  sceneInfo() {
    const out = [];
    renderer.scene.traverse((o) => {
      if (o.isInstancedMesh) out.push({ name: o.name || o.geometry.type, count: o.count, visible: o.visible, culled: o.frustumCulled, mat: o.material.type });
    });
    return out;
  },
};
