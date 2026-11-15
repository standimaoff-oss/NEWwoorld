/* Постобработка: HDR-буфер, сглаживание (FXAA), виньетка, насыщенность, «зерно».
   Свой небольшой конвейер, чтобы не тянуть аддоны three. */
import * as THREE from 'three';

const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FINAL_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uTime;
uniform float uVignette;
uniform float uSat;
uniform float uContrast;
uniform float uNight;
uniform float uRain;
uniform float uAa;
uniform float uExposure;
varying vec2 vUv;

vec3 sampleC(vec2 uv) { return texture2D(tDiffuse, uv).rgb; }

/* ACES (те же коэффициенты, что в three, упрощённая аппроксимация Narkowicz) */
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(0.41666)) - 0.055, step(0.0031308, c));
}

void main(){
  vec2 uv = vUv;
  // лёгкое «дыхание» камеры для дождя не нужно — только резкость/AA
  vec3 col = sampleC(uv);
  if (uAa > 0.5) {
    // FXAA (упрощённый)
    vec3 rgbNW = sampleC(uv + vec2(-1.0, -1.0) * uTexel);
    vec3 rgbNE = sampleC(uv + vec2(1.0, -1.0) * uTexel);
    vec3 rgbSW = sampleC(uv + vec2(-1.0, 1.0) * uTexel);
    vec3 rgbSE = sampleC(uv + vec2(1.0, 1.0) * uTexel);
    vec3 rgbM = col;
    vec3 luma = vec3(0.299, 0.587, 0.114);
    float lNW = dot(rgbNW, luma), lNE = dot(rgbNE, luma), lSW = dot(rgbSW, luma), lSE = dot(rgbSE, luma), lM = dot(rgbM, luma);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    if (lMax - lMin > 0.06) {
      vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
      dir = clamp(dir / (max(abs(dir.x), abs(dir.y)) + 1e-4) * uTexel * 1.6, -uTexel * 4.0, uTexel * 4.0);
      vec3 a = 0.5 * (sampleC(uv + dir * (1.0/3.0 - 0.5)) + sampleC(uv + dir * (2.0/3.0 - 0.5)));
      vec3 b = a * 0.5 + 0.25 * (sampleC(uv + dir * -0.5) + sampleC(uv + dir * 0.5));
      float lB = dot(b, luma);
      col = (lB < lMin || lB > lMax) ? a : b;
    }
  }
  // тон-маппинг и переход в sRGB: рендер идёт в линейном HDR-буфере
  col = aces(col * uExposure);
  col = toSRGB(col);
  // насыщенность/контраст
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, uSat);
  col = (col - 0.5) * uContrast + 0.5;
  // холодная дымка в дождь
  col = mix(col, col * vec3(0.94, 0.97, 1.04), uRain);
  // виньетка
  vec2 d = uv - 0.5;
  float vig = 1.0 - dot(d, d) * uVignette;
  col *= vig;
  // ночью — синие тени, лёгкое зерно
  col = mix(col, col * vec3(0.92, 0.96, 1.12), uNight * 0.5);
  float grain = fract(sin(dot(uv * vec2(1024.0, 768.0) + uTime * 3.1, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.012 * (1.0 + uNight);
  gl_FragColor = vec4(col, 1.0);
}`;

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.enabled = true;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, samples: 0, depthBuffer: true,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.NoColorSpace,
    });
    this.uniforms = {
      tDiffuse: { value: this.target.texture },
      uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      uTime: { value: 0 }, uVignette: { value: 0.42 }, uSat: { value: 1.10 }, uContrast: { value: 1.04 },
      uNight: { value: 0 }, uRain: { value: 0 }, uAa: { value: 1 }, uExposure: { value: 1.0 },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: QUAD_VERT, fragmentShader: FINAL_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.qscene = new THREE.Scene(); this.qscene.add(this.quad);
    this.qcam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  setSize(w, h, pixelRatio) {
    const W = Math.max(2, Math.floor(w * pixelRatio)), H = Math.max(2, Math.floor(h * pixelRatio));
    this.target.setSize(W, H);
    this.uniforms.uTexel.value.set(1 / W, 1 / H);
  }
  render(dt) {
    this.uniforms.uTime.value += dt;
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.qscene, this.qcam);
  }
}
