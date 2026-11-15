// Chromium/WebGL2 verification for the standalone China_3D.html.
// Run: node tools/verify_china_3d.cjs
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = '/home/user/NEWwoorld';
const CACHE = path.join(ROOT, '.cache/china-preview/node_modules');
const resolve = name => require.resolve(name, { paths: [CACHE] });
const chromium = require(resolve('@sparticuz/chromium'));
const { chromium: pw } = require(resolve('playwright-core'));
const OUT = path.join(ROOT, 'docs/china-3d');
const FILE = path.join(ROOT, 'China_3D.html');
const URL = 'file://' + FILE + '?quality=medium';
fs.mkdirSync(OUT, { recursive: true });

const report = {
  started: new Date().toISOString(),
  result: 'RUNNING',
  file: 'China_3D.html',
  sha256: crypto.createHash('sha256').update(fs.readFileSync(FILE)).digest('hex'),
  bytes: fs.statSync(FILE).size,
  phases: {}, errors: [], warnings: [], external: [],
};
function save() { fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify(report, null, 2) + '\n'); }
function wire(page, tag) {
  page.on('console', m => {
    if (m.type() === 'error') report.errors.push(`${tag}: console: ${m.text()}`);
    if (m.type() === 'warning') report.warnings.push(`${tag}: ${m.text()}`);
  });
  page.on('pageerror', e => report.errors.push(`${tag}: pageerror: ${String(e)}`));
  page.on('request', r => { if (/^https?:/.test(r.url())) report.external.push(`${tag}: ${r.url()}`); });
}
async function launch() {
  return pw.launch({
    executablePath: await chromium.executablePath(), args: chromium.args, headless: true,
    env: { ...process.env, LD_LIBRARY_PATH: '/tmp/chromium-libs/lib:/tmp' },
  });
}
async function ready(page, url = URL, timeout = 180000) {
  await page.goto(url, { waitUntil: 'load', timeout });
  await page.waitForFunction(() => (window.__CHINA3D_READY__ && window.__CHINA3D__?.state.ready) || !document.querySelector('#error')?.hidden, null, { timeout });
  const fatal = await page.evaluate(() => document.querySelector('#error')?.hidden ? null : document.querySelector('#error').textContent);
  if (fatal) throw new Error(fatal);
  await page.evaluate(() => { window.__CHINA3D__.state.paused = true; });
}
async function shot(page, name, clean = true) {
  await page.evaluate(() => {
    const C = window.__CHINA3D__;
    C.state.freeze = true;
    C.lighting(2); C.lighting(2);
    C.render(); C.render();
  });
  await page.evaluate(v => document.body.classList.toggle('clean', v), clean);
  await page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 180000 });
  (report.phases.screenshots = report.phases.screenshots || []).push(name);
  await page.evaluate(() => { window.__CHINA3D__.state.freeze = false; });
  save();
}

