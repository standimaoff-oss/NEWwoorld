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
precision highp sampler3D;
uniform float uCloudTime;
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform vec3 uCloudSun;       // направление на солнце (не цвет!)
uniform vec3 uCloudSunColor;  // цвет солнечного света
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
varying vec3 vDir;
float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453); }

/* --- облака: процессуальный fbm по мировым координатам (без швов) --- */
float hash12(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm2(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + vec2(13.7, 7.3); a *= 0.5; }
  return v;
}
float cloudDensity(vec3 p, float hN) {
  vec2 q = p.xz * 0.0021 + vec2(uCloudTime * 0.0022, uCloudTime * 0.0014);
  float base = fbm2(q);
  float det = fbm2(q * 3.9 - vec2(uCloudTime * 0.007, -uCloudTime * 0.005));
  float micro = fbm2(q * 9.0 + hN * 3.0);
  float d = base * 0.68 + det * 0.26 + micro * 0.14;
  float thr = mix(0.72, 0.26, uCloudCoverage);
  d = smoothstep(thr, thr + 0.16, d);
  // кучевая форма
  float shape = smoothstep(0.0, 0.10, hN) * smoothstep(1.0, 0.78, hN);
  return d * shape * uCloudDensity;
}

vec4 marchClouds(vec3 rd, vec3 baseSky) {
  if (rd.y < 0.035) return vec4(0.0);
  float y0 = uLayerY, y1 = uLayerY + uLayerH;
  float ta = (y0 - cameraPosition.y) / rd.y;
  float tb = (y1 - cameraPosition.y) / rd.y;
  float t0 = max(0.0, min(ta, tb));
  float t1 = min(max(ta, tb), 14000.0);
  if (t1 <= t0) return vec4(0.0);
  const int STEPS = 40;
  float stepL = (t1 - t0) / float(STEPS);
  float trans = 1.0;
  vec3 col = vec3(0.0);
  float t = t0 + stepL * hash12(rd.xz * 512.0);
  vec3 sunDir = normalize(-uCloudSun);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = cameraPosition + rd * t;
    float hN = clamp((p.y - y0) / uLayerH, 0.0, 1.0);
    float dens = cloudDensity(p, hN);
    if (dens > 0.004) {
      float shadow = 0.0;
      for (int j = 0; j < 3; j++) {
        vec3 lp = p + sunDir * (90.0 + 140.0 * float(j));
        float hh = clamp((lp.y - y0) / uLayerH, 0.0, 1.0);
        shadow += cloudDensity(vec3(lp.x, hh, lp.z), hh);
      }
      shadow = clamp(shadow / 3.0, 0.0, 1.0);
      float powder = 1.0 + 1.5 * pow(1.0 - dens, 2.0);
      float scatter = pow(clamp(dot(rd, sunDir) * 0.5 + 0.5, 0.0, 1.0), 6.0);
      // тени внутри облака — холодные (небо), край — яркое солнце
      // внутри облака — холодная тень, сверху — почти белое солнце
      vec3 shade = mix(vec3(0.30, 0.38, 0.55), vec3(1.0), pow(1.0 - shadow, 1.4));
      vec3 sunLit = uCloudSunColor * (1.05 + 1.25 * (1.0 - shadow)) * powder + uCloudSunColor * scatter * 0.75;
      vec3 lit = shade * (baseSky * 0.22 + sunLit);
      // ночью облака — тёмные силуэты с едва заметной подсветкой от луны
      vec3 moonLit = vec3(0.055, 0.075, 0.13) * (0.55 + 0.9 * (1.0 - shadow)) * powder;
      lit = mix(lit, moonLit * 0.55 + baseSky * 0.05, clamp(uNight, 0.0, 1.0));
      float a = 1.0 - exp(-dens * stepL * 0.009);
      col += lit * a * trans;
      trans *= (1.0 - a);
      if (trans < 0.01) break;
    }
    t += stepL;
  }
  float horiz = smoothstep(0.035, 0.22, rd.y);
  col *= mix(1.0, 0.30, uNight);   // у горизонта облака растворяются в дымке
  return vec4(col, clamp((1.0 - trans) * horiz, 0.0, 1.0));
}

