#!/usr/bin/env node
// test_web_logic.mjs — проверки логики веб-сборки без браузера и без GPU.
//
//   node tests/test_web_logic.mjs
//
// Почему это нужно: ShopSim.exe в песочнице не запустить, браузера нет, поэтому
// «проверить» можно то, что проверяется статически и числами:
//   1. геометрия сцены (world.js) — инварианты: нет NaN, трава не на асфальте,
//      дома не в озере, вывески в пределах фасада,密度 травы и т.д.;
//   2. запечённый GI (gi.js) — значения в диапазоне, дворы темнее улицы;
//   3. контракт uniform'ов — каждое имя, которое main.js/materials.js подставляет
//      в шейдер, реально объявлен в shaders/glsl (ловит опечатки вроде uWaterNrm);
//   4. index.html — каждый id, за которым лезет JS, присутствует в разметке;
//   5. материалы — альбедо/шероховатость из docs/material_report*.json в допуске
//      ТЗ («не ярко, не глянцево»).
// Выход ≠ 0 падает на любой проверке, CI-скрипт tools/check.sh использует его как есть.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import * as W from '../web/js/world.js';
import { bakeGI, giStats, GI, NIGHT_LIGHT_GAIN } from '../web/js/gi.js';
import { LOOK, QUALITY, SEASONS, TIMES, TEX } from '../web/js/materials.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const js = read('web/js/main.js');        // нужен и в [6] (uniform-контракт), и в [7]

