// world.js — генератор квартала Пекина для веб-сборки (шаг 5.33).
//
// Один и тот же код описывает мир для отрисовки и для снимков: дамп сцены
// делает tools/dump_scene.js, эталонный рендер — tools/shader_preview.py.
// Поэтому «что на превью» и «что в игре» — не два разных мира.
//
// Устройство:
//  • сетка улиц 1536 × 1536 м (совпадает с GI_GRID из common.glsl), кварталы
//    96 × 112 м, ширина главной улицы 60 м, второстепенной 26 м;
//  • дома — коробки со «стеновыми» гранями: фасад несёт тип материала, высоту
//    этажа, ширину окна и семя; вывеска — отдельный instanced-щит;
//  • пятачки: парк бамбука, набережная с пальмами, озеро 340 × 250 м,
//    площадь с ёлкой, хутун с серым кирпичом, деловой квартал со стеклом;
//  • layer-карта 512² задаёт покрытие, плотность травы, впадины под лужи, износ;
//    трава сеется по ней, поэтому «трава везде» — это свойство карты, а не
//    отдельный список объектов.

'use strict';

export const WORLD = 1536;            // метров на всю сцену (как GI_WORLD в шейдерах)
export const LAYERS = 512;            // разрешение layer-карты

// ------------------------------------------------------------------- ПСЧ
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Шум, совпадающий с GLSL hash12/vnoise2 по структуре (не побитово: важно
// поведение, а не идентичность чисел — карта генерируется один раз и здесь, и
// в превью, см. tools/shader_preview.py).
function hash2(x, y) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * ux) * (1 - uy) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
}
export function fbm2(x, y, oct = 3) {
  let s = 0, amp = 0.5, fx = x, fy = y;
  for (let i = 0; i < oct; i++) {
    s += amp * (noise2(fx, fy) * 2 - 1);
    const nx = 1.6 * fx + 1.2 * fy;
    fy = -1.2 * fx + 1.6 * fy;
    fx = nx;
    amp *= 0.5;
  }
  return s;
}

// --------------------------------------------------------------- планировка
export const DISTRICTS = {
  axis: { name: 'Ось Тяньаньмэнь', facade: 4, roof: 7, hMin: 9, hMax: 22, sign: 0.55 },
  hutong: { name: 'Хутуны', facade: 3, roof: 3, hMin: 5.2, hMax: 9.5, sign: 0.85 },
  office: { name: 'Деловой квартал', facade: 5, roof: 3, hMin: 30, hMax: 96, sign: 0.35 },
  market: { name: 'Рынок и магазины', facade: 6, roof: 3, hMin: 8, hMax: 26, sign: 0.95 },
  panel: { name: 'Панельные дворы', facade: 0, roof: 3, hMin: 18, hMax: 33, sign: 0.4 },
  panel5: { name: 'Пятиэтажки', facade: 1, roof: 3, hMin: 15, hMax: 18, sign: 0.6 },
  brick: { name: 'Красный кирпич', facade: 2, roof: 3, hMin: 12, hMax: 24, sign: 0.7 },
};

// Озеро и парк — аналитические функции, они же используются для depth-карты.
export function lakeField(x, z) {
  // Центр (250, -180), полусоси 170 × 118, берег изогнут шумом.
  const dx = (x - 250) / 170, dz = (z + 180) / 118;
  const r = Math.hypot(dx, dz) + 0.13 * fbm2(x * 0.011, z * 0.011, 3);
  return r;                                    // <1 — вода
}
export function bambooParkField(x, z) {
  const dx = (x + 430) / 210, dz = (z - 300) / 150;
  return Math.hypot(dx, dz) + 0.09 * fbm2(x * 0.02, z * 0.02, 2);
}

export function blockLayout(seed = 20261) {
  const rnd = mulberry32(seed);
  const blocks = [];
  const streetMain = 60, streetSide = 26;
  const bw = 96, bh = 112;
  const stepX = bw + streetSide, stepZ = bh + streetSide;
  const n = Math.floor(WORLD / stepX);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const cx = (ix - n / 2 + 0.5) * stepX;
      const cz = (iz - n / 2 + 0.5) * stepZ;
      // ось проспекта: три ряда вдоль z = 0 — имперский квартал
      let d = 'hutong';
      if (Math.abs(cz) < streetMain * 1.2) d = 'axis';
      else if (cx > 120 && Math.abs(cz) < 380) d = 'office';
      else if (cx < -120 && cz > 60) d = 'market';
      else if (ix % 3 === 0 && iz % 3 === 0) d = 'panel';
      else if (iz % 3 === 1) d = 'panel5';
      else if (ix % 4 === 2) d = 'brick';
      blocks.push({ cx, cz, bw, bh, district: d, seed: (rnd() * 1e6) | 0 });
    }
  }
  return { blocks, streetMain, streetSide, stepX, stepZ, n };
}

