/* Небо: градиент, солнце, луна, звёзды и объёмные облака (ray marching по 3D-текстуре). */
import * as THREE from 'three';
import { settings, q } from '../core/settings.js';
import { fbm, noise2, hash2 } from '../world/gen.js';

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */`
precision highp float;
uniform float uCloudTime;
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform vec3 uCloudSun;       // направление на солнце (не цвет!)
uniform vec3 uCloudSunColor;  // цвет солнечного света
uniform vec3 uCloudTint;       // закатный оттенок облаков
uniform float uDusk;           // 0 — день, 1 — пик заката
uniform vec3 uCloudSky;
uniform float uLayerY;
uniform float uLayerH;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uNight;
uniform float uTime;
uniform vec3 uMoonDir;
uniform float uCloudSteps;    // сколько шагов марча делать (качество + погода)
uniform float uCloudDetail;   // 1 — третий слой шума, 0 — без него
varying vec3 vDir;
float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453); }

/* --- облака: процессуальный fbm по мировым координатам (без швов) --- */
// без sin(): небо занимает пол-экрана, и 5 октав «через синус» стоили
// больше, чем весь остальной кадр
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm2(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + vec2(13.7, 7.3); a *= 0.5; }
  return v;
}
vec4 cloudLayer(vec3 rd, vec3 baseSky) {
  /* Облака как слой на высоте uLayerY, а не марч по лучу.
     Марч 30–40 шагов давал на горизонте полосы и «лесенку» (каждый шаг —
     сотни метров), поэтому форма считается по проекции луча на плоскость
     слоя: гладко на любом удалении и в разы дешевле. */
  float hy = uLayerY - cameraPosition.y;
  if (rd.y < 0.02 || hy <= 1.0 || uCloudCoverage < 0.006) return vec4(0.0);
  float t = hy / rd.y;
  vec2 p = (cameraPosition.xz + rd.xz * t) * 0.0022;
  vec2 drift = vec2(uCloudTime * 0.0026, uCloudTime * 0.0011);
  vec2 q = p + drift;

  // доменное искажение: облака кучевые, с рваными краями, а не полосы
  vec2 warp = vec2(fbm2(q * 0.7 + vec2(3.7, 1.3)), fbm2(q * 0.7 + vec2(9.1, 5.9))) - 0.5;
  float base = fbm2(q + warp * 1.15);
  float det = uCloudDetail > 0.5 ? vnoise(q * 3.3 - drift * 1.6 + warp * 0.5) : 0.5;
  float dens = base * 0.84 + det * 0.16;

  float thr = mix(0.66, 0.24, clamp(uCloudCoverage, 0.0, 1.0));
  float a = smoothstep(thr, thr + 0.14, dens);
  a *= smoothstep(0.012, 0.16, rd.y);        // у горизонта облака растворяются
  if (a < 0.002) return vec4(0.0);

  // освещение: тело облака темнее, край и сторона солнца — светлее
  vec3 sunDir = normalize(-uCloudSun);
  float mu = clamp(dot(rd, sunDir), 0.0, 1.0);
  float body = smoothstep(thr + 0.02, thr + 0.40, dens);
  vec3 lit = mix(uCloudSky, uCloudSunColor, 0.30 + 0.55 * pow(mu, 2.0));
  lit *= 0.80 + 0.42 * (1.0 - body);
  // закат: облака впитывают оранжевый, но не перекрывают его белым
  lit = mix(lit, uCloudTint * (0.72 + 0.55 * pow(mu, 2.0)) + baseSky * 0.22, clamp(uDusk, 0.0, 1.0) * 0.85);
  // ночью — тёмные силуэты с подсветкой луны
  lit = mix(lit, vec3(0.045, 0.055, 0.085) * (0.5 + 0.85 * (1.0 - body)) + baseSky * 0.04, clamp(uNight, 0.0, 1.0));

  return vec4(lit, clamp(a * uCloudDensity * 0.85, 0.0, 0.98));
}

void main(){
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uTop, pow(h, 0.72));
  // полоса у горизонта (дымка)
  col = mix(col, uHorizon * 1.02, pow(1.0 - h, 8.0) * 0.55);
  // солнце
  float sd = max(dot(d, -uSunDir), 0.0);
  col += uSunColor * pow(sd, 900.0) * 26.0;
  col += uSunColor * pow(sd, 22.0) * 0.28;
  col += uSunColor * pow(sd, 4.0) * 0.06;
  // луна
  float md = max(dot(d, -uMoonDir), 0.0);
  col += vec3(0.9, 0.94, 1.0) * smoothstep(0.99965, 0.9999, md) * 2.2 * uNight;
  col += vec3(0.55, 0.65, 0.9) * pow(md, 60.0) * 0.12 * uNight;
  // звёзды
  if (uNight > 0.02 && d.y > 0.0) {
    vec3 sp = floor(d * 320.0);
    float st = hash(sp);
    float tw = 0.6 + 0.4 * sin(uTime * 2.0 + st * 40.0);
    float star = smoothstep(0.9975, 1.0, st) * tw;
    col += vec3(0.85, 0.9, 1.0) * star * uNight * 1.8 * smoothstep(0.02, 0.25, d.y);
  }
  if (d.y < 0.0) col = mix(col, uGround, smoothstep(0.0, -0.08, d.y));
  // облака поверх неба (внутри того же шейдера — без проблем прозрачности)
  if (uCloudDensity > 0.001) {
    vec4 cl = cloudLayer(d, col);
    if (cl.a > 0.001) {
      col = mix(col, cl.rgb * mix(1.0, 0.45, uNight), clamp(cl.a, 0.0, 1.0));
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export class Sky {
  constructor(scene) {
    this.scene = scene;
    this.uniforms = {
      uTop: { value: new THREE.Color(0.22, 0.46, 0.86) },
      uHorizon: { value: new THREE.Color(0.74, 0.85, 0.95) },
      uGround: { value: new THREE.Color(0.30, 0.33, 0.28) },
      uSunDir: { value: new THREE.Vector3(0.3, 0.6, 0.75).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.86) },
      uMoonDir: { value: new THREE.Vector3(-0.3, -0.6, -0.7).normalize() },
      uNight: { value: 0 },
      uTime: { value: 0 },
      uCloudTime: { value: 0 },
      uCloudCoverage: { value: 0.45 },
      uCloudDensity: { value: 1.0 },
      uCloudSun: { value: new THREE.Vector3(0, 1, 0) },
      uCloudSunColor: { value: new THREE.Color(1.0, 0.97, 0.90) },
      uCloudTint: { value: new THREE.Color(1.0, 1.0, 1.0) },
      uDusk: { value: 0.0 },
      uCloudSky: { value: new THREE.Color(0.62, 0.74, 0.92) },
      uLayerY: { value: 430 },
      uLayerH: { value: 300 },
      uCloudSteps: { value: 26 },
      uCloudDetail: { value: 1 },
    };
    this.cloudRes = 0;
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
      side: THREE.BackSide, depthWrite: true, depthTest: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), this.skyMat);
    this.sky.scale.setScalar(9000);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    scene.add(this.sky);
    this.setCloudQuality();
  }

  setCloudQuality() {
    const Q = q();
    const res = Math.min(192, Math.max(32, Q.cloudRes || 96));
    // шагов марча: 40 на ультра, 32 на высоком, 18 на среднем. Больше шагов —
    // мягче края облаков, но именно они дороже всего в шейдере неба
    this.baseSteps = Q.cloudRes >= 160 ? 44 : Q.cloudRes >= 120 ? 36 : Q.cloudRes >= 96 ? 24 : 16;
    this.uniforms.uCloudSteps.value = this.baseSteps;
    this.uniforms.uCloudDetail.value = res >= 96 ? 1 : 0;
    this.cloudRes = res;
  }

  /** Шаги марча под текущую погоду и fps: в ясную погоду облаков мало,
   *  и полный марч 26 шагов на каждый пиксель неба просто не нужен. */
  setCloudBudget(fps, coverage) {
    if (!this.baseSteps) return;
    let steps = this.baseSteps;
    // в ясную погоду облаков почти нет — полный марч не нужен
    if (coverage < 0.2) steps = Math.min(steps, 20);
    if (fps && fps < 32) steps = Math.min(steps, 18);
    else if (fps && fps < 46) steps = Math.min(steps, 24);
    // детализация (третья проба на свет) зависит от разрешения текстуры, а не
    // от числа шагов: иначе облака «щелкали» при просадке fps
    const detail = this.cloudRes >= 96 ? 1 : 0;
    if (this.uniforms.uCloudSteps.value !== steps) this.uniforms.uCloudSteps.value = steps;
    if (this.uniforms.uCloudDetail.value !== detail) this.uniforms.uCloudDetail.value = detail;
  }

  debugClouds() {
    const u = this.uniforms;
    return {
      res: this.cloudRes,
      coverage: u.uCloudCoverage.value, density: u.uCloudDensity.value,
      layerY: u.uLayerY.value, layerH: u.uLayerH.value,
      visible: this.sky.visible,
    };
  }

  setSeasonColors(season) {
    // Раньше здесь к облачности прибавлялось +0.08, но её каждый кадр
    // перезаписывает setClouds() из weather.js — строка ничего не делала.
    // Облачность целиком считает погода; сезон влияет только на осадки
    // (зимой это снег), поэтому здесь остаётся лишь запомнить сезон.
    this.season = season;
  }

  setDusk(dusk) {
    this.uniforms.uDusk.value = Math.max(0, Math.min(1, dusk || 0));
  }

  setClouds(coverage, density, night) {
    this.uniforms.uCloudCoverage.value = coverage;
    this.uniforms.uCloudDensity.value = density;
    this.uniforms.uCloudSky.value.copy(this.uniforms.uHorizon.value);
    // направление на солнце отдельно, цвет света — из неба/солнца
    this.uniforms.uCloudSun.value.copy(this.uniforms.uSunDir.value);
    // Цвет облака — не то же, что цвет прямого света: облако рассеивает свет,
    // поэтому яркость держится около единицы, а оттенок уходит в закатный.
    const sc = this.uniforms.uSunColor.value;
    const lum = Math.max(0.001, sc.r * 0.3 + sc.g * 0.6 + sc.b * 0.1);
    // оттенок без яркости — в готовый цвет, без аллокации на каждый кадр
    const tint = this._tint || (this._tint = new THREE.Color());
    tint.setRGB(sc.r / lum, sc.g / lum, sc.b / lum);
    this.uniforms.uCloudSunColor.value.copy(tint).multiplyScalar(1.15);
    this.uniforms.uCloudTint.value.copy(tint);
  }

  setSun(dir, color, night) {
    this.uniforms.uSunDir.value.copy(dir);
    this.uniforms.uSunColor.value.copy(color);
    this.uniforms.uNight.value = night;
    this.uniforms.uMoonDir.value.copy(dir).multiplyScalar(-1);
  }
  setSkyColors(top, horizon, ground) {
    this.uniforms.uTop.value.copy(top);
    this.uniforms.uHorizon.value.copy(horizon);
    this.uniforms.uGround.value.copy(ground);
  }
  update(dt, camera) {
    this.uniforms.uTime.value += dt;
    this.uniforms.uCloudTime.value += dt;
    this.sky.position.copy(camera.position);
  }
}
