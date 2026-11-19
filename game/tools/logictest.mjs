/* Логические тесты ShopSim без браузера и GPU.
   Запуск: node game/tools/logictest.mjs
   Проверяют мир, экономику, покупателей, погоду/сезоны, отсутствие материалов
   про Китай и ключевые места оптимизаций. */
import { register } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

register('./three-loader.mjs', import.meta.url);

/* ---------- заглушки браузера (нужны модулям на этапе импорта) ---------- */
const noop = () => {};
const fakeEl = () => ({
  style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  getContext: () => null, addEventListener: noop, appendChild: noop, remove: noop,
  setAttribute: noop, querySelector: () => null, children: [],
});
globalThis.window = {
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, addEventListener: noop,
  location: { search: '' }, requestAnimationFrame: noop, __argv: null,
};
globalThis.document = {
  createElement: fakeEl, addEventListener: noop, getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [], body: { classList: { toggle: noop } },
  documentElement: { requestFullscreen: noop },
};
const define = (name, value) => {
  try { globalThis[name] = value; } catch (e) { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); }
  if (globalThis[name] !== value) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};
define('navigator', { userAgent: 'node-test', maxTouchPoints: 0, hardwareConcurrency: 8, getGamepads: () => [] });
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
define('performance', { now: () => Date.now() });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, info = '') => results.push({ name, ok: !!ok, info });

/* ---------- мир ---------- */
const gen = await import('../src/world/gen.js');
const city = gen.generateCity();
const grove = gen.PARK_GROVE;
check('город: домов > 300', city.buildings.length > 300, `${city.buildings.length}`);
check('город: магазинов > 40', city.shops.length > 40, `${city.shops.length}`);
check('мир: бамбука в данных нет', !('bamboo' in city) && !('pagoda' in city), Object.keys(city).join(','));
check('парк: Берёзовая роща на месте бамбукового', grove.name === 'Берёзовая роща' && gen.inPark(grove.cx, grove.cz) === grove, grove.name);
check('парк: район называется по-новому', gen.districtName(grove.cx, grove.cz) === 'Берёзовая роща', gen.districtName(grove.cx, grove.cz));
const groveTrees = city.trees.filter((t) => Math.hypot(t.x - grove.cx, t.z - grove.cz) < grove.r);
check('парк: деревья в роще > 200', groveTrees.length > 200, `${groveTrees.length}`);
check('парк: берёзы преобладают', groveTrees.filter((t) => t.type === 'birch').length > groveTrees.length * 0.4, `${groveTrees.filter((t) => t.type === 'birch').length}`);
check('парк: магазины не стоят в роще', !city.shops.some((s) => Math.hypot(s.x - grove.cx, s.z - grove.cz) < grove.r), `${city.shops.length}`);
check('парк: дорожки есть', city.paths.length >= 40, `${city.paths.length}`);
check('мир: все координаты конечные', city.buildings.every((b) => Number.isFinite(b.x) && Number.isFinite(b.z)));

/* ---------- магазины и покупатели ---------- */
const shopsMod = await import('../src/game/shops.js');
const notes = [];
const fakeGame = {
  money: 1000000,
  city: { data: city },
  stats: { served: 0, revenue: 0 },
  weather: { hour: 10, day: 1, night: 0 },
  ui: { notify: (t, k) => notes.push(`${k || ''}:${t}`) },
};
const sys = new shopsMod.ShopSystem(fakeGame);
sys.init(city.shops);
const shop = sys.starter;
check('стартовый магазин выдан', !!shop && shop.owned && shop.open, shop && shop.name);
check('стартовый магазин с товаром', sys.stockCount(shop) > 0, `${sys.stockCount(shop)}`);
check('категория товара не затёрта складом', !!shopsMod.GOODS[shop.cat] && typeof shop.stock === 'object', `${shop.cat} / ${typeof shop.stock}`);

