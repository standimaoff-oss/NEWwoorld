/* Постобработка в стиле современного рендера:
   GTAO (контактное затенение) + SSGI (глобальное освещение по глубине и цвету)
   + Bloom (мягкое свечение яркого) + God rays (лучи от солнца) + ACES.

   Все проходы работают в HDR (HalfFloat), поэтому блики не обрезаются
   до 1.0 и bloom получается физичным, а не «мыльным». */
import * as THREE from 'three';

const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/* ---- общий фрагмент: чтение глубины в линейную дистанцию ---- */
const DEPTH_HELPERS = /* glsl */`
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uNear, uFar;
float rawDepth(vec2 uv) { return texture2D(tDepth, uv).x; }
float viewZ(vec2 uv) {
  float d = rawDepth(uv);
#if defined(USE_LOGDEPTH)
  return -uFar * pow(2.0, d * (log2(uFar) - log2(uNear)) ) * 0.0 - (uNear * uFar) / (uFar - d * (uFar - uNear)) * -1.0;
#else
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
#endif
}
`;

/* ---- GTAO: контактная тень по 12 направлениям ---- */
const AO_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uNear, uFar;
uniform vec2 uRes;
uniform float uRadius, uIntensity, uProjScale;

float linearZ(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}
vec3 viewPos(vec2 uv) {
  float z = linearZ(uv);
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * z / uProjScale, ndc.y * z / uProjScale, -z);
}

const float PI = 3.14159265;

void main() {
  float cz = linearZ(vUv);
  if (cz > uFar * 0.98) { gl_FragColor = vec4(1.0); return; }
  vec3 n = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);
  if (length(n) < 0.01) { gl_FragColor = vec4(1.0); return; }

  vec3 p = viewPos(vUv);
  // радиус в единицах экрана на этой глубине
  float rPx = uRadius * uProjScale / cz;
  // поворот выборки по пикселю — убирает полосы
  float rot = fract(sin(dot(vUv * uRes, vec2(12.9898, 78.233))) * 43758.5453) * PI * 2.0;

  float occ = 0.0;
  const int STEPS = 6;
  const int DIRS = 6;
  for (int d = 0; d < DIRS; d++) {
    float ang = rot + float(d) * (PI / float(DIRS));
    vec2 dir = vec2(cos(ang), sin(ang));
    for (int s = 1; s <= STEPS; s++) {
      float t = float(s) / float(STEPS);
      vec2 uv = vUv + dir * uTexel * rPx * t;
      float sz = linearZ(uv);
      if (sz > uFar * 0.98) continue;
      vec3 q = viewPos(uv);
      vec3 v = q - p;
      float vv = dot(v, v);
      float vn = dot(v, n);
      // вклад только «полусферы над поверхностью» с плавным затуханием по радиусу
      float falloff = max(0.0, 1.0 - vv / (uRadius * uRadius));
      occ += max(0.0, vn) * falloff * inversesqrt(vv + 0.0001);
      // и небольшой вклад «сбоку», иначе плоскости не затеняют друг друга
      occ += max(0.0, -vn) * 0.0;
    }
  }
  occ /= float(STEPS * DIRS);
  float ao = clamp(1.0 - occ * uIntensity, 0.0, 1.0);
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}`;

/* ---- SSGI: один проход с цветом из буфера сцены ---- */
const SSGI_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tAO;
uniform vec2 uTexel;
uniform float uNear, uFar, uProjScale;
uniform float uStrength, uRadius;
uniform vec3 uSunColor;
uniform float uNight;

float linearZ(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}
vec3 viewPos(vec2 uv) {
  float z = linearZ(uv);
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * z / uProjScale, ndc.y * z / uProjScale, -z);
}

const float PI = 3.14159265;

void main() {
  vec3 base = texture2D(tColor, vUv).rgb;
  gl_FragColor = vec4(clamp(base, 0.0, 6.0), 1.0);
}`;

/* ---- GTAO+GI в один проход: затенение умножается, свет от соседей добавляется ---- */
const GTAO_GI_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform vec2 uTexel;
uniform float uNear, uFar, uProjScale;
uniform float uRadius, uIntensity, uGI;
uniform vec3 uSunColor;
uniform float uNight;
uniform vec2 uRes;

float linearZ(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}
vec3 viewPos(vec2 uv) {
  float z = linearZ(uv);
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * z / uProjScale, ndc.y * z / uProjScale, -z);
}

