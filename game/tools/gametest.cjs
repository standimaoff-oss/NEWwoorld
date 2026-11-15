/* Автотест геймплея в headless Chromium: магазин, покупатели, деньги, сохранение. */
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const W = 900, H = 520;
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok, info }); };

(async () => {
  const browser = await puppeteer.launch({
    args: [...chromium.args, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=3072'],
    executablePath: await chromium.executablePath(), headless: 'shell', protocolTimeout: 400000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  const logs = [];
  page.on('console', (m) => { if (!/Clock: This module/.test(m.text())) logs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));
  await page.goto('http://127.0.0.1:8123/game/index.html?hour=10&fresh=1', { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction('window.__ready === true', { timeout: 240000 });
  await new Promise((r) => setTimeout(r, 3000));

  const ev = (fn, ...args) => page.evaluate(fn, ...args);

  // 1. мир собран
  const world = await ev(() => window.__api.world());
  check('мир: дома > 300', world && world.buildings > 300, JSON.stringify(world));
  check('мир: магазинов > 40', world && world.shops > 40, JSON.stringify(world));
  check('мир: деревьев > 500', world && world.trees > 500, JSON.stringify(world));

  // 2. стартовый магазин выдан
  const start = await ev(() => {
    const s = window.__game.gameplay.shopsys.starter;
    return s ? { id: s.id, name: s.name, owned: s.owned, open: s.open, stock: window.__game.gameplay.shopsys.stockCount(s) } : null;
  });
  check('стартовый магазин выдан и открыт', start && start.owned && start.open, JSON.stringify(start));

  // 3. покупатели приходят и платят
  await ev(() => {
    const g = window.__game, s = g.gameplay.shopsys.starter;
    g.player.teleport(s.x, s.z + 3);
    s.reputation = 1;
    g.gameplay.shopsys.buyers.length = 0;
  });
  const moneyBefore = await ev(() => window.__game.money);
  // ускоряем симуляцию, не полагаясь на реальный FPS headless-браузера
  await ev(() => {
    const ss = window.__game.gameplay.shopsys;
    for (let i = 0; i < 900; i++) ss.update(1 / 15);
  });
  const after = await ev(() => {
    const g = window.__game, s = g.gameplay.shopsys.starter;
    return { served: s.served, revenue: s.revenue, money: g.money, buyers: g.gameplay.shopsys.buyers.length, stock: g.gameplay.shopsys.stockCount(s) };
  });
  check('покупатели обслуживаются (>=2)', after.served >= 2, JSON.stringify(after));
  check('деньги растут от продаж', after.money > moneyBefore, `${moneyBefore} -> ${after.money}`);
  check('товар на полках тратится', after.stock < 120, `осталось ${after.stock}`);

  // 4. заказ товара
  const order = await ev(() => {
    const g = window.__game, s = g.gameplay.shopsys.starter;
    const m0 = g.money;
    // освобождаем место на полках, как в игре после продаж
    for (const k in s.stock) s.stock[k] = Math.max(0, s.stock[k] - 8);
    const r = g.gameplay.shopsys.order(s, 'bread', 5, g.money);
    if (r.ok) g.money -= r.cost;
    return { r, m0, m1: g.money, stock: s.stock.bread };
  });
  check('заказ товара работает', order.r.ok && order.stock >= 5 && order.m1 < order.m0, JSON.stringify(order));

  // 5. покупка оборудования
  const fix = await ev(() => {
    const g = window.__game, s = g.gameplay.shopsys.starter;
    g.money = 500000;
    const before = s.fixtures.length;
    const r = g.gameplay.shopsys.buyFixture(s, 'basket', g.money);
    if (r.ok) g.money -= r.cost;
    return { r, before, after: s.fixtures.length };
  });
  check('покупка оборудования', fix.r.ok && fix.after === fix.before + 1, JSON.stringify(fix));

  // 6. аренда второго магазина
  const rent = await ev(() => {
    const g = window.__game;
    g.money = 500000;
    const s = g.gameplay.shopsys.shops.find((x) => !x.owned);
    const m0 = g.money;
    const r = g.gameplay.shopsys.rent(s, g.money);
    if (r.ok) g.money -= r.cost;
    return { ok: r.ok, owned: g.gameplay.shopsys.owned.length, money: g.money, m0, name: s.name };
  });
  check('аренда второго магазина', rent.ok && rent.owned >= 2, JSON.stringify(rent));

  // 7. сохранение/загрузка
  const save = await ev(() => {
    const g = window.__game;
    g.gameplay.save();
    return { owned: g.gameplay.shopsys.owned.length, money: g.money, raw: !!localStorage.getItem('shopsim.save.v6') };
  });
  check('сохранение в localStorage', save.raw, JSON.stringify(save));

  // 8. графика переключается
  const quality = await ev(() => {
    const g = window.__game;
    const out = [];
    for (const k of ['low', 'medium', 'high']) {
      g.setQuality(k);
      out.push({ q: k, density: +(g.grass ? g.grass.density : 0).toFixed(2), radius: g.grass ? g.grass.radius : 0 });
    }
    return out;
  });
  check('качество графики переключается', quality.length === 3 && quality[0].radius < quality[2].radius, JSON.stringify(quality));

  // 9. сезоны
  const seasons = await ev(() => {
    const g = window.__game;
    const out = {};
    for (const s of ['summer', 'autumn', 'winter']) { g.setSeason(s); out[s] = g.grass ? g.grass.uniforms.uSeason.value : -1; }
    return out;
  });
  check('сезоны травы', seasons.summer === 0 && seasons.autumn === 1 && seasons.winter === 2, JSON.stringify(seasons));

  // 10. погода: дождь должен нарастать
  const weather = await ev(async () => {
    const g = window.__game;
    const before = g.weather.rain;
    window.__api.setWeather('rain');
    // ждём реального времени: погода плавно интерполируется в update(dt)
    for (let i = 0; i < 400; i++) {
      g.weather.update(0.05);
      if (g.weather.rain > 0.6) break;
    }
    const rain = g.weather.rain;
    window.__api.setWeather('clear');
    for (let i = 0; i < 400; i++) { g.weather.update(0.05); if (g.weather.rain < 0.05) break; }
    return { before: +before.toFixed(2), rain: +rain.toFixed(2), clear: +g.weather.rain.toFixed(2) };
  });
  check('дождь включается и выключается', weather.rain > 0.5 && weather.clear < 0.2, JSON.stringify(weather));

  // 11. время суток
  const tod = await ev(() => {
    const g = window.__game;
    window.__api.setHour(3);
    const night = g.weather.night;
    window.__api.setHour(13);
    const day = g.weather.night;
    return { night, day };
  });
  check('день/ночь', tod.night > 0.9 && tod.day < 0.1, JSON.stringify(tod));

  // 12. карта и панели открываются
  const panels = await ev(() => {
    const g = window.__game;
    const out = {};
    for (const p of ['catalog', 'map', 'shop', 'graphics']) {
      try { g.openPanel(p); out[p] = !document.getElementById('panel-' + p).classList.contains('hidden'); g.closePanel(p); }
      catch (e) { out[p] = 'ERR ' + e.message; }
    }
    return out;
  });
  check('панели открываются', Object.values(panels).every((v) => v === true), JSON.stringify(panels));

  // 13. ошибок в консоли нет
  const errs = await ev(() => window.ShopLog.dump().errors);
  check('нет ошибок JS', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  console.log(JSON.stringify({
    passed: results.filter((r) => r.ok).length, total: results.length,
    results, logs: logs.filter((l) => /ERROR|PAGEERROR/.test(l)).slice(0, 10),
  }, null, 1));
  await browser.close();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})().catch((e) => { console.error('FAIL', e); process.exit(2); });
