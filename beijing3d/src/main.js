import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SSGIEffect } from '../../preview/src/ssgi.js';
import { U, state, stats, colliders, clamp, lerp } from '../../preview/src/state.js';
import { makeSky, makeRain } from '../../preview/src/shaders.js';
import { initSceneMaterials, M, Batch } from './materials.js';
import { buildScene, setLayer } from './osm.js';
import { makeOsmGrass } from './grass.js';
import { makeLabels } from './labels.js';
import { updateSignLighting, updateSignsVisibility } from './signs.js';
import { DATA, META, LAYERS, CLIP, CENTER, SPAN, featureById, centerOf, bboxOf, escapeHtml, SEARCH_ALIASES } from './config.js';

const $ = s => document.querySelector(s);
const errors = [];
window.addEventListener('error', e => { errors.push(String(e.message)); showError(e.message); });
window.addEventListener('unhandledrejection', e => { errors.push(String(e.reason)); showError(String(e.reason)); });
function showError(msg) { const el = $('#error'); el.hidden = false; el.textContent = 'Ошибка рендера: ' + msg; }

// State extensions: every OSM layer is independently switchable. Stylistic
// details are explicitly separate from surveyed footprints and road lines.
state.layers = Object.fromEntries(LAYERS.map(([k]) => [k, true]));
state.showAllLabels = false;
state.selectedId = null;
state.freeze = false;
state.paused = false;
state.grass = true;
state.plants = true;
state.ao = true;
state.gi = true;

const S = META.stats;
const nf = new Intl.NumberFormat('ru-RU');

function makeViews() {
  const gulou = centerOf('w25091600', [210, 179]);
  const drum = centerOf('w267371087', [-320.55, 204.49]);
  const bell = centerOf('w425993664', [-329.44, 389.29]);
  const houhai = centerOf('r409777', [-764.38, 94.82]);
  const beihai = centerOf('w366464114', [-729.06, -808.88]);
  return [
    { id: 'overview', name: 'Гулоу · OSM 3D', icon: '01', pos: [-100, 45, 500], target: [-350, 12, 280],
      text: `Низкий косой 3D-вид на плотную часть квартала: ${nf.format(S.buildings)} контуров зданий, ${nf.format(S.highwayWaysRendered)} highway-way и ${nf.format(S.alleyWaysRendered)} хутунов. Свободная камера, не top-down план.` },
    { id: 'nanluogu', name: 'Наньлогусян', icon: '02', pos: [400, 14, -720], target: [290, 4, -500],
      text: `Южный участок 南锣鼓巷 · OSM way 4922662. Полоса, поверхность paving_stones и примыкающие переулки взяты из выгрузки. Покрытие building-контуров неравномерное: пустые участки не заполнены выдуманными зданиями, см. «Данные».` },
    { id: 'hutong', name: 'Переулки между зданиями', icon: '03', pos: [-450, 2.5, 150], target: [-350, 3, 320],
      text: `Уровень улицы среди реальных OSM-контуров у Гулоу: ${nf.format(S.alleyWaysRendered)} межквартальных проездов, пешеходных и служебных хутунов. Это не одна улица без переулков.` },
    { id: 'drum', name: 'Барабанная башня', icon: '04', pos: [-240, 42, 70], target: [drum[0], 22, drum[1]],
      text: `鼓楼 / Drum Tower, OSM way 267371087: контур и height=47 м из OSM, heritage relation 7301352. Объём — экструзия footprint, а не фотограмметрия.` },
    { id: 'bell', name: 'Колокольная башня', icon: '05', pos: [-235, 43, 505], target: [bell[0], 23, bell[1]],
      text: `钟楼 / Bell Tower, OSM way 425993664. В OSM нет height: 47.9 м взято из внешнего справочника [1] и прямо раскрыто в ограничениях.` },
    { id: 'gulou', name: 'Гулоу · площадь', icon: '06', pos: [gulou[0] + 150, 55, gulou[1] - 210], target: [gulou[0], 10, gulou[1]],
      text: `鼓楼东大街 и площадь между башнями: дороги, barrier и POI из OSM. GTAO + SSGI подсвечивают реальную плотность застройки.` },
    { id: 'houhai', name: 'Шичахай · вода', icon: '07', pos: [-480, 65, 330], target: [houhai[0], 1, houhai[1]],
      text: `什刹后海 / Houhai Lake, OSM relation 409777. Плоский водный полигон без батиметрии; часть member-way озёр отсутствует в bbox и disclosed.` },
    { id: 'beihai', name: 'Парк Бэйхай', icon: '08', pos: [-520, 62, -520], target: [beihai[0], 2, beihai[1]],
      text: `北海公园 / Beihai Park и озеро: реальные полигоны OSM, объёмная трава только внутри green/pitch контуров. Деревья OSM: ${S.trees}.` },
    { id: 'rain', name: 'Вечерний дождь', icon: '09', pos: [400, 14, -720], target: [290, 4, -500],
      text: 'Погода, мокрые PBR-материалы, ночное освещение и дождь из China_Preview.html применены к OSM-геометрии.', weather: 'rain', hour: 22.0 },
  ];
}

