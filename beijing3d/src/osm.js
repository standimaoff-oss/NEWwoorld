import * as THREE from 'three';
import { M } from './materials.js';
import { DATA, META, LAYERS } from './config.js';
import {
  MeshBuilder, addPolygonTop, addBuilding, addRibbon, addWall, addGate,
  addGround, addMarkers, addTrees, addDecorations, fillColliders,
} from './geometry.js';
import { makeSigns } from './signs.js';

function areaMaterial(a) {
  switch (a.kind) {
    case 'water': return M.water;
    case 'green': return M.grass;
    case 'pitch': return M.pitch;
    case 'historic': return M.red;
    case 'pier': return M.stone;
    case 'paving':
      if (a.tags.surface === 'paving_stones' || a.tags.highway === 'pedestrian' || a.tags.highway === 'footway') return M.paving;
      return M.road;
    default: return M.paving;
  }
}

function areaY(kind) {
  if (kind === 'water') return .012;
  if (kind === 'paving') return .028;
  if (kind === 'historic') return .034;
  if (kind === 'pier') return .022;
  if (kind === 'pitch') return .008;
  return .002;
}

function roadMaterial(tags) {
  const s = tags.surface, h = tags.highway;
  if (s === 'paving_stones' || h === 'pedestrian' || h === 'footway' || h === 'steps') return M.paving;
  if (s === 'asphalt' || h === 'primary' || h === 'secondary' || h === 'tertiary') return M.asphalt;
  return M.road;
}

function barrierMaterial(tags) {
  const b = tags.barrier;
  if (b === 'gate' || b === 'entrance') return M.darkWood;
  if (b === 'fence') return M.fence;
  return M.wall;
}

function lineY(kind) {
  if (kind === 'road') return .042;
  if (kind === 'waterway') return .055;
  if (kind === 'tree_row') return .012;
  if (kind === 'monument_line') return .05;
  if (kind === 'pier') return .03;
  return .03;
}

function lineMaterial(l) {
  switch (l.kind) {
    case 'road': return roadMaterial(l.tags);
    case 'waterway': return M.water;
    case 'tree_row': return M.grass;
    case 'monument_line': return M.paving;
    case 'pier': return M.stone;
    default: return barrierMaterial(l.tags);
  }
}

export function buildScene(scene, state) {
  const groups = {};
  for (const [key] of LAYERS) {
    if (key === 'labels') continue;
    const g = new THREE.Group();
    g.name = 'osm-' + key;
    scene.add(g);
    groups[key] = g;
  }
  const pickMeshes = [];
  const ground = addGround(scene);

  // Flat OSM areas: water, parks, pedestrian squares, campuses, historic sites.
  const areaBuilders = new Map();
  for (const a of DATA.areas) {
    if (!areaBuilders.has(a.layer)) areaBuilders.set(a.layer, new MeshBuilder(a.layer));
    addPolygonTop(areaBuilders.get(a.layer), areaMaterial(a), a.rings, areaY(a.kind), a.featureId);
  }
  for (const [layer, b] of areaBuilders) b.build(groups[layer] || groups.other, pickMeshes);

  // Linear OSM geometry: every highway way, barrier way, waterway, tree row.
  const lineBuilders = new Map();
  for (const l of DATA.lines) {
    if (!lineBuilders.has(l.layer)) lineBuilders.set(l.layer, new MeshBuilder(l.layer));
    const b = lineBuilders.get(l.layer);
    if (l.kind === 'barrier') {
      const isGate = l.tags.barrier === 'gate' || l.tags.barrier === 'entrance';
      if (isGate) addGate(b, barrierMaterial(l.tags), l.points, l.height, l.featureId);
      else addWall(b, barrierMaterial(l.tags), l.points, l.width, l.height, l.featureId, l.closed);
    } else {
      addRibbon(b, lineMaterial(l), l.points, l.width, lineY(l.kind), l.featureId, l.closed);
    }
  }
  for (const [layer, b] of lineBuilders) b.build(groups[layer] || groups.other, pickMeshes);

  // Exact OSM building footprints, extruded to documented or inferred heights.
  const buildingBuilder = new MeshBuilder('buildings');
  for (const b of DATA.buildings) addBuilding(buildingBuilder, b);
  buildingBuilder.build(groups.buildings, pickMeshes);

  addMarkers(groups, pickMeshes, DATA.markers);
  const treeGroup = addTrees(groups, DATA.trees);
  const signSystem = makeSigns(scene, groups, DATA.signs);
  const decorations = addDecorations(groups.details, DATA.buildings);
  fillColliders(DATA.buildings, DATA.lines);

  for (const [key, g] of Object.entries(groups)) {
    if (key !== 'labels') g.visible = state.layers[key] !== false;
  }
  scene.userData.ground = ground;
  const result = {
    groups, pickMeshes, ground, treeGroup, signSystem, decorations,
    counts: META.stats,
  };
  return result;
}

export function setLayer(sceneObj, name, on) {
  if (name === 'labels') return;
  const g = sceneObj.groups[name];
  if (g) g.visible = !!on;
}