// ------------------------------------------------------ layer-карта покрытий
// r — материал (0..7 → 0..1), g — плотность травы, b — впадина (лужи), a — износ.
export function buildLayers(lake, bamboo, layout) {
  const size = LAYERS;
  const data = new Uint8Array(size * size * 4);
  const { blocks, streetMain, streetSide, stepX, stepZ } = layout;
  const half = WORLD / 2;
  for (let py = 0; py < size; py++) {
    const z = (py / (size - 1) - 0.5) * WORLD;
    for (let px = 0; px < size; px++) {
      const x = (px / (size - 1) - 0.5) * WORLD;
      let mat = 2, turf = 0.62, basin = 0.0, wear = 0.2;
      // улицы: асфальт по осям кварталов
      const gx = Math.abs(((x + half) % stepX) - streetSide / 2);
      const gz = Math.abs(((z + half) % stepZ) - streetSide / 2);
      const onStreet = gx < streetSide / 2 || (Math.abs(z) < streetMain / 2);
      const onStreetZ = gz < streetSide / 2 || (Math.abs(x) < streetMain / 2);
      if (onStreet || onStreetZ) {
        mat = 0; turf = 0.03; wear = 0.45; basin = 0.15 + 0.25 * noise2(x * 0.02, z * 0.02);
        // 6 м у борта — парковочная полоса: тот же асфальт, но старый, латаный,
        // с масляными пятнами (мат 6, шероховатость 0.58 — он темнее и «жирнее»).
        // Без этого улица выглядела залитой одним катком.
        const curb = Math.min(gx, gz);
        if (curb > streetSide / 2 - 6.5) { mat = 6; wear = 0.30; basin += 0.10; }
      }
      // тротуар вдоль улиц
      const nearStreet = (gx < streetSide / 2 + 4.5) || (gz < streetSide / 2 + 4.5) || Math.abs(z) < streetMain / 2 + 5;
      if (nearStreet && !(onStreet || onStreetZ)) { mat = 1; turf = 0.05; wear = 0.3; }
      // вода и набережная
      const L = lake(x, z);
      if (L < 1.0) { mat = 5; turf = 0.0; basin = 1.0; }
      else if (L < 1.12) { mat = 5; turf = 0.18; }
      // «мокрый берег»: ил с полусохшей травой выше уреза. Без этой полосы
      // вода обрывается в чистый газон — выглядит как нарисованный круг.
      else if (L < 1.30) { mat = 4; turf = 0.34 + 0.3 * noise2(x * 0.09, z * 0.09); basin = 0.12; }
      // парк бамбука — дёрн с высокой плотностью
      const B = bamboo(x, z);
      if (B < 1.0) {
        // в бамбуковнике под ногами — утоптанная земля с прожилками дерна,
        // а не «газон как в сквере»: чахлый покров под сенью стеблей
        const trampled = noise2(x * 0.055, z * 0.055) > 0.56;
        mat = trampled ? 4 : 2;
        turf = trampled ? 0.30 : 0.95;
        wear = 0.05;
      }
      // дворы: газон с пятнами, дорожки
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (Math.abs(x - b.cx) < b.bw / 2 && Math.abs(z - b.cz) < b.bh / 2) {
          // дома занимают периметр, в середине — двор
          const inHouse = Math.abs(Math.abs(x - b.cx) - b.bw / 2 + 12) < 14 ||
                          Math.abs(Math.abs(z - b.cz) - b.bh / 2 + 12) < 14;
          if (inHouse) { mat = 3; turf = 0.02; wear = 0.4; }
          else {
            const path = Math.abs(((x - b.cx) * 0.07 + (z - b.cz) * 0.03) % 1 - 0.5) < 0.09;
            mat = path ? 1 : 2;
            turf = path ? 0.05 : 0.7 + 0.25 * fbm2(x * 0.05, z * 0.05, 3);
            wear = 0.12;
          }
          break;
        }
      }
      // площади перед воротами — плитка, лужайки вдоль проспекта
      if (Math.abs(z) < streetMain * 1.2 && Math.abs(x) < 220) { mat = 1; turf = 0.06; }
      const i4 = (py * size + px) * 4;
      data[i4] = Math.max(0, Math.min(255, Math.round((mat / 7) * 255)));
      data[i4 + 1] = Math.max(0, Math.min(255, Math.round(turf * 255)));
      data[i4 + 2] = Math.max(0, Math.min(255, Math.round(Math.max(basin + 0.25 * fbm2(x * 0.02, z * 0.02, 2), 0) * 255)));
      data[i4 + 3] = Math.round(wear * 255);
    }
  }
  return data;
}

// --------------------------------------------------------------- глубина воды
export function buildWaterDepth(size, lake) {
  const data = new Uint8Array(size * size * 4);
  const box = waterBox(lake);
  for (let py = 0; py < size; py++) {
    const z = box.minZ + (py / (size - 1)) * (box.maxZ - box.minZ);
    for (let px = 0; px < size; px++) {
      const x = box.minX + (px / (size - 1)) * (box.maxX - box.minX);
      const L = lake(x, z);
      let depth = Math.max(0, (1.0 - L)) * 9.2 * (1 + 0.35 * fbm2(x * 0.02, z * 0.02, 3));
      // протока
      const ch = Math.exp(-Math.pow((z + 520 + 90 * Math.sin(x * 0.004)) / 34, 2));
      depth = Math.max(depth, ch * 3.0);
      depth = Math.min(depth, 11);
      const gsz = depth > 0.02 ? 1 : 0;
      const fx = Math.max(-1, Math.min(1, -(lake(x + 2, z) - lake(x - 2, z)) * 18));
      const fz = Math.max(-1, Math.min(1, (lake(x, z + 2) - lake(x, z - 2)) * 18));
      const i = (py * size + px) * 4;
      data[i] = Math.round(Math.min(1, depth / 11) * 255);
      data[i + 1] = Math.round((0.5 + 0.5 * fx) * 255);
      data[i + 2] = Math.round((0.5 + 0.5 * fz) * 255);
      data[i + 3] = gsz ? 255 : 0;
    }
  }
  return { data, box };
}

export function waterBox(lake) {
  // Границы воды с запасом под протоку: озеро 340×250 + хвост.
  return { minX: 250 - 205, maxX: 250 + 205, minZ: -180 - 150, maxZ: -180 + 210 };
}

// ------------------------------------------------------------------- дома
// Корпус ставим только если ВСЁ его пятно (четыре угла, а не только центр) не
// залезает в воду и в парк: иначе половина дома висит над озером.
function plotFree(cx, cz, w, d) {
  const ax = w / 2, az = d / 2;
  for (const sx of [-ax, 0, ax]) {
    for (const sz of [-az, 0, az]) {
      const x = cx + sx, z = cz + sz;
      if (lakeField(x, z) < 1.12 || bambooParkField(x, z) < 1.02) return false;
    }
  }
  return true;
}