const float PI = 3.14159265;

void main() {
  vec3 col = texture2D(tColor, vUv).rgb;
  float cz = linearZ(vUv);
  if (cz > uFar * 0.98) { gl_FragColor = vec4(col, 1.0); return; }
  vec3 n = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);
  if (length(n) < 0.01) { gl_FragColor = vec4(col, 1.0); return; }
  vec3 p = viewPos(vUv);

  float rPx = uRadius * uProjScale / cz;
  float rot = fract(sin(dot(vUv * uRes, vec2(12.9898, 78.233))) * 43758.5453) * PI * 2.0;

  float occ = 0.0;
  vec3 gi = vec3(0.0);
  float giW = 0.0;
  const int STEPS = 5;
  const int DIRS = 8;
  for (int d = 0; d < DIRS; d++) {
    float ang = rot + float(d) * (PI / float(DIRS));
    vec2 dir = vec2(cos(ang), sin(ang));
    for (int s = 1; s <= STEPS; s++) {
      float t = (float(s) + 0.5) / float(STEPS);
      vec2 uv = vUv + dir * uTexel * rPx * t;
      float sz = linearZ(uv);
      if (sz > uFar * 0.98) continue;
      vec3 q = viewPos(uv);
      vec3 v = q - p;
      float vv = dot(v, v);
      if (vv < 0.0004) continue;
      float vn = dot(v, n) * inversesqrt(vv);
      // затенение: соседи над плоскостью
      float ao = max(0.0, vn) * max(0.0, 1.0 - vv / (uRadius * uRadius));
      occ += ao;
      // цветной переотражённый свет: соседи, которые светятся и стоят рядом
      float w = exp(-vv / (uRadius * uRadius * 0.55));
      gi += texture2D(tColor, uv).rgb * w * (0.55 + 0.45 * vn);
      giW += w;
    }
  }
  float nSamp = float(STEPS * DIRS);
  occ /= nSamp;
  float ao = clamp(1.0 - occ * uIntensity, 0.12, 1.0);

  vec3 indirect = vec3(0.0);
  if (giW > 0.001) {
    vec3 avg = gi / giW;
    // гасим «плоское» освещение: берём только отклонение от собственного цвета
    vec3 own = col;
    indirect = max(vec3(0.0), avg - own * 0.65);
    indirect *= uGI * (1.0 - uNight * 0.45);
  }
  vec3 outc = col * ao + indirect;
  gl_FragColor = vec4(outc, 1.0);
}`;

/* ---- Bloom: яркий проход (яркость выше порога) ---- */
const BRIGHT_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uThreshold, uSoft;
void main() {
  vec3 c = texture2D(tColor, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float k = smoothstep(uThreshold, uThreshold + uSoft, l);
  gl_FragColor = vec4(c * k, 1.0);
}`;

/* ---- размытие по двум осям (9 отсчётов, гаусс) ---- */
const BLUR_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tColor;
uniform vec2 uDir;     // texel * направление
void main() {
  vec3 sum = texture2D(tColor, vUv).rgb * 0.227027;
  sum += texture2D(tColor, vUv + uDir * 1.384615) .rgb * 0.316216;
  sum += texture2D(tColor, vUv - uDir * 1.384615).rgb * 0.316216;
  sum += texture2D(tColor, vUv + uDir * 3.230769).rgb * 0.070270;
  sum += texture2D(tColor, vUv - uDir * 3.230769).rgb * 0.070270;
  gl_FragColor = vec4(sum, 1.0);
}`;

/* ---- God rays: экранные лучи от солнца (радиальный марч к позиции солнца) ---- */
const RAYS_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tColor;      // яркий буфер после bloom
uniform sampler2D tDepth;
uniform vec2 uSunUV;
uniform float uAspect, uDensity, uWeight, uDecay, uNight, uCloudy;
void main() {
  vec2 uv = vUv;
  vec2 delta = (uSunUV - uv) * (uDensity / 40.0);
  float illum = 1.0;
  vec3 acc = vec3(0.0);
  vec2 p = uv;
  float blocked = 0.0;
  for (int i = 0; i < 40; i++) {
    p += delta;
    float dz = texture2D(tDepth, clamp(p, 0.001, 0.999)).x;
    // глубина 1.0 = небо; всё ближе — геометрия, она заслоняет лучи
    float mask = step(0.99995, dz);
    acc += texture2D(tColor, clamp(p, 0.001, 0.999)).rgb * mask * illum;
    illum *= uDecay;
  }
  vec3 rays = acc * uWeight / 40.0;
  rays *= (1.0 - uNight) * (1.0 - uCloudy * 0.65);
  gl_FragColor = vec4(rays, 1.0);
}`;

