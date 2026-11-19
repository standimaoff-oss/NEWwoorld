/* Склейка геометрий и мелкие помощники — свой аналог BufferGeometryUtils. */
import * as THREE from 'three';

const ATTRS = ['position', 'normal', 'uv', 'color'];

/** Склеивает массив BufferGeometry (с индексами или без) в одну. Сохраняет position/normal/uv/color. */
export function mergeGeometries(geos, useGroups = false) {
  const list = geos.filter((g) => g && g.attributes.position);
  if (!list.length) return new THREE.BufferGeometry();
  const has = {};
  for (const a of ATTRS) has[a] = list.every((g) => !!g.attributes[a]);
  const out = new THREE.BufferGeometry();
  const totals = {};
  let vTotal = 0, iTotal = 0;
  for (const g of list) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
  }
  const arrays = {};
  for (const a of ATTRS) {
    if (!has[a]) continue;
    const size = list[0].attributes[a].itemSize;
    arrays[a] = { arr: new Float32Array(vTotal * size), size, off: 0 };
    if (a === 'color' && list[0].attributes[a].normalized) { /* нормализованный цвет не встречается */ }
  }
  const idx = new Uint32Array(iTotal);
  let vOff = 0, iOff = 0;
  for (const g of list) {
    const count = g.attributes.position.count;
    for (const a of ATTRS) {
      if (!arrays[a]) continue;
      const src = g.attributes[a].array;
      arrays[a].arr.set(src, vOff * arrays[a].size);
    }
    if (g.index) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[iOff + i] = gi[i] + vOff;
      iOff += gi.length;
    } else {
      for (let i = 0; i < count; i++) idx[iOff + i] = vOff + i;
      iOff += count;
    }
    vOff += count;
  }
  for (const a of ATTRS) {
    if (arrays[a]) out.setAttribute(a, new THREE.BufferAttribute(arrays[a].arr, arrays[a].size));
  }
  if (iTotal) out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** Готовит геометрию: применяет матрицу и переводит uv в «метры» (для текстур фасадов). */
export function xform(geo, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], uvScale = null } = {}) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
  m.compose(new THREE.Vector3(pos[0], pos[1], pos[2]), q, new THREE.Vector3(scale[0], scale[1], scale[2]));
  geo.applyMatrix4(m);
  if (uvScale && geo.attributes.uv) {
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uvScale[0], uv.getY(i) * uvScale[1]);
    uv.needsUpdate = true;
  }
  return geo;
}

/** Простая merge-сборка: добавляйте куски, получите один меш. */
export class MeshBuilder {
  constructor() { this.list = []; }
  add(geo, transform) { this.list.push(xform(geo, transform)); return this; }
  box(w, h, d, pos, rot = [0, 0, 0], uvScale = null) {
    return this.add(new THREE.BoxGeometry(w, h, d), { pos, rot, uvScale });
  }
  cyl(r1, r2, h, seg, pos, rot = [0, 0, 0]) {
    return this.add(new THREE.CylinderGeometry(r1, r2, h, seg), { pos, rot });
  }
  plane(w, h, pos, rot = [0, 0, 0]) {
    return this.add(new THREE.PlaneGeometry(w, h), { pos, rot });
  }
  build(material, { shadows = true, receive = false } = {}) {
    if (!this.list.length) return null;
    const geo = mergeGeometries(this.list);
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = shadows; mesh.receiveShadow = receive;
    this.list.forEach((g) => g.dispose && g.dispose());
    this.list.length = 0;
    return mesh;
  }
}

/** Геометрия для InstancedMesh из произвольного набора кусков. */
export function instanced(geoList, material, matrices, chunkSize = 0, colors = null) {
  // chunkSize > 0 — режем инстансы по сетке мира, чтобы работало отсечение по камере
  if (chunkSize > 0 && matrices.length > 48) {
    const buckets = new Map();
    for (const m of matrices) {
      const k = Math.floor(m.x / chunkSize) + ',' + Math.floor(m.z / chunkSize);
      let arr = buckets.get(k); if (!arr) { arr = []; buckets.set(k, arr); }
      arr.push(m);
    }
    const g = new THREE.Group();
    if (colors) {
      // цвета едут вместе со своими матрицами. indexOf на каждом инстансе —
      // это O(n²) на сборке мира: держим карту «запись → индекс» один раз.
      const pos = new Map();
      matrices.forEach((m, i) => pos.set(m, i));
      for (const [, arr] of buckets) {
        g.add(instanced(geoList, material, arr, 0, arr.map((m) => colors[pos.get(m)])));
      }
    } else {
      for (const [, arr] of buckets) g.add(instanced(geoList, material, arr, 0));
    }
    return g;
  }
  const geo = mergeGeometries(geoList);
  const im = new THREE.InstancedMesh(geo, material, matrices.length);
  const d = new THREE.Object3D();
  matrices.forEach((m, i) => {
    d.position.set(m.x, m.y, m.z);
    d.rotation.set(m.rx || 0, m.ry || 0, m.rz || 0);
    const s = m.s === undefined ? 1 : m.s;
    d.scale.set(m.sx !== undefined ? m.sx : s, m.sy !== undefined ? m.sy : s, m.sz !== undefined ? m.sz : s);
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
  });
  im.instanceMatrix.needsUpdate = true;
  if (colors) {
    const col = new THREE.Color();
    matrices.forEach((m, i) => { const c = colors[i]; if (c) im.setColorAt(i, col.setRGB(c[0], c[1], c[2])); });
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }
  im.castShadow = false;   // теневой проход дорогой: включаем точечно
  im.receiveShadow = false;
  // отсечение по одной геометрии сломало бы инстансы — считаем общую сферу
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  for (const m of matrices) {
    const r = Math.max(m.sx || m.s || 1, m.sy || m.s || 1, m.sz || m.s || 1);
    box.expandByPoint(p.set(m.x - r, m.y - r, m.z - r));
    box.expandByPoint(p.set(m.x + r, m.y + r, m.z + r));
  }
  geo.computeBoundingSphere();
  const bs = geo.boundingSphere;
  const c = box.getCenter(new THREE.Vector3());
  geo.boundingSphere = new THREE.Sphere(c, Math.max(1, box.getSize(new THREE.Vector3()).length() / 2 + (bs ? bs.radius : 0)));
  return im;
}
