import * as THREE from 'three';
import { M, Batch, sign, flushSigns, buildSigns } from './materials.js';
import { U, rand, rr, pick, stats, colliders, CANAL, bridgeAt } from './state.js';
import { makeTrees, makePalms, makeBamboo, makeShrubs, makeChristmasTree } from './vegetation.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
function roof(batch, x, y, z, w, d, h, mat) {
  const g = new THREE.ConeGeometry(1, 1, 4, 1); g.rotateY(Math.PI / 4);
  batch.add(g, mat, x, y + h / 2, z, w * .72, h, d * .72);
  batch.box(mat, x, y, z, w + .7, .16, d + .7);
  batch.box(M.wood, x, y + h + .05, z, w * .45, .14, .18);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    batch.cyl(mat, V(x + sx * w * .48, y, z + sz * d * .48), V(x + sx * w * .55, y + .35, z + sz * d * .55), .07);
  }
}
function lantern(batch, x, y, z) {
  batch.cyl(M.dark, V(x, y + .45, z), V(x, y + .8, z), .018);
  batch.sphere(M.red, x, y, z, .28, .36, .28);
  batch.cyl(M.roofGold, V(x, y - .36, z), V(x, y - .58, z), .025);
  batch.cyl(M.roofGold, V(x, y + .28, z), V(x, y + .38, z), .12);
}
function windowUnit(batch, x, y, z, w, h, ry = 0, ac = false, balcony = false) {
  const nx = Math.sin(ry), nz = Math.cos(ry);
  batch.box(M.glass, x, y, z, w, h, .06, ry); stats.windows++;
  batch.box(M.frame, x, y - h / 2, z + nz * .04, w + .16, .1, .18, ry);
  batch.box(M.frame, x, y + h / 2, z - nz * .01, w + .12, .08, .1, ry);
  batch.box(M.frame, x - Math.cos(ry) * w / 2, y, z + nx * w / 2, .07, h, .09, ry);
  batch.box(M.frame, x + Math.cos(ry) * w / 2, y, z - nx * w / 2, .07, h, .09, ry);
  if (ac) {
    batch.box(M.white, x + w * .3, y - h / 2 - .35, z + nz * .28, .7, .45, .35, ry);
    batch.box(M.frame, x + w * .3, y - h / 2 - .35, z + nz * .47, .55, .3, .02, ry);
  }
  if (balcony) {
    batch.box(M.concreteDark, x, y - h / 2 - .05, z + nz * .5, w + .5, .12, 1, ry);
    batch.box(M.metal, x, y - h / 2 + .45, z + nz * .95, w + .5, .05, .05, ry);
    for (let i = -2; i <= 2; i++) batch.box(M.metal, x + Math.cos(ry) * i * w / 4, y - h / 2 + .22, z + nz * .95 - nx * i * w / 4, .035, .45, .035, ry);
  }
}
function shop(batch, x, w, idx, open = false) {
  const z = -7.9;
  if (!open) batch.box(M.dark, x, 1.7, z + .05, w - .6, 3.3, .2);
  const panels = 4;
  for (let i = 0; i < panels; i++) {
    const px = x - w / 2 + 1.2 + i * (w - 2.4) / (panels - 1);
    if (open && (i === 1 || i === 2)) continue;
    batch.box(M.glass, px, 1.65, z + .18, 2.1, 2.7, .05); stats.windows++;
    batch.box(M.frame, px, .22, z + .22, 2.2, .12, .12);
    batch.box(M.frame, px - 1.08, 1.65, z + .22, .09, 2.8, .12);
  }
  batch.box(M.metal, x, 3.45, z + .2, w - .4, .35, .3);
  sign(x, 4.25, z + .28, w - 1, 1.35, 0, idx % 24);
  batch.box(M.dark, x, 4.25, z + .12, w - .8, 1.5, .18);
  const awnMat = idx % 2 ? M.red : M.leaf;
  batch.box(awnMat, x, 3.35, z + .95, w - .8, .08, 1.6, 0, null);
  for (let i = 0; i < 8; i++) batch.box(M.white, x - w / 2 + 1 + i * (w - 2) / 7, 3.36, z + .95, .22, .09, 1.6);
  batch.box(M.dark, x + w / 2 - .4, 5.6, z + 1.1, .12, 3.2, .8);
  sign(x + w / 2 - .4, 5.6, z + 1.53, .75, 3, 0, idx % 32, true);
  sign(x + w / 2 + .03, 5.6, z + 1.1, .75, 3, Math.PI / 2, idx % 32, true);
  lantern(batch, x - w / 2 + .7, 3.1, z + .8); lantern(batch, x + w / 2 - .7, 3.1, z + .8);
  if (open) {
    batch.box(M.paving, x, .06, -14, w - 1, .12, 12);
    batch.box(M.lamp, x, 3.2, -13, 4, .06, .3);
    for (let r = 0; r < 3; r++) {
      const sz = -11 - r * 2.6;
      batch.box(M.shelf, x - 3, .9, sz, 4, 1.8, .6);
      for (let s = 0; s < 3; s++) for (let g = 0; g < 7; g++) batch.box(pick(M.goods), x - 4.6 + g * .52, .35 + s * .55, sz + .32, .3, .35, .25);
    }
    batch.box(M.wood, x + 3.2, .6, -10.5, 2.6, 1.2, 1);
    batch.box(M.dark, x + 3.2, 1.35, -10.5, .5, .35, .4);
    sign(x, 2.6, -19.8, 5, 1, 0, 13);
  }
}
function lowBlock(batch, x, idx) {
  const w = 14, d = 14, h = rr(9, 15), z = -15;
  const mat = idx % 3 === 0 ? M.brickRed : idx % 3 === 1 ? M.concreteDark : M.brick;
  if (idx === 7) {
    // Hollow ground-floor shell so the open shop actually has a visible interior.
    batch.box(mat, x - w / 2 + .15, h / 2, z, .3, h, d);
    batch.box(mat, x + w / 2 - .15, h / 2, z, .3, h, d);
    batch.box(mat, x, h / 2, z - d / 2 + .15, w, h, .3);
    batch.box(mat, x, (h + 5) / 2, z + d / 2 - .15, w, h - 5, .3);
    batch.box(M.concreteDark, x, 3.65, z, w, .25, d);
    batch.box(M.paving, x, .04, z, w - .4, .08, d - .4);
  } else batch.box(mat, x, h / 2, z, w, h, d);
  colliders.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: -8, skip: idx === 7 });
  batch.box(M.concrete, x, h + .15, z, w + .4, .3, d + .4);
  batch.box(M.concreteDark, x, .3, z, w + .3, .6, d + .3);
  shop(batch, x, w, idx, idx === 7);
  for (let y = 6; y < h - 1; y += 3) for (let wx = -4.8; wx <= 4.8; wx += 3.2) {
    windowUnit(batch, x + wx, y, -7.94, 1.5, 1.8, 0, rand() > .5, rand() > .65);
  }
  for (let y = 6; y < h - 1; y += 3) for (let wz = -11; wz >= -20; wz -= 3.4) {
    windowUnit(batch, x + w / 2 + .04, y, wz, 1.4, 1.8, Math.PI / 2, rand() > .6);
  }
  if (idx % 4 === 1) roof(batch, x, h + .3, z, w + 1, d + 1, 2.2, M.roof);
  else { batch.box(M.metal, x + 3, h + .9, z - 2, 2, 1.5, 2); batch.cyl(M.metal, V(x - 4, h, z + 3), V(x - 4, h + 3, z + 3), .04); }
  batch.box(M.concreteDark, x - w / 2 + .15, h / 2, -7.8, .3, h, .35);
  batch.box(M.concreteDark, x + w / 2 - .15, h / 2, -7.8, .3, h, .35);
}
function tower(batch, x, z, w, d, h, style) {
  const mat = style % 3 === 0 ? M.concrete : style % 3 === 1 ? M.concreteDark : M.brick;
  batch.box(mat, x, h / 2, z, w, h, d, 0, pick([0xe8e2d2, 0xd6d0c0, 0xc8c0ae, 0xded6c2, 0xc4beb0]));
  batch.box(M.concreteDark, x, 1.5, z, w + 1.2, 3, d + 1.2);
  batch.box(M.concrete, x, h + .2, z, w + .5, .4, d + .5);
  colliders.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 });
  for (let y = 5; y < h - 1.5; y += 3.1) {
    for (let wx = -w / 2 + 1.6; wx < w / 2 - 1; wx += 2.7) windowUnit(batch, x + wx, y, z + d / 2 + .04, 1.5, 1.9, 0, rand() > .45, rand() > .55);
    for (let wz = z - d / 2 + 1.6; wz < z + d / 2 - 1; wz += 2.9) windowUnit(batch, x + w / 2 + .04, y, wz, 1.5, 1.9, Math.PI / 2, rand() > .6, rand() > .7);
    batch.box(M.concreteDark, x, y + 1.35, z + d / 2 + .08, w, .14, .2);
  }
  for (let i = 0; i < 3; i++) { batch.box(M.metal, x - w / 3 + i * w / 3, h + 1, z - 1, 2, 1.8, 2); }
  batch.cyl(M.metal, V(x, h, z), V(x, h + 5, z), .06);
  if (style % 2 === 0) { batch.box(M.dark, x, h * .62, z + d / 2 + .3, w * .7, 2.2, .25); sign(x, h * .62, z + d / 2 + .45, w * .65, 1.9, 0, (style + 18) % 24); }
}
function bench(batch, x, z, ry = 0) {
  for (let i = 0; i < 4; i++) batch.box(M.wood, x + Math.sin(ry) * i * .14, .48, z + Math.cos(ry) * i * .14, 2, .07, .12, ry);
  batch.box(M.wood, x + Math.sin(ry) * .55, .85, z + Math.cos(ry) * .55, 2, .45, .07, ry);
  for (const s of [-1, 1]) batch.box(M.metal, x + Math.cos(ry) * s * .8, .24, z - Math.sin(ry) * s * .8, .08, .48, .5, ry);
}
function lamp(batch, x, z, h = 5) {
  batch.cyl(M.metal, V(x, 0, z), V(x, h, z), .07);
  batch.cyl(M.metal, V(x, h, z), V(x + 1, h + .3, z), .055);
  batch.box(M.dark, x + 1.1, h + .25, z, .7, .15, .35);
  batch.box(M.lamp, x + 1.1, h + .16, z, .55, .04, .25);
}
function railing(batch, z) {
  for (let x = -112; x <= 112; x += 3.5) {
    if (bridgeAt(x)) continue;
    batch.box(M.stone, x, .65, z, .22, 1.3, .22);
    if (!bridgeAt(x + 3.5)) { batch.box(M.stone, x + 1.75, 1.15, z, 3.5, .14, .16); batch.box(M.stone, x + 1.75, .55, z, 3.5, .1, .12); }
  }
}
function bridge(batch, x) {
  batch.box(M.stone, x, .18, CANAL.z, 8, .55, CANAL.width + 3);
  batch.box(M.paving, x, .49, CANAL.z, 7.6, .08, CANAL.width + 2);
  for (const s of [-1, 1]) {
    const rx = x + s * 3.8;
    for (let z = 10; z <= 48; z += 2.4) batch.box(M.stone, rx, 1.05, z, .2, 1.2, .2);
    batch.box(M.stone, rx, 1.55, CANAL.z, .18, .16, CANAL.width + 2);
    batch.box(M.stone, rx, .95, CANAL.z, .12, .1, CANAL.width + 2);
  }
  for (const z of [17, 29, 41]) batch.box(M.concreteDark, x, -.6, z, 6, 1.4, 1.4);
}
function paifang(batch, x, z) {
  for (const s of [-1, 1]) { batch.box(M.red, x + s * 4, 3, z, .65, 6, .65); batch.box(M.stone, x + s * 4, .3, z, 1.1, .6, 1.1); }
  batch.box(M.red, x, 5.4, z, 9.5, .7, .7); batch.box(M.red, x, 4.2, z, 8.5, .45, .55);
  roof(batch, x, 5.8, z, 10, 2.6, 1.5, M.roofGold);
  batch.box(M.dark, x, 4.8, z + .4, 4.6, 1.1, .15); sign(x, 4.8, z + .5, 4.4, 1, 0, 10);
  lantern(batch, x - 3, 3.8, z + .4); lantern(batch, x + 3, 3.8, z + .4);
}
function foodCart(batch, x, z) {
  batch.box(M.metal, x, .8, z, 2.4, 1.2, 1.2); batch.box(M.wood, x, 1.45, z, 2.6, .12, 1.4);
  for (const s of [-1, 1]) { batch.cyl(M.dark, V(x + s * .9, .1, z - .5), V(x + s * .9, .6, z - .5), .28); batch.cyl(M.metal, V(x + s * 1.1, 1.5, z), V(x + s * 1.1, 2.7, z), .035); }
  batch.box(M.red, x, 2.75, z, 2.9, .12, 1.7); sign(x, 2.45, z + .86, 2.2, .55, 0, 8);
  batch.sphere(M.metal, x - .5, 1.6, z, .35, .18, .35); batch.box(M.white, x + .5, 1.65, z, .5, .3, .4);
}
function bicycle(batch, x, z) {
  const m = M.metal;
  for (const s of [-1, 1]) { const g = new THREE.TorusGeometry(.34, .035, 6, 16); batch.add(g, M.dark, x + s * .55, .36, z, 1, 1, 1); }
  batch.cyl(m, V(x - .55, .36, z), V(x, .85, z), .03); batch.cyl(m, V(x, .85, z), V(x + .55, .36, z), .03); batch.cyl(m, V(x - .55, .36, z), V(x + .2, .36, z), .03); batch.cyl(m, V(x + .2, .36, z), V(x, .85, z), .03); batch.cyl(m, V(x + .55, .36, z), V(x + .45, 1, z), .03);
  batch.box(M.dark, x, .92, z, .3, .07, .18); batch.box(m, x + .45, 1.02, z, .06, .06, .45);
}

