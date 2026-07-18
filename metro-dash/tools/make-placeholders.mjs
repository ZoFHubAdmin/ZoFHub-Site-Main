// tools/make-placeholders.mjs
// ---------------------------------------------------------------------------
// Generates CLEAN, self-made placeholder sprites for Metro Dash so the project
// ships ZERO third-party / copyrighted art. Run once:  node tools/make-placeholders.mjs
// Overwrites assets/player.png and assets/police.png with simple, original,
// fully-opaque 128x128 runner silhouettes (player = teal, police = crimson).
// No external libraries — encodes the PNGs by hand via zlib.
// ---------------------------------------------------------------------------
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'assets');

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function sprite(base, fig) {
  const W = 128, H = 128, buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const shade = 1 - (y / H) * 0.22;
    let r = Math.round(base[0] * shade), g = Math.round(base[1] * shade), b = Math.round(base[2] * shade);
    const head = (x - 64) ** 2 + (y - 38) ** 2 <= 17 ** 2;
    const torso = x >= 46 && x <= 82 && y >= 56 && y <= 104;
    const legL = x >= 50 && x <= 60 && y > 104 && y <= 124;
    const legR = x >= 68 && x <= 78 && y > 104 && y <= 124;
    const armL = x >= 34 && x <= 46 && y >= 60 && y <= 96;
    const armR = x >= 82 && x <= 94 && y >= 60 && y <= 96;
    if (head || torso || legL || legR || armL || armR) { r = fig[0]; g = fig[1]; b = fig[2]; }
    const i = (y * W + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  }
  return encodePNG(W, H, buf);
}

writeFileSync(join(assets, 'player.png'), sprite([22, 184, 196], [245, 247, 250]));
writeFileSync(join(assets, 'police.png'), sprite([206, 52, 58], [245, 247, 250]));
console.log('✓ Wrote clean placeholders: assets/player.png (teal), assets/police.png (crimson)');
