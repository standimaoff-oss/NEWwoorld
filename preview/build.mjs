import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const assetsDir = path.join(here, 'assets');
const textures = {};
for (const f of fs.readdirSync(assetsDir).filter(f => f.endsWith('.jpg'))) textures[f.replace('.jpg', '')] = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(assetsDir, f)).toString('base64');
const font = fs.readFileSync(path.join(assetsDir, 'NotoPreview.woff2')).toString('base64');
const result = await build({ entryPoints: [path.join(here, 'src/main.js')], bundle: true, minify: true, format: 'iife', target: ['es2020'], write: false, legalComments: 'inline', logLevel: 'info' });
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const notices = `<!--\nShopSim China graphics preview — standalone approval build.\nOriginal game files are NOT modified by this document.\n\nthree.js: MIT License, Copyright 2010-2025 three.js authors.\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.\n\nPhotographic PBR textures: ambientCG, CC0 1.0. Retrieved from the GitHub mirror petroulacl/fps-buildings-env-kit; resized and desaturated for this preview. Asset IDs: Grass004, Concrete012, Bricks066, Asphalt021, Road001, Metal063.\n\nNoto Sans SC font subset: SIL Open Font License 1.1.\n${fs.readFileSync(path.join(assetsDir, 'FONT_OFL.txt'), 'utf8')}\n\nSketchfab model URLs and Shadertoy URLs supplied by the user are recorded as visual references only. No Sketchfab assets or Shadertoy source code were downloaded or embedded. All scene geometry and GLSL effects in this preview were authored for the preview. Hardware RTGI is not implemented: high quality uses screen-space GTAO plus a screen-space ray-traced diffuse GI (SSGI) pass for one indirect bounce.\n-->\n`;
let html = fs.readFileSync(path.join(here, 'template.html'), 'utf8');
html = html.replace('__ASSETS__', 'window.__CHINA_ASSETS__=' + JSON.stringify({ textures, font }).replace(/</g, '\\u003c') + ';');
html = html.replace('__APP__', () => js);
// PWA hooks are HTTP-only: opened via file:// the document stays a plain,
// dependency-free HTML file with zero requests of any kind.
const pwaBoot = `<script>
if (location.protocol === 'http:' || location.protocol === 'https:') {
  const link = document.createElement('link');
  link.rel = 'manifest'; link.href = new URL('./manifest.webmanifest', location.href).href;
  document.head.appendChild(link);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('./sw.js', location.href).href).catch(() => {});
}
</script>
`;
html = html.replace('</body>', pwaBoot + '</body>');
html = notices + html;
const out = path.join(root, 'China_Preview.html');
fs.writeFileSync(out, html);
// PWA companions live next to the HTML, both at the repo root and in the
// served copy. Everything is static, so an Android/desktop browser can install
// the preview as a standalone app and run it offline.
const pwaFiles = ['manifest.webmanifest', 'sw.js'];
const iconFiles = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
const pub = path.join(root, '.cache/china-preview/public'); fs.mkdirSync(pub, { recursive: true });
fs.writeFileSync(path.join(pub, 'index.html'), html);
for (const f of pwaFiles) {
  const body = fs.readFileSync(path.join(here, 'pwa-src', f));
  fs.writeFileSync(path.join(root, f), body);
  fs.writeFileSync(path.join(pub, f), body);
}
for (const f of iconFiles) {
  const body = fs.readFileSync(path.join(assetsDir, f));
  fs.writeFileSync(path.join(root, f), body);
  fs.writeFileSync(path.join(pub, f), body);
}
// Native app shells read their own copy of the standalone document straight
// from assets/app, so an APK/EXE build needs no network and no extra bundler.
for (const target of [
  path.join(root, 'android/app/src/main/assets/index.html'),
  path.join(root, 'desktop/app/index.html'),
]) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html);
}
console.log('Wrote', out, (Buffer.byteLength(html) / 1048576).toFixed(2), 'MiB', '+ PWA / APK / EXE assets');
