/* Детерминированный генератор города: улицы, кварталы, дома, магазины, парки, вода.
   Самара — район Стара-Загора / Ново-Вокзальная, но всё строится кодом.
   Ось X — восток, Z — юг. Размер мира 1600 × 1600 м, край — ±800. */
export const WORLD_SIZE = 1600;
export const HALF = WORLD_SIZE / 2;

export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function noise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
export function fbm(x, y, oct = 4, seed = 0) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * noise2(x * f, y * f, seed + i * 17); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/* ---------- сетка улиц ---------- */
export const ROADS = [
  { axis: 'z', at: 0, width: 26, name: 'проспект Карла Маркса', main: true },
  { axis: 'z', at: -260, width: 20, name: 'улица Стара-Загора', main: true },
  { axis: 'z', at: 260, width: 20, name: 'Ново-Вокзальная улица' },
  { axis: 'z', at: -520, width: 16, name: 'улица Фадеева' },
  { axis: 'z', at: 520, width: 16, name: 'улица Победы' },
  { axis: 'x', at: 0, width: 22, name: 'улица Демократическая', main: true },
  { axis: 'x', at: -260, width: 20, name: 'улица Ново-Садовая' },
  { axis: 'x', at: 260, width: 20, name: 'улица Советской Армии' },
  { axis: 'x', at: -520, width: 16, name: 'улица Тухачевского' },
  { axis: 'x', at: 520, width: 16, name: 'набережная Волги' },
];
export const RIVER = { z0: 560, z1: 800, name: 'Волга', level: -0.35 };
export const LAKE = { cx: -655, cz: -655, rx: 128, rz: 98, name: 'озеро в парке Дружбы' };
export const PARK_GROVE = { cx: 665, cz: -665, r: 225, name: 'Берёзовая роща' };
export const PARK_FRIENDS = { cx: -655, cz: -655, r: 240, name: 'Парк Дружбы' };
export const SQUARE = { cx: 78, cz: 78, r: 52, name: 'Площадь Новогодняя' };

export function roadAt(x, z) {
  for (const r of ROADS) {
    const d = r.axis === 'z' ? Math.abs(x - r.at) : Math.abs(z - r.at);
    if (d < r.width / 2) return r;
  }
  return null;
}
export function inPark(x, z) {
  if (Math.hypot(x - PARK_GROVE.cx, z - PARK_GROVE.cz) < PARK_GROVE.r) return PARK_GROVE;
  if (Math.hypot(x - PARK_FRIENDS.cx, z - PARK_FRIENDS.cz) < PARK_FRIENDS.r) return PARK_FRIENDS;
  if (Math.hypot(x - SQUARE.cx, z - SQUARE.cz) < SQUARE.r) return SQUARE;
  return null;
}
export function lakeDist(x, z) {
  const dx = (x - LAKE.cx) / LAKE.rx, dz = (z - LAKE.cz) / LAKE.rz;
  const r = Math.sqrt(dx * dx + dz * dz);
  const wob = (fbm(x * 0.006 + 11, z * 0.006 - 7, 3, 7) - 0.5) * 0.22;
  return r + wob;
}
export function isWater(x, z) {
  if (z > RIVER.z0) return true;
  return lakeDist(x, z) < 1.0;
}
export function isFreeGround(x, z, margin = 0) {
  if (Math.abs(x) > HALF - 6 || Math.abs(z) > HALF - 6) return false;
  if (roadAt(x, z)) return false;
  if (inPark(x, z)) return false;
  if (lakeDist(x, z) < 1.06 + margin / 200) return false;
  if (z > RIVER.z0 - 10 - margin) return false;
  return true;
}
/** высота земли: дорога 0.02, тротуар 0.2, газон 0.16 с мелкими неровностями */
export function isSidewalk(x, z) {
  for (const r of ROADS) {
    const d = r.axis === 'z' ? Math.abs(x - r.at) : Math.abs(z - r.at);
    if (d < r.width / 2 + 2.6) return true;
  }
  return false;
}