const VIEWS = makeViews();

let renderer, scene, camera, controls, composer, gtao, ssgi, sun, hemi, fill, sky, rainObj;
let sceneObj, grass, labels, hdrSupported = true;
let yaw = 0, pitch = 0, walkPos = new THREE.Vector3(centerOf('w4922662')[0], 1.75, centerOf('w4922662')[1]);
let savedCam = null, tween = null, selectionBox = null, nightLights = [];
const keys = new Set(), joy = { x: 0, y: 0, active: false };
let last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 0, statTimer = 0, tourTimer = 0, grassTimer = 0;
const isTouch = matchMedia('(pointer: coarse)').matches;
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
const waterPolys = DATA.areas.filter(a => a.kind === 'water');

async function init() {
  const params = new URLSearchParams(location.search);
  state.quality = params.get('quality') || (isTouch ? 'medium' : 'high');
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = false;
  hdrSupported = renderer.extensions.has('EXT_color_buffer_float');
  $('#app').appendChild(renderer.domElement);
  renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); showError('WebGL-контекст потерян. Перезагрузите страницу или выберите качество ниже.'); });

  scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0xb4bcbe, .00025);
  camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, .1, 6000);
  camera.position.set(...VIEWS[0].pos);
  controls = new OrbitControls(camera, renderer.domElement); controls.target.set(...VIEWS[0].target);
  controls.enableDamping = true; controls.dampingFactor = .07; controls.maxPolarAngle = Math.PI / 2 - .02;
  controls.minDistance = 1.5; controls.maxDistance = 3200;

  hemi = new THREE.HemisphereLight(0xbfc9cf, 0x5a5948, .9); scene.add(hemi);
  fill = new THREE.AmbientLight(0x8a939a, .22); scene.add(fill);
  sun = new THREE.DirectionalLight(0xffe6bd, 2.3); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -1100, right: 1100, top: 1100, bottom: -1100, near: 1, far: 3000 });
  sun.shadow.bias = -.0004; sun.shadow.normalBias = .06; scene.add(sun); scene.add(sun.target);

  sky = makeSky(scene); sky.frustumCulled = false;
  rainObj = makeRain(scene);
  sky.onBeforeRender = () => { sky.position.copy(camera.position); };
  await initSceneMaterials(scene);
  sceneObj = buildScene(scene, state);
  grass = makeOsmGrass(sceneObj.groups.green);
  labels = makeLabels($('#labels'), focusFeature);
  makeNightLights();

  const composerTarget = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: hdrSupported ? THREE.HalfFloatType : THREE.UnsignedByteType });
  composer = new EffectComposer(renderer, composerTarget); composer.addPass(new RenderPass(scene, camera));
  gtao = new GTAOPass(scene, camera, innerWidth, innerHeight); gtao.blendIntensity = .55;
  gtao.updateGtaoMaterial({ radius: 1.4, distanceExponent: 1, thickness: 1, scale: 1, samples: 8 });
  gtao.updatePdMaterial({ radius: 4, samples: 8, rings: 2 }); composer.addPass(gtao);
  ssgi = new SSGIEffect(camera, gtao, innerWidth, innerHeight);
  composer.addPass(ssgi.estimate); composer.addPass(ssgi.composite);
  composer.addPass(new OutputPass());
  // Reuse the exact verified linear-space AO composite from China_Preview.html.
  gtao.blendMaterial.dispose();
  gtao.blendMaterial = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, tScene: { value: null }, intensity: { value: .55 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `uniform sampler2D tDiffuse,tScene; uniform float intensity; varying vec2 vUv;
      void main(){ vec4 s=texture2D(tScene,vUv); float ao=clamp(texture2D(tDiffuse,vUv).r,0.,1.);
        gl_FragColor=vec4(s.rgb*mix(1.,ao,intensity),s.a); }`,
    blending: THREE.NoBlending, depthTest: false, depthWrite: false,
  });
  const hideForAO = new Set([sky, rainObj.rain, ...grass.chunks, ...sceneObj.signSystem.sprites]);
  const origOverride = gtao._overrideVisibility.bind(gtao);
  gtao._overrideVisibility = () => {
    origOverride();
    scene.traverse(o => {
      if (o.visible && (hideForAO.has(o) || o.isSprite || o.material?.alphaTest > 0)) {
        o.visible = false; gtao._visibilityCache.push(o);
      }
    });
  };

  buildUI(); applyQuality(state.quality); setWeather(state.weather); setHour(state.hour); resize(); setView(0, true);
  addEventListener('resize', resize);
  state.ready = true; $('#loading').classList.add('done'); setTimeout(() => $('#loading').remove(), 700);
  window.__CHINA3D_READY__ = true;
  window.__CHINA3D__ = {
    state, stats, U, errors, renderer, scene, camera, composer, gtao, ssgi, sky, rainObj,
    sceneObj, grass, labels, data: DATA, meta: META, views: VIEWS, layers: state.layers,
    nightLights, setView, setWeather, setHour, setQuality: applyQuality, setLayer: layerToggle,
    focusFeature, selectFeature, search, screenshot, render: renderFrame,
    lighting: updateLighting, info: () => renderer.info.render,
    counts: { ...S, pickMeshes: sceneObj.pickMeshes.length, labels: labels.count, signs: sceneObj.signSystem.sprites.length },
  };
  requestAnimationFrame(loop);
}

