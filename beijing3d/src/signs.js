import * as THREE from 'three';
import { stats, rand } from '../../preview/src/state.js';
import { featureById } from './config.js';

// One atlas with real OSM names. No invented shop text is used.
export function makeSigns(scene, groups, signs) {
  const cols = 8, rows = 16, cell = 256;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell; canvas.height = rows * cell;
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const s of signs) {
    const col = s.index % cols, row = Math.floor(s.index / cols);
    const ox = col * cell, oy = row * cell;
    ctx.fillStyle = s.bg; ctx.fillRect(ox + 4, oy + 4, cell - 8, cell - 8);
    ctx.strokeStyle = s.fg; ctx.lineWidth = 3; ctx.strokeRect(ox + 12, oy + 12, cell - 24, cell - 24);
    ctx.fillStyle = s.fg;
    ctx.font = '600 46px NotoPreview, sans-serif';
    ctx.fillText(s.text, ox + cell / 2, oy + 102, cell - 36);
    ctx.font = '500 19px NotoPreview, sans-serif';
    ctx.fillText(s.sub, ox + cell / 2, oy + 166, cell - 36);
    ctx.font = '500 15px NotoPreview, sans-serif';
    ctx.fillText('OSM · ODbL', ox + cell / 2, oy + 218, cell - 40);
    ctx.save();
    ctx.beginPath(); ctx.rect(ox + 4, oy + 4, cell - 8, cell - 8); ctx.clip();
    for (let i = 0; i < 120; i++) {
      ctx.fillStyle = rand() > .5 ? 'rgba(235,225,200,.055)' : 'rgba(20,18,14,.06)';
      ctx.fillRect(ox + rand() * cell, oy + rand() * cell, 1 + rand() * 7, 1 + rand() * 3);
    }
    ctx.restore();
  }
  const atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping;
  atlas.minFilter = THREE.LinearFilter;
  atlas.magFilter = THREE.LinearFilter;
  atlas.generateMipmaps = false;
  atlas.anisotropy = 4;

  const mats = [];
  const sprites = [];
  for (const s of signs) {
    const col = s.index % cols, row = Math.floor(s.index / cols);
    const tex = atlas.clone();
    tex.repeat.set(1 / cols, 1 / rows);
    tex.offset.set(col / cols, 1 - (row + 1) / rows);
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({
      map: tex, color: 0xffffff, transparent: true, alphaTest: .02,
      depthTest: true, depthWrite: false, toneMapped: false, fog: false,
    });
    const sprite = new THREE.Sprite(mat);
    const f = featureById.get(s.featureId);
    const height = f && f.height ? f.height : 4.5;
    sprite.position.set(s.center[0], height + 2.6, s.center[1]);
    sprite.scale.set(5.4, 2.7, 1);
    sprite.renderOrder = 3;
    sprite.userData.featureId = s.featureId;
    sprite.userData.layer = s.layer;
    sprite.userData.ignorePick = true;
    (groups[s.layer] || groups.pois).add(sprite);
    mats.push(mat); sprites.push(sprite);
  }
  scene.userData.signMats = mats;
  scene.userData.signSprites = sprites;
  stats.signs = signs.length;
  return { mats, sprites, atlas };
}

export function updateSignLighting(scene, night) {
  for (const m of scene.userData.signMats || []) {
    m.color.setRGB(1, .97 - night * .08, .9 - night * .2);
  }
}

// The atlas has 128 real OSM names. Cull distant sprites so an oblique city
// view does not turn into a field of unreadable coloured dots; near street
// level they remain legible, and a selected feature's sign is always kept.
export function updateSignsVisibility(scene, camera, selectedId) {
  for (const s of scene.userData.signSprites || []) {
    s.visible = camera.position.distanceTo(s.position) < 300 || s.userData.featureId === selectedId;
  }
}
