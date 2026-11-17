/* Игровой слой: наведение, взаимодействие, покупатели-модели, магазины, панели, задания. */
import * as THREE from 'three';
import { ShopSystem, GOODS, FIXTURES } from './shops.js';
import { shopDoor, insideShop, districtName, roadAt, HALF } from '../world/gen.js';
import { money, el } from '../core/ui.js';
import { settings, saveGame, loadGame, clearGame, saveSettings } from '../core/settings.js';

export class Gameplay {
  constructor(game) {
    this.game = game;
    this.shopsys = new ShopSystem(game);
    this.nearShop = null;
    this.insideShop = null;
    this.target = null;
    this.raycaster = new THREE.Raycaster();
    this.center = new THREE.Vector2(0, 0);
    this.staffGroup = new THREE.Group();
    game.renderer.scene.add(this.staffGroup);
    this.npcModels = new Map();
    this.people = [];
    this.quest = { buying: false, opened: false, served: 5, done: {} };
    this.lastMoney = game.money;
    this.data = null;
  }

  init(cityData) {
    this.data = cityData;
    this.shopsys.init(cityData.shops);
    this.game.shops = this.shopsys.shops;
    this.quest.shop = this.shopsys.starter || this.shopsys.shops[0];
    // покупатели-модели (инстансы людей на улице — просто прохожие)
    this._buildPeople();
    this.updateObjectives();
  }

