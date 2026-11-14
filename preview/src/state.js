import * as THREE from 'three';

// Shared shader uniforms. All animation is driven by one simulation clock.
export const U = {
  time: { value: 0 }, rain: { value: 0 }, night: { value: 0 },
  wind: { value: 1 }, effects: { value: 1 },
  sunDir: { value: new THREE.Vector3(-.45, .72, .35).normalize() },
  player: { value: new THREE.Vector3(9999, 0, 9999) },
  grassRadius: { value: 85 },
};
export const state = {
  quality: 'high', weather: 'clear', hour: 16.4, mode: 'orbit',
  paused: false, tour: false, grass: true, water: true, plants: true,
  festive: true, ao: true, gi: true, view: 0, ready: false,
};
let seed = 20261114;
export function rand() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
export const rr = (a, b) => a + rand() * (b - a);
export const pick = a => a[Math.floor(rand() * a.length)];
export const clamp = THREE.MathUtils.clamp;
export const lerp = THREE.MathUtils.lerp;
export const stats = { grass: 0, bamboo: 0, palms: 0, trees: 0, signs: 0, windows: 0 };
export const colliders = []; // simple XZ AABBs for the walkthrough only
export const CANAL = { z: 29, width: 36, length: 300, y: -.55 };
export function isWater(x, z) { return z > CANAL.z - CANAL.width / 2 && z < CANAL.z + CANAL.width / 2 && Math.abs(x) < CANAL.length / 2; }
export function bridgeAt(x) { return Math.abs(x + 52) < 4.5 || Math.abs(x - 62) < 4.5; }
