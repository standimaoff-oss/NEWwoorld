/* Снимает экран игры в headless Chromium (SwiftShader) и собирает ошибки консоли.
   Использование: node shot.js out.png "?hour=9&spawn=8,0.2,22,20" [wait_ms] [w] [h]
   Переменные: ARGS (url-параметры), TEST=1 — запустить автотест. */
const chromium = require('@sparticuz/chromium').default;
const puppeteer = require('puppeteer-core');
const path = require('path');

const out = process.argv[2] || '/tmp/shot.png';
const query = process.argv[3] || '';
const wait = parseInt(process.argv[4] || '9000', 10);
const W = parseInt(process.argv[5] || '1280', 10);
const H = parseInt(process.argv[6] || '720', 10);
const URL = `http://127.0.0.1:8123/game/index.html${query}`;

(async () => {
  const execPath = await chromium.executablePath();
  const browser = await puppeteer.launch({
    args: [...chromium.args, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=2048'],
    executablePath: execPath, headless: 'shell', protocolTimeout: 240000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => logs.push(m.type().toUpperCase() + ': ' + m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', (r) => logs.push('REQFAIL: ' + r.url() + ' ' + (r.failure() || {}).errorText));
  await page.goto(URL, { waitUntil: 'load', timeout: 120000 });
  try {
    await page.waitForFunction('window.__ready === true', { timeout: wait + 60000 });
  } catch (e) { logs.push('WARN: __ready timeout'); }
  await new Promise((r) => setTimeout(r, wait));
  // продвинуть время/кадры для стабильности
  const info = await page.evaluate(() => {
    const g = window.__game;
    if (!g) return { error: 'no game' };
    return {
      fps: g.renderer.fps, calls: g.renderer.drawCalls, tris: g.renderer.triangles,
      pos: g.player ? [g.player.pos.x.toFixed(1), g.player.pos.z.toFixed(1)] : null,
      hour: g.weather ? g.weather.hour.toFixed(2) : null,
      grass: g.grassStats || null,
      logs: window.ShopLog ? window.ShopLog.dump() : null,
    };
  }).catch((e) => ({ error: String(e) }));
  await page.screenshot({ path: out });
  console.log(JSON.stringify({ out, info, logs: logs.slice(-60) }, null, 1));
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
