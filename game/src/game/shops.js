/* Магазины: аренда/покупка, товар, полки, касса, покупатели, выручка.
   Данные магазина лежат в city.data.shops (position/size), здесь — экономика и состояние. */
import { shopDoor, insideShop } from '../world/gen.js';

export const GOODS = {
  food: [
    { id: 'bread', name: 'Хлеб', buy: 42, sell: 68, w: 0.4 },
    { id: 'milk', name: 'Молоко', buy: 58, sell: 92, w: 0.5 },
    { id: 'eggs', name: 'Яйца', buy: 76, sell: 119, w: 0.6 },
    { id: 'cheese', name: 'Сыр', buy: 190, sell: 289, w: 0.7 },
    { id: 'apples', name: 'Яблоки', buy: 64, sell: 105, w: 0.5 },
    { id: 'sausage', name: 'Колбаса', buy: 210, sell: 319, w: 0.7 },
    { id: 'water', name: 'Вода', buy: 22, sell: 39, w: 0.4 },
    { id: 'juice', name: 'Сок', buy: 58, sell: 99, w: 0.5 },
    { id: 'chips', name: 'Чипсы', buy: 45, sell: 79, w: 0.3 },
    { id: 'sweets', name: 'Конфеты', buy: 80, sell: 135, w: 0.3 },
  ],
  small: [
    { id: 'press', name: 'Газеты', buy: 30, sell: 55, w: 0.2 },
    { id: 'gum', name: 'Жвачка', buy: 18, sell: 35, w: 0.15 },
    { id: 'pens', name: 'Ручки', buy: 20, sell: 45, w: 0.15 },
    { id: 'batteries', name: 'Батарейки', buy: 70, sell: 145, w: 0.2 },
    { id: 'flowers', name: 'Цветок', buy: 130, sell: 260, w: 0.5 },
    { id: 'book', name: 'Книга', buy: 220, sell: 399, w: 0.6 },
  ],
  tech: [
    { id: 'earbuds', name: 'Наушники', buy: 900, sell: 1590, w: 0.3 },
    { id: 'charger', name: 'Зарядка', buy: 420, sell: 790, w: 0.3 },
    { id: 'mouse', name: 'Мышь', buy: 520, sell: 949, w: 0.3 },
    { id: 'tv', name: 'Телевизор', buy: 14000, sell: 22990, w: 2.0 },
    { id: 'phone', name: 'Телефон', buy: 12000, sell: 19990, w: 0.4 },
  ],
  clothes: [
    { id: 'tshirt', name: 'Футболка', buy: 340, sell: 690, w: 0.5 },
    { id: 'jeans', name: 'Джинсы', buy: 900, sell: 1690, w: 0.8 },
    { id: 'jacket', name: 'Куртка', buy: 2200, sell: 3990, w: 1.2 },
    { id: 'shoes', name: 'Кроссовки', buy: 1900, sell: 3490, w: 1.0 },
  ],
  cafe: [
    { id: 'coffee', name: 'Кофе', buy: 45, sell: 149, w: 0.2 },
    { id: 'tea', name: 'Чай', buy: 25, sell: 99, w: 0.2 },
    { id: 'croissant', name: 'Круассан', buy: 55, sell: 129, w: 0.3 },
    { id: 'cake', name: 'Пирожное', buy: 70, sell: 179, w: 0.3 },
  ],
};

export const FIXTURES = [
  { id: 'shelf_s', name: 'Стеллаж малый', desc: '4 полки, 12 мест', price: 18000, slots: 12, size: [1.8, 1.8, 0.5] },
  { id: 'shelf_l', name: 'Стеллаж двойной', desc: '6 полок, 24 места', price: 32000, slots: 24, size: [2.4, 2.2, 0.6] },
  { id: 'fridge', name: 'Холодильник', desc: 'витрина для молочного', price: 64000, slots: 16, size: [1.6, 2.1, 0.8] },
  { id: 'counter', name: 'Прилавок-касса', desc: 'касса и лента', price: 48000, slots: 0, size: [2.2, 1.0, 0.9] },
  { id: 'basket', name: 'Корзинки', desc: 'покупатели берут больше', price: 4000, slots: 0, size: [0.6, 0.4, 0.4] },
  { id: 'light', name: 'Светильник', desc: 'ярче — покупателей больше', price: 6500, slots: 0, size: [0.8, 0.2, 0.8] },
  { id: 'sign', name: 'Вывеска «ОТКРЫТО»', desc: 'видно с улицы', price: 9000, slots: 0, size: [0.8, 0.4, 0.1] },
];

