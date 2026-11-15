import * as THREE from 'three';
import { M, Batch } from './materials.js';
import { U, rand, rr, stats, colliders } from '../../preview/src/state.js';
import { makeTrees } from '../../preview/src/vegetation.js';
import { CLIP, CENTER, SPAN } from './config.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function hashId(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function edgeAngle(ux, uz) {
  // Batch.box local X follows the edge, local Z follows the outward normal.
  return Math.atan2(-uz, ux);
}

function normalizedRings(rings) {
  return rings.map(r => {
    const contour = (r.outer || []).map(p => new THREE.Vector2(p[0], p[1]));
    if (!THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
    const holes = (r.holes || []).map(h => {
      const a = h.map(p => new THREE.Vector2(p[0], p[1]));
      if (THREE.ShapeUtils.isClockWise(a)) a.reverse();
      return a;
    });
    return { contour, holes };
  });
}

// One merged, non-indexed mesh per material. faceIndex ranges keep every OSM
// feature selectable even after batching hundreds of footprints together.
export class MeshBuilder {
  constructor(layer) {
    this.layer = layer;
    this.byMat = new Map();
  }
  _buf(mat) {
    if (!this.byMat.has(mat)) this.byMat.set(mat, { positions: [], normals: [], uvs: [], ranges: [] });
    return this.byMat.get(mat);
  }
  addTriangles(mat, tris, featureId) {
    if (!tris.length) return;
    const b = this._buf(mat);
    const start = b.positions.length / 9;
    for (const tri of tris) {
      for (const v of tri) {
        b.positions.push(v.p[0], v.p[1], v.p[2]);
        b.normals.push(v.n[0], v.n[1], v.n[2]);
        b.uvs.push(v.uv[0], v.uv[1]);
      }
    }
    b.ranges.push({ start, count: tris.length, featureId });
  }
  addQuad(mat, corners, normal, uvs, featureId) {
    const v = i => ({ p: corners[i], n: normal, uv: uvs[i] });
    this.addTriangles(mat, [
      [v(0), v(1), v(2)],
      [v(0), v(2), v(3)],
    ], featureId);
  }
  addBox(mat, cx, cy, cz, w, h, d, featureId, ry = 0) {
    const c = Math.cos(ry), s = Math.sin(ry);
    const ex = [c, 0, -s], ez = [s, 0, c];
    const map = (lx, ly, lz) => [
      cx + ex[0] * lx + ez[0] * lz,
      cy + ly,
      cz + ex[2] * lx + ez[2] * lz,
    ];
    const nmap = (nx, ny, nz) => [ex[0] * nx + ez[0] * nz, ny, ex[2] * nx + ez[2] * nz];
    const x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2, z0 = -d / 2, z1 = d / 2;
    const uv = (a, b, c2, d2) => [[a, b], [c2, b], [c2, d2], [a, d2]];
    // top +Y
    this.addQuad(mat, [map(x0, y1, z0), map(x0, y1, z1), map(x1, y1, z1), map(x1, y1, z0)], nmap(0, 1, 0), uv(x0, z0, x1, z1), featureId);
    // bottom -Y
    this.addQuad(mat, [map(x0, y0, z0), map(x1, y0, z0), map(x1, y0, z1), map(x0, y0, z1)], nmap(0, -1, 0), uv(x0, z0, x1, z1), featureId);
    // front +Z (local)
    this.addQuad(mat, [map(x0, y0, z1), map(x1, y0, z1), map(x1, y1, z1), map(x0, y1, z1)], nmap(0, 0, 1), uv(x0, y0, x1, y1), featureId);
    // back -Z
    this.addQuad(mat, [map(x1, y0, z0), map(x0, y0, z0), map(x0, y1, z0), map(x1, y1, z0)], nmap(0, 0, -1), uv(x0, y0, x1, y1), featureId);
    // right +X
    this.addQuad(mat, [map(x1, y0, z1), map(x1, y0, z0), map(x1, y1, z0), map(x1, y1, z1)], nmap(1, 0, 0), uv(z0, y0, z1, y1), featureId);
    // left -X
    this.addQuad(mat, [map(x0, y0, z0), map(x0, y0, z1), map(x0, y1, z1), map(x0, y1, z0)], nmap(-1, 0, 0), uv(z0, y0, z1, y1), featureId);
  }
  build(group, pickMeshes) {
    for (const [mat, b] of this.byMat) {
      if (!b.positions.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.normals, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uvs, 2));
      g.computeBoundingBox(); g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = this.layer !== 'water';
      mesh.receiveShadow = true;
      mesh.userData.ranges = b.ranges;
      mesh.userData.layer = this.layer;
      group.add(mesh);
      pickMeshes.push(mesh);
    }
    this.byMat.clear();
  }
}

