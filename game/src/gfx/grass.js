/* Трава: геометрия травинок с текстурой, ветер, приминание под ногами, сезоны.
   Чанки 16 × 16 м строятся лениво вокруг игрока. */
import * as THREE from 'three';
import { settings, q } from '../core/settings.js';
import { isWater, lakeDist, roadAt, RIVER, inPark, isSidewalk, hash2, fbm } from '../world/gen.js';

const CHUNK = 16;
const CACHE_LIMIT = 220;

const VERT = /* glsl */`
uniform float uTime;
uniform vec3 uPlayer;
uniform vec2 uWind;
uniform float uWindStrength;
uniform float uFar;
attribute float aPhase;
varying vec3 vColor;
varying vec3 vNrm;
varying float vH;
varying vec2 vUv;
varying vec2 vWorld;
varying vec3 vShadowCoord;
void main(){
  vec3 p = position;
  vec4 wo = modelMatrix * vec4(p, 1.0);
  vWorld = wo.xz;
  float h = uv.y;                       // 0..1 вдоль травинки
  float ph = aPhase;
  // ветер: две волны + порывы
  float w1 = sin(uTime * 1.7 + wo.x * 0.33 + wo.z * 0.21 + ph);
  float w2 = sin(uTime * 4.1 + wo.x * 0.9 - wo.z * 0.7 + ph * 2.0);
  float gust = 0.55 + 0.45 * sin(uTime * 0.47 + wo.x * 0.021 + wo.z * 0.017);
  float bend = (w1 * 0.62 + w2 * 0.22) * gust * uWindStrength;
  vec2 dir = normalize(uWind + vec2(0.0001));
  // приминание под игроком
  vec2 d = wo.xz - uPlayer.xz;
  float dist = length(d);
  float push = smoothstep(1.15, 0.05, dist);
  vec2 pdir = dist > 0.001 ? d / dist : vec2(0.0);
  vec2 off = dir * bend * 0.30 + pdir * push * 0.34;
  p.xz += off * h * h;
  p.y -= push * 0.13 * h * h;
  // дальний край плавно прижимаем к земле — без резкой границы
  float dCam = length(wo.xz - cameraPosition.xz);
  float fade = smoothstep(uFar, uFar * 0.60, dCam);
  p.y *= (0.5 + 0.5 * fade);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vNrm = normalize(vec3(-dir.x * bend * 0.5, 1.0, -dir.y * bend * 0.5));
  vH = h;
  vUv = uv;
  vColor = color;
  // мировая позиция после смещения ветром — по ней берём тень
  vShadowCoord = (modelMatrix * vec4(p, 1.0)).xyz;
}
`;

const FRAG = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uSeason;
uniform float uWet;
uniform float uFar;
uniform float uAmbient;
uniform vec3 uEdgeColor;
uniform sampler2D uBladeTex;
/* Тени: карта глубины от солнца. Без этого трава перекрывала газон
   и тени деревьев просто не были видны. */
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowOn;
uniform float uShadowTexel;

/* varying объявлен ДО функции: GLSL требует объявления до использования.
   Раньше vShadowCoord стоял ниже shadowFactor(), и часть драйверов (ANGLE,
   SwiftShader) не собирала программу — трава просто не рисовалась. */
varying vec3 vShadowCoord;

