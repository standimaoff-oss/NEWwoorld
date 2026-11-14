// main.js — веб-сборка ShopSim 0.5.31: загрузка, проходы рендера, управление.
//
// Проход один-единственный: сцена строится из тех же модулей (world.js, gi.js),
// что и снимки через tools/shader_preview.py, и использует те же GLSL-программы,
// что нативная сборка на raylib (build/shaders/web — это те же файлы, только с
// шапкой «#version 300 es»). Отдельного «веб-варианта» шейдеров нет.
//
// Порядок проходов:
//   1. scene (HDR RGBA16F + depth32F): sky → ground → facades → vegetation →
//      grass → water → signs/emissive (все — со светом из запечённого объёма GI)
//   2. ssao (пол-размера)
//   3. bloom (1/4, два размытия)
//   4. rain_window (только когда включён «дождь за стеклом»)
//   5. post: AO → bloom → тонмаппинг ACES → виньетка/зерно → экран
//
// Горячие клавиши: WASD + стрелки — движение, ЛКМ — обзор, колесо — скорость,
// T — время суток, R — дождь, G — снег, Y — сезон, B — пересобрать GI,
// 1/2/3 — качество, C — кинематографический режим, S — снимок PNG,
// H — справка, E — телепорт к озеру, F — фонари, J — витрина (pass дождя за стеклом).

'use strict';

import {
  createContext, makeProgram, makeVAO, makeFBO, makeMSAA, blitTo,
  tex2D, tex3D, texImage, mat4, perspective, lookAt, mul4, invert4,
} from './gl.js';
import * as W from './world.js';
import { bakeGI, giStats, GI } from './gi.js';
import { TEX, QUALITY, LOOK, SEASONS, TIMES, srgb2lin, toSRGB } from './materials.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => (x < a ? a : (x > b ? b : x));
const lerp = (a, b, t) => a + (b - a) * t;
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

class App {
  constructor() {
    this.canvas = $('view');
    this.gl = createContext(this.canvas, { antialias: false });
    this.state = {
      quality: 'medium', time: 'noon', season: 'summer',
      rain: 0, snow: 0, wind: 0.35, gi: 1, bloom: 1, ao: 1,
      windowRain: 0, cinema: 0, exposure: LOOK.exposure, grassScale: 1,
    };
    this.keys = new Set();
    this.mouse = { down: false, x: 0, y: 0, yaw: 2.55, pitch: -0.16, speed: 1 };
    this.cam = [128, 12, 372];
    this.target = [6, 7, -14];
    this.frame = 0;
    this.stats = { fps: 0, ms: 0, tris: 0, grass: 0, veg: 0, gi: 0, calls: 0 };
    this.programs = {};
    this.textures = {};
    this.running = true;
  }

  // -------------------------------------------------------------- инициализация
  async init() {
    const t0 = performance.now();
    this.setStatus('шейдеры…');
    await this.buildPrograms();
    this.setStatus('текстуры…');
    await this.loadTextures();
    this.setStatus('квартал…');
    this.buildWorld();
    this.setStatus('запекание GI…');
    this.rebakeGI();
    this.uploadGI();
    this.setStatus('буферы…');
    this.buildGPU();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.bindInput();
    this.last = performance.now();
    this.setStatus(`готово за ${((performance.now() - t0) / 1000).toFixed(1)} с`);
    requestAnimationFrame(() => this.frameLoop());
  }

  setStatus(text) { const el = $('status'); if (el) el.textContent = text; }

  async fetchText(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.text();
  }

  async buildPrograms() {
    // Файлы собраны tools/shader_dialect.py; #include уже раскрыт.
    const files = [
      ['sky', 'sky.vert.glsl', 'sky.frag.glsl'],
      ['ground', 'ground.vert.glsl', 'ground.frag.glsl'],
      ['facade', 'facade.vert.glsl', 'facade.frag.glsl'],
      ['veg', 'veg.vert.glsl', 'veg.frag.glsl'],
      ['grass', 'grass.vert.glsl', 'grass.frag.glsl'],
      ['water', 'water.vert.glsl', 'water.frag.glsl'],
      ['emissive', 'emissive.vert.glsl', 'emissive.frag.glsl'],
      ['ssao', 'screen.vert.glsl', 'ssao.frag.glsl'],
      ['bloom', 'screen.vert.glsl', 'bloom.frag.glsl'],
      ['rainwin', 'screen.vert.glsl', 'rain_window.frag.glsl'],
      ['post', 'screen.vert.glsl', 'post.frag.glsl'],
    ];
    const gl = this.gl;
    const screen = { vao: gl.createVertexArray(), count: 3 };
    gl.bindVertexArray(screen.vao);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    // один большой треугольник (-1..3), покрывающий экран
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.fullscreen = screen;
    for (const [name, vs, fs] of files) {
      const [vsSrc, fsSrc] = await Promise.all([
        this.fetchText(`build/shaders/web/${vs}`),
        this.fetchText(`build/shaders/web/${fs}`),
      ]);
      this.programs[name] = makeProgram(gl, vsSrc, fsSrc, name);
    }
  }

  async loadTextures() {
    const gl = this.gl;
    for (const [name, url, kind] of TEX) {
      try {
        this.textures[name] = await texImage(gl, url, { srgb: false, mips: true, aniso: QUALITY[this.state.quality].mipsAniso });
      } catch (e) {
        // отсутствие текстуры не должно ронять сцену: шейдер увидит серый шум
        console.warn(`текстура ${url}: ${e.message}`);
        this.textures[name] = this.placeholder();
      }
    }
  }

  placeholder() {
    const gl = this.gl;
    const d = new Uint8Array(4 * 4 * 4).fill(128);
    return tex2D(gl, { width: 4, height: 4, data: d, mips: false });
  }