export function addPolygonTop(builder, mat, rings, y, featureId) {
  const tris = [];
  for (const nr of normalizedRings(rings)) {
    const contour = nr.contour.map(p => p.clone());
    const holes = nr.holes.map(h => h.map(p => p.clone()));
    const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
    const verts = contour.concat(...holes);
    for (const f of faces) {
      const a = verts[f[0]], b = verts[f[1]], c = verts[f[2]];
      // XY-plane CCW maps to -Y in XZ; reverse to face the sky.
      tris.push([
        { p: [a.x, y, a.y], n: [0, 1, 0], uv: [a.x, a.y] },
        { p: [c.x, y, c.y], n: [0, 1, 0], uv: [c.x, c.y] },
        { p: [b.x, y, b.y], n: [0, 1, 0], uv: [b.x, b.y] },
      ]);
    }
  }
  builder.addTriangles(mat, tris, featureId);
}

function wallMaterial(tags, id) {
  const h = hashId(id);
  if (tags.man_made === 'tower' || tags.amenity === 'place_of_worship' || tags.historic) return M.brickRed;
  if (tags.building === 'commercial' || tags.building === 'retail') return M.brickRed;
  if (tags.building === 'residential') return M.concrete;
  return [M.brick, M.concrete, M.brickRed, M.stone, M.concreteDark][h % 5];
}

export function addBuilding(builder, b) {
  const h = Math.max(1.5, b.height);
  const wm = wallMaterial(b.tags, b.featureId);
  const roofMat = b.monument || b.tags.man_made === 'tower'
    ? M.roofTile
    : [M.roof, M.roofCool, M.roofWarm, M.roof][hashId(b.featureId) % 4];
  addPolygonTop(builder, roofMat, b.rings, h, b.featureId);
  const wallTris = [];
  for (const nr of normalizedRings(b.rings)) {
    for (const ring of [nr.contour, ...nr.holes]) {
      let u0 = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        const dx = c.x - a.x, dz = c.y - a.y;
        const len = Math.hypot(dx, dz);
        if (len < 1e-3) continue;
        const nx = -dz / len, nz = dx / len;
        const n = [nx, 0, nz];
        const p0 = [a.x, 0, a.y], p1 = [c.x, 0, c.y], p2 = [c.x, h, c.y], p3 = [a.x, h, a.y];
        const uv = [[u0, 0], [u0 + len, 0], [u0 + len, h], [u0, h]];
        const v = k => ({ p: [p0, p1, p2, p3][k], n, uv: uv[k] });
        wallTris.push([v(0), v(1), v(2)], [v(0), v(2), v(3)]);
        u0 += len;
      }
    }
  }
  builder.addTriangles(wm, wallTris, b.featureId);
}

function segmentList(points, closed) {
  const segs = [];
  for (let i = 0; i < points.length - 1; i++) segs.push([points[i], points[i + 1]]);
  if (closed && points.length > 2) segs.push([points[points.length - 1], points[0]]);
  return segs.filter(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-3);
}

export function addRibbon(builder, mat, points, width, y, featureId, closed = false) {
  const tris = [];
  const half = width / 2;
  for (const [a, b] of segmentList(points, closed)) {
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len, nx = -uz, nz = ux;
    const over = Math.min(half, len * .45);
    const ax = a[0] - ux * over, az = a[1] - uz * over;
    const bx = b[0] + ux * over, bz = b[1] + uz * over;
    const p0 = [ax + nx * half, y, az + nz * half];
    const p1 = [bx + nx * half, y, bz + nz * half];
    const p2 = [bx - nx * half, y, bz - nz * half];
    const p3 = [ax - nx * half, y, az - nz * half];
    const u1 = len + over * 2;
    const uv = [[0, width], [u1, width], [u1, 0], [0, 0]];
    const n = [0, 1, 0];
    const v = k => ({ p: [p0, p1, p2, p3][k], n, uv: uv[k] });
    tris.push([v(0), v(1), v(2)], [v(0), v(2), v(3)]);
  }
  builder.addTriangles(mat, tris, featureId);
}

