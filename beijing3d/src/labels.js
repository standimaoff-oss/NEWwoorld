import * as THREE from 'three';
import { DATA, escapeHtml } from './config.js';

// DOM labels are projected from the exact OSM feature centre each frame. They
// are intentionally culled by distance and priority so 691 names do not cover
// the scene; the search panel can reveal every named feature.
export function makeLabels(container, focusFeature) {
  const items = DATA.labels.map(l => {
    const el = document.createElement('div');
    el.className = 'osm-label';
    el.dataset.featureId = l.featureId;
    el.dataset.layer = l.layer;
    el.innerHTML = `<b>${escapeHtml(l.text)}</b>${l.sub ? `<span>${escapeHtml(l.sub)}</span>` : ''}`;
    el.title = `${l.text} · ${l.featureId} · © OpenStreetMap contributors`;
    el.onclick = e => { e.stopPropagation(); focusFeature(l.featureId); };
    container.appendChild(el);
    return { ...l, el };
  });
  const v = new THREE.Vector3(), world = new THREE.Vector3();

  function update(camera, state, selectedId) {
    camera.updateMatrixWorld();
    const w = innerWidth, h = innerHeight;
    const labelsOn = state.layers.labels !== false;
    for (const l of items) {
      const selected = l.featureId === selectedId;
      if (!labelsOn && !selected) { l.el.style.display = 'none'; continue; }
      if (!state.showAllLabels && !selected && l.priority < 30) { l.el.style.display = 'none'; continue; }
      world.set(l.x, l.y, l.z);
      const dist = camera.position.distanceTo(world);
      if (dist > 850) { l.el.style.display = 'none'; continue; }
      v.copy(world).project(camera);
      if (v.z < -1 || v.z > 1) { l.el.style.display = 'none'; continue; }
      const x = (v.x * .5 + .5) * w, y = (-v.y * .5 + .5) * h;
      if (x < -80 || x > w + 80 || y < -40 || y > h + 40) { l.el.style.display = 'none'; continue; }
      l.el.style.display = '';
      l.el.style.left = `${x}px`;
      l.el.style.top = `${y}px`;
      l.el.classList.toggle('selected', selected);
      l.el.classList.toggle('quiet', l.layer === 'pois' && !selected);
      l.el.style.opacity = String(Math.max(.45, Math.min(1, 1.25 - dist / 900)));
    }
  }
  return { items, update, count: items.length };
}
