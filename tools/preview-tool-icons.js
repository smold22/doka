'use strict';

/* Сравниваем иконки инструментов: рендерим svg прямо из renderer/index.html */

const fs = require('fs');
const path = require('path');
const { parsePath, pathToSegments, pathToSubpaths, preview } = require('./svg-ascii.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

const wanted = process.argv.slice(2);
const icons = [];
const buttonRe = /<button[^>]*data-tool="([a-z]+)"[^>]*>([\s\S]*?)<\/button>/g;
let m;
while ((m = buttonRe.exec(html)) !== null) {
  const [, tool, body] = m;
  if (wanted.length && !wanted.includes(tool)) continue;
  const ds = [...body.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((x) => x[1]);
  const circles = [...body.matchAll(/<circle\b([^>]*)\/?>/g)].map((x) => circleSubs(x[1]));
  const subpaths = [];
  for (const d of ds) subpaths.push(...pathToSubpaths(d));
  for (const sub of circles) subpaths.push(...sub);
  if (!subpaths.length) continue;
  const size = /viewBox="0 0 ([\d.]+) [\d.]+"/.exec(body);
  icons.push({ name: tool, subpaths, fill: /\bclass="solid"/.test(body), size: size ? Number(size[1]) : 20 });
}

/* <circle cx cy r> → контур многоугольника */
function circleSubs(attrs) {
  const num = (key) => {
    const mm = new RegExp(key + '="([-\\d.]+)"').exec(attrs);
    return mm ? Number(mm[1]) : 0;
  };
  const cx = num('cx');
  const cy = num('cy');
  const r = num('r');
  if (!r) return [];
  const pts = [];
  for (let i = 0; i <= 20; i += 1) {
    const t = (i / 20) * Math.PI * 2;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return [pts];
}

if (!icons.length) {
  console.log('иконки не найдены');
  process.exit(1);
}

console.log('найдено иконок: ' + icons.length + ' → ' + icons.map((i) => i.name).join(', '));
console.log(preview(icons.map((i) => Object.assign({ size: i.size }, i)), { px: 26, stroke: 1.4, gap: 3 }));

/* дубли: одинаковая геометрия у разных инструментов */
const seen = new Map();
for (const icon of icons) {
  const key = icon.subpaths
    .flatMap((poly) => poly.map((p) => p.map((v) => v.toFixed(2)).join(',')))
    .sort()
    .join('|');
  if (seen.has(key)) console.log(`внимание: иконка «${icon.name}» совпадает с «${seen.get(key)}»`);
  else seen.set(key, icon.name);
}
void parsePath;
void pathToSegments;