export function buildBuildings(layout, opts = {}) {
  const { blocks } = layout;
  const out = [];
  for (const b of blocks) {
    // красная линия мира: пятно застройки вместе с тротуаром не должно вылезать
    // за 1536×1536 — за краем земля кончается, и дом повисает в небе
    if (Math.abs(b.cx) + b.bw / 2 + 5 > WORLD / 2 || Math.abs(b.cz) + b.bh / 2 + 5 > WORLD / 2) continue;
    const rnd = mulberry32(b.seed);
    const D = DISTRICTS[b.district];
    const alongX = Math.abs(b.cx) < 260 && Math.abs(b.cz) < 90;   // площадь: не застраиваем
    if (alongX) {
      // по кромкам площади — низкие павильоны и ворота
      const side = b.cz < 0 ? -1 : 1;
      const gate = mk(b.cx, b.cz + side * (b.bh / 2 - 8), b.bw * 0.7, 16, 12 + rnd() * 6, D, b.seed, opts, b);
      if (gate) out.push(gate);
      continue;
    }
    const per = 3 + ((rnd() * 3) | 0);
    for (let i = 0; i < per; i++) {
      const t = (i + 0.5) / per;
      const w = (b.bw - 26) * (0.28 + 0.4 * rnd());
      const d = (b.bh - 26) * (0.3 + 0.35 * rnd());
      const ang = t * Math.PI * 2;
      const cx = b.cx + Math.cos(ang) * (b.bw / 2 - 16);
      const cz = b.cz + Math.sin(ang) * (b.bh / 2 - 16);

      const h = D.hMin + (D.hMax - D.hMin) * Math.pow(rnd(), b.district === 'office' ? 1.6 : 0.8);
      const bb = mk(cx, cz, w, d, h, D, (b.seed + i * 977) | 0, opts, b);
      if (bb) out.push(bb);
    }
    // иногда — внутренний корпус
    if (rnd() < 0.35) {
      const h = D.hMin + (D.hMax - D.hMin) * 0.45 * rnd();
      const bb = mk(b.cx + (rnd() - 0.5) * 18, b.cz + (rnd() - 0.5) * 18, 18 + rnd() * 14, 16 + rnd() * 12, h, D, (b.seed + 31) | 0, opts, b);
      if (bb) out.push(bb);
    }
  }
  return out;
}

function mk(cx, cz, w, d, h, D, seed, opts, plot) {
  const rnd = mulberry32(seed);
  // Красная линия: 4.5 м тротуара с каждой стороны пятна застройки. Раньше
  // корпус мог «вырасти» за пятно (Math.max(10, w) добавлял метра три), и тогда
  // меш, который buildFacadeMesh режет по пятну, расходился с метаданными:
  // вывески и фонарные столбы вставали внутри стены.
  if (plot) {
    const pad = 4.5;
    w = Math.min(w, plot.bw - 2 * pad);
    d = Math.min(d, plot.bh - 2 * pad);
    const ax = Math.max(0, plot.bw / 2 - pad - w / 2);
    const az = Math.max(0, plot.bh / 2 - pad - d / 2);
    const ox = Math.max(-ax, Math.min(ax, cx - plot.cx));
    const oz = Math.max(-az, Math.min(az, cz - plot.cz));
    cx = plot.cx + ox; cz = plot.cz + oz;
  }
  // вода и парк проверяются уже после всех поправок размера — иначе «ноль»
  // превращается в десяток метров и половина корпуса висит над озерам
  if (!plotFree(cx, cz, w, d)) return null;
  const floors = Math.max(1, Math.round(h / (h < 12 ? 3.6 : 3.05)));
  const floorH = h / floors;
  w = Math.max(10, w); d = Math.max(9, d);
  if (plot && !plotFree(cx, cz, w, d)) return null;
  return {
    x: cx, z: cz, w, d, h,
    facade: rnd() < 0.22 ? (D.facade === 4 ? 3 : D.facade) : D.facade,
    floors, floorH,
    winW: 1.6 + 2.4 * (h > 26 ? 1 : 0.7) * (0.7 + 0.6 * rnd()),
    lit: 0.25 + 0.5 * rnd(),
    seed,
    signChance: D.sign,
    signCell: (rnd() * (opts.signCount || 32)) | 0,
    signFloor: rnd() < 0.5 ? 0 : 1 + ((rnd() * 3) | 0),
    cornice: rnd() < 0.5,
    roofUnits: 1 + ((rnd() * 4) | 0),
  };
}