export function buildWorld(scene) {
  buildSigns(scene);
  const batch = new Batch(scene);
  // Distant ground hides the finite edge of the preview block.
  batch.box(M.grass, 0, -.18, -1065, 4000, .3, 1870);
  batch.box(M.grass, 0, -.18, 1065, 4000, .3, 1870);
  batch.box(M.grass, -1075, -.18, 0, 1850, .3, 260);
  batch.box(M.grass, 1075, -.18, 0, 1850, .3, 260);
  // Ground is split around the canal so the water is actually below street level.
  batch.box(M.grass, 0, -.16, -69, 320, .32, 122);
  batch.box(M.grass, 0, -.16, 88.5, 320, .32, 83);
  // Street band between those two slabs: without it the bright sky shows through
  // two rectangular holes at the ends of the canal in the overview camera.
  batch.box(M.grass, 0, -.16, 1.5, 320, .32, 19);
  // Close the two dry gaps beside the canal ends; the water is 300 m, the block 320 m.
  batch.box(M.grass, -155, -.16, CANAL.z, 10, .32, CANAL.width);
  batch.box(M.grass, 155, -.16, CANAL.z, 10, .32, CANAL.width);
  batch.box(M.stone, -150.2, -.35, CANAL.z, .6, 1.5, CANAL.width);
  batch.box(M.stone, 150.2, -.35, CANAL.z, .6, 1.5, CANAL.width);
  batch.box(M.concreteDark, 0, -1.35, CANAL.z, CANAL.length, .4, CANAL.width);
  batch.box(M.asphalt, 0, -.02, 0, 240, .16, 10);
  batch.box(M.paving, 0, .02, -6.5, 240, .2, 3);
  batch.box(M.paving, 0, .02, 7, 240, .2, 4);
  batch.box(M.paving, 0, .02, 52, 240, .2, 10);
  batch.box(M.stone, 0, -.35, 10.8, 300, 1.5, .6);
  batch.box(M.stone, 0, -.35, 47.2, 300, 1.5, .6);
  for (let x = -116; x < 116; x += 7) batch.box(M.white, x, .07, 0, 3, .02, .14);
  for (const bx of [-52, 62]) { for (let i = -4; i <= 4; i++) batch.box(M.white, bx + i * .8, .08, 0, .45, .02, 8); bridge(batch, bx); }
  railing(batch, 10.2); railing(batch, 47.8);
  // Park paths and the circular New Year plaza.
  batch.box(M.paving, -8, .03, 84, 4.2, .1, 54);
  for (let z = 58; z < 110; z += 2) batch.box(M.paving, 66 + Math.sin(z * .11) * 6, .035, z, 4.4, .1, 2.4, Math.cos(z * .11) * .25);
  batch.box(M.paving, 70, .03, 92, 72, .1, 3.4);
  const plaza = new THREE.CylinderGeometry(10.5, 10.5, .12, 48); batch.add(plaza, M.paving, -40, .03, 77);
  const ring = new THREE.TorusGeometry(10.2, .12, 6, 64); ring.rotateX(Math.PI / 2); batch.add(ring, M.stone, -40, .12, 77);

  for (let i = 0; i < 14; i++) lowBlock(batch, -104 + i * 16, i);
  const towers = [[-96,-38,16,14,34],[-72,-42,14,16,46],[-46,-40,18,14,38],[-18,-44,16,16,56],[10,-40,18,14,42],[38,-43,15,16,62],[66,-39,18,14,36],[94,-42,16,16,50],[-88,-72,20,18,58],[-56,-76,18,18,70],[-24,-74,20,16,48],[8,-78,18,18,76],[42,-74,20,16,64],[76,-78,18,18,54],[104,-72,16,16,68]];
  towers.forEach((t, i) => tower(batch, ...t, i));
  for (let i = 0; i < 18; i++) batch.box(M.concreteDark, -130 + i * 15, rr(12, 30), -118 - rr(0, 12), rr(10, 16), rr(24, 60), 12);
  // A small red-wall courtyard and a park gate give the quarter a Beijing silhouette.
  batch.box(M.red, -70, 3, -29, 30, 6, 1); roof(batch, -70, 6, -29, 31, 2, 1, M.roof);
  batch.box(M.red, -70, 4, -27, 12, 8, 5); roof(batch, -70, 8, -27, 14, 7, 2.2, M.roofGold); roof(batch, -70, 10.2, -27, 10, 5, 1.8, M.roofGold);
  sign(-70, 6.2, -24.4, 6, 1.3, 0, 19);
  paifang(batch, 66, 58);
  batch.box(M.dark, 47, 1.4, 55, 5, 1.5, .25); sign(47, 1.4, 55.15, 4.8, 1.3, 0, 10);

  for (let x = -105; x <= 105; x += 21) { lamp(batch, x, 8.5); lamp(batch, x + 8, 49.5, 4.5); }
  for (let x = -100; x <= 100; x += 14) { batch.box(M.concreteDark, x, .45, 9.2, 1.2, .9, .8); }
  for (const x of [-85,-30,18,88]) { bench(batch, x, 55.5); batch.box(M.metal, x + 2, .45, 55.5, .55, .9, .55); }
  for (const z of [66,84,104]) bench(batch, 61 + Math.sin(z * .11) * 6, z, Math.PI / 2);
  bench(batch, -28, 86, .4); bench(batch, -52, 86, -.4);
  foodCart(batch, -18, 50.5); foodCart(batch, 34, 50.5);
  for (const x of [-92,-61,-5,29,72,98]) bicycle(batch, x, -6.2);
  for (let x = -100; x <= 100; x += 25) { batch.box(M.metal, x, .08, 4.6, .8, .05, .5); batch.box(M.dark, x, .1, 4.6, .6, .03, .3); }
  // Utility wires, small posters and drain details along the hutong.
  const wireMat = new THREE.LineBasicMaterial({ color: 0x343a38 });
  for (let x = -100; x < 100; x += 25) {
    batch.cyl(M.wood, V(x, 0, -6.8), V(x, 8.5, -6.8), .09);
    batch.box(M.metal, x, 7.8, -6.8, 1.2, .08, .08);
    const pts = []; for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push(V(x + t * 25, 8.2 - Math.sin(t * Math.PI) * .8, -6.8)); }
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat));
  }
  for (let i = 0; i < 16; i++) { const x = rr(-100, 100); batch.box(M.white, x, 1.4, -7.72, .35, .5, .02); batch.box(M.red, x, 1.5, -7.7, .3, .12, .025); }

  const treePos = [], palmPos = [], shrubPos = [];
  for (let x = -100; x <= 100; x += 18) { if (!bridgeAt(x)) palmPos.push([x, 8.8, .8]); }
  for (let x = -95; x <= 100; x += 16) { if (x > 30) continue; palmPos.push([x, 59.5, rr(.85, 1.1)]); }
  for (let i = 0; i < 34; i++) { const x = rr(-108, 25), z = rr(62, 108); if (Math.hypot(x + 40, z - 77) > 13 && Math.abs(x + 8) > 4) treePos.push([x, z, rr(.8, 1.25)]); }
  for (let x = -100; x <= 100; x += 12) { shrubPos.push([x, 56.5, 0, .8]); if (!bridgeAt(x)) shrubPos.push([x + 4, 9.5, 0, .6]); }
  for (let i = 0; i < 40; i++) shrubPos.push([rr(32, 108), rr(58, 110), 0, rr(.6, 1)]);
  const trees = makeTrees(scene, treePos), palms = makePalms(scene, palmPos), bamboo = makeBamboo(scene), shrubs = makeShrubs(scene, shrubPos);
  const fir = makeChristmasTree(scene, batch, -40, 77);
  batch.flush(); flushSigns(scene);
  const lights = [];
  for (const [x, z] of [[-40,77],[66,58],[8,-6],[-18,50]]) { const l = new THREE.PointLight(0xffc978, 0, 18, 2); l.position.set(x, 4, z); scene.add(l); lights.push(l); }
  const interior = new THREE.PointLight(0xffe2ae, 24, 18, 2); interior.position.set(8, 3, -13); scene.add(interior);
  const interiorFill = new THREE.PointLight(0xfff0d0, 10, 12, 2); interiorFill.position.set(8, 2.6, -9); scene.add(interiorFill);
  return { batch, plants: [trees, palms, bamboo, shrubs], fir, lights, interior, interiorFill };
}