void main(){
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uTop, pow(h, 0.72));
  // полоса у горизонта (дымка)
  col = mix(col, uHorizon * 1.02, pow(1.0 - h, 8.0) * 0.7);
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
    vec4 cl = marchClouds(d, col);
    if (cl.a > 0.001) {
      vec3 lit = cl.rgb / max(cl.a, 0.0001);
      lit *= mix(1.0, 0.42, uNight);
      col = mix(col, lit, clamp(cl.a, 0.0, 1.0));
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;

/* --- облака: 3D-текстура плотности, марч по лучу в ограниченном слое --- */
export function makeCloudNoise3D(res = 96) {
  // Значения на решётке (4x4x4) с повтором по краям — текстура стыкуется без шва.
  const G = 8;
  const grid = new Float32Array(G * G * G);
  let seed = 1337;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const smooth = (t) => t * t * (3 - 2 * t);
  const at = (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
    const g = (a, b, c) => grid[(((c % G) + G) % G * G + ((b % G) + G) % G) * G + (((a % G) + G) % G)];
    const x0y0 = g(xi, yi, zi) * (1 - xf) + g(xi + 1, yi, zi) * xf;
    const x1y0 = g(xi, yi + 1, zi) * (1 - xf) + g(xi + 1, yi + 1, zi) * xf;
    const x0y1 = g(xi, yi, zi + 1) * (1 - xf) + g(xi + 1, yi, zi + 1) * xf;
    const x1y1 = g(xi, yi + 1, zi + 1) * (1 - xf) + g(xi + 1, yi + 1, zi + 1) * xf;
    const a0 = x0y0 * (1 - yf) + x1y0 * yf;
    const a1 = x0y1 * (1 - yf) + x1y1 * yf;
    return a0 * (1 - zf) + a1 * zf;
  };
  const R = res;
  const data = new Uint8Array(R * R * R);
  let maxV = 0, sum = 0;
  for (let z = 0; z < R; z++) for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    const u = x / R, v = y / R, w = z / R;
    // 4 октавы периодического шума
    let val = 0, amp = 0.5, freq = 2;
    for (let o = 0; o < 4; o++) {
      val += amp * at(u * freq, v * freq * 1.6, w * freq);
      amp *= 0.5; freq *= 2;
    }
    // кучевая форма: снизу плоско, сверху пухло
    const hN = v;
    const shape = Math.max(0, Math.sin(Math.min(1, Math.max(0, (hN - 0.04) / 0.92)) * Math.PI));
    let d = (val - 0.40) / 0.30;
    d = Math.max(0, Math.min(1, d)) * (0.35 + 0.65 * shape);
    const b = Math.round(d * 255);
    data[(z * R + y) * R + x] = b;
    if (b > maxV) maxV = b; sum += b;
  }
  const tex = new THREE.Data3DTexture(data, R, R, R);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  tex.userData = { maxV, mean: sum / data.length, res: R };
  return tex;
}

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
      uCloudNoise: { value: null },
      uCloudTime: { value: 0 },
      uCloudCoverage: { value: 0.45 },
      uCloudDensity: { value: 1.0 },
      uCloudSun: { value: new THREE.Vector3(0, 1, 0) },
      uCloudSunColor: { value: new THREE.Color(1.0, 0.97, 0.90) },
      uCloudSky: { value: new THREE.Color(0.62, 0.74, 0.92) },
      uLayerY: { value: 430 },
      uLayerH: { value: 300 },
    };
    this.cloudTex = null;
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
    if (res === this.cloudRes && this.cloudTex) return;
    this.cloudRes = res;
    if (this.cloudTex) this.cloudTex.dispose();
    this.cloudTex = makeCloudNoise3D(res);
    this.uniforms.uCloudNoise.value = this.cloudTex;
  }

  debugClouds() {
    const u = this.uniforms;
    return {
      hasTex: !!u.uCloudNoise.value, res: this.cloudRes,
      coverage: u.uCloudCoverage.value, density: u.uCloudDensity.value,
      layerY: u.uLayerY.value, layerH: u.uLayerH.value,
      texInfo: this.cloudTex ? this.cloudTex.userData : null,
      visible: this.sky.visible,
    };
  }

  setSeasonColors(season) {
    if (season === 'winter') this.uniforms.uCloudCoverage.value = Math.min(1, this.uniforms.uCloudCoverage.value + 0.08);
  }

  setClouds(coverage, density, night) {
    this.uniforms.uCloudCoverage.value = coverage;
    this.uniforms.uCloudDensity.value = density;
    this.uniforms.uCloudSky.value.copy(this.uniforms.uHorizon.value);
    // направление на солнце отдельно, цвет света — из неба/солнца
    this.uniforms.uCloudSun.value.copy(this.uniforms.uSunDir.value);
    this.uniforms.uCloudSunColor.value.copy(this.uniforms.uSunColor.value);
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