// mesh: pos(3) nrm(3) uv(2) wall(4) sign(4) — как в facade.vert.
// Стена = 4 вершины по ребру прямоугольника, UV в метрах: u вдоль стены, v вверх.
// Царга (высота этажа) и ширина окна идут в aWall, поэтому сетка окон в
// шейдере получается одинаковой на 5- и 27-этажном доме.
export function buildFacadeMesh(bld, opts = {}) {
  const pos = [], nrm = [], uv = [], wall = [], sign = [];
  const idx = [];
  let v = 0;
  const push = (x, y, z, nx, ny, nz, u, vv, w, s) => {
    pos.push(x, y, z); nrm.push(nx, ny, nz); uv.push(u, vv);
    wall.push(...w); sign.push(...s);
  };
  for (const b of bld) {
    const hw = b.w / 2, hd = b.d / 2;
    const c = [[b.x - hw, b.z - hd], [b.x + hw, b.z - hd], [b.x + hw, b.z + hd], [b.x - hw, b.z + hd]];
    const N = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0]];
    const signFace = b.signFloor === 0 ? 0 : (b.signFloor % 4);
    for (let f = 0; f < 4; f++) {
      const p0 = c[f], p1 = c[(f + 1) % 4];
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const n = N[f];
      const base = v;
      // (тип, шаг этажа, ширина окна, высота дома/100) — последнее поле
      // одновременно даёт шейдеру и «мелкий» вариант фактуры, и разнообразие
      // для хэша «кто сегодня не спит».
      const wallAttr = [b.facade, b.floorH, b.winW, b.h / 100];
      const withSign = b.signChance > 0.3 && f === signFace;
      // (клетка атласа, отметка низа щита, сдвиг по стене, признак)
      const signAttr = withSign
        ? [b.signCell, b.signFloor === 0 ? 4.2 : b.floorH * b.signFloor - 0.7,
           ((b.seed % 97) / 97), 1]
        : [-1, 0, 0.5, 0];
      // низ-стена: до 4.6 м — витрина (обработка в шейдере по высоте), поэтому
      // окна начинаются со второго этажа: uv.y смещаем на 0.35 м
      push(p0[0], 0, p0[1], n[0], n[1], n[2], 0, 0, wallAttr, signAttr);
      push(p1[0], 0, p1[1], n[0], n[1], n[2], len, 0, wallAttr, signAttr);
      push(p1[0], b.h, p1[1], n[0], n[1], n[2], len, b.h, wallAttr, signAttr);
      push(p0[0], b.h, p0[1], n[0], n[1], n[2], 0, b.h, wallAttr, signAttr);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      v += 4;
    }
    // крыша: плита + парапет 0.6 м + техblokи
    const rb = v;
    for (const p of c) push(p[0], b.h, p[1], 0, 1, 0, p[0] - b.x + hw, p[1] - b.z + hd, [3, b.floorH, b.winW, 0.5], [-1, 0, 1, 0]);
    idx.push(rb, rb + 2, rb + 1, rb, rb + 3, rb + 2);
    v += 4;
    if (opts.parapet !== false) {
      for (let f = 0; f < 4; f++) {
        const p0 = c[f], p1 = c[(f + 1) % 4];
        const n = N[f];
        const base = v;
        const wallAttr = [3, b.floorH, b.winW, 1.0];   // крыша: всегда «крупный» бетон
        push(p0[0], b.h, p0[1], n[0], n[1], n[2], 0, 0, wallAttr, [-1, 0, 1, 0]);
        push(p1[0], b.h, p1[1], n[0], n[1], n[2], 1, 0, wallAttr, [-1, 0, 1, 0]);
        push(p1[0], b.h + 0.75, p1[1], n[0], n[1], n[2], 1, 0.75, wallAttr, [-1, 0, 1, 0]);
        push(p0[0], b.h + 0.75, p0[1], n[0], n[1], n[2], 0, 0.75, wallAttr, [-1, 0, 1, 0]);
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        v += 4;
      }
    }
    // техblokи на крыше (лифтовые шахты, конденсаторы)
    const rnd = mulberry32(b.seed ^ 0x51ed);
    const units = Math.min(b.roofUnits, b.w > 26 ? 4 : 2);
    for (let i = 0; i < units; i++) {
      const ux = b.x + (rnd() - 0.5) * (b.w - 8), uz = b.z + (rnd() - 0.5) * (b.d - 8);
      const uh = 1.2 + 2.4 * rnd(), uw = 2.4 + 3.6 * rnd(), ud = 2.0 + 3.0 * rnd();
      const cc = [[ux - uw / 2, uz - ud / 2], [ux + uw / 2, uz - ud / 2], [ux + uw / 2, uz + ud / 2], [ux - uw / 2, uz + ud / 2]];
      for (let f = 0; f < 4; f++) {
        const p0 = cc[f], p1 = cc[(f + 1) % 4];
        const n = N[f];
        const base = v;
        const wa = [3, 2.2, 1.4, 1.0];
        push(p0[0], b.h, p0[1], n[0], n[1], n[2], 0, 0, wa, [-1, 0, 1, 0]);
        push(p1[0], b.h, p1[1], n[0], n[1], n[2], 2, 0, wa, [-1, 0, 1, 0]);
        push(p1[0], b.h + uh, p1[1], n[0], n[1], n[2], 2, uh, wa, [-1, 0, 1, 0]);
        push(p0[0], b.h + uh, p0[1], n[0], n[1], n[2], 0, uh, wa, [-1, 0, 1, 0]);
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        const rb = v;
        push(cc[0][0], b.h + uh, cc[0][1], 0, 1, 0, 0, 0, wa, [-1, 0, 1, 0]);
        push(cc[1][0], b.h + uh, cc[1][1], 0, 1, 0, 1, 0, wa, [-1, 0, 1, 0]);
        push(cc[2][0], b.h + uh, cc[2][1], 0, 1, 0, 1, 1, wa, [-1, 0, 1, 0]);
        push(cc[3][0], b.h + uh, cc[3][1], 0, 1, 0, 0, 1, wa, [-1, 0, 1, 0]);
        idx.push(rb, rb + 2, rb + 1, rb, rb + 3, rb + 2);
        v += 8;
      }
    }
  }
  return {
    pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv),
    wall: new Float32Array(wall), sign: new Float32Array(sign), idx: new Uint32Array(idx),
    verts: v, quads: v / 4,
  };
}

// --------------------------------------------------- новогодняя ёлка: гирлянда
// и звезда. Лампы — те же instanced-щиты, что и вывески (mode 2), поэтому
// для них не нужен отдельный проход и отдельный шейдер.
export function buildTreeLights(tree, opts = {}) {
  const out = [];
  const rnd = mulberry32(0x1225);
  const turns = opts.turns || 4.5;
  const lamps = opts.lamps || 190;
  const top = tree.layers.length ? tree.layers.length : 1;
  for (let i = 0; i < lamps; i++) {
    const t = i / (lamps - 1);
    const y = 1.2 + t * (tree.height - 1.6);
    const ang = t * Math.PI * 2 * turns + rnd() * 0.25;
    const r = Math.max(0.4, (1 - t) * 5.4 * (0.85 + 0.2 * rnd()));
    out.push({
      x: tree.x + Math.cos(ang) * r, z: tree.z + Math.sin(ang) * r, y,
      w: 0.22, h: 0.3, rot: ang + Math.PI / 2, cell: 31, mode: 2,
      bright: 1.0 + rnd() * 0.6, phase: t, tilt: 0,
    });
  }
  // верхушка-звезда: четыре щита крестом, чтобы было видно со всех сторон
  for (let k = 0; k < 4; k++) {
    out.push({
      x: tree.x, z: tree.z, y: tree.height + 0.9, w: 1.5, h: 1.5,
      rot: k * Math.PI / 4, cell: 30, mode: 2, bright: 2.4, phase: rnd(), tilt: 0,
    });
  }
  return out;
}