float shadowFactor() {
  if (uShadowOn < 0.5) return 1.0;
  vec4 sc = uShadowMatrix * vec4(vShadowCoord, 1.0);
  vec3 proj = sc.xyz / sc.w;
  proj = proj * 0.5 + 0.5;
  if (proj.z > 1.0 || proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0) return 1.0;
  // 4 отсчёта — мягкая кромка без дорогого PCF
  float lit = 0.0;
  lit += step(proj.z - 0.0015, texture2D(uShadowMap, proj.xy + vec2(-0.5, -0.5) * uShadowTexel).x);
  lit += step(proj.z - 0.0015, texture2D(uShadowMap, proj.xy + vec2(0.5, -0.5) * uShadowTexel).x);
  lit += step(proj.z - 0.0015, texture2D(uShadowMap, proj.xy + vec2(-0.5, 0.5) * uShadowTexel).x);
  lit += step(proj.z - 0.0015, texture2D(uShadowMap, proj.xy + vec2(0.5, 0.5) * uShadowTexel).x);
  return mix(0.34, 1.0, lit * 0.25);
}
varying vec3 vColor;
varying vec3 vNrm;
varying float vH;
varying vec2 vUv;
varying vec2 vWorld;
void main(){
  vec3 N = normalize(vNrm);
  vec3 L = normalize(-uSunDir);
  float diff = max(dot(N, L), 0.0);
  // просвет на кончиках (как у настоящей травы на солнце)
  float back = pow(max(dot(-N, L), 0.0), 2.0) * 0.5;
  float trans = pow(max(0.0, dot(-L, vec3(0.0, 1.0, 0.0))), 2.0);
  // текстура травинки: тёмное основание, светлый кончик, прожилки
  vec3 tex = texture2D(uBladeTex, vUv).rgb;
  vec3 tint = vColor * 0.34;   // тонировка: цвет травы, а не подсветка
  // пятнистость газона: без неё поле выглядело ровной яркой заливкой
  float fieldVar = 0.88 + 0.12 * sin(vWorld.x * 0.11 + sin(vWorld.y * 0.07) * 2.0);
  tint *= fieldVar;
  // Сезон — множитель в шейдере, а не пересборка всех чанков.
  // Лето 0, осень 1, зима 2 (зимой трава не рисуется вовсе).
  if (uSeason > 0.5 && uSeason < 1.5) tint *= vec3(1.42, 0.92, 0.34);
  else if (uSeason > 1.5) tint *= vec3(1.3, 1.3, 1.2);
  vec3 albedo = tex * tint;
  // затенение в глубине дёрна
  float ao = mix(0.55, 1.0, pow(vH, 0.7));
  vec3 amb = mix(uGroundColor * 0.9, uSkyColor, 0.35 + 0.65 * vH);
  // солнце даёт до ~1.3, небо — мягкая заливка
  // небо и земля дают мягкий свет; солнце — направленный
  vec3 light = amb * 0.45 * uAmbient * ao + uSunColor * (diff * 0.62 * ao + back * 0.22);
  vec3 col = albedo * light;
  col *= mix(1.0, 0.8, uWet);
  col = pow(col, vec3(0.98)); // без сильного подъёма теней: было «пластиково»
  // чуть меньше кислотности: подмешиваем яркость в цвет
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum), 0.14);
  // немного холоднее в тени
  float dCam = length(vWorld - cameraPosition.xz);
  // туман только очень слабый: трава не должна светиться в белёсую полосу
  float fogT = smoothstep(uFogNear, uFogFar, dCam) * 0.35;
  col = mix(col, uFogColor, fogT);
  // у самой границы радиуса плавно в цвет земли под травой (а не в туман)
  // плавный переход в цвет газона; uEdgeColor совпадает с текстурой земли по тону
  col = mix(col, uEdgeColor, smoothstep(uFar * 0.42, uFar * 0.86, dCam));
  col *= shadowFactor();
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Текстура травинки: вертикальный градиент с прожилками и шумом. */
function bladeTexture() {
  const W = 64, H = 128;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = 1 - y / H;               // 0 у основания, 1 на кончике
      const across = Math.abs(x / W - 0.5) * 2;
      // прожилки вдоль травинки
      const vein = 0.82 + 0.18 * Math.sin(x * 1.35 + Math.sin(y * 0.12) * 1.4);
      const noise = 0.9 + hashlike(x, y) * 0.2;
      const base = 0.35 + 0.65 * Math.pow(v, 0.85);
      let k = base * vein * noise * (1 - across * 0.35);
      const r = k * 0.62, gg = k, b = k * 0.42;
      const i = (y * W + x) * 4;
      img.data[i] = Math.min(255, 255 * r);
      img.data[i + 1] = Math.min(255, 255 * gg);
      img.data[i + 2] = Math.min(255, 255 * b);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
function hashlike(x, y) {
  let h = Math.imul(x * 374761393 + y * 668265263, 1274126177);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

export class GrassField {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'grass';
    scene.add(this.group);
    this.chunks = new Map();
    this.geoCache = new Map();
    this.queue = [];
    this.lastCX = 1e9; this.lastCZ = 1e9;
    this.enabled = true;
    this.density = 1;

    this.uniforms = {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(1.0, 0.95, 0.85) },
      uSkyColor: { value: new THREE.Color(0.55, 0.7, 0.95) },
      uGroundColor: { value: new THREE.Color(0.16, 0.17, 0.12) },
      uFogColor: { value: new THREE.Color(0.75, 0.8, 0.86) },
      uFogNear: { value: 60 },
      uFogFar: { value: 420 },
      uPlayer: { value: new THREE.Vector3() },
      uWind: { value: new THREE.Vector2(0.85, 0.52) },
      uWindStrength: { value: 1.0 },
      uSeason: { value: 0 },
      uFar: { value: 80 },
      uWet: { value: 0 },
      uBladeTex: { value: bladeTexture() },
      uAmbient: { value: 1.0 },
      uEdgeColor: { value: new THREE.Color(0.055, 0.290, 0.042) },
      uShadowMap: { value: null },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uShadowOn: { value: 0 },
      uShadowTexel: { value: 1 / 2048 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      vertexColors: true, side: THREE.DoubleSide,
    });
    this.material.fog = false;
    this.setQuality();
  }

  setQuality() {
    const Q = q();
    this.density = Q.grass * (settings.grassScale ?? 1);
    this.radius = Math.max(12, Q.grassDist);
    this.uniforms.uFar.value = this.radius;
    this._applyEnabled();
    // сбросить кэш — плотность входит в ключ, но старые меши надо пересобрать
    for (const [k, m] of this.chunks) { if (m) this.group.remove(m); }
    this.chunks.clear();
    this.lastCX = 1e9;
    this.geoCache.forEach((g) => g.dispose());
    this.geoCache.clear();
    this._applyEnabled();
  }

  /** Трава рисуется только когда есть плотность и это не зима. */
  _applyEnabled() {
    this.enabled = this.density > 0.02 && !this.winter;
    this.group.visible = this.enabled;
  }

  applySeason(season) {
    this.uniforms.uSeason.value = season === 'autumn' ? 1 : season === 'winter' ? 2 : 0;
    // Зимой газон под снегом: травинки не рисуются вообще. Это и правильная
    // картинка, и главный источник просадки fps зимой (десятки тысяч
    // альфа-травинок в кадре и в теневом проходе).
    this.winter = season === 'winter';
    this._applyEnabled();
    if (this.winter) {
      // освобождаем геометрию: весной чанки соберутся заново
      for (const [, m] of this.chunks) { if (m) { this.group.remove(m); m.geometry.dispose(); } }
      this.chunks.clear();
      this.geoCache.forEach((g) => g.dispose());
      this.geoCache.clear();
      this.queue.length = 0;
      this.lastCX = 1e9; this.lastCZ = 1e9;
    }
  }
  setWet(w) { this.uniforms.uWet.value = w; }

  buildChunk(cx, cz) {
    const key = cx + ',' + cz + ':' + Math.round(this.density * 10);
    if (this.geoCache.has(key)) { const g = this.geoCache.get(key); this.geoCache.delete(key); this.geoCache.set(key, g); return g; }
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const target = Math.round(CHUNK * CHUNK * 13 * Math.min(1.9, this.density) * (this.budget || 1));
    const vertsPerBlade = 4;
    const maxV = target * vertsPerBlade;
    const pos = new Float32Array(maxV * 3);
    const nrm = new Float32Array(maxV * 3);
    const col = new Float32Array(maxV * 3);
    const uv = new Float32Array(maxV * 2);
    const phase = new Float32Array(maxV);
    const idx = [];
    let vi = 0, vcount = 0;
    for (let i = 0; i < target * 1.6; i++) {
      const lx = Math.random() * CHUNK, lz = Math.random() * CHUNK;
      const bx = x0 + lx, bz = z0 + lz;
      // никакой травы на воде: река, озеро, пруд
      if (isWater(bx, bz)) continue;
      if (bz > RIVER.z0 - 3.5) continue;
      if (roadAt(bx, bz) || isSidewalk(bx, bz) || lakeDist(bx, bz) < 1.04) continue;
      if (this.world && this.world.solidAt && this.world.solidAt(bx, bz)) continue;
      const park = inPark(bx, bz);
      const patch = hash2(Math.floor(bx / 3.1), Math.floor(bz / 3.1), 11);
      // пятна: где-то гуще, где-то реже — как настоящий газон
      if (patch < 0.16 && !park) continue;
      const tall = park ? 1.35 : 1.0;
      const hgt = (0.13 + Math.random() * 0.24 + patch * 0.12 + (park ? 0.08 : 0)) * tall;
      const wid = 0.013 + Math.random() * 0.018;
      const ang = Math.random() * Math.PI * 2;
      const lean = 0.14 + Math.random() * 0.4;
      const dx = Math.cos(ang) * lean, dz = Math.sin(ang) * lean;
      const dry = Math.random() * Math.random();
      // базовый (летний) цвет; сезонный оттенок считается в шейдере
      const r = 0.46 + dry * 0.34, g = 0.66 + dry * 0.30, b = 0.30 + dry * 0.16;
      const bendX = dx * hgt, bendZ = dz * hgt;
      // 4 вершины: основание двумя, середина изгиба двумя — силуэт тот же, вершин меньше
      const pts = [
        [-wid, 0, 0, 0], [wid, 0, 0, 0],
        [-wid * 0.42 + bendX * 0.5, hgt * 0.56, bendZ * 0.5, 0.56],
        [wid * 0.42 + bendX * 0.5, hgt * 0.56, bendZ * 0.5, 0.56],
      ];
      const ph = Math.random() * 6.283;
      const vStart = vcount;
      for (let k = 0; k < 4; k++) {
        const p = pts[k];
        pos[vi * 3] = p[0] + lx; pos[vi * 3 + 1] = p[1]; pos[vi * 3 + 2] = p[2] + lz;
        nrm[vi * 3] = 0; nrm[vi * 3 + 1] = 1; nrm[vi * 3 + 2] = 0;
        col[vi * 3] = r; col[vi * 3 + 1] = g; col[vi * 3 + 2] = b;
        uv[vi * 2] = k === 0 || k === 2 ? 0 : 1;
        uv[vi * 2 + 1] = p[3];
        phase[vi] = ph;
        vi++; vcount++;
      }
      // кончик вьющейся травы: треугольник над серединой
      idx.push(vStart, vStart + 1, vStart + 2, vStart + 1, vStart + 3, vStart + 2);
      if (vcount >= maxV - 4) break;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, vcount * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm.slice(0, vcount * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col.slice(0, vcount * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv.slice(0, vcount * 2), 2));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase.slice(0, vcount), 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    this.geoCache.set(key, geo);
    while (this.geoCache.size > CACHE_LIMIT) {
      const k = this.geoCache.keys().next().value;
      if (this.chunks.has(k)) break;
      const g = this.geoCache.get(k); g.dispose(); this.geoCache.delete(k);
    }
    return geo;
  }

  update(dt, camera, player) {
    this.uniforms.uTime.value += dt;
    this.uniforms.uPlayer.value.copy(player);
    if (!this.enabled) return;
    const cx = camera.position.x, cz = camera.position.z;
    if (Math.abs(cx - this.lastCX) > CHUNK * 0.5 || Math.abs(cz - this.lastCZ) > CHUNK * 0.5) {
      this.lastCX = cx; this.lastCZ = cz;
      this._reassign(cx, cz);
    }
    let built = 0;
    while (this.queue.length && built < 3) {
      const { key, cx: qx, cz: qz } = this.queue.shift();
      if (this.chunks.has(key)) continue;
      const geo = this.buildChunk(qx, qz);
      if (!geo || !geo.index || geo.index.count === 0) { this.chunks.set(key, null); continue; }
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.position.set(qx * CHUNK, 0, qz * CHUNK);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.frustumCulled = true;
      this.group.add(mesh);
      this.chunks.set(key, mesh);
      built++;
    }
    // старые (удалённые) чанки не должны держать память
    if (this.chunks.size > 260) {
      const it = this.chunks.keys();
      for (let i = 0; i < 40; i++) {
        const k = it.next().value;
        if (!k) break;
        const m = this.chunks.get(k);
        if (m) this.group.remove(m);
        this.chunks.delete(k);
      }
    }
  }

  /** Перестроить все чанки (после смены плотности/качества). */
  rebuild() {
    for (const [, m] of this.chunks) {
      if (m) { this.group.remove(m); m.geometry.dispose(); }
    }
    this.chunks.clear();
    // в кэше лежат те же геометрии, что и в мешах: их тоже надо освободить,
    // иначе смена качества/плотности тихо утекала видеопамятью
    this.geoCache.forEach((g) => g.dispose());
    this.geoCache.clear();
    this.queue.length = 0;
    this.lastCX = 1e9; this.lastCZ = 1e9;
  }

  _reassign(cx, cz) {
    const R = this.radius;
    const minX = Math.floor((cx - R) / CHUNK), maxX = Math.floor((cx + R) / CHUNK);
    const minZ = Math.floor((cz - R) / CHUNK), maxZ = Math.floor((cz + R) / CHUNK);
    const want = new Set();
    // чанк берём, только если его ближайшая точка попадает в круг радиуса
    const inCircle = (qx, qz) => {
      const x0 = qx * CHUNK, z0 = qz * CHUNK;
      const nx = Math.max(x0, Math.min(cx, x0 + CHUNK)), nz = Math.max(z0, Math.min(cz, z0 + CHUNK));
      return Math.hypot(nx - cx, nz - cz) <= R + CHUNK * 0.4;
    };
    this.queue.length = 0;
    for (let ix = minX; ix <= maxX; ix++) {
      for (let iz = minZ; iz <= maxZ; iz++) {
        const wx = (ix + 0.5) * CHUNK, wz = (iz + 0.5) * CHUNK;
        if (Math.abs(wx) > 830 || Math.abs(wz) > 830) continue;
        const d = Math.hypot(wx - cx, wz - cz);
        if (d > R) continue;
        const key = ix + ',' + iz;
        want.add(key);
        if (!this.chunks.has(key)) this.queue.push({ key, cx: ix, cz: iz, d });
      }
    }
    for (const [key, mesh] of this.chunks) {
      if (!want.has(key)) { if (mesh) this.group.remove(mesh); this.chunks.delete(key); }
    }
    this.queue.sort((a, b) => a.d - b.d);
  }

  setSun(dir, color, sky, ground) {
    this.uniforms.uSunDir.value.copy(dir);
    this.uniforms.uSunColor.value.copy(color);
    this.uniforms.uSkyColor.value.copy(sky);
    this.uniforms.uGroundColor.value.copy(ground);
  }
  setFog(near, far, color) {
    // туман для травы — только на самом дальнем крае радиуса
    this.uniforms.uFogNear.value = this.radius * 0.55;
    this.uniforms.uFogFar.value = this.radius;
    this.uniforms.uFogColor.value.copy(color);
  }
  setWind(x, z, strength) {
    this.uniforms.uWind.value.set(x, z).normalize();
    this.uniforms.uWindStrength.value = strength;
  }
  debugInfo() {
    let verts = 0;
    for (const [, m] of this.chunks) if (m) verts += m.geometry.attributes.position.count;
    return { chunks: this.chunks.size, verts, density: +this.density.toFixed(2), radius: this.radius, queued: this.queue.length, winter: !!this.winter };
  }
  stats() { return { chunks: this.chunks.size, visible: this.enabled }; }
}
