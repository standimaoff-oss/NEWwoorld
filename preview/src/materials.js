import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { U, rand, rr, stats } from './state.js';

export const M = {};
export const textures = {};
const loader = new THREE.TextureLoader();
export async function loadAssets() {
  const data = window.__CHINA_ASSETS__;
  const font = new FontFace('NotoPreview', `url(data:font/woff2;base64,${data.font})`, { weight: '100 900' });
  await font.load(); document.fonts.add(font);
  await Promise.all(Object.entries(data.textures).map(async ([key, uri]) => {
    const t = await loader.loadAsync(uri);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = key.endsWith('_Color') ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4; textures[key] = t;
  }));
}

// Photographic PBR maps (ambientCG CC0), with world-scale UVs on instanced boxes.
export function pbr(name, color = 0xffffff, tile = 3, roughness = .9, metalness = 0) {
  const m = new THREE.MeshStandardMaterial({
    color, map: textures[name + '_Color'], normalMap: textures[name + '_NormalGL'],
    roughnessMap: textures[name + '_Roughness'], roughness, metalness,
    normalScale: new THREE.Vector2(.35, .35),
  });
  m.userData.tile = tile; m.userData.baseRough = roughness;
  m.onBeforeCompile = sh => {
    sh.uniforms.uTile = { value: tile }; sh.uniforms.uRain = U.rain; sh.uniforms.uEffects = U.effects;
    sh.vertexShader = sh.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
      #ifdef USE_INSTANCING
        vec3 isc = vec3(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz),length(instanceMatrix[2].xyz));
        vec3 an = abs(normal);
        vec2 idim = an.x > .5 ? isc.zy : (an.y > .5 ? isc.xz : isc.xy);
        #ifdef USE_MAP
          vMapUv *= idim / uTile;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv *= idim / uTile;
        #endif
        #ifdef USE_ROUGHNESSMAP
          vRoughnessMapUv *= idim / uTile;
        #endif
      #else
        #ifdef USE_MAP
          vMapUv /= uTile;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv /= uTile;
        #endif
        #ifdef USE_ROUGHNESSMAP
          vRoughnessMapUv /= uTile;
        #endif
      #endif
    `).replace('void main() {', 'uniform float uTile;\nvoid main() {');
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', 'uniform float uRain;\nuniform float uEffects;\nvoid main() {')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor * (1.0 - uRain * uEffects * 0.62), 0.16, 1.0);
        diffuseColor.rgb *= 1.0 - uRain * uEffects * 0.16;
      `);
  };
  m.customProgramCacheKey = () => 'pbr-world-' + tile;
  return m;
}
export function plain(color, roughness = .85, metalness = 0, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}

// Static geometry is batched by material into instanced draws.
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 10);
const unitSphere = new THREE.IcosahedronGeometry(1, 1);
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
export class Batch {
  constructor(scene) { this.scene = scene; this.groups = new Map(); this.meshes = []; }
  add(geo, mat, x, y, z, sx = 1, sy = 1, sz = 1, ry = 0, color = null, rx = 0, rz = 0) {
    const key = geo.uuid + '|' + mat.uuid;
    if (!this.groups.has(key)) this.groups.set(key, { geo, mat, items: [] });
    tmpQ.setFromEuler(new THREE.Euler(rx, ry, rz));
    tmpM.compose(tmpP.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz));
    this.groups.get(key).items.push({ m: tmpM.clone(), color });
  }
  box(mat, x, y, z, w, h, d, ry = 0, color = null) { this.add(unitBox, mat, x, y, z, w, h, d, ry, color); }
  sphere(mat, x, y, z, sx, sy = sx, sz = sx, color = null) { this.add(unitSphere, mat, x, y, z, sx, sy, sz, 0, color); }
  cyl(mat, a, b, r, color = null) {
    const d = new THREE.Vector3().subVectors(b, a), len = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(up, d.normalize());
    const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(.5), q, new THREE.Vector3(r, len, r));
    const key = unitCyl.uuid + '|' + mat.uuid;
    if (!this.groups.has(key)) this.groups.set(key, { geo: unitCyl, mat, items: [] });
    this.groups.get(key).items.push({ m, color });
  }
  flush() {
    for (const { geo, mat, items } of this.groups.values()) {
      const mesh = new THREE.InstancedMesh(geo, mat, items.length);
      let hasColor = false;
      items.forEach((it, i) => { mesh.setMatrixAt(i, it.m); if (it.color) { mesh.setColorAt(i, new THREE.Color(it.color)); hasColor = true; } });
      if (hasColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.computeBoundingSphere();
      this.scene.add(mesh); this.meshes.push(mesh);
    }
    this.groups.clear(); return this.meshes;
  }
}

