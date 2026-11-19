/* Самопроверка в браузере: `?test` или `?headless`.
   Проверяет мир, экономику, сезоны и отсутствие ошибок, печатает отчёт
   в консоль и кладёт его в window.__testReport — по нему смотрят автотесты. */
export async function runTests(game, w) {
  const out = [];
  const check = (name, ok, info = '') => out.push({ name, ok: !!ok, info: String(info) });
  const step = (ms) => new Promise((r) => setTimeout(r, ms));

  // renderer живёт в game, а не в наборе мира: раньше он приходил undefined,
  // и проверка «кадры рисуются» падала с TypeError прямо в отчёте
  const { city, weather, grass, gameplay, player } = w;
  const renderer = game.renderer;
  const sys = gameplay.shopsys;

  const stats = city.statistics();
  check('мир собран', stats.buildings > 300 && stats.shops > 40 && stats.trees > 500, JSON.stringify(stats));
  check('прохожие есть', gameplay.people.length > 0, gameplay.people.length);

  const starter = sys.starter;
  check('стартовый магазин выдан и открыт', !!starter && starter.owned && starter.open, starter && starter.name);
  check('на полках есть товар', starter && sys.stockCount(starter) > 0, starter && sys.stockCount(starter));

  // покупатели: прокручиваем симуляцию, не полагаясь на частоту кадров
  const money0 = game.money;
  const served0 = starter ? starter.served : 0;
  if (starter) for (let i = 0; i < 450; i++) sys.update(1 / 15);
  check('покупатели платят', !!starter && starter.served > served0 && game.money > money0,
    `${served0} → ${starter && starter.served}, деньги ${Math.round(game.money)}`);

  // сезоны: зимой трава не рисуется, идёт снег, газон под снегом
  game.setSeason('winter');
  for (let i = 0; i < 60; i++) weather.update(1 / 30);
  check('зимой трава выключена', grass.enabled === false && grass.group.visible === false, `enabled=${grass.enabled}`);
  check('зимой идёт снег', weather.snowAmount > 0.02 && weather.rainMesh.visible === false, weather.snowAmount.toFixed(2));
  check('зимой газон под снегом', city._season === 'winter' && !!city.materials.grass.map, city._season);
  check('зимой кусты и пучки травы в снегу, а не спрятаны',
    !!(city.tuftMesh && city.tuftMesh.visible) && (city.shrubMeshes || []).every((m) => m.visible),
    `пучки ${city.tuftMesh && city.tuftMesh.visible}, кустов ${(city.shrubMeshes || []).filter((m) => m.visible).length}`);
  game.setSeason('summer');
  for (let i = 0; i < 90; i++) weather.update(1 / 30);
  check('летом трава снова рисуется', grass.enabled === true, `enabled=${grass.enabled}`);

  // постобработка и качество связаны
  game.setQuality('low');
  check('низкое качество: постобработка без AO', game.post && game.post.useAO === false, game.post && game.post.level);
  game.setQuality('high');
  check('высокое качество: AO включён', game.post && game.post.useAO === true, game.post && game.post.level);

  // облака не «залипают» на максимуме при переключении сезона
  const cov0 = weather.cloudCoverage;
  for (let i = 0; i < 4; i++) game.setSeason(i % 2 ? 'summer' : 'winter');
  for (let i = 0; i < 5; i++) weather.recalc();
  check('облачность не накапливается', Math.abs(weather.cloudCoverage - cov0) < 0.02, `${cov0.toFixed(2)} → ${weather.cloudCoverage.toFixed(2)}`);
  game.setSeason('summer');

  // карта и панели
  const panels = ['map', 'graphics', 'catalog', 'shop', 'pause'];
  let panelsOk = true;
  for (const p of panels) {
    try { game.openPanel(p); panelsOk = panelsOk && game.ui.isPanelOpen(p); game.closePanel(p); }
    catch (e) { panelsOk = false; }
  }
  check('панели открываются', panelsOk);

  // ошибки JS
  const errs = (window.ShopLog && window.ShopLog.dump().errors) || [];
  check('в журнале нет ошибок', !errs.length, errs.slice(0, 2).join(' | '));

  check('кадры рисуются', renderer.fps > 0 && renderer.drawCalls > 0, `${renderer.fps} fps, ${renderer.drawCalls} вызовов`);

  const report = {
    ok: out.filter((r) => r.ok).length, total: out.length,
    fps: renderer.fps, calls: renderer.drawCalls, tris: renderer.triangles,
    world: stats, results: out,
  };
  window.__testReport = report;
  console.log('SELFTEST ' + JSON.stringify(report, null, 1));
  return report;
}
