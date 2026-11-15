import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SSGIEffect } from './ssgi.js';
import { U, state, stats, colliders, isWater, bridgeAt, clamp, lerp } from './state.js';
import { loadAssets, initMaterials, M } from './materials.js';
import { makeSky, makeWater, makeRain } from './shaders.js';
import { makeGrass } from './vegetation.js';
import { buildWorld, makeLife } from './world.js';

const $ = s => document.querySelector(s);
const errors = [];
window.addEventListener('error', e => { errors.push(String(e.message)); showError(e.message); });
function showError(msg) { const el = $('#error'); el.hidden = false; el.textContent = 'Ошибка рендера: ' + msg; }
const VIEWS = [
  { id: 'overview', name: 'Город и канал', icon: '01', pos: [112, 72, 132], target: [0, 12, -10], text: 'Художественный квартал Пекина: плотные фасады, китайские вывески, вода и парк. Это макет графики, не копия карты OSM.' },
  { id: 'street', name: 'Хутун и вывески', icon: '02', pos: [20, 3.1, 6.5], target: [-24, 5, -8], text: 'Фототекстуры кирпича и бетона, потёртые вывески, кондиционеры, балконы, фонари и витрины. Магазин «便民超市» можно осмотреть пешком.' },
  { id: 'grass', name: 'Трава вблизи', icon: '03', pos: [24, 1.05, 62], target: [10, .3, 72], text: 'Газон из фототекстуры продолжается вдаль; вблизи добавлены объёмные травинки с ветром, цветовыми вариациями и плавным LOD по расстоянию.' },
  { id: 'bamboo', name: 'Бамбуковый парк', icon: '04', pos: [67, 2.2, 90], target: [66, 3, 70], text: 'Бамбуковая роща с узлами стеблей, листьями, каменной дорожкой, скамейками и входными воротами. Растительность расставлена процедурно.' },
  { id: 'palms', name: 'Пальмы и деревья', icon: '05', pos: [-40, 7, 44], target: [-70, 4, 66], text: 'Новые пальмы у набережной и лиственные деревья в парке вместо простых старых крон. Собственные модели-заменители, не импорт Sketchfab.' },
  { id: 'fir', name: 'Новогодняя ёлка', icon: '06', pos: [-28, 3.4, 89], target: [-40, 4.2, 77], text: 'Ель с ярусами ветвей, украшениями, звездой, подарками и тёплой подсветкой. Площадка показана как сезонный декор квартала.' },
  { id: 'water', name: 'Большая вода', icon: '07', pos: [7, 4.2, 51], target: [-12, -.3, 27], text: 'Канал 36 × 300 м: анимированные волны, отражение сцены, блики, прибрежная пена и рябь от дождя. Отражение обновляется через кадр.' },
  { id: 'rain', name: 'Дождь и окна', icon: '08', pos: [-2, 2.8, 4.5], target: [-18, 5, -8], text: 'Дождь увлажняет материалы, снижает шероховатость, даёт капли и потёки на стёклах. Облака и освещение меняются вместе с погодой.', weather: 'rain' },
  { id: 'shop', name: 'Витрина магазина', icon: '09', pos: [8, 1.9, -5.8], target: [7, 1.4, -13], text: 'Открытая витрина с полками, товаром и кассой — только визуальный макет. Экономика и игровая логика основной игры здесь не менялись.' },
];

let renderer, scene, camera, controls, composer, gtao, ssgi, sun, hemi, fill, sky, water, rainObj, grass, world, life, hdrSupported = true;
let yaw = 0, pitch = 0, walkPos = new THREE.Vector3(18, 1.75, 7), savedCam = null, tween = null;
const keys = new Set(), joy = { x: 0, y: 0, active: false };
let last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 0, statTimer = 0, tourTimer = 0, grassTimer = 0;
const isTouch = matchMedia('(pointer: coarse)').matches;

