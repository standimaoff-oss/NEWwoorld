/* Сборка города: земля, дороги, тротуары, дома с фасадами и окнами, магазины,
   деревья (лиственные, ели, пальмы), бамбук, фонари, скамейки. */
import * as THREE from 'three';
import {
  ROADS, RIVER, LAKE, HALF, WORLD_SIZE, PARK_BAMBOO, PARK_FRIENDS, SQUARE,
  generateCity, roadAt, isSidewalk, lakeDist, isWater, inPark, shopDoor, hash2, rng,
} from './gen.js';
import {
  asphaltTexture, sidewalkTexture, concreteTexture, facadeTexture, roofTexture,
  grassTexture, barkTexture, leafTexture, signTexture, roadMarkTexture,
  windowTexture, windowLitTexture, bambooLeafTexture, palmFrondTexture,
} from '../gfx/textures.js';
import { settings } from '../core/settings.js';
import { mergeGeometries, MeshBuilder, instanced, xform } from '../util/geo.js';

const M = (geo, mat, x, y, z, ry = 0) => {
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.y = ry; return m;
};

export class City {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.group = new THREE.Group(); scene.add(this.group);
    this.data = null;
    this.colliders = [];  // {x,z,w,d,ry,h}
    this.solidGrid = null;
    this.shopMeshes = new Map();
    this.nightLights = [];
    this.materials = {};
    this.palms = [];
  }

  async build(progress = () => {}) {
    this.data = generateCity();
    progress(0.25, 'планировка города');
    this._materials();
    this._terrain();
    progress(0.34, 'дороги и тротуары');
    this._roads();
    this._parks();
    progress(0.5, 'дома');
    this._buildings();
    progress(0.68, 'деревья и бамбук');
    this._vegetation();
    this._streetFurniture();
    this._xmas();
    this._buildSolidGrid();
    progress(0.8, 'магазины');
    this._shopDetails();
    return this.data;
  }

  _materials() {
    const m = this.materials;
    m.asphalt = new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.92, metalness: 0.02 });
    m.asphalt.map.repeat.set(4, 4);
    m.sidewalk = new THREE.MeshStandardMaterial({ map: sidewalkTexture(), roughness: 0.88 });
    m.sidewalk.map.repeat.set(60, 60);
    m.curb = new THREE.MeshStandardMaterial({ map: concreteTexture([150, 148, 142]), roughness: 0.8 });
    m.grass = new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 0.95, color: 0xffffff });
    m.grass.map.repeat.set(260, 260);
    m.roof = new THREE.MeshStandardMaterial({ map: roofTexture(), roughness: 0.95 });
    m.bark = new THREE.MeshStandardMaterial({ map: barkTexture(), roughness: 0.9 });
    m.leafMaple = new THREE.MeshStandardMaterial({ map: leafTexture('maple'), roughness: 0.92, color: 0xffffff });
    m.leafBirch = new THREE.MeshStandardMaterial({ map: leafTexture('birch'), roughness: 0.92, color: 0xffffff });
    m.leafAutumn = new THREE.MeshStandardMaterial({ map: leafTexture('autumn'), roughness: 0.85 });
    m.glass = new THREE.MeshStandardMaterial({ map: windowTexture(), roughness: 0.28, metalness: 0.45, envMapIntensity: 1.4 });
    m.glassLit = new THREE.MeshStandardMaterial({
      map: windowTexture(), emissive: 0xffffff, emissiveMap: windowLitTexture(),
      emissiveIntensity: 0.0, roughness: 0.3, metalness: 0.35, envMapIntensity: 1.2,
    });
    m.darkMetal = new THREE.MeshStandardMaterial({ color: 0x2a3033, roughness: 0.55, metalness: 0.5 });
    m.paint = new THREE.MeshStandardMaterial({ color: 0xd9d6cc, roughness: 0.7 });
    m.bamboo = new THREE.MeshStandardMaterial({ map: leafTexture('birch'), color: 0xc4d47a, roughness: 0.7 });
    m.bambooLeaf = new THREE.MeshStandardMaterial({ color: 0x5d9a3a, roughness: 0.8, side: THREE.DoubleSide });
    m.signPost = new THREE.MeshStandardMaterial({ color: 0x353d42, roughness: 0.6, metalness: 0.3 });
    m.neonColors = [0xff5a5a, 0x59d3ff, 0xffd23f, 0x7bff9e, 0xff8ae2];
  }

  _terrain() {
    // земля: большая плоскость с текстурой травы; у реки край
    const g = new THREE.PlaneGeometry(WORLD_SIZE + 300, WORLD_SIZE + 300, 40, 40);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      let y = 0.16;
      // под водой земля заметно ниже уровня воды (RIVER.level = -0.35),
      // иначе сквозь волны видны зелёные «острова»
      if (z > RIVER.z0 - 3) y = -3.2;
      else if (z > RIVER.z0 - 12) y = -1.15;                 // пологий спуск к воде
      else if (lakeDist(x, z) < 1.10) y = -3.0;
      else if (lakeDist(x, z) < 1.30) y = -0.9;
      p.setY(i, y);
    }
    g.computeVertexNormals();
    const ground = new THREE.Mesh(g, this.materials.grass);
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.group.add(ground);
    this.ground = ground;

    // берег: бетонный откос набережной
    const bankW = WORLD_SIZE + 300;
    const bank = new THREE.Mesh(new THREE.BoxGeometry(bankW, 1.4, 3.6), this.materials.curb);
    bank.position.set(0, -0.35, RIVER.z0 - 2.2);
    bank.receiveShadow = true;
    this.group.add(bank);
    // парапет
    const rail = new THREE.Mesh(new THREE.BoxGeometry(bankW, 0.85, 0.35), this.materials.paint);
    rail.position.set(0, 0.55, RIVER.z0 - 3.2);
    this.group.add(rail);
  }

  _roads() {
    const markGeos = [];
    // дороги не должны уходить в воду: обрезаем по набережной
    const Z_CUT = RIVER.z0 - 14;
    for (const r of ROADS) {
      let len = WORLD_SIZE + 60;
      let alongZ = 0;          // смещение центра вдоль дороги
      if (r.axis === 'z') {
        // вдоль Z: длина от -HALF-30 до Z_CUT
        const z0 = -HALF - 30, z1 = Z_CUT;
        len = z1 - z0; alongZ = (z0 + z1) / 2 - (r.axis === 'z' ? 0 : r.at);
      }
      const geo = new THREE.PlaneGeometry(r.axis === 'z' ? r.width : len, r.axis === 'z' ? len : r.width);
      geo.rotateX(-Math.PI / 2);
      const roadMat = this.materials.asphalt.clone();
      roadMat.map = this.materials.asphalt.map.clone();
      roadMat.map.needsUpdate = true;
      roadMat.map.repeat.set((r.axis === 'z' ? r.width : len) / 2.4, (r.axis === 'z' ? len : r.width) / 2.4);
      roadMat.color = new THREE.Color(0x8e8e8a);
      roadMat.roughness = 1.0; roadMat.metalness = 0.0;
      const mesh = new THREE.Mesh(geo, roadMat);
      if (r.axis === 'z') mesh.position.set(r.at, 0.18, alongZ);
      else mesh.position.set(0, 0.18, r.at);
      mesh.receiveShadow = true;
      this.group.add(mesh);
      // тротуары по бокам
      for (const s of [-1, 1]) {
        const sw = new THREE.PlaneGeometry(r.axis === 'z' ? 2.6 : len, r.axis === 'z' ? len : 2.6);
        sw.rotateX(-Math.PI / 2);
        const swm = new THREE.Mesh(sw, this.materials.sidewalk);
        if (r.axis === 'z') swm.position.set(r.at + s * (r.width / 2 + 1.3), 0.225, alongZ);
        else swm.position.set(0, 0.225, r.at + s * (r.width / 2 + 1.3));
        swm.receiveShadow = true;
        this.group.add(swm);
        // бордюр
        const cb = new THREE.BoxGeometry(r.axis === 'z' ? 0.22 : len, 0.26, r.axis === 'z' ? len : 0.22);
        const cbm = new THREE.Mesh(cb, this.materials.curb);
        if (r.axis === 'z') cbm.position.set(r.at + s * (r.width / 2), 0.19, alongZ);
        else cbm.position.set(0, 0.19, r.at + s * (r.width / 2));
        cbm.receiveShadow = true;
        this.group.add(cbm);
      }
      // разметка: пунктир по центру
      const step = 6;
      const tEnd = r.axis === 'z' ? Z_CUT - 8 : HALF - 20;
      for (let t = -HALF + 20; t < tEnd; t += step * 2) {
        const seg = new THREE.PlaneGeometry(r.axis === 'z' ? 0.16 : step, r.axis === 'z' ? step : 0.16);
        seg.rotateX(-Math.PI / 2);
        seg.translate(r.axis === 'z' ? r.at : t, 0.196, r.axis === 'z' ? t : r.at);
        markGeos.push(seg);
      }
      // разметка: двойная сплошная у главных
      if (r.main) {
        for (const sgn of [-0.22, 0.22]) {
          const len2 = r.axis === 'z' ? (Z_CUT - (-HALF - 30)) : WORLD_SIZE;
          const line = new THREE.PlaneGeometry(r.axis === 'z' ? 0.12 : len2, r.axis === 'z' ? len2 : 0.12);
          line.rotateX(-Math.PI / 2);
          if (r.axis === 'z') line.translate(r.at + sgn, 0.196, (-HALF - 30 + Z_CUT) / 2);
          else line.translate(0, 0.196, r.at + sgn);
          markGeos.push(line);
        }
      }
    }
    const markMat = new THREE.MeshStandardMaterial({ color: 0xdedad0, roughness: 0.7 });
    if (markGeos.length) {
      const mm = new THREE.Mesh(mergeGeometries(markGeos), markMat);
      mm.matrixAutoUpdate = false;
      this.group.add(mm);
    }
    // пешеходные переходы на перекрёстках
    const zebraGeos = [];
    for (const rx of ROADS.filter((r) => r.axis === 'z')) {
      for (const rz of ROADS.filter((r) => r.axis === 'x')) {
        for (let i = 0; i < 7; i++) {
          const g1 = new THREE.BoxGeometry(0.55, 0.02, rz.width * 0.85);
          g1.translate(rx.at + (i - 3) * 0.95, 0.197, rz.at);
          zebraGeos.push(g1);
          const g2 = new THREE.BoxGeometry(rx.width * 0.85, 0.02, 0.55);
          g2.translate(rx.at, 0.197, rz.at + (i - 3) * 0.95);
          zebraGeos.push(g2);
        }
      }
    }
    if (zebraGeos.length) {
      const zm = new THREE.Mesh(mergeGeometries(zebraGeos), markMat);
      this.group.add(zm);
    }
    // лужи: одна геометрия, проявляются в дождь
    const puddleGeos = [];
    const rnd = rng(31);
    for (let i = 0; i < 150; i++) {
      const r = ROADS[Math.floor(rnd() * ROADS.length)];
      const t = -HALF + rnd() * WORLD_SIZE;
      const off = (rnd() - 0.5) * (r.width - 3);
      const pg = new THREE.CircleGeometry(0.8 + rnd() * 2.2, 12);
      pg.rotateX(-Math.PI / 2);
      pg.scale(1, 0.55 + rnd() * 0.5, 1);
      pg.translate(r.axis === 'z' ? r.at + off : t, 0.199, r.axis === 'z' ? t : r.at + off);
      puddleGeos.push(pg);
    }
    this.puddleMat = new THREE.MeshStandardMaterial({ color: 0x18262e, roughness: 0.05, metalness: 0.85, transparent: true, opacity: 0.0 });
    this.puddles = new THREE.Mesh(mergeGeometries(puddleGeos), this.puddleMat);
    this.puddles.receiveShadow = false;
    this.group.add(this.puddles);
    this.plaza = null;
  }

  _parks() {
    // площадь: тротуарная плитка кругом
    const plazaGeo = new THREE.CircleGeometry(SQUARE.r, 48);
    plazaGeo.rotateX(-Math.PI / 2);
    const plaza = new THREE.Mesh(plazaGeo, this.materials.sidewalk);
    plaza.position.set(SQUARE.cx, 0.228, SQUARE.cz);
    plaza.material = this.materials.sidewalk.clone();
    plaza.material.map = this.materials.sidewalk.map.clone();
    plaza.material.map.needsUpdate = true;
    plaza.material.map.repeat.set(18, 18);
    plaza.material.color = new THREE.Color(0xa8a49a);
    plaza.receiveShadow = true;
    this.group.add(plaza);
    // дорожки бамбукового парка
    for (const p of this.data.paths) {
      const len = Math.hypot(p.x2 - p.x1, p.z2 - p.z1);
      const g = new THREE.PlaneGeometry(p.w, len);
      g.rotateX(-Math.PI / 2);
      const pm = this.materials.sidewalk.clone();
      pm.map = this.materials.sidewalk.map.clone(); pm.map.needsUpdate = true;
      pm.map.repeat.set(p.w / 1.6, len / 1.6);
      const m = new THREE.Mesh(g, pm);
      m.position.set((p.x1 + p.x2) / 2, 0.228, (p.z1 + p.z2) / 2);
      m.rotation.y = Math.atan2(p.x2 - p.x1, p.z2 - p.z1);
      m.receiveShadow = true;
      this.group.add(m);
    }
    // набережная — плитка вдоль реки
    const emb = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_SIZE, 7), this.materials.sidewalk);
    emb.rotation.x = -Math.PI / 2;
    emb.position.set(0, 0.228, RIVER.z0 - 7);
    emb.material = this.materials.sidewalk.clone();
    emb.material.map = this.materials.sidewalk.map.clone();
    emb.material.map.needsUpdate = true;
    emb.material.map.repeat.set(120, 3);
    emb.receiveShadow = true;
    this.group.add(emb);
  }

  _buildings() {
    const facadeCache = new Map();
    const rnd = rng(4242);
    const litWindows = [];
    const litFrame = [];   // матрицы окон со светом
    const darkFrame = [];  // матрицы тёмных окон
    const paintList = [], corniceList = [], roofBoxList = [];  // детали цвета «краска»
    const metalList = [];  // тёмный металл
    const doorList = [];
    const winGeo = new THREE.PlaneGeometry(1, 1);

    for (const b of this.data.buildings) {
      if (b.kind === 'shop') { this._shopBox(b); continue; }
      const key = b.style + ':' + (b.seed % 7);
      if (!facadeCache.has(key)) {
        const t = facadeTexture(b.style, (b.seed % 7) + 1).clone();
        t.needsUpdate = true;
        facadeCache.set(key, t);
      }
      const tex = facadeCache.get(key);
      const tile = 7.2; // метров на один период текстуры
      // Тело дома — в батч по стилю (текстуры с общим repeat, чтобы не плодить материалы)
      const tint = 0.86 + ((b.seed % 13) / 13) * 0.26;
      const hueShift = ((b.seed % 7) - 3) * 0.012;
      const bodyKey = key;
      if (!this._bodyBatches) this._bodyBatches = new Map();
      let batch = this._bodyBatches.get(bodyKey);
      if (!batch) {
        const t = tex.clone(); t.needsUpdate = true;
        t.repeat.set(Math.max(1, Math.round((b.w + b.d) / (tile * 2))), Math.max(1, Math.round(b.h / tile)));
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.86, metalness: 0.02 });
        mat.color.setRGB(tint * (1 + hueShift), tint, tint * (1 - hueShift * 0.6));
        batch = { mat, list: [] };
        this._bodyBatches.set(bodyKey, batch);
      }
      batch.list.push({ x: b.x, y: b.h / 2 + 0.16, z: b.z, ry: b.rotY || 0, sx: b.w, sy: b.h, sz: b.d });

      // окна — в общие инстансы
      const floors = b.floors;
      const rows = Math.max(1, floors - (b.style === 'private' ? 0 : 1));
      const winW = b.style === 'private' ? 1.15 : 1.45, winH = 1.35;
      const rnd2 = rng(b.seed + 77);
      const cosa = Math.cos(b.rotY || 0), sina = Math.sin(b.rotY || 0);
      for (let side = 0; side < 4; side++) {
        if (side > 0 && b.style === 'private') continue;
        const along = side < 2 ? b.w : b.d;
        const cc = Math.max(2, Math.floor((along - 2.4) / 3.0));
        for (let f = 0; f < rows; f++) {
          const y = 2.2 + f * 3.05;
          if (y > b.h - 1.35) break;
          for (let c = 0; c < cc; c++) {
            if (rnd2() < 0.05) continue;
            const t = ((c + 0.5) / cc - 0.5) * (along - 2.4);
            let lx, lz, ry;
            if (side === 0) { lx = t; lz = b.d / 2 + 0.08; ry = 0; }
            else if (side === 1) { lx = -t; lz = -b.d / 2 - 0.08; ry = Math.PI; }
            else if (side === 2) { lx = b.w / 2 + 0.08; lz = -t; ry = Math.PI / 2; }
            else { lx = -b.w / 2 - 0.08; lz = t; ry = -Math.PI / 2; }
            const px = b.x + lx * cosa + lz * sina;
            const pz = b.z - lx * sina + lz * cosa;
            const rot = (b.rotY || 0) + ry;
            const isLit = rnd2() < (b.style === 'office' ? 0.6 : 0.42);
            const rec = { x: px, y, z: pz, ry: rot, sx: winW, sy: winH, sz: 1 };
            (isLit ? litFrame : darkFrame).push(rec);
            if (isLit) litWindows.push(rec);
          }
        }
      }
      // балконы объединены по дому
      if (b.style !== 'private' && b.floors > 2) {
        for (let side = 0; side < 2; side++) {
          const along = side < 2 ? b.w : b.d;
          const cc = Math.max(2, Math.floor((along - 2.4) / 6.0));
          for (let f = 1; f < rows; f++) {
            const y = 2.2 + f * 3.05;
            if (y > b.h - 1.35) break;
            for (let c = 0; c < cc; c++) {
              const t = ((c + 0.5) / cc - 0.5) * (along - 2.4);
              let lx, lz, ry;
              if (side === 0) { lx = t; lz = b.d / 2 + 0.58; ry = 0; }
              else { lx = -t; lz = -b.d / 2 - 0.58; ry = Math.PI; }
              const px = b.x + lx * cosa + lz * sina;
              const pz = b.z - lx * sina + lz * cosa;
              const rot = (b.rotY || 0) + ry;
              paintList.push({ x: px, y: y - winH / 2 - 0.12, z: pz, ry: rot, sx: winW + 0.8, sy: 0.1, sz: 1.0 });
              metalList.push({ x: px + Math.sin(rot) * 0.45, y: y - winH / 2 + 0.34, z: pz + Math.cos(rot) * 0.45, ry: rot, sx: winW + 0.8, sy: 0.8, sz: 0.05 });
            }
          }
        }
      }
      // вход в подъезд
      if (b.style !== 'private') {
        const dx = b.w / 2 - 2.4;
        const px = b.x + dx * cosa + (b.d / 2 + 0.1) * sina;
        const pz = b.z - dx * sina + (b.d / 2 + 0.1) * cosa;
        doorList.push({ x: px, y: 1.45, z: pz, ry: b.rotY || 0, sx: 1.7, sy: 2.5, sz: 0.16 });
        metalList.push({ x: px + sina * 0.6, y: 3.05, z: pz + cosa * 0.6, ry: b.rotY || 0, sx: 2.8, sy: 0.16, sz: 1.7 });
      }
      // карниз и парапет — инстансом
      corniceList.push({ x: b.x, y: b.h + 0.1, z: b.z, ry: b.rotY || 0, sx: b.w + 0.55, sy: 0.32, sz: b.d + 0.55 });
      // надстройки на крыше (лифтовые будки, вентиляция) — инстансами
      if (b.style !== 'private' && rnd() < 0.55) {
        const n = 1 + Math.floor(rnd() * 2);
        for (let i = 0; i < n; i++) {
          const bw = 2 + rnd() * 3.5, bd = 2 + rnd() * 3, bh = 0.8 + rnd() * 1.6;
          const ox = (rnd() - 0.5) * (b.w - bw - 2), oz = (rnd() - 0.5) * (b.d - bd - 2);
          const px = b.x + ox * cosa + oz * sina, pz = b.z - ox * sina + oz * cosa;
          roofBoxList.push({ x: px, y: b.h + 0.16 + bh / 2, z: pz, ry: b.rotY || 0, sx: bw, sy: bh, sz: bd });
        }
      }
      this.colliders.push({ x: b.x, z: b.z, w: b.w, d: b.d, ry: b.rotY || 0, h: b.h, kind: 'building' });
    }

    // тела домов: по одному InstancedMesh на стиль
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    if (this._bodyBatches) {
      for (const [, batch] of this._bodyBatches) {
        if (!batch.list.length) continue;
        const im = instanced([boxGeo.clone()], batch.mat, batch.list, 200);
        im.name = 'bodies_' + batch.list.length;
        im.castShadow = true; im.receiveShadow = true;   // тела домов
        this.group.add(im);
      }
    }
    // общие инстансы окон/балконов
    const mkInst = (geo, mat, mats, cast) => {
      if (!mats.length) return null;
      const im = instanced([geo.clone()], mat, mats, 200);
      im.name = 'inst_' + mats.length;
      im.castShadow = false;
      this.group.add(im);
      return im;
    };
    mkInst(winGeo, this.materials.glass, darkFrame, false);
    this.litWindowMesh = mkInst(winGeo, this.materials.glassLit, litFrame, false);
    mkInst(boxGeo, this.materials.paint, paintList, true);
    mkInst(boxGeo, this.materials.darkMetal, metalList, true);
    mkInst(boxGeo, new THREE.MeshStandardMaterial({ color: 0x4a3324, roughness: 0.7 }), doorList, true);
    mkInst(boxGeo, this.materials.paint, corniceList, true);
    mkInst(boxGeo, this.materials.roof, roofBoxList, true);
    this.materials.glassLit.emissiveIntensity = 0;
    this.litWindows = litWindows;
  }

  /** Коробка магазина: витрина, дверь, вывеска, козырёк, интерьер за стеклом. */
  _shopBox(b) {
    const s = b.shop;
    const bodyMat = new THREE.MeshStandardMaterial({ map: facadeTexture('shop', 3), roughness: 0.8 });
    bodyMat.map = bodyMat.map.clone(); bodyMat.map.needsUpdate = true;
    bodyMat.map.repeat.set(2, 1.4);
    bodyMat.color = new THREE.Color(0xb9b4a8);
    const geo = new THREE.BoxGeometry(b.w, b.h, b.d);
    const roof = this.materials.roof;
    const mesh = new THREE.Mesh(geo, [bodyMat, bodyMat, roof, roof, bodyMat, bodyMat]);
    mesh.position.set(b.x, b.h / 2 + 0.16, b.z);
    mesh.rotation.y = b.rotY;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.shopId = s.id;
    this.group.add(mesh);
    b.mesh = mesh;
    this.shopMeshes.set(s.id, mesh);

    const door = shopDoor(s);
    const f = s.front;                       // единичный вектор «на улицу»
    const r = { x: -f.z, z: f.x };            // вправо по фасаду
    const ang = Math.atan2(f.x, f.z);         // поворот фасада
    // точка на фасаде: смещение вдоль r на t и наружу на out
    const at = (t, out) => ({ x: s.x + r.x * t + f.x * (s.d / 2 + out), z: s.z + r.z * t + f.z * (s.d / 2 + out) });

    // 1) витрина: стекло во всю ширину, с рамой
    const gw = Math.max(1.8, s.w - 2.0), gh = Math.min(2.3, s.h - 1.9);
    const p1 = at(0, 0.07);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(gw, gh, 0.06), new THREE.MeshPhysicalMaterial({
      color: 0xcfe2ea, roughness: 0.06, metalness: 0.2, transmission: 0.0, opacity: 0.42, transparent: true,
      envMapIntensity: 2.0, clearcoat: 1.0,
    }));
    glass.position.set(p1.x, 1.36 + gh / 2 - 0.1, p1.z);
    glass.rotation.y = ang;
    this.group.add(glass);
    s.glassMesh = glass;
    // интерьер за стеклом: тёплое пятно, витрина с товаром
    const inter = new THREE.Mesh(new THREE.PlaneGeometry(gw - 0.15, gh - 0.15), new THREE.MeshBasicMaterial({ color: 0xffe0b0 }));
    const p1b = at(0, 0.05);
    inter.position.set(p1b.x, 1.36 + gh / 2 - 0.1, p1b.z);
    inter.rotation.y = ang;
    inter.material.color.setHex(0x2a2820);
    this.group.add(inter);
    s.interiorMesh = inter;
    // рама витрины
    const frameMat = this.materials.darkMetal;
    const mkBar = (w, h, t, y) => {
      const pp = at(t, 0.09);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.09), frameMat);
      bar.position.set(pp.x, y, pp.z);
      bar.rotation.y = ang;
      this.group.add(bar);
    };
    mkBar(gw + 0.14, 0.1, 0, 1.31 + gh / 2 - 0.05);       // верх
    mkBar(gw + 0.14, 0.1, 0, 1.31 - gh / 2 + 0.02);       // низ
    mkBar(0.1, gh + 0.1, -gw / 2 - 0.02, 1.31 + gh / 2 - 0.05);
    mkBar(0.1, gh + 0.1, gw / 2 + 0.02, 1.31 + gh / 2 - 0.05);
    mkBar(0.07, gh, gw * 0.16, 1.31 + gh / 2 - 0.05);     // стойка-импост

    // 2) дверь (сбоку витрины)
    const doorT = -gw / 2 - 0.85;
    const pd = at(doorT, 0.1);
    const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(0.95, 2.15, 0.09), new THREE.MeshStandardMaterial({ color: 0x27333a, roughness: 0.45, metalness: 0.4 }));
    doorMesh.position.set(pd.x, 1.24, pd.z);
    doorMesh.rotation.y = ang;
    this.group.add(doorMesh);
    s.doorMesh = doorMesh;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 0.06), new THREE.MeshStandardMaterial({ color: 0xd8c48a, roughness: 0.3, metalness: 0.9 }));
    const ph = at(doorT + 0.34, 0.17);
    handle.position.set(ph.x, 1.2, ph.z);
    handle.rotation.y = ang;
    this.group.add(handle);

    // 3) вывеска
    const label = s.name.toUpperCase();
    const sw = Math.min(s.w - 0.6, 8.5);
    const sigGeo = new THREE.PlaneGeometry(sw, sw * 0.19);
    const sigTex = signTexture(label, {
      bg: '#101c24',
      fg: s.type === 'pharmacy' ? '#7bff9e' : s.type === 'cafe' ? '#ffcf7a' : s.type === 'clothes' ? '#ff8ae2' : '#ffd44d',
    });
    const sig = new THREE.Mesh(sigGeo, new THREE.MeshStandardMaterial({
      map: sigTex, emissive: 0xffffff, emissiveMap: sigTex, emissiveIntensity: 0.25, roughness: 0.55,
    }));
    const ps = at(0, 0.10);
    sig.position.set(ps.x, Math.min(b.h - 0.28, 3.15 + b.h * 0.06), ps.z);
    sig.rotation.y = ang;
    this.group.add(sig);
    s.signMesh = sig;
    // тёмная плашка под вывеску
    const plate = new THREE.Mesh(new THREE.BoxGeometry(sw + 0.2, sw * 0.19 + 0.16, 0.06), this.materials.darkMetal);
    const pp2 = at(0, 0.07);
    plate.position.set(pp2.x, Math.min(b.h - 0.28, 3.15 + b.h * 0.06), pp2.z);
    plate.rotation.y = ang;
    this.group.add(plate);

    // 4) козырёк над витриной с полосатым тентом
    const awnW = gw + 0.5;
    const awn = new THREE.Mesh(new THREE.BoxGeometry(awnW, 0.07, 1.35), new THREE.MeshStandardMaterial({
      color: s.type === 'cafe' ? 0x7c3b3b : 0x2f5a48, roughness: 0.85,
    }));
    const pa = at(0, 0.62);
    awn.position.set(pa.x, 2.72, pa.z);
    awn.rotation.y = ang; awn.rotation.x = -0.14;
    awn.castShadow = true;
    this.group.add(awn);
    // кронштейны
    for (const t of [-awnW / 2 + 0.2, awnW / 2 - 0.2]) {
      const pb = at(t, 0.1);
      const br = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.3, 1.2), this.materials.darkMetal);
      br.position.set(pb.x, 2.98, pb.z);
      br.rotation.y = ang; br.rotation.x = -0.16;
      this.group.add(br);
    }

    // 5) урна и коврик у входа
    const mat = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.9), new THREE.MeshStandardMaterial({ color: 0x4a4a44, roughness: 1 }));
    mat.rotation.x = -Math.PI / 2; mat.rotation.z = -ang;
    const pm = at(doorT, 1.3);
    mat.position.set(pm.x, 0.235, pm.z);
    this.group.add(mat);

    this.colliders.push({ x: s.x, z: s.z, w: s.w, d: s.d, ry: b.rotY, h: s.h, kind: 'shop', id: s.id });
  }

  _vegetation() {
    this.treeGroup = new THREE.Group(); this.group.add(this.treeGroup);
    const rnd = rng(777);
    const leafMat = settings.season === 'autumn' ? this.materials.leafAutumn : this.materials.leafMaple;
    const leafMat2 = settings.season === 'autumn' ? this.materials.leafAutumn : this.materials.leafBirch;
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.3, 3.6, 6);
    const crownGeo = new THREE.IcosahedronGeometry(1, 1);
    const coneGeo = new THREE.ConeGeometry(1, 2.6, 7);

    const maple = [], birch = [], spruce = [];
    for (const t of this.data.trees) {
      if (t.type === 'palm' || t.type === 'palm2') { this.palms.push(t); continue; }
      if (t.type === 'spruce') spruce.push(t); else if (t.type === 'birch') birch.push(t); else maple.push(t);
    }
    // стволы — инстансами
    const trunkAdd = (list, hScale) => {
      const tr = instanced([trunkGeo], this.materials.bark, list.map((t) => ({ x: t.x, y: 1.8 * t.scale * hScale, z: t.z, ry: t.rot, s: t.scale, sy: t.scale * hScale })), 160);
      this.treeGroup.add(tr);
    };
    trunkAdd(maple, 1); trunkAdd(birch, 1.2);
    // кроны — инстансами, по 3 шара на дерево
    const crownAdd = (list, mat, count, rmin, rmax, ybase) => {
      const recs = [];
      for (const t of list) {
        for (let i = 0; i < count; i++) {
          const r = (rmin + rnd() * (rmax - rmin)) * t.scale;
          const a = rnd() * 6.28, rr = rnd() * 1.4 * t.scale;
          const spread = rnd() * 2.2 * t.scale;
          const yy = (ybase + rnd() * 2.4) * t.scale;
          recs.push({
            x: t.x + Math.cos(a) * spread, y: yy, z: t.z + Math.sin(a) * spread,
            ry: rnd() * 6.28, s: r, sy: r * (0.62 + rnd() * 0.34),
          });
        }
      }
      if (recs.length) {
        const cols = recs.map(() => {
          const v = 0.52 + rnd() * 0.42;
          const warm = rnd() * 0.18;
          return [v * (0.86 + warm), v * (0.96 + warm * 0.4), v * 0.72];
        });
        this.treeGroup.add(instanced([crownGeo], mat, recs, 200, cols));
      }
    };
    crownAdd(maple, leafMat, 5, 1.5, 2.6, 4.2);
    crownAdd(birch, leafMat2, 4, 1.2, 2.1, 5.0);
    // ели
    if (spruce.length) {
      const recs = [];
      for (const t of spruce) {
        for (let i = 0; i < 3; i++) {
          recs.push({ x: t.x, y: (1.5 + i * 1.6) * t.scale, z: t.z, ry: rnd() * 6.28, sx: (2.0 - i * 0.45) * t.scale, sy: 1.5 * t.scale, sz: (2.0 - i * 0.45) * t.scale });
        }
      }
      this.treeGroup.add(instanced([coneGeo], this.materials.bambooLeaf, recs, 160));
    }
    this._bamboo();
    this._palms();
    this._shrubs();
    this._grassTufts();
    // список чанков растительности для дистанционного отсечения
    this.treeChunks = [];
    for (const child of this.treeGroup.children) {
      if (child.isGroup) this.treeChunks.push(...child.children);
      else this.treeChunks.push(child);
    }
  }

  /** Кустарники и живые изгороди: 2-3 низких шара + стриженая «стена» у дорог. */
  _shrubs() {
    const list = this.data.shrubs || [];
    if (!list.length) return;
    const bushGeo = new THREE.IcosahedronGeometry(1, 1);
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x3f7a33, roughness: 0.92 });
    const hedgeMat = new THREE.MeshStandardMaterial({ color: 0x2f6b2a, roughness: 0.95 });
    const bushes = [], hedges = [];
    const rnd = rng(4242);
    for (const sh of list) {
      if (sh.kind === 'hedge') {
        hedges.push({ x: sh.x, y: 0.52 * sh.s, z: sh.z, ry: sh.ry, sx: 1.5 + sh.s * 1.1, sy: 0.9 * sh.s, sz: 0.75 });
      } else {
        const n = 1 + Math.floor(rnd() * 2);
        for (let i = 0; i < n; i++) {
          const r = (0.42 + rnd() * 0.5) * sh.s;
          bushes.push({
            x: sh.x + (rnd() - 0.5) * sh.s * 1.1, y: r * 0.72, z: sh.z + (rnd() - 0.5) * sh.s * 1.1,
            ry: rnd() * 6.28, sx: r * 1.15, sy: r * 0.82, sz: r * 1.15,
          });
        }
      }
    }
    if (bushes.length) {
      const cols = bushes.map(() => {
        const v = 0.55 + rnd() * 0.4;
        return [v * 0.72, v * 0.95, v * 0.5];
      });
      const im = instanced([bushGeo], bushMat, bushes, 200, cols);
      im.receiveShadow = true;
      this.group.add(im);
      this.shrubMeshes = this.shrubMeshes || [];
      this.shrubMeshes.push(im);
    }
    if (hedges.length) {
      const boxGeo = new THREE.BoxGeometry(1, 1, 1);
      const im = instanced([boxGeo], hedgeMat, hedges, 200);
      im.receiveShadow = true;
      this.group.add(im);
      this.shrubMeshes = this.shrubMeshes || [];
      this.shrubMeshes.push(im);
    }
  }

  _palms() {
    if (!this.palms.length) return;
    const trunkGeo = new THREE.CylinderGeometry(0.11, 0.24, 1, 7, 4);
    const frondGeo = new THREE.PlaneGeometry(3.4, 3.0, 1, 1);
    const rnd = rng(99);
    const frondMat = new THREE.MeshStandardMaterial({
      map: palmFrondTexture(), transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.85,
    });
    const trunkMat = new THREE.MeshStandardMaterial({ map: barkTexture(), color: 0xc8b393, roughness: 0.92 });
    const trunks = [], fronds = [];
    for (const t of this.palms) {
      const h = 7.2 * t.scale;
      trunks.push({ x: t.x, y: h / 2, z: t.z, rz: (rnd() - 0.5) * 0.12, sx: t.scale, sy: h, sz: t.scale });
      // крона: 9 вееров, наклонённых вниз
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + rnd() * 0.3;
        const r = 1.15 * t.scale;
        fronds.push({
          x: t.x + Math.cos(a) * r, y: h - 0.15 + rnd() * 0.3, z: t.z + Math.sin(a) * r,
          rx: -0.95 - rnd() * 0.35, ry: a + Math.PI / 2, rz: 0,
          sx: t.scale * 1.0, sy: t.scale * 1.0, sz: t.scale * 1.0,
        });
      }
      // кокосы
    }
    this.treeGroup.add(instanced([trunkGeo], trunkMat, trunks));
    const fm = instanced([frondGeo], frondMat, fronds);
    fm.castShadow = false;
    this.treeGroup.add(fm);
  }

  _bamboo() {
    const poleGeo = new THREE.CylinderGeometry(0.075, 0.11, 1, 7, 4);
    // листва бамбука: горизонтальные «веера» из плоскостей с альфа-текстурой пучка листьев
    const leafGeo = new THREE.PlaneGeometry(1.6, 1.6);
    const stalkMat = new THREE.MeshStandardMaterial({ color: 0x7d9a44, roughness: 0.62 });
    const leafMat = new THREE.MeshStandardMaterial({
      map: bambooLeafTexture(), transparent: true, alphaTest: 0.35, side: THREE.DoubleSide,
      roughness: 0.78, depthWrite: true,
    });
    const rnd = rng(31337);
    this.bambooGroup = new THREE.Group(); this.group.add(this.bambooGroup);
    const poles = [], leaves = [];
    const col = new THREE.Color();
    for (const b of this.data.bamboo) {
      const cluster = b.kind === 'cluster' ? 4 : 1;
      for (let c = 0; c < cluster; c++) {
        const h = (7 + rnd() * 8) * b.scale;
        const x = b.x + (rnd() - 0.5) * 1.6, z = b.z + (rnd() - 0.5) * 1.6;
        poles.push({ x, y: h / 2, z, rx: (rnd() - 0.5) * 0.05, rz: (rnd() - 0.5) * 0.05, ry: rnd() * 6.28, sx: 1, sy: h, sz: 1, tint: 0.75 + rnd() * 0.3 });
        // листва: несколько ярусов по высоте
        const levels = 3 + Math.floor(rnd() * 3);
        for (let k = 0; k < levels; k++) {
          const yy = h * (0.42 + 0.58 * (k / levels)) - rnd() * 0.5;
          const n = 2 + Math.floor(rnd() * 3);
          for (let j = 0; j < n; j++) {
            const a = rnd() * 6.28;
            const rr = 0.25 + rnd() * 1.6;
            leaves.push({
              x: x + Math.cos(a) * rr, y: yy, z: z + Math.sin(a) * rr,
              rx: -0.35 + (rnd() - 0.5) * 0.7, ry: a + rnd(), rz: (rnd() - 0.5) * 0.5,
              s: (0.8 + rnd() * 0.9) * b.scale,
            });
          }
        }
      }
    }
    if (poles.length) {
      const pm = instanced([poleGeo], stalkMat, poles);
      // у каждого ствола свой оттенок
      const c2 = new THREE.Color();
      for (let i = 0; i < poles.length; i++) { const t = poles[i].tint; c2.setRGB(t * 0.95, t, t * 0.7); pm.setColorAt(i, c2); }
      if (pm.instanceColor) pm.instanceColor.needsUpdate = true;
      this.bambooGroup.add(pm);
    }
    if (leaves.length) {
      const lm = instanced([leafGeo], leafMat, leaves);
      lm.castShadow = false;
      this.bambooGroup.add(lm);
    }
    this.bambooLeafMat = leafMat;
    // земля в бамбуковой роще — плотный ковёр из опавших листьев (пятно)
    const floorGeo = new THREE.CircleGeometry(PARK_BAMBOO.r * 0.97, 40);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x6a7a3a, roughness: 0.95, transparent: true, opacity: 0.35 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.set(PARK_BAMBOO.cx, 0.232, PARK_BAMBOO.cz);
    floor.receiveShadow = true;
    this.group.add(floor);
  }

  _grassTufts() {
    // Крупные пучки травы по краям газонов дают «пушистость» у земли помимо шейдера травы
    const tuftGeo = new THREE.ConeGeometry(0.35, 0.75, 4, 1, true);
    const mat = new THREE.MeshStandardMaterial({ color: 0x6a8d3e, roughness: 0.9, side: THREE.DoubleSide });
    const inst = new THREE.InstancedMesh(tuftGeo, mat, 2600);
    const dummy = new THREE.Object3D();
    const rnd = rng(555);
    let n = 0;
    for (let i = 0; i < 6000 && n < 2600; i++) {
      const x = (rnd() - 0.5) * WORLD_SIZE * 0.95, z = (rnd() - 0.5) * (WORLD_SIZE * 0.9);
      if (roadAt(x, z) || isSidewalk(x, z) || isWater(x, z) || z > RIVER.z0 - 4) continue;
      if (this.solidAt && this.solidAt(x, z)) continue;
      dummy.position.set(x, 0.4, z);
      dummy.rotation.set(0, rnd() * 6.28, 0);
      const s = 0.7 + rnd() * 1.5;
      dummy.scale.set(s, s * (0.7 + rnd() * 0.8), s);
      dummy.updateMatrix();
      inst.setMatrixAt(n++, dummy.matrix);
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    this.tuftMesh = inst;
    this.group.add(inst);
  }

  _streetFurniture() {
    const rnd = rng(1212);
    // фонари: столб + лампа
    if (this.data.lamps.length) {
      const poleGeo = new THREE.CylinderGeometry(0.07, 0.12, 6.4, 6);
      this.group.add(instanced([poleGeo], this.materials.darkMetal, this.data.lamps.map((l) => ({ x: l.x, y: 3.2, z: l.z, ry: l.rot }))));
      const headGeo = new THREE.BoxGeometry(0.46, 0.16, 0.85);
      this.lampMat = new THREE.MeshStandardMaterial({ color: 0x3a3f42, emissive: 0xffd9a0, emissiveIntensity: 0.0, roughness: 0.5 });
      this.lampHeads = instanced([headGeo], this.lampMat, this.data.lamps.map((l) => ({
        x: l.x + Math.sin(l.rot) * 0.55, y: 6.35, z: l.z + Math.cos(l.rot) * 0.55, ry: l.rot, sx: 1, sy: 1, sz: 1,
      })));
      this.lampHeads.castShadow = false;
      this.group.add(this.lampHeads);
      // хомут-кронштейн
      const arm = new THREE.BoxGeometry(0.06, 0.06, 1.1);
      this.group.add(instanced([arm], this.materials.darkMetal, this.data.lamps.map((l) => ({ x: l.x + Math.sin(l.rot) * 0.28, y: 6.32, z: l.z + Math.cos(l.rot) * 0.28, ry: l.rot }))));
      for (const l of this.data.lamps) this.colliders.push({ x: l.x, z: l.z, w: 0.35, d: 0.35, ry: 0, h: 6.4, kind: 'lamp' });
    }
    // скамейки: дерево и металл
    if (this.data.benches.length) {
      const woodRecs = [], metalRecs = [];
      for (const b of this.data.benches) {
        const c = Math.cos(b.rot), sn = Math.sin(b.rot);
        woodRecs.push({ x: b.x, y: 0.65, z: b.z, ry: b.rot, sx: 1.9, sy: 0.1, sz: 0.5 });
        woodRecs.push({ x: b.x - sn * 0.22, y: 0.98, z: b.z - c * 0.22, ry: b.rot, rx: -0.12, sx: 1.9, sy: 0.5, sz: 0.08 });
        for (const s2 of [-1, 1]) metalRecs.push({ x: b.x + c * s2 * 0.8, y: 0.42, z: b.z - sn * s2 * 0.8, ry: b.rot, sx: 0.08, sy: 0.45, sz: 0.45 });
      }
      const bg = new THREE.BoxGeometry(1, 1, 1);
      this.group.add(instanced([bg], new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.85 }), woodRecs));
      this.group.add(instanced([bg], this.materials.darkMetal, metalRecs));
    }
    // урны
    if (this.data.bins.length) {
      const binGeo = new THREE.CylinderGeometry(0.26, 0.22, 0.8, 8);
      this.group.add(instanced([binGeo], new THREE.MeshStandardMaterial({ color: 0x2f3a33, roughness: 0.7, metalness: 0.3 }), this.data.bins.map((b) => ({ x: b.x, y: 0.6, z: b.z }))));
    }
    // дорожные знаки
    const postGeo = new THREE.CylinderGeometry(0.045, 0.045, 2.6, 5);
    const signGeo = new THREE.CircleGeometry(0.32, 16);
    const posts = [], signsW = [], signsR = [];
    for (const r of ROADS) {
      for (let t = -HALF + 80; t < HALF - 80; t += 96) {
        if (rnd() < 0.5) continue;
        const x = r.axis === 'z' ? r.at + r.width / 2 + 0.8 : t;
        const z = r.axis === 'z' ? t : r.at + r.width / 2 + 0.8;
        posts.push({ x, y: 1.3, z });
        const rec = { x, y: 2.35, z, ry: r.axis === 'z' ? 0 : Math.PI / 2 };
        (rnd() < 0.3 ? signsR : signsW).push(rec);
      }
    }
    if (posts.length) {
      this.group.add(instanced([postGeo], this.materials.signPost, posts));
      if (signsW.length) this.group.add(instanced([signGeo], new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, side: THREE.DoubleSide }), signsW));
      if (signsR.length) this.group.add(instanced([signGeo], new THREE.MeshStandardMaterial({ color: 0xd23a3a, roughness: 0.5, side: THREE.DoubleSide }), signsR));
    }
  }

  _xmas() {
    // Новогодняя ёлка на площади + украшения (зимой — с гирляндой)
    const { x, z } = this.data.xmas;
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.7, 3, 8), this.materials.bark);
    trunk.position.y = 1.5; g.add(trunk);
    const coneMat = new THREE.MeshStandardMaterial({ color: 0x1f4a2a, roughness: 0.85 });
    for (let i = 0; i < 5; i++) {
      const c = new THREE.Mesh(new THREE.ConeGeometry(5 - i * 0.85, 4.2, 10), coneMat);
      c.position.y = 3.4 + i * 2.5;
      c.castShadow = true;
      g.add(c);
    }
    // гирлянда: точки-лампочки по спирали
    const bulbs = [];
    const cols = [0xff4040, 0xffd23f, 0x4bff8a, 0x4bb3ff, 0xff7ae0];
    for (let i = 0; i < 260; i++) {
      const t = i / 260;
      const a = t * Math.PI * 16;
      const rr = (4.6 - t * 4.0);
      const y = 3.2 + t * 12.2;
      bulbs.push({ x: Math.cos(a) * rr, y, z: Math.sin(a) * rr, c: cols[i % cols.length] });
    }
    const bulbGeo = new THREE.SphereGeometry(0.11, 6, 5);
    const bulbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.0, roughness: 0.35 });
    const bm = new THREE.InstancedMesh(bulbGeo, bulbMat, bulbs.length);
    const dmy = new THREE.Object3D();
    const cTmp = new THREE.Color();
    bulbs.forEach((b, i) => {
      dmy.position.set(b.x, b.y, b.z);
      dmy.rotation.set(0, 0, 0);
      dmy.scale.setScalar(1);
      dmy.updateMatrix();
      bm.setMatrixAt(i, dmy.matrix);
      bm.setColorAt(i, cTmp.setHex(b.c));
    });
    bm.instanceMatrix.needsUpdate = true;
    if (bm.instanceColor) bm.instanceColor.needsUpdate = true;
    g.add(bm);
    this.xmasBulbMat = bulbMat;
    this.xmasBulbs = [bm];
    // звезда
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.8), new THREE.MeshStandardMaterial({ color: 0xffe27a, emissive: 0xffd24a, emissiveIntensity: 0.0 }));
    star.position.y = 16.4; g.add(star);
    this.xmasStar = star;
    g.position.set(x, 0.22, z);
    this.group.add(g);
    // ограждение вокруг ёлки
    const fenceMat = new THREE.MeshStandardMaterial({ color: 0x8a2727, roughness: 0.6, metalness: 0.3 });
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * 6.28;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 5), fenceMat);
      post.position.set(x + Math.cos(a) * 7, 0.7, z + Math.sin(a) * 7);
      this.group.add(post);
    }
    this.colliders.push({ x, z, w: 3, d: 3, ry: 0, h: 16, kind: 'xmas' });
  }

  _shopDetails() {
    // вывески и «открыто/закрыто»
    for (const s of this.data.shops) {
      // урна у входа
      const d = shopDoor(s);
      const bin = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.2, 0.75, 8), new THREE.MeshStandardMaterial({ color: 0x39443c, roughness: 0.7 }));
      bin.position.set(d.x + (s.d / 2) * 0.4, 0.58, d.z + 0.5);
      bin.castShadow = true;
      this.group.add(bin);
    }
  }

  _buildSolidGrid() {
    // грубая сетка 4 м: занята ли клетка домом/магазином (для травы и деревьев)
    const N = Math.ceil(WORLD_SIZE / 4) + 2;
    this.solidGrid = new Uint8Array(N * N);
    this.gridN = N;
    for (const c of this.colliders) {
      if (c.kind !== 'building' && c.kind !== 'shop') continue;
      const r = Math.max(c.w, c.d) / 2 + 1.2;
      for (let z = -r; z <= r; z += 2) for (let x = -r; x <= r; x += 2) {
        const px = c.x + x, pz = c.z + z;
        const ix = Math.floor((px + HALF) / 4), iz = Math.floor((pz + HALF) / 4);
        if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
        this.solidGrid[iz * N + ix] = 1;
      }
    }
  }
  solidAt(x, z) {
    if (!this.solidGrid) return false;
    const ix = Math.floor((x + HALF) / 4), iz = Math.floor((z + HALF) / 4);
    if (ix < 0 || iz < 0 || ix >= this.gridN || iz >= this.gridN) return false;
    return this.solidGrid[iz * this.gridN + ix] === 1;
  }

  /** Дальние чанки деревьев не рисуем — экономия без видимой разницы (туман). */
  cullVegetation(camera) {
    if (!this.treeChunks) return;
    const cx = camera.position.x, cz = camera.position.z;
    for (const c of this.treeChunks) {
      if (!c || !c.geometry) continue;
      if (!c.geometry.boundingSphere) c.geometry.computeBoundingSphere();
      const bs = c.geometry.boundingSphere;
      if (!bs) continue;
      const d = Math.hypot(bs.center.x - cx, bs.center.z - cz) - bs.radius;
      c.visible = d < 420;
      c.castShadow = d < 90;   // тень бросают только ближние — теневой проход дешевеет в разы
    }
  }

  setNight(n) {
    const lit = Math.max(0, Math.min(1, n * 1.4 - 0.1));
    this._night = lit;
    if (this.materials.glassLit) this.materials.glassLit.emissiveIntensity = lit * 1.7;
    if (this.lampMat) this.lampMat.emissiveIntensity = lit * 2.4;
    if (this.xmasBulbMat) this.xmasBulbMat.emissiveIntensity = lit * 2.6 + 0.03;
    if (this.xmasStar) this.xmasStar.material.emissiveIntensity = lit * 2.2 + 0.02;
    for (const sh of this.data.shops) {
      if (sh.signMesh) sh.signMesh.material.emissiveIntensity = 0.2 + lit * 1.9;
      if (sh.glassMesh) { sh.glassMesh.material.emissive = sh.glassMesh.material.emissive || new THREE.Color(); sh.glassMesh.material.emissive.setRGB(0.26 * lit, 0.2 * lit, 0.11 * lit); }
    }
    if (this.puddleMat) this.puddleMat.opacity = Math.min(0.9, (this._wet || 0) * 0.95);
  }

  setWet(w) { this._wet = w; if (this.puddleMat) this.puddleMat.opacity = Math.min(0.92, w * 0.95); }

  statistics() {
    const d = this.data;
    return {
      buildings: d.buildings.filter((b) => b.kind === 'house').length,
      shops: d.shops.length,
      trees: d.trees.length + d.bamboo.length,
      bamboo: d.bamboo.length,
    };
  }
}