/* ---------- магазины ---------- */
export const SHOP_TYPES = [
  { id: 'grocery', name: 'Продукты «У дома»', size: [9, 7], price: 420000, rent: 38000, area: 63, stock: 'food' },
  { id: 'kiosk', name: 'Киоск «Пресса»', size: [3.4, 2.6], price: 95000, rent: 8500, area: 9, stock: 'small' },
  { id: 'bakery', name: 'Пекарня', size: [7, 6], price: 380000, rent: 32000, area: 42, stock: 'food' },
  { id: 'flowers', name: 'Цветы', size: [6, 5], price: 260000, rent: 21000, area: 30, stock: 'small' },
  { id: 'electronics', name: 'Техника', size: [10, 8], price: 720000, rent: 64000, area: 80, stock: 'tech' },
  { id: 'clothes', name: 'Одежда', size: [9, 8], price: 610000, rent: 52000, area: 72, stock: 'clothes' },
  { id: 'cafe', name: 'Кофейня', size: [8, 6.5], price: 480000, rent: 41000, area: 52, stock: 'cafe' },
  { id: 'pharmacy', name: 'Аптека', size: [7, 6], price: 400000, rent: 34000, area: 42, stock: 'small' },
  { id: 'shaurma', name: 'Шаурма', size: [5, 4.4], price: 210000, rent: 17500, area: 22, stock: 'food' },
  { id: 'bookstore', name: 'Книги', size: [8, 7], price: 350000, rent: 30000, area: 56, stock: 'small' },
  { id: 'sport', name: 'Спорттовары', size: [10, 8], price: 690000, rent: 60000, area: 80, stock: 'tech' },
  { id: 'toys', name: 'Игрушки', size: [7, 6], price: 330000, rent: 28000, area: 42, stock: 'small' },
];