(async () => {
  let browser = await launch();
  try {
    // ---- Static standalone / attribution checks ----
    const html = fs.readFileSync(FILE, 'utf8');
    report.phases.static = {
      hasODbL: html.includes('ODbL 1.0'),
      hasAttribution: html.includes('© OpenStreetMap contributors'),
      noExternalScript: !/<script[^>]+src\s*=\s*["']https?:/i.test(html) &&
        !/<link[^>]+href\s*=\s*["']https?:/i.test(html) &&
        !/<img[^>]+src\s*=\s*["']https?:/i.test(html) &&
        !/@import\s+url\(\s*["']?https?:/i.test(html),
      hasInlineData: html.includes('window.__CHINA3D_DATA__='),
      hasInlineAssets: html.includes('window.__CHINA_ASSETS__='),
      rawOsmExtract: fs.existsSync(path.join(ROOT, 'docs/beijing-osm-3d/osm-map.json')),
      rawProvenance: fs.existsSync(path.join(ROOT, 'docs/beijing-osm-3d/osm-source.json')),
    };
    save();

    // ---- Desktop: load, exact OSM data, UI, screenshots ----
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    wire(page, 'desktop');
    await ready(page);
    report.phases.runtime = await page.evaluate(() => {
      const C = window.__CHINA3D__;
      const gl = C.renderer.getContext();
      return {
        ready: C.state.ready, webgl2: gl instanceof WebGL2RenderingContext,
        glVersion: gl.getParameter(gl.VERSION), perspective: C.camera.isPerspectiveCamera === true,
        fov: C.camera.fov, title: document.title,
        fontLoaded: document.fonts.check('20px NotoPreview'),
        attribution: C.meta.attribution, license: C.meta.license,
        caveats: C.meta.caveats.length,
        caveatCount: document.querySelectorAll('#caveatList li').length,
        dataNoteCount: document.querySelectorAll('#dataNotes li').length,
        layerControls: document.querySelectorAll('#layers input').length,
        viewButtons: document.querySelectorAll('.view-btn').length,
        labelElements: document.querySelectorAll('.osm-label').length,
        appErrors: C.errors.length,
        triangles: C.info().triangles, drawCalls: C.info().calls,
      };
    });
    report.phases.geometry = await page.evaluate(() => {
      const C = window.__CHINA3D__, D = C.data, clip = C.meta.clipBBoxMeters;
      const ids = new Set(D.features.map(f => f.id));
      const required = ['w4922662', 'w267371087', 'w425993664', 'w929701515', 'w625847762', 'w931453417', 'r21434020'];
      let outside = 0, badCenter = 0, maxY = 0, maxSpan = 0;
      for (const key of ['areas', 'buildings', 'lines']) for (const x of D[key]) {
        for (const ring of (x.rings || []).flatMap(r => [r.outer, ...(r.holes || [])])) for (const [px, pz] of ring) {
          if (px < clip[0] - .01 || px > clip[2] + .01 || pz < clip[1] - .01 || pz > clip[3] + .01) outside++;
        }
        for (const [px, pz] of x.points || []) if (px < clip[0] - .01 || px > clip[2] + .01 || pz < clip[1] - .01 || pz > clip[3] + .01) outside++;
        for (const [x0, z0, x1, z1] of [x.bbox]) maxSpan = Math.max(maxSpan, x1 - x0, z1 - z0);
      }
      for (const f of D.features) {
        if (!f.bbox || !f.hasGeometry) continue;
        const [x0, z0, x1, z1] = f.bbox, [cx, cz] = f.center;
        if (cx < x0 - 1 || cx > x1 + 1 || cz < z0 - 1 || cz > z1 + 1) badCenter++;
      }
      const buildingMeshes = C.sceneObj.groups.buildings.children.filter(o => o.isMesh);
      for (const m of buildingMeshes) {
        const p = m.geometry.attributes.position;
        for (let i = 1; i < p.count; i += 3) maxY = Math.max(maxY, p.getY(i));
      }
      return {
        featureIdsUnique: ids.size === D.features.length,
        requiredIdsPresent: required.every(id => ids.has(id)),
        w929701515IsBuilding: D.buildings.some(b => b.featureId === 'w929701515'),
        barrierRingsAreWalls: ['w625847762', 'w931453417'].every(id => D.lines.some(l => l.featureId === id && l.kind === 'barrier')),
        r21434020IsPavingArea: D.areas.some(a => a.featureId === 'r21434020' && a.kind === 'paving' && a.layer === 'roads'),
        buildingHeightMaxMeters: maxY,
        is3D: maxY > 40,
        streetLevelView: C.views.some(v => v.pos[1] < 10),
        pointsOutsideClip: outside, centersOutsideBBox: badCenter,
        largestFeatureSpanMeters: Math.round(maxSpan),
        stats: C.meta.stats,
        externalHeight: C.meta.externalHeightSources[0],
        caveatsMentionBarriers: C.meta.caveats.some(c => /barrier|забор/i.test(c)),
        caveatsMentionHeights: C.meta.caveats.some(c => /height|высот/i.test(c)),
        caveatsMentionClipping: C.meta.caveats.some(c => /обрезан|буфер|неполн|вне буфера/i.test(c)),
        caveatsMentionLicense: C.meta.caveats.some(c => /ODbL|атрибуц/i.test(c)),
        caveatsMentionBuildingCoverage: C.meta.caveats.some(c => /building-контур|неравномерное/i.test(c)),
      };
    });
    save();

    // Search by Russian alias and exact OSM feature focus.
    await page.fill('#search', 'Нанлугусян');
    report.phases.search = await page.evaluate(() => ({
      results: document.querySelectorAll('#searchResults .result').length,
      first: document.querySelector('#searchResults .result b')?.textContent || '',
    }));
    await page.locator('#searchResults .result').first().click();
    await page.evaluate(() => window.__CHINA3D__.focusFeature('w4922662'));
    report.phases.selection = await page.evaluate(() => ({
      selectedId: window.__CHINA3D__.state.selectedId,
      infoHasId: document.querySelector('#info')?.textContent.includes('w4922662'),
      infoHasAttribution: document.querySelector('#info')?.textContent.includes('© OpenStreetMap contributors'),
      selectionBox: !!window.__CHINA3D__.scene.children.find(o => o.type === 'Box3Helper'),
    }));
    // Layer and disclosure controls.
    await page.uncheck('#layer-details');
    const detailsOff = await page.evaluate(() => ({ layer: window.__CHINA3D__.state.layers.details, group: window.__CHINA3D__.sceneObj.groups.details.visible }));
    await page.check('#layer-details');
    await page.check('#allLabels');
    report.phases.controls = {
      detailsOff,
      detailsOn: await page.evaluate(() => window.__CHINA3D__.state.layers.details),
      allLabels: await page.evaluate(() => window.__CHINA3D__.state.showAllLabels),
    };
    await page.uncheck('#allLabels');
    await page.click('[data-weather="rain"]');
    await page.evaluate(() => { const C = window.__CHINA3D__; C.setHour(22); C.lighting(2); C.lighting(2); });
    report.phases.weather = await page.evaluate(() => ({ weather: window.__CHINA3D__.state.weather, rain: window.__CHINA3D__.U.rain.value, night: window.__CHINA3D__.U.night.value }));
    await page.click('[data-weather="clear"]');
    await page.evaluate(() => { const C = window.__CHINA3D__; C.setHour(16.4); C.setView(0, true); C.selectFeature(null); C.lighting(2); C.lighting(2); });
    await shot(page, '00-ui', false);

    // Clean 3D views, including street-level hutongs and monuments.
    const views = [[0, '01-overview'], [1, '02-nanluoguxiang'], [2, '03-hutongs'], [3, '04-drum-tower'], [4, '05-bell-tower'], [6, '06-houhai']];
    for (const [i, name] of views) {
      await page.evaluate(i => window.__CHINA3D__.setView(i, true), i);
      await shot(page, name, true);
    }
    await page.evaluate(() => { const C = window.__CHINA3D__; C.setView(8, true); C.setWeather('rain'); C.setHour(22); });
    await shot(page, '07-rain-night', true);
    await page.evaluate(() => { const C = window.__CHINA3D__; C.setWeather('clear'); C.setHour(16.4); C.setView(0, true); document.body.classList.remove('clean'); });

    // Canvas is really painted, not a blank WebGL clear colour.
    report.phases.canvas = await page.evaluate(() => {
      const C = window.__CHINA3D__, gl = C.renderer.getContext();
      C.state.freeze = true; C.render(); C.render();
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, w = 64, h = 64;
      const patches = [
        [(W - w) >> 1, (H - h) >> 1],
        [(W - w) >> 1, Math.floor(H * .18)],
        [Math.floor(W * .22), Math.floor(H * .30)],
        [Math.floor(W * .72), Math.floor(H * .30)],
      ];
      const colors = new Set(); let sum = 0, sum2 = 0, n = 0;
      for (const [x, y] of patches) {
        const a = new Uint8Array(4 * w * h);
        gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, a);
        for (let i = 0; i < a.length; i += 4) {
          const lum = a[i] * .299 + a[i + 1] * .587 + a[i + 2] * .114;
          colors.add(`${a[i]},${a[i + 1]},${a[i + 2]}`); sum += lum; sum2 += lum * lum; n++;
        }
      }
      C.state.freeze = false;
      const mean = sum / n, std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
      return { uniqueColors: colors.size, luminanceStdDev: std, painted: colors.size > 40 && std > 4 };
    });
    save();

    // ---- High quality: GTAO + SSGI parity and contribution ----
    await page.setViewportSize({ width: 1024, height: 640 });
    report.phases.highQuality = await page.evaluate(() => {
      const C = window.__CHINA3D__;
      C.setView(1, true); C.state.ao = true; C.state.gi = true; C.setQuality('high');
      return { gtao: C.gtao.enabled, ssgi: C.ssgi.enabled, hdr: C.renderer.extensions.has('EXT_color_buffer_float'), passes: C.composer.passes.map(p => [p.constructor.name, p.enabled]) };
    });
    await shot(page, '08-high-gtao-ssgi', true);
    report.phases.aoParity = await page.evaluate(() => {
      const C = window.__CHINA3D__, gl = C.renderer.getContext();
      C.state.freeze = true; C.state.ao = true; C.state.gi = true; C.setQuality('high');
      const px = () => { const a = new Uint8Array(4); gl.readPixels(512, 320, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a); return [...a]; };
      C.render(); C.render(); const on = px();
      C.state.ao = false; C.setQuality('high'); C.render(); C.render(); const off = px();
      C.state.ao = true; C.state.gi = true; C.setQuality('high'); C.state.freeze = false;
      const delta = Math.max(...[0, 1, 2].map(i => Math.abs(on[i] - off[i])));
      return { on, off, maxChannelDelta: delta, passed: delta < 25 };
    });
    report.phases.ssgi = await page.evaluate(() => {
      const C = window.__CHINA3D__, gl = C.renderer.getContext();
      C.setView(1, true); C.state.freeze = true; C.state.ao = true; C.setQuality('high');
      const W = Math.min(512, gl.drawingBufferWidth), H = Math.min(320, gl.drawingBufferHeight);
      const grab = () => { const a = new Uint8Array(4 * W * H); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, a); return a; };
      C.state.gi = false; C.ssgi.setEnabled(false); C.render(); C.render(); const off = grab();
      C.state.gi = true; C.ssgi.setEnabled(true); C.render(); C.render(); C.render(); const on = grab();
      let diff = 0, changed = 0;
      for (let i = 0; i < off.length; i += 16) { const d = Math.abs(on[i] - off[i]); diff += d; if (d > 2) changed++; }
      const result = { diff, changedSamples: changed, active: C.ssgi.enabled, contributes: diff > 40, notWashedOut: diff < 3000000 };
      C.state.freeze = false; C.setView(0, true); C.setQuality('medium');
      return result;
    });
    report.phases.water = await page.evaluate(() => {
      const C = window.__CHINA3D__;
      const mats = C.sceneObj.groups.water.children.filter(o => o.isMesh).map(o => o.material.name || o.material.type);
      return { shaderPresent: mats.includes('BeijingOsmWater'), polygonCount: C.data.areas.filter(a => a.kind === 'water').length, animatedBy: 'U.time' };
    });
    save();

    // ---- Mobile: standalone file, drawers, touch search and walk mode ----
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const mp = await mobile.newPage(); wire(mp, 'mobile');
    await ready(mp, 'file://' + FILE + '?quality=low');
    await mp.screenshot({ path: path.join(OUT, '09-mobile.png'), timeout: 180000 });
    (report.phases.screenshots = report.phases.screenshots || []).push('09-mobile');
    await mp.click('#guideToggle');
    report.phases.mobileDrawer = await mp.evaluate(() => ({
      guideOpen: document.querySelector('#guide').classList.contains('open'),
      scrollWidth: document.documentElement.scrollWidth, innerWidth,
    }));
    await mp.fill('#search', 'Барабанная башня');
    const mobileResults = await mp.locator('#searchResults .result').count();
    await mp.locator('#searchResults .result').first().click();
    report.phases.mobileSearch = await mp.evaluate(() => ({
      info: document.querySelector('#info')?.textContent.slice(0, 180),
      selectedId: window.__CHINA3D__.state.selectedId,
    }));
    await mp.screenshot({ path: path.join(OUT, '10-mobile-drawer.png'), timeout: 180000 });
    (report.phases.screenshots = report.phases.screenshots || []).push('10-mobile-drawer');
    await mp.click('#settings');
    report.phases.mobileControls = await mp.evaluate(() => document.querySelector('#controls').classList.contains('open'));
    await mp.evaluate(() => document.querySelector('[data-mode="walk"]').click());
    report.phases.mobileWalk = await mp.evaluate(() => ({
      mode: window.__CHINA3D__.state.mode,
      joystick: document.querySelector('#joy').classList.contains('show'),
      mobileQuality: window.__CHINA3D__.state.quality,
      gtaoOff: !window.__CHINA3D__.gtao.enabled,
    }));
    report.phases.mobileResults = mobileResults;
    save();

    const pass =
      report.errors.length === 0 && report.external.length === 0 &&
      Object.values(report.phases.static).every(Boolean) &&
      report.phases.runtime.webgl2 && report.phases.runtime.fontLoaded && report.phases.runtime.appErrors === 0 &&
      report.phases.runtime.triangles > 0 && report.phases.runtime.drawCalls > 0 &&
      report.phases.geometry.featureIdsUnique && report.phases.geometry.requiredIdsPresent &&
      report.phases.geometry.w929701515IsBuilding && report.phases.geometry.barrierRingsAreWalls &&
      report.phases.geometry.r21434020IsPavingArea && report.phases.geometry.is3D &&
      report.phases.geometry.streetLevelView && report.phases.geometry.pointsOutsideClip === 0 &&
      report.phases.geometry.centersOutsideBBox === 0 &&
      report.phases.geometry.caveatsMentionBarriers && report.phases.geometry.caveatsMentionHeights &&
      report.phases.geometry.caveatsMentionClipping && report.phases.geometry.caveatsMentionLicense &&
      report.phases.geometry.caveatsMentionBuildingCoverage &&
      report.phases.search.results > 0 && report.phases.selection.infoHasAttribution &&
      report.phases.controls.detailsOff.layer === false && report.phases.controls.detailsOff.group === false &&
      report.phases.weather.rain > .8 && report.phases.weather.night > .4 &&
      report.phases.canvas.painted && report.phases.highQuality.gtao && report.phases.highQuality.ssgi &&
      report.phases.aoParity.passed && report.phases.ssgi.contributes && report.phases.ssgi.notWashedOut &&
      report.phases.water.shaderPresent && report.phases.mobileDrawer.guideOpen &&
      report.phases.mobileSearch.selectedId && report.phases.mobileControls &&
      report.phases.mobileWalk.mode === 'walk' && report.phases.mobileWalk.gtaoOff;
    report.result = pass ? 'PASS' : 'FAIL';
    report.finished = new Date().toISOString();
    save();
    console.log(JSON.stringify({ result: report.result, errors: report.errors.length, external: report.external.length, warnings: report.warnings.length, phases: Object.keys(report.phases).length }, null, 2));
    if (!pass) process.exitCode = 1;
  } finally {
    await browser.close();
  }
})().catch(e => {
  report.result = 'FAIL'; report.finished = new Date().toISOString();
  report.errors.push('verification: ' + String(e.stack || e));
  save();
  console.error(e);
  process.exitCode = 1;
});