// ------------------------------------------------------------- фонарные столбы
// Столб и консоль входят в mesh фасадов типом 1 (серая панель, альбедо 0.16,
// шероховатость 0.8): одна геометрия, один проход. Тип 5 (офисное стекло,
// альбедо 0.022) брать нельзя — столбы превращались в чёрные лакированные
// трубы, которые на снимке выглядели как дыры в сцене. Огни — instanced-щиты
// (mode 1) той же программы, что и вывески.
export function buildLampMesh(lamps) {
  const pos = [], nrm = [], uv = [], wall = [], sign = [];
  const idx = [];
  let v = 0;
  const box = (cx, cy, cz, sx, sy, sz, type) => {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const c = [[cx - hx, cz - hz], [cx + hx, cz - hz], [cx + hx, cz + hz], [cx - hx, cz + hz]];
    const N = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0]];
    const wa = [type, sy, 1.0, 1.0];        // столбы — всегда «крупная» фактура
    const sa = [-1, 0, 1, 0];
    for (let f = 0; f < 4; f++) {
      const p0 = c[f], p1 = c[(f + 1) % 4], n = N[f];
      const b = v;
      pos.push(p0[0], cy - hy, p0[1], p1[0], cy - hy, p1[1], p1[0], cy + hy, p1[1], p0[0], cy + hy, p0[1]);
      for (let k = 0; k < 4; k++) { nrm.push(n[0], n[1], n[2]); uv.push(k * 2, 0); wall.push(...wa); sign.push(...sa); }
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      v += 4;
    }
    const rb = v;
    pos.push(c[0][0], cy + hy, c[0][1], c[1][0], cy + hy, c[1][1], c[2][0], cy + hy, c[2][1], c[3][0], cy + hy, c[3][1]);
    for (let k = 0; k < 4; k++) { nrm.push(0, 1, 0); uv.push(k, k); wall.push(...wa); sign.push(...sa); }
    idx.push(rb, rb + 2, rb + 1, rb, rb + 3, rb + 2);
    v += 4;
  };
  for (const l of lamps) {
    box(l.x, 3.6, l.z, 0.28, 7.2, 0.28, 1);
    box(l.x + 0.7, 7.1, l.z, 1.6, 0.18, 0.24, 1);
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv),
           wall: new Float32Array(wall), sign: new Float32Array(sign), idx: new Uint32Array(idx), verts: v };
}

// ---------------------------------------------------- вывески (instanced-щиты)
// iPos   = (x, z, отметка низа, ширина)
// iShape = (поворот, наклон верхней кромки, высота щита, клетка атласа)
// iExtra = (зерно, фаза мерцания, яркость, режим 0 вывеска / 1 фонарь / 2 гирлянда)
// Три режима на одном проходе — поэтому фонарь и гирлянда не требуют ни своего
// шейдера, ни лишней пересборки VAO.
export function buildSigns(bld, signCount = 32, opts = {}) {
  const rnd = mulberry32(opts.seed || 77);
  const out = [];
  // нормаль грани: [nx, 0, nz]. Раньше у восточной/западной граней третья
  // компонентка тоже была ±1 — и щит уезжал на off по обеим осям, то есть висел
  // в воздухе у угла дома, а не на стене.
  const dirs = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0]];
  for (let bi = 0; bi < bld.length; bi++) {
    const b = bld[bi];
    // Ниже 30 м первый этаж почти всегда лавка — вывеска есть независимо от
    // «казённости» района; на башнях решают шансы района (стеклянный офис
    // обычно молчит, кроме цоколя).
    const dense = b.h < 30;
    if (!dense && rnd() > b.signChance) continue;
    // «много вывесок» по ТЗ: в магазине и лавке — щит на каждый этаж, в
    // офисе и на панели — одна-две вывески у входа
    const n = !dense ? 1 + ((rnd() * 2) | 0)
            : b.signChance > 0.8 ? 3 + ((rnd() * 6) | 0)
            : b.signChance > 0.6 ? 2 + ((rnd() * 5) | 0)
            : 2 + ((rnd() * 3) | 0);
    const f0 = (rnd() * 4) | 0;
    for (let i = 0; i < n; i++) {
      // грани идут по кругу, а не случайно: иначе на узком корпусе все щиты
      // stacks в одну точку (тест «нет ковра» это и ловил)
      const f = (f0 + i) & 3;
      const d = dirs[f];
      const span = (f < 2 ? b.w : b.d) - 8;
      // ряд по этажам + распределение вдоль грани
      const along = ((i % 3) / 3 - 1 / 3 + (rnd() - 0.5) * 0.3) * Math.max(2, span) * 0.8;
      const off = (f < 2 ? b.d : b.w) / 2 + 0.14;
      const x = b.x + (d[0] !== 0 ? d[0] * off : along);
      const z = b.z + (d[2] !== 0 ? d[2] * off : along);
      const vertical = rnd() < 0.35;
      // щит не должен вылезать за грань: половина ширины — это span/2, минус
      // уже сделанный отступ along
      const width = vertical ? 1.5 + 0.8 * rnd()
                             : Math.min(0.92 * Math.max(2, span), 7 + 11 * rnd());
      // низкие корпуса (хутун 5..9 м) не носят вертикальный_banner_ в шесть
      // этажей: высота ограничивается отметкой парапета, иначе щит пробивает
      // крышу, а сверху светится торец
      const maxH = Math.max(1.3, b.h - 1.5);
      const height = Math.min(vertical ? maxH * 0.82 : maxH * 0.55,
                              vertical ? 6 + 12 * rnd() : 2.0 + 2.6 * rnd());
      const fl = b.signFloor === 0 ? 1 + ((i / 3) | 0) : b.signFloor + ((i / 3) | 0);
      const base = Math.max(1.8, b.floorH * fl - 0.9 + 1.2 * rnd());
      const ylo = Math.min(base, Math.max(1.6, b.h - height - 0.5));
      out.push({
        x, z, y: Math.max(1.6, ylo),
        w: width, h: height, bi,
        rot: d[0] !== 0 ? (d[0] > 0 ? 0 : Math.PI) : (d[2] > 0 ? Math.PI / 2 : -Math.PI / 2),
        // клетки 0..signCount-1 — широкие щиты, signCount..2*signCount-1 — те же
        // тексты в вертикальной раскладке; 30..31 широкого набора зарезервированы
        // под лампу фонаря и точку гирлянды, поэтому горизонтальные щиты берут
        // только 0..signCount-3.
        cell: vertical ? signCount + ((rnd() * signCount) | 0)
                       : (rnd() * Math.max(1, signCount - 2)) | 0,
        mode: 0,
        bright: 0.75 + 1.15 * rnd(),
        phase: rnd(),
        seed: rnd(),
        tilt: 0.08 + 0.26 * rnd(),
      });
    }
  }
  // фонари: та же программа, режим 1 — маленький щит-лампа на столбе
  for (const l of (opts.lamps || [])) {
    for (const side of [1, -1]) {
      out.push({ x: l.x, z: l.z, y: l.y - 0.35, w: 0.55, h: 0.5, rot: side > 0 ? 0 : Math.PI,
                 cell: 30, mode: 1, bright: 1.6 + 0.5 * rnd(), phase: rnd(), seed: rnd(), tilt: 0 });
    }
  }
  return { signs: out };
}