export class ShopSystem {
  constructor(game) {
    this.game = game;
    this.shops = [];
    this.owned = [];
    this.buyers = [];
    this.totalServed = 0;
    this.totalRevenue = 0;
    this.staff = [];
    this.lastDay = 1;
    this._spawnTimer = 0;
    this.msgTimer = 0;
  }

  init(cityShops) {
    this.shops = cityShops.map((s) => ({
      ...s,
      // s.stock приходит из gen.js строкой-категорией ('food'|'tech'|...);
      // склад храним отдельно, иначе категория затирается пустым объектом
      cat: s.cat || s.stock,
      owned: false, rented: false, open: false,
      stock: {},                 // goodsId -> количество
      fixtures: [],              // {id, x, z, ry}
      price2: s.price,
      rent: s.rent,
      served: 0, revenue: 0, dayRevenue: 0,
      reputation: 0.4,           // 0..1 — влияет на поток
      lastVisitDay: 0,
      queue: [],
    }));
    // стартовый магазин: выбираем в самом оживлённом квартале (много соседей рядом),
    // с приоритетом продуктовых/киосков — там всегда есть покупатели
    // плотность застройки вокруг: сколько домов и магазинов в радиусе 160 м
    const blds = (this.game && this.game.city && this.game.city.data && this.game.city.data.buildings) || [];
    const scored = this.shops.map((s) => {
      let nearShops = 0, nearBld = 0;
      for (const o of this.shops) if (o !== s && Math.hypot(o.x - s.x, o.z - s.z) < 160) nearShops++;
      for (const b of blds) if (Math.hypot(b.x - s.x, b.z - s.z) < 160) nearBld++;
      const typeBias = (s.cat === 'food' ? 6 : s.cat === 'small' ? 4 : 0);
      return { s, score: nearBld * 1.0 + nearShops * 2 + typeBias };
    });
    scored.sort((a, b) => b.score - a.score);
    const start = scored.length ? scored[0] : null;
    if (start) this.grantStarter(start.s);
    return this.shops;
  }

  grantStarter(shop) {
    shop.owned = true;
    shop.open = true;
    shop.stock = {};
    shop.fixtures = [
      { id: 'shelf_l', x: -0.34, z: -0.3, ry: 0 },
      { id: 'shelf_s', x: 0.34, z: -0.3, ry: 0 },
      { id: 'counter', x: 0, z: 0.36, ry: 0 },
      { id: 'light', x: 0, z: 0, ry: 0 },
    ];
    // стартовый запас ровно по вместимости полок (36), поровну на 2-3 позиции
    const list = this.goodsFor(shop);
    const cap = this.capacity(shop);
    for (const g of list) shop.stock[g.id] = 0;
    const picks = list.slice(0, 3);
    const per = Math.floor(cap / picks.length);
    for (const g of picks) shop.stock[g.id] = per;
    shop.open = true;
    this.owned.push(shop);
    this.starter = shop;
    // точка спавна перед входом
    const d = shopDoor(shop);
    this.spawn = { x: d.x + d.nx * 4.5, z: d.z + d.nz * 4.5, lookX: shop.x, lookZ: shop.z };
    return shop;
  }