function makeNightLights() {
  const group = sceneObj.groups.details;
  const candidates = [];
  const nan = DATA.lines.find(l => l.featureId === 'w4922662' && l.partIndex === 0);
  if (nan && nan.points.length > 4) {
    const n = Math.min(6, nan.points.length - 1);
    for (let i = 1; i <= n; i++) candidates.push(nan.points[Math.floor(i * (nan.points.length - 1) / (n + 1))]);
  }
  for (const id of ['w25091600', 'w267371087', 'w425993664', 'r409777']) {
    const c = centerOf(id, CENTER); candidates.push([c[0], c[1]]);
  }
  const batch = new Batch(group);
  for (const [x, z] of candidates.slice(0, 10)) {
    batch.box(M.dark, x + 4.2, 1.4, z, .14, 2.8, .14);
    batch.box(M.dark, x + 4.2, 2.85, z, .75, .12, .12);
    batch.sphere(M.lamp, x + 4.9, 2.72, z, .28, .34, .28);
    const l = new THREE.PointLight(0xffc978, 0, 90, 2); l.position.set(x + 4.9, 2.72, z); group.add(l); nightLights.push(l);
  }
  batch.flush().forEach(m => {
    m.userData.ignorePick = true; m.userData.layer = 'details';
    m.castShadow = m.material !== M.lamp; m.receiveShadow = true;
  });
}

function resize() {
  if (!renderer) return;
  const q = state.quality, pr = Math.min(devicePixelRatio || 1, q === 'high' ? 1.5 : q === 'medium' ? 1 : .75);
  renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  composer.setPixelRatio(pr); composer.setSize(innerWidth, innerHeight);
  gtao.setSize(Math.floor(innerWidth * pr * .75), Math.floor(innerHeight * pr * .75));
  ssgi.setSize(Math.floor(innerWidth * pr), Math.floor(innerHeight * pr));
}