// заказы удобнее проверять на магазине со свободными полками
const shop2 = { ...shop, id: 't', stock: {}, fixtures: [{ id: 'shelf_l' }, { id: 'shelf_s' }], owned: true, open: false };
const cap2 = sys.capacity(shop2);
check('заказ больше свободных мест отклонён', sys.order(shop2, 'bread', cap2 + 5, fakeGame.money).ok === false);
check('заказ без денег отклонён', sys.order(shop2, 'bread', 1, 0).ok === false);
const okOrder = sys.order(shop2, 'bread', 5, fakeGame.money);
check('обычный заказ проходит', okOrder.ok && sys.stockCount(shop2) === 5, `${sys.stockCount(shop2)} / ${cap2}`);

const empty = { ...shop, id: 'x', stock: {}, fixtures: [{ id: 'counter' }], owned: true };
check('нельзя открыть магазин без товара', sys.openShop(empty).ok === false);

const poor = { ...shop, owned: false, rented: false };
fakeGame.money = 10;
check('аренда без денег отклонена', sys.rent(poor, fakeGame.money).ok === false);
fakeGame.money = 1000000;
const rentRes = sys.rent(poor, fakeGame.money);
check('аренда списывает аренду + залог', rentRes.ok && rentRes.cost === poor.rent * 2, `${rentRes.cost}`);

// покупатели: 2 минуты игрового времени
fakeGame.money = 0;
const revBefore = shop.revenue;
for (let i = 0; i < 30 * 120; i++) sys.update(1 / 30);
const served = shop.served;
const paid = shop.revenue;
check('покупатели приходят и платят', served > 0 && paid > revBefore, `обслужено ${served}, выручка ${Math.round(paid)}`);
check('у покупателей не NaN-ожидание', sys.buyers.every((b) => Number.isFinite(b.wait) || b.phase !== 'topay'));
check('деньги начисляются игроку', fakeGame.money > 0, `${Math.round(fakeGame.money)}`);

// сохранение аренды: срок оплаты не должен теряться
const realShop = sys.shops.find((x) => !x.owned);
fakeGame.money = 1000000;
sys.rent(realShop, fakeGame.money);
const saveData = JSON.parse(JSON.stringify(sys.save()));
const sys2 = new shopsMod.ShopSystem(fakeGame);
sys2.init(city.shops);
sys2.load(saveData);
const rented = sys2.shops.find((x) => x.rented);
check('аренда переживает сохранение', !!rented && Number.isFinite(rented.rentPaidUntil), rented && rented.rentPaidUntil);

// ночное закрытие и утреннее открытие
const auto = sys.starter;
auto.open = true;
fakeGame.weather.hour = 23;
fakeGame.weather.night = 1;
sys.update(1 / 30);
const closedAtNight = !auto.open && auto.closedByNight === true;
fakeGame.weather.hour = 10;
fakeGame.weather.night = 0;
sys.update(1 / 30);
check('магазин закрывается ночью и открывается утром', closedAtNight && auto.open === true, `${closedAtNight} → ${auto.open}`);
fakeGame.weather.night = 0;

/* ---------- погода и сезоны ---------- */
const { Weather } = await import('../src/world/weather.js');
const { settings } = await import('../src/core/settings.js');
const THREE = await import('../vendor/three.module.js');
const scene = new THREE.Scene();
const w = new Weather(scene);
w.camera = new THREE.PerspectiveCamera();
settings.season = 'summer';
settings.weather = 'auto';
w.applySettings();
for (let i = 0; i < 30 * 40; i++) w.update(1 / 30);
check('летом осадки — дождь, не снег', w.snowAmount === 0 && w.rainAmount >= 0, `${w.rainAmount.toFixed(2)}`);
check('время идёт', w.hour > 10, w.hour.toFixed(2));
check('цвет неба конечный', Number.isFinite(w.skyTop.r) && Number.isFinite(w.fogColor.b));

