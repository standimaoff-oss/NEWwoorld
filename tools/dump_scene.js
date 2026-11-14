#!/usr/bin/env node
// dump_scene.js — дамп сцены веб-сборки для эталонного CPU-рендера.
//
//   node tools/dump_scene.js --out build/preview/scene.json \
//        --view -120,14,250,40,6,-40 --t dusk --quality medium
//
// Зачем: снимок «игры» в песочнице снять нечем (нет ни GPU, ни браузера), но
// числам верить надо. Поэтому сцена один раз строится настоящим игровым кодом
// (web/js/world.js — те же функции, что вызывает main.js), а tools/shader_preview.py
// рисует её по формулам из shaders/glsl. Превью и игра используют один и тот же
// atlas, одну layer-карту и один набор чисел в web/js/materials.js.
//
// Видимый регион отбирается здесь, а не в Python: JSON остаётся маленьким,
// а CPU-рендер не гоняет 200 тыс. треугольников ради кадра 1120×630.

import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as W from '../web/js/world.js';
import { LOOK, QUALITY, SEASONS, TIMES, srgb2lin } from '../web/js/materials.js';
import { bakeGI, giStats } from '../web/js/gi.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
function num(name, def) { const v = arg(name); return v === null ? def : Number(v); }
const clamp = (x, a, b) => (x < a ? a : (x > b ? b : x));
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

const timeKey = arg('t', 'noon');
const seasonKey = arg('season', 'summer');
const quality = arg('quality', 'medium');
const T = TIMES[timeKey] || TIMES.noon;
const S = SEASONS[seasonKey] || SEASONS.summer;
const rain = clamp(num('rain', 0), 0, 1);
const snow = clamp(num('snow', S.snow), 0, 1);
const wind = clamp(num('wind', 0.4), 0, 1);
const view = (arg('view', '-120,14,250,40,6,-40') + '').split(',').map(Number);
if (view.length < 6 || view.some((v) => !Number.isFinite(v))) {
  console.error('--view x,y,z,tx,ty,tz обязателен и должен содержать 6 чисел');
  process.exit(2);
}
const cam = { pos: view.slice(0, 3), target: view.slice(3, 6) };
const yaw = Math.atan2(cam.target[0] - cam.pos[0], cam.target[2] - cam.pos[2]);
const pitch = Math.atan2(cam.target[1] - cam.pos[1], Math.hypot(cam.target[0] - cam.pos[0], cam.target[2] - cam.pos[2]));
const fov = num('fov', 55);

// ------------------------------------------------------------- строка сцены
const t0 = Date.now();
const layout = W.blockLayout(20261);
const lake = (x, z) => W.lakeField(x, z);
const bamboo = (x, z) => W.bambooParkField(x, z);
const layers = W.buildLayers(lake, bamboo, layout);
const wd = W.buildWaterDepth(512, lake);
const bld = W.buildBuildings(layout, { signCount: 32 });
const vegAll = W.buildVegetation(layout, { bamboo: 5200, palms: 300 });
const lamps = W.lampPositions(layout, bld).map(([x, z]) => ({ x, z, y: 7.3 }));
const signs = W.buildSigns(bld, 32, { lamps }).signs.concat(W.buildTreeLights(vegAll.tree, { lamps: 220 }));

// ------------------------------------------------------- отбор по видимости
const R = num('radius', 300);                     // метры вокруг камеры
// Трава — плотное поле вокруг камеры (как в main.js): иначе снимок показывает
// десятые доли травинки на м² и «лысый» газон, хотя в игре он густой.
const q = QUALITY[quality];
let grassField;

const near = (x, z, pad = 0) => Math.hypot(x - cam.pos[0], z - cam.pos[2]) <= R + pad;

const FACADE_LIN = [
  [0.141, 0.132, 0.120], [0.159, 0.150, 0.136], [0.092, 0.048, 0.036],
  [0.106, 0.104, 0.099], [0.057, 0.019, 0.014], [0.022, 0.028, 0.038],
  [0.174, 0.166, 0.146], [0.248, 0.172, 0.048],
];
const FACADE_ROUGH = [0.82, 0.80, 0.73, 0.74, 0.57, 0.34, 0.57, 0.23];

