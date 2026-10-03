'use strict';

/* Мини-растеризатор path d → ASCII, чтобы сравнивать иконки инструментов.
   Поддерживает M L H V C Q A Z (в user space 20×20). */

function parsePath(d) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const cmds = [];
  let i = 0;
  let cur = null;
  let lastMove = false;
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) {
      cur = tokens[i];
      lastMove = false;
      i += 1;
      continue;
    }
    if (!cur) throw new Error('путь начинается не с команды: ' + tokens[i]);
    const need = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }[cur.toUpperCase()];
    if (need === undefined) throw new Error('неизвестная команда: ' + cur);
    if (need === 0) { cmds.push({ c: cur }); cur = null; continue; }
    /* после moveto повторные пары — это неявная lineto (SVG 1.1 п. 8.3.2) */
    const implicit = lastMove
      ? (cur === cur.toLowerCase() && cur.toUpperCase() === 'M' ? 'l' : 'L')
      : cur;
    if (cur.toUpperCase() === 'M') {
      lastMove = true;
    } else {
      lastMove = false;
    }
    cmds.push({ c: implicit, args: tokens.slice(i, i + need).map(Number) });
    i += need;
  }
  return cmds;
}

function arcPoints(p0, rx, ry, phi, laf, sf, p1) {
  /* endpoint → center parameterization (SVG 1.1, приложение F.6.5) */
  const rad = (phi * Math.PI) / 180;
  const cosP = Math.cos(rad);
  const sinP = Math.sin(rad);
  const dx2 = (p0[0] - p1[0]) / 2;
  const dy2 = (p0[1] - p1[1]) / 2;
  const x1 = cosP * dx2 + sinP * dy2;
  const y1 = -sinP * dx2 + cosP * dy2;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (laf === sf) coef = -coef;
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cosP * cx1 - sinP * cy1 + (p0[0] + p1[0]) / 2;
  const cy = sinP * cx1 + cosP * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const th1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dth = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sf && dth > 0) dth -= Math.PI * 2;
  if (sf && dth < 0) dth += Math.PI * 2;
  const n = Math.max(2, Math.ceil(Math.abs(dth) / (Math.PI / 12)));
  const out = [];
  for (let k = 1; k <= n; k += 1) {
    const t = th1 + (dth * k) / n;
    const x = cosP * rx * Math.cos(t) - sinP * ry * Math.sin(t) + cx;
    const y = sinP * rx * Math.cos(t) + cosP * ry * Math.sin(t) + cy;
    out.push([x, y]);
  }
  return out;
}

/* Возвращает замкнутые контуры (массивы точек) — нужно и для обводки, и для заливки */
function pathToSubpaths(d) {
  const segs = pathToSegments(d);
  const subs = [];
  let cur = [];
  for (const [a, b] of segs) {
    if (!cur.length) cur.push(a);
    else if (cur[cur.length - 1][0] !== a[0] || cur[cur.length - 1][1] !== a[1]) {
      subs.push(cur);
      cur = [a];
    }
    cur.push(b);
  }
  if (cur.length > 1) subs.push(cur);
  return subs;
}

/* правило ненулевой обмотки (SVG default fill-rule) */
function insideNonZero(p, poly) {
  let winding = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a[1] <= p[1]) {
      if (b[1] > p[1] && (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]) > 0) winding += 1;
    } else if (b[1] <= p[1] && (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]) < 0) {
      winding -= 1;
    }
  }
  return winding !== 0;
}

