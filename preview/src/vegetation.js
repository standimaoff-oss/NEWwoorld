import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { M } from './materials.js';
import { U, rand, rr, pick, stats, CANAL, bridgeAt } from './state.js';
import { bladeGeometry, grassMaterial, foliageMaterial } from './shaders.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
function cylGeo(a, b, r1, r2 = r1, seg = 7) {
  const d = b.clone().sub(a), len = d.length();
  const g = new THREE.CylinderGeometry(r2, r1, len, seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.clone().normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2); return g;
}
function leafTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
  x.clearRect(0, 0, 128, 128);
  for (let i = 0; i < 22; i++) {
    const px = rr(18, 110), py = rr(18, 110), a = rr(0, Math.PI * 2), l = rr(10, 22), w = rr(4, 8);
    x.save(); x.translate(px, py); x.rotate(a); x.fillStyle = pick(['#667b49', '#748851', '#5a7042', '#87945c', '#4f653d']);
    x.beginPath(); x.ellipse(0, 0, l, w, 0, 0, Math.PI * 2); x.fill(); x.strokeStyle = 'rgba(190,200,130,.35)'; x.lineWidth = .8; x.beginPath(); x.moveTo(-l, 0); x.lineTo(l, 0); x.stroke(); x.restore();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function cardGeo(w, h) { const g = new THREE.PlaneGeometry(w, h); return g; }
function merged(geos) {
  const list = geos.map(g => { const n = g.index ? g.toNonIndexed() : g; if (!n.attributes.uv) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2)); return n; });
  const out = mergeGeometries(list); if (!out) throw new Error('Vegetation geometry merge failed'); return out;
}
function instance(scene, geo, mat, transforms, colors = null) {
  const m = new THREE.InstancedMesh(geo, mat, transforms.length);
  transforms.forEach((t, i) => { m.setMatrixAt(i, t); if (colors) m.setColorAt(i, new THREE.Color(colors[i])); });
  if (colors) m.instanceColor.needsUpdate = true;
  m.castShadow = true; m.receiveShadow = true; m.computeBoundingSphere(); scene.add(m); return m;
}
function mat4(x, y, z, s = 1, ry = 0) { return new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), V(s, s, s)); }

export function isLawn(x, z) {
  if (z > 7 && z < 10.7 && Math.abs(x) < 112 && !bridgeAt(x)) return true;
  if (z < 57 || z > 112 || Math.abs(x) > 112) return false;
  if (Math.hypot(x + 40, z - 77) < 11) return false;
  if (Math.abs(x + 8) < 2.2) return false;
  const bx = 66 + Math.sin(z * .11) * 6; if (z > 58 && Math.abs(x - bx) < 2.4) return false;
  if (Math.abs(z - 92) < 1.8 && x > 30) return false;
  return true;
}

export function makeGrass(scene) {
  const geo = bladeGeometry(), mat = grassMaterial(), chunks = [];
  const size = 16;
  for (let cx = -112; cx < 112; cx += size) for (let cz = 0; cz < 112; cz += size) {
    const transforms = [], colors = [];
    for (let i = 0; i < 2200; i++) {
      const x = cx + rand() * size, z = cz + rand() * size;
      if (!isLawn(x, z)) continue;
      const s = rr(.65, 1.35); transforms.push(mat4(x, .02, z, s, rr(0, 6.28)));
      colors.push(pick([0xf2f5e6, 0xe4eccf, 0xf7f7e8, 0xd8e4c0, 0xfffff0]));
    }
    if (!transforms.length) continue;
    const m = instance(scene, geo, mat, transforms, colors); m.castShadow = false; m.userData.max = transforms.length; m.userData.center = V(cx + 8, 0, cz + 8); chunks.push(m);
  }
  return {
    chunks,
    update(camera, quality, enabled) {
      const factor = quality === 'high' ? 1 : quality === 'medium' ? .55 : .25;
      const radius = quality === 'high' ? 95 : quality === 'medium' ? 70 : 48; U.grassRadius.value = radius;
      let count = 0;
      for (const m of chunks) {
        const d = Math.hypot(camera.position.x - m.userData.center.x, camera.position.z - m.userData.center.z);
        m.visible = enabled && d < radius + 12; m.count = m.visible ? Math.floor(m.userData.max * factor) : 0; count += m.count;
      }
      stats.grass = count;
    },
  };
}