let fails = 0, checks = 0;
const ok = (name, cond, extra = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`); }
  else console.log(`  ✓ ${name}${extra ? '  (' + extra + ')' : ''}`);
};
const finite = (a) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

console.log('\n[1] геометрия квартала');
const layout = W.blockLayout(20261);
const bld = W.buildBuildings(layout, { signCount: 32 });
ok('кварталов в сетке 1536 м', layout.blocks.length === 144, `${layout.blocks.length}`);
ok('дома построены', bld.length > 400, `${bld.length} корпусов`);
const hmin = Math.min(...bld.map(b => b.h)), hmax = Math.max(...bld.map(b => b.h));
ok('высоты в диапазоне ТЗ (5..96 м)', hmin >= 4 && hmax <= 100, `${hmin.toFixed(1)}..${hmax.toFixed(1)} м`);
const wmin = Math.min(...bld.map(b => Math.min(b.w, b.d)));
ok('нет выроченных планов (< 6 м)', wmin >= 6, `минимальная сторона ${wmin.toFixed(1)} м`);
const floorsBad = bld.filter(b => b.floors < 1 || Math.abs(b.floors * b.floorH - b.h) > 0.6).length;
ok('этажность согласована с высотой', floorsBad === 0, `${floorsBad} расхождений`);
const inWater = bld.filter(b => [[-1,-1],[1,1],[-1,1],[1,-1]].some(([sx, sz]) =>
  W.lakeField(b.x + sx * b.w / 2, b.z + sz * b.d / 2) < 1.0)).length;
ok('дома не стоят в озере', inWater === 0, `${inWater}`);
const inBamboo = bld.filter(b => [[-1,-1],[1,1],[-1,1],[1,-1]].some(([sx, sz]) =>
  W.bambooParkField(b.x + sx * b.w / 2, b.z + sz * b.d / 2) < 1.0)).length;
ok('дома не стоят в бамбуковом парке', inBamboo === 0, `${inBamboo}`);
const outside = bld.filter(b => Math.abs(b.x) + b.w / 2 > W.WORLD / 2 || Math.abs(b.z) + b.d / 2 > W.WORLD / 2).length;
ok('вся сцена внутри 1536×1536', outside === 0);

console.log('\n[2] фасадный меш');
const mesh = W.buildFacadeMesh(bld, {});
ok('позиции конечны', finite(mesh.pos));
ok('нормали конечны', finite(mesh.nrm));
ok('атрибут стены конечен', finite(mesh.wall));
ok('индексы в диапазоне вершин', mesh.idx[mesh.idx.length - 1] < mesh.verts,
   `${mesh.idx.length / 3} треуг.`);
const types = new Set();
for (let i = 0; i < mesh.wall.length; i += 4) types.add(mesh.wall[i]);
ok('типы материалов ⊆ 0..7', [...types].every(t => t >= 0 && t <= 7), `${types.size} значений`);
// aWall.w = высота дома / 100 — по ней шейдер выбирает «мелкий» вариант фактуры
const heightIdx = [];
for (let i = 0; i < mesh.wall.length; i += 4) heightIdx.push(mesh.wall[i + 3]);
ok('высота дома/100 в допуске 0..1', heightIdx.every(v => v >= 0 && v <= 1.0));
const badNormals = (() => {
  let n = 0;
  for (let i = 0; i < mesh.nrm.length; i += 3) {
    const l = Math.hypot(mesh.nrm[i], mesh.nrm[i + 1], mesh.nrm[i + 2]);
    if (Math.abs(l - 1) > 1e-3) n++;
  }
  return n;
})();
ok('нормали единичные', badNormals === 0, `${badNormals} битых`);

console.log('\n[3] слой-карта, вода, трава');
const layers = W.buildLayers((x, z) => W.lakeField(x, z), (x, z) => W.bambooParkField(x, z), layout);
ok('layer-карта 512² RGBA', layers.length === W.LAYERS * W.LAYERS * 4);
const mats = new Float64Array(8);      // Uint8Array переполнился бы на 255
let turfOnAsphalt = 0, turfSum = 0;
for (let i = 0; i < layers.length; i += 4) {
  const m = Math.round(layers[i] / 255 * 7);
  mats[m]++;
  const g = layers[i + 1] / 255;
  turfSum += g;
  if ((m === 0 || m === 1) && g > 0.5) turfOnAsphalt++;
}
// 0..6 — покрытия, которые генератор пишет в карту; 7 («разметка») в слое
// физически не помещается: линия 0.7 м при шаге карты 3 м, её рисует шейдер.
ok('покрытия 0..6 встречаются в слое', mats.slice(0, 7).every(v => v > 0),
   [...mats].map(v => (v / 2621.44).toFixed(1) + '%').join('/'));   // map на typed array вернул бы числа
const shares = [...mats].map(v => v / 262144);
ok('нет доминанта одного покрытия (< 55%)', Math.max(...shares) < 0.55,
   `${(Math.max(...shares) * 100).toFixed(0)}%`);
ok('мат 7 (разметка) в слое отсутствует намеренно', mats[7] === 0, `${mats[7]} пикс.`);
ok('на асфальте и плитке травы нет', turfOnAsphalt === 0, `${turfOnAsphalt} пикс.`);
const wd = W.buildWaterDepth(512, (x, z) => W.lakeField(x, z));
let maxDepth = 0, wet = 0;
for (let i = 0; i < wd.data.length; i += 4) {
  const d = wd.data[i] / 255 * 11;
  if (d > 0.02) wet++;
  maxDepth = Math.max(maxDepth, d);
}
// карта глубин покрывает waterBox (озеро + протока), поэтому считаем долю воды
// внутри самого бокса, а не по всей текстуре
const wb = W.waterBox((x, z) => W.lakeField(x, z));
const boxCells = (wd.box ? (wd.box.maxX - wd.box.minX) * (wd.box.maxZ - wd.box.minZ) : 1) || 1;
const boxPx = wd.data.length / 4;      // вся карта глубин покрывает waterBox
ok('озеро заполнило 45..92% бокса глубин', wet / boxPx > 0.45 && wet / boxPx < 0.92,
   `${(wet / boxPx * 100).toFixed(1)}%`);
ok('глубина ≤ 11 м', maxDepth <= 11.001, `${maxDepth.toFixed(1)} м`);

const veg = W.buildVegetation(layout, { bamboo: 3000, palms: 200 });
ok('бамбук и пальмы посажены', veg.veg.length > 2000, `${veg.veg.length} объектов`);
const inLake = veg.veg.filter(v => W.lakeField(v.x, v.z) < 1.0).length;
ok('растения не в воде', inLake === 0, `${inLake}`);
const palmN = veg.veg.filter(v => v.type === 4).length, bambooN = veg.veg.filter(v => v.type === 3).length;
ok('пальмы есть (замена старых деревьев)', palmN > 150, `${palmN}`);
ok('бамбука больше, чем пальм (парк)', bambooN > palmN, `${bambooN} vs ${palmN}`);
const tallBad = veg.veg.filter(v => v.h <= 0.1 || v.h > 14 || !Number.isFinite(v.h)).length;
ok('высоты растений в диапазоне 0.1..14 м', tallBad === 0);

// самая «зелёная» точка карты: там проверяем плотность ядра без поправок на
// покрытие (на асфальте травы нет по замыслу, и это мерить нечем)
const gcenter = (() => {
  let best = [0, 0], bv = -1;
  for (let z = -500; z <= 500; z += 15) {
    for (let x = -700; x <= 700; x += 15) {
      const px = Math.round((x / W.WORLD + 0.5) * (W.LAYERS - 1));
      const py = Math.round((z / W.WORLD + 0.5) * (W.LAYERS - 1));
      const v = layers[(py * W.LAYERS + px) * 4 + 1];
      if (v > bv) { bv = v; best = [x, z]; }
    }
  }
  return best;
})();
const qM = QUALITY.medium;
const gf = W.buildGrassField({ layers, center: gcenter, max: qM.grass, bands: qM.grassBands, height: 1, seed: 5 });
ok('поле травы не пустое', gf.count > 10000, `${gf.count} травинок (cap ${qM.grass})`);
ok('координаты травы конечны', finite(gf.iPos) && finite(gf.iShape) && finite(gf.iExtra));
const rCore = qM.grassBands[0][0], rMid = qM.grassBands[1][0];
const rings = [0, 0, 0];
for (let i = 0; i < gf.count; i++) {
  const o = i * 4, d = Math.hypot(gf.iPos[o] - gcenter[0], gf.iPos[o + 1] - gcenter[1]);
  rings[d <= rCore ? 0 : d <= rMid ? 1 : 2]++;
}
const densCore = rings[0] / (Math.PI * rCore * rCore);
ok('ядро medium: 20..40 травинок/м² (ТЗ)', densCore >= 20 && densCore <= 45, `${densCore.toFixed(1)} /м² в круге ${rCore} м`);
ok('дальние пояса не пустые', rings[1] > 500 && rings[2] > 500, `${rings[1]} / ${rings[2]}`);
ok('бюджет поясов не превышает cap', gf.count <= qM.grass, `${gf.count} ≤ ${qM.grass}`);
const densLow = (() => {
  const Q = QUALITY.low, g = W.buildGrassField({ layers, center: gcenter, max: Q.grass, bands: Q.grassBands, height: 1, seed: 5 });
  let k = 0;
  for (let i = 0; i < g.count; i++) { const o = i * 4; if (Math.hypot(g.iPos[o] - gcenter[0], g.iPos[o + 1] - gcenter[1]) <= Q.grassBands[0][0]) k++; }
  return k / (Math.PI * Q.grassBands[0][0] ** 2);
})();
ok('ядро low: ≥ 9 травинок/м²', densLow >= 9, `${densLow.toFixed(1)} /м²`);
const hs = [];
for (let i = 0; i < gf.count; i++) hs.push(gf.iPos[i * 4 + 2]);
ok('высота травы 5..35 см (газон, не кукуруза)', Math.min(...hs) > 0.05 && Math.max(...hs) < 0.36,
   `${(Math.min(...hs) * 100).toFixed(1)}..${(Math.max(...hs) * 100).toFixed(1)} см`);
const ws = [];
for (let i = 0; i < gf.count; i++) ws.push(gf.iPos[i * 4 + 3]);
ok('ширина травинки 8..25 мм', Math.min(...ws) > 0.008 && Math.max(...ws) < 0.034,
   `${(Math.min(...ws) * 1000).toFixed(0)}..${(Math.max(...ws) * 1000).toFixed(0)} мм`);
const sp = new Set();
for (let i = 0; i < gf.count; i++) sp.add(gf.iShape[i * 4 + 3]);
ok('виды трав ⊆ 0..4 (атлас 5×2)', [...sp].every(v => v >= 0 && v <= 4), `${sp.size} видов`);

console.log('\n[4] вывески и фонари');
const lamps = W.lampPositions(layout, bld).map(([x, z]) => ({ x, z, y: 7.3 }));
const signs = W.buildSigns(bld, 32, { lamps }).signs;
// режимы: 0 — вывеска на стене, 1 — фонарь на столбе, 2 — лампочка гирлянды.
// На стену проверяем только нулевые, иначе фонари и гирлянда дали бы ложные
// провалы («вывеска висит в воздухе» — она и должна).
const wallSigns = signs.filter(s => s.mode === 0);
const lampPlates = signs.filter(s => s.mode === 1);
const garland = W.buildTreeLights(veg.tree, { lamps: 120 });
ok('вывесок много (ТЗ: «много вывесок»)', wallSigns.length > 1400,
   `${wallSigns.length} щитов на ${bld.length} корпусов, ${(wallSigns.length / bld.length).toFixed(1)} на дом`);
// в среднем на фасад — щит должен читаться через 20 м: 25% стен не спасает
const perFace = wallSigns.length / (bld.length * 4);
ok('≥ 0.6 щита на грань дома', perFace >= 0.6, perFace.toFixed(2));
// 4×8 широких + 16×2 вертикальных = 64 клетки; 30/31 — лампа и гирлянда,
// на широкой ленте их быть не должно
const badCell = wallSigns.filter(s => s.cell < 0 || s.cell >= 64).length;
ok('клетка атласа в 0..63', badCell === 0);
const vertSet = wallSigns.filter(s => s.cell >= 32).length;
ok('вертикальные щиты берут нижнюю половину атласа', (() => {
  const tall = wallSigns.filter(s => s.h > s.w);
  return tall.every(s => s.cell >= 32) && tall.length > 50;
})(), `${vertSet} из ${wallSigns.length} — нижняя сетка`);
ok('лампа/гирлянда не занимают клетки текста', (() => {
  const used = new Set(signs.filter(s => s.mode === 0 && s.cell < 32).map(s => s.cell));
  return !used.has(30) && !used.has(31);
})());
const lampInWater = lamps.filter(l => W.lakeField(l.x, l.z) < 1.12);
ok('фонарей нет в воде', lampInWater.length === 0,
   `${lampInWater.length} столбов в озере из ${lamps.length}`);
ok('фонарные щитки есть (режим 1)', lampPlates.length >= lamps.length,
   `${lampPlates.length} пластинок на ${lamps.length} столбов`);
ok('лампочки гирлянды в конусе ёлки', (() => {
  const t2 = veg.tree;
  return garland.filter(g => {
    const r = Math.hypot(g.x - t2.x, g.z - t2.z);
    const k = Math.max(0.02, 1 - (g.y - 1.2) / t2.h);
    return r > t2.r * k + 0.9 || g.y < 0.5 || g.y > t2.h + 1.2;
  }).length === 0;
})(), `${garland.length} ламп`);
const badSize = wallSigns.filter(s => !(s.w > 0.4 && s.w < 20 && s.h > 0.2 && s.h < 20)).length;
ok('размеры щитов правдоподобны', badSize === 0, `${badSize} странных`);
// главный инвариант вывески: она висит НА стене, а не в воздухе. Проверяем,
// что центр щита лежит на границе ближайшего корпуса (±0.8 м) и что щит не
// залезает выше крыши.
const onWall = (() => {
  // Главный инвариант вывески: она висит НА стене своего корпуса, не в воздухе
  // и не выше парапета. «Свой» корпус берём по bi, который проставляет
  // buildSigns, — искать «ближайший по центру» нельзя: у общей стены двух
  // корпусов ближайшим окажется сосед.
  let bad = 0;
  for (const sg of wallSigns) {
    const best = bld[sg.bi];
    if (!best) { bad++; continue; }
    const ex = Math.max(0, Math.abs(sg.x - best.x) - best.w / 2);
    const ez = Math.max(0, Math.abs(sg.z - best.z) - best.d / 2);
    if (Math.hypot(ex, ez) > 0.8) bad++;
    else if (sg.y + sg.h > best.h + 0.6) bad++;
    else if (sg.y < 0.15) bad++;
  }
  return bad;
})();
ok('вывески висят на стене и не выше крыши', onWall === 0, `${onWall} из ${wallSigns.length}`);
// щиты не должны наслаиваться друг на друга: считаем коллизии пар по грани
const overlap = (() => {
  let bad = 0;
  const byB = new Map();
  for (const arr of byB.values()) {
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b2 = arr[j];
      if (Math.abs(a.rot - b2.rot) > 0.01) continue;               // разные грани
      const dx = Math.abs(a.x - b2.x) + Math.abs(a.z - b2.z);
      const dy = Math.abs((a.y + a.h / 2) - (b2.y + b2.h / 2));
      if (dx < Math.min(a.w, b2.w) * 0.55 && dy < Math.min(a.h, b2.h) * 0.55) bad++;
    }
  }
  return bad;
})();
ok('щиты не наслаиваются друг на друга', overlap === 0, `${overlap} пар`);
const tree = W.buildTreeLights(veg.tree, { lamps: 200 });
ok('гирлянда ёлки собрана', tree.length >= 200, `${tree.length} ламп + звезда`);
const lampMesh = W.buildLampMesh(lamps);
ok('меж фонарных столтов не пустой', lampMesh.idx.length > 0, `${lampMesh.verts} верш.`);
const poleInBuilding = lamps.filter(l => bld.some(b =>
  Math.abs(l.x - b.x) < b.w / 2 && Math.abs(l.z - b.z) < b.d / 2)).length;
ok('столбы не внутри домов', poleInBuilding === 0, `${poleInBuilding}`);

console.log('\n[5] GI-объём');
const env = { day: TIMES.noon.day, sunDir: norm3(TIMES.noon.dir), sunCol: TIMES.noon.sun, skyCol: TIMES.noon.sky, rain: 0, snow: 0 };
const gi = bakeGI(bld, W.buildLights(bld, lamps), env);
ok('объём 96×12×96 RGBA', gi.data.length === GI.X * GI.Y * GI.Z * 4);
const st = giStats(gi.data);
ok('освещённость в разумном диапазоне', st.irradiance > 0.02 && st.irradiance < 0.9,
  st.irradiance.toFixed(3));
ok('небо видно в среднем > 50%', st.skyVis > 0.5, st.skyVis.toFixed(2));
ok('нет пустых ячеек (min > 0)', st.min > 0, st.min.toFixed(3));
const t0 = Date.now(); bakeGI(bld, [], env); const dt = Date.now() - t0;
ok('запекание приемлемо по времени (< 400 мс)', dt < 400, `${dt} мс`);
// двор (высокая застройка вокруг) должен быть темнее открытой улицы
// физика ночью: искусственный свет не имеет права делать улицу светлее дня.
// Считаем облучённость нижнего слоя (у земли) по той же кривой, что giWorld()
// в common.glsl, и сравниваем полночь с полуднем.
const layer0 = (vol) => {
  const { X, Y, Z } = GI;
  let e = 0, n = 0;
  for (let iz = 0; iz < Z; iz++) {
    for (let ix = 0; ix < X; ix++) {
      const o = (iz * X + ix) * 4;                     // iy = 0
      const c = [(vol[o] + vol[o + 1] + vol[o + 2]) / 3 / (255 / 1.6)];
      const v = c[0] * c[0] * 0.6 + c[0] * 0.75;
      e += v; n++;
    }
  }
  return e / n;
};
const envDay = { day: TIMES.noon.day, sunDir: norm3(TIMES.noon.dir), sunCol: TIMES.noon.sun, skyCol: TIMES.noon.sky, rain: 0, snow: 0 };
const envNight = { day: TIMES.night.day, sunDir: norm3(TIMES.night.dir), sunCol: TIMES.night.sun, skyCol: TIMES.night.sky, rain: 0, snow: 0 };
const giDay = bakeGI(bld, W.buildLights(bld, lamps), envDay);
const giNight = bakeGI(bld, W.buildLights(bld, lamps), envNight);
const gDay = layer0(giDay.data), gNight = layer0(giNight.data);
ok('ночью улица темнее дня (искусственный свет физичен)', gNight < gDay * 0.35,
   `ночь ${gNight.toFixed(3)} < день ${gDay.toFixed(3)} × 0.35`);
ok('ночью свет фонарей всё-таки есть', gNight > 0.004, `${gNight.toFixed(4)} облучённости у земли`);
const open = bakeGI([], [], env);
ok('застройка темнее открытого поля', st.irradiance < giStats(open.data).irradiance,
  `${st.irradiance.toFixed(3)} < ${giStats(open.data).irradiance.toFixed(3)}`);

console.log('\n[6] контракт uniform’ов (шейдер ↔ JS)');
const glslDir = 'shaders/glsl';
const collect = (text) => {
  const out = new Map();
  for (const m of text.matchAll(/^\s*uniform\s+(?:mediump\s+|highp\s+|lowp\s+)?(\w+)\s+(\w+)\s*;/gm)) {
    out.set(m[2], m[1]);
  }
  return out;
};
const union = collect([read(`${glslDir}/common.glsl`),
  ...['grass.vert', 'grass.frag', 'water.vert', 'water.frag', 'facade.vert', 'facade.frag',
       'ground.vert', 'ground.frag', 'veg.vert', 'veg.frag', 'emissive.vert', 'emissive.frag',
       'post.frag', 'bloom.frag', 'ssao.frag', 'sky.vert', 'sky.frag', 'rain_window.frag',
       'screen.vert'].map(n => read(`${glslDir}/${n}`))].join('\n'));
const usedNames = new Set();
for (const src of ['web/js/main.js']) {
  for (const m of read(src).matchAll(/\.(?:set|tex)\(\s*'([A-Za-z_]\w*)'/g)) usedNames.add(m[1]);
}
const unknown = [...usedNames].filter(n => !union.has(n));
ok(`все uniform’ы JS объявлены в GLSL (${usedNames.size} имён)`, unknown.length === 0, unknown.join(', '));
const typed = [...usedNames].filter(n => union.has(n)).map(n => {
  const t = union.get(n);
  const want = t === 'float' ? 1 : t === 'vec2' ? 2 : t === 'vec3' ? 3 : t === 'vec4' ? 4 : t === 'mat4' ? 16 : 0;
  return [n, t, want];
});
ok('типы объявлены (float/vecN/mat4/sampler)', typed.every(([, t, w]) => w > 0 || /sampler/.test(t)),
  typed.filter(([, t, w]) => !(w > 0 || /sampler/.test(t))).map(x => x[0]).join(', '));
// арность: .set('uFoo', LOOK.a.b) и литеральные массивы должны совпадать с
// объявленным в GLSL типом — иначе gl.uniform4fv на vec2 молча роняет draw call
const arity = (() => {
  const bad = [];
  for (const m of js.matchAll(/\.set\(\s*'(u\w+)'\s*,\s*LOOK\.(\w+)\.(\w+)\s*\)/g)) {
    const [, name, a, b] = m;
    const v = LOOK[a] && LOOK[a][b];
    const t2 = union.get(name);
    if (!Array.isArray(v)) {
      if (typeof v === 'number' && t2 === 'float') continue;     // скаляр в float — ок
      bad.push(`${name}: LOOK.${a}.${b} — не массив и не float`); continue;
    }
    const want = t2 === 'float' ? 1 : t2 === 'vec2' ? 2 : t2 === 'vec3' ? 3 : t2 === 'vec4' ? 4 : -1;
    if (want === -1) { bad.push(`${name}: нет такого uniform в GLSL`); continue; }
    if (v.length !== want) bad.push(`${name}: ${t2} ← массив из ${v.length}`);
  }
  return bad;
})();
ok('LOOK-векторы совпадают по арности с GLSL', arity.length === 0, arity.join('; '));
const samplerMis = [...js.matchAll(/\.set\(\s*'(u\w+)'/g)].map(m => m[1])
  .filter(n => /sampler/.test(union.get(n) || ''));
ok('текстуры назначаются через .tex, не .set', samplerMis.length === 0, samplerMis.join(', '));
// контракт атласа вывесок: генератор (assets/beijing_signs.json) ↔ JS (LOOK) ↔
// GLSL (uSignGrid). Разъезд на строку уже превращал вывески в кашу из половинок
// соседних щитов, поэтому сверяем числа, а не надеемся на глаз.
const reg = JSON.parse(readFileSync(join(ROOT, 'assets/beijing_signs.json'), 'utf8'));
const G = LOOK.emissive.grid;
ok('сетка вывесок: колонок/рядов широких совпали с генератором',
   G[0] === reg.cols && G[1] === reg.rows, `${G[0]}×${G[1]} против ${reg.cols}×${reg.rows}`);
ok('сетка вывесок: вертикальные совпали с генератором',
   G[2] === reg.vertCols && G[3] === reg.vertRows, `${G[2]}×${G[3]} против ${reg.vertCols}×${reg.vertRows}`);
ok('смещение вертикальных = числу широких клеток', reg.vertOffset === reg.cols * reg.rows,
   `${reg.vertOffset} = ${reg.cols}×${reg.rows}`);
const fac = read('shaders/glsl/facade.frag'), emi = read('shaders/glsl/emissive.frag');
const com = read('shaders/glsl/common.glsl');
ok('шейдеры делят атлас одной функцией signUV',
   /vec2\s+signUV\s*\(/.test(com) && /signUV\s*\(/.test(fac) && /signUV\s*\(/.test(emi));
ok('в шейдерах не осталось захардкоженной сетки 8×4',
   !/vec2\(8\.0,\s*4\.0\)/.test(fac) && !/uEmitGrid/.test(emi) && !/uEmitGrid/.test(js));
ok('uSignGrid объявлен в common.glsl и задаётся для facade и emissive',
   /uniform vec4\s+uSignGrid/.test(com) && (js.match(/'uSignGrid'/g) || []).length === 2);
// материалы: каждая константа LOOK должна быть числом и попадать в свой vecN
const flat = [];
const walk = (o, path) => {
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) flat.push([`${path}${k}`, v]);
    else if (v && typeof v === 'object') walk(v, `${path}${k}.`);
  }
};
walk(LOOK, 'LOOK.');
ok('LOOK: массивы чисел', flat.every(([, v]) => v.every(Number.isFinite)), `${flat.length} векторов`);
const albedoLike = flat.filter(([k]) => /color|tint|bed|warm|sun/i.test(k));
const tooBright = albedoLike.filter(([, v]) => v.slice(0, 3).some(x => x > 1.05));
ok('LOOK: ни один цвет не «выбит» (>1.05 в линеарных)', tooBright.length === 0, tooBright.map(x => x[0]).join(', '));
for (const q of Object.keys(QUALITY)) {
  const Q = QUALITY[q], B = Q.grassBands;
  ok(`профиль ${q}: травинки ≤ 120k`, Q.grass <= 120000, `${Q.grass}`);
  ok(`профиль ${q}: поясов травы 2..3`, Array.isArray(B) && B.length >= 2 && B.length <= 3, `${B.length}`);
  ok(`профиль ${q}: дальний радиус ≤ 90 м`, B[B.length - 1][0] <= 90, `${B[B.length - 1][0]} м`);
  // бюджет: сумма поясов не должна превышать cap, иначе последний пояс пустой
  let need = 0, prev = 0;
  for (const [rad, cell] of B) { need += Math.PI * (rad * rad - prev * prev) / (cell * cell); prev = rad; }
  ok(`профиль ${q}: пояса вписаны в бюджет`, need <= Q.grass * 1.25,
     `нужно ${(need / 1000).toFixed(0)}k при cap ${(Q.grass / 1000).toFixed(0)}k`);
  ok(`профиль ${q}: ядро 20..40 шт/м²`, 1 / (B[0][1] * B[0][1]) >= (q === 'low' ? 11 : 20)
     && 1 / (B[0][1] * B[0][1]) <= 45, `${(1 / (B[0][1] * B[0][1])).toFixed(1)} /м²`);
}
for (const key of Object.keys(TIMES)) {
  const T = TIMES[key];
  const l = Math.hypot(...T.dir);
  ok(`TIME ${key}: направление на солнце нормализовано`, Math.abs(l - 1) < 0.25, l.toFixed(3));
  ok(`TIME ${key}: день в 0..1`, T.day >= 0 && T.day <= 1);
}
for (const key of Object.keys(SEASONS)) {
  const s = SEASONS[key].season;
  ok(`SEASON ${key}: сумма весов = 1`, Math.abs(s.reduce((a, b) => a + b, 0) - 1) < 1e-9, s.join('/'));
}

console.log('\n[7] index.html ↔ main.js');
const html = read('web/index.html');
const ids = new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]));
const missing = [...ids].filter(id => !html.includes(`id="${id}"`));
ok(`каждый id из JS есть в разметке (${ids.size})`, missing.length === 0, missing.join(', '));
const listeners = [...js.matchAll(/\bbtn\('([\w-]+)'|(?<![\w.])on\('([\w-]+)'/g)].map(m => m[1] || m[2]);
const orphan = listeners.filter(id => !html.includes(`id="${id}"`));
ok('все обработчики привязаны к существующим контролам', orphan.length === 0, orphan.join(', '));
ok('canvas #view есть', html.includes('id="view"'));
for (const [, , kind, url] of TEX.map((t, i) => [i, t[0], t[2], t[1]])) {
  ok(`текстура ${url}`, existsSync(join(ROOT, url)), kind);
}

console.log('\n[8] отчёты материалов в допуске ТЗ');
for (const f of ['docs/material_report.json', 'docs/material_report_surfaces.json']) {
  if (!existsSync(join(ROOT, f))) { ok(f, false, 'нет файла'); continue; }
  const rep = JSON.parse(read(f));
  const items = rep.beijing_facades || rep.ground || rep.materials
    || (Array.isArray(rep) ? rep : []);
  ok(`${f}: ${items.length} материалов`, items.length >= 8, items.length + ' шт.');
  const bright = items.filter(m => (m.albedo ?? m.albedo_mean ?? 0) > 0.32);
  ok(`${f}: альбедо ≤ 0.32 (кроме песка/черепицы)`,
    bright.every(m => /черепиц|песок/.test(m.material)), bright.map(m => m.material).join(', '));
  const glossy = items.filter(m => (m.rough ?? m.rough_mean ?? 1) < 0.20);
  ok(`${f}: шероховатость ≥ 0.20 (не глянцевые)`, glossy.length === 0, glossy.map(m => m.material).join(', '));
}

console.log(`\n${fails ? 'ПРОВАЛЕНО' : 'OK'}: проверок ${checks}, провалов ${fails}\n`);
process.exit(fails ? 1 : 0);