export function addWall(builder, mat, points, width, height, featureId, closed = false) {
  const tris = [];
  const half = width / 2, h = Math.max(.6, height);
  for (const [a, b] of segmentList(points, closed)) {
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len, nx = -uz, nz = ux;
    const af = [a[0] + nx * half, a[1] + nz * half];
    const bf = [b[0] + nx * half, b[1] + nz * half];
    const ab = [a[0] - nx * half, a[1] - nz * half];
    const bb = [b[0] - nx * half, b[1] - nz * half];
    const uv = [[0, 0], [len, 0], [len, h], [0, h]];
    // front, normal +n
    {
      const corners = [[af[0], 0, af[1]], [bf[0], 0, bf[1]], [bf[0], h, bf[1]], [af[0], h, af[1]]];
      const n = [nx, 0, nz];
      const v = k => ({ p: corners[k], n, uv: uv[k] });
      tris.push([v(0), v(1), v(2)], [v(0), v(2), v(3)]);
    }
    // back, normal -n (reverse winding)
    {
      const corners = [[bb[0], 0, bb[1]], [ab[0], 0, ab[1]], [ab[0], h, ab[1]], [bb[0], h, bb[1]]];
      const n = [-nx, 0, -nz];
      const v = k => ({ p: corners[k], n, uv: uv[k] });
      tris.push([v(0), v(1), v(2)], [v(0), v(2), v(3)]);
    }
    // top cap +Y
    {
      const corners = [[af[0], h, af[1]], [bf[0], h, bf[1]], [bb[0], h, bb[1]], [ab[0], h, ab[1]]];
      const n = [0, 1, 0];
      const uvTop = [[0, width], [len, width], [len, 0], [0, 0]];
      const v = k => ({ p: corners[k], n, uv: uvTop[k] });
      tris.push([v(0), v(1), v(2)], [v(0), v(2), v(3)]);
    }
  }
  builder.addTriangles(mat, tris, featureId);
}

export function addGate(builder, mat, points, height, featureId) {
  const a = points[0], b = points[points.length - 1];
  const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
  if (len < .1) return;
  const h = Math.max(1.5, height);
  builder.addBox(mat, a[0], h / 2, a[1], .5, h, .5, featureId);
  builder.addBox(mat, b[0], h / 2, b[1], .5, h, .5, featureId);
  builder.addBox(mat, (a[0] + b[0]) / 2, h - .18, (a[1] + b[1]) / 2, len, .36, .55, featureId, edgeAngle(dx / len, dz / len));
}

export function addGround(scene) {
  const w = SPAN[0] + 360, d = SPAN[1] + 360;
  const g = new THREE.PlaneGeometry(w, d, 1, 1);
  g.rotateX(-Math.PI / 2);
  g.translate(CENTER[0], -.065, CENTER[1]);
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i), pos.getZ(i));
  const mesh = new THREE.Mesh(g, M.ground);
  mesh.receiveShadow = true;
  mesh.userData.ignorePick = true;
  scene.add(mesh);
  return mesh;
}

export function addMarkers(groups, pickMeshes, markers) {
  const byLayer = new Map();
  for (const m of markers) {
    if (!byLayer.has(m.layer)) byLayer.set(m.layer, []);
    byLayer.get(m.layer).push(m);
  }
  for (const [layer, list] of byLayer) {
    const builder = new MeshBuilder(layer);
    const mat = layer === 'monuments' ? M.monument : layer === 'barriers' ? M.dark : M.marker;
    for (const m of list) {
      const w = layer === 'monuments' ? 1.3 : layer === 'barriers' ? .8 : .55;
      const h = layer === 'monuments' ? 4.2 : layer === 'barriers' ? 2.2 : 1.5;
      builder.addBox(mat, m.x, h / 2, m.z, w, h, w, m.featureId);
      builder.addBox(layer === 'monuments' ? M.gold : mat, m.x, h + .22, m.z, w * 1.35, .4, w * 1.35, m.featureId);
    }
    builder.build(groups[layer] || groups.pois, pickMeshes);
  }
}

export function addTrees(groups, trees) {
  if (!trees.length) return null;
  const positions = trees.map(t => [t.x, t.z, rr(.85, 1.2)]);
  const group = makeTrees(groups.green, positions);
  group.traverse(o => { if (o.isMesh) o.userData.ignorePick = true; });
  return group;
}