/* ---- финальный проход: композит + ACES + sRGB + виньетка ---- */
const FINAL_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tRays;
uniform vec2 uTexel;
uniform float uTime, uVignette, uSat, uContrast, uNight, uRain, uAa, uExposure;
uniform float uBloomAmt, uRaysAmt, uChroma;

vec3 sampleC(vec2 uv) { return texture2D(tColor, uv).rgb; }

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(0.41666)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = vUv;
  vec3 col = sampleC(uv);

  // хроматическая аберрация по краям кадра — «объектив»
  if (uChroma > 0.001) {
    vec2 d = uv - 0.5;
    float r2 = dot(d, d);
    vec2 off = d * r2 * uChroma * 0.012;
    col.r = sampleC(uv + off).r;
    col.g = col.g;
    col.b = sampleC(uv - off).b;
  }

  // FXAA: сглаживание кромок по соседям
  if (uAa > 0.5) {
    vec3 nw = sampleC(uv + vec2(-1.0, -1.0) * uTexel);
    vec3 ne = sampleC(uv + vec2(1.0, -1.0) * uTexel);
    vec3 sw = sampleC(uv + vec2(-1.0, 1.0) * uTexel);
    vec3 se = sampleC(uv + vec2(1.0, 1.0) * uTexel);
    vec3 luma = vec3(0.299, 0.587, 0.114);
    float lNW = dot(nw, luma), lNE = dot(ne, luma), lSW = dot(sw, luma), lSE = dot(se, luma), lM = dot(col, luma);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    if (lMax - lMin > 0.06) {
      vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
      dir = clamp(dir / (max(abs(dir.x), abs(dir.y)) + 1e-4) * uTexel * 1.6, -uTexel * 4.0, uTexel * 4.0);
      vec3 a = 0.5 * (sampleC(uv + dir * (1.0 / 3.0 - 0.5)) + sampleC(uv + dir * (2.0 / 3.0 - 0.5)));
      vec3 b = a * 0.5 + 0.25 * (sampleC(uv + dir * -0.5) + sampleC(uv + dir * 0.5));
      float lB = dot(b, luma);
      col = (lB < lMin || lB > lMax) ? a : b;
    }
  }

  // bloom и god rays — до тонмаппинга, в линейном свете
  col += texture2D(tBloom, uv).rgb * uBloomAmt;
  col += texture2D(tRays, uv).rgb * uRaysAmt;

  col = aces(col * uExposure);
  col = toSRGB(col);

  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, uSat);
  col = (col - 0.5) * uContrast + 0.5;

  col = mix(col, col * vec3(0.94, 0.97, 1.04), uRain);
  col = mix(col, col * vec3(0.92, 0.96, 1.12), uNight * 0.5);

  vec2 d = uv - 0.5;
  float vig = 1.0 - dot(d, d) * uVignette;
  col *= vig;

  float grain = fract(sin(dot(uv * vec2(1024.0, 768.0) + uTime * 3.1, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.012 * (1.0 + uNight);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.enabled = true;
    this.quality = 1;          // 1 — полный, 0.5 — мобильный
    this.useAO = true;
    this.useGI = true;
    this.useBloom = true;
    this.useRays = true;

    const hdr = {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      colorSpace: THREE.NoColorSpace, depthBuffer: false,
    };
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, samples: 0, depthBuffer: true,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.NoColorSpace,
    });
    this.aoTarget = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.brightTarget = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.bloomA = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.bloomB = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.raysTarget = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.compTarget = new THREE.WebGLRenderTarget(1, 1, hdr);

    // нормали и глубина — для GTAO/SSGI
    this.normalTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: true, colorSpace: THREE.NoColorSpace,
    });
    this.normalTarget.depthTexture = new THREE.DepthTexture(1, 1);
    this.normalTarget.depthTexture.format = THREE.DepthFormat;
    this.normalTarget.depthTexture.type = THREE.UnsignedIntType;

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.qscene = new THREE.Scene(); this.qscene.add(this.quad);
    this.qcam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.normalMat = new THREE.MeshNormalMaterial();
    this.normalOverride = null;

    this.aoUniforms = {
      tDepth: { value: this.normalTarget.depthTexture }, tNormal: { value: this.normalTarget.texture },
      tColor: { value: this.target.texture },
      uTexel: { value: new THREE.Vector2(1, 1) }, uRes: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.12 }, uFar: { value: 2600 }, uProjScale: { value: 1 },
      uRadius: { value: 2.2 }, uIntensity: { value: 2.9 }, uGI: { value: 0.75 },
      uSunColor: { value: new THREE.Color(1, 1, 1) }, uNight: { value: 0 },
    };
    this.aoMat = new THREE.ShaderMaterial({
      uniforms: this.aoUniforms, vertexShader: QUAD_VERT, fragmentShader: GTAO_GI_FRAG,
      depthTest: false, depthWrite: false,
    });

    this.brightUniforms = {
      tColor: { value: this.compTarget.texture }, uTexel: { value: new THREE.Vector2(1, 1) },
      uThreshold: { value: 1.9 }, uSoft: { value: 1.1 },
    };
    this.brightMat = new THREE.ShaderMaterial({
      uniforms: this.brightUniforms, vertexShader: QUAD_VERT, fragmentShader: BRIGHT_FRAG,
      depthTest: false, depthWrite: false,
    });

    this.blurUniforms = {
      tColor: { value: null }, uDir: { value: new THREE.Vector2() },
    };
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: this.blurUniforms, vertexShader: QUAD_VERT, fragmentShader: BLUR_FRAG,
      depthTest: false, depthWrite: false,
    });

    this.raysUniforms = {
      tColor: { value: this.bloomA.texture }, tDepth: { value: this.normalTarget.depthTexture },
      uSunUV: { value: new THREE.Vector2(0.5, 0.5) }, uAspect: { value: 1 },
      uDensity: { value: 0.72 }, uWeight: { value: 0.30 }, uDecay: { value: 0.945 },
      uNight: { value: 0 }, uCloudy: { value: 0 },
    };
    this.raysMat = new THREE.ShaderMaterial({
      uniforms: this.raysUniforms, vertexShader: QUAD_VERT, fragmentShader: RAYS_FRAG,
      depthTest: false, depthWrite: false,
    });

    this.uniforms = {
      tColor: { value: this.compTarget.texture },
      tBloom: { value: this.bloomA.texture },
      tRays: { value: this.raysTarget.texture },
      uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      uTime: { value: 0 }, uVignette: { value: 0.42 }, uSat: { value: 1.12 }, uContrast: { value: 1.05 },
      uNight: { value: 0 }, uRain: { value: 0 }, uAa: { value: 1 }, uExposure: { value: 1.0 },
      uBloomAmt: { value: 0.42 }, uRaysAmt: { value: 1.6 }, uChroma: { value: 1.0 },
    };
    this.finalMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: QUAD_VERT, fragmentShader: FINAL_FRAG,
      depthTest: false, depthWrite: false,
    });

    this.bloomLevels = [];
  }

  setQuality(level) {
    // level: 'high' | 'medium' | 'low'
    this.quality = level === 'low' ? 0.5 : level === 'medium' ? 0.75 : 1;
    this.useGI = level !== 'low';
    this.useAO = level !== 'low';
    this.useRays = level === 'high';
    this.useBloom = true;
  }

  setSize(w, h, pixelRatio) {
    const pr = Math.max(0.5, Math.min(pixelRatio || 1, 2)) * this.quality;
    const W = Math.max(2, Math.floor(w * pr)), H = Math.max(2, Math.floor(h * pr));
    this.W = W; this.H = H;
    this.target.setSize(W, H);
    this.normalTarget.setSize(W, H);
    this.normalTarget.depthTexture.image.width = W;
    this.normalTarget.depthTexture.image.height = H;
    this.normalTarget.depthTexture.needsUpdate = true;
    this.compTarget.setSize(W, H);
    this.brightTarget.setSize(Math.max(2, W >> 1), Math.max(2, H >> 1));
    this.bloomA.setSize(Math.max(2, W >> 1), Math.max(2, H >> 1));
    this.bloomB.setSize(Math.max(2, W >> 1), Math.max(2, H >> 1));
    this.raysTarget.setSize(Math.max(2, W >> 2), Math.max(2, H >> 2));
    this.aoTarget.setSize(W, H);

    const texel = new THREE.Vector2(1 / W, 1 / H);
    this.uniforms.uTexel.value.copy(texel);
    this.aoUniforms.uTexel.value.copy(texel);
    this.aoUniforms.uRes.value.set(W, H);
    this.brightUniforms.uTexel.value.copy(texel);
    this.aoUniforms.uNear.value = this.camera.near;
    this.aoUniforms.uFar.value = this.camera.far;
    // масштаб проекции: во сколько раз мир сжимается в NDC по вертикали
    this.aoUniforms.uProjScale.value = 1.0 / Math.tan((this.camera.fov * Math.PI / 180) / 2);
    this.raysUniforms.uAspect.value = W / H;
  }

  /** Параметры кадра: солнце для лучей, ночь, дождь, экспозиция. */
  setFrameState({ sunScreen, sunColor, night, rain, exposure, cloudy }) {
    if (sunScreen) {
      this.raysUniforms.uSunUV.value.set(sunScreen.x, sunScreen.y);
      this.sunOnScreen = sunScreen.onScreen !== false;
    } else {
      this.sunOnScreen = false;
    }
    this.uniforms.uNight.value = night || 0;
    this.uniforms.uRain.value = rain || 0;
    this.aoUniforms.uNight.value = night || 0;
    this.raysUniforms.uNight.value = night || 0;
    this.raysUniforms.uCloudy.value = cloudy || 0;
    this.uniforms.uExposure.value = exposure != null ? exposure : 1.0;
    if (sunColor) this.aoUniforms.uSunColor.value.copy(sunColor);
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.qscene, this.qcam);
  }

  render(dt) {
    this.uniforms.uTime.value += dt;
    const r = this.renderer;

    // 1) геометрия в HDR-буфер
    r.setRenderTarget(this.target);
    r.clear(true, true, true);
    r.render(this.scene, this.camera);

    // 1b) нормали + глубина отдельным проходом (для AO/GI/лучей)
    const prevOverride = this.scene.overrideMaterial;
    this.scene.overrideMaterial = this.normalMat;
    r.setRenderTarget(this.normalTarget);
    r.clear(true, true, true);
    r.render(this.scene, this.camera);
    this.scene.overrideMaterial = prevOverride;

    // 2) GTAO + SSGI: затенение и цветной переотражённый свет
    if (this.useAO) {
      this._pass(this.aoMat, this.compTarget);
    } else {
      this._pass(new THREE.ShaderMaterial({
        uniforms: { tColor: { value: this.target.texture } },
        vertexShader: QUAD_VERT,
        fragmentShader: 'uniform sampler2D tColor; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tColor, vUv); }',
        depthTest: false, depthWrite: false,
      }), this.compTarget);
    }

    // 3) bloom: яркий проход + двустороннее размытие
    if (this.useBloom) {
      this._pass(this.brightMat, this.brightTarget);
      this.blurUniforms.tColor.value = this.brightTarget.texture;
      this.blurUniforms.uDir.value.set(1.0 / this.brightTarget.width, 0);
      this._pass(this.blurMat, this.bloomA);
      this.blurUniforms.tColor.value = this.bloomA.texture;
      this.blurUniforms.uDir.value.set(0, 1.0 / this.brightTarget.height);
      this._pass(this.blurMat, this.bloomB);
      this.blurUniforms.tColor.value = this.bloomB.texture;
      this.blurUniforms.uDir.value.set(1.6 / this.brightTarget.width, 0);
      this._pass(this.blurMat, this.bloomA);
      this.blurUniforms.tColor.value = this.bloomA.texture;
      this.blurUniforms.uDir.value.set(0, 1.6 / this.brightTarget.height);
      this._pass(this.blurMat, this.bloomB);
      this.uniforms.tBloom.value = this.bloomB.texture;
    }

    // 4) god rays от солнца
    if (this.useRays && this.sunOnScreen) {
      this._pass(this.raysMat, this.raysTarget);
      this.uniforms.tRays.value = this.raysTarget.texture;
      this.uniforms.uRaysAmt.value = 0.75;
    } else {
      this.uniforms.uRaysAmt.value = 0.0;
    }

    // 5) финал: композит, ACES, sRGB, виньетка, зерно
    this.uniforms.tColor.value = this.compTarget.texture;
    r.setRenderTarget(null);
    this.quad.material = this.finalMat;
    r.render(this.qscene, this.qcam);
  }
}
