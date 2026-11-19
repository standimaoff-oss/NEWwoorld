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
    this.snowAmount = 0;   // 0..1 — сколько идёт снег (зимой)
    this.rainAmount = 0;   // 0..1 — сколько идёт дождь (не зимой)
    // Константы цвета считаются один раз: раньше recalc() создавал по 14
    // объектов THREE.Color каждый кадр и нагружал сборщик мусора.
    this._c = {
      dayTop: new THREE.Color(0.045, 0.17, 0.58),
      dayHor: new THREE.Color(0.47, 0.66, 0.90),
      nightTop: new THREE.Color(0.004, 0.008, 0.025),
      nightHor: new THREE.Color(0.045, 0.06, 0.11),
      duskTop: new THREE.Color(0.10, 0.09, 0.24),
      duskMid: new THREE.Color(0.62, 0.26, 0.22),
      duskHor: new THREE.Color(1.0, 0.36, 0.09),
      overcast: new THREE.Color(0.44, 0.47, 0.50),
      overcastHor: new THREE.Color(0.62, 0.65, 0.68),
      groundNight: new THREE.Color(0.05, 0.055, 0.07),
      groundDay: new THREE.Color(0.34, 0.36, 0.31),
      sunWarm: new THREE.Color(1.0, 0.40, 0.10),
      fogDay: new THREE.Color(0.72, 0.78, 0.85),
      fogNight: new THREE.Color(0.05, 0.06, 0.09),
      fogRain: new THREE.Color(0.35, 0.36, 0.38),
      snowTint: new THREE.Color(0.90, 0.94, 1.0),
    };
    this._overcast = new THREE.Color();
    this._overcastHor = new THREE.Color();
    this._buildRain();
    this._buildSnow();
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

  /** Снег: дешёвые точки (не линии дождя) в кубе вокруг камеры. */
  _buildSnow() {
    const Q = q();
    const N = Math.round((Q.rain || 0.8) * 5200) + 900;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    const rnd = rng(29);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (rnd() - 0.5) * 44;
      pos[i * 3 + 1] = rnd() * 22;
      pos[i * 3 + 2] = (rnd() - 0.5) * 44;
      seed[i] = rnd();
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.snowUniforms = {
      uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uSnow: { value: 0 },
      uSize: { value: 1.0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.snowUniforms, transparent: true, depthWrite: false,
      vertexShader: /* glsl */`
        attribute float aSeed;
        uniform float uTime; uniform vec3 uCam; uniform float uSnow; uniform float uSize;
        varying float vA;
        void main(){
          vec3 p = position;
          float fall = 1.1 + aSeed * 1.6;
          p.y = mod(p.y - uTime * fall, 22.0);
          p.x += sin(uTime * 0.8 + aSeed * 31.0) * 0.9;
          p.z += cos(uTime * 0.6 + aSeed * 17.0) * 0.7;
          p.x = mod(p.x + uCam.x + 22.0, 44.0) - 22.0 + uCam.x;
          p.z = mod(p.z + uCam.z + 22.0, 44.0) - 22.0 + uCam.z;
          vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
          float d = length(mv.xyz);
          vA = uSnow * (1.0 - smoothstep(14.0, 26.0, d)) * (0.45 + aSeed * 0.55);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (0.05 + aSeed * 0.07) * uSize * 900.0 / max(1.0, -mv.z);
        }`,
      fragmentShader: /* glsl */`
        varying float vA;
        void main(){
          vec2 c = gl_PointCoord - 0.5;
          float r = dot(c, c);
          if (r > 0.25) discard;
          gl_FragColor = vec4(0.97, 0.98, 1.0, vA * (1.0 - r * 4.0) * 0.9);
        }`,
    });
    this.snowMesh = new THREE.Points(g, mat);
    this.snowMesh.frustumCulled = false;
    this.snowMesh.renderOrder = 801;
    this.snowMesh.visible = false;
    this.scene.add(this.snowMesh);
  }

  applySettings() {
    const m = settings.weather;
    const winter = settings.season === 'winter';
    // Базовая облачность и «лишний» туман: раньше cloudy/fog/snow попадали
    // в ветку auto и ничем не отличались от неё, хотя эти режимы описаны
    // в README и в меню.
    this.overcast = 0.14;
    this.extraFog = 0;
    if (m === 'clear') this.rainTarget = 0;
    else if (m === 'cloudy') { this.rainTarget = 0; this.overcast = 0.6; }
    else if (m === 'fog') { this.rainTarget = 0; this.overcast = 0.78; this.extraFog = 1; }
    else if (m === 'rain') this.rainTarget = 0.75;
    else if (m === 'storm') this.rainTarget = 1.0;
    else if (m === 'snow') this.rainTarget = 0.55;
    else {
      // auto — задаёт сезон: зимой это тихий снег, осенью — редкая морось
      this.rainTarget = winter ? 0.42 : settings.season === 'autumn' ? 0.12 : 0.0;
    }
  }

  setHour(h) { this.hour = ((h % 24) + 24) % 24; this.recalc(); }

  /** Сколько частиц рисовать: на низком качестве хватает половины. */
  setParticleBudget(frac = 1) {
    const f = Math.max(0.2, Math.min(1, frac));
    if (this.rainMesh) this.rainMesh.geometry.setDrawRange(0, Math.floor(7000 * 2 * f));
    if (this.splash) this.splash.geometry.setDrawRange(0, Math.floor(260 * f));
    if (this.snowMesh) this.snowMesh.geometry.setDrawRange(0, Math.floor(this.snowMesh.geometry.attributes.position.count * f));
    this.particleFraction = f;
  }

  /** Медленно меняющийся сценарий погоды (если auto). */
  _autoWeather(dt) {
    if (settings.weather !== 'auto') {
      // один источник истины: те же цели, что и при смене настроек.
      // Раньше незнакомое значение (например ?weather=snow из старых
      // ссылок) считалось грозой и включало дождь на полную мощность.
      this.applySettings();
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
    // Зимой осадки — снег: он рисуется точками, без брызг и без «мокрых» материалов.
    const winter = settings.season === 'winter';
    this.snowAmount = winter ? this.rain : 0;
    this.rainAmount = winter ? 0 : this.rain;
    if (winter) this.wetness = 0;
    this.rainUniforms.uTime.value = this.time;
    this.rainUniforms.uRain.value = this.rainAmount;
    if (this.camera) {
      this.rainUniforms.uCam.value.copy(this.camera.position);
      this.splashUniforms.uCam.value.copy(this.camera.position);
      this.snowUniforms.uCam.value.copy(this.camera.position);
    }
    this.splashUniforms.uTime.value = this.time;
    this.splashUniforms.uRain.value = this.rainAmount;
    this.snowUniforms.uTime.value = this.time;
    this.snowUniforms.uSnow.value = this.snowAmount;
    this.rainMesh.visible = this.rainAmount > 0.02;
    this.splash.visible = this.rainAmount > 0.02;
    this.snowMesh.visible = this.snowAmount > 0.02;
  }

  recalc() {
    const h = this.hour;
    // высота солнца: восход 6:00, закат 20:00
    const ang = ((h - 6) / 14) * Math.PI;
    const sunUp = h >= 5.5 && h <= 20.5;
    const el = sunUp ? Math.sin(ang) : -0.25;
    const az = Math.cos(ang);
    // Закат должен быть виден в кадре, а не уходить за спину: у солнца
    // азимут ведёт себя как в реальности — в полдень оно выше и «прямо»,
    // к вечеру смещается к западу (−X) с ощутимой составляющей по −Z.
    const lowSun = 1 - Math.min(1, Math.max(0, el) / 0.55); // 0 днём → 1 у горизонта
    this.sunDir.set(
      0.55 * az + 0.12 - lowSun * 0.62,
      Math.max(-0.4, el * 1.55 + 0.12),
      0.72 - lowSun * 0.55,
    ).normalize();
    this.moonDir.copy(this.sunDir).multiplyScalar(-1);
    // ночь 0..1
    const dayLight = Math.max(0, Math.min(1, (el + 0.10) / 0.30));
    this.night = 1 - dayLight;
    // золотой час: солнце уже низко, но ещё светит — именно тут небо оранжевое.
    // Раньше dusk считался слишком «узко» и синева дня перебивала закат в серый.
    // заря живёт только пока солнце у горизонта: |el| < 0.42 и гаснет ночью
    const duskRaw = Math.pow(Math.max(0, 1 - Math.abs(el) / 0.42), 0.75);
    const dusk = duskRaw * (el > -0.06 ? 1 : Math.max(0, 1 + el / 0.30));
    this.dusk = dusk;
    // цвета (без аллокаций: константы в this._c, промежуточные — scratch-цвета)
    const C = this._c;
    // Закат: сначала «снимаем» дневную синеву, и только потом добавляем оранжевый.
    // Прямой lerp через промежуточные тона давал серо-сиреневую кашу вместо зари.
    this.skyTop.copy(C.nightTop).lerp(C.dayTop, dayLight).lerp(C.duskTop, Math.min(1, dusk * 1.15));
    // горизонт: дневная синева гаснет, затем прогревается до насыщенного оранжевого
    this.skyHor.copy(C.nightHor).lerp(C.dayHor, dayLight * (1 - dusk * 0.85));
    this.skyHor.lerp(C.duskMid, Math.min(1, dusk * 0.95));
    this.skyHor.lerp(C.duskHor, Math.min(1, dusk * dusk * 1.35));
    // пасмурность: дождь/снег сгоняет синеву в серое (иначе небо остаётся бирюзовым)
    this._overcast.copy(C.overcast).multiplyScalar(0.12 + dayLight * 0.88);
    this._overcastHor.copy(C.overcastHor).multiplyScalar(0.10 + dayLight * 0.90);
    const cloudAmt = Math.min(1, this.rain * 1.15 + this.cloudCoverage * 0.55);
    this.skyTop.lerp(this._overcast, cloudAmt);
    this.skyHor.lerp(this._overcastHor, cloudAmt);
    this.groundAmb.copy(C.groundNight).lerp(C.groundDay, dayLight);
    this.sunColor.setRGB(1.0, 0.95, 0.86).lerp(C.sunWarm, Math.min(1, dusk * 1.3)).multiplyScalar(dayLight * 1.05 + 0.02);
    // дождь гасит свет
    this.sunColor.multiplyScalar(1 - this.rain * 0.45);
    this._fogBase = this._fogBase || new THREE.Color();
    this._fogBase.copy(C.fogDay).lerp(C.fogNight, this.night);
    this.fogColor.copy(this._fogBase).lerp(this.skyHor, 0.55).lerp(C.fogRain, this.rain * 0.45);
    // зимой туман холоднее и светлее — снег отражает много света
    if (settings.season === 'winter') this.fogColor.lerp(C.snowTint, 0.22);
    let lightI = (0.42 + 3.0 * dayLight) * (1 - this.rain * 0.55) + this.lightning * 2.6;
    // снег отражает почти всё: без поправки зимний кадр выгорал
    if (settings.season === 'winter') lightI *= 0.9;
    this.lightIntensity = lightI;
    // Небо подсвечивает тени, но не должно их стирать: 0.95 → 0.62 по амплитуде
    this.ambientIntensity = (0.26 + 0.62 * dayLight) * (1 - dusk * 0.18) + this.rain * 0.14;
    const overcast = Math.max(this.overcast || 0.14, 0.14 + this.rain * 0.35);
    this.cloudCoverage = Math.min(1, overcast + this.rain * 0.35);
    this.cloudDensity = 0.95 + this.rain * 1.05 + Math.max(0, overcast - 0.14) * 0.9;
    // плотность тумана считает погода, а не main: так режим «туман» реально виден
    this.fogDensity = 0.0012 + this.rain * 0.0022 + (this.extraFog || 0) * 0.0028;
    this.grassWet = this.wetness;
    this.sunDirWorld = this.sunDir;
  }

  clockText() {
    const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }
  isNight() { return this.night > 0.45; }
}