async function init() {
  const params = new URLSearchParams(location.search);
  state.quality = params.get('quality') || (isTouch ? 'medium' : 'high');
  await loadAssets(); initMaterials();
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = false;
  hdrSupported = renderer.extensions.has('EXT_color_buffer_float');
  $('#app').appendChild(renderer.domElement);
  renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); showError('WebGL-контекст потерян. Перезагрузите страницу или выберите качество ниже.'); });
  scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0xb4bcbe, .0028);
  camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, .1, 700);
  camera.position.set(...VIEWS[0].pos);
  controls = new OrbitControls(camera, renderer.domElement); controls.target.set(...VIEWS[0].target);
  controls.enableDamping = true; controls.dampingFactor = .07; controls.maxPolarAngle = Math.PI / 2 - .02; controls.minDistance = 1.5; controls.maxDistance = 280;
  hemi = new THREE.HemisphereLight(0xbfc9cf, 0x5a5948, .9); scene.add(hemi);
  fill = new THREE.AmbientLight(0x8a939a, .22); scene.add(fill);
  sun = new THREE.DirectionalLight(0xffe6bd, 2.3); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -120, right: 120, top: 120, bottom: -120, near: 1, far: 320 });
  sun.shadow.bias = -.00035; sun.shadow.normalBias = .035; scene.add(sun); scene.add(sun.target);
  sky = makeSky(scene); water = makeWater(scene); rainObj = makeRain(scene);
  if (!hdrSupported) water.getRenderTarget().texture.type = THREE.UnsignedByteType;
  sky.onBeforeRender = () => { sky.position.copy(camera.position); };
  world = buildWorld(scene); grass = makeGrass(scene); life = makeLife(scene);
  const composerTarget = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: hdrSupported ? THREE.HalfFloatType : THREE.UnsignedByteType });
  composer = new EffectComposer(renderer, composerTarget); composer.addPass(new RenderPass(scene, camera));
  gtao = new GTAOPass(scene, camera, innerWidth, innerHeight); gtao.blendIntensity = .55;
  gtao.updateGtaoMaterial({ radius: 1.4, distanceExponent: 1, thickness: 1, scale: 1, samples: 8 });
  gtao.updatePdMaterial({ radius: 4, samples: 8, rings: 2 }); composer.addPass(gtao);
  ssgi = new SSGIEffect(camera, gtao, innerWidth, innerHeight);
  composer.addPass(ssgi.estimate); composer.addPass(ssgi.composite);
  composer.addPass(new OutputPass());
  // Explicit linear-space AO composite. Fixed-function multiplicative blending on
  // half-float targets brightened the image on some ANGLE/SwiftShader drivers.
  gtao.blendMaterial.dispose();
  gtao.blendMaterial = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, tScene: { value: null }, intensity: { value: .55 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `uniform sampler2D tDiffuse,tScene; uniform float intensity; varying vec2 vUv;
      void main(){ vec4 s=texture2D(tScene,vUv); float ao=clamp(texture2D(tDiffuse,vUv).r,0.,1.);
        gl_FragColor=vec4(s.rgb*mix(1.,ao,intensity),s.a); }`,
    blending: THREE.NoBlending, depthTest: false, depthWrite: false,
  });
  const hideForAO = new Set([sky, rainObj.rain, ...grass.chunks]);
  const origOverride = gtao._overrideVisibility.bind(gtao);
  gtao._overrideVisibility = () => {
    origOverride();
    scene.traverse(o => { if (o.visible && (hideForAO.has(o) || o.material?.alphaTest > 0)) { o.visible = false; gtao._visibilityCache.push(o); } });
  };
  buildUI(); applyQuality(state.quality); setWeather(state.weather); setHour(state.hour); resize();
  addEventListener('resize', resize);
  state.ready = true; $('#loading').classList.add('done'); setTimeout(() => $('#loading').remove(), 700);
  window.__CHINA__ = { state, stats, U, errors, renderer, scene, camera, composer, gtao, ssgi, setView, setWeather, setQuality: applyQuality, setHour, views: VIEWS, screenshot, render: () => { grass.update(camera, state.quality, state.grass); renderFrame(); }, lighting: updateLighting, info: () => renderer.info.render };
  requestAnimationFrame(loop);
}
function resize() {
  if (!renderer) return;
  const q = state.quality, pr = Math.min(devicePixelRatio || 1, q === 'high' ? 1.5 : q === 'medium' ? 1 : .75);
  renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  composer.setPixelRatio(pr); composer.setSize(innerWidth, innerHeight);
  if (q === 'high') gtao.setSize(Math.floor(innerWidth * pr * .75), Math.floor(innerHeight * pr * .75));
}
function applyQuality(q) {
  state.quality = q; $('#quality').value = q;
  const shadows = q !== 'low'; renderer.shadowMap.enabled = shadows;
  sun.castShadow = shadows; const ms = q === 'high' ? 2048 : 1024;
  if (sun.shadow.mapSize.x !== ms) { sun.shadow.mapSize.set(ms, ms); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
  gtao.enabled = q === 'high' && state.ao && hdrSupported;
  ssgi.setEnabled(gtao.enabled && state.gi);
  water.getRenderTarget().setSize(q === 'high' ? 768 : 512, q === 'high' ? 512 : 384);
  resize(); grass.update(camera, q, state.grass);
  $('#qualityNote').textContent = q === 'high' ? 'ПК: тени, GTAO + SSGI, полный LOD травы' : q === 'medium' ? 'Баланс: тени и умеренная трава' : 'Телефон / слабый ПК: без тяжёлых эффектов';
}
function setWeather(w) { state.weather = w; document.querySelectorAll('[data-weather]').forEach(b => b.classList.toggle('active', b.dataset.weather === w)); }
function setHour(h) { state.hour = h; $('#hour').value = h; $('#hourLabel').textContent = `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`; }
function setView(i, instant = false) {
  state.view = i; const v = VIEWS[i];
  document.querySelectorAll('.view-btn').forEach((b, j) => b.classList.toggle('active', j === i));
  $('#viewText').textContent = v.text; $('#viewTitle').textContent = v.name;
  if (v.weather) setWeather(v.weather);
  if (state.mode === 'walk') setMode('orbit');
  if (instant) { camera.position.set(...v.pos); controls.target.set(...v.target); controls.update(); tween = null; }
  else tween = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: new THREE.Vector3(...v.pos), t1: new THREE.Vector3(...v.target) };
}
function setMode(m) {
  if (m === state.mode) return;
  if (m === 'walk') {
    savedCam = { p: camera.position.clone(), t: controls.target.clone() };
    controls.enabled = false; walkPos.set(18, 1.75, 7); yaw = 0; pitch = 0; state.mode = 'walk';
    $('#modeHint').textContent = 'WASD — ходьба · Shift — быстрее · тяните мышью — обзор';
  } else {
    state.mode = 'orbit'; controls.enabled = true;
    if (savedCam) { camera.position.copy(savedCam.p); controls.target.copy(savedCam.t); }
    $('#modeHint').textContent = 'ЛКМ — вращение · колесо — масштаб · ПКМ — сдвиг';
  }
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  $('#joy').classList.toggle('show', m === 'walk' && isTouch);
}
function buildUI() {
  const nav = $('#views');
  VIEWS.forEach((v, i) => { const b = document.createElement('button'); b.className = 'view-btn' + (i === 0 ? ' active' : ''); b.innerHTML = `<span>${v.icon}</span>${v.name}`; b.onclick = () => { state.tour = false; $('#tour').classList.remove('active'); setView(i); }; nav.appendChild(b); });
  document.querySelectorAll('[data-weather]').forEach(b => b.onclick = () => setWeather(b.dataset.weather));
  $('#hour').oninput = e => setHour(+e.target.value);
  $('#quality').onchange = e => applyQuality(e.target.value);
  for (const key of ['grass', 'water', 'plants', 'festive', 'ao', 'gi']) {
    const el = $('#' + key); el.checked = state[key];
    el.onchange = () => { state[key] = el.checked; water.visible = state.water; world.plants.forEach(g => g.visible = state.plants); world.fir.visible = state.festive; gtao.enabled = state.quality === 'high' && state.ao && hdrSupported; ssgi.setEnabled(gtao.enabled && state.gi); grass.update(camera, state.quality, state.grass); };
  }
  $('#effects').onchange = e => { U.effects.value = e.target.checked ? 1 : 0; };
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $('#tour').onclick = () => { state.tour = !state.tour; $('#tour').classList.toggle('active', state.tour); tourTimer = 0; if (state.tour) setView((state.view + 1) % VIEWS.length); };
  $('#shot').onclick = screenshot;
  $('#settings').onclick = () => $('#controls').classList.toggle('open');
  $('#guideToggle').onclick = () => $('#guide').classList.toggle('open');
  $('#creditsBtn').onclick = () => $('#credits').showModal();
  $('#closeCredits').onclick = () => $('#credits').close();
  addEventListener('keydown', e => { keys.add(e.code); if (e.code === 'Escape') { $('#credits').close(); $('#controls').classList.remove('open'); } if (e.code === 'KeyH') document.body.classList.toggle('clean'); });
  addEventListener('keyup', e => keys.delete(e.code));
  let drag = null;
  renderer.domElement.addEventListener('pointerdown', e => { if (state.mode === 'walk' && e.pointerType !== 'touch') drag = { x: e.clientX, y: e.clientY }; if (state.mode === 'walk' && e.pointerType === 'touch' && e.clientX > innerWidth * .4) drag = { x: e.clientX, y: e.clientY, touch: true }; });
  addEventListener('pointermove', e => { if (!drag) return; yaw -= (e.clientX - drag.x) * .004; pitch = clamp(pitch - (e.clientY - drag.y) * .003, -1.2, 1.2); drag.x = e.clientX; drag.y = e.clientY; });
  addEventListener('pointerup', () => drag = null);
  const joyEl = $('#joy'), knob = $('#joyKnob');
  joyEl.addEventListener('pointerdown', e => { joy.active = true; joyEl.setPointerCapture(e.pointerId); moveJoy(e); });
  joyEl.addEventListener('pointermove', e => { if (joy.active) moveJoy(e); });
  joyEl.addEventListener('pointerup', () => { joy.active = false; joy.x = joy.y = 0; knob.style.transform = 'translate(0,0)'; });
  function moveJoy(e) { const r = joyEl.getBoundingClientRect(), dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2, l = Math.hypot(dx, dy), k = l > 36 ? 36 / l : 1; joy.x = dx * k / 36; joy.y = dy * k / 36; knob.style.transform = `translate(${dx * k}px,${dy * k}px)`; }
  setView(0, true);
}
function screenshot() {
  renderFrame();
  const a = document.createElement('a'); a.download = `china-preview-${VIEWS[state.view].id}.png`; a.href = renderer.domElement.toDataURL('image/png'); a.click();
  $('#toast').textContent = 'Скриншот сохранён'; $('#toast').classList.add('show'); setTimeout(() => $('#toast').classList.remove('show'), 1800);
}
function updateLighting(dt) {
  U.rain.value = lerp(U.rain.value, state.weather === 'rain' ? 1 : 0, Math.min(1, dt * 1.6));
  const a = (state.hour - 6) / 16 * Math.PI, sy = Math.sin(a);
  U.sunDir.value.set(Math.cos(a) * .65, Math.max(sy, -.2), .38).normalize();
  const day = clamp(sy * 2.2, 0, 1); U.night.value = 1 - clamp((sy + .05) * 3, 0, 1);
  sun.position.copy(U.sunDir.value).multiplyScalar(140); sun.intensity = Math.max(sy, 0) * 2.6 * (1 - U.rain.value * .65);
  hemi.intensity = .16 + day * .8 * (1 - U.rain.value * .3); fill.intensity = .12 + U.night.value * .08;
  // Linear-space colors match the procedural sky horizon after tone mapping.
  const fogDay = new THREE.Color().setRGB(.68, .72, .72), fogNight = new THREE.Color().setRGB(.055, .07, .09), fogRain = new THREE.Color().setRGB(.43, .47, .49);
  scene.fog.color.copy(fogDay).lerp(fogNight, U.night.value).lerp(fogRain, U.rain.value * .55);
  scene.fog.density = .0028 + U.rain.value * .0014 - U.night.value * .0004;
  renderer.toneMappingExposure = 1.05 + U.night.value * .18;
  scene.userData.signMats.forEach(m => m.emissiveIntensity = .06 + U.night.value * .75);
  M.lamp.emissiveIntensity = .35 + U.night.value * 2.2;
  world.lights.forEach((l, i) => l.intensity = U.night.value * (i === 0 && state.festive ? 38 : 22));
  if (world.interior) world.interior.intensity = 24 + U.night.value * 16;
  if (world.interiorFill) world.interiorFill.intensity = 10 + U.night.value * 6;
  rainObj.rain.visible = U.rain.value > .02 && U.effects.value > .5; rainObj.center.value.copy(camera.position);
}
function updateWalk(dt) {
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 9 : 4.2) * dt;
  let fx = 0, fz = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) fz -= 1; if (keys.has('KeyS') || keys.has('ArrowDown')) fz += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) fx -= 1; if (keys.has('KeyD') || keys.has('ArrowRight')) fx += 1;
  fx += joy.x; fz += joy.y;
  const l = Math.hypot(fx, fz); if (l > 1) { fx /= l; fz /= l; }
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  const dx = (fx * cos + fz * sin) * speed, dz = (-fx * sin + fz * cos) * speed;
  const nx = clamp(walkPos.x + dx, -116, 116), nz = clamp(walkPos.z + dz, -110, 116);
  const blocked = (x, z) => colliders.some(c => !c.skip && x > c.x0 - .3 && x < c.x1 + .3 && z > c.z0 - .3 && z < c.z1 + .3) || (isWater(x, nz) && !bridgeAt(x));
  if (!blocked(nx, walkPos.z)) walkPos.x = nx;
  if (!blocked(walkPos.x, nz)) walkPos.z = nz;
  walkPos.y = (isWater(walkPos.x, walkPos.z) && bridgeAt(walkPos.x) ? .55 : .12) + 1.65;
  camera.position.copy(walkPos); camera.rotation.set(pitch, yaw, 0, 'YXZ');
  U.player.value.copy(walkPos);
}
function renderFrame() {
  // Always render through the linear HDR composer. Three.js applies scene fog in
  // the render target's color space; mixing direct-to-screen and composer frames
  // made the fog (and the whole city) wash out whenever GTAO was enabled.
  renderer.info.reset();
  if (gtao.enabled) gtao.blendMaterial.uniforms.tScene.value = composer.readBuffer.texture;
  composer.render();
}
function loop(now) {
  requestAnimationFrame(loop);
  const rawDt = (now - last) / 1000, dt = Math.min(rawDt, .05); last = now;
  if (state.freeze) return;
  if (!state.paused) { U.time.value += dt; life.update(dt, U.time.value); }
  if (tween) { tween.t += dt / 1.35; const k = clamp(tween.t, 0, 1), e = k * k * (3 - 2 * k); camera.position.lerpVectors(tween.p0, tween.p1, e); controls.target.lerpVectors(tween.t0, tween.t1, e); if (k >= 1) tween = null; }
  if (state.mode === 'orbit') controls.update(); else updateWalk(dt);
  if (state.tour) { tourTimer += dt; if (tourTimer > 8) { tourTimer = 0; setView((state.view + 1) % VIEWS.length); } }
  updateLighting(dt);
  grassTimer += dt; if (grassTimer > .4) { grassTimer = 0; grass.update(camera, state.quality, state.grass); }
  renderFrame();
  fpsAcc += rawDt; fpsN++; statTimer += rawDt;
  if (statTimer > .5) {
    fps = Math.round(fpsN / Math.max(fpsAcc, .001)); fpsAcc = fpsN = statTimer = 0;
    const inf = renderer.info.render;
    $('#stats').textContent = `${fps} FPS · ${(inf.triangles / 1000).toFixed(0)}k треуг. · ${inf.calls} draw · трава ${stats.grass.toLocaleString('ru-RU')} · бамбук ${stats.bamboo}`;
    $('#renderBadge').textContent = `${state.quality.toUpperCase()} · WebGL2 · ${gtao.enabled ? (ssgi.enabled ? 'GTAO + SSGI' : 'GTAO') : 'без AO'} · ${state.weather === 'rain' ? 'дождь' : 'ясно'}`;
  }
}
init().catch(e => { errors.push(String(e.stack || e)); showError(e.message); $('#loading').classList.add('done'); console.error(e); });
