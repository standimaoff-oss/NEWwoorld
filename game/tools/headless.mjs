#!/usr/bin/env node
/* Полная проверка игры БЕЗ браузера: jsdom + поддельные WebGL2/2D-контексты.
 *
 * Зачем: node --check и логические тесты не ловят ошибки сборки мира, шейдерных
 * материалов и UI. Здесь игра реально загружается целиком: строится город,
 * открываются панели, считается экономика, переключаются сезоны, читается и
 * пишется сохранение. GLSL не компилируется (контекст фиктивный), поэтому
 * визуальную часть всё равно надо смотреть глазами.
 *
 * Запуск:
 *   cd game && npm i --no-save jsdom
 *   node game/tools/headless.mjs
 *
 * Код возврата 1, если хоть одна проверка упала.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import module from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const SAVE_FILE = path.join(os.tmpdir(), 'shopsim-headless-save.json');
const withSave = process.argv.includes('--with-save');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.error('Нужен jsdom:  cd game && npm i --no-save jsdom');
  process.exit(2);
}

const GLC = {
  VERSION: 0x1F02, SHADING_LANGUAGE_VERSION: 0x8B8C, VENDOR: 0x1F00, RENDERER: 0x1F01,
  MAX_TEXTURE_SIZE: 0x0D33, MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C, MAX_3D_TEXTURE_SIZE: 0x8073,
  MAX_ARRAY_TEXTURE_LAYERS: 0x88FF, MAX_SAMPLES: 0x8D57, MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD, MAX_VARYING_VECTORS: 0x8DFC,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D, MAX_RENDERBUFFER_SIZE: 0x84E8, MAX_DRAW_BUFFERS: 0x8824,
  MAX_COLOR_ATTACHMENTS: 0x8CDF, LINK_STATUS: 0x8B82, COMPILE_STATUS: 0x8B81,
  ACTIVE_UNIFORMS: 0x8B86, ACTIVE_ATTRIBUTES: 0x8B89, ACTIVE_UNIFORM_BLOCKS: 0x8B84,
  FRAMEBUFFER_COMPLETE: 0x8CD5, TIMEOUT_EXPIRED: 0x911B, CONDITION_SATISFIED: 0x911C,
};

function makeGL(canvas) {
  const base = {
    canvas, drawingBufferWidth: canvas.width || 800, drawingBufferHeight: canvas.height || 450,
    getParameter(p) {
      switch (p) {
        case GLC.VERSION: return 'WebGL 2.0 (fake)';
        case GLC.SHADING_LANGUAGE_VERSION: return 'WebGL GLSL ES 3.00 (fake)';
        case GLC.VENDOR: return 'fake';
        case GLC.RENDERER: return 'fake-gl';
        case GLC.MAX_TEXTURE_SIZE: case GLC.MAX_CUBE_MAP_TEXTURE_SIZE:
        case GLC.MAX_RENDERBUFFER_SIZE: case 0x0D3A: return 8192;
        case GLC.MAX_3D_TEXTURE_SIZE: case GLC.MAX_ARRAY_TEXTURE_LAYERS: return 2048;
        case GLC.MAX_SAMPLES: case GLC.MAX_DRAW_BUFFERS: case GLC.MAX_COLOR_ATTACHMENTS:
        case GLC.MAX_VERTEX_ATTRIBS: case GLC.MAX_TEXTURE_IMAGE_UNITS:
        case GLC.MAX_VERTEX_TEXTURE_IMAGE_UNITS: return 16;
        case GLC.MAX_COMBINED_TEXTURE_IMAGE_UNITS: return 32;
        case GLC.MAX_VERTEX_UNIFORM_VECTORS: case GLC.MAX_FRAGMENT_UNIFORM_VECTORS: return 1024;
        case GLC.MAX_VARYING_VECTORS: return 15;
        case 0x0C10: case 0x0BA2: return new Int32Array([0, 0, canvas.width || 800, canvas.height || 450]);
        default: return 0;
      }
    },
    getExtension(n) {
      if (/anisotropic/i.test(n)) return { MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84E8, TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE };
      if (/debug_renderer_info/.test(n)) return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
      if (/lose_context/.test(n)) return { loseContext() {}, restoreContext() {} };
      return null;
    },
    getSupportedExtensions() { return []; },
    getShaderPrecisionFormat() { return { precision: 23, rangeMin: 127, rangeMax: 127 }; },
    getShaderParameter() { return true; },
    getProgramParameter(p, n) { return n === GLC.LINK_STATUS ? true : 0; },
    getShaderInfoLog() { return ''; }, getProgramInfoLog() { return ''; },
    getUniformLocation() { return { u: 1 }; }, getAttribLocation() { return -1; },
    getActiveUniform() { return null; }, getActiveAttrib() { return null; },
    getUniformBlockIndex() { return -1; }, getActiveUniformBlockParameter() { return 0; },
    getActiveUniforms() { return []; }, getActiveUniformBlockName() { return ''; },
    checkFramebufferStatus() { return GLC.FRAMEBUFFER_COMPLETE; },
    isContextLost() { return false; }, getError() { return 0; },
    getContextAttributes() {
      return { alpha: false, antialias: true, depth: true, stencil: true, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'default', failIfMajorPerformanceCaveat: false, desynchronized: false };
    },
    createTexture() { return { id: 1 }; }, createFramebuffer() { return { id: 2 }; },
    createRenderbuffer() { return { id: 3 }; }, createBuffer() { return { id: 4 }; },
    createProgram() { return { id: 5 }; }, createShader() { return { id: 6 }; },
    createVertexArray() { return { id: 7 }; }, createSampler() { return { id: 8 }; },
    createQuery() { return { id: 9 }; },
    clientWaitSync() { return GLC.CONDITION_SATISFIED; }, getSyncParameter() { return 0; },
    fenceSync() { return { id: 10 }; }, deleteSync() {},
  };
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'string' && k in GLC) return GLC[k];
      if (typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k)) return 0;
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function make2d(canvas) {
  const grad = () => ({ addColorStop() {} });
  const base = {
    canvas,
    measureText: (t) => ({ width: (t || '').length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: grad, createRadialGradient: grad, createConicGradient: grad,
    createPattern: () => ({}),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)), width: w, height: h }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)), width: w, height: h }),
    putImageData() {}, getLineDash: () => [],
  };
  return new Proxy(base, {
    get(t, k) { return k in t ? t[k] : () => {}; },
    set(t, k, v) { t[k] = v; return true; },
  });
}

/* ---- canvas: поддельные 2D и WebGL2 ---- */
function installCanvasStubs(win) {
    const canvases = new WeakMap();
  win.HTMLCanvasElement.prototype.getContext = function (type) {
    if (type === '2d') { if (!canvases.has(this)) canvases.set(this, make2d(this)); return canvases.get(this); }
    if (type === 'webgl2' || type === 'webgl') { if (!canvases.has(this)) canvases.set(this, makeGL(this)); return canvases.get(this); }
    return null;
  };
  win.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
  win.HTMLCanvasElement.prototype.requestPointerLock = () => {};
  win.Element.prototype.requestPointerLock = () => {};
  win.Element.prototype.requestFullscreen = () => Promise.resolve();
  win.Element.prototype.webkitRequestFullscreen = () => {};
  win.document.exitFullscreen = () => Promise.resolve();
  if (!win.ResizeObserver) {
    win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  win.requestAnimationFrame = win.requestAnimationFrame || ((cb) => setTimeout(() => cb(performance.now()), 16));
  win.cancelAnimationFrame = win.cancelAnimationFrame || clearTimeout;
  class FakeAudioCtx {
    constructor() { this.destination = {}; this.currentTime = 0; this.state = 'running'; this.sampleRate = 48000; }
    createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createOscillator() { return { frequency: { value: 440, setValueAtTime() {} }, type: 'sine', connect() {}, start() {}, stop() {} }; }
    createBuffer() { return { getChannelData: () => new Float32Array(1024) }; }
    createBufferSource() { return { buffer: null, connect() {}, start() {}, stop() {} }; }
    createBiquadFilter() { return { type: 'lowpass', frequency: { value: 440 }, connect() {} }; }
    createPanner() { return { positionX: {}, positionY: {}, positionZ: {}, connect() {} }; }
    resume() { return Promise.resolve(); }
  }
  win.AudioContext = win.webkitAudioContext = FakeAudioCtx;

}


const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Загружает index.html и настоящие модули игры. */
async function bootGame(url, savedJSON) {
  const html = fs.readFileSync(path.join(GAME, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  if (savedJSON) win.localStorage.setItem('shopsim.save.v6', savedJSON);
  installCanvasStubs(win);
  installGlobals(win);
  module.register(pathToFileURL(path.join(GAME, 'tools/three-loader.mjs')).href, import.meta.url);
  const logs = [];
  win.addEventListener('error', (e) => logs.push('window: ' + e.message));
  process.on('unhandledRejection', (e) => logs.push('unhandled: ' + (e && (e.stack || e.message))));
  await import(pathToFileURL(path.join(GAME, 'src/main.js')).href);
  for (let i = 0; i < 240; i++) { if (win.__ready) break; await wait(250); }
  return { win, logs };
}

function installGlobals(win) {
  const define = (k, v) => {
    try { Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); }
    catch { globalThis[k] = v; }
  };
  for (const k of ['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage',
    'requestAnimationFrame', 'cancelAnimationFrame', 'HTMLElement', 'HTMLCanvasElement', 'Element', 'Node',
    'getComputedStyle', 'matchMedia', 'ResizeObserver', 'AudioContext', 'webkitAudioContext', 'Image',
    'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'TouchEvent', 'PointerEvent']) define(k, win[k]);
  define('self', win);
  define('devicePixelRatio', 1);
}

/* ---------- сценарий ---------- */
const fmt = (o) => JSON.stringify(o);
const snap = (win) => {
  const r = win.__game.renderer;
  return { calls: r.drawCalls, tris: Math.round(r.triangles) };
};

async function main() {
  /* 1. Загрузка с сохранением (если передали файл) */
  if (withSave) {
    const saved = fs.readFileSync(SAVE_FILE, 'utf8');
    const { win, logs } = await bootGame('http://localhost/?nohud=1&quality=low&hour=10', saved);
    const g = win.__game;
    const errs = (win.ShopLog && win.ShopLog.dump().errors) || [];
    const state = g ? {
      money: Math.round(g.money),
      player: g.player.pos.toArray().map((v) => +v.toFixed(1)),
      owned: g.shops.filter((s) => s.owned).length,
      hour: +g.weather.hour.toFixed(2),
    } : null;
    console.log('BOOT_WITH_SAVE', win.__ready ? 'OK' : 'FAIL', fmt(state));
    if (errs.length) console.log('ERRORS', fmt(errs.slice(0, 3)));
    if (logs.length) console.log('LOGS', fmt(logs.slice(0, 3)));
    process.exit(win.__ready && !(errs.length) ? 0 : 1);
  }

  /* 2. Чистая загрузка + встроенный тест (?test) */
  const { win, logs } = await bootGame('http://localhost/?test=1&fresh=1&nohud=1&quality=low&hour=10');
  if (!win.__ready) {
    console.error('ИГРА НЕ ЗАГРУЗИЛАСЬ');
    if (logs.length) console.error(logs.slice(0, 5).join('\n'));
    const errs = win.ShopLog ? win.ShopLog.dump().errors : [];
    if (errs.length) console.error(errs.slice(0, 5).join('\n'));
    process.exit(1);
  }
  for (let i = 0; i < 240; i++) { if (win.__testReport) break; await wait(250); }

  let failed = 0;
  const rep = win.__testReport;
  if (!rep) { console.error('НЕТ ОТЧЁТА ВСТРОЕННОГО ТЕСТА'); failed++; }
  else {
    for (const r of rep.results) {
      if (!r.ok) failed++;
      console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.info ? ' — ' + r.info : ''));
    }
    console.log(`ВСТРОЕННЫЙ ТЕСТ: ${rep.ok}/${rep.total}`);
  }

  /* 3. Стоимость кадра: лето против зимы */
  const g = win.__game;
  const season = async (s) => {
    g.settings.season = s;
    g.applySeason();
    await wait(2000);
    return { season: s, grass: g.grass.enabled, snow: +g.weather.snowAmount.toFixed(2), ...snap(win) };
  };
  const summer = await season('summer');
  const winter = await season('winter');
  console.log('ЛЕТО  ', fmt(summer));
  console.log('ЗИМА  ', fmt(winter));
  console.log(`ЗИМА/ЛЕТО: вызовов ${(winter.calls / summer.calls * 100).toFixed(0)}%, треугольников ${(winter.tris / summer.tris * 100).toFixed(0)}%`);
  if (winter.grass !== false) { console.log('FAIL зимой трава всё ещё рисуется'); failed++; }
  if (winter.tris >= summer.tris) { console.log('FAIL зимой не меньше треугольников'); failed++; }

  /* 4. Сохранение и повторный запуск */
  g.setSeason('summer');
  await wait(500);
  g.gameplay.save();
  const raw = win.localStorage.getItem('shopsim.save.v6');
  fs.writeFileSync(SAVE_FILE, raw || '');
  console.log('СОХРАНЕНИЕ', raw ? raw.length + ' байт' : 'FAIL');
  if (!raw) failed++;

  const errs = (win.ShopLog && win.ShopLog.dump().errors) || [];
  if (errs.length) { console.log('ОШИБКИ В ЖУРНАЛЕ', fmt(errs.slice(0, 3))); failed++; }
  if (logs.length) console.log('ПЕРЕХВАЧЕНО', fmt(logs.slice(0, 3)));

  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--with-save'], { stdio: 'inherit' });
  if (child.status !== 0) { console.log('FAIL повторный запуск с сохранением'); failed++; }

  console.log(failed ? `ПРОВАЛЕНО ПРОВЕРОК: ${failed}` : 'ВСЁ ЧИСТО');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
