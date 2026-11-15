/* Погода и время суток: дождь полосами, брызги на земле, молнии, лужи; солнце и цвет неба по часам. */
import * as THREE from 'three';
import { settings, q } from '../core/settings.js';
import { rng } from '../world/gen.js';

export const DAY_SECONDS = 900; // полный цикл (24 ч) — 15 минут игры

export class Weather {
  constructor(scene) {
    this.scene = scene;
    this.hour = 9.4;
    this.day = 1;
    this.time = 0;
    this.rain = 0;         // 0..1 текущий
    this.rainTarget = 0;
    this.wetness = 0;
    this.lightning = 0;
    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.sunColor = new THREE.Color();
    this.skyTop = new THREE.Color();
    this.skyHor = new THREE.Color();
    this.groundAmb = new THREE.Color();
    this.fogColor = new THREE.Color();
    this.night = 0;
    this.grassWet = 0;
    this._buildRain();
    this.applySettings();
    this.recalc();
  }

  _buildRain() {
    const N = 7000;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 6);
    const seed = new Float32Array(N * 2);
    const anchor = new Float32Array(N * 6);   // одинаковый для обеих вершин линии
    const rnd = rng(5);
    for (let i = 0; i < N; i++) {
      const x = (rnd() - 0.5) * 60, y = rnd() * 26, z = (rnd() - 0.5) * 60;
      const len = 0.22 + rnd() * 0.45;
      pos[i * 6] = x; pos[i * 6 + 1] = y; pos[i * 6 + 2] = z;
      pos[i * 6 + 3] = x + 0.16; pos[i * 6 + 4] = y + len; pos[i * 6 + 5] = z + 0.06;
      // якорь = середина линии: по нему считаем «заворачивание», чтобы линия не растягивалась
      const ay = y + len * 0.5;
      anchor[i * 6] = x; anchor[i * 6 + 1] = ay; anchor[i * 6 + 2] = z;
      anchor[i * 6 + 3] = x; anchor[i * 6 + 4] = ay; anchor[i * 6 + 5] = z;
      seed[i * 2] = rnd(); seed[i * 2 + 1] = rnd();
    }
    g.setAttribute('aAnchor', new THREE.BufferAttribute(anchor, 3));
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 2));
    this.rainUniforms = {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uRain: { value: 0 },
      uColor: { value: new THREE.Color(0.86, 0.90, 0.96) },
      uWind: { value: new THREE.Vector2(0.3, 0.12) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.rainUniforms,
      transparent: true, depthWrite: false,
      vertexShader: /* glsl */`
        attribute vec2 aSeed;
        attribute vec3 aAnchor;
        uniform float uTime; uniform vec3 uCam; uniform float uRain; uniform vec2 uWind;
        varying float vA;
        void main(){
          float fall = 20.0 + aSeed.x * 14.0;
          // якорь падает и заворачивается в кубе 60 x 26 x 60
          vec3 a = aAnchor;
          a.y = mod(a.y - uTime * fall, 26.0);
          a.x = mod(a.x + uTime * uWind.x * 5.0 + 30.0, 60.0) - 30.0;
          a.z = mod(a.z + uTime * uWind.y * 5.0 + 30.0, 60.0) - 30.0;
          // смещение вершины относительно якоря переносим вместе с ним
          vec3 p = position + (a - aAnchor);
          // куб дождя стоит вокруг камеры
          p += vec3(uCam.x, 0.0, uCam.z);
          vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
          float d = length(mv.xyz);
          vA = uRain * (1.0 - smoothstep(12.0, 32.0, d)) * (0.35 + aSeed.y * 0.5);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        varying float vA;
        void main(){ if (vA < 0.01) discard; gl_FragColor = vec4(uColor, vA * 0.62); }`,
    });
    this.rainMesh = new THREE.LineSegments(g, mat);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.renderOrder = 800;
    this.scene.add(this.rainMesh);

    // брызги: кольца на земле
    const RN = 260;
    const rg = new THREE.BufferGeometry();
    const rp = new Float32Array(RN * 3), rs = new Float32Array(RN);
    const r2 = rng(11);
    for (let i = 0; i < RN; i++) { rp[i * 3] = (r2() - 0.5) * 60; rp[i * 3 + 1] = 0.21; rp[i * 3 + 2] = (r2() - 0.5) * 60; rs[i] = r2(); }
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    rg.setAttribute('aSeed', new THREE.BufferAttribute(rs, 1));
    this.splashUniforms = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uRain: { value: 0 } };
    const smat = new THREE.ShaderMaterial({
      uniforms: this.splashUniforms, transparent: true, depthWrite: false,
      vertexShader: /* glsl */`
        attribute float aSeed; uniform float uTime; uniform vec3 uCam; uniform float uRain;
        varying float vT; varying float vA;
        void main(){
          vec3 p = position;
          float period = 0.65 + aSeed * 0.6;
          float t = mod(uTime + aSeed * 13.0, period) / period;
          p.x = mod(p.x - uCam.x + 30.0, 60.0) - 30.0 + uCam.x;
          p.z = mod(p.z - uCam.z + 30.0, 60.0) - 30.0 + uCam.z;
          float s = 0.06 + t * 0.26;
          p.xz += position.xz * 0.0;
          vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = s * 260.0 / max(1.0, -mv.z);
          vT = t;
          float d = length(mv.xyz);
          vA = uRain * (1.0 - smoothstep(10.0, 30.0, d)) * (1.0 - t);
        }`,
      fragmentShader: /* glsl */`
        varying float vT; varying float vA;
        void main(){
          vec2 c = gl_PointCoord - 0.5;
          float r = length(c) * 2.0;
          float ring = smoothstep(0.75, 1.0, r) - smoothstep(1.0, 1.0, r);
          if (ring < 0.02) discard;
          gl_FragColor = vec4(0.78, 0.85, 0.9, ring * vA * 0.5);
        }`,
    });
    this.splash = new THREE.Points(rg, smat);
    this.splash.frustumCulled = false;
    this.splash.renderOrder = 799;
    this.scene.add(this.splash);
  }

  applySettings() {
    if (settings.weather === 'clear') this.rainTarget = 0;
    else if (settings.weather === 'rain') this.rainTarget = 0.75;
    else if (settings.weather === 'storm') this.rainTarget = 1.0;
    else this.rainTarget = 0.0; // auto — задаёт сезон/расписание
  }

  setHour(h) { this.hour = ((h % 24) + 24) % 24; this.recalc(); }

  /** Медленно меняющийся сценарий погоды (если auto). */
  _autoWeather(dt) {
    if (settings.weather !== 'auto') {
      this.rainTarget = settings.weather === 'clear' ? 0 : settings.weather === 'rain' ? 0.7 : 1.0;
      return;
    }
    // «система» фронтов: каждые ~10 игровых минут решаем, будет ли дождь
    this._frontTimer = (this._frontTimer || 0) + dt;
    if (this._frontTimer > 90) {
      this._frontTimer = 0;
      const r = Math.random();
      const season = settings.season;
      if (season === 'winter') this.rainTarget = r < 0.45 ? 0.55 : 0;   // снег
      else if (season === 'autumn') this.rainTarget = r < 0.5 ? 0.6 : 0.05;
      else this.rainTarget = r < 0.22 ? 0.5 : 0;
    }
  }

  update(dt) {
    this.time += dt;
    const dayLen = DAY_SECONDS;
    this.hour += (dt / dayLen) * 24 * (this.timeScale || 1);
    if (this.hour >= 24) { this.hour -= 24; this.day++; }
    this._autoWeather(dt);
    // переход погоды по настенному времени (не зависит от FPS)
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const wdt = this._lastWall ? Math.min(0.5, (nowMs - this._lastWall) / 1000) : dt;
    this._lastWall = nowMs;
    const eff = Math.max(dt, wdt);
    const k = 1 - Math.exp(-eff * 1.6);
    this.rain += (this.rainTarget - this.rain) * k;
    this.wetness += ((this.rain > 0.15 ? this.rain : 0) - this.wetness) * (1 - Math.exp(-eff * 0.45));
    this.lightning = Math.max(0, this.lightning - dt * 2.2);
    if (settings.weather === 'storm' && Math.random() < dt * 0.14) this.lightning = 1;
    this.recalc();
    this.rainUniforms.uTime.value = this.time;
    this.rainUniforms.uRain.value = this.rain;
    if (this.camera) { this.rainUniforms.uCam.value.copy(this.camera.position); this.splashUniforms.uCam.value.copy(this.camera.position); }
    this.splashUniforms.uTime.value = this.time;
    this.splashUniforms.uRain.value = this.rain;
    this.rainMesh.visible = this.rain > 0.02;
    this.splash.visible = this.rain > 0.02;
  }

  recalc() {
    const h = this.hour;
    // высота солнца: восход 6:00, закат 20:00
    const ang = ((h - 6) / 14) * Math.PI;
    const sunUp = h >= 5.5 && h <= 20.5;
    const el = sunUp ? Math.sin(ang) : -0.25;
    const az = Math.cos(ang);
    this.sunDir.set(0.55 * az + 0.12, Math.max(-0.4, el * 1.05), 0.72).normalize();
    this.moonDir.copy(this.sunDir).multiplyScalar(-1);
    // ночь 0..1
    const dayLight = Math.max(0, Math.min(1, (el + 0.10) / 0.30));
    this.night = 1 - dayLight;
    const dusk = Math.max(0, 1 - Math.abs(el) / 0.30) * (el > -0.1 ? 1 : 0.45); // заря
    this.dusk = dusk;
    // цвета
    const dayTop = new THREE.Color(0.045, 0.17, 0.58);
    const dayHor = new THREE.Color(0.47, 0.66, 0.90);
    const nightTop = new THREE.Color(0.004, 0.008, 0.025);
    const nightHor = new THREE.Color(0.045, 0.06, 0.11);
    const duskTop = new THREE.Color(0.12, 0.16, 0.34);
    const duskHor = new THREE.Color(0.98, 0.55, 0.28);
    this.skyTop.copy(nightTop).lerp(dayTop, dayLight);
    this.skyHor.copy(nightHor).lerp(dayHor, dayLight).lerp(duskHor, dusk * 0.62);
    this.skyTop.lerp(duskTop, dusk * 0.55);
    // пасмурность: дождь сгоняет синеву в серое (иначе небо остаётся бирюзовым)
    const overcast = new THREE.Color(0.44, 0.47, 0.50).multiplyScalar(0.12 + dayLight * 0.88);
    const overcastHor = new THREE.Color(0.62, 0.65, 0.68).multiplyScalar(0.10 + dayLight * 0.90);
    const cloudAmt = Math.min(1, this.rain * 1.15 + this.cloudCoverage * 0.55);
    this.skyTop.lerp(overcast, cloudAmt);
    this.skyHor.lerp(overcastHor, cloudAmt);
    this.groundAmb.copy(new THREE.Color(0.05, 0.055, 0.07)).lerp(new THREE.Color(0.34, 0.36, 0.31), dayLight);
    this.sunColor.setRGB(1.0, 0.95, 0.86).lerp(new THREE.Color(1.0, 0.62, 0.34), dusk * 0.9).multiplyScalar(dayLight * 1.05 + 0.02);
    // дождь гасит свет
    const rainDim = 1 - this.rain * 0.45;
    this.sunColor.multiplyScalar(rainDim);
    const fogBase = new THREE.Color(0.72, 0.78, 0.85).lerp(new THREE.Color(0.05, 0.06, 0.09), this.night);
    this.fogColor.copy(fogBase).lerp(this.skyHor, 0.55).lerp(new THREE.Color(0.35, 0.36, 0.38), this.rain * 0.45);
    this.lightIntensity = (0.35 + 2.1 * dayLight) * (1 - this.rain * 0.55) + this.lightning * 2.6;
    this.ambientIntensity = 0.38 + 0.95 * dayLight + this.rain * 0.18;
    this.cloudCoverage = 0.20 + this.rain * 0.60;
    this.cloudDensity = 1.15 + this.rain * 0.9;
    this.grassWet = this.wetness;
    this.sunDirWorld = this.sunDir;
  }

  clockText() {
    const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }
  isNight() { return this.night > 0.45; }
}