const boxes = [];
for (const b of bld) {
  if (!near(b.x, b.z, Math.max(b.w, b.d))) continue;
  const alb = FACADE_LIN[b.facade] || FACADE_LIN[0];
  // зима: снег на крышах осветляет весь объём — здесь это общий множитель
  const k = 1 + 0.10 * snow;
  boxes.push([b.x - b.w / 2, 0, b.z - b.d / 2, b.w, b.h, b.d,
              alb[0] * k, alb[1] * k, alb[2] * k, FACADE_ROUGH[b.facade] || 0.7,
              b.floors, b.floorH, b.winW, (b.seed % 997) / 997, b.lit]);
}
for (const l of lamps) {
  if (!near(l.x, l.z)) continue;
  boxes.push([l.x - 0.14, 0, l.z - 0.14, 0.28, l.y, 0.28, 0.035, 0.036, 0.038, 0.42, 0, 0, 0, 0.5, 0]);
}

grassField = W.buildGrassField({
  layers, center: [cam.pos[0], cam.pos[2]], max: num('maxGrassField', q.grass),
  // пояса берём из профиля, только сжимаем под радиус дампа: кадр превью видит
  // 22..30 м, а не 63, и плотность ядра должна считаться именно на кадре
  bands: (q.grassBands || []).map(([rad, cell]) => [Math.min(rad, R * 0.95), cell * num('grassCellScale', 1)]),
  height: S.grassH, seed: 5, treeX: 6, treeZ: -20,
});
const grass = grassField;
const grassOut = [];
for (let i = 0; i < grass.count && grassOut.length < num('maxGrass', 26000); i++) {
  const o = i * 4;
  const x = grass.iPos[o], z = grass.iPos[o + 1];
  if (!near(x, z, 90)) continue;
  grassOut.push([x, z, grass.iPos[o + 2], grass.iPos[o + 3],
                 grass.iShape[o], grass.iShape[o + 1], grass.iShape[o + 3]].map((v) => +v.toFixed(4)));
}

const vegOut = [];
for (const v of vegAll.veg) {
  if (vegOut.length >= num('maxVeg', 4200)) break;
  if (!near(v.x, v.z, 120)) continue;
  vegOut.push([v.x, v.z, v.h, v.w, v.rot, v.stiff, v.type, v.tint].map((q) => +q.toFixed(4)));
}

const SIGN_COLORS = [[0.85, 0.10, 0.08], [0.95, 0.72, 0.10], [0.10, 0.55, 0.30],
                     [0.20, 0.35, 0.85], [0.75, 0.20, 0.55], [0.92, 0.92, 0.85]];
const signOut = [];
for (const s of signs) {
  if (!near(s.x, s.z)) continue;
  const c = SIGN_COLORS[s.cell % SIGN_COLORS.length];
  signOut.push([s.x, s.y, s.z, s.w, s.h, s.rot, s.tilt, c[0], c[1], c[2], s.bright, s.cell, s.mode]);
}

// вода: сетка по береговой коробке — только если она в радиусе
const water = [];
{
  const b = wd.box;
  const step = num('waterStep', 3);
  const nx = Math.ceil((b.maxX - b.minX) / step), nz = Math.ceil((b.maxZ - b.minZ) / step);
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x0 = b.minX + ix * step, z0 = b.minZ + iz * step;
      const cxm = x0 + step / 2, czm = z0 + step / 2;
      if (lake(cxm, czm) >= 1.0) continue;
      if (!near(cxm, czm, step * 3)) continue;
      water.push([x0, z0, step]);
    }
  }
}

// земля: клетки по layer-карте вокруг камеры
const ground = [];
{
  const step = num('groundStep', 4);
  const size = W.LAYERS, half = W.WORLD / 2;
  const x0 = Math.floor((cam.pos[0] - R) / step) * step, x1 = cam.pos[0] + R;
  const z0 = Math.floor((cam.pos[2] - R) / step) * step, z1 = cam.pos[2] + R;
  for (let x = x0; x < x1; x += step) {
    for (let z = z0; z < z1; z += step) {
      const px = clamp(Math.round((x / W.WORLD + 0.5) * (size - 1)), 0, size - 1);
      const py = clamp(Math.round((z / W.WORLD + 0.5) * (size - 1)), 0, size - 1);
      const o = (py * size + px) * 4;
      const mat = Math.round(layers[o] / 255 * 7);
      const turf = layers[o + 1] / 255, basin = layers[o + 2] / 255, wear = layers[o + 3] / 255;
      const L = lake(x, z);
      const y = L < 1.02 ? -clamp((1.02 - L) * 9, 0, 6.5) : 0;   // плоский город + чаша озера
      ground.push([x, z, step, mat, +turf.toFixed(3), +basin.toFixed(3), +wear.toFixed(3), +y.toFixed(3)]);
    }
  }
}