export function generateCity() {
  const rand = rng(20241115);
  const buildings = [], shops = [], trees = [], lamps = [], benches = [], bins = [], signs = [], paths = [], shrubs = [];
  let bid = 0, sid = 0;
  const shopSpots = [];   // заполняется ниже, нужен для проверок озеленения

  /* --- дома в кварталах --- */
  const coords = [-HALF + 10, -520, -260, 0, 260, 520, RIVER.z0 - 6];
  for (let i = 0; i < coords.length - 1; i++) {
    for (let j = 0; j < coords.length - 1; j++) {
      const x0 = coords[i], x1 = coords[i + 1], z0 = coords[j], z1 = coords[j + 1];
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      if (inPark(cx, cz)) continue;
      if (lakeDist(cx, cz) < 1.2) continue;
      const bw = x1 - x0, bh = z1 - z0;
      if (bw < 60 || bh < 60) continue;
      for (let side = 0; side < 4; side++) {
        const horiz = side < 2;           // 0: север, 1: юг, 2: запад, 3: восток
        const along = horiz ? bw : bh;
        const roadInset = 14;
        let pos = roadInset + 4;
        let guard = 0;
        while (pos < along - 34 && guard++ < 40) {
          const style = pickStyle(rand);
          const w = style === 'private' ? 11 + rand() * 5 : (style === 'office' ? 26 + rand() * 16 : 20 + rand() * 24);
          const d = style === 'private' ? 11 + rand() * 4 : 13 + rand() * 9;
          const floors = style === 'private' ? 2 : (style.includes('9') ? 9 + Math.floor(rand() * 4) : 5 + Math.floor(rand() * 2));
          const h = floors * 3.05 + 0.8;
          let bx, bz, rotY;
          if (horiz) {
            bx = x0 + pos + w / 2;
            bz = side === 0 ? z0 + roadInset + d / 2 : z1 - roadInset - d / 2;
            rotY = side === 0 ? 0 : Math.PI;
          } else {
            bx = side === 2 ? x0 + roadInset + d / 2 : x1 - roadInset - d / 2;
            bz = z0 + pos + w / 2;
            rotY = side === 2 ? Math.PI / 2 : -Math.PI / 2;
          }
          const ok = isFreeGround(bx, bz, 20) && !overlapBox(buildings, bx, bz, Math.max(w, d) + 3);
          if (ok) {
            buildings.push({ id: 'b' + (bid++), x: bx, z: bz, w, d, h, rotY, style, kind: 'house', floors, seed: Math.floor(rand() * 1e6) });
          } else {
            pos += w + 6;
            continue;
          }
          pos += w + 5 + rand() * 8;
        }
      }
      // двор: деревья, детская площадка-пятно, гаражи
      for (let k = 0; k < 10; k++) {
        const tx = x0 + 40 + rand() * (bw - 80), tz = z0 + 40 + rand() * (bh - 80);
        if (isFreeGround(tx, tz, 4) && !overlapBox(buildings, tx, tz, 8) && lakeDist(tx, tz) > 1.15) {
          trees.push({ x: tx, z: tz, type: pickTree(rand), scale: 0.8 + rand() * 0.6, rot: rand() * 6.28 });
        }
      }
      // озеленение пустырей: ряды деревьев по свободным местам квартала,
      // чтобы город не выглядел полем между улицами
      const greenSpots = Math.round((bw * bh) / 900);   // ~1 дерево на 30×30 м свободной земли
      for (let k = 0; k < greenSpots; k++) {
        const tx = x0 + 20 + rand() * (bw - 40), tz = z0 + 20 + rand() * (bh - 40);
        if (!isFreeGround(tx, tz, 3.4)) continue;
        if (overlapBox(buildings, tx, tz, 6.5)) continue;
        if (shopSpots.some((sp) => Math.hypot(sp.x - tx, sp.z - tz) < 11)) continue;
        if (lakeDist(tx, tz) < 1.12) continue;
        trees.push({ x: tx, z: tz, type: pickTree(rand), scale: 0.7 + rand() * 0.85, rot: rand() * 6.28 });
      }
      // аллеи вдоль внутренних проездов квартала — ровные ряды, читается как сквер
      for (const [ax, az] of [[x0 + 26, z0 + 26], [x1 - 26, z1 - 26]]) {
        const horiz = rand() < 0.5;
        const len = horiz ? bw - 52 : bh - 52;
        const step = 13 + rand() * 5;
        for (let t = 0; t < len; t += step) {
          const tx = horiz ? ax + t : ax + (rand() - 0.5) * 3;
          const tz = horiz ? az + (rand() - 0.5) * 3 : az + t;
          if (!isFreeGround(tx, tz, 3)) continue;
          if (overlapBox(buildings, tx, tz, 6)) continue;
          if (shopSpots.some((sp) => Math.hypot(sp.x - tx, sp.z - tz) < 10)) continue;
          trees.push({ x: tx, z: tz, type: rand() < 0.5 ? 'linden' : pickTree(rand), scale: 0.85 + rand() * 0.5, rot: rand() * 6.28 });
        }
      }
    }
  }

  /* --- кустарники и живые изгороди: заполняют пустыри и обрамляют газоны --- */
  for (let k = 0; k < 4200; k++) {
    const x = (rand() * 2 - 1) * (HALF - 40);
    const z = (rand() * 2 - 1) * (HALF - 40);
    if (!isFreeGround(x, z, 2)) continue;
    if (lakeDist(x, z) < 1.06) continue;
    // плотнее у дорог — там живая изгородь
    let nearRoad = false;
    for (const r of ROADS) {
      const d = r.axis === 'z' ? Math.abs(x - r.at) : Math.abs(z - r.at);
      if (d > r.width / 2 + 2.6 && d < r.width / 2 + 9) nearRoad = true;
    }
    const patch = fbm(x / 42, z / 42, 3, 71);
    if (!nearRoad && patch < 0.52 && rand() < 0.75) continue;
    if (shops.some((sp) => Math.hypot(sp.x - x, sp.z - z) < 7)) continue;
    shrubs.push({ x, z, s: 0.6 + rand() * 0.9, ry: rand() * 6.28, kind: rand() < 0.22 ? 'hedge' : 'bush' });
  }

  /* --- лесополоса по окраинам: плотный лес за пределами застройки --- */
  const forestBelt = (x, z) => (Math.max(Math.abs(x), Math.abs(z)) > 560 && Math.max(Math.abs(x), Math.abs(z)) < HALF - 20);
  for (let k = 0; k < 5200; k++) {
    const x = (rand() * 2 - 1) * (HALF - 30);
    const z = (rand() * 2 - 1) * (HALF - 30);
    if (!forestBelt(x, z)) continue;
    if (!isFreeGround(x, z, 4)) continue;
    if (lakeDist(x, z) < 1.2) continue;
    // внутри лесополосы — сгущение к краю
    const edge = Math.max(Math.abs(x), Math.abs(z));
    if (rand() > 0.25 + (edge - 560) / 700) continue;
    trees.push({ x, z, type: rand() < 0.25 ? 'spruce' : pickTree(rand), scale: 0.8 + rand() * 0.9, rot: rand() * 6.28 });
  }

  /* --- магазины вдоль улиц (отдельные павильоны), вход с тротуара --- */
  for (const r of ROADS) {
    const step = 34;
    for (let t = -HALF + 70; t < HALF - 70; t += step) {
      for (const side of [-1, 1]) {
        if (rand() < 0.55) continue;
        const offRoad = r.width / 2 + 11.5;
        const x = r.axis === 'z' ? r.at + side * offRoad : t;
        const z = r.axis === 'z' ? t : r.at + side * offRoad;
        if (Math.abs(x) > HALF - 30 || Math.abs(z) > HALF - 30) continue;
        if (!isFreeGround(x, z, 8)) continue;
        if (overlapBox(buildings, x, z, 13)) continue;
        if (shopSpots.some((s) => Math.hypot(s.x - x, s.z - z) < 26)) continue;
        const type = SHOP_TYPES[Math.floor(rand() * SHOP_TYPES.length)];
        const front = r.axis === 'z' ? { x: -side, z: 0 } : { x: 0, z: -side };
        const rotY = Math.atan2(front.x, front.z);
        const w = type.size[0], d = type.size[1];
        // ставим центр отступая от тротуара
        const cxo = x + front.x * (d / 2 + 2.0), czo = z + front.z * (d / 2 + 2.0);
        if (!isFreeGround(cxo, czo, 6)) continue;
        if (overlapBox(buildings, cxo, czo, Math.max(w, d) + 3)) continue;
        const shop = {
          id: 's' + (sid++), type: type.id, name: type.name, price: type.price, rent: type.rent, area: type.area, stock: type.stock,
          x: cxo, z: czo, w, d, h: type.id === 'kiosk' ? 3.0 : 4.4, rotY, front, kind: 'shop',
          owned: false, rented: false, open: false, stockLevel: 0, furniture: [], income: 0, served: 0,
          district: districtName(cxo, czo), seed: 1000 + sid,
        };
        // дом вокруг магазина не должен пересекаться
        shops.push(shop); shopSpots.push({ x: cxo, z: czo });
        buildings.push({ id: shop.id, x: cxo, z: czo, w, d, h: shop.h, rotY, style: 'shop', kind: 'shop', shop, front, seed: shop.seed });
      }
    }
  }

  /* --- Берёзовая роща: светлый берёзовый лес, дорожки, скамейки --- */
  for (let i = 0; i < 760; i++) {
    const a = rand() * Math.PI * 2, rr = Math.sqrt(rand()) * PARK_GROVE.r * 0.97;
    const x = PARK_GROVE.cx + Math.cos(a) * rr, z = PARK_GROVE.cz + Math.sin(a) * rr;
    if (roadAt(x, z) || lakeDist(x, z) < 1.05) continue;
    // у дорожек и на опушке берёзы реже, в глубине — плотнее
    const edge = rr / PARK_GROVE.r;
    if (rand() > 0.35 + edge * 0.55) continue;
    const type = rand() < 0.72 ? 'birch' : (rand() < 0.5 ? 'maple' : 'spruce');
    trees.push({ x, z, type, scale: 0.85 + rand() * 0.55, rot: rand() * 6.28 });
  }
  // кольцевая аллея и радиальные дорожки
  const ring = [];
  for (let i = 0; i < 40; i++) {
    const a0 = (i / 40) * Math.PI * 2, a1 = ((i + 1) / 40) * Math.PI * 2;
    ring.push({
      x1: PARK_GROVE.cx + Math.cos(a0) * PARK_GROVE.r * 0.62, z1: PARK_GROVE.cz + Math.sin(a0) * PARK_GROVE.r * 0.62,
      x2: PARK_GROVE.cx + Math.cos(a1) * PARK_GROVE.r * 0.62, z2: PARK_GROVE.cz + Math.sin(a1) * PARK_GROVE.r * 0.62, w: 3.0,
    });
  }
  paths.push(...ring);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4;
    paths.push({ x1: PARK_GROVE.cx, z1: PARK_GROVE.cz, x2: PARK_GROVE.cx + Math.cos(a) * PARK_GROVE.r * 0.9, z2: PARK_GROVE.cz + Math.sin(a) * PARK_GROVE.r * 0.9, w: 3.2 });
  }
  // фонари по кольцу, скамейки и урны между ними
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const lx = PARK_GROVE.cx + Math.cos(a) * (PARK_GROVE.r * 0.66);
    const lz = PARK_GROVE.cz + Math.sin(a) * (PARK_GROVE.r * 0.66);
    lamps.push({ x: lx, z: lz, rot: a + Math.PI, park: true });
    const ba = a + Math.PI / 16;
    const bx = PARK_GROVE.cx + Math.cos(ba) * (PARK_GROVE.r * 0.66);
    const bz = PARK_GROVE.cz + Math.sin(ba) * (PARK_GROVE.r * 0.66);
    benches.push({ x: bx, z: bz, rot: ba + Math.PI / 2 });
    bins.push({ x: bx + Math.cos(ba) * 1.4, z: bz + Math.sin(ba) * 1.4 });
  }

  /* --- парк Дружбы: пальмы, озеро, кафе --- */
  for (let i = 0; i < 420; i++) {
    const a = rand() * Math.PI * 2, rr = Math.sqrt(rand()) * PARK_FRIENDS.r * 0.96;
    const x = PARK_FRIENDS.cx + Math.cos(a) * rr, z = PARK_FRIENDS.cz + Math.sin(a) * rr;
    if (roadAt(x, z) || lakeDist(x, z) < 1.08) continue;
    if (rand() < 0.55) trees.push({ x, z, type: rand() < 0.6 ? 'palm' : 'palm2', scale: 0.85 + rand() * 0.55, rot: rand() * 6.28 });
    else trees.push({ x, z, type: pickTree(rand), scale: 0.8 + rand() * 0.5, rot: rand() * 6.28 });
  }
  for (let i = 0; i < 26; i++) {
    const t = -HALF + 60 + rand() * (WORLD_SIZE - 120);
    const z = RIVER.z0 - 6 - rand() * 5;
    if (lakeDist(t, z) > 1.1) trees.push({ x: t, z, type: 'palm', scale: 0.9 + rand() * 0.4, rot: rand() * 6.28 });
  }

  /* --- деревья и фонари вдоль улиц --- */
  for (const r of ROADS) {
    for (let t = -HALF + 40; t < HALF - 40; t += 16) {
      for (const side of [-1, 1]) {
        const x = r.axis === 'z' ? r.at + side * (r.width / 2 + 3.4) : t + (rand() - 0.5) * 3;
        const z = r.axis === 'z' ? t + (rand() - 0.5) * 3 : r.at + side * (r.width / 2 + 3.4);
        if (!isFreeGround(x, z)) continue;
        if (inPark(x, z)) continue;
        if (rand() < 0.42) trees.push({ x, z, type: pickTree(rand), scale: 0.85 + rand() * 0.4, rot: rand() * 6.28 });
      }
    }
    for (let t = -HALF + 30; t < HALF - 30; t += 32) {
      const side = (Math.floor(t / 32) % 2 === 0) ? 1 : -1;
      const x = r.axis === 'z' ? r.at + side * (r.width / 2 + 1.1) : t;
      const z = r.axis === 'z' ? t : r.at + side * (r.width / 2 + 1.1);
      if (isFreeGround(x, z) || isSidewalk(x, z)) lamps.push({ x, z, rot: r.axis === 'z' ? (side > 0 ? Math.PI : 0) : (side > 0 ? Math.PI / 2 : -Math.PI / 2) });
    }
    for (let t = -HALF + 60; t < HALF - 60; t += 58) {
      const side = (Math.floor(t / 58) % 2 === 0) ? 1 : -1;
      const x = r.axis === 'z' ? r.at + side * (r.width / 2 + 4.6) : t;
      const z = r.axis === 'z' ? t : r.at + side * (r.width / 2 + 4.6);
      if (!isFreeGround(x, z)) continue;
      benches.push({ x, z, rot: r.axis === 'z' ? Math.PI / 2 * side : (side > 0 ? 0 : Math.PI) });
      bins.push({ x: x + 1.3, z: z + 0.4 });
    }
  }

  /* --- ёлка на площади --- */
  const xmas = { x: SQUARE.cx, z: SQUARE.cz };

  return { buildings, shops, trees, lamps, benches, bins, paths, shrubs, xmas, SHOP_TYPES };
}