function applyQuality(q) {
  state.quality = q; $('#quality').value = q;
  const shadows = q !== 'low'; renderer.shadowMap.enabled = shadows; sun.castShadow = shadows;
  const ms = q === 'high' ? 2048 : 1024;
  if (sun.shadow.mapSize.x !== ms) { sun.shadow.mapSize.set(ms, ms); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
  gtao.enabled = q === 'high' && state.ao && hdrSupported && U.effects.value > .5;
  ssgi.setEnabled(gtao.enabled && state.gi);
  resize(); grass.update(camera, q, state.grass);
  $('#qualityNote').textContent = q === 'high' ? 'ПК: тени, GTAO + SSGI, полный LOD травы' : q === 'medium' ? 'Баланс: тени и умеренная трава' : 'Телефон / слабый ПК: без тяжёлых эффектов';
}

function setWeather(w) { state.weather = w; document.querySelectorAll('[data-weather]').forEach(b => b.classList.toggle('active', b.dataset.weather === w)); }
function setHour(h) {
  state.hour = h; $('#hour').value = h;
  $('#hourLabel').textContent = `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
}
function setView(i, instant = false) {
  state.view = i; const v = VIEWS[i];
  document.querySelectorAll('.view-btn').forEach((b, j) => b.classList.toggle('active', j === i));
  $('#viewText').textContent = v.text; $('#viewTitle').textContent = v.name;
  if (v.weather) setWeather(v.weather);
  if (v.hour) setHour(v.hour);
  if (state.mode === 'walk') setMode('orbit');
  if (instant) { camera.position.set(...v.pos); controls.target.set(...v.target); controls.update(); tween = null; }
  else tween = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: new THREE.Vector3(...v.pos), t1: new THREE.Vector3(...v.target) };
}
function setMode(m) {
  if (m === state.mode) return;
  if (m === 'walk') {
    savedCam = { p: camera.position.clone(), t: controls.target.clone() };
    controls.enabled = false; const c = centerOf('w4922662', CENTER); walkPos.set(c[0], 1.75, c[1]); yaw = 0; pitch = 0; state.mode = 'walk';
    $('#modeHint').textContent = 'WASD — ходьба · Shift — быстрее · тяните мышью — обзор';
  } else {
    state.mode = 'orbit'; controls.enabled = true;
    if (savedCam) { camera.position.copy(savedCam.p); controls.target.copy(savedCam.t); }
    $('#modeHint').textContent = 'ЛКМ — вращение · колесо — масштаб · ПКМ — сдвиг · клик — карточка OSM';
  }
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  $('#joy').classList.toggle('show', m === 'walk' && isTouch);
}

function regexEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function searchPattern(q) {
  const low = q.trim().toLowerCase();
  for (const [ru, pattern] of SEARCH_ALIASES) if (low.includes(ru)) return pattern;
  return regexEscape(q.trim()).replace(/\s+/g, '.+');
}
function featureScore(f) {
  let s = 0;
  if (f.id === 'w4922662' || f.id === 'w267371087' || f.id === 'w425993664') s += 130;
  if (f.layer === 'monuments' || f.tags.historic || f.tags.heritage) s += 90;
  if (f.tags.man_made === 'tower') s += 40;
  if (f.layer === 'roads' && f.name) s += 25;
  if (f.layer === 'water' && f.name) s += 20;
  if (f.name) s += 10;
  if (f.hasGeometry) s += 5;
  return s;
}
function search(q) {
  const term = q.trim();
  if (!term) return [];
  let re;
  try { re = new RegExp(searchPattern(term), 'i'); } catch { re = new RegExp(regexEscape(term), 'i'); }
  return DATA.features
    .filter(f => re.test(f.searchText || f.name || f.id))
    .sort((a, b) => featureScore(b) - featureScore(a) || (a.name || '').length - (b.name || '').length || a.id.localeCompare(b.id))
    .slice(0, 24);
}
function updateSearchResults() {
  const results = search($('#search').value);
  const box = $('#searchResults');
  box.innerHTML = '';
  if (!$('#search').value.trim()) { box.hidden = true; return; }
  box.hidden = false;
  if (!results.length) { box.innerHTML = '<div class="muted">В выгрузке OSM не найдено. Неотмеченные объекты не додумываются.</div>'; return; }
  for (const f of results) {
    const b = document.createElement('button');
    b.className = 'result';
    b.innerHTML = `<b>${escapeHtml(f.name || f.id)}</b><span>${escapeHtml(f.id)} · ${escapeHtml(f.layer)}${f.nameEn ? ' · ' + escapeHtml(f.nameEn) : ''}</span>`;
    b.onclick = () => focusFeature(f.id);
    box.appendChild(b);
  }
}

function selectedCaveat(f) {
  if (!f) return '';
  if (f.defaultHeight === true) return '<div class="warn">Высота не из OSM: использован класс building. Это визуальная оценка, не замер.</div>';
  if (f.tags && f.tags.highway) return '<div class="warn">Ширина highway в OSM отсутствует: полоса построена по классу дороги.</div>';
  if (f.tags && f.tags.barrier) return '<div class="warn">Показаны только заборы/ворота, внесённые в OSM. Неотмеченные ограждения не созданы.</div>';
  if (f.layer === 'monuments') return '<div class="warn">3D-объём — экструзия контура OSM, а не фотограмметрия или импорт модели.</div>';
  if (f.layer === 'water') return '<div class="warn">Плоский полигон OSM без батиметрии; отсутствующие member-way disclosed.</div>';
  if (!f.hasGeometry) return '<div class="warn">Геометрия вне буфера кадра или отсутствует в выгрузке; объект сохранён только для поиска.</div>';
  return '';
}
function renderInfo(f) {
  const box = $('#info');
  if (!f) { box.hidden = true; return; }
  box.hidden = false;
  const tags = Object.entries(f.tags || {}).slice(0, 16)
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('');
  const h = f.height != null ? `${f.height} м · ${escapeHtml(f.heightSource || 'источник не указан')}` : 'нет в выгрузке';
  box.innerHTML = `<h2>Объект OSM</h2><div class="info-title">${escapeHtml(f.name || f.id)}</div>
    <div class="muted">${escapeHtml(f.id)} · ${escapeHtml(f.kind)} · слой ${escapeHtml(f.layer)}</div>
    <dl>${tags || '<div><dt>tags</dt><dd>нет тегов</dd></div>'}</dl>
    <div class="info-row"><span>Высота</span><b>${h}</b></div>
    <div class="info-row"><span>Геометрия</span><b>${f.hasGeometry ? 'в буфере кадра' : 'вне кадра / неполная'}</b></div>
    <div class="info-row"><span>Источник</span><b>${escapeHtml(f.osmUrl)}</b></div>
    ${selectedCaveat(f)}
    <div class="attribution-mini">© OpenStreetMap contributors · ODbL 1.0</div>`;
}
function updateSelectionBox(f) {
  if (selectionBox) { scene.remove(selectionBox); selectionBox.geometry.dispose(); selectionBox.material.dispose(); selectionBox = null; }
  if (!f || !f.hasGeometry || !f.bbox) return;
  const bb = f.bbox, top = Math.max(4, (f.height || 6) + 3);
  const box = new THREE.Box3(new THREE.Vector3(bb[0], 0, bb[1]), new THREE.Vector3(bb[2], top, bb[3]));
  selectionBox = new THREE.Box3Helper(box, 0xffd88a);
  selectionBox.material.depthTest = false; selectionBox.material.transparent = true; selectionBox.material.opacity = .9;
  selectionBox.renderOrder = 10; selectionBox.userData.ignorePick = true;
  scene.add(selectionBox);
}
function selectFeature(id, fly = false) {
  const f = id ? featureById.get(id) : null;
  state.selectedId = f ? id : null;
  renderInfo(f); updateSelectionBox(f);
  if (f && fly) {
    if (state.mode === 'walk') setMode('orbit');
    if (state.layers[f.layer] === false) layerToggle(f.layer, true);
    const bb = bboxOf(id);
    const cx = clamp(f.center[0], CLIP[0] + 20, CLIP[2] - 20);
    const cz = clamp(f.center[1], CLIP[1] + 20, CLIP[3] - 20);
    const span = Math.max(bb[2] - bb[0], bb[3] - bb[1], 12);
    const dist = clamp(span * 1.35 + 48, 55, 430);
    const ty = Math.min(30, Math.max(3, ((f.height || 6) / 2) + 2));
    tween = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(),
      p1: new THREE.Vector3(cx + dist * .55, Math.max(28, dist * .48), cz + dist * .6),
      t1: new THREE.Vector3(cx, ty, cz) };
  }
  return f || null;
}
function focusFeature(id) { return selectFeature(id, true); }

function layerToggle(name, on) {
  state.layers[name] = !!on;
  setLayer(sceneObj, name, !!on);
  const cb = document.querySelector(`[data-layer="${name}"]`);
  if (cb) cb.checked = !!on;
  if (name === 'details') nightLights.forEach(l => l.visible = !!on);
}

function showDialog(dialog) {
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
}
function buildUI() {
  const nav = $('#views');
  VIEWS.forEach((v, i) => {
    const b = document.createElement('button'); b.className = 'view-btn' + (i === 0 ? ' active' : '');
    b.innerHTML = `<span>${v.icon}</span>${escapeHtml(v.name)}`;
    b.onclick = () => { state.tour = false; $('#tour').classList.remove('active'); setView(i); };
    nav.appendChild(b);
  });
  const layers = $('#layers');
  for (const [key, label] of LAYERS) {
    const id = 'layer-' + key;
    const lab = document.createElement('label'); lab.className = 'layer';
    lab.innerHTML = `<input type="checkbox" id="${id}" data-layer="${key}" checked><span>${escapeHtml(label)}</span>`;
    layers.appendChild(lab);
    $(`#${id}`).onchange = e => layerToggle(key, e.target.checked);
  }
  $('#dataNotes').innerHTML = META.caveats.slice(0, 3)
    .map(c => `<li>${escapeHtml(c.length > 190 ? c.slice(0, 187) + '…' : c)}</li>`).join('');
  $('#caveatList').innerHTML = META.caveats.map(c => `<li>${escapeHtml(c)}</li>`).join('');
  $('#provenance').innerHTML = `<b>${escapeHtml(META.source)}</b><br>
    ${escapeHtml(META.retrievedAt)} · bbox ${META.bboxWGS84.join(', ')} · ${nf.format(META.stats.rawElements)} elements<br>
    ${escapeHtml(META.license)} · ${escapeHtml(META.attribution)}<br>
    <span class="muted">${escapeHtml(META.sourceUrl)}</span>`;
  $('#externalSources').innerHTML = (META.externalSources || [])
    .map(s => `<div>[${s.id}] <a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a> · ${escapeHtml(s.url)}</div>`).join('')
    + '<div class="muted">Использовано только для одной отсутствующей в OSM высоты; все контуры и остальные атрибуты — OSM.</div>';
  $('#search').oninput = updateSearchResults;
  $('#allLabels').onchange = e => { state.showAllLabels = e.target.checked; };
  $('#effects').onchange = e => { U.effects.value = e.target.checked ? 1 : 0; applyQuality(state.quality); };
  $('#grass').onchange = e => { state.grass = e.target.checked; grass.update(camera, state.quality, state.grass); };
  $('#plants').onchange = e => { state.plants = e.target.checked; if (sceneObj.treeGroup) sceneObj.treeGroup.visible = state.plants; };
  $('#ao').onchange = e => { state.ao = e.target.checked; applyQuality(state.quality); };
  $('#gi').onchange = e => { state.gi = e.target.checked; applyQuality(state.quality); };
  $('#quality').onchange = e => applyQuality(e.target.value);
  $('#hour').oninput = e => setHour(+e.target.value);
  document.querySelectorAll('[data-weather]').forEach(b => b.onclick = () => setWeather(b.dataset.weather));
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $('#tour').onclick = () => { state.tour = !state.tour; $('#tour').classList.toggle('active', state.tour); tourTimer = 0; if (state.tour) setView((state.view + 1) % VIEWS.length); };
  $('#shot').onclick = screenshot;
  $('#settings').onclick = () => $('#controls').classList.toggle('open');
  $('#guideToggle').onclick = () => $('#guide').classList.toggle('open');
  for (const id of ['#creditsBtn', '#dataBtn', '#dataBtn2', '#dataBtn2b']) $(id).onclick = () => showDialog(id === '#creditsBtn' ? $('#credits') : $('#dataDialog'));
  $('#closeCredits').onclick = () => $('#credits').close();
  $('#closeData').onclick = () => $('#dataDialog').close();
  addEventListener('keydown', e => {
    if (e.code === 'Escape') { $('#credits').close(); $('#dataDialog').close(); $('#controls').classList.remove('open'); $('#guide').classList.remove('open'); }
    if (e.code === 'KeyH' && e.target.tagName !== 'INPUT') document.body.classList.toggle('clean');
    if (e.target.tagName !== 'INPUT') keys.add(e.code);
  });
  addEventListener('keyup', e => keys.delete(e.code));

  let drag = null, down = null;
  renderer.domElement.addEventListener('pointerdown', e => {
    down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };
    if (state.mode === 'walk' && e.pointerType !== 'touch') drag = { x: e.clientX, y: e.clientY };
    if (state.mode === 'walk' && e.pointerType === 'touch' && e.clientX > innerWidth * .4) drag = { x: e.clientX, y: e.clientY, touch: true };
  });
  addEventListener('pointermove', e => {
    if (!drag) return;
    yaw -= (e.clientX - drag.x) * .004; pitch = clamp(pitch - (e.clientY - drag.y) * .003, -1.2, 1.2);
    drag.x = e.clientX; drag.y = e.clientY;
  });
  addEventListener('pointerup', () => { drag = null; });
  renderer.domElement.addEventListener('pointerup', e => {
    const d = down; down = null;
    if (!d || d.button !== 0 || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 450) return;
    pickAt(e.clientX, e.clientY);
  });
  const joyEl = $('#joy'), knob = $('#joyKnob');
  joyEl.addEventListener('pointerdown', e => { joy.active = true; joyEl.setPointerCapture(e.pointerId); moveJoy(e); });
  joyEl.addEventListener('pointermove', e => { if (joy.active) moveJoy(e); });
  joyEl.addEventListener('pointerup', () => { joy.active = false; joy.x = joy.y = 0; knob.style.transform = 'translate(0,0)'; });
  function moveJoy(e) {
    const r = joyEl.getBoundingClientRect(), dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2;
    const l = Math.hypot(dx, dy), k = l > 36 ? 36 / l : 1;
    joy.x = dx * k / 36; joy.y = dy * k / 36; knob.style.transform = `translate(${dx * k}px,${dy * k}px)`;
  }
}

