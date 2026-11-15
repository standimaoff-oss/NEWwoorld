/* Собирает .ico из PNG-иконок (PNG внутри ICO — поддерживается Windows Vista+). */
const fs = require('fs'), path = require('path');
const SRC = path.resolve(__dirname, '../game/icons');
const icons = ['icon-192.png', 'icon-512.png'].map(f => ({ f, data: fs.readFileSync(path.join(SRC, f)) }));
const sizes = [192, 512];
const n = icons.length;
const header = Buffer.alloc(6 + n * 16);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(n, 4);
let off = 6 + n * 16;
icons.forEach((ic, i) => {
  const s = sizes[i];
  const b = 6 + i * 16;
  header.writeUInt8(s >= 256 ? 0 : s, b);       // width (0 = 256+)
  header.writeUInt8(s >= 256 ? 0 : s, b + 1);   // height
  header.writeUInt8(0, b + 2);                  // palette
  header.writeUInt8(0, b + 3);                  // reserved
  header.writeUInt16LE(1, b + 4);               // planes
  header.writeUInt16LE(32, b + 6);              // bpp
  header.writeUInt32LE(ic.data.length, b + 8);
  header.writeUInt32LE(off, b + 12);
  off += ic.data.length;
});
fs.writeFileSync(path.join(__dirname, 'shopsim.ico'), Buffer.concat([header, ...icons.map(i => i.data)]));
console.log('shopsim.ico ok');
