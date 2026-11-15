import * as THREE from 'three';
import { bladeGeometry, grassMaterial } from '../../preview/src/shaders.js';
import { U, rand, rr, stats, pick } from '../../preview/src/state.js';
import { DATA } from './config.js';

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / ((b[1] - a[1]) || 1e-9) + a[0]) inside = !inside;
  }
  return inside;
}

function pointInArea(x, z, a) {
  return a.rings.some(r => pointInRing(x, z, r.outer) && !(r.holes || []).some(h => pointInRing(x, z, h)));
}

// Exact OSM green/pitch polygons receive volumetric grass blades from the
// China_Preview.html vegetation shader. The blades are a style layer, not OSM
// objects; no random grass is scattered over roads or building footprints.
export function makeOsmGrass(group) {
  const areas = DATA.areas.filter(a => a.kind === 'green' || a.kind === 'pitch');
  const geo = bladeGeometry(), mat = grassMaterial();
  mat.side = THREE.DoubleSide;
  const chunks = [];
  const tmp = new THREE.Object3D();
  const palette = [0xe7edcc, 0xdce6bb, 0xf1efd5, 0xcbdcae, 0xe9e6c6];
  const chunkSize = 180;
  const buckets = new Map();
  for (const a of areas) {
    const [x0, z0, x1, z1] = a.bbox;
    const w = x1 - x0, d = z1 - z0;
    const density = Math.min(420, Math.max(18, Math.round(w * d / 110)));
    let placed = 0, guard = 0;
    while (placed < density && guard++ < density * 14) {
      const x = x0 + rand() * w, z = z0 + rand() * d;
      if (!pointInArea(x, z, a)) continue;
      const key = `${Math.floor(x / chunkSize)}:${Math.floor(z / chunkSize)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push([x, z, rr(.7, 1.45)]);
      placed++;
    }
  }
  for (const [key, list] of buckets) {
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.name = 'osm-grass-' + key;
    list.forEach(([x, z, s], i) => {
      tmp.position.set(x, .045, z);
      tmp.rotation.set(0, rand() * Math.PI * 2, 0);
      tmp.scale.set(s, s, s);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
      mesh.setColorAt(i, new THREE.Color(pick(palette)));
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = false; mesh.receiveShadow = true;
    mesh.userData.max = list.length;
    const [ix, iz] = key.split(':').map(Number);
    mesh.userData.center = new THREE.Vector3((ix + .5) * chunkSize, 0, (iz + .5) * chunkSize);
    mesh.userData.ignorePick = true;
    group.add(mesh); chunks.push(mesh);
  }
  return {
    chunks,
    update(camera, quality, enabled) {
      const factor = quality === 'high' ? 1 : quality === 'medium' ? .55 : .25;
      const radius = quality === 'high' ? 145 : quality === 'medium' ? 95 : 55;
      U.grassRadius.value = radius;
      let count = 0;
      for (const m of chunks) {
        const d = Math.hypot(camera.position.x - m.userData.center.x, camera.position.z - m.userData.center.z);
        m.visible = enabled && d < radius + 45;
        m.count = m.visible ? Math.max(1, Math.floor(m.userData.max * factor)) : 0;
        count += m.count;
      }
      stats.grass = count;
      return count;
    },
  };
}
