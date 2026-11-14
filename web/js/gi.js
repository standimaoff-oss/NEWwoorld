// gi.js — запечённый объём глобального освещения (RTGI-контур, шаг 5.33).
//
// Что это честно: полный трассировщик лучей в реальном времени здесь не нужен
// и на телефоне не выживет. Поэтому GI собирается из трёх частей:
//
//  1. объём 96 × 12 × 96 ячеек по 16 м (совпадает с GI_GRID в common.glsl).
//     В каждой ячейке: доля неба (sky visibility, 6 лучей вверх) и облучённость
//     — небо + один отскок от стен + фонари и витрины. Пишется в sampler3D,
//     читает каждый объект, поэтому трава в арке и стена во дворе получают
//     один и тот же ambient.
//  2. экранный SSAO (shaders/glsl/ssao.frag) — контактные тени у стен и под
//     лавками, которых в объёме 16-метровых ячеек не разглядеть.
//  3. мягкий свет от источников (фонари, вывески, окна) — считается при запекании
//     и «сидит» в облучённости, поэтому ночью двор освещён даже без теневых карт.
//
// Перезапекается при смене дня/погоды (кнопка «GI» или клавиша G) — 100..400 мс.

'use strict';

export const GI = { X: 96, Y: 12, Z: 96, WORLD: 1536 };

/**
 * Усиление искусственного света в запечённом GI, доля дневной облучённости.
 * 0.045 — «под фонарём видно лицо, но улица не похожа на день» (ночь выходит
 * в ~7 раз темнее дня). Число вынесено
 * сюда, чтобы тест мог проверить отношение «ночь/день» прямо по объёму.
 */
export const NIGHT_LIGHT_GAIN = 0.045;

const CELL = GI.WORLD / GI.X;
const YCELL = (GI.Y * CELL) / GI.Y;

// Цвет фасадов для отскока: те же числа, что в атласе (см. make_beijing_tex.py).
const FACADE_ALBEDO = [
  [0.205, 0.200, 0.185], [0.190, 0.185, 0.172], [0.115, 0.052, 0.036],
  [0.140, 0.138, 0.132], [0.075, 0.020, 0.014], [0.030, 0.036, 0.044],
  [0.240, 0.232, 0.205], [0.300, 0.215, 0.055],
];

function worldToCell(x, z) {
  return [Math.floor((x / GI.WORLD + 0.5) * GI.X), Math.floor((z / GI.WORLD + 0.5) * GI.Z)];
}

/**
 * @param {Array} bld  дома: {x,z,w,d,h,facade}
 * @param {Array} lights  источники: {x,z,y,r,c:{0..1*3},kind}
 * @param {Object} env {day:0..1, sunDir:[3], sunCol:[3], skyCol:[3], rain, snow}
 */