// ------------------------------------------------------------- растительность
export const STREET_HALF = 30;                       // половина главного проспекта

export function buildVegetation(layout, opts = {}) {
  const rnd = mulberry32(20260114);
  const veg = [];      // {x,z,h,w,rot,stiff,type,tint,seed,phase,press,wet}
  const add = (type, x, z, h, w, stiff, spread = 1) => {
    if (lakeField(x, z) < 1.06) return;
    veg.push({
      type, x, z, h, w, stiff,
      rot: rnd() * Math.PI * 2,
      tint: 0.75 + 0.5 * rnd(),
      seed: rnd(), phase: rnd(),
      press: rnd() < 0.06 ? 0.7 : 0.0,
      wet: rnd() * 0.4,
      cross: type === 3 || type === 0 || type === 6 ? 2 : (type === 4 ? 3 : 1),
      lean: (rnd() - 0.5) * 0.18 * spread,
    });
  };
  // 1) бамбуковый парк: плотные куртины
  for (let i = 0; i < (opts.bamboo || 5200); i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd());
    const x = -430 + Math.cos(a) * r * 205, z = 300 + Math.sin(a) * r * 145;
    if (bambooParkField(x, z) > 0.98) continue;
    add(3, x, z, 5.2 + 4.6 * rnd(), 0.34 + 0.16 * rnd(), 0.15);
  }
  // 1b) подлесок бамбукового парка: папоротник и сухостой у куртин
  for (let i = 0; i < (opts.ferns || 1400); i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd());
    const x = -430 + Math.cos(a) * r * 215, z = 300 + Math.sin(a) * r * 155;
    if (bambooParkField(x, z) > 1.06) continue;
    add(2, x, z, 0.38 + 0.42 * rnd(), 0.3 + 0.28 * rnd(), 0.55);
  }
  // 2) пальмовая аллея у воды и на пляже
  for (let i = 0; i < (opts.palms || 260); i++) {
    const t = rnd() * Math.PI * 2;
    const rr = 1.14 + 0.30 * rnd();
    const x = 250 + Math.cos(t) * 170 * rr, z = -180 + Math.sin(t) * 118 * rr;
    add(4, x, z, 6.5 + 5.5 * rnd(), 2.4 + 1.4 * rnd(), 0.28);
  }
  // 3) лиственные во дворах и кусты вдоль улиц
  for (const b of layout.blocks) {
    const rnd2 = mulberry32(b.seed ^ 91);
    const trees = 3 + ((rnd2() * 7) | 0);
    for (let i = 0; i < trees; i++) {
      const x = b.cx + (rnd2() - 0.5) * (b.bw - 34), z = b.cz + (rnd2() - 0.5) * (b.bh - 34);
      add(rnd2() < 0.55 ? 0 : 1, x, z, 2.2 + 2.4 * rnd2(), 1.6 + 1.4 * rnd2(), 0.85);
    }
    for (let i = 0; i < 14; i++) {
      const x = b.cx + (rnd2() - 0.5) * (b.bw - 14), z = b.cz + (rnd2() - 0.5) * (b.bh - 14);
      add(rnd2() < 0.3 ? 5 : 8, x, z, 0.55 + 0.5 * rnd2(), 0.5 + 0.4 * rnd2(), 0.95);
    }
  }
  // 4) ёлки и еловая лапа для новогодней ёлки на площади
  const height = opts.treeHeight || 17.5, layers = 22;
  const tree = { x: 6, y: 0, z: -20, height, layers: [] };
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1);
    const r = (1 - t) * 5.6 + 0.4;
    const cnt = Math.max(3, Math.round(10 * (1 - t * 0.55)));
    for (let k = 0; k < cnt; k++) {
      const a = (k / cnt) * Math.PI * 2 + t * 1.7;
      add(6, tree.x + Math.cos(a) * r, tree.z + Math.sin(a) * r,
          2.3 - t * 0.7, 2.4 - t * 0.9, 0.9);
    }
    tree.layers.push({ y: t * height, r });
  }
  return { veg, tree };
}

// ------------------------------------------------------------------- свет
export function buildLights(bld, lamps) {
  const out = [];
  for (const l of lamps) out.push({ x: l.x, z: l.z, y: 8.6, r: 26, c: [0.42, 0.36, 0.26], kind: 0 });
  for (const b of bld) {
    if (b.h > 26 && (b.seed & 3) === 0) out.push({ x: b.x, z: b.z, y: b.h + 1.5, r: 42, c: [0.30, 0.34, 0.46], kind: 1 });
  }
  return out;
}