export function makeTrees(scene, positions) {
  const leafTex = leafTexture();
  const leafMat = foliageMaterial(0xffffff); leafMat.map = leafTex; leafMat.alphaTest = .42; leafMat.alphaToCoverage = true;
  const trunkGeos = [], leafGeos = [], coreGeos = [];
  trunkGeos.push(cylGeo(V(0, 0, 0), V(.2, 5.2, 0), .28, .12, 9));
  for (let i = 0; i < 9; i++) {
    const a = i * 2.399, r = rr(1.2, 2.5), y = rr(4.2, 6.6);
    const end = V(Math.cos(a) * r, y, Math.sin(a) * r);
    trunkGeos.push(cylGeo(V(.1, 3.2 + i * .15, 0), end, .09, .035));
    for (let j = 0; j < 22; j++) {
      const g = cardGeo(rr(1.1, 1.8), rr(1.0, 1.6));
      g.rotateX(rr(-1.2, 1.2)); g.rotateY(rr(0, 6.28)); g.rotateZ(rr(0, 6.28));
      g.translate(end.x + rr(-1.1, 1.1), end.y + rr(-.7, .9), end.z + rr(-1.1, 1.1)); leafGeos.push(g);
    }
    const core = new THREE.IcosahedronGeometry(rr(.7, 1.1), 1); core.translate(end.x, end.y, end.z); coreGeos.push(core);
  }
  const tr = merged(trunkGeos), lv = merged(leafGeos), core = merged(coreGeos);
  const ts = [], cs = [], colors = [];
  positions.forEach(p => { ts.push(mat4(p[0], 0, p[1], p[2] || rr(.85, 1.25), rr(0, 6.28))); colors.push(pick([0xb7c39a, 0xa8b88e, 0xc2c6a0, 0x9fb18a])); });
  const group = new THREE.Group(); scene.add(group);
  const a = instance(group, tr, M.bark, ts), b = instance(group, lv, leafMat, ts, colors), c = instance(group, core, foliageMaterial(0x4e633c), ts, colors);
  stats.trees = positions.length; return group;
}

export function makePalms(scene, positions) {
  const trunkGeos = [], frondGeos = [];
  const top = V(.55, 8.2, .2); let prev = V(0, 0, 0);
  for (let i = 1; i <= 16; i++) {
    const t = i / 16, p = V(t * t * .55, t * 8.2, t * t * .2);
    trunkGeos.push(cylGeo(prev, p, .24 - t * .08, .24 - t * .085, 9));
    const ring = new THREE.CylinderGeometry(.255 - t * .08, .255 - t * .08, .055, 9); ring.translate(p.x, p.y, p.z); trunkGeos.push(ring); prev = p;
  }
  for (let f = 0; f < 12; f++) {
    const a = f / 12 * Math.PI * 2 + rr(-.1, .1), len = rr(3.2, 4.4), dir = V(Math.cos(a), 0, Math.sin(a)), side = V(-Math.sin(a), 0, Math.cos(a));
    const point = t => top.clone().add(dir.clone().multiplyScalar(t * len)).add(V(0, Math.sin(t * Math.PI) * 1.15 - t * t * 1.7, 0));
    let pp = point(0);
    for (let s = 1; s <= 14; s++) {
      const t = s / 14, p = point(t); frondGeos.push(cylGeo(pp, p, .025 * (1 - t) + .006, .02 * (1 - t) + .005, 4)); pp = p;
      if (s > 1) {
        const ll = .85 * Math.sin(t * Math.PI) + .12;
        for (const sd of [-1, 1]) {
          const base = p.clone(), tip = p.clone().add(side.clone().multiplyScalar(ll * sd)).add(dir.clone().multiplyScalar(.32)).add(V(0, -.22 - t * .2, 0));
          const mid = base.clone().lerp(tip, .45).add(V(0, .04, 0)), w = .065;
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute([...base.toArray(), ...mid.clone().add(dir.clone().multiplyScalar(w)).toArray(), ...tip.toArray(), ...base.toArray(), ...tip.toArray(), ...mid.clone().sub(dir.clone().multiplyScalar(w)).toArray()], 3));
          g.computeVertexNormals(); frondGeos.push(g);
        }
      }
    }
  }
  const tg = merged(trunkGeos), fg = merged(frondGeos), ts = [], cs = [];
  positions.forEach(p => { ts.push(mat4(p[0], 0, p[1], p[2] || rr(.85, 1.15), rr(0, 6.28))); cs.push(pick([0x899b62, 0x7b9158, 0x96a46c])); });
  const group = new THREE.Group(); scene.add(group);
  instance(group, tg, M.bark, ts); instance(group, fg, foliageMaterial(0xffffff), ts, cs);
  stats.palms = positions.length; return group;
}

