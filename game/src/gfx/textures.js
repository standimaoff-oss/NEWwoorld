/* Процедурные текстуры: трава, асфальт, бетон, кирпич, панели, дерево, кора, листва.
   Всё рисуется на canvas и запекается — никаких файлов не нужно. */
import * as THREE from 'three';
import { rng, hash2, noise2, fbm } from '../world/gen.js';

const cache = new Map();
function makeCanvas(size) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  return c;
}
function toTex(canvas, repeat = 1, srgb = true, aniso = 4) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}
function cached(key, fn) { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); }

/* --- трава: пучок/дерновина, фотореалистичное смешение --- */
export function grassTexture() {
  return cached('grass', () => {
    const S = 512, c = makeCanvas(S), g = c.getContext('2d');
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const n1 = fbm(x / 24, y / 24, 4, 3);
        const n2 = fbm(x / 5, y / 5, 3, 9);
        const n3 = noise2(x / 2.2, y / 2.2, 21);
        let v = n1 * 0.55 + n2 * 0.27 + n3 * 0.18;
        v = Math.pow(v, 0.92);
        const dry = Math.max(0, fbm(x / 60 + 5, y / 60 - 3, 2, 5) - 0.55) * 2.2;
        let r = 34 + 58 * v + 62 * dry, gg = 66 + 116 * v + 30 * dry, b = 18 + 32 * v + 8 * dry;
        // полосы кошения (луг подстрижен газонокосилкой)
        const mow = 0.5 + 0.5 * Math.sin((y / 9) + fbm(x / 90, y / 90, 2, 61) * 2.2);
        const k = 0.9 + mow * 0.2;
        r *= k; gg *= k; b *= k;
        const i = (y * S + x) * 4;
        img.data[i] = Math.min(255, r); img.data[i + 1] = Math.min(255, gg); img.data[i + 2] = Math.min(255, b); img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    // отдельные травинки поверх
    const rnd = rng(77);
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * S, y = rnd() * S, len = 5 + rnd() * 22, a = -Math.PI / 2 + (rnd() - 0.5) * 0.9;
      const lum = 60 + rnd() * 120;
      g.strokeStyle = `rgba(${(30 + lum * 0.38) | 0},${(70 + lum) | 0},${(22 + lum * 0.24) | 0},${0.18 + rnd() * 0.3})`;
      g.lineWidth = 0.5 + rnd() * 1.1;
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a) * len * 0.5, y + Math.sin(a) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke();
    }
    return toTex(c, 1, true, 8);
  });
}

