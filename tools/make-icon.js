'use strict';

/* Генератор иконки приложения: build/icon.ico + build/icon.png
   Запуск: npm run icon
   Рисует знак «доска + перо» без внешних зависимостей. */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // суперсэмплинг

const ACCENT = [47, 123, 232];
const ACCENT_DARK = [34, 96, 196];
const PAPER = [255, 255, 255];

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  if (x >= x0 + r && x <= x1 - r) return true;
  if (y >= y0 + r && y <= y1 - r) return true;
  return Math.hypot(x - cx, y - cy) <= r;
}

function distToSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/* цвет пикселя в нормализованных координатах 0..1 */
function sample(x, y) {
  if (!inRoundedRect(x, y, 0, 0, 1, 1, 0.22)) return null;

  /* лёгкий вертикальный градиент фона */
  const t = y;
  let color = [
    Math.round(ACCENT[0] + (ACCENT_DARK[0] - ACCENT[0]) * t),
    Math.round(ACCENT[1] + (ACCENT_DARK[1] - ACCENT[1]) * t),
    Math.round(ACCENT[2] + (ACCENT_DARK[2] - ACCENT[2]) * t),
  ];
  let alpha = 255;

  /* лист бумаги */
  if (inRoundedRect(x, y, 0.18, 0.2, 0.82, 0.8, 0.06)) color = PAPER;

  /* перо: диагональная полоса с белым наконечником */
  const penDist = distToSegment(x, y, 0.3, 0.74, 0.72, 0.32);
  if (penDist <= 0.055) {
    color = ACCENT_DARK;
    if (penDist <= 0.03) color = ACCENT;
  }
  /* наконечник пера */
  if (distToSegment(x, y, 0.7, 0.3, 0.79, 0.21) <= 0.045) color = [30, 41, 59];

  /* линия чернил на бумаге */
  if (inRoundedRect(x, y, 0.18, 0.2, 0.82, 0.8, 0.06)) {
    if (distToSegment(x, y, 0.27, 0.6, 0.5, 0.66) <= 0.022) color = [30, 41, 59];
    if (distToSegment(x, y, 0.27, 0.68, 0.45, 0.72) <= 0.018) color = [100, 116, 139];
  }

  return { r: color[0], g: color[1], b: color[2], a: alpha };
}

function renderRGBA(size) {
  const out = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SS);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) * step;
          const y = (py * SS + sy + 0.5) * step;
          const c = sample(x, y);
          if (c) {
            r += c.r;
            g += c.g;
            b += c.b;
            a += 255;
          }
        }
      }
      const total = SS * SS;
      const i = (py * size + px) * 4;
      const alpha = a / total;
      if (alpha > 0) {
        const cover = a / 255;
        out[i] = Math.round(r / cover);
        out[i + 1] = Math.round(g / cover);
        out[i + 2] = Math.round(b / cover);
      }
      out[i + 3] = Math.round(alpha);
    }
  }
  return out;
}

/* BMP-изображение для ICO: снизу вверх, BGRA + AND-маска */
function bmpForIco(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(0, 20);

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const si = (srcY * size + x) * 4;
      const di = (y * size + x) * 4;
      xor[di] = rgba[si + 2];
      xor[di + 1] = rgba[si + 1];
      xor[di + 2] = rgba[si];
      xor[di + 3] = rgba[si + 3];
    }
  }

  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const alpha = rgba[(srcY * size + x) * 4 + 3];
      if (alpha === 0) mask[y * maskRowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  header.writeUInt32LE(xor.length + mask.length, 20);
  return Buffer.concat([header, xor, mask]);
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function main() {
  const dir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(dir, { recursive: true });

  const images = SIZES.map((size) => {
    const rgba = renderRGBA(size);
    return { size, rgba, bmp: bmpForIco(size, rgba) };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.bmp.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.bmp.length;
    entries.push(e);
  }

  const ico = Buffer.concat([header, ...entries, ...images.map((i) => i.bmp)]);
  fs.writeFileSync(path.join(dir, 'icon.ico'), ico);

  const big = images[images.length - 1];
  fs.writeFileSync(path.join(dir, 'icon.png'), encodePng(big.size, big.rgba));

  console.log(`icon.ico: ${SIZES.join(', ')} px — ${ico.length} байт`);
  console.log('icon.png: 256 px');
}

main();