export function addDecorations(group, buildings) {
  const batch = new Batch(group);
  const cone = new THREE.ConeGeometry(1, 1, 4, 1); cone.rotateY(Math.PI / 4);
  stats.windows = 0; stats.lanterns = 0; stats.roofCaps = 0;
  for (const b of buildings) {
    const h = Math.max(1.5, b.height);
    const id = b.featureId;
    const hh = hashId(id);
    for (const r of b.rings) {
      for (const ring of [r.outer, ...r.holes]) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], c = ring[(i + 1) % ring.length];
          const dx = c[0] - a[0], dz = c[1] - a[1], len = Math.hypot(dx, dz);
          if (len < 1.2) continue;
          const ux = dx / len, uz = dz / len, nx = -uz, nz = ux;
          const ry = edgeAngle(ux, uz);
          const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
          // Low roof parapet along the exact OSM footprint.
          batch.box(M.roof, mx + nx * .04, h + .08, mz + nz * .04, len, .16, .32, ry);
          stats.roofCaps++;
          if (h > 2.6 && len > 3.2 && hh % 5 !== 0) {
            const cols = Math.min(6, Math.floor(len / 3.0));
            const rows = Math.min(4, Math.floor((h - .8) / 2.9));
            for (let k = 1; k < cols; k++) {
              const t = k / cols;
              const x = a[0] + dx * t + nx * .055;
              const z = a[1] + dz * t + nz * .055;
              for (let row = 0; row < rows; row++) {
                const y = 1.35 + row * 2.9;
                if (y + 1.2 > h - .25) continue;
                batch.box(M.glass, x, y, z, 1.25, 1.35, .055, ry);
                batch.box(M.frame, x, y - .72, z, 1.42, .1, .12, ry);
                batch.box(M.frame, x, y + .72, z, 1.42, .08, .1, ry);
                stats.windows++;
              }
            }
          }
          if (len > 4 && hh % 3 === 0) {
            const t = .5;
            const x = a[0] + dx * t + nx * .075;
            const z = a[1] + dz * t + nz * .075;
            batch.box(M.darkWood, x, 1.15, z, 1.25, 2.3, .1, ry);
            if (hh % 6 === 0) {
              const lx = x + nx * .45, lz = z + nz * .45;
              batch.cyl(M.roofGold, V(lx, 2.35, lz), V(lx, 2.85, lz), .035);
              batch.sphere(M.red, lx, 2.15, lz, .26, .34, .26);
              batch.cyl(M.gold, V(lx, 1.82, lz), V(lx, 1.68, lz), .045);
              stats.lanterns++;
            }
          }
        }
      }
    }
    if (b.monument || b.tags.man_made === 'tower' || b.roofShape === 'gabled') {
      const [x0, z0, x1, z1] = b.bbox;
      const w = Math.max(4, x1 - x0), d = Math.max(4, z1 - z0);
      const cx = b.center[0], cz = b.center[1];
      for (let level = 0; level < 2; level++) {
        const scale = 1 - level * .17;
        const y = h + 1.05 + level * 1.9;
        batch.add(cone, M.roofTile, cx, y, cz, w * .78 * scale, 2.1, d * .78 * scale);
        batch.box(M.roofGold, cx, y - 1.02, cz, w * .86 * scale, .18, d * .86 * scale);
      }
      batch.sphere(M.gold, cx, h + 4.15, cz, .26, .32, .26);
      batch.box(M.red, cx, h + .15, cz, w * .55, .45, d * .55);
    }
  }
  const meshes = batch.flush();
  meshes.forEach(m => {
    m.userData.ignorePick = true;
    m.userData.layer = 'details';
    m.castShadow = m.material !== M.glass && m.material !== M.lamp;
    m.receiveShadow = true;
  });
  return meshes;
}

export function fillColliders(buildings, lines) {
  colliders.length = 0;
  for (const b of buildings) {
    const [x0, z0, x1, z1] = b.bbox;
    if (x1 - x0 < .4 || z1 - z0 < .4) continue;
    colliders.push({ x0: x0 + .15, x1: x1 - .15, z0: z0 + .15, z1: z1 - .15 });
  }
  for (const l of lines) {
    if (l.kind !== 'barrier') continue;
    const [x0, z0, x1, z1] = l.bbox;
    colliders.push({ x0: x0 - .25, x1: x1 + .25, z0: z0 - .25, z1: z1 + .25 });
  }
}
