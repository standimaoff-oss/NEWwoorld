/* Пакет снимков за один запуск браузера. node shots.cjs shots.json [w] [h] */
const chromium = require('@sparticuz/chromium').default;
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const cfgPath = process.argv[2] || '/tmp/shots.json';
const W = parseInt(process.argv[3] || '1280', 10);
const H = parseInt(process.argv[4] || '720', 10);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const OUTDIR = cfg.outdir || '/tmp/shots';
fs.mkdirSync(OUTDIR, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({
    args: [...chromium.args, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=3072'],
    executablePath: await chromium.executablePath(), headless: 'shell', protocolTimeout: 300000, dumpio: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => { const t = m.text(); if (!/Clock: This module/.test(t)) logs.push(m.type().toUpperCase() + ': ' + t); });
  page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));
  await page.goto(`http://127.0.0.1:8123/game/index.html?${cfg.query || 'hour=10'}`, { waitUntil: 'load', timeout: 120000 });
  try { await page.waitForFunction('window.__ready === true', { timeout: 180000 }); } catch (e) { logs.push('WARN: no ready'); }
  await new Promise((r) => setTimeout(r, cfg.warmup || 4000));
  const results = [];
  for (const shot of cfg.shots) {
    if (shot.hour !== undefined) await page.evaluate((h) => window.__api.setHour(h), shot.hour);
    if (shot.weather) await page.evaluate((w) => window.__api.setWeather(w), shot.weather);
    if (shot.season) await page.evaluate((s) => window.__api.setSeason(s), shot.season);
    if (shot.rain !== undefined) await page.evaluate((r) => {
      const w = window.__game.weather; w.rain = r; w.rainTarget = r; w.wetness = r; w.recalc();
    }, shot.rain);
    if (shot.cam) await page.evaluate((c) => window.__api.setCam(...c), shot.cam);
    if (shot.teleport) await page.evaluate((p) => window.__api.teleport(...p), shot.teleport);
    if (shot.eval) { try { await page.evaluate(shot.eval); } catch (e) { logs.push('EVALFAIL: ' + e.message); } }
    await new Promise((r) => setTimeout(r, shot.wait || 3500));
    let st = null;
    try {
      st = await page.evaluate(() => ({ ...window.__api.stats(), probe: window.__probe || null }));
      await page.screenshot({ path: path.join(OUTDIR, shot.name + '.png') });
      results.push({ name: shot.name, stats: st });
    } catch (e) {
      logs.push('SHOTFAIL ' + shot.name + ': ' + e.message);
      results.push({ name: shot.name, error: e.message });
      break;
    }
  }
  console.log(JSON.stringify({ results, logs: logs.slice(-40) }, null, 1));
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
