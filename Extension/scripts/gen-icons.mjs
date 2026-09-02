import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function roundedBoxDist(x, y) {
  const qx = Math.abs(x - 50) - (48 - 22);
  const qy = Math.abs(y - 50) - (48 - 22);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - 22;
}

function edgeDist(px, py, ax, ay, bx, by) {
  const ex = bx - ax;
  const ey = by - ay;
  const len = Math.hypot(ex, ey) || 1;
  return ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / len;
}

function triangleCoverage(px, py) {
  const d1 = edgeDist(px, py, 38, 28, 74, 50);
  const d2 = edgeDist(px, py, 74, 50, 38, 72);
  const d3 = edgeDist(px, py, 38, 72, 38, 28);
  return clamp01(0.5 + Math.min(d1, d2, d3));
}

function sample(nx, ny) {
  const x = nx * 100;
  const y = ny * 100;
  const bgCov = clamp01(0.5 - roundedBoxDist(x, y));
  if (bgCov <= 0) return [0, 0, 0, 0];
  const tri = triangleCoverage(x, y) * bgCov;
  const t = y / 100;
  const rTop = 0xff, gTop = 0x51, bTop = 0x4a;
  const rBot = 0xb3, gBot = 0x14, bBot = 0x14;
  let r = Math.round(rTop + (rBot - rTop) * t);
  let g = Math.round(gTop + (gBot - gTop) * t);
  let b = Math.round(bTop + (bBot - bTop) * t);
  if (tri > 0) {
    r = Math.round(r * (1 - tri) + 255 * tri);
    g = Math.round(g * (1 - tri) + 255 * tri);
    b = Math.round(b * (1 - tri) + 255 * tri);
  }
  return [r, g, b, Math.round(bgCov * 255)];
}

function png(size) {
  const S = 6;
  const big = size * S;
  const raw = Buffer.alloc(big * big * 4);
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const [r, g, b, a] = sample((x + 0.5) / big, (y + 0.5) / big);
      const i = (y * big + x) * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < S; dy++) {
        for (let dx = 0; dx < S; dx++) {
          const i = ((y * S + dy) * big + (x * S + dx)) * 4;
          r += raw[i];
          g += raw[i + 1];
          b += raw[i + 2];
          a += raw[i + 3];
        }
      }
      const n = S * S;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  const stride = size * 4;
  const imgData = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    imgData[y * (stride + 1)] = 0;
    out.copy(imgData, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(imgData, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconDir = join(root, 'public', 'icon');
mkdirSync(iconDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(iconDir, `${size}.png`), png(size));
  console.log(`icon ${size}.png written`);
}
