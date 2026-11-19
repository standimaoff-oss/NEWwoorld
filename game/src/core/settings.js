/* Настройки, качество графики, сохранения. */
export const VERSION = '0.6.2';
export const BUILD_NAME = 'Realtime Grass';

const Q = {
  low:    { name: 'низко',   grass: 0.30, grassDist: 28,  shadows: false, shadowSize: 0,    pixelRatio: 1.0,  aa: false, skyClouds: 0,  water: 0, cloudRes: 64,  fog: 0.0, decals: 0.4, people: 0.5, rain: 0.5 },
  medium: { name: 'средне',  grass: 0.55, grassDist: 44,  shadows: true,  shadowSize: 1024, pixelRatio: 1.0,  aa: false, skyClouds: 10, water: 1, cloudRes: 96,  fog: 1.0, decals: 0.7, people: 0.8, rain: 0.8 },
  high:   { name: 'высоко',  grass: 0.85, grassDist: 60,  shadows: true,  shadowSize: 2048, pixelRatio: 1.5,  aa: true,  skyClouds: 22, water: 1, cloudRes: 128, fog: 1.0, decals: 1.0, people: 1.0, rain: 1.0 },
  ultra:  { name: 'ультра',  grass: 1.20, grassDist: 92, shadows: true,  shadowSize: 4096, pixelRatio: 2.0,  aa: true,  skyClouds: 34, water: 1, cloudRes: 192, fog: 1.0, decals: 1.0, people: 1.0, rain: 1.0 },
};

function isMobile() {
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua) || (navigator.maxTouchPoints > 1 && window.innerWidth < 1280);
}

export const platform = {
  mobile: isMobile(),
  android: /Android/i.test(navigator.userAgent || ''),
  electron: typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent || ''),
  webgl2: (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; } })(),
};

// v7: старые настройки 0.6.0/0.6.1 могли содержать масштаб кадра, который
// авто-качество когда-то понизило — из-за него картинка оставалась мыльной.
const KEY = 'shopsim.settings.v7';
const SAVE = 'shopsim.save.v6';

export const settings = {
  quality: platform.mobile ? 'medium' : 'high',
  pixelScale: 1.0,
  volume: 0.7,
  sensitivity: 1.0,
  invertY: false,
  lang: 'ru',
  hourOffset: 0,
  weather: 'auto', // auto | clear | cloudy | rain | storm | fog | snow
  showFps: true,
  shadows: true,
  grassScale: 1.0,
  season: 'summer', // summer | autumn | winter (новогодняя ёлка зимой)
  ...load(),
};

export function q() { return Q[settings.quality] || Q.high; }
export function qualityPresets() { return Q; }

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* приватный режим */ }
}
function load() {
  try {
    // однократный перенос со v6: масштаб кадра от прошлого авто-качества
    // выбрасываем (из-за него картинка оставалась мыльной)
    if (!localStorage.getItem(KEY)) {
      const old = localStorage.getItem('shopsim.settings.v6');
      if (old) {
        const o = JSON.parse(old) || {};
        delete o.pixelScale;
        localStorage.setItem(KEY, JSON.stringify(o));
        localStorage.removeItem('shopsim.settings.v6');
      }
    }
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (!s || typeof s !== 'object') return {};
    // неизвестный пресет качества ломал постобработку (AO/лучи по строке)
    if (s.quality && !Q[s.quality]) delete s.quality;
    return s;
  } catch (e) { return {}; }
}

export function saveGame(state) {
  try { localStorage.setItem(SAVE, JSON.stringify(state)); return true; } catch (e) { return false; }
}
export function loadGame() {
  try { const s = localStorage.getItem(SAVE); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}
export function clearGame() { try { localStorage.removeItem(SAVE); } catch (e) {} }

export function detectQuality() {
  // грубая оценка: телефоны — средне, слабые ПК — средне, остальные — высоко
  if (platform.mobile) return 'medium';
  const mem = navigator.deviceMemory || 8;
  const cores = navigator.hardwareConcurrency || 8;
  if (mem <= 4 && cores <= 4) return 'medium';
  if (cores >= 12 && !platform.webgl2) return 'medium';
  return 'high';
}

/** Параметры из адресной строки / командной строки Electron (--low, --quality high, --scale 0.8 ...). */
export function applyCliOverrides(params) {
  const out = {};
  if (params.has('low') || params.has('lowspec')) { settings.quality = 'low'; out.quality = 'low'; }
  if (params.has('medium')) { settings.quality = 'medium'; out.quality = 'medium'; }
  if (params.has('high')) { settings.quality = 'high'; out.quality = 'high'; }
  if (params.has('ultra')) { settings.quality = 'ultra'; out.quality = 'ultra'; }
  const sc = parseFloat(params.get('scale') || '');
  if (Number.isFinite(sc) && sc > 0.3 && sc <= 2) { settings.pixelScale = sc; out.pixelScale = sc; }
  if (params.has('noshadows')) { settings.shadows = false; out.shadows = false; }
  if (params.has('nograss')) { settings.grassScale = 0; out.grassScale = 0; }
  const g = parseFloat(params.get('grass') || '');
  if (Number.isFinite(g)) { settings.grassScale = g; out.grassScale = g; }
  const hr = parseFloat(params.get('hour') || '');
  if (Number.isFinite(hr)) { settings.hourOffset = hr; out.hour = hr; }
  const w = params.get('weather'); if (w) { settings.weather = w; out.weather = w; }
  // ?weather=snow без зимы снега не давал вовсе (осадки зимние) — включаем зиму
  if (settings.weather === 'snow') settings.season = 'winter';
  const s = params.get('season'); if (s) { settings.season = s; out.season = s; }
  return out;
}