export const H_SIGNS = [
  ['老北京茶馆', 'СТАРАЯ ЧАЙНАЯ · PEKING TEA', '#643b32', '#e8d6ae'],
  ['和平便利店', 'МИР · ПРОДУКТЫ 24/7', '#315b51', '#eee4c9'],
  ['北京面馆', 'ЛАПША И ПЕЛЬМЕНИ', '#873f32', '#f0dfbb'],
  ['新华书店', 'КНИГИ · КАНЦТОВАРЫ', '#385047', '#e9dfc5'],
  ['街角咖啡', 'КОФЕ И ВЫПЕЧКА', '#4d5145', '#e6d9bd'],
  ['水果蔬菜', 'ФРУКТЫ · ОВОЩИ', '#5d6b3d', '#f0e6c8'],
  ['五金杂货', 'ХОЗТОВАРЫ · РЕМОНТ', '#465967', '#e5e2ce'],
  ['修理手机', 'ТЕЛЕФОНЫ · АКСЕССУАРЫ', '#385d69', '#e4e8db'],
  ['京味小吃', 'УЛИЧНАЯ КУХНЯ', '#7a4434', '#efdfb9'],
  ['日用百货', 'ТОВАРЫ ДЛЯ ДОМА', '#5a5144', '#ece1c7'],
  ['竹林公园', 'БАМБУКОВЫЙ ПАРК', '#3c5945', '#e6dfc1'],
  ['新年快乐', 'С НОВЫМ ГОДОМ', '#8b3b31', '#efd7a0'],
  ['胡同人家', 'ЖИЗНЬ В ХУТУНАХ', '#5b493d', '#e9dbc0'],
  ['便民超市', 'ВАШ БУДУЩИЙ МАГАЗИН', '#355e58', '#eee5c9'],
  ['豆浆油条', 'СОЕВОЕ МОЛОКО · ЗАВТРАК', '#7b6240', '#f0e4c5'],
  ['理发店', 'ПАРИКМАХЕРСКАЯ', '#4c5364', '#e7e1d0'],
  ['北京药房', 'АПТЕКА', '#3f6654', '#e5ecd9'],
  ['花鸟市场', 'ЦВЕТЫ И РАСТЕНИЯ', '#5e6744', '#eee4c7'],
  ['地铁', 'МЕТРО · ЛИНИЯ 1', '#3d5366', '#e7e5d8'],
  ['京华里', 'ПЕКИН · ТВОРЧЕСКИЙ КВАРТАЛ', '#713b30', '#ead6a8'],
  ['自行车修理', 'ВЕЛОСИПЕДЫ', '#4a5b55', '#e6dfc8'],
  ['兰州拉面', 'ЛАПША РУЧНОЙ ТЯНКИ', '#3e6250', '#eee2bd'],
  ['旧书回收', 'БУКИНИСТ', '#665341', '#e9ddc4'],
  ['冷饮批发', 'НАПИТКИ · МОРОЖЕНОЕ', '#496575', '#e8e7d5'],
];
export const V_SIGNS = [['茶', '葉', '馆'], ['便', '利', '店'], ['面', '馆'], ['书', '店'], ['咖', '啡'], ['水', '果'], ['五', '金'], ['手', '机'], ['小', '吃'], ['药', '房'], ['超', '市'], ['理', '发']];
export let signMat, vSignMat;
const signGeos = [], vSignGeos = [];
function noiseCanvas(ctx, w, h, amount = 1800) {
  for (let i = 0; i < amount; i++) {
    const a = rr(.015, .09); ctx.fillStyle = rand() > .5 ? `rgba(235,225,200,${a})` : `rgba(25,24,20,${a})`;
    ctx.fillRect(rr(0, w), rr(0, h), rr(1, 9), rr(1, 3));
  }
  for (let i = 0; i < 18; i++) { ctx.fillStyle = 'rgba(28,27,22,.035)'; ctx.fillRect(rr(0, w), 0, rr(2, 10), h); }
}
export function buildSigns(scene) {
  const c = document.createElement('canvas'); c.width = 2048; c.height = 768; const x = c.getContext('2d');
  H_SIGNS.forEach((s, i) => {
    const ox = (i % 4) * 512, oy = Math.floor(i / 4) * 128;
    x.fillStyle = s[2]; x.fillRect(ox, oy, 512, 128);
    x.strokeStyle = s[3]; x.lineWidth = 3; x.strokeRect(ox + 9, oy + 9, 494, 110);
    x.textAlign = 'center'; x.fillStyle = s[3]; x.font = '600 58px NotoPreview, sans-serif'; x.fillText(s[0], ox + 256, oy + 70);
    x.font = '500 17px NotoPreview, sans-serif'; x.fillText(s[1], ox + 256, oy + 103);
    x.save(); x.beginPath(); x.rect(ox, oy, 512, 128); x.clip(); x.translate(ox, oy); noiseCanvas(x, 512, 128, 500); x.restore();
  });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  signMat = new THREE.MeshStandardMaterial({ map: t, roughness: .78, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: .08 });
  const vc = document.createElement('canvas'); vc.width = 1024; vc.height = 2048; const vx = vc.getContext('2d');
  for (let i = 0; i < 32; i++) {
    const s = V_SIGNS[i % V_SIGNS.length], ox = (i % 8) * 128, oy = Math.floor(i / 8) * 512;
    vx.fillStyle = i % 3 === 0 ? '#7c3d32' : i % 3 === 1 ? '#3e5b52' : '#665a3e'; vx.fillRect(ox, oy, 128, 512);
    vx.strokeStyle = '#d9c9a2'; vx.lineWidth = 3; vx.strokeRect(ox + 7, oy + 7, 114, 498);
    vx.fillStyle = '#eadbb7'; vx.textAlign = 'center'; vx.font = '600 76px NotoPreview, sans-serif';
    s.forEach((ch, j) => vx.fillText(ch, ox + 64, oy + 110 + j * 140));
    vx.save(); vx.beginPath(); vx.rect(ox, oy, 128, 512); vx.clip(); vx.translate(ox, oy); noiseCanvas(vx, 128, 512, 250); vx.restore();
  }
  const vt = new THREE.CanvasTexture(vc); vt.colorSpace = THREE.SRGBColorSpace; vt.anisotropy = 4;
  vSignMat = new THREE.MeshStandardMaterial({ map: vt, roughness: .8, emissive: 0xffffff, emissiveMap: vt, emissiveIntensity: .08 });
  scene.userData.signMats = [signMat, vSignMat];
}
function atlasPlane(w, h, idx, cols, rows, x, y, z, ry) {
  const g = new THREE.PlaneGeometry(w, h), uv = g.attributes.uv;
  const col = idx % cols, row = Math.floor(idx / cols);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (col + uv.getX(i)) / cols, 1 - (row + 1 - uv.getY(i)) / rows);
  g.rotateY(ry); g.translate(x, y, z); return g;
}
export function sign(x, y, z, w, h, ry, idx, vertical = false) {
  (vertical ? vSignGeos : signGeos).push(atlasPlane(w, h, idx, vertical ? 8 : 4, vertical ? 4 : 6, x, y, z, ry)); stats.signs++;
}
export function flushSigns(scene) {
  for (const [geos, mat] of [[signGeos, signMat], [vSignGeos, vSignMat]]) {
    if (!geos.length) continue;
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat); mesh.castShadow = false; mesh.receiveShadow = true; scene.add(mesh);
  }
}