// Столбы ставим вдоль красной линии квартала, но «вдоль линии» недостаточно:
// выступ корпуса, павильон рынка или киоск превращают фонарь в объект внутри
// стены (в боковом свете — тёмное пятно и светящийся плафон в бетоне). Поэтому
// кандидата сдвигаем поперёк улицы, пока не упрёмся в свободный тротуар, а
// отказ — только когда места нет вовсе. bld можно не передавать (тогда без
// проверки), но main.js и тесты передают. «Места нет» — это и вода: кварталы
// набегают на берег, и без проверки над озером стоял лес столбов.
export function lampPositions(layout, bld) {
  const out = [];
  const CELL = 32;
  const grid = new Map();
  const key = (x, z) => ((Math.floor(x / CELL) * 4096) + Math.floor(z / CELL));
  if (bld) {
    for (const b of bld) {
      const x0 = Math.floor((b.x - b.w / 2 - 1.4) / CELL), x1 = Math.floor((b.x + b.w / 2 + 1.4) / CELL);
      const z0 = Math.floor((b.z - b.d / 2 - 1.4) / CELL), z1 = Math.floor((b.z + b.d / 2 + 1.4) / CELL);
      for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
        const k = gx * 4096 + gz;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(b);
      }
    }
  }
  const blocked = (x, z) => {
    // Вода — тоже «места нет»: столб, вбитый в озеро, выглядит плавающим
    // плафоном, а ночью рисует световой круг посреди воды. Запас берега —
    // те же 12 %, что и в `buildVegetation`.
    if (lakeField(x, z) < 1.12) return true;
    if (!bld) return false;
    const arr = grid.get(key(x, z));
    if (!arr) return false;
    for (const b of arr) if (Math.abs(x - b.x) < b.w / 2 + 1.4 && Math.abs(z - b.z) < b.d / 2 + 1.4) return true;
    return false;
  };
  const near = new Set();                       // не ставить столбы впритык
  const push = (x, z, ax, az) => {
    for (let k = 0; k <= 14; k++) {
      const px = x + ax * k, pz = z + az * k;
      if (!blocked(px, pz)) {
        const kk = `${Math.round(px / 9)}|${Math.round(pz / 9)}`;
        if (!near.has(kk)) { near.add(kk); out.push([px, pz]); }
        return true;
      }
    }
    return false;
  };
  for (const b of layout.blocks) {
    const step = 22;
    for (let s = -1; s <= 1; s += 2) {
      for (let t = -b.bw / 2; t <= b.bw / 2 + 0.01; t += step) {
        // сдвигаем наружу (в тротуар улицы), если в candidate уперлись в стену
        push(b.cx + t, b.cz + s * (b.bh / 2 + 3.2), 0, s);
        push(b.cx + s * (b.bw / 2 + 3.2), b.cz + t * (b.bh / b.bw), s, 0);
      }
    }
  }
  return out;
}

// ------------------------------------------- трава: поле вокруг камеры
// Плотность газона — 20..40 травинок на м², поэтому «весь мир одним списком»
// не работает: 110 тыс. инстансов на 1536² м² дают 0.3 травинки на м² и лысый
// дёрн у ног. Поле строится решёткой с джиттером вокруг камеры и переставляется,
// когда камера уходит дальше шага. Плотность берётся из той же layer-карты, что
// читает ground.frag, — трава растёт ровно там, где дёрн, и не лезет на асфальт.
export function buildGrassField(opts = {}) {
  const layers = opts.layers;
  const size = W_SIZE;
  const c = opts.center || [0, 0];
  const max = opts.max || 60000;
  // Пояса плотности: [радиус, метры на травинку]. Ядро — 20..40 травинок/м²,
  // как требует ТЗ; чем дальше, тем реже, потому что бюджет инстансов конечен
  // и трава «под ноги» важнее травы в сорока метрах. Один плотный диск на весь
  // радиус в бюджет не влезает, а равномерная решётка по всему миру даёт
  // 0.3 шт/м² — лысый дёрн и у ног, и вдали.
  const bands = opts.bands || [[opts.radius || 34, opts.cell || 0.24],
                               [opts.farRadius || 0, opts.farCell || 1.4]];
  const hMul = opts.height == null ? 1.0 : opts.height;
  const rnd = mulberry32((opts.seed || 5) ^ ((c[0] * 7) | 0) ^ ((c[1] * 13) | 0));
  const iPos = new Float32Array(max * 4);
  const iShape = new Float32Array(max * 4);
  const iExtra = new Float32Array(max * 4);
  let n = 0;
  const tree = [opts.treeX == null ? 6 : opts.treeX, opts.treeZ == null ? -20 : opts.treeZ];
  const put = (x, z, g) => {
    if (n >= max) return false;
    const near = Math.hypot(x - tree[0], z - tree[1]) < 15;   // луг под ёлкой
    // Сухостой — только по края газона и вдоль плиток (5..18%), иначе городская
    // лужайка выглядит выжженным полем.
    const dry = rnd() < 0.05 + 0.13 * (1 - g);
    const species = near ? 3 : (dry ? 4 : (rnd() * 4) | 0);
    // Городской газон стригут до 8..20 см; 30 см читаются как кукуруза, а при
    // 25 травинках/м² ещё и перекрывают друг друга тенями.
    const h = (0.045 + 0.135 * g) * (0.78 + 0.5 * rnd()) * hMul * (near ? 2.3 : 1);
    const w = (0.013 + 0.012 * rnd()) * (near ? 1.5 : 1);
    const o = n * 4;
    iPos[o] = x; iPos[o + 1] = z; iPos[o + 2] = h; iPos[o + 3] = w;
    iShape[o] = rnd() * Math.PI * 2;
    iShape[o + 1] = (rnd() - 0.5) * 1.4;
    iShape[o + 2] = 0.55 + 0.45 * rnd();
    iShape[o + 3] = species;
    iExtra[o] = rnd();
    iExtra[o + 1] = rnd();
    iExtra[o + 2] = rnd() < 0.06 ? 0.85 : 0;
    iExtra[o + 3] = 0.25 + 0.5 * rnd();
    n++;
    return true;
  };
  const turfAt = (x, z) => {
    const px = Math.min(size - 1, Math.max(0, Math.round((x / W_WORLD + 0.5) * (size - 1))));
    const py = Math.min(size - 1, Math.max(0, Math.round((z / W_WORLD + 0.5) * (size - 1))));
    const o = (py * size + px) * 4;
    const g = layers[o + 1] / 255;
    const mat = Math.round((layers[o] / 255) * 7);
    return { g, mat };
  };
  // точка Пояса: джиттер внутри ячейки, отсев по покрытию, приём по бюджету
  const ok = (dx, dz, rad, radIn) => {
    const d = Math.hypot(dx - c[0], dz - c[1]);
    if (d > rad || d < radIn) return false;
    const t = turfAt(dx, dz);
    if (t.g < 0.22) return false;                    // асфальт, плитка, вода — не трава
    if (t.mat === 7 && rnd() > 0.25) return false;   // на разметке — только кустики
    return put(dx, dz, t.g);
  };
  // «нет травы в этой точке» — обычный случай (асфальт, разметка, выход за
  // круг), а не конец цикла: останавливает пояса только исчерпанный бюджет, и
  // это уже условие в самих for (n < max).
  const band = (step, radIn, rad) => {
    const x0 = Math.floor((c[0] - rad) / step) * step, z0 = Math.floor((c[1] - rad) / step) * step;
    for (let x = x0; x < c[0] + rad && n < max; x += step) {
      for (let z = z0; z < c[1] + rad && n < max; z += step) {
        const dx = x + (rnd() - 0.5) * step * 1.25;
        const dz = z + (rnd() - 0.5) * step * 1.25;
        ok(dx, dz, rad, radIn);
      }
    }
  };
  // Пояса идут от ближнего к дальнему; у дальнего — «дырка» радиусом внутреннего,
  // иначе редкая сетка внешнего пояса просто пересозаполняет плотное ядро.
  let inner = 0;
  for (let bi = 0; bi < bands.length; bi++) {
    const rad = bands[bi][0], step = bands[bi][1];
    if (!(rad > inner) || !(step > 0)) continue;
    band(step, inner, rad);
    inner = rad;
  }
  return { count: n, cap: max, iPos: iPos.slice(0, n * 4), iShape: iShape.slice(0, n * 4),
           iExtra: iExtra.slice(0, n * 4), center: [c[0], c[1]],
           step: (bands[0][1] || 0.24) * 24, radius: inner };
}

