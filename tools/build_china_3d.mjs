// Build the standalone Beijing OSM 3D document.
//
// All runtime inputs are inlined: OSM-derived geometry, photographic PBR maps,
// Noto font subset, three.js bundle and the GTAO + SSGI pipeline. The resulting
// China_3D.html opens over file:// with zero network requests.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const cacheModules = path.join(root, '.cache/china-preview/node_modules');
const require = createRequire(import.meta.url);
let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  esbuild = require(path.join(cacheModules, 'esbuild'));
}
const { build } = esbuild;

const assetsDir = path.join(root, 'preview/assets');
const textures = {};
for (const f of fs.readdirSync(assetsDir).filter(f => f.endsWith('.jpg'))) {
  textures[f.replace('.jpg', '')] = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(assetsDir, f)).toString('base64');
}
const font = fs.readFileSync(path.join(assetsDir, 'NotoPreview.woff2')).toString('base64');
const dataPath = path.join(root, 'docs/china-3d/beijing-3d.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

const result = await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'beijing3d/src/main.js')],
  nodePaths: [cacheModules],
  bundle: true, minify: true, format: 'iife', platform: 'browser',
  target: ['es2020'], write: false, legalComments: 'inline', logLevel: 'info',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const assetsScript = 'window.__CHINA_ASSETS__=' + JSON.stringify({ textures, font }).replace(/</g, '\\u003c') + ';';
const dataScript = 'window.__CHINA3D_DATA__=' + JSON.stringify(data)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029') + ';';
const ofl = fs.readFileSync(path.join(assetsDir, 'FONT_OFL.txt'), 'utf8');
const notices = `<!--
Beijing · Gulou / Nanluoguxiang — standalone OSM 3D WebGL preview.
Self-contained: no fetch(), no external fonts, textures, scripts or stylesheets.
Original ShopSim.exe and game saves are not modified by this document.

Map data: © OpenStreetMap contributors, Open Database License (ODbL) 1.0.
Source: OpenStreetMap API v0.6 / map.json, bbox 116.385,39.930,116.402,39.945.
Retrieved: ${data.meta.retrievedAt}. Raw extract: docs/beijing-osm-3d/osm-map.json.
Geometry is clipped to a +${data.meta.clipMarginMeters} m buffer. Absent OSM
fences, alleys, building heights, monument meshes and incomplete relation
rings are disclosed in the document UI; they are not silently invented.
Facade windows, lanterns, sign boards, roof caps and tree crowns are stylistic
procedural details from China_Preview.html, not OSM objects.

three.js: MIT License, Copyright 2010-2025 three.js authors.
Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions: The above copyright notice and this
permission notice shall be included in all copies or substantial portions of
the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

Photographic PBR textures: ambientCG, CC0 1.0, resized and desaturated.
Asset IDs: Grass004, Concrete012, Bricks066, Asphalt021, Road001, Metal063.
Noto Sans SC font subset: SIL Open Font License 1.1.
${ofl}
High quality uses three.js GTAOPass plus the verified deterministic SSGI
screen-space single-bounce effect from China_Preview.html; it is not hardware
ray tracing. WebGL2 / Chromium verification is recorded in
docs/china-3d/verification.json.
-->
`;

let html = fs.readFileSync(path.join(root, 'beijing3d/template.html'), 'utf8');
html = html.replace('__ASSETS__', () => assetsScript);
html = html.replace('__DATA__', () => dataScript);
html = html.replace('__APP__', () => js);
html = notices + html;
const out = path.join(root, 'China_3D.html');
fs.writeFileSync(out, html);
const bytes = Buffer.byteLength(html);
const sha = crypto.createHash('sha256').update(html).digest('hex');
const info = {
  file: 'China_3D.html', bytes, sha256: sha,
  builtAt: new Date().toISOString(),
  sourceData: 'docs/china-3d/beijing-3d.json',
  sourceDataBytes: fs.statSync(dataPath).size,
  attribution: data.meta.attribution,
  license: data.meta.license,
  stats: data.meta.stats,
  externalRequests: 0,
};
fs.mkdirSync(path.join(root, 'docs/china-3d'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/china-3d/build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log(JSON.stringify({ out, bytes, sha256: sha.slice(0, 16), stats: data.meta.stats }, null, 2));