export function makeLife(scene) {
  const cars = [], peds = [], dummy = new THREE.Object3D();
  dummy.rotation.order = 'YXZ';
  const carColors = [0x8b8e88, 0x4d6168, 0x7a4d42, 0xb0ad9e, 0x3e4a45, 0x6b7378];
  const paint = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .5, metalness: .25 });
  const NC = 9;
  const carBody = new THREE.InstancedMesh(new THREE.BoxGeometry(3.8, .7, 1.7), paint, NC);
  const carCab = new THREE.InstancedMesh(new THREE.BoxGeometry(2, .65, 1.5), M.glass, NC);
  const carRoof = new THREE.InstancedMesh(new THREE.BoxGeometry(2.1, .1, 1.55), paint, NC);
  const wheelGeo = new THREE.CylinderGeometry(.32, .32, .18, 10); wheelGeo.rotateX(Math.PI / 2);
  const wheels = new THREE.InstancedMesh(wheelGeo, M.dark, NC * 4);
  const lights = new THREE.InstancedMesh(new THREE.BoxGeometry(.08, .18, .35), M.lamp, NC * 2);
  for (const m of [carBody, carCab, carRoof, wheels, lights]) { m.castShadow = true; m.frustumCulled = false; scene.add(m); }
  for (let i = 0; i < NC; i++) {
    const c = { x: -115 + i * 27, z: i % 2 ? 2.3 : -2.3, yaw: i % 2 ? Math.PI : 0, speed: rr(5, 9), dir: i % 2 ? -1 : 1 };
    cars.push(c); carBody.setColorAt(i, new THREE.Color(carColors[i % carColors.length])); carRoof.setColorAt(i, new THREE.Color(carColors[i % carColors.length]));
  }
  carBody.instanceColor.needsUpdate = true; carRoof.instanceColor.needsUpdate = true;
  const skin = new THREE.MeshStandardMaterial({ color: 0xb08a6b, roughness: .9 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .95 });
  const clothes = [0x5b6b62, 0x7a6a58, 0x4d5a6b, 0x8b8172, 0x6b4f48, 0x9a968a];
  const NP = 24;
  const torso = new THREE.InstancedMesh(new THREE.CapsuleGeometry(.22, .5, 3, 7), cloth, NP);
  const head = new THREE.InstancedMesh(new THREE.SphereGeometry(.15, 8, 6), skin, NP);
  const legs = new THREE.InstancedMesh(new THREE.CapsuleGeometry(.085, .55, 3, 5), M.dark, NP * 2);
  const arms = new THREE.InstancedMesh(new THREE.CapsuleGeometry(.065, .45, 3, 5), cloth, NP * 2);
  for (const m of [torso, head, legs, arms]) { m.castShadow = true; m.frustumCulled = false; scene.add(m); }
  for (let i = 0; i < NP; i++) {
    const path = i % 3, x = rr(-105, 105), col = new THREE.Color(clothes[i % clothes.length]);
    const p = { x: path === 2 ? rr(-10, -6) : x, z: path === 0 ? 6.5 : path === 1 ? rr(50, 55) : rr(60, 108), path, speed: rr(.7, 1.3), dir: rand() > .5 ? 1 : -1, phase: rr(0, 6.28), yaw: 0 };
    peds.push(p); torso.setColorAt(i, col); arms.setColorAt(i * 2, col); arms.setColorAt(i * 2 + 1, col);
  }
  torso.instanceColor.needsUpdate = true; arms.instanceColor.needsUpdate = true;
  function setInst(mesh, i, x, y, z, yaw = 0, rx = 0) { dummy.position.set(x, y, z); dummy.rotation.set(rx, yaw, 0); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); }
  function local(p, lx, lz) { const c = Math.cos(p.yaw), s = Math.sin(p.yaw); return [p.x + lx * c + lz * s, p.z - lx * s + lz * c]; }
  return {
    update(dt, t) {
      cars.forEach((c, i) => {
        c.x += c.speed * c.dir * dt; if (c.x > 122) c.x = -122; if (c.x < -122) c.x = 122;
        setInst(carBody, i, c.x, .65, c.z, c.yaw); setInst(carCab, i, c.x + (c.dir > 0 ? -.2 : .2), 1.25, c.z, c.yaw); setInst(carRoof, i, c.x + (c.dir > 0 ? -.2 : .2), 1.6, c.z, c.yaw);
        let w = 0; for (const wx of [-1.2, 1.2]) for (const wz of [-.8, .8]) { const [x, z] = local(c, wx, wz); setInst(wheels, i * 4 + w++, x, .33, z, c.yaw); }
        for (let h = 0; h < 2; h++) { const [x, z] = local(c, 1.92, h ? .55 : -.55); setInst(lights, i * 2 + h, x, .7, z, c.yaw); }
      });
      peds.forEach((p, i) => {
        const axis = p.path === 2 ? 'z' : 'x'; p[axis] += p.speed * p.dir * dt;
        if (p[axis] > 108) p.dir = -1; if (p[axis] < (p.path === 2 ? 60 : -108)) p.dir = 1;
        p.yaw = p.path === 2 ? (p.dir > 0 ? 0 : Math.PI) : (p.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
        const sw = Math.sin(t * 5 * p.speed + p.phase) * .35;
        setInst(torso, i, p.x, 1.05, p.z, p.yaw); setInst(head, i, p.x, 1.62, p.z, p.yaw);
        for (let s = 0; s < 2; s++) { const side = s ? 1 : -1; let [x, z] = local(p, side * .11, 0); setInst(legs, i * 2 + s, x, .42, z, p.yaw, s ? sw : -sw); [x, z] = local(p, side * .3, 0); setInst(arms, i * 2 + s, x, 1.05, z, p.yaw, s ? -sw : sw); }
      });
      for (const m of [carBody, carCab, carRoof, wheels, lights, torso, head, legs, arms]) m.instanceMatrix.needsUpdate = true;
    },
  };
}