const W_WORLD = WORLD;
const W_SIZE = LAYERS;

// Общая оценка плотности на весь мир — нужна тестам и отладочной панели.
export function buildGrass(layers, opts = {}) {
  const count = opts.count || 120000;
  const iPos = new Float32Array(count * 4);
  const iShape = new Float32Array(count * 4);
  const iExtra = new Float32Array(count * 4);
  const rnd = mulberry32(opts.seed || 5);
  const size = LAYERS;
  let n = 0, tries = 0;
  const maxTries = count * 14;
  const water = waterBox(lakeField);
  while (n < count && tries++ < maxTries) {
    const x = (rnd() - 0.5) * WORLD;
    const z = (rnd() - 0.5) * WORLD;
    // плотность травы берём из той же карты, что и шейдер земли
    const px = Math.min(size - 1, Math.max(0, Math.round(((x / WORLD) + 0.5) * (size - 1))));
    const py = Math.min(size - 1, Math.max(0, Math.round(((z / WORLD) + 0.5) * (size - 1))));
    const g = layers[(py * size + px) * 4 + 1] / 255;
    if (g < 0.22) continue;
    const near = Math.hypot(x - 6, z + 20) < 16;          // лужайка под ёлкой — разнотравье
    const d = 1;
    // Сухостой — только по края газона и вдоль плиток (5..18%), иначе городская
    // лужайка выглядит выжженным полем.
    const dry = rnd() < 0.05 + 0.13 * (1 - g);
    const species = near ? 3 : (dry ? 4 : (rnd() * 4) | 0);
    // Городской газон, а не пшеница: 6..27 см. У ёлки — луг до 55 см.
    const h = (0.055 + 0.215 * g) * (0.75 + 0.55 * rnd()) * (opts.height || 1.0) * (near ? 2.1 : 1);
    const w = 0.011 + 0.011 * rnd();                       // ширина ленты у основания
    const i = n * 4;
    iPos[i] = x; iPos[i + 1] = z; iPos[i + 2] = h; iPos[i + 3] = w;
    // iShape = (поворот, изгиб, оттенок, вид) — ровно как в grass.vert
    iShape[i] = rnd() * Math.PI * 2;
    iShape[i + 1] = (rnd() - 0.5) * 1.4;
    iShape[i + 2] = 0.55 + 0.45 * rnd();            // оттенок
    iShape[i + 3] = species;                        // вид (строка атласа)
    // iExtra = (зерно, фаза порыва, прижатие, мокрость)
    iExtra[i] = rnd();
    iExtra[i + 1] = rnd();
    iExtra[i + 2] = rnd() < 0.05 ? 0.85 : 0;
    iExtra[i + 3] = 0.25 + 0.5 * rnd();
    n++;
    void d;
  }
  return { count: n, iPos: iPos.slice(0, n * 4), iShape: iShape.slice(0, n * 4), iExtra: iExtra.slice(0, n * 4) };
}

// --------------------------------------------------- упрощённая сцена для дампа
export function dumpable(w) {
  return {
    boxes: w.bld.map(b => [b.x, 0, b.z, b.w, b.h, b.d, 0.2, 0.2, 0.2, 0.7]),
    grass: Array.from({ length: Math.min(4000, w.grass.count) }, (_, i) => {
      const o = i * 4;
      return [w.grass.iPos[o], w.grass.iPos[o + 1], w.grass.iPos[o + 2], w.grass.iPos[o + 3],
              w.grass.iShape[o], 0, w.grass.iShape[o + 2]];
    }),
  };
}