function pickStyle(rand) {
  const r = rand();
  if (r < 0.13) return 'private';
  if (r < 0.18) return 'office';
  if (r < 0.42) return 'panel5';
  if (r < 0.64) return 'panel9';
  if (r < 0.87) return 'brick5';
  return 'brick9';
}
function pickTree(rand) {
  const r = rand();
  if (r < 0.42) return 'maple';
  if (r < 0.7) return 'birch';
  if (r < 0.88) return 'linden';
  return 'spruce';
}
function overlapBox(list, x, z, r) {
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const rr = Math.max(b.w, b.d) / 2 + r / 2;
    if (Math.abs(b.x - x) < rr && Math.abs(b.z - z) < rr) return true;
  }
  return false;
}
export function districtName(x, z) {
  if (z > RIVER.z0 - 4) return 'набережная Волги';
  if (inPark(x, z) === PARK_GROVE) return 'Берёзовая роща';
  if (inPark(x, z) === PARK_FRIENDS) return 'Парк Дружбы';
  if (inPark(x, z) === SQUARE) return 'Новогодняя площадь';
  if (Math.abs(x) < 20) return 'проспект Карла Маркса';
  if (Math.abs(z) < 20) return 'улица Демократическая';
  if (Math.abs(x + 260) < 14) return 'улица Стара-Загора';
  if (Math.abs(x - 260) < 14) return 'Ново-Вокзальная';
  if (x < -300 && z < -300) return 'Парк Дружбы';
  if (x > 300 && z < -300) return 'Берёзовая роща';
  if (z > 300) return 'Заволжский';
  return 'Центральный';
}
export function shopDoor(s) {
  const f = s.front || { x: 0, z: 1 };
  return { x: s.x + f.x * (s.d / 2 + 1.5), z: s.z + f.z * (s.d / 2 + 1.5), nx: f.x, nz: f.z };
}
export function insideShop(s, x, z) {
  const dx = x - s.x, dz = z - s.z;
  const c = Math.cos(-s.rotY), sn = Math.sin(-s.rotY);
  const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
  return Math.abs(lx) < s.w / 2 && Math.abs(lz) < s.d / 2;
}
