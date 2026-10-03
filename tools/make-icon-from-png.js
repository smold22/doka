'use strict';

/* Генератор иконки приложения из готового PNG: build/icon.ico + build/icon.png
   Запуск: npm run icon -- "C:\путь\к\иконке.png"
   Без внешних зависимостей: PNG распаковывается через zlib, ICO собирается вручную. */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 192, 256];
const DEFAULT_SOURCE = path.join('C:', 'Users', 'vlaso', 'Desktop', '1111.png');

/* ---------------- чтение PNG ---------------- */

function readChunks(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Это не PNG-файл');
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    chunks.push({ type, data });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('В PNG нет блока IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (depth !== 8) throw new Error(`Поддерживается только 8 бит на канал, а в файле ${depth}`);
  if (interlace !== 0) throw new Error('Чересстрочные PNG не поддерживаются');
  if (colorType === 3) throw new Error('PNG с палитрой не поддерживается');

  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`Неизвестный тип цвета PNG: ${colorType}`);

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = zlib.inflateSync(idat);

  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      switch (filter) {
        case 0: break;
        case 1: value += a; break;
        case 2: value += b; break;
        case 3: value += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`Неизвестный фильтр строки PNG: ${filter}`);
      }
      cur[x] = value & 0xff;
    }
  }

  /* приводим к RGBA */
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, px = 0; px < width * height; px++, i += channels) {
    let r; let g; let b; let a = 255;
    if (channels === 1) { r = g = b = out[i]; }
    else if (channels === 2) { r = g = b = out[i]; a = out[i + 1]; }
    else if (channels === 3) { r = out[i]; g = out[i + 1]; b = out[i + 2]; }
    else { r = out[i]; g = out[i + 1]; b = out[i + 2]; a = out[i + 3]; }
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
  }
  return { width, height, rgba };
}

/* ---------------- масштабирование ---------------- */

/* sRGB <-> линейное пространство: усреднять цвета нужно в линейном,
   иначе по краям появляются тёмные каймы */
function toLinear(v) {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function toSrgb(v) {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(s * 255)));
}

/* билинейное сглаживание с усреднением по площади (даёт резкий результат при уменьшении) */
function resize(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const ratioX = sw / dw;
  const ratioY = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = y * ratioY;
    const sy1 = sy0 + ratioY;
    for (let x = 0; x < dw; x++) {
      const sx0 = x * ratioX;
      const sx1 = sx0 + ratioX;
      let r = 0; let g = 0; let b = 0; let a = 0; let weight = 0;
      for (let sy = Math.floor(sy0); sy < Math.min(sh, Math.ceil(sy1)); sy++) {
        const wy = Math.min(sy1, sy + 1) - Math.max(sy0, sy);
        for (let sx = Math.floor(sx0); sx < Math.min(sw, Math.ceil(sx1)); sx++) {
          const wx = Math.min(sx1, sx + 1) - Math.max(sx0, sx);
          const w = wx * wy;
          if (w <= 0) continue;
          const i = (sy * sw + sx) * 4;
          const alpha = src[i + 3] / 255;
          r += toLinear(src[i]) * alpha * w;
          g += toLinear(src[i + 1]) * alpha * w;
          b += toLinear(src[i + 2]) * alpha * w;
          a += src[i + 3] * w;
          weight += w;
        }
      }
      const o = (y * dw + x) * 4;
      if (a > 0) {
        out[o] = toSrgb((r * 255) / a);
        out[o + 1] = toSrgb((g * 255) / a);
        out[o + 2] = toSrgb((b * 255) / a);
      }
      out[o + 3] = Math.round(a / weight);
    }
  }
  return out;
}

/* ---------------- ICO ---------------- */

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
      if (alpha < 128) mask[y * maskRowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  header.writeUInt32LE(xor.length + mask.length, 20);
  return Buffer.concat([header, xor, mask]);
}

function buildIco(images) {
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
  return Buffer.concat([header, ...entries, ...images.map((i) => i.bmp)]);
}

/* ---------------- основной сценарий ---------------- */

function main() {
  const source = path.resolve(process.argv[2] || DEFAULT_SOURCE);
  if (!fs.existsSync(source)) {
    console.error(`Файл не найден: ${source}`);
    console.error('Использование: npm run icon -- "C:\\путь\\к\\иконке.png"');
    process.exit(1);
  }

  const image = decodePng(fs.readFileSync(source));
  const dir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(dir, { recursive: true });

  const images = SIZES.map((size) => {
    const rgba = resize(image.rgba, image.width, image.height, size, size);
    return { size, bmp: bmpForIco(size, rgba) };
  });

  const ico = buildIco(images);
  fs.writeFileSync(path.join(dir, 'icon.ico'), ico);
  fs.copyFileSync(source, path.join(dir, 'icon.png'));

  console.log(`источник: ${source} (${image.width}x${image.height})`);
  console.log(`icon.ico: ${SIZES.join(', ')} px — ${ico.length} байт`);
  console.log('icon.png: копия исходного изображения');
}

if (require.main === module) main();

module.exports = { decodePng, resize, buildIco, bmpForIco };