// Rain on shop windows: procedural droplets with moving heads and trails.
export function makeGlass() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: U.time, uRain: U.rain, uNight: U.night, uEffects: U.effects },
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv=uv; mat4 mm=modelMatrix;
        #ifdef USE_INSTANCING
          mm=mm*instanceMatrix;
        #endif
        vec4 wp=mm*vec4(position,1.); vN=normalize(mat3(mm)*normal); vV=cameraPosition-wp.xyz; gl_Position=projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: `uniform float uTime,uRain,uNight,uEffects; varying vec2 vUv; varying vec3 vN,vV;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      void main(){
        float fres=pow(1.-abs(dot(normalize(vN),normalize(vV))),3.);
        vec3 col=mix(vec3(.025,.035,.04),vec3(.16,.20,.22),fres*.6+vUv.y*.05);
        float warm=step(.62,hash(floor(vUv*2.)+3.)); col=mix(col,vec3(.58,.43,.24),uNight*warm*.65);
        vec2 g=vUv*vec2(5.,3.); vec2 id=floor(g); float r=hash(id);
        vec2 f=fract(g); float yy=fract(f.y+uTime*(.10+r*.12)+r);
        float xx=.5+.16*sin(yy*13.+r*20.); float head=length((vec2(f.x,yy)-vec2(xx,.5))*vec2(1.,1.7));
        float drop=smoothstep(.12,.025,head); float trail=smoothstep(.045,.0,abs(f.x-xx))*smoothstep(.5,.15,yy)*step(.5,yy);
        float wet=uRain*uEffects; col+=wet*(drop*.34+trail*.10); col=mix(col,col*.82,wet*.35);
        gl_FragColor=vec4(col,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

export function initMaterials() {
  M.grass = pbr('Grass004', 0x8a956e, 3.5, .96);
  M.concrete = pbr('Concrete012', 0xb8b5aa, 3.2, .92);
  M.concreteDark = pbr('Concrete012', 0x8e918b, 2.6, .94);
  M.brick = pbr('Bricks066', 0x9b8b7d, 2.4, .93);
  M.brickRed = pbr('Bricks066', 0x9a6f5d, 2.2, .92);
  M.asphalt = pbr('Asphalt021', 0x9a9c99, 4, .94);
  M.road = pbr('Road001', 0xa5a49d, 5, .93);
  M.paving = pbr('Concrete012', 0xa8a69b, 1.6, .9);
  M.metal = pbr('Metal063', 0x6f7672, 1.5, .72, .55);
  M.red = pbr('Concrete012', 0x8d4437, 2.5, .88);
  M.wood = pbr('Metal063', 0x7a6247, 2, .86);
  M.roof = pbr('Bricks066', 0x66645c, 1.2, .88);
  M.roofGold = pbr('Bricks066', 0x9b814a, 1.1, .76);
  M.white = plain(0xc9c7bc, .88); M.dark = plain(0x343a38, .8);
  M.frame = plain(0x5b625e, .7, .25); M.glass = makeGlass();
  M.lamp = plain(0xffe2ae, .4, 0, { emissive: 0xffc978, emissiveIntensity: .5 });
  M.leaf = plain(0x5d7147, .92, 0, { side: THREE.DoubleSide });
  M.bark = pbr('Metal063', 0x6d6250, 1.4, .95);
  M.bamboo = plain(0x6f8150, .82); M.bambooNode = plain(0x8b9265, .86);
  M.stone = pbr('Concrete012', 0x9c9e94, 1.8, .92);
  M.shelf = plain(0x77806f, .82, .15);
  M.goods = [plain(0xb9533f, .7), plain(0xd0a24a, .7), plain(0x6f9457, .75), plain(0xd9d4c4, .8), plain(0x5b88a0, .7)];
}