  nearest(x, z, radius = 14) {
    let best = null, bd = radius;
    for (const s of this.shops) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  byId(id) { return this.shops.find((s) => s.id === id); }

  /** Сколько единиц товара всего и сколько вмещает магазин. */
  capacity(shop) {
    let slots = 0;
    for (const f of shop.fixtures) {
      const def = FIXTURES.find((x) => x.id === f.id);
      if (def) slots += def.slots;
    }
    return Math.max(12, slots);
  }
  stockCount(shop) {
    let n = 0;
    for (const k in shop.stock) n += shop.stock[k];
    return n;
  }
  stockValue(shop) {
    let v = 0;
    for (const k in shop.stock) { const g = this.goodById(k); if (g) v += shop.stock[k] * (g.buy + g.sell) / 2; }
    return v;
  }
  goodById(id) {
    for (const k in GOODS) { const f = GOODS[k].find((g) => g.id === id); if (f) return f; }
    return null;
  }
  goodsFor(shop) { return GOODS[shop.cat] || GOODS[shop.type] || GOODS.food; }

  /** Заказ товара: списывает деньги, товар приходит сразу (упрощённо — поставка). */
  order(shop, goodId, qty, money) {
    const g = this.goodById(goodId);
    if (!g) return { ok: false, msg: 'Такого товара нет' };
    const cap = this.capacity(shop);
    const free = cap - this.stockCount(shop);
    if (qty > free) return { ok: false, msg: `Мест на полках: ${free}. Заказ больше не влезет` };
    const cost = g.buy * qty;
    if (money < cost) return { ok: false, msg: `Не хватает денег: нужно ${cost} ₽` };
    shop.stock[goodId] = (shop.stock[goodId] || 0) + qty;
    return { ok: true, cost, msg: `Заказано: ${g.name} × ${qty} за ${cost} ₽` };
  }

  buyFixture(shop, id, money) {
    const def = FIXTURES.find((f) => f.id === id);
    if (!def) return { ok: false, msg: 'Нет такого предмета' };
    if (money < def.price) return { ok: false, msg: `Нужно ${def.price} ₽` };
    const ry = Math.random() * Math.PI * 2;
    shop.fixtures.push({ id, x: 0, z: 0, ry });
    return { ok: true, cost: def.price, msg: `Куплено: ${def.name}` };
  }

  openShop(shop) {
    if (!shop.owned) return { ok: false, msg: 'Магазин не ваш' };
    if (this.stockCount(shop) === 0) return { ok: false, msg: 'Полки пусты — сначала закажите товар' };
    if (!shop.fixtures.some((f) => f.id === 'counter')) return { ok: false, msg: 'Нужна касса (прилавок-касса)' };
    shop.open = !shop.open;
    return { ok: true, msg: shop.open ? 'Магазин открыт — ждите покупателей' : 'Магазин закрыт' };
  }

  rent(shop, money) {
    if (shop.owned) return { ok: false, msg: 'Уже ваш' };
    if (money < shop.rent * 2) return { ok: false, msg: `Нужно ${shop.rent * 2} ₽ (аренда + залог)` };
    shop.rented = true; shop.owned = true;
    shop.rentPaidUntil = this.dayNow() + 7;
    this.owned.push(shop);
    return { ok: true, cost: shop.rent * 2, msg: `Арендован на 7 дней: ${shop.name}` };
  }
  purchase(shop, money) {
    if (shop.owned) return { ok: false, msg: 'Уже ваш' };
    if (money < shop.price) return { ok: false, msg: `Нужно ${shop.price} ₽` };
    shop.owned = true; shop.bought = true;
    this.owned.push(shop);
    return { ok: true, cost: shop.price, msg: `Куплен: ${shop.name}` };
  }

  dayNow() { return this.game.weather ? this.game.weather.day : 1; }

  /** Поток покупателей зависит от репутации, света, корзинок, часа. */
  buyersPerMinute(shop) {
    if (!shop.open) return 0;
    const hour = this.game.weather.hour;
    // часы пик: 9-11, 18-20
    const peak = (hour > 8.5 && hour < 11) ? 1.55 : (hour > 17.5 && hour < 20.5) ? 1.7 : (hour > 12 && hour < 17) ? 1.0 : (hour > 20.5 || hour < 8) ? 0.25 : 0.7;
    const hasLight = shop.fixtures.some((f) => f.id === 'light') ? 1.25 : 1.0;
    const hasBasket = shop.fixtures.some((f) => f.id === 'basket') ? 1.3 : 1.0;
    const stockFactor = Math.min(1, this.stockCount(shop) / Math.max(8, this.capacity(shop) * 0.4));
    return 3.2 * peak * hasLight * hasBasket * (0.5 + shop.reputation) * stockFactor * (1 + this.owned.length * 0.12);
  }

  update(dt) {
    const hour = this.game.weather.hour;
    const night = this.game.weather.night;
    for (const shop of this.shops) {
      if (!shop.owned) continue;
      // аренда списывается раз в день
      if (shop.rented && shop.rentPaidUntil !== undefined && this.dayNow() > shop.rentPaidUntil) {
        shop.rentPaidUntil = this.dayNow() + 7;
        this.game.money -= shop.rent * 7;
        this.game.ui.notify(`Аренда ${shop.name}: −${shop.rent * 7} ₽`, 'bad');
      }
      // утром магазин, закрытый автоматически ночью, открывается сам —
      // иначе игрок утром видел «закрыт» и не понимал, почему нет покупателей
      if (shop.closedByNight && hour > 8 && hour < 21) {
        shop.closedByNight = false;
        if (!shop.open && this.stockCount(shop) > 0) {
          shop.open = true;
          this.game.ui.notify(`${shop.name} открыт`, 'good');
        }
      }
      if (!shop.open) continue;
      // покупатели
      shop._acc = (shop._acc || 0) + dt * this.buyersPerMinute(shop) / 60;
      while (shop._acc >= 1) {
        shop._acc -= 1;
        if (this.buyers.length < 40) this.spawnBuyer(shop);
      }
      // закрываемся ночью автоматически
      if (night > 0.65 && shop.open && shop.autoClose !== false) {
        shop.open = false;
        shop.closedByNight = true;
        this.game.ui.notify(`${shop.name} закрыт на ночь`, '');
      }
    }
    // движение покупателей
    for (let i = this.buyers.length - 1; i >= 0; i--) {
      const b = this.buyers[i];
      this.updateBuyer(b, dt);
      if (b.dead) this.buyers.splice(i, 1);
    }
    // ежедневная смена
    if (this.dayNow() !== this.lastDay) {
      this.lastDay = this.dayNow();
      for (const s of this.shops) if (s.owned) {
        s.dayRevenue = 0;
        s.reputation = Math.max(0.1, Math.min(1, s.reputation + (s.served > 8 ? 0.06 : -0.03)));
      }
    }
  }

  spawnBuyer(shop) {
    const door = shopDoor(shop);
    const goods = this.goodsFor(shop);
    const inStock = goods.filter((g) => (shop.stock[g.id] || 0) > 0);
    if (!inStock.length) return null;
    const n = 1 + Math.floor(Math.random() * (shop.fixtures.some((f) => f.id === 'basket') ? 5 : 3));
    const basket = [];
    for (let i = 0; i < n; i++) {
      const g = inStock[Math.floor(Math.random() * inStock.length)];
      if ((shop.stock[g.id] || 0) < 1) continue;
      shop.stock[g.id] -= 1;
      basket.push(g);
    }
    if (!basket.length) return null;
    const b = {
      shop, basket, phase: 'enter', t: 0,
      x: door.x + (Math.random() - 0.5) * 2, z: door.z + (Math.random() - 0.5) * 2,
      tx: door.x, tz: door.z, door, dead: false, speed: 1.2 + Math.random() * 0.5,
      patience: 18 + Math.random() * 12, wait: 0, spent: 0,
    };
    // цель: касса
    const counter = shop.fixtures.find((f) => f.id === 'counter');
    b.cashierX = shop.x + (counter ? (counter.x || 0) : 0);
    b.cashierZ = shop.z + (counter ? (counter.z || 0) : 0);
    this.buyers.push(b);
    return b;
  }

  updateBuyer(b, dt) {
    const shop = b.shop;
    b.t += dt;
    const dx = b.tx - b.x, dz = b.tz - b.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.25) {
      const sp = b.speed * dt;
      b.x += dx / d * Math.min(sp, d);
      b.z += dz / d * Math.min(sp, d);
    } else {
      // фазы
      if (b.phase === 'enter') {
        // идёт по залу к полкам
        b.phase = 'shopping';
        b.tx = shop.x + (Math.random() - 0.5) * shop.w * 0.65;
        b.tz = shop.z + (Math.random() - 0.5) * shop.d * 0.65;
        b.wait = 1.5 + Math.random() * 2;
      } else if (b.phase === 'shopping') {
        if (b.wait > 0) { b.wait -= dt; return; }
        b.phase = 'topay';
        // очередь: каждый следующий встаёт на полшага дальше от кассы
        const waiting = this.buyers.filter((o) => o !== b && o.shop === shop && o.phase === 'topay' && !o.dead).length;
        b.tx = b.cashierX + (Math.random() - 0.5) * 0.5;
        b.tz = b.cashierZ + 1.1 + waiting * 0.55;
        b.wait = 1.0 + Math.random() * 0.8;
      } else if (b.phase === 'topay') {
        // касса: платит через секунду-полторы (раньше wait уже был <= 0,
        // и покупатель «платил» мгновенно, ещё не дойдя до прилавка)
        if (!Number.isFinite(b.wait)) b.wait = 1.2;
        b.wait -= dt;
        if (b.wait <= 0) {
          b.phase = 'leave';
          b.tx = b.door.x; b.tz = b.door.z;
          // оплата
          const sum = b.basket.reduce((a, g) => a + g.sell, 0);
          b.spent = sum;
          shop.revenue += sum;
          shop.dayRevenue += sum;
          shop.served += 1;
          this.totalServed += 1;
          this.totalRevenue += sum;
          this.game.money += sum;
          this.game.stats.served = this.totalServed;
          this.game.stats.revenue = this.totalRevenue;
          if (Math.random() < 0.30) this.game.ui.notify(`+${sum} ₽ · ${shop.name}`, 'good');
          if (this.game.onSale) this.game.onSale(shop, sum, b);
        }
      } else if (b.phase === 'leave') {
        b.dead = true;
      }
    }
    // страховка от NaN: без неё покупатель мог навсегда замереть у кассы
    if (b.phase === 'topay' && !Number.isFinite(b.wait)) b.wait = 1.2;
  }