function pickAt(clientX, clientY) {
  pointer.x = clientX / innerWidth * 2 - 1; pointer.y = -(clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const meshes = sceneObj.pickMeshes.filter(m => m.visible && m.parent && m.parent.visible);
  const hits = raycaster.intersectObjects(meshes, false);
  for (const hit of hits) {
    const ranges = hit.object.userData.ranges || [];
    const r = ranges.find(q => hit.faceIndex >= q.start && hit.faceIndex < q.start + q.count);
    if (r) { selectFeature(r.featureId, false); return; }
  }
  selectFeature(null, false);
}

function screenshot() {
  renderFrame();
  const a = document.createElement('a'); a.download = `china-3d-osm-${VIEWS[state.view].id}.png`;
  a.href = renderer.domElement.toDataURL('image/png'); a.click();
  $('#toast').textContent = 'Скриншот сохранён · © OpenStreetMap contributors';
  $('#toast').classList.add('show'); setTimeout(() => $('#toast').classList.remove('show'), 1800);
}

function updateLighting(dt) {
  U.rain.value = lerp(U.rain.value, state.weather === 'rain' ? 1 : 0, Math.min(1, dt * 1.6));
  const a = (state.hour - 6) / 16 * Math.PI, sy = Math.sin(a);
  U.sunDir.value.set(Math.cos(a) * .65, Math.max(sy, -.2), .38).normalize();
  const day = clamp(sy * 2.2, 0, 1); U.night.value = 1 - clamp((sy + .05) * 3, 0, 1);
  sun.position.copy(U.sunDir.value).multiplyScalar(1200); sun.intensity = Math.max(sy, 0) * 2.85 * (1 - U.rain.value * .65);
  hemi.intensity = .42 + day * .88 * (1 - U.rain.value * .3); fill.intensity = .25 + U.night.value * .12;
  const fogDay = new THREE.Color().setRGB(.60, .65, .65), fogNight = new THREE.Color().setRGB(.055, .07, .09), fogRain = new THREE.Color().setRGB(.37, .41, .43);
  scene.fog.color.copy(fogDay).lerp(fogNight, U.night.value).lerp(fogRain, U.rain.value * .55);
  scene.fog.density = .00025 + U.rain.value * .00012 - U.night.value * .00003;
  renderer.toneMappingExposure = 1.18 + U.night.value * .15;
  updateSignLighting(scene, U.night.value);
  M.lamp.emissiveIntensity = .35 + U.night.value * 2.2;
  nightLights.forEach(l => l.intensity = U.night.value * 26 * (state.layers.details ? 1 : 0));
  rainObj.rain.visible = U.rain.value > .02 && U.effects.value > .5;
  rainObj.center.value.copy(camera.position);
}

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / ((b[1] - a[1]) || 1e-9) + a[0]) inside = !inside;
  }
  return inside;
}
function isWater(x, z) {
  return waterPolys.some(a => a.rings.some(r => pointInRing(x, z, r.outer) && !(r.holes || []).some(h => pointInRing(x, z, h))));
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
  const nx = clamp(walkPos.x + dx, CLIP[0] + 4, CLIP[2] - 4), nz = clamp(walkPos.z + dz, CLIP[1] + 4, CLIP[3] - 4);
  const blocked = (x, z) => colliders.some(c => x > c.x0 - .35 && x < c.x1 + .35 && z > c.z0 - .35 && z < c.z1 + .35) || isWater(x, z);
  if (!blocked(nx, walkPos.z)) walkPos.x = nx;
  if (!blocked(walkPos.x, nz)) walkPos.z = nz;
  walkPos.y = 1.75;
  camera.position.copy(walkPos); camera.rotation.set(pitch, yaw, 0, 'YXZ');
  U.player.value.copy(walkPos);
}

