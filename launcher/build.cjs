/* Упаковщик игры в .exe: собирает game/ в ZIP (без сжатия) и генерирует embed.c,
   затем кросс-компилирует нативный лаунчер через zig cc в настоящий PE32+.
   Запуск: node launcher/build.cjs */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GAME = path.join(ROOT, 'game');
const OUT = path.join(ROOT, 'dist');
const ZIG = process.env.SHOPSIM_ZIG || '/tmp/zig_test/zx/ziglang/zig';

// --- собираем список файлов игры ---
const SKIP = new Set(['tools', 'node_modules', '.git', 'ShopSim-Windows.bat', 'ShopSim-Windows.ps1']);
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
}
walk(GAME);
files.sort();

// --- пишем ZIP (stored, без сжатия) ---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const locals = [];
const centrals = [];
let offset = 0;
for (const f of files) {
  const rel = path.relative(GAME, f).split(path.sep).join('/');
  const data = fs.readFileSync(f);
  const name = Buffer.from(rel, 'utf8');
  const crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(0, 8);          // stored
  lh.writeUInt16LE(0, 10);
  lh.writeUInt16LE(0, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(data.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(name.length, 26);
  lh.writeUInt16LE(0, 28);
  locals.push(lh, name, data);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0, 8);
  ch.writeUInt16LE(0, 10);
  ch.writeUInt16LE(0, 12);
  ch.writeUInt16LE(0, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(data.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(name.length, 28);
  ch.writeUInt16LE(0, 30);
  ch.writeUInt16LE(0, 32);
  ch.writeUInt16LE(0, 34);
  ch.writeUInt16LE(0, 36);
  ch.writeUInt32LE(0, 38);
  ch.writeUInt32LE(offset, 42);
  centrals.push(ch, name);
  offset += lh.length + name.length + data.length;
}
const cdBuf = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...locals, cdBuf, eocd]);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'game.zip'), zip);
console.log('game.zip:', (zip.length / 1048576).toFixed(2), 'MB,', files.length, 'файлов');

// --- генерируем embed.c ---
const lines = ['/* Автогенерировано launcher/build.cjs — не редактировать. */', '#include <stddef.h>', ''];
lines.push(`const unsigned char game_zip[] = {`);
let row = [];
for (let i = 0; i < zip.length; i++) {
  row.push(zip[i]);
  if (row.length === 20) { lines.push('  ' + row.join(',') + ','); row = []; }
}
if (row.length) lines.push('  ' + row.join(','));
lines.push('};');
lines.push(`const size_t game_zip_len = ${zip.length};`);
const embedPath = path.join(__dirname, 'embed.c');
fs.writeFileSync(embedPath, lines.join('\n'));
console.log('embed.c:', (fs.statSync(embedPath).size / 1048576).toFixed(2), 'MB');

// --- иконка (если есть) и компиляция ---
// иконка -> .rc -> объект (ресурсы Windows)
const rcPath = path.join(__dirname, 'res.rc');
fs.writeFileSync(rcPath, '1 ICON "shopsim.ico"\n1 VERSIONINFO\nFILEVERSION 0,6,0,0\nPRODUCTVERSION 0,6,0,0\nBEGIN\n  BLOCK "StringFileInfo"\n  BEGIN\n    BLOCK "040904E4"\n    BEGIN\n      VALUE "CompanyName", "ShopSim"\n      VALUE "FileDescription", "ShopSim - симулятор магазина"\n      VALUE "FileVersion", "0.6.0.0"\n      VALUE "ProductName", "ShopSim"\n      VALUE "ProductVersion", "0.6.0.0"\n      VALUE "OriginalFilename", "ShopSim.exe"\n    END\n  END\n  BLOCK "VarFileInfo"\n  BEGIN\n    VALUE "Translation", 0x409, 1252\n  END\nEND\n');
const resObj = path.join(OUT, 'res.o');
execFileSync(ZIG, ['rc', '/fo', resObj, rcPath], { stdio: 'inherit', cwd: __dirname });

// Лаунчер теперь на C++ (WebView2-окно вместо запуска браузера),
// поэтому компилируем zig c++ и линкуем C++ рантайм.
const args = [
  'c++', '-target', 'x86_64-windows-gnu', '-O2', '-s',
  '-DWEBVIEW_EDGE', '-DWEBVIEW_STATIC',
  '-I', path.join(__dirname, 'wv'),
  '-mwindows', '-Wl,--subsystem,windows', '-Wl,--entry=WinMainCRTStartup',
  '-o', path.join(OUT, 'ShopSim.exe'),
  path.join(__dirname, 'ShopSim.cpp'), embedPath, resObj,
  '-lws2_32', '-lshell32', '-lole32', '-ladvapi32', '-lversion', '-luser32', '-lgdi32', '-lshlwapi', '-luuid',
  '-static-libgcc', '-static-libstdc++',
];
console.log('zig', args.join(' '));
execFileSync(ZIG, args, { stdio: 'inherit', maxBuffer: 1 << 28 });
const exe = path.join(OUT, 'ShopSim.exe');
const st = fs.statSync(exe);
const head = fs.readFileSync(exe, { start: 0, end: 2 });
console.log('ShopSim.exe:', (st.size / 1048576).toFixed(2), 'MB, signature:', head.toString('latin1'));
