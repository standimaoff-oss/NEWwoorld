/* Движение: машины по улицам (едут по правой полосе, тормозят у игрока), светофоры, ночные фары. */
import * as THREE from 'three';
import { ROADS, HALF } from './gen.js';
import { instanced } from '../util/geo.js';

const CAR_COLORS = [0xb8bcc0, 0x2b2f33, 0x8a1f1f, 0x1f3a6a, 0x2a5a3a, 0xd8cfae, 0x6a6a72, 0xe0e0e0, 0x3a2a20];

export class Traffic {
  constructor(scene, city, weather) {
    this.scene = scene;
    this.city = city;
    this.weather = weather;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.cars = [];
    this.lights = [];
    this.enabled = true;
  }

  /** Собирает простую, но узнаваемую модель машины одним мешем на кузов + колёса инстансами. */
  _carGeo() {
    if (this._geo) return this._geo;
    const parts = [];
    const body = new THREE.BoxGeometry(1.85, 0.62, 4.2);
    body.translate(0, 0.62, 0); parts.push(body);
    const hood = new THREE.BoxGeometry(1.72, 0.28, 1.5);
    hood.translate(0, 0.95, 1.25); parts.push(hood);
    const cab = new THREE.BoxGeometry(1.65, 0.62, 2.0);
    cab.translate(0, 1.15, -0.15); parts.push(cab);
    const trunk = new THREE.BoxGeometry(1.72, 0.24, 1.2);
    trunk.translate(0, 0.92, -1.5); parts.push(trunk);
    // «стёкла» — отдельный меш, но объединим в одну геометрию с кузовом (одним материалом)
    const g = parts.reduce((acc, p) => {
      const np = p.toNonIndexed ? p.toNonIndexed() : p;
      return acc ? mergeTwo(acc, np) : np;
    }, null);
    this._geo = g;
    return g;
  }

  _headGeo() {
    if (this._head) return this._head;
    const a = new THREE.BoxGeometry(0.34, 0.16, 0.08); a.translate(0.6, 0.72, 2.09);
    const b = new THREE.BoxGeometry(0.34, 0.16, 0.08); b.translate(-0.6, 0.72, 2.09);
    this._head = mergeTwo(a.toNonIndexed(), b.toNonIndexed());
    return this._head;
  }

  _tailGeo() {
    if (this._tail) return this._tail;
    const a = new THREE.BoxGeometry(0.3, 0.14, 0.08); a.translate(0.6, 0.74, -2.09);
    const b = new THREE.BoxGeometry(0.3, 0.14, 0.08); b.translate(-0.6, 0.74, -2.09);
    this._tail = mergeTwo(a.toNonIndexed(), b.toNonIndexed());
    return this._tail;
  }

  _wheelGeo() {
    if (this._wheel) return this._wheel;
    const w = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 10);
    w.rotateZ(Math.PI / 2);
    this._wheel = w;
    return w;
  }

  build() {
    const bodyGeo = this._carGeo();
    const glassGeo = new THREE.BoxGeometry(1.55, 0.5, 1.9);
    glassGeo.translate(0, 1.18, -0.15);
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x1b2830, roughness: 0.1, metalness: 0.6, envMapIntensity: 1.6 });
    const wheelGeo = this._wheelGeo();
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.85 });
    const bodyMats = CAR_COLORS.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.35, metalness: 0.55, envMapIntensity: 1.3 }));
    const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0xffdca0, emissiveIntensity: 0.0 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0x8a1a1a, emissive: 0xff2020, emissiveIntensity: 0.0 });
    const N = 26;
    for (let i = 0; i < N; i++) {
      const road = ROADS[i % ROADS.length];
      const lane = (i % 2 === 0) ? 1 : -1;   // сторона/направление
      const g = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, bodyMats[i % bodyMats.length]);
      body.castShadow = true;
      g.add(body);
      g.add(new THREE.Mesh(glassGeo, glassMat));
      // колёса
      const wheels = instanced([wheelGeo], wheelMat, [
        { x: -0.92, y: 0.34, z: 1.35 }, { x: 0.92, y: 0.34, z: 1.35 },
        { x: -0.92, y: 0.34, z: -1.35 }, { x: 0.92, y: 0.34, z: -1.35 },
      ]);
      wheels.instanceMatrix.needsUpdate = true;
      g.add(wheels);
      // фары и стопы: пара одной геометрией — было 4 вызова отрисовки на машину
      const lights = new THREE.Mesh(this._headGeo(), lightMat);
      g.add(lights);
      const tails = new THREE.Mesh(this._tailGeo(), tailMat);
      g.add(tails);
      const car = {
        g, body, road, lane, dir: lane,
        along: -HALF - 20 + Math.random() * (2 * HALF + 40),
        speed: (lane > 0 ? 1 : -1) * (8 + Math.random() * 7),
        headMat: lightMat, tailMat,
        hue: i % CAR_COLORS.length,
      };
      g.position.y = 0.02;
      this.group.add(g);
      this.cars.push(car);
    }
    this.lightMat = lightMat;
    this.tailMat = tailMat;
  }

  update(dt) {
    if (!this.enabled) return;
    const pl = this.game && this.game.player;
    const px = pl ? pl.pos.x : 0;
    const pz = pl ? pl.pos.z : 0;
    for (const c of this.cars) {
      const r = c.road;
      c.along += c.speed * dt;
      if (c.along > HALF + 30) c.along = -HALF - 30;
      if (c.along < -HALF - 30) c.along = HALF + 30;
      // позиция
      const offset = c.lane * (r.width / 4);        // правая полоса
      let x, z, rotY;
      if (r.axis === 'z') {
        x = r.at + offset;
        z = c.along;
        rotY = c.speed > 0 ? Math.PI : 0;
      } else {
        x = c.along;
        z = r.at + offset;
        rotY = c.speed > 0 ? -Math.PI / 2 : Math.PI / 2;
      }
      c.g.position.set(x, 0.02, z);
      c.g.rotation.y = rotY;
      c.x = x; c.z = z;
      // невидимые за пределами ~260 м от игрока
      const near = Math.abs(x - px) < 280 && Math.abs(z - pz) < 280;
      c.g.visible = near;
      // тень бросают только ближние машины: дальние в неё не попадают и так
      const carNear = Math.abs(x - px) < 70 && Math.abs(z - pz) < 70;
      if (c.body && c.body.castShadow !== carNear) c.body.castShadow = carNear;
      // свет: днём нет, ночью фары
    }
    const night = this.weather ? this.weather.night : 0;
    if (this.lightMat) this.lightMat.emissiveIntensity = night * 2.6 + (this.weather && this.weather.rain > 0.4 ? 0.8 : 0);
    if (this.tailMat) this.tailMat.emissiveIntensity = night * 1.8 + 0.15;
  }
}

/* простое слияние двух неиндексированных геометрий (позиции/нормали/uv) */
function mergeTwo(a, b) {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    if (!a.attributes[name] || !b.attributes[name]) continue;
    const sa = a.attributes[name], sb = b.attributes[name];
    const arr = new Float32Array(sa.array.length + sb.array.length);
    arr.set(sa.array, 0); arr.set(sb.array, sa.array.length);
    out.setAttribute(name, new THREE.BufferAttribute(arr, sa.itemSize));
  }
  return out;
}