function renderFrame() {
  renderer.info.reset();
  if (gtao.enabled) gtao.blendMaterial.uniforms.tScene.value = composer.readBuffer.texture;
  composer.render();
}
function loop(now) {
  requestAnimationFrame(loop);
  const rawDt = (now - last) / 1000, dt = Math.min(rawDt, .05); last = now;
  if (state.freeze) return;
  if (!state.paused) U.time.value += dt;
  if (tween) {
    tween.t += dt / 1.35; const k = clamp(tween.t, 0, 1), e = k * k * (3 - 2 * k);
    camera.position.lerpVectors(tween.p0, tween.p1, e); controls.target.lerpVectors(tween.t0, tween.t1, e);
    if (k >= 1) tween = null;
  }
  if (state.mode === 'orbit') controls.update(); else updateWalk(dt);
  if (state.tour) { tourTimer += dt; if (tourTimer > 8) { tourTimer = 0; setView((state.view + 1) % VIEWS.length); } }
  updateLighting(dt);
  grassTimer += dt; if (grassTimer > .4) { grassTimer = 0; grass.update(camera, state.quality, state.grass); }
  labels.update(camera, state, state.selectedId);
  updateSignsVisibility(scene, camera, state.selectedId);
  renderFrame();
  fpsAcc += rawDt; fpsN++; statTimer += rawDt;
  if (statTimer > .5) {
    fps = Math.round(fpsN / Math.max(fpsAcc, .001)); fpsAcc = fpsN = statTimer = 0;
    const inf = renderer.info.render;
    $('#stats').textContent = `${fps} FPS · ${(inf.triangles / 1000).toFixed(0)}k треуг. · ${inf.calls} draw · OSM ${nf.format(S.features)} feature / ${nf.format(S.buildings)} зданий / ${nf.format(S.alleyWaysRendered)} хутунов / ${nf.format(S.barriersRendered)} barrier · трава ${nf.format(stats.grass || 0)} · окна ${nf.format(stats.windows || 0)}`;
    $('#renderBadge').textContent = `${state.quality.toUpperCase()} · WebGL2 · ${gtao.enabled ? (ssgi.enabled ? 'GTAO + SSGI' : 'GTAO') : 'без AO'} · ${state.weather === 'rain' ? 'дождь' : 'ясно'} · © OpenStreetMap contributors`;
  }
}

init().catch(e => { errors.push(String(e.stack || e)); showError(e.message); $('#loading').classList.add('done'); console.error(e); });