  /* ---------- прохожие ---------- */
  _buildPeople() {
    const count = 26;
    const bodyGeo = new THREE.CapsuleGeometry(0.22, 0.66, 3, 8);
    const headGeo = new THREE.SphereGeometry(0.18, 10, 8);
    const legGeo = new THREE.BoxGeometry(0.18, 0.72, 0.2);
    const armGeo = new THREE.BoxGeometry(0.13, 0.56, 0.15);
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a97f, roughness: 0.85 });
    const colors = [0x2b5f8a, 0x8a3d3d, 0x3d6b4a, 0x6a5a8a, 0xa08444, 0x444b52, 0x8a6a3d];
    for (let i = 0; i < count; i++) {
      const g = new THREE.Group();
      const c = colors[i % colors.length];
      const mat = new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 });
      const torso = new THREE.Mesh(bodyGeo, mat); torso.position.y = 1.15; g.add(torso);
      const head = new THREE.Mesh(headGeo, skin); head.position.y = 1.72; g.add(head);
      const legL = new THREE.Mesh(legGeo, new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.9 }));
      legL.position.set(-0.12, 0.36, 0); g.add(legL);
      const legR = legL.clone(); legR.position.x = 0.12; g.add(legR);
      const armL = new THREE.Mesh(armGeo, mat); armL.position.set(-0.32, 1.2, 0); g.add(armL);
      const armR = new THREE.Mesh(armGeo, mat); armR.position.set(0.32, 1.2, 0); g.add(armR);
      g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      // дорожка: ходит вдоль тротуара
      const road = Math.random() < 0.5 ? 0 : 1;
      const lane = road === 0 ? 0 : -260;
      const side = Math.random() < 0.5 ? 1 : -1;
      const dir = Math.random() < 0.5 ? 1 : -1;
      const p = {
        g, legL, legR, armL, armR,
        x: lane + side * 15 + (Math.random() - 0.5) * 3,
        z: -HALF + Math.random() * 1000,
        dir, speed: 1.1 + Math.random() * 0.7, phase: Math.random() * 6.28,
        axis: 'z',
      };
      this.people.push(p);
      this.staffGroup.add(g);
    }
  }

  /* ---------- покупатели в магазинах ---------- */
  _buyerModel(b) {
    let m = this.npcModels.get(b);
    if (m) return m;
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: [0x2b5f8a, 0x8a3d3d, 0x3d6b4a, 0x6a5a8a][Math.floor(Math.random() * 4)], roughness: 0.8 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.6, 3, 8), mat); torso.position.y = 1.05; g.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), new THREE.MeshStandardMaterial({ color: 0xd9a97f, roughness: 0.85 })); head.position.y = 1.58; g.add(head);
    // корзинка
    if (b.basket.length) {
      const bas = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.22), new THREE.MeshStandardMaterial({ color: 0xb03a3a, roughness: 0.7 }));
      bas.position.set(0.28, 0.82, 0.05); g.add(bas);
    }
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.staffGroup.add(g);
    this.npcModels.set(b, g);
    return g;
  }

  update(dt) {
    const g = this.game;
    this.shopsys.update(dt);
    this._updatePeople(dt);
    this._updateBuyers(dt);
    this._updateTarget();
    this._handleInput();
    this._updateHud();
    this._moneyWatch();
  }

  _updatePeople(dt) {
    const px = this.game.player.pos.x, pz = this.game.player.pos.z;
    for (const p of this.people) {
      p.phase += dt * p.speed * 3.4;
      p.z += p.dir * p.speed * dt;
      if (Math.abs(p.z) > HALF - 30) p.dir *= -1;
      if (Math.abs(p.z - pz) < 180 && Math.abs(p.x - px) < 180) {
        p.g.visible = true;
        p.g.position.set(p.x, 0.22, p.z);
        p.g.rotation.y = p.dir > 0 ? 0 : Math.PI;
        const sw = Math.sin(p.phase) * 0.5;
        p.legL.rotation.x = sw; p.legR.rotation.x = -sw;
        p.armL.rotation.x = -sw * 0.8; p.armR.rotation.x = sw * 0.8;
      } else { p.g.visible = false; }
    }
  }

  _updateBuyers(dt) {
    const active = new Set();
    for (const b of this.shopsys.buyers) {
      active.add(b);
      const m = this._buyerModel(b);
      m.visible = true;
      m.position.set(b.x, 0.24, b.z);
      const dx = b.tx - b.x, dz = b.tz - b.z;
      if (Math.hypot(dx, dz) > 0.2) m.rotation.y = Math.atan2(dx, dz);
      m.position.y = 0.24 + Math.abs(Math.sin(b.t * 7)) * 0.03;
    }
    for (const [b, m] of this.npcModels) {
      if (!active.has(b)) { this.staffGroup.remove(m); this.npcModels.delete(b); }
    }
  }

  /* ---------- что под прицелом ---------- */
  _updateTarget() {
    const g = this.game;
    const pos = g.player.pos;
    this.nearShop = this.shopsys.nearest(pos.x, pos.z, 22);
    this.insideShop = null;
    for (const s of this.shopsys.shops) if (s.owned && insideShop(s, pos.x, pos.z)) { this.insideShop = s; break; }
    // что за дверь: стоим ли у входа в магазин
    let doorShop = null;
    for (const s of this.shopsys.shops) {
      const d = shopDoor(s);
      if (Math.hypot(pos.x - d.x, pos.z - d.z) < 3.2) { doorShop = s; break; }
    }
    this.doorShop = doorShop;
    g.nearShop = doorShop || this.insideShop;
    // подсказка
    let text = '', key = 'E';
    if (this.insideShop) {
      text = this.insideShop.open ? 'Магазин открыт · B — каталог и товар' : 'Зайти в магазин · B — каталог';
      key = 'B';
    } else if (doorShop) {
      text = doorShop.owned ? (doorShop.open ? `«${doorShop.name}» — работает · E — управление` : `«${doorShop.name}» — войти и открыть`)
        : `«${doorShop.name}» · ${money(doorShop.price)} · E — осмотреть`;
    }
    g.ui.prompt(text, key);
  }

  _handleInput() {
    const g = this.game, inp = g.input;
    const acts = inp.takeActions();
    const use = inp.pressed('KeyE') || acts.includes('use');
    if (inp.pressed('KeyB') || acts.includes('catalog')) g.togglePanel('catalog');
    if (inp.pressed('KeyM') || acts.includes('map')) g.togglePanel('map');
    if (inp.pressed('Tab')) { g.mode = g.mode === 'walk' ? 'drone' : 'walk'; g.ui.notify(g.mode === 'drone' ? 'Режим дрона' : 'Пешком'); }
    if (inp.pressed('F1')) g.ui.graphicsPanel(), g.openPanel('graphics');
    if (inp.pressed('F2')) g.setQuality(settings.quality === 'high' ? 'low' : settings.quality === 'low' ? 'medium' : 'high');
    if (inp.pressed('Escape')) {
      if (g.panelOpen) g.closePanel(g.panelOpen);
      else { g.paused = !g.paused; if (g.paused) g.openPanel('pause'); }
    }
    if (use) this.interact();
  }

  interact() {
    const g = this.game;
    if (this.doorShop) {
      const s = this.doorShop;
      if (s.owned) {
        this.game.togglePanel('shop');
      } else {
        this.openOffer(s);
      }
      return;
    }
    if (this.insideShop) { this.game.togglePanel('shop'); return; }
    // возле ёлки
    const xmas = this.data.xmas;
    if (Math.hypot(g.player.pos.x - xmas.x, g.player.pos.z - xmas.z) < 9) {
      g.ui.dialogue('Ёлка', 'Новогодняя ёлка на площади Новогодней. Загадайте желание — говорят, сбывается.', [
        { label: 'Загадать желание', action: () => { g.money += 1000; g.ui.notify('Желание загадано: +1 000 ₽', 'good'); } },
        { label: 'Просто посмотреть', action: () => {} },
      ]);
    }
  }

  /* ---------- предложение аренды/покупки ---------- */
  openOffer(s) {
    const g = this.game;
    g.closePanel(g.panelOpen);
    const p = g.ui.makePanel('shop', {
      title: s.name,
      sub: `${s.area} м² · ${districtName(s.x, s.z)}`,
      body: '',
      foot: `Денег у вас: ${money(g.money)}`,
    });
    this.panel = p;
    const b = p.body;
    b.innerHTML = `
      <div class="row" style="gap:24px;align-items:flex-start">
        <div style="flex:1 1 320px">
          <h3>Помещение</h3>
          <div class="kv">
            <span>Площадь</span><b>${s.area} м²</b>
            <span>Район</span><b>${districtName(s.x, s.z)}</b>
            <span>Поставки</span><b>${({ food: 'продукты', small: 'мелочь', tech: 'техника', clothes: 'одежда', cafe: 'кафе' })[s.stock] || 'продукты'}</b>
            <span>Цена покупки</span><b>${money(s.price)}</b>
            <span>Аренда</span><b>${money(s.rent)} / неделя</b>
          </div>
        </div>
        <div style="flex:1 1 260px">
          <h3>Что даёт</h3>
          <div class="note-inline">${s.type === 'cafe' ? 'Готовый поток: кофе и выпечка, высокая наценка. Покупатели идут с утра.' :
          s.type === 'kiosk' ? 'Маленький, дёшево: газеты, жвачка, батарейки. Хорош как первый магазин.' :
          'Стандартный продуктовый: стабильный поток покупателей и понятная наценка.'}</div>
        </div>
      </div>`;
    const row = el('div', { class: 'row', style: 'margin-top:18px' });
    const bRent = el('button', { class: 'btn' }, `Арендовать — ${money(s.rent * 2)}`);
    bRent.onclick = () => {
      const r = this.shopsys.rent(s, g.money);
      if (r.ok) { g.money -= r.cost; g.ui.notify(r.msg, 'good'); this.game.closePanel('shop'); this.openShopPanel(); }
      else g.ui.notify(r.msg, 'bad');
    };
    const bBuy = el('button', { class: 'btn green' }, `Купить — ${money(s.price)}`);
    bBuy.onclick = () => {
      const r = this.shopsys.purchase(s, g.money);
      if (r.ok) { g.money -= r.cost; g.ui.notify(r.msg, 'good'); this.game.closePanel('shop'); this.openShopPanel(); }
      else g.ui.notify(r.msg, 'bad');
    };
    const bNo = el('button', { class: 'btn ghost' }, 'Позже');
    bNo.onclick = () => this.game.closePanel('shop');
    row.appendChild(bRent); row.appendChild(bBuy); row.appendChild(bNo);
    b.appendChild(row);
    g.ui.openPanel('shop');
    g.panelOpen = 'shop';
  }

  /* ---------- панель своего магазина ---------- */
  openShopPanel() {
    const g = this.game;
    const s = this.insideShop || this.doorShop || this.shopsys.starter;
    if (!s) return;
    this.activeShop = s;
    if (!s.owned) { this.openOffer(s); return; }
    g.closePanel(g.panelOpen);
    const rep = this.shopsys.report(s);
    const p = g.ui.makePanel('shop', {
      title: s.name,
      sub: `${rep.area} м² · ${rep.district} · ${s.open ? 'ОТКРЫТ' : 'закрыт'}`,
      body: '',
      foot: '',
    });
    const b = p.body;
    b.innerHTML = `
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px">
        ${this._stat('Выручка сегодня', money(s.dayRevenue))}
        ${this._stat('Всего выручки', money(s.revenue))}
        ${this._stat('Покупателей', String(s.served))}
        ${this._stat('Товара на полках', `${rep.stock} / ${rep.cap}`)}
        ${this._stat('Сейчас в зале', String(rep.buyersNow))}
        ${this._stat('Репутация', Math.round(s.reputation * 100) + '%')}
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn ${s.open ? 'bad' : 'green'}" id="btn-open">${s.open ? 'Закрыть магазин' : 'Открыть магазин'}</button>
        <button class="btn ghost" id="btn-order">Заказать товар</button>
        <button class="btn ghost" id="btn-fixtures">Оборудование</button>
      </div>
      <h3>Полки</h3>
      <div id="stocklist" class="grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))"></div>
      `;
    const bt = (id) => b.querySelector('#' + id);
    bt('btn-open').onclick = () => {
      const r = this.shopsys.openShop(s);
      g.ui.notify(r.msg, r.ok ? 'good' : 'bad');
      this.openShopPanel();
    };
    bt('btn-order').onclick = () => { this.orderMode = true; this.openCatalog(); };
    bt('btn-fixtures').onclick = () => { this.orderMode = false; this.openCatalog(); };
    const list = b.querySelector('#stocklist');
    const goods = this.shopsys.goodsFor(s);
    for (const gd of goods) {
      const n = s.stock[gd.id] || 0;
      const card = el('div', { class: 'card' + (n === 0 ? ' locked' : '') });
      card.innerHTML = `<div class="nm">${gd.name}</div><div class="ds">осталось: <b style="color:#ffb43d">${n}</b> шт · ${money(gd.sell)}</div>`;
      card.onclick = (e) => {
        e.stopPropagation();
        const qty = e.shiftKey ? 20 : 5;
        const cost = gd.buy * qty;
        if (g.money < cost) return g.ui.notify(`Нужно ${money(cost)}`, 'bad');
        if (!n && this.shopsys.capacity(s) - this.shopsys.stockCount(s) < qty) return g.ui.notify('Мест на полках нет', 'bad');
        const r = this.shopsys.order(s, gd.id, qty, g.money);
        if (r.ok) { g.money -= r.cost; g.ui.notify(r.msg, 'good'); this.openShopPanel(); }
        else g.ui.notify(r.msg, 'bad');
      };
      list.appendChild(card);
    }
    p.root.querySelector('header h2').textContent = s.name;
    g.ui.openPanel('shop');
    g.panelOpen = 'shop';
  }

  _stat(label, val) {
    return `<div style="background:#ffffff08;border:1px solid #ffffff12;border-radius:10px;padding:10px">
      <div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#8fa4b3">${label}</div>
      <div style="font-size:18px;font-weight:700;margin-top:3px">${val}</div></div>`;
  }

  /* ---------- каталог: товар и оборудование ---------- */
  openCatalog() {
    const g = this.game;
    g.closePanel(g.panelOpen);
    const s = this.activeShop || this.insideShop || this.shopsys.starter;
    if (!s) { g.ui.notify('Сначала войдите в магазин', 'bad'); return; }
    this.activeShop = s;
    const mode = this.orderMode ? 'trade' : 'fixtures';
    const p = g.ui.makePanel('catalog', {
      title: 'Каталог',
      sub: `${s.name} · денег ${money(g.money)}`,
      body: '',
      foot: 'Покупки приходят сразу на полки. Товар, который закончился, покупатели не берут — заказывайте заранее.',
    });
    const wrap = el('div', { class: 'split' });
    const tabs = el('div', { class: 'tabs' });
    const tabsData = [
      { k: 'trade', n: 'Товар', d: 'на полки' },
      { k: 'fixtures', n: 'Оборудование', d: 'стеллажи, касса' },
      { k: 'quality', n: 'Графика', d: 'трава, вода, небо' },
    ];
    const content = el('div');
    for (const t of tabsData) {
      const b = el('button', { class: 'tab' + (mode === t.k ? ' on' : '') }, `${t.n}<small>${t.d}</small>`);
      b.onclick = () => {
        if (t.k === 'quality') { g.closePanel('catalog'); g.openPanel('graphics'); return; }
        this.orderMode = t.k === 'trade';
        this.openCatalog();
      };
      tabs.appendChild(b);
    }
    wrap.appendChild(tabs);
    wrap.appendChild(content);
    p.body.appendChild(wrap);
    const grid = el('div', { class: 'grid' });
    content.appendChild(grid);

    g.ui.openPanel('catalog');
    g.panelOpen = 'catalog';
    if (this.orderMode) {
      const goods = this.shopsys.goodsFor(s);
      content.appendChild(el('h3', {}, 'Товар для продажи (клик — 5 шт, Shift — 20 шт)'));
      for (const gd of goods) {
        const n = s.stock[gd.id] || 0;
        const card = el('div', { class: 'card' });
        card.innerHTML = `<div class="nm">${gd.name}</div>
          <div class="ds">закупка ${money(gd.buy)} · продажа ${money(gd.sell)}<br>на полках: ${n}</div>
          <div class="pr">наценка ${Math.round((gd.sell / gd.buy - 1) * 100)}%</div>`;
        card.onclick = (e) => {
          const qty = e.shiftKey ? 20 : 5;
          const cost = gd.buy * qty;
          if (g.money < cost) return g.ui.notify(`Нужно ${money(cost)}`, 'bad');
          const cap = this.shopsys.capacity(s) - this.shopsys.stockCount(s);
          if (cap < qty) return g.ui.notify(`На полках только ${cap} свободных мест`, 'bad');
          const r = this.shopsys.order(s, gd.id, qty, g.money);
          if (r.ok) { g.money -= r.cost; g.ui.notify(r.msg, 'good'); this.openCatalog(); }
          else g.ui.notify(r.msg, 'bad');
        };
        grid.appendChild(card);
      }
    } else {
      content.appendChild(el('h3', {}, 'Оборудование магазина'));
      for (const f of FIXTURES) {
        const have = s.fixtures.filter((x) => x.id === f.id).length;
        const card = el('div', { class: 'card' });
        card.innerHTML = `<div class="nm">${f.name}</div><div class="ds">${f.desc}</div>
          <div class="pr">${money(f.price)}${have ? ' · у вас: ' + have : ''}</div>`;
        card.onclick = () => {
          const r = this.shopsys.buyFixture(s, f.id, g.money);
          if (r.ok) { g.money -= r.cost; g.ui.notify(r.msg, 'good'); this._rebuildFixtures(s); this.openCatalog(); }
          else g.ui.notify(r.msg, 'bad');
        };
        grid.appendChild(card);
      }
    }
  }

  _rebuildFixtures(s) { /* мебель в интерьере — упрощённо, только данные */ }

  /* ---------- карта ---------- */
  openMap() {
    const g = this.game;
    const p = g.ui.makePanel('map', { title: 'Карта', sub: 'Самара · Стара-Загора', body: '', foot: 'Буква — магазин, звезда — ваш. Нажмите на карту, чтобы поставить метку.' });
    const wrap = el('div', { class: 'mapwrap' });
    const c = document.createElement('canvas');
    const W = 1180, H = 1180;
    c.width = W; c.height = H;
    c.style.width = '100%';
    c.style.maxHeight = '62vh';
    c.style.objectFit = 'contain';
    wrap.appendChild(c);
    p.body.appendChild(wrap);
    p.body.appendChild(el('div', { class: 'legend' }, `
      <span><i style="background:#ffb43d"></i>ваш магазин</span>
      <span><i style="background:#59d3ff"></i>магазин сдаётся</span>
      <span><i style="background:#2a5566"></i>вода</span>
      <span><i style="background:#6a9a4a"></i>парк</span>
      <span><i style="background:#8a8a88"></i>улицы</span>`));
    this._drawMap(c, W, H);
    g.closePanel(g.panelOpen);
    g.ui.openPanel('map');
    g.panelOpen = 'map';
  }

  _drawMap(c, W, H) {
    const ctx = c.getContext('2d');
    const half = 800;
    const sc = W / (half * 2);
    const toX = (x) => (x + half) * sc, toY = (z) => (z + half) * sc;
    ctx.fillStyle = '#16241a'; ctx.fillRect(0, 0, W, H);
    // река
    ctx.fillStyle = '#20404f';
    ctx.fillRect(0, toY(560), W, H - toY(560));
    // озеро
    ctx.beginPath(); ctx.ellipse(toX(-655), toY(-655), 128 * sc, 98 * sc, 0, 0, 7); ctx.fill();
    // парки
    ctx.fillStyle = '#2b4a26';
    for (const [cx, cz, r] of [[665, -665, 225], [-655, -655, 240], [78, 78, 52]]) {
      ctx.beginPath(); ctx.arc(toX(cx), toY(cz), r * sc, 0, 7); ctx.fill();
    }
    // улицы
    const roadLines = [
      ['z', 0, 26], ['z', -260, 20], ['z', 260, 20], ['z', -520, 16], ['z', 520, 16],
      ['x', 0, 22], ['x', -260, 20], ['x', 260, 20], ['x', -520, 16], ['x', 520, 16],
    ];
    ctx.fillStyle = '#3c4148';
    for (const [ax, at, w] of roadLines) {
      if (ax === 'z') ctx.fillRect(toX(at - w / 2), 0, w * sc, H);
      else ctx.fillRect(0, toY(at - w / 2), W, w * sc);
    }
    // дома
    ctx.fillStyle = '#3f4a52';
    for (const b of this.data.buildings) {
      if (b.kind === 'shop') continue;
      const w = b.w * sc, d = b.d * sc;
      ctx.fillRect(toX(b.x) - w / 2, toY(b.z) - d / 2, w, d);
    }
    // магазины
    for (const s of this.shopsys.shops) {
      ctx.fillStyle = s.owned ? '#ffb43d' : '#59d3ff';
      ctx.beginPath(); ctx.arc(toX(s.x), toY(s.z), s.owned ? 9 : 6, 0, 7); ctx.fill();
      ctx.strokeStyle = '#0009'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    // игрок
    const px = toX(this.game.player.pos.x), py = toY(this.game.player.pos.z);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.moveTo(px, py - 9); ctx.lineTo(px + 6, py + 6); ctx.lineTo(px - 6, py + 6); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#000'; ctx.stroke();
    // подписи районов
    ctx.fillStyle = '#cfe3eecc'; ctx.font = '600 20px "Segoe UI",sans-serif';
    ctx.fillText('Парк Дружбы', toX(-655) - 68, toY(-655) - 6);
    ctx.fillText('Бамбуковый парк', toX(665) - 96, toY(-665) - 6);
    ctx.fillText('Волга', toX(0) - 28, toY(706));
    ctx.fillText('пр. Карла Маркса', toX(0) + 14, toY(-46));
    ctx.font = '600 15px "Segoe UI",sans-serif'; ctx.fillStyle = '#ffd9a0';
    for (const s of this.shopsys.shops) if (s.owned) ctx.fillText(s.name, toX(s.x) + 12, toY(s.z) + 5);
  }

  /* ---------- задания ---------- */
  updateObjectives() {
    const q = this.quest;
    const shop = q.shop;
    const list = [];
    const stock = shop ? this.shopsys.stockCount(shop) : 0;
    list.push({ text: `Зайти в свой магазин «${shop ? shop.name : '—'}»`, done: !!this.insideShop || q.done.visit });
    list.push({ text: 'Заказать товар на полки (B)', done: stock > 0 });
    list.push({ text: 'Открыть магазин (покупатели идут)', done: shop ? shop.open : false });
    list.push({ text: `Обслужить 5 покупателей (${shop ? shop.served : 0}/5)`, done: shop ? shop.served >= 5 : false });
    list.push({ text: `Заработать 5 000 ₽ выручки (${money(shop ? shop.revenue : 0)})`, done: shop ? shop.revenue >= 5000 : false });
    list.push({ text: 'Купить или арендовать второй магазин', done: this.shopsys.owned.length >= 2 });
    this.game.ui.objectives(list, 'Задачи');
    this.objectiveList = list;
  }

  _moneyWatch() {
    const g = this.game;
    if (g.money !== this.lastMoney) {
      this.lastMoney = g.money;
      this.updateObjectives();
    }
  }

  _updateHud() {
    const g = this.game;
    this._hudTimer = (this._hudTimer || 0) + 1;
    if (this._hudTimer % 30 === 0) this.updateObjectives();
    const s = this.insideShop || this.doorShop;
    g.ui.task(s ? `${s.name} · ${s.open ? 'открыт' : 'закрыт'} · товар ${this.shopsys.stockCount(s)}/${this.shopsys.capacity(s)} · выручка ${money(s.dayRevenue)}` : '');
  }

  zoneName() {
    const p = this.game.player.pos;
    if (this.insideShop) return this.insideShop.name;
    if (this.doorShop) return 'у «' + this.doorShop.name + '»';
    return districtName(p.x, p.z);
  }

  openPause() {
    const g = this.game;
    g.closePanel(g.panelOpen);
    const p = g.ui.makePanel('pause', {
      title: 'Пауза', sub: 'ShopSim 0.6', body: '', foot: 'Esc — продолжить',
    });
    const b = p.body;
    b.innerHTML = `<div class="note-inline" style="margin-bottom:14px">Город живёт своей жизнью: время идёт, покупатели приходят. Пауза останавливает игру.</div>`;
    const row = el('div', { class: 'row' });
    const b1 = el('button', { class: 'btn' }, 'Продолжить');
    b1.onclick = () => { g.paused = false; g.closePanel('pause'); };
    const b2 = el('button', { class: 'btn ghost' }, 'Настройки графики');
    b2.onclick = () => { g.closePanel('pause'); g.openPanel('graphics'); };
    const b3 = el('button', { class: 'btn ghost' }, 'Сохранить');
    b3.onclick = () => { this.save(); g.ui.notify('Сохранено', 'good'); };
    const b4 = el('button', { class: 'btn ghost' }, 'Новая игра');
    b4.onclick = () => { clearGame(); location.reload(); };
    const b5 = el('button', { class: 'btn bad' }, 'Выйти в меню');
    b5.onclick = () => { g.closeAllPanels?.(); location.reload(); };
    row.append(b1, b2, b3, b4, b5);
    b.appendChild(row);
    b.appendChild(el('h3', {}, 'Статистика мира'));
    const w = g.city.statistics();
    b.appendChild(el('div', { class: 'kv' }, `
      <span>Домов</span><b>${w.buildings}</b>
      <span>Магазинов и помещений</span><b>${w.shops}</b>
      <span>Деревьев и бамбука</span><b>${w.trees}</b>
      <span>Обслужено покупателей</span><b>${this.shopsys.totalServed}</b>
      <span>Общая выручка</span><b>${money(this.shopsys.totalRevenue)}</b>`));
    g.ui.openPanel('pause');
    g.panelOpen = 'pause';
  }

  save() {
    const g = this.game;
    saveGame({
      v: 6, money: g.money, quest: this.quest, shops: this.shopsys.save(),
      weather: { hour: g.weather.hour, day: g.weather.day },
      player: { x: g.player.pos.x, z: g.player.pos.z, yaw: g.player.yaw },
      totals: { served: this.shopsys.totalServed, revenue: this.shopsys.totalRevenue },
    });
  }
  load() {
    const d = loadGame();
    if (!d || d.v !== 6) return false;
    const g = this.game;
    g.money = d.money ?? g.money;
    this.quest = d.quest || this.quest;
    this.shopsys.load(d.shops);
    if (d.totals) { this.shopsys.totalServed = d.totals.served || 0; this.shopsys.totalRevenue = d.totals.revenue || 0; }
    if (d.player) { g.player.teleport(d.player.x, d.player.z); g.player.yaw = d.player.yaw || 0; }
    if (d.weather) { g.weather.hour = d.weather.hour; g.weather.day = d.weather.day; }
    return true;
  }
}