  // --------------------------------------------------------------------- мир
  buildWorld() {
    const q = QUALITY[this.state.quality];
    this.layout = W.blockLayout(20261);
    const lake = (x, z) => W.lakeField(x, z);
    const bamboo = (x, z) => W.bambooParkField(x, z);
    this.layers = W.buildLayers(lake, bamboo, this.layout);
    const wd = W.buildWaterDepth(512, lake);
    this.waterDepth = wd.data;
    this.waterBox = wd.box;
    this.bld = W.buildBuildings(this.layout, { signCount: 32 });
    const veg = W.buildVegetation(this.layout, { bamboo: 5200, palms: 300 });
    this.veg = veg.veg;
    this.tree = veg.tree;
    this.treeLights = W.buildTreeLights(this.tree, { lamps: 220 });
    const lampXY = W.lampPositions(this.layout, bld);
    this.lamps = lampXY.map(([x, z]) => ({ x, z, y: 7.3 }));
    this.signs = W.buildSigns(this.bld, 32, { lamps: this.lamps }).signs.concat(this.treeLights);
    this.lampMesh = W.buildLampMesh(this.lamps);
    // Поле травы привязано к камере: плотность 20-40 травинок/м² достижима только
    // в радиусе детализации, поэтому буферы заполняются заново при уходе камеры
    // дальше шага (см. refreshGrass).
    this.grass = W.buildGrassField(this.grassOpts());
    this.facade = W.buildFacadeMesh(this.bld, {});
    // Карты слоёв и глубины — «текстуры данных»: их читают земля, вода и
    // генератор травы, поэтому маски никогда не расходятся с рендером.
    // 1×1 чёрная заглушка (не placeholder(): он серый 0.5, а для аддитивного
    // bloom и для отключённого AO нужен именно ноль). bloom и AO выборочны, а
    // шейдер сэмплирует оба юниформа всегда: без привязанной текстуры WebGL на
    // каждый кадр пишет «incomplete texture», а значение сэмпла — шум драйвера.
    this.textures.blank = tex2D(this.gl, {
      width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]),
      internal: this.gl.RGBA8, format: this.gl.RGBA, type: this.gl.UNSIGNED_BYTE,
      wrap: this.gl.CLAMP_TO_EDGE, mips: false,
    });
    this.textures.layers = tex2D(this.gl, {
      width: W.LAYERS, height: W.LAYERS, data: this.layers,
      internal: this.gl.RGBA8, format: this.gl.RGBA, type: this.gl.UNSIGNED_BYTE,
      wrap: this.gl.CLAMP_TO_EDGE, mips: false,
    });
    this.textures.waterDepth = tex2D(this.gl, {
      width: 512, height: 512, data: this.waterDepth,
      internal: this.gl.RGBA8, format: this.gl.RGBA, type: this.gl.UNSIGNED_BYTE,
      wrap: this.gl.CLAMP_TO_EDGE, mips: false,
    });
    // огни для GI: фонари + тёплые окна первых этажей
    const rnd = W.mulberry32(31);
    this.lights = this.lamps.map((l) => ({ x: l.x, z: l.z, y: l.y, r: 24, c: [0.30, 0.24, 0.15], kind: 1 }))
      .concat(this.signs.filter((s) => s.mode !== 1).slice(0, 700).map((s) => ({
        x: s.x, z: s.z, y: s.y + s.h, r: 16 + 10 * rnd(), c: [0.26, 0.16, 0.14], kind: 0,
      })));
  }

  // ------------------------------------------------------------------- GPU
  grassOpts(forceCenter) {
    const q = QUALITY[this.state.quality];
    const S = SEASONS[this.state.season];
    return {
      layers: this.layers, max: q.grass, bands: q.grassBands,
      height: S.grassH * this.state.grassScale,
      center: forceCenter || [this.cam[0], this.cam[2]], seed: 5, treeX: 6, treeZ: -20,
    };
  }

  /** Пересборка поля травы: только если камера ушла дальше шага или сменился сезон. */
  refreshGrass(force) {
    const c = [this.cam[0], this.cam[2]];
    const f = this.grass;
    if (!force && f && Math.hypot(c[0] - f.center[0], c[1] - f.center[1]) < f.step) return;
    this.grass = W.buildGrassField(this.grassOpts());
    if (!this.geoGrass) return;
    const g = this.grass;
    // буферы выделены под максимум (q.grass), поэтому меняем только содержимое
    const pad = (src) => {
      const out = new Float32Array(this.geoGrass.capacity * 4);
      out.set(src);
      return out;
    };
    this.geoGrass.update(2, pad(g.iPos));
    this.geoGrass.update(3, pad(g.iShape));
    this.geoGrass.update(4, pad(g.iExtra));
    this.geoGrass.instances = g.count;
  }

  buildGPU() {
    const gl = this.gl;
    const loc = (p, n) => this.programs[p].loc.a[n];

    // земля: сетка 96×96 на весь город (1536 м) + смещение по берегу озера
    const ground = this.buildGroundMesh();
    this.geoGround = makeVAO(gl, {
      attribs: [
        { loc: loc('ground', 'aPos'), size: 3, data: ground.pos },
        { loc: loc('ground', 'aNormal'), size: 3, data: ground.nrm },
        { loc: loc('ground', 'aUv'), size: 2, data: ground.uv },
      ], indices: ground.idx,
    });
    this.geoGround.count = ground.idx.length;

    const f = this.facade;
    this.geoFacade = makeVAO(gl, {
      attribs: [
        { loc: loc('facade', 'aPos'), size: 3, data: f.pos, count: f.verts },
        { loc: loc('facade', 'aNormal'), size: 3, data: f.nrm },
        { loc: loc('facade', 'aUv'), size: 2, data: f.uv },
        { loc: loc('facade', 'aWall'), size: 4, data: f.wall },
        { loc: loc('facade', 'aSign'), size: 4, data: f.sign },
      ], indices: f.idx,
    });
    this.geoFacade.count = f.idx.length;

    const lm = this.lampMesh;
    this.geoLamps = makeVAO(gl, {
      attribs: [
        { loc: loc('facade', 'aPos'), size: 3, data: lm.pos, count: lm.verts },
        { loc: loc('facade', 'aNormal'), size: 3, data: lm.nrm },
        { loc: loc('facade', 'aUv'), size: 2, data: lm.uv },
        { loc: loc('facade', 'aWall'), size: 4, data: lm.wall },
        { loc: loc('facade', 'aSign'), size: 4, data: lm.sign },
      ], indices: lm.idx,
    });
    this.geoLamps.count = lm.idx.length;

    // трава: лента из 4 сегментов
    const blade = this.buildBladeMesh();
    const g = this.grass;
    // Буферы инстансов выделяем сразу под потолок профиля (q.grass), а не под
    // текущий count: refreshGrass потом только переписывает содержимое. Иначе
    // bufferSubData на длинном массиве дал бы GL_INVALID_VALUE на первом же шаге.
    const padCap = (src) => {
      const out = new Float32Array(q.grass * 4);
      out.set(src);
      return out;
    };
    this.geoGrass = makeVAO(gl, {
      attribs: [
        { loc: loc('grass', 'aPos'), size: 3, data: blade.pos },
        { loc: loc('grass', 'aUv'), size: 2, data: blade.uv },
        { loc: loc('grass', 'iPos'), size: 4, data: padCap(g.iPos), divisor: 1 },
        { loc: loc('grass', 'iShape'), size: 4, data: padCap(g.iShape), divisor: 1 },
        { loc: loc('grass', 'iExtra'), size: 4, data: padCap(g.iExtra), divisor: 1 },
      ], indices: blade.idx,
    });
    this.geoGrass.count = blade.idx.length;
    this.geoGrass.instances = Math.min(g.count, q.grass);
    // Буферы инстансов — сразу под потолок профиля: пересборка поля тогда не
    // трогает VAO и не дёргает аллокатор на каждом шаге камеры.
    this.geoGrass.capacity = q.grass;

    // листва: крест из двух квадов (или четырёх на высоком качестве)
    const cross = this.buildCrossMesh(QUALITY[this.state.quality].vegCross);
    const vbuf = this.packVeg();
    this.geoVeg = makeVAO(gl, {
      attribs: [
        { loc: loc('veg', 'aPos'), size: 3, data: cross.pos },
        { loc: loc('veg', 'aUv'), size: 2, data: cross.uv },
        { loc: loc('veg', 'iPos'), size: 4, data: vbuf.iPos, divisor: 1 },
        { loc: loc('veg', 'iShape'), size: 4, data: vbuf.iShape, divisor: 1 },
        { loc: loc('veg', 'iExtra'), size: 4, data: vbuf.iExtra, divisor: 1 },
      ], indices: cross.idx,
    });
    this.geoVeg.count = cross.idx.length;
    this.geoVeg.instances = this.veg.length;

    // вывески/фонари/гирлянды: quad
    const sq = this.packSigns();
    const ep = this.programs.emissive;
    this.geoSigns = makeVAO(gl, {
      attribs: [
        { loc: ep.loc.a.aPos, size: 2, data: new Float32Array([-1, 0, 1, 0, 1, 1, -1, 1]), type: gl.FLOAT },
        { loc: ep.loc.a.aUv, size: 2, data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]) },
        { loc: ep.loc.a.iPos, size: 4, data: sq.iPos, divisor: 1 },
        { loc: ep.loc.a.iShape, size: 4, data: sq.iShape, divisor: 1 },
        { loc: ep.loc.a.iExtra, size: 4, data: sq.iExtra, divisor: 1 },
      ], indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    });
    this.geoSigns.count = 6;
    this.geoSigns.instances = this.signs.length;

    // вода: концентрические кольца + крупная сетка вдали
    const water = this.buildWaterMesh();
    this.geoWater = makeVAO(gl, {
      attribs: [{ loc: loc('water', 'aPos'), size: 3, data: water.pos }],
      indices: water.idx,
    });
    this.geoWater.count = water.idx.length;
  }

  buildGroundMesh() {
    const N = 150, S = W.WORLD, half = S / 2;
    const pos = new Float32Array((N + 1) * (N + 1) * 3);
    const nrm = new Float32Array((N + 1) * (N + 1) * 3);
    const uv = new Float32Array((N + 1) * (N + 1) * 2);
    const idx = new Uint32Array(N * N * 6);
    let p = 0, u = 0, k = 0;
    for (let iz = 0; iz <= N; iz++) {
      for (let ix = 0; ix <= N; ix++) {
        const x = (ix / N) * S - half, z = (iz / N) * S - half;
        const L = W.lakeField(x, z);
        // Плоскость города строго ровная: дома, трава, вывески и фонари расставлены
        // на y = 0, поэтому единственное допустимое смещение — чаша озера. Любая
        // любая «волна рельефа» открыла бы щель под стенами.

        let y = 0;
        if (L < 1.02) y = -clamp((1.02 - L) * 9.0, 0, 6.5);
        pos[p] = x; pos[p + 1] = y; pos[p + 2] = z;
        nrm[p] = 0; nrm[p + 1] = 1; nrm[p + 2] = 0;
        uv[u] = x + half; uv[u + 1] = z + half;
        p += 3; u += 2;
      }
    }
    for (let iz = 0; iz < N; iz++) {
      for (let ix = 0; ix < N; ix++) {
        const a = iz * (N + 1) + ix, b = a + 1, c = a + (N + 1), d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    // нормали по производной высот — иначе лужа на плоской сети не ловит блик
    for (let iz = 0; iz <= N; iz++) {
      for (let ix = 0; ix <= N; ix++) {
        const i = (iz * (N + 1) + ix) * 3;
        const h = (xx, zz) => {
          const L = W.lakeField(xx, zz);
          return L < 1.02 ? -clamp((1.02 - L) * 9.0, 0, 6.5) : 0;
        };
        const e = S / N;
        const dx = h(ix * e - half + e, iz * e - half) - h(ix * e - half - e, iz * e - half);
        const dz = h(ix * e - half, iz * e - half + e) - h(ix * e - half, iz * e - half - e);
        const nx = -dx / (2 * e), nz = -dz / (2 * e);
        const l = Math.hypot(nx, 1, nz) || 1;
        nrm[i] = nx / l; nrm[i + 1] = 1 / l; nrm[i + 2] = nz / l;
      }
    }
    return { pos, nrm, uv, idx };
  }

  buildBladeMesh() {
    // Лента из 4 сегментов: x — половина ширины (-1..1), y — доля высоты,
    // z — смещение «вперёд» для скрученности (его травинке даёт aPos.z).
    const pos2 = [], uv2 = [];
    for (let i = 0; i <= 4; i++) {
      const y = i / 4;
      pos2.push(-1, y, 0, 1, y, y * y * 0.30);
      uv2.push(0, y, 1, y);
    }
    const idx = [];
    for (let i = 0; i < 4; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    return { pos: new Float32Array(pos2), uv: new Float32Array(uv2), idx: new Uint16Array(idx) };
  }

  buildCrossMesh(planes) {
    const pos = [], uv = [], idx = [];
    const mk = (rot) => {
      const base = pos.length / 3;
      const c = Math.cos(rot), s = Math.sin(rot);
      for (const [x, y] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) {
        pos.push(x * c, y, -x * s);
        uv.push(x * 0.5 + 0.5, y);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2);   // с двух сторон
    };
    for (let i = 0; i < planes; i++) mk((i / planes) * Math.PI);
    return { pos: new Float32Array(pos), uv: new Float32Array(uv), idx: new Uint16Array(idx) };
  }

  packVeg() {
    const n = this.veg.length;
    const iPos = new Float32Array(n * 4), iShape = new Float32Array(n * 4), iExtra = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const v = this.veg[i], o = i * 4;
      iPos[o] = v.x; iPos[o + 1] = v.z; iPos[o + 2] = v.h; iPos[o + 3] = v.w;
      iShape[o] = v.rot; iShape[o + 1] = v.stiff; iShape[o + 2] = v.type; iShape[o + 3] = v.tint;
      iExtra[o] = v.seed; iExtra[o + 1] = v.phase; iExtra[o + 2] = v.press; iExtra[o + 3] = v.wet;
    }
    return { iPos, iShape, iExtra };
  }

  packSigns() {
    const n = this.signs.length;
    const iPos = new Float32Array(n * 4), iShape = new Float32Array(n * 4), iExtra = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const s = this.signs[i], o = i * 4;
      iPos[o] = s.x; iPos[o + 1] = s.z; iPos[o + 2] = s.y; iPos[o + 3] = s.w * 0.5;   // половина ширины
      iShape[o] = s.rot; iShape[o + 1] = s.tilt; iShape[o + 2] = s.h; iShape[o + 3] = s.cell;
      iExtra[o] = s.seed || 0.5; iExtra[o + 1] = s.phase; iExtra[o + 2] = s.bright; iExtra[o + 3] = s.mode;
    }
    return { iPos, iShape, iExtra };
  }

  buildWaterMesh() {
    // Кольца вокруг центра озера: чем дальше — тем крупнее ячейка. Плюс сетка
    // 340×250 в пределах boxes (чтобы у воды был «берег», а не край кольца).
    const pos = [], idx = [];
    const b = this.waterBox;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const rings = 46, seg = 96;
    const rmax = Math.max(b.maxX - cx, b.maxZ - cz) * 1.4;
    for (let r = 0; r <= rings; r++) {
      const t = r / rings;
      const rad = 2.0 + (rmax - 2.0) * t * t;
      for (let s = 0; s <= seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        pos.push(cx + Math.cos(a) * rad, 0, cz + Math.sin(a) * rad);
      }
    }
    const stride = seg + 1;
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < seg; s++) {
        const a = r * stride + s, c = a + stride;
        idx.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
    const ia = new Uint32Array(idx);
    return { pos: new Float32Array(pos), idx: ia };
  }

  // ------------------------------------------------------------------ GI-объём
  rebakeGI() {
    const T = TIMES[this.state.time];
    const day = T.day;
    const env = {
      day, sunDir: norm3(T.dir), sunCol: T.sun, skyCol: T.sky,
      rain: this.state.rain, snow: this.state.snow,
    };
    const t0 = performance.now();
    this.giVol = bakeGI(this.bld, this.lights, env);
    this.stats.gi = this.giVol.ms;
    this.giStat = giStats(this.giVol.data);
    void t0;
  }

  uploadGI() {
    const gl = this.gl;
    this.textures.gi = tex3D(gl, {
      size: this.giVol.size, data: this.giVol.data,
      internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE,
    });
  }

  // ------------------------------------------------------------------- таргеты
  resize() {
    const gl = this.gl;
    const q = QUALITY[this.state.quality];
    const dpr = clamp(window.devicePixelRatio || 1, 1, q.scale >= 1 ? 2 : 1.5) * q.scale;
    const w = Math.max(320, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(240, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.w = w; this.h = h;
    const mk = () => {
      for (const k of ['scene', 'ao', 'bloomA', 'bloomB', 'glass']) if (this.fbo && this.fbo[k]) this.destroy(this.fbo[k]);
      const half = 16, ms = this.gl.getParameter(gl.MAX_SAMPLES) || 0;
      const samples = 0;                       // MSAA выключена: SSAO берёт глубину из текстуры
      void ms;
      const hdr = gl.getExtension('EXT_color_buffer_float') ? gl.RGBA16F : gl.RGBA8;
      return {
        samples,
        hdr,
        scene: makeFBO(gl, w, h, { color: hdr, depth: true }),
        msaa: samples ? makeMSAA(gl, w, h, samples) : null,
        ao: makeFBO(gl, Math.max(1, w >> q.ssaoHalf), Math.max(1, h >> q.ssaoHalf), { color: gl.RGBA8, depth: false }),
        bloomA: makeFBO(gl, Math.max(1, w >> 2), Math.max(1, h >> 2), { color: hdr, depth: false }),
        bloomB: makeFBO(gl, Math.max(1, w >> 2), Math.max(1, h >> 2), { color: hdr, depth: false }),
        glass: makeFBO(gl, w, h, { color: hdr, depth: false }),
      };
    };
    this.fbo = mk();
    gl.viewport(0, 0, w, h);
  }

  destroy(f) {
    const gl = this.gl;
    if (!f) return;
    for (const t of f.color || []) gl.deleteTexture(t.tex);
    if (f.depthTex && f.depthTex.tex) gl.deleteTexture(f.depthTex.tex);
    if (f.fb) gl.deleteFramebuffer(f.fb);
  }

  // ---------------------------------------------------------------- ввод
  bindInput() {
    const c = this.canvas;
    const btn = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    btn('btn-panel', () => toggle('panel'));
    btn('btn-help', () => toggle('help'));
    addEventListener('keydown', (e) => {
      if (e.target && e.target.tagName === 'INPUT') return;
      this.keys.add(e.code);
      switch (e.code) {
        case 'KeyT': this.cycle(TIMES, 'time'); break;
        case 'KeyY': this.cycle(SEASONS, 'season'); break;
        case 'KeyR': this.state.rain = this.state.rain > 0.05 ? 0 : 0.65; this.syncUI(); this.rebakeGI(); this.uploadGI(); break;
        case 'KeyG': this.state.snow = this.state.snow > 0.05 ? 0 : 1; this.syncUI(); this.rebakeGI(); this.uploadGI(); break;
        case 'KeyB': this.rebakeGI(); this.uploadGI(); break;
        case 'KeyJ': this.state.windowRain = this.state.windowRain > 0.5 ? 0 : 1; break;
        case 'KeyC': this.state.cinema = this.state.cinema ? 0 : 1; break;
        case 'KeyF': this.showLightCones = !this.showLightCones; break;
        case 'KeyH': toggle('help'); break;
        case 'KeyP': toggle('panel'); break;
        case 'KeyS': this.snapshot(); break;
        case 'Digit1': this.setQuality('low'); break;
        case 'Digit2': this.setQuality('medium'); break;
        case 'Digit3': this.setQuality('high'); break;
        case 'KeyE': this.cam = [402, 9, -60]; this.target = [250, 4, -180]; break;
        default: break;
      }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    c.addEventListener('mousedown', (e) => { this.mouse.down = true; this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
    addEventListener('mouseup', () => { this.mouse.down = false; });
    addEventListener('mousemove', (e) => {
      if (!this.mouse.down) return;
      this.mouse.yaw -= (e.clientX - this.mouse.x) * 0.0035;
      this.mouse.pitch = clamp(this.mouse.pitch - (e.clientY - this.mouse.y) * 0.0032, -1.35, 1.35);
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.mouse.speed = clamp(this.mouse.speed * (e.deltaY > 0 ? 0.85 : 1.18), 0.25, 12);
    }, { passive: false });
    // тач: один палец — обзор, два — движение (для Android)
    let touch = null;
    c.addEventListener('touchstart', (e) => { const t = e.touches[0]; touch = [t.clientX, t.clientY]; }, { passive: true });
    c.addEventListener('touchmove', (e) => {
      if (!touch) return;
      const t = e.touches[0];
      this.mouse.yaw -= (t.clientX - touch[0]) * 0.005;
      this.mouse.pitch = clamp(this.mouse.pitch - (t.clientY - touch[1]) * 0.005, -1.3, 1.3);
      touch = [t.clientX, t.clientY];
      if (e.touches.length === 2) { this.moveVec = [0, 0, -6 * this.mouse.speed]; }
    }, { passive: true });
    c.addEventListener('touchend', () => { touch = null; this.moveVec = null; }, { passive: true });
  }

  cycle(dict, key) {
    const ks = Object.keys(dict);
    this.state[key] = ks[(ks.indexOf(this.state[key]) + 1) % ks.length];
    this.rebakeGI(); this.uploadGI(); this.syncUI();
    if (key === 'season') this.grass = W.buildGrassField(this.grassOpts());
  }

  setQuality(q) {
    if (q === this.state.quality) return;
    this.state.quality = q;
    this.grass = W.buildGrassField(this.grassOpts());   // новый потолок инстансов
    this.buildGPU();
    this.resize();
    this.syncUI();
  }

  syncUI() {
    const set = (id, v) => { const el = $(id); if (el) el.value = v; };
    set('sel-quality', this.state.quality);
    set('sel-time', this.state.time);
    set('sel-season', this.state.season);
    const chk = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
    chk('chk-gi', this.state.gi); chk('chk-ao', this.state.ao); chk('chk-bloom', this.state.bloom);
    chk('chk-window', this.state.windowRain); chk('chk-cinema', this.state.cinema);
    const rq = $('rng-rain'), rs = $('rng-snow'), rw = $('rng-wind');
    if (rq) rq.value = String(Math.round(this.state.rain * 100));
    if (rs) rs.value = String(Math.round(this.state.snow * 100));
    if (rw) rw.value = String(Math.round(this.state.wind * 100));
    const st = $('state');
    if (st) st.textContent = `${QUALITY[this.state.quality].label} · ${this.state.time} · ${this.state.season}`;
  }

  // ------------------------------------------------------------- общие uniform'ы
  globals(p, dt) {
    const gl = this.gl;
    const T = TIMES[this.state.time];
    const S = SEASONS[this.state.season];
    const day = T.day, sunDir = norm3(T.dir);
    const wet = clamp(Math.max(this.state.rain * 0.9, this.state.snow * 0.35), 0, 1);
    const fog = this.state.snow > 0.5 ? LOOK.fogSnow : (this.state.rain > 0.05 ? LOOK.fogWet : LOOK.fogClear);
    const seasonVec = S.season;
    p.set('uTime', this.time)
      .set('uSun', [sunDir[0], sunDir[1], sunDir[2], day])
      .set('uSkyTint', [T.sky[0], T.sky[1], T.sky[2], 1])
      .set('uFog', [fog.color[0], fog.color[1], fog.color[2], fog.density * (1 + this.state.snow)])
      .set('uWeather', [this.state.rain, wet, this.state.snow, this.state.wind])
      .set('uCamera', [this.cam[0], this.cam[1], this.cam[2], 1.75])
      .set('uViewProj', this.viewProj)
      .set('uInvViewProj', this.invViewProj)
      .set('uCamPos', this.cam)
      .set('uExposure', this.state.exposure);
    if (p.loc.u.uGIVol) p.tex('uGIVol', 12, this.textures.gi), p.set('uGIOn', this.state.gi ? 1 : 0);
    void gl; void seasonVec;
    return { day, sunDir, wet, S, T };
  }

  // ------------------------------------------------------------------ рендер
  render(dt) {
    const gl = this.gl;
    this.time = (this.time || 0) + dt;
    const q = QUALITY[this.state.quality];
    const S = SEASONS[this.state.season];
    let calls = 0, tris = 0;

    // --- сцена (MSAA, если включено) ---
    const target = this.fbo.msaa ? this.fbo.msaa.fb : this.fbo.scene.fb;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(0.02, 0.03, 0.05, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // 1) небо
    {
      const p = this.programs.sky.use();
      const g = this.globals(p, dt);
      const C = LOOK.sky.clouds.slice();
      C[0] = clamp(C[0] * (0.6 + 0.9 * (g.day < 0.4 ? 1.2 : 1)) + this.state.rain * 0.35, 0, 1);
      C[3] = this.time * 0.004;
      p.set('uClouds', C).set('uCloudTint', LOOK.sky.tint).set('uMoonPhase', LOOK.sky.moonPhase);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.bindVertexArray(this.fullscreen.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
      calls++;
    }

    // 2) земля
    {
      const p = this.programs.ground.use();
      this.globals(p, dt);
      p.tex('uLayers', 0, this.textures.layers)
       .tex('uGroundAlbedo', 1, this.textures.ground)
       .set('uGroundTile', LOOK.ground.tile)
       .set('uGroundParam', [LOOK.ground.param[0], LOOK.ground.param[1], LOOK.ground.param[2],
                             S.snow ? 0.85 : LOOK.ground.param[3]])
       .set('uSeason', S.season);
      gl.bindVertexArray(this.geoGround.vao);
      gl.drawElements(gl.TRIANGLES, this.geoGround.count, gl.UNSIGNED_INT, 0);
      calls++; tris += this.geoGround.count / 3;
    }

    // 3) фасады + фонарные столбы
    {
      const p = this.programs.facade.use();
      this.globals(p, dt);
      const city = LOOK.facade.city.slice();
      city[1] = clamp((1 - city[0]) * 0.55 + 0.25, 0.2, 0.9);
      p.tex('uFacadeAlbedo', 2, this.textures.facade)
       .tex('uFacadeNrm', 3, this.textures.facadeNrm)
       .tex('uSignAtlas', 4, this.textures.signs)
       // сетка атласа вывесок одна на facade и emissive (signUV в common.glsl),
       // числа те же, что в assets/beijing_signs.json
       .set('uSignGrid', LOOK.emissive.grid)
       .set('uFacadeTile', LOOK.facade.tile)
       .set('uCityParam', city)
       .set('uNightWarm', LOOK.facade.nightWarm)
       .set('uLitSeed', this.time * 0.01);
      gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
      gl.bindVertexArray(this.geoFacade.vao);
      gl.drawElements(gl.TRIANGLES, this.geoFacade.count, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(this.geoLamps.vao);
      gl.drawElements(gl.TRIANGLES, this.geoLamps.count, gl.UNSIGNED_INT, 0);
      gl.disable(gl.CULL_FACE);
      calls += 2; tris += (this.geoFacade.count + this.geoLamps.count) / 3;
    }

    // 4) листва (бамбук, пальмы, кусты, ёлка)
    {
      const p = this.programs.veg.use();
      this.globals(p, dt);
      p.tex('uVegAtlas', 5, this.textures.veg)
       .tex('uVegRough', 6, this.textures.vegRough)
       .set('uVegParam', LOOK.veg.param)
       .set('uHeight', LOOK.veg.height * S.vegH)
       .set('uWindDir', this.windVec)
       .set('uWindStrength', this.state.wind * (0.55 + 0.45 * q.detail))
       .set('uGust', 0.5 + 0.5 * Math.sin(this.time * 0.31))
       .set('uSeason', S.season);
      gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT);          // cross-квады: только дальние плоскости
      gl.bindVertexArray(this.geoVeg.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, this.geoVeg.count, gl.UNSIGNED_SHORT, 0, this.geoVeg.instances);
      gl.disable(gl.CULL_FACE);
      calls++; tris += (this.geoVeg.count / 3) * this.geoVeg.instances;
    }

    // 5) трава
    if (this.geoGrass.instances > 0) {
      const p = this.programs.grass.use();
      this.globals(p, dt);
      p.tex('uBladeAtlas', 7, this.textures.grass)
       .tex('uTurfTex', 8, this.textures.turf)
       .set('uGrassParam', LOOK.grass.param)
       .set('uHeight', LOOK.grass.height)        // сезон и масштаб уже запечены в поле
       .set('uCut', LOOK.grass.cut)
       .set('uAlphaCutoff', this.state.rain > 0.3 ? 0.30 : LOOK.grass.cutoff)
       .set('uShadowStrength', q.shadows)
       .set('uSeason', S.season)
       .set('uWindDir', this.windVec)
       .set('uWindStrength', this.state.wind)
       .set('uGust', 0.5 + 0.5 * Math.sin(this.time * 0.27));
      gl.bindVertexArray(this.geoGrass.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, this.geoGrass.count, gl.UNSIGNED_SHORT, 0, this.geoGrass.instances);
      calls++; tris += (this.geoGrass.count / 3) * this.geoGrass.instances;
      this.stats.grass = this.geoGrass.instances;
    }

    // 6) вода
    {
      const p = this.programs.water.use();
      this.globals(p, dt);
      const Wt = LOOK.water;
      p.tex('uDepth', 9, this.textures.waterDepth)
       .tex('uFoam', 10, this.textures.waterFoam)
       .set('uWaterBox', [this.waterBox.minX, this.waterBox.minZ,
                          this.waterBox.maxX - this.waterBox.minX, this.waterBox.maxZ - this.waterBox.minZ])
       .set('uAmp', Wt.amp * (1 + this.state.wind * 0.9))
       .set('uChop', Wt.chop)
       .set('uWaterColor', Wt.color)
       .set('uWaterParam', [Wt.param[0] * q.detail, Wt.param[1], Wt.param[2] * (1 + this.state.wind), Wt.param[3]])
       .set('uBedColor', Wt.bed)
       .set('uSunColorLin', Wt.sun);
      gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
      gl.bindVertexArray(this.geoWater.vao);
      gl.drawElements(gl.TRIANGLES, this.geoWater.count, gl.UNSIGNED_INT, 0);
      gl.disable(gl.CULL_FACE);
      calls++; tris += this.geoWater.count / 3;
    }

    // 7) вывески, фонари, гирлянды — эмиссия, аддитивно
    {
      const p = this.programs.emissive.use();
      this.globals(p, dt);
      const E = LOOK.emissive.param.slice();
      E[1] = 0.30 + 0.35 * (1 - TIMES[this.state.time].day);
      p.tex('uEmissive', 13, this.textures.signs)
       .set('uEmitParam', E)
       .set('uSignGrid', LOOK.emissive.grid);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      gl.bindVertexArray(this.geoSigns.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, this.geoSigns.count, gl.UNSIGNED_SHORT, 0, this.geoSigns.instances);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      calls++; tris += 2 * this.geoSigns.instances;
    }

    if (this.fbo.msaa) {
      blitTo(gl, this.fbo.msaa.fb, this.fbo.scene.fb, this.w, this.h);
    }

    // --- постпроходы на 1/4 и полный экран ---
    const half = { w: this.fbo.ao.width, h: this.fbo.ao.height };
    if (q.ao > 0 && this.state.ao) {
      const p = this.programs.ssao.use();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.ao.fb);
      gl.viewport(0, 0, half.w, half.h);
      gl.disable(gl.DEPTH_TEST);
      p.tex('uDepth', 0, this.fbo.scene.depthTex)
       .set('uRes', [half.w, half.h])
       .set('uSSAO', [LOOK.post.ssao[0], LOOK.post.ssao[1] * q.ao, LOOK.post.ssao[2], LOOK.post.ssao[3]])
       .set('uNearFar', LOOK.post.nearFar)
       .set('uViewProj', this.viewProj).set('uInvViewProj', this.invViewProj)
       .set('uCamPos', this.cam).set('uTime', this.time);
      gl.bindVertexArray(this.fullscreen.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      calls++;
    }
    if (q.bloom && this.state.bloom) {
      const bw = this.fbo.bloomA.width, bh = this.fbo.bloomA.height;
      const p = this.programs.bloom.use();
      for (let pass = 0; pass < 2; pass++) {
        const dst = pass === 0 ? this.fbo.bloomA : this.fbo.bloomB;
        const src = pass === 0 ? this.fbo.scene : this.fbo.bloomA;
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
        gl.viewport(0, 0, bw, bh);
        p.tex('uSrc', 0, src.color[0])
         .set('uTexel', [1 / bw * (pass ? 2.1 : 1), 1 / bh * (pass ? 1 : 2.1)])
         .set('uBloom', LOOK.post.bloom)
         .set('uExposure', this.state.exposure);
        gl.bindVertexArray(this.fullscreen.vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        calls++;
      }
    }
    let finalSrc = this.fbo.scene;
    if (this.state.windowRain > 0.5 && this.state.rain > 0.02) {
      const p = this.programs.rainwin.use();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.glass.fb);
      gl.viewport(0, 0, this.w, this.h);
      p.tex('uScene', 0, this.fbo.scene.color[0])
       .set('uRes', [this.w, this.h])
       .set('uRainParam', [this.state.rain, LOOK.rainWindow.param[1], LOOK.rainWindow.param[2], LOOK.rainWindow.param[3]])
       .set('uThrough', 0)
       .set('uTime', this.time);
      gl.bindVertexArray(this.fullscreen.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      finalSrc = this.fbo.glass;
      calls++;
    }
    {
      const p = this.programs.post.use();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.w, this.h);
      const rain = this.state.rain;
      p.tex('uScene', 0, finalSrc.color[0])
       .tex('uBloomTex', 1, (this.state.bloom && q.bloom ? this.fbo.bloomB.color[0] : null) || this.textures.blank)
       .tex('uAO', 2, (this.state.ao && q.ao > 0 ? this.fbo.ao.color[0] : null) || this.textures.blank)
       .set('uPost', [q.bloom && this.state.bloom ? LOOK.post.bloom[3] : 0,
                      this.state.ao && q.ao > 0 ? LOOK.post.ao : 0,
                      this.state.cinema ? 0.55 : LOOK.post.vignette,
                      LOOK.post.grain])
       .set('uRainAir', [rain, -0.25, 0.5 + rain * 0.8, this.state.windowRain > 0.5 ? 1 : rain * 0.4])
       .set('uRes', [this.w, this.h])
       .set('uFlash', this.flash || 0)
       .set('uTime', this.time)
       .set('uExposure', this.state.exposure)
       .set('uCamera', [this.cam[0], this.cam[1], this.cam[2], 1.75])
       .set('uFog', [LOOK.fogClear.color[0], LOOK.fogClear.color[1], LOOK.fogClear.color[2], 1]);
      gl.bindVertexArray(this.fullscreen.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      calls++;
    }
    gl.bindVertexArray(null);
    this.stats.calls = calls;
    this.stats.tris = tris;
  }

  // --------------------------------------------------------------- камера/цикл
  update(dt) {
    this.frameN = (this.frameN || 0) + 1;
    if ((this.frameN & 7) === 0) this.refreshGrass(false);
    const k = this.keys, sp = 26 * this.mouse.speed * (k.has('ShiftLeft') ? 4 : 1) * dt;
    const fwd = [Math.sin(this.mouse.yaw) * Math.cos(this.mouse.pitch), 0, Math.cos(this.mouse.yaw) * Math.cos(this.mouse.pitch)];
    const rl = [fwd[2], 0, -fwd[0]];
    const n = Math.hypot(fwd[0], fwd[2]) || 1;
    fwd[0] /= n; fwd[2] /= n;
    let mv = [0, 0, 0];
    const add = (v, s) => { mv[0] += v[0] * s; mv[1] += v[1] * s; mv[2] += v[2] * s; };
    if (k.has('KeyW')) add(fwd, sp);
    if (k.has('KeyS')) add(fwd, -sp);
    if (k.has('KeyA')) add(rl, -sp);
    if (k.has('KeyD')) add(rl, sp);
    if (k.has('Space')) mv[1] += sp;
    if (k.has('ControlLeft') || k.has('KeyQ')) mv[1] -= sp;
    if (this.moveVec) add([fwd[0], 0, fwd[2]], this.moveVec[2]);
    this.cam = [this.cam[0] + mv[0], clamp(this.cam[1] + mv[1], 1.2, 320), this.cam[2] + mv[2]];
    // кинематографический режим: медленный облёт площади с ёлкой
    if (this.state.cinema) {
      const a = this.time * 0.055;
      this.cam = [6 + Math.cos(a) * 92, 16 + 6 * Math.sin(a * 0.7), -20 + Math.sin(a) * 92];
      this.target = [6, 8, -20];
      this.mouse.yaw = Math.atan2(this.cam[0] - 6, this.cam[2] + 20);
      this.mouse.pitch = -0.09;
    } else if (!this.keys.size) {
      // свободный полёт «от мыши»: цель — точка перед камерой
      this.target = [this.cam[0] + fwd[0] * 10, this.cam[1] + Math.sin(this.mouse.pitch) * 10,
                    this.cam[2] + fwd[2] * 10];
    }
    const eye = [this.cam[0], this.cam[1], this.cam[2]];
    const titleEl = $('title');
    if (titleEl) titleEl.textContent = `ShopSim · ${this.state.time} · ${QUALITY[this.state.quality].label}`;
    perspective(this.proj || (this.proj = mat4()), 52 * Math.PI / 180, this.w / this.h, 0.25, 1500);
    lookAt(this.view || (this.view = mat4()), eye, this.target, [0, 1, 0]);
    mul4(this.viewProj || (this.viewProj = mat4()), this.proj, this.view);
    invert4(this.invViewProj || (this.invViewProj = mat4()), this.viewProj);
    const wd = this.state.wind;
    const ang = this.time * 0.02;
    this.windVec = [Math.cos(ang) * (0.6 + 0.4 * wd), Math.sin(ang) * (0.6 + 0.4 * wd)];
    if (this.state.rain > 0.4 && Math.random() < dt * 0.12) this.flashT = 0.5;
    this.flash = this.flashT ? Math.max(0, (this.flashT -= dt) > 0 ? Math.pow(this.flashT / 0.5, 2) : 0) : 0;
  }

  frameLoop() {
    if (!this.running) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    try {
      this.update(dt);
      this.render(dt);
    } catch (e) {
      this.running = false;
      this.fatal(e);
      return;
    }
    this.stats.ms = lerp(this.stats.ms || 0, performance.now() - now, 0.1);
    this.stats.fps = lerp(this.stats.fps || 60, 1 / Math.max(dt, 1e-4), 0.08);
    if ((this.frame++ & 15) === 0) this.drawStats();
    requestAnimationFrame(() => this.frameLoop());
  }

  drawStats() {
    const el = $('stats');
    if (!el) return;
    const s = this.stats;
    const gi = this.giStat || { irradiance: 0, skyVis: 0 };
    const miss = Object.entries(this.programs).filter(([, p]) => p.missing.size).map(([n, p]) => `${n}: ${[...p.missing].join(', ')}`);
    el.innerHTML = [
      `fps <b>${s.fps.toFixed(0)}</b> · ${s.ms.toFixed(1)} ms`,
      `треуг. <b>${(s.tris / 1e6).toFixed(2)}M</b> · вызовов ${s.calls}`,
      `трава <b>${(s.grass / 1000).toFixed(0)}k</b> · листва ${(this.veg.length / 1000).toFixed(1)}k`,
      `вывески ${this.signs.length} · GI ${s.gi} мс`,
      `освещ. ${gi.irradiance.toFixed(3)} · небо ${gi.skyVis.toFixed(2)}`,
      `${this.w}×${this.h}px`,
      miss.length ? `⚠ нет в контракте: ${miss.join(' | ')}` : `uniform-контракт: ок`,
    ].join('<br>');
  }

  /** Снимок для авотестов: dataURL без скачивания. */
  dataURL() { return this.canvas.toDataURL('image/png'); }

  snapshot() {
    this.canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `shopsim_${this.state.time}_${this.state.season}_q${this.state.quality}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  }

  fatal(e) {
    console.error(e);
    const box = $('err');
    if (box) {
      box.classList.remove('hide');
      box.textContent = (e.stack || e.message || String(e)).slice(0, 4000);
    } else alert(String(e && e.stack || e));
  }
}

// --- UI -------------------------------------------------------------------
function toggle(id) { const el = $(id); if (el) el.classList.toggle('hide'); }

function wireUI(app) {
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('input', () => { fn(el); echo(id, el); }); };
  on('sel-quality', (el) => app.setQuality(el.value));
  on('sel-time', (el) => { app.state.time = el.value; app.rebakeGI(); app.uploadGI(); });
  on('sel-season', (el) => { app.state.season = el.value; });
  on('rng-rain', (el) => { app.state.rain = +el.value / 100; app.rebakeGI(); app.uploadGI(); });
  on('rng-snow', (el) => { app.state.snow = +el.value / 100; app.rebakeGI(); app.uploadGI(); });
  on('rng-wind', (el) => { app.state.wind = +el.value / 100; });
  on('rng-exposure', (el) => { app.state.exposure = +el.value / 100; });
  on('rng-grass', (el) => {
    app.state.grassScale = +el.value / 100;
    app.grass = W.buildGrassField(app.grassOpts());     // высота запечена в поле
  });
  on('chk-gi', (el) => { app.state.gi = el.checked ? 1 : 0; });
  on('chk-ao', (el) => { app.state.ao = el.checked ? 1 : 0; });
  on('chk-bloom', (el) => { app.state.bloom = el.checked ? 1 : 0; });
  on('chk-window', (el) => { app.state.windowRain = el.checked ? 1 : 0; });
  on('chk-cinema', (el) => { app.state.cinema = el.checked ? 1 : 0; });
  const btn = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  btn('btn-gi', () => { app.rebakeGI(); app.uploadGI(); });
  btn('btn-shot', () => app.snapshot());
  btn('btn-rebuild', () => { app.buildWorld(); app.rebakeGI(); app.uploadGI(); app.buildGPU(); });
  // кнопки телепорта: data-view="x,y,z,tx,ty,tz"
  for (const el of document.querySelectorAll('[data-view]')) {
    el.addEventListener('click', () => {
      const v = el.getAttribute('data-view').split(',').map(Number);
      app.cam = [v[0], v[1], v[2]];
      app.target = [v[3], v[4], v[5]];
      app.mouse.yaw = Math.atan2(v[3] - v[0], v[5] - v[2]);
      app.mouse.pitch = Math.atan2(v[4] - v[1], Math.hypot(v[3] - v[0], v[5] - v[2]));
      app.state.cinema = 0;
      const cb = $('chk-cinema'); if (cb) cb.checked = false;
    });
  }
}

/** Живые подписи у ползунков — чтобы значение было видно на самом контроле. */
function echo(id, el) {
  const map = { 'rng-rain': 'out-rain', 'rng-snow': 'out-snow', 'rng-wind': 'out-wind',
                'rng-exposure': 'out-exposure', 'rng-grass': 'out-grass' };
  const out = $(map[id]);
  if (out) out.textContent = id === 'rng-exposure' ? (el.value / 100).toFixed(2) : `${el.value}%`;
}

// Параметры из URL — чтобы автотест и «ссылка на момент» работали без кликов:
//   ?view=x,y,z,tx,tz&t=night&season=winter&rain=0.6&q=low&clean=1&freeze=1
function applyQuery(app) {
  const q = new URLSearchParams(location.search);
  const st = app.state;
  if (q.has('view')) {
    const v = q.get('view').split(',').map(Number);
    if (v.length >= 3 && v.every(Number.isFinite)) {
      app.cam = [v[0], v[1], v[2]];
      app.target = v.length >= 6 ? [v[3], v[4], v[5]] : [v[0] + 10, v[1] - 2, v[2] + 10];
      app.mouse.yaw = Math.atan2(app.target[0] - v[0], app.target[2] - v[2]);
      app.mouse.pitch = Math.atan2(app.target[1] - v[1], Math.hypot(app.target[0] - v[0], app.target[2] - v[2]));
    }
  }
  if (TIMES[q.get('t')]) st.time = q.get('t');
  if (SEASONS[q.get('season')]) st.season = q.get('season');
  if (q.has('rain')) st.rain = clamp(+q.get('rain'), 0, 1);
  if (q.has('snow')) st.snow = clamp(+q.get('snow'), 0, 1);
  if (q.has('wind')) st.wind = clamp(+q.get('wind'), 0, 1);
  if (q.has('expo')) st.exposure = clamp(+q.get('expo'), 0.2, 4);
  if (q.has('grass')) st.grassScale = clamp(+q.get('grass'), 0, 2);
  if (QUALITY[q.get('q')]) st.quality = q.get('q');
  if (q.has('gi')) st.gi = +q.get('gi') ? 1 : 0;
  if (q.has('ao')) st.ao = +q.get('ao') ? 1 : 0;
  if (q.has('bloom')) st.bloom = +q.get('bloom') ? 1 : 0;
  if (q.has('win')) st.windowRain = +q.get('win') ? 1 : 0;
  if (q.get('clean') === '1') {
    for (const el of document.querySelectorAll('.ui')) el.style.display = 'none';
  }
  app.freeze = q.get('freeze') === '1';
  if (app.freeze) st.cinema = 0;
}

/** Снимок по требованию: window.__shot().then(dataURL) — для скриншот-теста. */
function exposeHooks(app) {
  window.__ready = true;
  window.__shot = async () => { app.render(0.016); return app.dataURL(); };
  window.__state = () => ({ ...app.stats, giStat: app.giStat, quality: app.state.quality,
                             time: app.state.time, season: app.state.season, sizes: [app.w, app.h] });
  window.__set = (k, v) => { app.state[k] = v; if (k === 'time' || k === 'rain' || k === 'snow') { app.rebakeGI(); app.uploadGI(); } };
}

window.addEventListener('DOMContentLoaded', async () => {
  const app = new App();
  window.__app = app;
  applyQuery(app);
  try {
    await app.init();
    wireUI(app);
    app.syncUI();
    exposeHooks(app);
    if (app.freeze) { app.running = false; app.update(0.016); app.render(0.016); }
  } catch (e) {
    app.fatal(e);
  }
});

export { App, srgb2lin, toSRGB };