/* --- альфа-текстура пучка травы (для billboard-слоя) --- */
export function grassTuftTexture() {
  return cached('tuft', () => {
    const S = 128, c = makeCanvas(S), g = c.getContext('2d');
    g.clearRect(0, 0, S, S);
    const rnd = rng(2024);
    for (let i = 0; i < 90; i++) {
      const x = S * 0.5 + (rnd() - 0.5) * S * 0.72;
      const len = 30 + rnd() * 78;
      const a = -Math.PI / 2 + (rnd() - 0.5) * 0.85;
      const bend = (rnd() - 0.5) * 26;
      const lum = 50 + rnd() * 130;
      g.strokeStyle = `rgb(${(36 + lum * 0.3) | 0},${(66 + lum) | 0},${(24 + lum * 0.22) | 0})`;
      g.lineWidth = 1.1 + rnd() * 1.9;
      g.beginPath(); g.moveTo(x, S);
      g.quadraticCurveTo(x + Math.cos(a) * len * 0.45, S + Math.sin(a) * len * 0.55, x + Math.cos(a) * len * 0.75 + bend, S + Math.sin(a) * len);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  });
}

export function asphaltTexture() {
  return cached('asphalt', () => {
    const S = 512, c = makeCanvas(S), g = c.getContext('2d');
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const big = fbm(x / 70, y / 70, 3, 2);
      const mid = noise2(x / 9, y / 9, 31);
      const fine = hash2(x, y, 77);
      const v = 108 + big * 34 + mid * 22 + fine * 26;
      const i = (y * S + x) * 4;
      img.data[i] = v * 1.02; img.data[i + 1] = v; img.data[i + 2] = v * 1.03; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    // камешки
    const rnd = rng(404);
    for (let i = 0; i < 5200; i++) {
      const x = rnd() * S, y = rnd() * S, r = 0.4 + rnd() * 1.5;
      const v = 120 + rnd() * 90;
      g.fillStyle = `rgba(${v},${v},${v * 1.02},${0.25 + rnd() * 0.45})`;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    // тёмные пятна и заплаты
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(30,30,32,${0.03 + rnd() * 0.06})`;
      g.beginPath(); g.ellipse(rnd() * S, rnd() * S, 6 + rnd() * 40, 4 + rnd() * 30, rnd() * 3, 0, 7); g.fill();
    }
    return toTex(c, 1, true, 16);
  });
}

/* окно с рамой и переплётом — для окон домов */
export function windowTexture() {
  return cached('window', () => {
    const W = 128, H = 128, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    // рама
    g.fillStyle = '#e6e3d8'; g.fillRect(0, 0, W, H);
    // стекло
    const gr = g.createLinearGradient(0, 0, W, H);
    gr.addColorStop(0, '#5f7d90'); gr.addColorStop(0.42, '#93b4c6'); gr.addColorStop(0.55, '#c9dde6'); gr.addColorStop(0.78, '#6d8798'); gr.addColorStop(1, '#42596a');
    g.fillStyle = gr; g.fillRect(7, 7, W - 14, H - 14);
    // блики
    g.fillStyle = 'rgba(255,255,255,0.30)';
    g.beginPath(); g.moveTo(10, H * 0.62); g.lineTo(W * 0.55, 8); g.lineTo(W * 0.78, 8); g.lineTo(10, H * 0.86); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.14)';
    g.beginPath(); g.moveTo(10, H * 0.34); g.lineTo(W * 0.3, 8); g.lineTo(W * 0.4, 8); g.lineTo(10, H * 0.46); g.fill();
    // переплёт
    g.fillStyle = '#e6e3d8';
    g.fillRect(W / 2 - 3, 6, 6, H - 12);
    g.fillRect(6, H * 0.42, W - 12, 5);
    // тень в углах
    g.strokeStyle = 'rgba(20,26,30,0.35)'; g.lineWidth = 6; g.strokeRect(3, 3, W - 6, H - 6);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  });
}

/* окно со светом внутри (вечер/ночь) */
export function windowLitTexture() {
  return cached('windowLit', () => {
    const W = 128, H = 128, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#2a2620'; g.fillRect(0, 0, W, H);
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#ffd79a'); gr.addColorStop(0.6, '#ffc16e'); gr.addColorStop(1, '#e8a852');
    g.fillStyle = gr; g.fillRect(7, 7, W - 14, H - 14);
    // тюль/занавеска
    g.fillStyle = 'rgba(255,240,210,0.55)'; g.fillRect(9, 9, W - 18, H * 0.3);
    g.fillStyle = 'rgba(120,90,60,0.25)'; g.fillRect(9, 9, W * 0.18, H - 18);
    g.fillStyle = '#3a332a';
    g.fillRect(W / 2 - 3, 6, 6, H - 12);
    g.fillRect(6, H * 0.42, W - 12, 5);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  });
}

export function concreteTexture(tint = [138, 136, 130]) {
  return cached('concrete' + tint.join(','), () => {
    const S = 256, c = makeCanvas(S), g = c.getContext('2d');
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = fbm(x / 30, y / 30, 4, 15) * 0.7 + noise2(x / 2, y / 2, 3) * 0.3;
      const v = 0.62 + n * 0.5;
      const i = (y * S + x) * 4;
      img.data[i] = tint[0] * v; img.data[i + 1] = tint[1] * v; img.data[i + 2] = tint[2] * v; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    // потёки и грязь
    const rnd = rng(51);
    for (let i = 0; i < 26; i++) {
      const x = rnd() * S, y = rnd() * S, h = 20 + rnd() * 90;
      const gr = g.createLinearGradient(x, y, x, y + h);
      gr.addColorStop(0, `rgba(40,40,38,${0.16 + rnd() * 0.2})`); gr.addColorStop(1, 'rgba(40,40,38,0)');
      g.fillStyle = gr; g.fillRect(x, y, 2 + rnd() * 7, h);
    }
    return toTex(c, 1, true, 8);
  });
}

/* панельный фасад: плитка/панели и швы, грязь у швов, потёки */
export function facadeTexture(style = 'panel5', seed = 1) {
  return cached('facade:' + style + seed, () => {
    const S = 512, c = makeCanvas(S), g = c.getContext('2d');
    const base = {
      panel5: [186, 183, 172], panel9: [204, 198, 184], brick5: [150, 92, 72], brick9: [158, 96, 76],
      private: [216, 210, 194], office: [102, 110, 118], shop: [92, 92, 90],
    }[style] || [180, 176, 168];
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = fbm(x / 26, y / 26, 4, seed) * 0.6 + noise2(x / 2.4, y / 2.4, seed + 5) * 0.4;
      const v = 0.76 + n * 0.44;
      const i = (y * S + x) * 4;
      img.data[i] = base[0] * v; img.data[i + 1] = base[1] * v; img.data[i + 2] = base[2] * v; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const rnd = rng(seed * 977 + 3);
    if (style.startsWith('brick') || style === 'private') {
      const bh = style.startsWith('brick') ? 16 : 20, bw = style.startsWith('brick') ? 34 : 44;
      g.lineWidth = 1;
      for (let y = 0; y < S; y += bh) {
        const off = (Math.floor(y / bh) % 2) * bw / 2;
        for (let x = -bw; x < S + bw; x += bw) {
          const l = 0.8 + rnd() * 0.4;
          g.fillStyle = `rgba(${base[0] * l | 0},${base[1] * l | 0},${base[2] * l | 0},0.5)`;
          g.fillRect(x + off, y, bw - 2, bh - 2);
          g.fillStyle = 'rgba(70,66,60,0.25)';
          g.fillRect(x + off, y + bh - 2, bw, 2);
        }
      }
    } else {
      // панели и плитка
      const pw = style === 'panel9' ? 62 : 96, ph = style === 'panel9' ? 42 : 58;
      for (let y = 0; y < S; y += ph) for (let x = 0; x < S; x += pw) {
        const l = 0.92 + rnd() * 0.16;
        g.fillStyle = `rgba(${base[0] * l | 0},${base[1] * l | 0},${base[2] * l | 0},0.35)`;
        g.fillRect(x + 2, y + 2, pw - 4, ph - 4);
      }
      g.strokeStyle = 'rgba(60,58,54,0.35)'; g.lineWidth = 2;
      for (let y = 0; y < S; y += ph) { g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke(); }
      for (let x = 0; x < S; x += pw) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke(); }
    }
    // грязь, потёки, мелкие пятна
    for (let i = 0; i < 60; i++) {
      const x = rnd() * S, y = rnd() * S, w = 6 + rnd() * 60, h = 20 + rnd() * 150;
      const gr = g.createLinearGradient(x, y, x, y + h);
      gr.addColorStop(0, `rgba(48,46,42,${0.06 + rnd() * 0.16})`); gr.addColorStop(1, 'rgba(48,46,42,0)');
      g.fillStyle = gr; g.fillRect(x, y, w, h);
    }
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `rgba(${60 + rnd() * 70 | 0},${58 + rnd() * 60 | 0},${52 + rnd() * 50 | 0},${rnd() * 0.16})`;
      g.beginPath(); g.arc(rnd() * S, rnd() * S, rnd() * 3.4, 0, 7); g.fill();
    }
    return toTex(c, 1, true, 8);
  });
}

export function roofTexture() {
  return cached('roof', () => {
    const S = 256, c = makeCanvas(S), g = c.getContext('2d');
    g.fillStyle = '#4a4d50'; g.fillRect(0, 0, S, S);
    const rnd = rng(9);
    for (let i = 0; i < 4000; i++) {
      const v = 40 + rnd() * 60;
      g.fillStyle = `rgba(${v},${v + 2},${v + 4},${0.4})`;
      g.fillRect(rnd() * S, rnd() * S, 2, 2);
    }
    for (let y = 0; y < S; y += 32) { g.fillStyle = 'rgba(30,32,34,0.5)'; g.fillRect(0, y, S, 2); }
    return toTex(c, 1, true, 4);
  });
}

export function barkTexture() {
  return cached('bark', () => {
    const S = 128, c = makeCanvas(S), g = c.getContext('2d');
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = fbm(x / 6, y / 24, 4, 12) * 0.7 + noise2(x / 1.5, y / 5, 4) * 0.3;
      const v = 40 + n * 80;
      const i = (y * S + x) * 4; img.data[i] = v * 1.05; img.data[i + 1] = v * 0.86; img.data[i + 2] = v * 0.68; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return toTex(c, 1, true, 4);
  });
}

export function leafTexture(kind = 'maple') {
  return cached('leaf:' + kind, () => {
    const S = 128, c = makeCanvas(S), g = c.getContext('2d');
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = fbm(x / 8, y / 8, 3, 17) * 0.5 + noise2(x / 2, y / 2, 6) * 0.5;
      let r, gg, b;
      if (kind === 'autumn') { r = 120 + n * 120; gg = 60 + n * 90; b = 20 + n * 30; }
      else if (kind === 'birch') { r = 60 + n * 70; gg = 110 + n * 100; b = 30 + n * 40; }
      else { r = 40 + n * 60; gg = 92 + n * 110; b = 26 + n * 44; }
      const i = (y * S + x) * 4; img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return toTex(c, 1, true, 4);
  });
}

export function sidewalkTexture() {
  return cached('sidewalk', () => {
    const S = 256, c = makeCanvas(S), g = c.getContext('2d');
    g.fillStyle = '#8d8a83'; g.fillRect(0, 0, S, S);
    const rnd = rng(4);
    for (let y = 0; y < S; y += 32) for (let x = 0; x < S; x += 32) {
      const v = 118 + rnd() * 40;
      g.fillStyle = `rgb(${v},${v - 3},${v - 9})`;
      g.fillRect(x + 1, y + 1, 30, 30);
      g.fillStyle = 'rgba(60,58,55,0.15)';
      g.fillRect(x + 1, y + 1, 30, 2); g.fillRect(x + 1, y + 1, 2, 30);
    }
    for (let i = 0; i < 900; i++) {
      const v = 80 + rnd() * 90;
      g.fillStyle = `rgba(${v},${v},${v},${rnd() * 0.25})`;
      g.beginPath(); g.arc(rnd() * S, rnd() * S, rnd() * 2.4, 0, 7); g.fill();
    }
    return toTex(c, 1, true, 8);
  });
}

export function waterNormalTexture() {
  return cached('waternormal', () => {
    const S = 256, c = makeCanvas(S), g = c.getContext('2d');
    const img = g.createImageData(S, S);
    const h = (x, y) => fbm(x / 22, y / 22, 5, 33) * 0.6 + fbm(x / 7 + 30, y / 7 - 20, 4, 44) * 0.4;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const e = 1.2;
      const hx = h((x + e + S) % S, y) - h((x - e + S) % S, y);
      const hy = h(x, (y + e + S) % S) - h(x, (y - e + S) % S);
      const nx = -hx * 4, ny = -hy * 4, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const i = (y * S + x) * 4;
      img.data[i] = (nx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[i + 2] = (nz / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return toTex(c, 1, false, 8);
  });
}

/** Текстура дорожной разметки: сплошная и прерывистая полосы (альфа). */
export function roadMarkTexture() {
  return cached('roadmark', () => {
    const w = 32, h = 256, c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(238,236,224,0.92)';
    g.fillRect(w / 2 - 2.2, 0, 4.4, h * 0.55);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/* Лист пальмы: перистый веер с альфой. */
export function palmFrondTexture() {
  return cached('palmfrond', () => {
    const W = 256, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.clearRect(0, 0, W, H);
    // центральная жилка по вертикали
    g.strokeStyle = '#7da33c'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(W / 2, 0); g.quadraticCurveTo(W / 2 + 6, H * 0.5, W / 2 + 2, H); g.stroke();
    const rnd = rng(707);
    for (let i = 0; i < 58; i++) {
      const t = i / 58;
      const y = 6 + t * (H - 14);
      const side = i % 2 === 0 ? 1 : -1;
      const len = (W * 0.46) * (1 - Math.abs(t - 0.55) * 0.7) * (0.75 + rnd() * 0.4);
      const droop = 26 + rnd() * 26;
      const lum = 0.72 + rnd() * 0.42;
      const grd = g.createLinearGradient(W / 2, y, W / 2 + side * len, y + droop);
      grd.addColorStop(0, `rgba(${70 * lum | 0},${128 * lum | 0},${44 * lum | 0},1)`);
      grd.addColorStop(1, `rgba(${112 * lum | 0},${178 * lum | 0},${64 * lum | 0},1)`);
      g.strokeStyle = grd;
      g.lineWidth = 2.6 + rnd() * 2.2;
      g.beginPath(); g.moveTo(W / 2, y);
      g.quadraticCurveTo(W / 2 + side * len * 0.55, y + droop * 0.35, W / 2 + side * len, y + droop);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  });
}

/* Лист бамбука: альфа-текстура пучка листьев. */
export function bambooLeafTexture() {
  return cached('bambooleaf', () => {
    const W = 256, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.clearRect(0, 0, W, H);
    const rnd = rng(606);
    for (let i = 0; i < 46; i++) {
      const cx = W * 0.5 + (rnd() - 0.5) * W * 0.82;
      const cy = H * 0.55 + (rnd() - 0.5) * H * 0.85;
      const len = 34 + rnd() * 78;
      const ang = rnd() * Math.PI * 2;
      const wdt = 7 + rnd() * 12;
      const grd = g.createLinearGradient(cx, cy, cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
      const lum = 0.55 + rnd() * 0.5;
      grd.addColorStop(0, `rgba(${60 * lum | 0},${120 * lum | 0},${40 * lum | 0},1)`);
      grd.addColorStop(1, `rgba(${110 * lum | 0},${180 * lum | 0},${70 * lum | 0},1)`);
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(cx, cy);
      g.quadraticCurveTo(cx + Math.cos(ang + 0.5) * len * 0.6, cy + Math.sin(ang + 0.5) * len * 0.6, cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
      g.quadraticCurveTo(cx + Math.cos(ang - 0.5) * len * 0.55 + wdt * 0.4, cy + Math.sin(ang - 0.5) * len * 0.55 + wdt * 0.4, cx, cy);
      g.fill();
      // прожилка
      g.strokeStyle = `rgba(${150 * lum | 0},${210 * lum | 0},${110 * lum | 0},0.7)`;
      g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len); g.stroke();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  });
}

/* Атлас вывесок для магазинов: несколько надписей на одной текстуре (экономия draw call). */
export function signAtlasTexture(texts) {
  const key = 'atlas:' + texts.join('|');
  return cached(key, () => {
    const cols = 4, rows = Math.ceil(texts.length / cols);
    const W = 512, H = 128;
    const c = document.createElement('canvas'); c.width = W * cols; c.height = H * rows;
    const g = c.getContext('2d');
    const palettes = [
      ['#12202a', '#ffd44d'], ['#1f1220', '#ff8ae2'], ['#0f1f18', '#7bff9e'],
      ['#20180c', '#ffcf7a'], ['#101c26', '#59d3ff'], ['#201010', '#ff6b5a'],
    ];
    texts.forEach((t, i) => {
      const cx = (i % cols) * W, cy = Math.floor(i / cols) * H;
      const [bg, fg] = palettes[i % palettes.length];
      g.fillStyle = bg; g.fillRect(cx, cy, W, H);
      const gr = g.createLinearGradient(cx, cy, cx, cy + H);
      gr.addColorStop(0, 'rgba(255,255,255,0.10)'); gr.addColorStop(1, 'rgba(0,0,0,0.22)');
      g.fillStyle = gr; g.fillRect(cx, cy, W, H);
      g.strokeStyle = fg; g.globalAlpha = 0.75; g.lineWidth = 5; g.strokeRect(cx + 7, cy + 7, W - 14, H - 14); g.globalAlpha = 1;
      g.fillStyle = fg;
      let size = 68;
      g.font = `700 ${size}px "Segoe UI",system-ui,sans-serif`;
      while (g.measureText(t).width > W - 48 && size > 16) { size -= 2; g.font = `700 ${size}px "Segoe UI",system-ui,sans-serif`; }
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.shadowColor = fg; g.shadowBlur = 16;
      g.fillText(t, cx + W / 2, cy + H / 2 + 3);
      g.shadowBlur = 0;
    });
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    tex.userData = { cols, rows, W, H };
    return tex;
  });
}

export function signTexture(text, opts = {}) {
  const key = 'sign:' + text + JSON.stringify(opts);
  return cached(key, () => {
    const w = 512, h = 128, c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    const bg = opts.bg || '#1c2a36', fg = opts.fg || '#ffd44d';
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.strokeStyle = fg; g.globalAlpha = 0.6; g.lineWidth = 5; g.strokeRect(6, 6, w - 12, h - 12); g.globalAlpha = 1;
    g.fillStyle = fg;
    g.font = `700 ${opts.size || 62}px "Segoe UI",system-ui,sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = fg; g.shadowBlur = opts.glow === false ? 0 : 18;
    // подгонка по ширине
    let size = opts.size || 62;
    while (g.measureText(text).width > w - 40 && size > 18) { size -= 2; g.font = `700 ${size}px "Segoe UI",system-ui,sans-serif`; }
    g.fillText(text, w / 2, h / 2 + 2);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  });
}

export function shopInteriorFloorTexture() {
  return cached('shopfloor', () => {
    const S = 256, c = makeCanvas(S), g = c.getContext('2d');
    const rnd = rng(88);
    for (let y = 0; y < S; y += 64) for (let x = 0; x < S; x += 64) {
      const v = 150 + rnd() * 50;
      g.fillStyle = `rgb(${v},${v - 8},${v - 26})`; g.fillRect(x, y, 64, 64);
      g.strokeStyle = 'rgba(80,62,44,0.4)'; g.strokeRect(x, y, 64, 64);
    }
    return toTex(c, 1, true, 8);
  });
}

export function disposeTextures() { cache.clear(); }