function pathToSegments(d) {
  const cmds = parsePath(d);
  const segs = [];
  let p = [0, 0];
  let start = [0, 0];
  let prevC = null;
  let prevQ = null;
  for (const step of cmds) {
    const c = step.c;
    const rel = c === c.toLowerCase();
    const C = c.toUpperCase();
    const a = step.args || [];
    const at = (k, base) => (rel ? base + a[k] : a[k]);
    if (C === 'M') {
      if (segs.length) segs.push([p, p]);      /* разрыв подконтура: нулевой отрезок */
      p = [at(0, p[0]), at(1, p[1])];
      start = p.slice();
      prevC = prevQ = null;
    } else if (C === 'L') {
      const np = [at(0, p[0]), at(1, p[1])];
      segs.push([p, np]);
      p = np;
      prevC = prevQ = null;
    } else if (C === 'H') {
      const np = [at(0, p[0]), p[1]];
      segs.push([p, np]);
      p = np;
      prevC = prevQ = null;
    } else if (C === 'V') {
      const np = [p[0], at(0, p[1])];
      segs.push([p, np]);
      p = np;
      prevC = prevQ = null;
    } else if (C === 'C' || C === 'S') {
      let c1;
      let c2;
      let np;
      if (C === 'C') {
        c1 = [at(0, p[0]), at(1, p[1])];
        c2 = [at(2, p[0]), at(3, p[1])];
        np = [at(4, p[0]), at(5, p[1])];
      } else {
        c1 = prevC ? [2 * p[0] - prevC[0], 2 * p[1] - prevC[1]] : p.slice();
        c2 = [at(0, p[0]), at(1, p[1])];
        np = [at(2, p[0]), at(3, p[1])];
      }
      const n = 14;
      for (let k = 1; k <= n; k += 1) {
        const t = k / n;
        const mt = 1 - t;
        const q = [
          mt * mt * mt * p[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * np[0],
          mt * mt * mt * p[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * np[1],
        ];
        segs.push([p, q]);
        p = q;
      }
      prevC = c2;
      prevQ = null;
    } else if (C === 'Q' || C === 'T') {
      let ctl;
      let np;
      if (C === 'Q') {
        ctl = [at(0, p[0]), at(1, p[1])];
        np = [at(2, p[0]), at(3, p[1])];
      } else {
        ctl = prevQ ? [2 * p[0] - prevQ[0], 2 * p[1] - prevQ[1]] : p.slice();
        np = [at(0, p[0]), at(1, p[1])];
      }
      const n = 12;
      for (let k = 1; k <= n; k += 1) {
        const t = k / n;
        const mt = 1 - t;
        const q = [
          mt * mt * p[0] + 2 * mt * t * ctl[0] + t * t * np[0],
          mt * mt * p[1] + 2 * mt * t * ctl[1] + t * t * np[1],
        ];
        segs.push([p, q]);
        p = q;
      }
      prevQ = ctl;
      prevC = null;
    } else if (C === 'A') {
      const np = [at(5, p[0]), at(6, p[1])];
      for (const q of arcPoints(p, a[0], a[1], a[2], a[3], a[4], np)) segs.push([p, q]);
      p = np;
      prevC = prevQ = null;
    } else if (C === 'Z') {
      segs.push([p, start]);
      p = start.slice();
      prevC = prevQ = null;
    }
  }
  return segs;
}

function distToSeg(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const len = vx * vx + vy * vy;
  const t = len ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len)) : 0;
  return Math.hypot(wx - t * vx, wy - t * vy);
}

/* side-by-side ASCII: names сверху, иконки под ними */
function preview(icons, opts) {
  const o = Object.assign({ size: 20, px: 34, stroke: 1.4, gap: 4 }, opts);
  const cols = Math.round(o.px * 2);
  const rows = Math.round(o.px * 2);
  const label = Math.max(...icons.map((i) => i.name.length));
  const blocks = icons.map((icon) => {
    const box = icon.size || o.size;
    const subs = icon.subpaths
      || icon.paths.flatMap((d) => pathToSubpaths(d));
    const segs = subs.flatMap((poly) => poly.map((pt, i) => [pt, poly[(i + 1) % poly.length]]));
    const lines = [];
    for (let row = 0; row < rows; row += 1) {
      const y = ((row + 0.5) / rows) * box;
      let line = '';
      for (let col = 0; col < cols; col += 1) {
        const x = ((col + 0.5) / cols) * box;
        const p = [x, y];
        let best = Infinity;
        for (const [a, b] of segs) best = Math.min(best, distToSeg(p, a, b));
        const filled = icon.fill && subs.some((poly) => insideNonZero(p, poly));
        if (icon.fill) {
          line += filled ? '#' : (best <= 0.7 ? '.' : ' ');
        } else {
          line += best <= o.stroke / 2 ? '#' : (best <= o.stroke / 2 + 0.5 ? '.' : ' ');
        }
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines;
  });
  let out = '';
  for (let k = 0; k < icons.length; k += 1) {
    out += icons[k].name.padEnd(label + 2 + o.gap);
  }
  out += '\n';
  for (let r = 0; r < rows; r += 1) {
    for (const b of blocks) out += b[r].padEnd(cols + 1) + '  ';
    out = out.replace(/\s+$/, '') + '\n';
  }
  return out;
}

module.exports = {
  parsePath, pathToSegments, pathToSubpaths, insideNonZero, preview, distToSeg,
};