export function bakeGI(bld, lights, env) {
  const t0 = performance.now();
  const { X, Y, Z } = GI;
  // 1) занятость: для каждой ячейки — самый верхний уровень крыши и тип фасада
  const occ = new Uint8Array(X * Z);                       // 0 — открыто, иначе «этажность × 8»
  const topFace = new Int8Array(X * Z).fill(-1);
  const hmax = new Float32Array(X * Z);
  for (const b of bld) {
    const [ix0, iz0] = worldToCell(b.x - b.w / 2, b.z - b.d / 2);
    const [ix1, iz1] = worldToCell(b.x + b.w / 2, b.z + b.d / 2);
    for (let ix = Math.max(0, ix0); ix <= Math.min(X - 1, ix1); ix++) {
      for (let iz = Math.max(0, iz0); iz <= Math.min(Z - 1, iz1); iz++) {
        const k = iz * X + ix;
        if (b.h > hmax[k]) { hmax[k] = b.h; topFace[k] = b.facade; }
      }
    }
  }
  for (let k = 0; k < X * Z; k++) occ[k] = Math.min(255, Math.round(hmax[k] / 4));

  const vol = new Uint8Array(X * Y * Z * 4);
  const day = env.day, sky = env.skyCol, sun = env.sunCol, sd = env.sunDir;

  // 2).sky visibility: пять наклонных лучей + вертикальный. Шаг — половина ячейки.
  const dirs = [
    [0, 1, 0], [0.5, 0.85, 0], [-0.5, 0.85, 0], [0, 0.85, 0.5], [0, 0.85, -0.5],
  ];
  for (let ix = 0; ix < X; ix++) {
    for (let iz = 0; iz < Z; iz++) {
      const wx = (ix + 0.5) * CELL - GI.WORLD / 2;
      const wz = (iz + 0.5) * CELL - GI.WORLD / 2;
      const roof = hmax[iz * X + ix];
      for (let iy = 0; iy < Y; iy++) {
        const wy = (iy + 0.5) * YCELL;
        let skyVis = 0;
        if (wy > roof + 0.5) {
          skyVis = 1;
        } else {
          let open = 0;
          for (const d of dirs) {
            let clear = 1;
            let t = 0;
            for (let s = 0; s < 14; s++) {
              t += CELL * 0.55;
              const px = wx + d[0] * t, pz = wz + d[2] * t, py = wy + d[1] * t;
              const [jx, jz] = worldToCell(px, pz);
              if (jx < 0 || jx >= X || jz < 0 || jz >= Z) break;
              if (hmax[jz * X + jx] > py) { clear = 0; break; }
            }
            open += clear;
          }
          skyVis = open / dirs.length;
        }
        // 3) облучённость: небо + отражённый от соседних крыш свет + фонари
        let er = sky[0] * (0.35 + 0.65 * skyVis) + 0.008;
        let eg = sky[1] * (0.35 + 0.65 * skyVis) + 0.010;
        let eb = sky[2] * (0.35 + 0.65 * skyVis) + 0.014;
        // солнце попадает только туда, где есть небо и где фасад не затенён
        const sunAmount = skyVis * Math.max(0, sd[1]) * day;
        er += sun[0] * 0.30 * sunAmount;
        eg += sun[1] * 0.28 * sunAmount;
        eb += sun[2] * 0.22 * sunAmount;
        // один отскок: если ячейка у стены — добавляем свет, отражённый от неё
        if (roof > wy && topFace[iz * X + ix] >= 0 && wy > 0) {
          const alb = FACADE_ALBEDO[topFace[iz * X + ix]] || FACADE_ALBEDO[0];
          const prox = 1 - Math.min(1, (roof - wy) / (YCELL * 2));
          er += alb[0] * (sun[0] * 0.35 + sky[0] * 0.5) * 0.55 * prox;
          eg += alb[1] * (sun[1] * 0.35 + sky[1] * 0.5) * 0.55 * prox;
          eb += alb[2] * (sun[2] * 0.35 + sky[2] * 0.5) * 0.55 * prox;
        }
        // 4) искусственный свет: фонари, витрины, окна (только нижние уровни).
        // Масштаб — не «на глаз», а из отношений освещённостей: улица под
        // фонарём получает ~10–30 лк против 5 000–10 000 лк днём, то есть в
        // 300..1000 раз меньше. Нам нужен «игровой» свет (в темноте должно быть
        // видно вывески), поэтому берём 2.5 % дневной облучённости в центре
        // пятна. Прежнее усиление 1.7 без поправки давало 0.51 против 0.13 у
        // дневного неба: ночью улица оказывалась ВДВОЕ светлее дня, а 700
        // вывесок размазывали это по всему кварталу.
        // Формула пятна: 1/(1 + d²/(0.12·r²)) — убывает быстрее, чем «радиус
        // действия» лампы, и даёт тёплый островок ~8..12 м, а не свет на 40 м.
        if (day < 0.75) {
          const night = 1 - day / 0.75;
          const gain = NIGHT_LIGHT_GAIN;
          for (const L of lights) {
            const dx = wx - L.x, dz = wz - L.z, dy = wy - L.y;
            const d2 = dx * dx + dz * dz + dy * dy * 2.2;
            const r2 = (L.r || 26) * (L.r || 26);
            if (d2 > r2 * 4) continue;
            const kindW = L.kind === 1 ? 1.0 : 0.55;      // фонарь ярче витрины
            const f = night * kindW * gain / (1 + d2 / (r2 * 0.12));
            er += L.c[0] * f * 1.7;
            eg += L.c[1] * f * 1.6;
            eb += L.c[2] * f * 1.5;
          }
        }
        // дождь и снег меняют отражательную способность улицы: мокрый асфальт
        // темнеет, снег — осветляет всё вокруг
        const wet = env.rain || 0, snow = env.snow || 0;
        const m = 1 - 0.22 * wet * (1 - 2.2 * snow);
        er *= m; eg *= m; eb *= m;
        er += 0.10 * snow; eg += 0.11 * snow; eb += 0.13 * snow;
        const o = ((iy * Z + iz) * X + ix) * 4;
        const q = 255 / 1.6;                        // объём хранит «усиленную» величину
        vol[o] = Math.min(255, Math.round(er * q));
        vol[o + 1] = Math.min(255, Math.round(eg * q));
        vol[o + 2] = Math.min(255, Math.round(eb * q));
        vol[o + 3] = Math.round(skyVis * 255);
      }
    }
  }
  const ms = performance.now() - t0;
  return { data: vol, size: [X, Y, Z], ms: Math.round(ms), cell: CELL };
}

/** Среднее по объёму — для панели диагностики и для снимков. */
export function giStats(vol) {
  let e = 0, sky = 0, min = 1, max = 0, n = 0;
  for (let i = 0; i < vol.length; i += 4) {
    const v = (vol[i] + vol[i + 1] + vol[i + 2]) / 765;
    e += v; sky += vol[i + 3] / 255; n++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { irradiance: e / n, skyVis: sky / n, min, max, cells: n };
}