export function makeBamboo(scene) {
  const stalks = [], nodes = [], leaves = [];
  const leafMat = foliageMaterial(0x87995c);
  for (let s = 0; s < 4; s++) {
    const ox = rr(-.55, .55), oz = rr(-.55, .55), h = rr(5.5, 8.5), lean = rr(-.06, .06), segs = 9;
    for (let i = 0; i < segs; i++) {
      const y0 = h * i / segs, y1 = h * (i + 1) / segs, r = .065 * (1 - i / segs * .35);
      stalks.push(cylGeo(V(ox + y0 * lean, y0, oz), V(ox + y1 * lean, y1, oz), r, r * .94, 7));
      const node = new THREE.CylinderGeometry(r * 1.22, r * 1.22, .045, 7); node.translate(ox + y1 * lean, y1, oz); nodes.push(node);
      if (i > 2) for (let b = 0; b < 3; b++) {
        const a = rr(0, 6.28), len = rr(.5, 1.1), base = V(ox + y1 * lean, y1, oz), tip = base.clone().add(V(Math.cos(a) * len, .25, Math.sin(a) * len));
        stalks.push(cylGeo(base, tip, .012, .005, 4));
        for (let l = 0; l < 5; l++) {
          const p = base.clone().lerp(tip, .3 + l * .16), g = new THREE.BufferGeometry();
          const d = V(Math.cos(a + (l % 2 ? .7 : -.7)), -.15, Math.sin(a + (l % 2 ? .7 : -.7))).multiplyScalar(rr(.3, .55));
          const side = V(-d.z, 0, d.x).normalize().multiplyScalar(.045);
          g.setAttribute('position', new THREE.Float32BufferAttribute([...p.toArray(), ...p.clone().add(d.clone().multiplyScalar(.45)).add(side).toArray(), ...p.clone().add(d).toArray(), ...p.toArray(), ...p.clone().add(d).toArray(), ...p.clone().add(d.clone().multiplyScalar(.45)).sub(side).toArray()], 3));
          g.computeVertexNormals(); leaves.push(g);
        }
      }
    }
  }
  const sg = merged(stalks), ng = merged(nodes), lg = merged(leaves), ts = [], cs = [];
  for (let i = 0; i < 210; i++) {
    const x = rr(36, 106), z = rr(59, 109), path = 66 + Math.sin(z * .11) * 6;
    if (Math.abs(x - path) < 3.2 || Math.abs(z - 92) < 2.5) continue;
    ts.push(mat4(x, 0, z, rr(.75, 1.2), rr(0, 6.28))); cs.push(pick([0xa8b878, 0x94aa6c, 0xb7bf86, 0x839b61]));
  }
  const group = new THREE.Group(); scene.add(group);
  instance(group, sg, M.bamboo, ts, cs); instance(group, ng, M.bambooNode, ts, cs); instance(group, lg, leafMat, ts, cs);
  stats.bamboo = ts.length * 4; return group;
}

export function makeShrubs(scene, positions) {
  const tex = leafTexture(), mat = foliageMaterial(0xffffff); mat.map = tex; mat.alphaTest = .4;
  const geos = [];
  for (let i = 0; i < 28; i++) { const g = cardGeo(rr(.6, 1.1), rr(.5, .9)); g.rotateY(rr(0, 6.28)); g.rotateX(rr(-.6, .6)); g.translate(rr(-.5, .5), rr(.25, .8), rr(-.5, .5)); geos.push(g); }
  const geo = merged(geos), ts = [], cs = [];
  positions.forEach(p => { ts.push(mat4(p[0], p[2] || 0, p[1], p[3] || rr(.7, 1.2), rr(0, 6.28))); cs.push(pick([0x9aaa76, 0x879b68, 0xb1b582])); });
  const group = new THREE.Group(); scene.add(group); instance(group, geo, mat, ts, cs); return group;
}

export function makeChristmasTree(scene, batch, x, z) {
  const group = new THREE.Group(); group.position.set(x, 0, z); scene.add(group);
  const needleMat = foliageMaterial(0x33513b);
  for (let i = 0; i < 9; i++) {
    const r = 3.1 * (1 - i / 10), y = 1 + i * .72;
    const g = new THREE.ConeGeometry(r, 1.65, 18, 3); const m = new THREE.Mesh(g, needleMat); m.position.y = y; m.castShadow = true; m.receiveShadow = true; group.add(m);
    for (let j = 0; j < 12; j++) {
      const a = j / 12 * 6.28 + i * .4, rr2 = r * .82;
      batch.sphere(i % 3 === 0 ? M.red : M.roofGold, x + Math.cos(a) * rr2, y - .35, z + Math.sin(a) * rr2, .11);
      batch.sphere(M.lamp, x + Math.cos(a + .2) * rr2, y - .2, z + Math.sin(a + .2) * rr2, .045);
    }
  }
  batch.cyl(M.wood, V(x, 0, z), V(x, 1.2, z), .22);
  const star = new THREE.Shape(); for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, r = i % 2 ? .22 : .55; i ? star.lineTo(Math.cos(a) * r, Math.sin(a) * r) : star.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
  const sm = new THREE.Mesh(new THREE.ExtrudeGeometry(star, { depth: .12, bevelEnabled: false }), M.lamp); sm.position.set(x, 7.7, z); group.add(sm); sm.position.set(0, 7.7, 0);
  for (let i = 0; i < 7; i++) { const a = i * .9; batch.box(i % 2 ? M.red : M.roofGold, x + Math.cos(a) * 2.2, .25, z + Math.sin(a) * 2.2, .6, .5, .5, a); batch.box(M.white, x + Math.cos(a) * 2.2, .51, z + Math.sin(a) * 2.2, .62, .03, .12, a); }
  return group;
}