settings.season = 'winter';
w.applySettings();
for (let i = 0; i < 30 * 20; i++) w.update(1 / 30);
check('зимой идёт снег, а не дождь', w.snowAmount > 0.02 && w.rainAmount === 0, `снег ${w.snowAmount.toFixed(2)}`);
check('зимой поверхность не «мокрая»', w.wetness === 0);
check('снег рисуется точками', !!w.snowMesh && w.snowMesh.isPoints === true);
check('дождевые линии зимой выключены', w.rainMesh.visible === false);

const covA = w.cloudCoverage;
w.recalc(); w.recalc();
check('облачность не зависит от переключения сезона', Math.abs(w.cloudCoverage - covA) < 1e-6, `${w.cloudCoverage}`);

settings.season = 'summer';
w.applySettings();
check('возврат в лето выключает снег', w.snowAmount === 0 || w.rainTarget < 0.2);

// режимы погоды из README: cloudy/fog/snow реально меняют небо и туман
w.rain = 0; settings.weather = 'cloudy'; w.applySettings(); w.recalc();
const covCloudy = w.cloudCoverage;
w.rain = 0; settings.weather = 'fog'; w.applySettings(); w.recalc();
const fogDensity = w.fogDensity;
const fogCov = w.cloudCoverage;
w.rain = 0; settings.weather = 'clear'; w.applySettings(); w.recalc();
const covClear = w.cloudCoverage;
const clearDensity = w.fogDensity;
check('облачно/туман поднимают облачность', covCloudy > covClear + 0.2 && fogCov > covCloudy, `${covClear.toFixed(2)} → ${covCloudy.toFixed(2)} → ${fogCov.toFixed(2)}`);
check('режим «туман» плотнее ясной погоды', fogDensity > clearDensity + 0.001, `${clearDensity.toFixed(4)} → ${fogDensity.toFixed(4)}`);
settings.weather = 'auto'; w.applySettings();

/* ---------- статические проверки кода ---------- */
const walk = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs|html|css)$/.test(name)) out.push(p);
  }
  return out;
};
const files = [...walk(path.join(root, 'src')), path.join(root, 'index.html')];
const banned = [/бамбук/i, /bamboo/i, /beijing/i, /пекин/i, /китай/i, /пагод/i, /tiananmen/i, /[\u4e00-\u9fff]/];
const hits = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const re of banned) {
    if (re.test(text)) hits.push(path.relative(root, f) + ' → ' + re);
  }
}
check('в коде нет упоминаний Китая/бамбука/иероглифов', hits.length === 0, hits.slice(0, 5).join('; '));

const skySrc = readFileSync(path.join(root, 'src/gfx/sky.js'), 'utf8');
check('облака: шаги марча — uniform', /uCloudSteps/.test(skySrc) && !/const int STEPS = 40/.test(skySrc));
check('облака: 4 октавы шума', /for \(int i = 0; i < 4; i\+\+\)/.test(skySrc));
const postSrc = readFileSync(path.join(root, 'src/gfx/post.js'), 'utf8');
check('постобработка: материал копирования не создаётся в кадре', /this\.copyMat/.test(postSrc) && postSrc.includes('this._pass(this.copyMat'));
const grassSrc = readFileSync(path.join(root, 'src/gfx/grass.js'), 'utf8');
check('трава: сезон в шейдере, без пересборки чанков', /tint \*= vec3\(1\.42/.test(grassSrc) && !/applySeason\(season\) \{[\s\S]{0,200}rebuild\(\)/.test(grassSrc));
check('трава: зимой выключается', /this\.winter = season === 'winter'/.test(grassSrc));
const mainSrc = readFileSync(path.join(root, 'src/main.js'), 'utf8');
check('телепорт в Пекин удалён', !/teleportBeijing|params\.has\('bj'\)/.test(mainSrc));

/* ---------- отчёт ---------- */
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.info ? ' — ' + r.info : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
if (typeof window !== 'undefined') window.__logicReport = { ok: results.filter((r) => r.ok).length, total: results.length, results };
process.exitCode = failed ? 1 : 0;
