/* Доска — выделение замкнутой области для инструмента «Заливка» */
(function (global) {
  'use strict';

  const IB = (global.IB = global.IB || {});
  const G = IB.geom;

  const ELLIPSE_SEGMENTS = 72;

  function pushSegment(out, a, b) {
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) return;
    out.push([a, b]);
  }

  function pushClosed(out, pts) {
    if (!pts || pts.length < 2) return;
    for (let i = 0; i < pts.length; i++) pushSegment(out, pts[i], pts[(i + 1) % pts.length]);
  }

  function ellipsePoints(r, n) {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const rx = r.w / 2;
    const ry = r.h / 2;
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
    }
    return out;
  }

  /* контур замкнутой фигуры; текст и картинки границей не считаются */
  function shapeOutline(obj) {
    const a = { x: obj.x1, y: obj.y1 };
    const b = { x: obj.x2, y: obj.y2 };
    if (obj.shape === 'ellipse' || obj.shape === 'circle') {
      return ellipsePoints(G.rectFromPoints(a, b), ELLIPSE_SEGMENTS);
    }
    if (G.isSolidShape(obj.shape)) {
      const geo = G.solidGeometry(obj.shape, a, b);
      return geo ? geo.outline : [];
    }
    if (G.isPolyShape(obj.shape)) return G.shapePoints(obj.shape, a, b);
    const r = G.rectFromPoints(a, b);
    return [
      { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
    ];
  }

  function collectSegments(store, excludeId) {
    const segs = [];
    for (const obj of store.items) {
      if (excludeId && obj.id === excludeId) continue;
      if (obj.type === 'stroke') {
        for (let i = 1; i < obj.points.length; i++) pushSegment(segs, obj.points[i - 1], obj.points[i]);
        continue;
      }
      if (obj.type !== 'shape') continue;
      if (obj.shape === 'line' || obj.shape === 'arrow') {
        pushSegment(segs, { x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 });
        continue;
      }
      if (obj.shape === 'polygon') {
        pushClosed(segs, obj.points);
        continue;
      }
      pushClosed(segs, shapeOutline(obj));
    }
    return segs;
  }

  function polygonArea(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      s += a.x * b.y - b.x * a.y;
    }
    return s / 2;
  }

  function targetInside(obj, p) {
    const a = { x: obj.x1, y: obj.y1 };
    const b = { x: obj.x2, y: obj.y2 };
    if (obj.shape === 'ellipse' || obj.shape === 'circle') return G.pointInEllipse(p, G.rectFromPoints(a, b));
    if (obj.shape === 'polygon') return G.pointInPolygon(p, obj.points || []);
    if (G.isSolidShape(obj.shape)) {
      const geo = G.solidGeometry(obj.shape, a, b);
      return geo ? G.pointInPolygon(p, geo.outline) : false;
    }
    if (G.isPolyShape(obj.shape)) return G.pointInPolygon(p, G.shapePoints(obj.shape, a, b));
    return G.rectContainsPoint(G.rectFromPoints(a, b), p);
  }

  function targetOutlineDist(obj, p) {
    const a = { x: obj.x1, y: obj.y1 };
    const b = { x: obj.x2, y: obj.y2 };
    if (obj.shape === 'ellipse' || obj.shape === 'circle') return G.distToEllipseOutline(p, G.rectFromPoints(a, b));
    if (obj.shape === 'polygon') return G.distToPolygon(p, obj.points || [], true);
    if (G.isSolidShape(obj.shape)) {
      const geo = G.solidGeometry(obj.shape, a, b);
      if (!geo) return Infinity;
      let best = Infinity;
      for (const e of geo.edges) {
        const d = G.distToSegment(p, e.a, e.b);
        if (d < best) best = d;
      }
      for (const c of geo.curves) {
        const d = G.distToEllipseOutline(p, { x: c.cx - c.rx, y: c.cy - c.ry, w: c.rx * 2, h: c.ry * 2 });
        if (d < best) best = d;
      }
      return best;
    }
    if (G.isPolyShape(obj.shape)) return G.distToPolygon(p, G.shapePoints(obj.shape, a, b), true);
    return G.distToRectOutline(p, G.rectFromPoints(a, b));
  }

  /* Есть ли внутри фигуры чужие линии/границы, режущие её на части.
     Нужно, чтобы клик по разделённому треугольнику красил половину, а не весь. */
  function subdivided(store, target) {
    if (!target || target.shape === 'polygon') return false;
    const margin = 1.5;
    const segs = collectSegments(store, target.id);
    const outline = shapeOutline(target);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of outline) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    if (!isFinite(x0)) return false;
    for (const [a, b] of segs) {
      /* доска бывает большой: чужие стены за габаритами фигуры не смотрят */
      if (Math.max(a.x, b.x) < x0 || Math.min(a.x, b.x) > x1) continue;
      if (Math.max(a.y, b.y) < y0 || Math.min(a.y, b.y) > y1) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.min(400, Math.max(1, Math.ceil(len / margin)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        if (targetInside(target, p) && targetOutlineDist(target, p) > margin) return true;
      }
    }
    return false;
  }

  function distPointSegment(p, a, b) {
    return G.distToSegment(p, a, b);
  }

  function simplify(points, eps) {
    if (points.length <= 4) return points.slice();
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    simplifyRange(points, 0, points.length - 1, eps, keep);
    const out = [];
    for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
    return out;
  }

  function simplifyRange(pts, i, j, eps, keep) {
    if (j <= i + 1) return;
    let maxD = 0;
    let idx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = distPointSegment(pts[k], pts[i], pts[j]);
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (maxD > eps && idx >= 0) {
      keep[idx] = 1;
      simplifyRange(pts, i, idx, eps, keep);
      simplifyRange(pts, idx, j, eps, keep);
    }
  }

  function firstFreeCell(blocked, cols, rows, cx, cy) {
    if (cx >= 0 && cx < cols && cy >= 0 && cy < rows && !blocked[cy * cols + cx]) return { cx, cy };
    for (let r = 1; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || x >= cols || y < 0 || y >= rows) continue;
          if (!blocked[y * cols + x]) return { cx: x, cy: y };
        }
      }
    }
    return null;
  }

  /* Площадь, которую занимает внутренность фигуры: нужна, чтобы отличить
     заливку целой фигуры от заливки её части. */
  function interiorArea(obj) {
    if (!obj || obj.type !== 'shape') return 0;
    if (obj.shape === 'line' || obj.shape === 'arrow') return 0;
    const a = { x: obj.x1, y: obj.y1 };
    const b = { x: obj.x2, y: obj.y2 };
    if (obj.shape === 'ellipse' || obj.shape === 'circle') {
      const r = G.rectFromPoints(a, b);
      return Math.PI * Math.abs(r.w / 2) * Math.abs(r.h / 2);
    }
    if (obj.shape === 'polygon') return Math.abs(polygonArea(obj.points || []));
    if (G.isSolidShape(obj.shape)) {
      const geo = G.solidGeometry(obj.shape, a, b);
      return geo ? Math.abs(polygonArea(geo.outline)) : 0;
    }
    if (G.isPolyShape(obj.shape)) return Math.abs(polygonArea(G.shapePoints(obj.shape, a, b)));
    const r = G.rectFromPoints(a, b);
    return Math.abs(r.w * r.h);
  }

  function nearestWallDistance(point, segs) {
    let best = Infinity;
    for (const [a, b] of segs) {
      const d = G.distToSegment(point, a, b);
      if (d < best) best = d;
    }
    return best;
  }

  /* Один проход трассировки в квадратном окне радиуса radius.
     null означает «в этом окне область не замкнулась» — окно надо расширить. */
  function traceWindow(segs, point, radius, baseCell) {
    let cell = baseCell;
    let size = Math.ceil((radius * 2) / cell);
    while (size > 1600) { cell *= 1.6; size = Math.ceil((radius * 2) / cell); }
    size = Math.max(4, size);
    const cols = size;
    const rows = size;
    const x0 = point.x - radius;
    const y0 = point.y - radius;
    const right = x0 + cols * cell;
    const bottom = y0 + rows * cell;

    const blocked = new Uint8Array(cols * rows);
    const mark = (wx, wy) => {
      const cx = Math.floor((wx - x0) / cell);
      const cy = Math.floor((wy - y0) / cell);
      if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) blocked[cy * cols + cx] = 1;
    };

    for (const [a, b] of segs) {
      /* стены вне окна не мешают: область их всё равно не касается */
      if (Math.max(a.x, b.x) < x0 || Math.min(a.x, b.x) > right) continue;
      if (Math.max(a.y, b.y) < y0 || Math.min(a.y, b.y) > bottom) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(len / (cell * 0.5)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        mark(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      }
    }

    const start = firstFreeCell(blocked, cols, rows, Math.floor((point.x - x0) / cell), Math.floor((point.y - y0) / cell));
    if (!start) return null;

    const filled = new Uint8Array(cols * rows);
    const stack = [start.cy * cols + start.cx];
    filled[stack[0]] = 1;
    let touchedBorder = false;
    let count = 0;
    while (stack.length) {
      const cur = stack.pop();
      count++;
      const cx = cur % cols;
      const cy = (cur - cx) / cols;
      if (cx === 0 || cy === 0 || cx === cols - 1 || cy === rows - 1) touchedBorder = true;
      if (cx > 0) { const n = cur - 1; if (!blocked[n] && !filled[n]) { filled[n] = 1; stack.push(n); } }
      if (cx < cols - 1) { const n = cur + 1; if (!blocked[n] && !filled[n]) { filled[n] = 1; stack.push(n); } }
      if (cy > 0) { const n = cur - cols; if (!blocked[n] && !filled[n]) { filled[n] = 1; stack.push(n); } }
      if (cy < rows - 1) { const n = cur + cols; if (!blocked[n] && !filled[n]) { filled[n] = 1; stack.push(n); } }
    }
    /* область упёрлась в край окна: значит, стены снаружи, окно мало */
    if (touchedBorder || count < 2) return null;

    const edges = new Map();
    const key = (gx, gy) => gx + ',' + gy;
    const addEdge = (fx, fy, tx, ty) => {
      const k = key(fx, fy);
      let arr = edges.get(k);
      if (!arr) { arr = []; edges.set(k, arr); }
      arr.push({ fx, fy, tx, ty, used: false });
    };

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        if (!filled[cy * cols + cx]) continue;
        const up = cy > 0 && filled[(cy - 1) * cols + cx];
        const down = cy < rows - 1 && filled[(cy + 1) * cols + cx];
        const left = cx > 0 && filled[cy * cols + (cx - 1)];
        const right2 = cx < cols - 1 && filled[cy * cols + (cx + 1)];
        if (!up) addEdge(cx, cy, cx + 1, cy);
        if (!right2) addEdge(cx + 1, cy, cx + 1, cy + 1);
        if (!down) addEdge(cx + 1, cy + 1, cx, cy + 1);
        if (!left) addEdge(cx, cy + 1, cx, cy);
      }
    }

    const loops = [];
    const guardMax = cols * rows * 4 + 16;
    for (const sk of [...edges.keys()]) {
      const arr = edges.get(sk);
      if (!arr) continue;
      for (const seed of arr) {
        if (seed.used) continue;
        const loop = [];
        let cur = seed;
        let guard = 0;
        while (cur && !cur.used && guard++ < guardMax) {
          cur.used = true;
          loop.push({ x: x0 + cur.fx * cell, y: y0 + cur.fy * cell });
          const nextArr = edges.get(key(cur.tx, cur.ty));
          if (!nextArr) break;
          let next = null;
          for (const cand of nextArr) { if (!cand.used) { next = cand; break; } }
          cur = next;
        }
        if (loop.length >= 3) loops.push(loop);
      }
    }
    if (!loops.length) return null;

    let best = null;
    let bestArea = 0;
    for (const loop of loops) {
      const pts = simplify(loop, cell * 0.9);
      const area = Math.abs(polygonArea(pts));
      if (area > bestArea) { bestArea = area; best = pts; }
    }
    if (!best || best.length < 3 || !(bestArea > 0)) return null;
    return { points: best, area: bestArea, cell };
  }

  /* Извлекает замкнутую область вокруг точки. Возвращает { points, area, cell }
     или null, если точку не окружает замкнутый контур.

     Окно намеренно локальное: доска может быть большой и посторонние объекты
     не должны coarsen сетку до нечитаемой. Сначала берём окно по ближайшей
     стене, и если область не замкнулась — расширяем его. */
  function extract(store, point, options) {
    const opts = options || {};
    const segs = collectSegments(store, null);
    if (!segs.length) return null;

    const cell = opts.cell || G.clamp(2 / (opts.scale || 1), 0.75, 4);
    const MAX_RADIUS = 4000;
    let radius = G.clamp(nearestWallDistance(point, segs) * 4 + 32, 80, MAX_RADIUS);

    for (let attempt = 0; attempt < 6; attempt++) {
      const got = traceWindow(segs, point, radius, cell);
      if (got) return got;
      if (radius >= MAX_RADIUS) break;
      radius = Math.min(radius * 2, MAX_RADIUS);
    }
    return null;
  }

  IB.region = { extract, subdivided, interiorArea, polygonArea, collectSegments };
})(window);