  /** Отчёт для панели магазина. */
  report(shop) {
    const goods = this.goodsFor(shop);
    const stock = this.stockCount(shop), cap = this.capacity(shop);
    return {
      name: shop.name, type: shop.type, area: shop.area, district: shop.district,
      owned: shop.owned, open: shop.open, rented: shop.rented,
      stock, cap, served: shop.served, revenue: shop.revenue, dayRevenue: shop.dayRevenue,
      reputation: shop.reputation, rent: shop.rent, price: shop.price,
      buyersNow: this.buyers.filter((b) => b.shop === shop && !b.dead).length,
      incomePerMin: this.buyersPerMinute(shop) * 0.5 * (goods.reduce((a, g) => a + g.sell, 0) / Math.max(1, goods.length)),
    };
  }

  save() {
    return this.shops.map((s) => ({
      id: s.id, owned: s.owned, rented: s.rented, open: s.open, stock: s.stock,
      fixtures: s.fixtures, served: s.served, revenue: s.revenue, reputation: s.reputation,
      rentPaidUntil: s.rentPaidUntil,
    }));
  }
  load(data) {
    if (!Array.isArray(data)) return;
    for (const d of data) {
      const s = this.byId(d.id);
      if (!s) continue;
      Object.assign(s, {
        owned: d.owned, rented: d.rented, open: d.open, stock: d.stock || {},
        fixtures: d.fixtures || [], served: d.served || 0, revenue: d.revenue || 0, reputation: d.reputation ?? 0.4,
      });
      // срок оплаты аренды тоже должен пережить сохранение, иначе после
      // перезапуска арендованная точка становилась бесплатной навсегда
      if (s.rented && d.rentPaidUntil === undefined) s.rentPaidUntil = this.dayNow() + 7;
      else if (d.rentPaidUntil !== undefined) s.rentPaidUntil = d.rentPaidUntil;
      if (s.owned && !this.owned.includes(s)) this.owned.push(s);
    }
  }
}