// ------------------------------------------------------------------ GI + env
const lights = lamps.map((l) => ({ x: l.x, z: l.z, y: l.y, r: 24, c: [0.30, 0.24, 0.15], kind: 1 }))
  .concat(signs.slice(0, 700).map((s) => ({ x: s.x, z: s.z, y: s.y + s.h, r: 18, c: [0.26, 0.16, 0.14], kind: 0 })));
const gi = bakeGI(bld, lights, {
  day: T.day, sunDir: norm3(T.dir), sunCol: T.sun, skyCol: T.sky, rain, snow,
});
const giStat = giStats(gi.data);

const out = {
  version: '5.33',
  camera: { pos: cam.pos, yaw, pitch, fov },
  env: {
    sun: norm3(T.dir), day: T.day, sunCol: T.sun, skyCol: T.sky,
    clouds: LOOK.sky.clouds[0] * (0.6 + 0.9 * (T.day < 0.4 ? 1.2 : 1)) + rain * 0.35,
    exposure: LOOK.exposure, rain, snow, wind, wet: clamp(Math.max(rain * 0.9, snow * 0.35), 0, 1),
    season: S.season, fog: (rain > 0.05 ? LOOK.fogWet : LOOK.fogClear),
  },
  look: { ground: LOOK.ground, facade: LOOK.facade, grass: LOOK.grass, veg: LOOK.veg,
          water: LOOK.water, post: LOOK.post, emissive: LOOK.emissive },
  waterBox: [wd.box.minX, wd.box.minZ, wd.box.maxX - wd.box.minX, wd.box.maxZ - wd.box.minZ],
  counts: { boxes: boxes.length, grass: grassOut.length, veg: vegOut.length, signs: signOut.length,
            ground: ground.length, water: water.length, grassTotal: grass.count,
            grassDensity: +(grassOut.length / Math.max(1, Math.PI * Math.pow(num('grassRadius', R * 0.8), 2))).toFixed(1),
            vegTotal: vegAll.veg.length, buildings: bld.length, signsTotal: signs.length },
  gi: { cells: giStat.cells, irradiance: +giStat.irradiance.toFixed(4), skyVis: +giStat.skyVis.toFixed(3),
        ms: gi.ms, ms_per_cell: +(gi.ms / giStat.cells * 1000).toFixed(2) },
  // сам объём — рядом бинарником (gi_u8.bin): превью обязан светить ТЕМ ЖЕ
  // запечённым светом, что и веб-сборка через uGIVol, иначе «эталон» расходится
  // с игрой в сумерках и ночью (у фонарей появляются тёплые пятна, а на снимке — нет)
  giVol: { file: 'gi_u8.bin', size: gi.size, cell: gi.cell, world: 1536, gain: 1.6 },
  textures: {
    facade: 'assets/textures/beijing_facade.png',
    facadeNrm: 'assets/textures/beijing_facade_nrm.png',
    signs: 'assets/textures/beijing_signs.png',
    grass: 'assets/textures/grass_blade.png',
    turf: 'assets/textures/grass_turf.png',
    veg: 'assets/textures/veg_atlas.png',
    ground: 'assets/textures/ground_atlas.png',
    waterFoam: 'assets/textures/water_foam.png',
  },
  boxes, grass: grassOut, veg: vegOut, signs: signOut, water, ground,
};

const path = resolve(ROOT, arg('out', 'build/preview/scene.json'));
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(out));
// Слой-карта и глубина — рядом, чтобы Python читал те же массивы, что и GPU.
const bin = resolve(dirname(path), 'layers_u8.bin');
writeFileSync(bin, Buffer.from(layers.buffer, layers.byteOffset, layers.byteLength));
const dbin = resolve(dirname(path), 'water_depth_u8.bin');
writeFileSync(dbin, Buffer.from(wd.data.buffer, wd.data.byteOffset, wd.data.byteLength));
const gbin = resolve(dirname(path), 'gi_u8.bin');
writeFileSync(gbin, Buffer.from(gi.data.buffer, gi.data.byteOffset, gi.data.byteLength));
const rep = {
  seconds: +((Date.now() - t0) / 1000).toFixed(2), sizeKB: +(statSync(path).size / 1024).toFixed(0),
  ...out.counts, gi: out.gi, time: timeKey, season: seasonKey, quality,
};
writeFileSync(resolve(dirname(path), 'dump_report.json'), JSON.stringify(rep, null, 1));
console.log('дамп сцены:', path);
console.log(JSON.stringify(rep));
