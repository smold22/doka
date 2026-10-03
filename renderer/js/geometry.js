/* Доска — геометрия, преобразования, утилиты */
(function (global) {
  'use strict';

  const IB = (global.IB = global.IB || {});

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const deg = (r) => (r * 180) / Math.PI;
  const rad = (d) => (d * Math.PI) / 180;
  const round = (v, step = 1) => Math.round(v / step) * step;

  function rectFromPoints(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y),
    };
  }

  function rectUnion(rects) {
    if (!rects.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rects) {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function rectsIntersect(a, b) {
    return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
  }

  function rectContainsPoint(r, p) {
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  }

  function inflate(r, by) {
    if (!r) return null;
    return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
  }

  /* преобразования вида */
  function toScreen(pt, view) {
    return { x: pt.x * view.scale + view.pan.x, y: pt.y * view.scale + view.pan.y };
  }

  function toWorld(pt, view) {
    return { x: (pt.x - view.pan.x) / view.scale, y: (pt.y - view.pan.y) / view.scale };
  }

  function viewToScreenRect(rect, view) {
    const a = toScreen({ x: rect.x, y: rect.y }, view);
    return { x: a.x, y: a.y, w: rect.w * view.scale, h: rect.h * view.scale };
  }

  /* расстояние до отрезка */
  function distToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = clamp(t, 0, 1);
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  /* расстояние до ломаной */
  function distToPolyline(p, points) {
    let best = Infinity;
    for (let i = 1; i < points.length; i++) {
      const d = distToSegment(p, points[i - 1], points[i]);
      if (d < best) best = d;
    }
    if (points.length === 1) best = dist(p, points[0]);
    return best;
  }

  /* расстояние до границы прямоугольника (внешний контур) */
  function distToRectOutline(p, r) {
    if (rectContainsPoint(r, p)) {
      const dl = p.x - r.x, dr = r.x + r.w - p.x, dt = p.y - r.y, db = r.y + r.h - p.y;
      return Math.min(dl, dr, dt, db);
    }
    return distToPolyline(p, [
      { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }, { x: r.x, y: r.y },
    ]);
  }

  function distToPolygon(p, points, closed) {
    let best = Infinity;
    const n = points.length;
    if (n < 2) return best;
    const last = closed === false ? n - 1 : n;
    for (let i = 0; i < last; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      const d = distToSegment(p, a, b);
      if (d < best) best = d;
    }
    return best;
  }

  function pointInPolygon(p, points) {
    const n = points.length;
    if (n < 3) return false;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = points[i];
      const b = points[j];
      if ((a.y > p.y) !== (b.y > p.y)) {
        const t = (p.y - a.y) / (b.y - a.y);
        if (p.x < a.x + t * (b.x - a.x)) inside = !inside;
      }
    }
    return inside;
  }

  /* внутренняя точка треугольника через знаки векторных произведений */
  function pointInTriangle(p, a, b, c) {
    const s1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const s2 = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
    const s3 = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x);
    const neg = s1 < 0 || s2 < 0 || s3 < 0;
    const pos = s1 > 0 || s2 > 0 || s3 > 0;
    return !(neg && pos);
  }

  function pointInEllipse(p, rect) {
    const rx = rect.w / 2 || 1e-6;
    const ry = rect.h / 2 || 1e-6;
    const nx = (p.x - (rect.x + rx)) / rx;
    const ny = (p.y - (rect.y + ry)) / ry;
    return nx * nx + ny * ny <= 1;
  }

  /* Расстояние до контура эллипса. Считаем по неявной функции и её
     градиенту: |f| / |grad| даёт расстояние почти точно у самой дуги,
     чего достаточно для попадания курсором с допуском в несколько пикселей. */
  function distToEllipseOutline(p, rect) {
    const rx = Math.abs(rect.w / 2) || 1e-6;
    const ry = Math.abs(rect.h / 2) || 1e-6;
    const dx = p.x - (rect.x + rect.w / 2);
    const dy = p.y - (rect.y + rect.h / 2);
    const gx = dx / (rx * rx);
    const gy = dy / (ry * ry);
    const f = gx * dx + gy * dy - 1;
    const grad = Math.hypot(2 * gx, 2 * gy);
    if (grad < 1e-9) return Math.min(Math.hypot(dx, dy), Math.abs(f) * Math.min(rx, ry));
    return Math.abs(f) / grad;
  }

  /* сглаживание ввода: убираем дрожание и добавляем точки */
  function simplifyPoints(points, tolerance) {
    if (points.length < 3) return points.slice();
    const out = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
      const prev = out[out.length - 1];
      const d = dist(prev, points[i]);
      if (d >= tolerance) out.push(points[i]);
    }
    out.push(points[points.length - 1]);
    return out;
  }

  /* сглаженная кривая по контрольным точкам (квадратичные сегменты) */
  function strokePath(points) {
    const p = new Path2D();
    if (!points.length) return p;
    if (points.length < 3) {
      p.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) p.lineTo(points[i].x, points[i].y);
      if (points.length === 1) p.lineTo(points[0].x + 0.01, points[0].y);
      return p;
    }
    p.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
      p.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
    }
    const last = points[points.length - 1];
    p.lineTo(last.x, last.y);
    return p;
  }

  /* ---- работа с прямоугольником объекта при изменении размера ---- */

  function transformRect(rect, handle, dx, dy, minSize) {
    const m = minSize || 8;
    let { x, y, w, h } = rect;
    const right = x + w;
    const bottom = y + h;

    if (handle.includes('w')) {
      x = Math.min(x + dx, right - m);
      w = right - x;
    }
    if (handle.includes('e')) {
      w = Math.max(m, w + dx);
    }
    if (handle.includes('n')) {
      y = Math.min(y + dy, bottom - m);
      h = bottom - y;
    }
    if (handle.includes('s')) {
      h = Math.max(m, h + dy);
    }
    return { x, y, w, h };
  }

  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  function handlePoints(rect) {
    const { x, y, w, h } = rect;
    const mx = x + w / 2;
    const my = y + h / 2;
    return {
      nw: { x, y }, n: { x: mx, y }, ne: { x: x + w, y },
      e: { x: x + w, y: my }, se: { x: x + w, y: y + h },
      s: { x: mx, y: y + h }, sw: { x, y: y + h },
      w: { x, y: my },
    };
  }

  function hitHandle(rect, pt, tolerance) {
    const pts = handlePoints(rect);
    for (const key of HANDLES) {
      if (dist(pts[key], pt) <= tolerance) return key;
    }
    return null;
  }

  /* ---- фигуры с вершинами ---- */

  /* Тяга задаёт основание и высоту. Наклон параллелограмма и сжатие верхнего
     основания трапеций выведены из ширины, поэтому одна и та же тяга всегда
     даёт одну и ту же фигуру, а сама фигура не вылезает за прямоугольник тяги. */
  const SHAPE_SKEW = 0.3;
  const SHAPE_TOP = 0.5;

  const POLY_SHAPES = new Set([
    'square', 'rhombus', 'parallelogram', 'trapezoid', 'trapezoid-iso', 'trapezoid-trapezium',
    'triangle', 'triangle-iso', 'triangle-right', 'triangle-obtuse', 'triangle-scalene', 'triangle-equilateral',
  ]);

  function isPolyShape(shape) {
    return POLY_SHAPES.has(shape);
  }

  function shapePoints(shape, a, b) {
    const r = rectFromPoints(a, b);
    const w = Math.abs(r.w);
    const h = Math.abs(r.h);
    const l = r.x;
    const t = r.y;
    const right = r.x + w;
    const bottom = r.y + h;
    if (shape === 'square') {
      return [
        { x: l, y: t }, { x: right, y: t },
        { x: right, y: bottom }, { x: l, y: bottom },
      ];
    }
    if (shape === 'triangle') {
      /* прямой угол в левом нижнем углу рамки, катеты вдоль её сторон */
      return [
        { x: l, y: t }, { x: l, y: bottom }, { x: right, y: bottom },
      ];
    }

    if (shape === 'triangle-obtuse') {
      return [
        { x: l + w * 0.25, y: t }, { x: l, y: bottom }, { x: right, y: bottom },
      ];
    }
    if (shape === 'triangle-scalene') {
      return [
        { x: l, y: bottom }, { x: right, y: bottom }, { x: l + w * 0.7, y: t },
      ];
    }
    if (shape === 'triangle-iso') {
      /* основание на всю ширину, вершина по центру верхней стороны */
      return [
        { x: l, y: bottom }, { x: right, y: bottom }, { x: l + w / 2, y: t },
      ];
    }
    if (shape === 'triangle-equilateral') {
      /* Как у равнобедренного: вершина привязана к верхней стороне рамки
         (точка старта), основание ниже неё. Высота — настоящая, сторона
         × √3⁄2, но не выше рамки. Раньше вершина считалась от нижней
         стороны (координаты курсора), и при вертикальной тяге вся фигура
         целиком ехала за указателем вместо того чтобы оставаться на месте
         и расти. */
      const hTri = Math.min(h, (w * Math.sqrt(3)) / 2);
      return [
        { x: l, y: t + hTri }, { x: right, y: t + hTri }, { x: l + w / 2, y: t },
      ];
    }
    if (shape === 'rhombus') {
      /* диагонали по средним линиям рамки: все четыре стороны равны */
      const mx = l + w / 2;
      const my = t + h / 2;
      return [
        { x: mx, y: t }, { x: right, y: my },
        { x: mx, y: bottom }, { x: l, y: my },
      ];
    }
    if (shape === 'parallelogram') {
      const k = w * SHAPE_SKEW;
      return [
        { x: l + k, y: bottom }, { x: right, y: bottom },
        { x: right - k, y: t }, { x: l, y: t },
      ];
    }
    const top = w * SHAPE_TOP;
    if (shape === 'trapezoid') {
      /* левая сторона строго вертикальна — два прямых угла слева */
      return [
        { x: l, y: bottom }, { x: right, y: bottom },
        { x: l + w - top, y: t }, { x: l, y: t },
      ];
    }
    if (shape === 'trapezoid-trapezium') {
      /* Произвольная трапеция ABCD с углами A=50°, B=130°, C=160°, D=20°
         (сумма 360°, A+B = 180° → AD ∥ BC), повёрнутая на 180°: длинное основание
         лежит снизу, острые углы A и B — по краям нижней стороны.
         Канонические вершины до поворота: A(0, 0), B(0.643, 0.766), C(1.643, 0.766),
         D(3.747, 0) — отсюда |AB| под 130° к BC, |CD| = sin50°/sin20° ≈ 2.24 под 20°,
         поэтому ∠A = 50°, ∠B = 130°, ∠C = 180° − 20° = 160°, ∠D = 20°.
         Ниже — координаты после поворота в нормализованном виде (x от l до right,
         y от t до bottom), так что пропорции сторон сохраняются в любой рамке. */
      return [
        { x: right, y: bottom },
        { x: l + w * 0.8284, y: t },
        { x: l + w * 0.5615, y: t },
        { x: l, y: bottom },
      ];
    }
    /* равнобедренная: верхнее основание симетрично нижнему */
    return [
      { x: l, y: bottom }, { x: right, y: bottom },
      { x: l + w - top / 2, y: t }, { x: l + top / 2, y: t },
    ];
  }

  /* ---------------- трёхмерные фигуры (каркас с лёгкой заливкой граней) ----------------

     Каждая фигура описана как полигональная сетка в единичном кубе: вершины и грани.
     Грань считается видимой, если её нормаль смотрит на наблюдателя, то есть
     в проекцию попадает нормаль (1, 1, 1) — классическое изометрическое положение,
     при котором видны верх и две боковые стороны. Ребро видимо, если видна хотя бы
     одна из двух смежных граней; остальные рисуются тонким пунктиром. */

  const SOLID_SHAPES = new Set([
    'solid-box',
    'solid-pyramid-3', 'solid-pyramid-4', 'solid-pyramid-5', 'solid-pyramid-6',
    'solid-prism-3', 'solid-prism-4', 'solid-prism-5',
    'solid-sphere',
  ]);

  function isSolidShape(shape) {
    return SOLID_SHAPES.has(shape);
  }

  /* Изометрия: ось x уходит вправо-вниз, y — влево-вниз, z — вверх. */
  const ISO_COS = Math.cos(Math.PI / 6);
  const ISO_SIN = Math.sin(Math.PI / 6);

  /* Свет сверху-слева: левая боковая грань светлее правой, верхняя — самая светлая. */
  const SOLID_LIGHT = (() => {
    const v = [-0.5, 0.6, 0.7];
    const n = Math.hypot(v[0], v[1], v[2]);
    return { x: v[0] / n, y: v[1] / n, z: v[2] / n };
  })();

  function isoProject(p) {
    return { x: (p[0] - p[1]) * ISO_COS, y: (p[0] + p[1]) * ISO_SIN - p[2] };
  }

  /* Правильный n-угольник в плоскости основания, вписанный в круг радиуса 0.5.
     Поворот основания выбирается из двух кандидатов: 0 и π/n. Разница видна
     в изометрии — при 0 у четырёхугольной призмы две грани вырождаются в линии,
     а при π/n у трёхугольной пирамиды остаётся одна грань вместо двух.
     Кандидат выбирается по числу видимых боковых граней, при равенстве — по
     суммарной площади проекции. */
  function regularBase(n) {
    const ph = basePhase(n);
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2 + ph;
      out.push([0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a), 0]);
    }
    return out;
  }

  function basePhase(n) {
    let best = 0;
    let bestScore = null;
    for (const ph of [0, Math.PI / n]) {
      const score = basePhaseScore(n, ph);
      if (bestScore === null || score > bestScore) { bestScore = score; best = ph; }
    }
    return best;
  }

  /* Оценка положения основания: сколько боковых граней смотрит на наблюдателя
     у призмы и у пирамиды, плюс суммарная площадь проекции как tie-break. */
  function basePhaseScore(n, ph) {
    const base = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2 + ph;
      base.push([0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a), 0]);
    }
    const prismVerts = base.concat(base.map((p) => [p[0], p[1], 1]));
    const prismSides = [];
    for (let i = 0; i < n; i++) prismSides.push([i, (i + 1) % n, n + (i + 1) % n, n + i]);
    const pyrVerts = base.concat([[0.5, 0.5, 1]]);
    const pyrSides = [];
    for (let i = 0; i < n; i++) pyrSides.push([i, (i + 1) % n, n]);
    const facing = sideFacingCount(prismVerts, prismSides) + sideFacingCount(pyrVerts, pyrSides);
    return facing * 1000 + projectedArea(prismVerts, prismSides) + projectedArea(pyrVerts, pyrSides);
  }

  /* Сколько боковых граней обращено к наблюдателю: нормаль смотрит вдоль (1,1,1). */
  function sideFacingCount(verts, faces) {
    const center = [0, 0, 0];
    for (const v of verts) { center[0] += v[0]; center[1] += v[1]; center[2] += v[2]; }
    center[0] /= verts.length; center[1] /= verts.length; center[2] /= verts.length;
    const inv = 1 / Math.sqrt(3);
    let count = 0;
    for (const f of faces) {
      const normal = faceNormal(f.map((i) => verts[i]), center);
      if (normal[0] * inv + normal[1] * inv + normal[2] * inv > 0.01) count++;
    }
    return count;
  }

  /* Суммарная площадь граней после проекции: выродившаяся грань даёт ноль. */
  function projectedArea(verts, faces) {
    let sum = 0;
    for (const f of faces) {
      const pr = f.map((i) => isoProject(verts[i]));
      let s = 0;
      for (let i = 0; i < pr.length; i++) {
        const a = pr[i];
        const b = pr[(i + 1) % pr.length];
        s += a.x * b.y - b.x * a.y;
      }
      sum += Math.abs(s / 2);
    }
    return sum;
  }

  /* Нормаль грани, развёрнутая наружу от центра фигуры: так результат не зависит
     от порядка обхода вершин в описании грани. */
  function faceNormal(pts3, center) {
    const [a, b, c] = [pts3[0], pts3[1], pts3[2]];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / len, n[1] / len, n[2] / len];
    let cx = 0, cy = 0, cz = 0;
    for (const p of pts3) { cx += p[0]; cy += p[1]; cz += p[2]; }
    cx /= pts3.length; cy /= pts3.length; cz /= pts3.length;
    const out = [cx - center[0], cy - center[1], cz - center[2]];
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) n = [-n[0], -n[1], -n[2]];
    return n;
  }

  /* Описание сетки по id фигуры. Индекс вершины в кубе: x + 2y + 4z. */
  function solidMesh(shape) {
    if (shape === 'solid-box') {
      const v = [];
      for (const z of [0, 1]) for (const y of [0, 1]) for (const x of [0, 1]) v.push([x, y, z]);
      return {
        verts: v,
        faces: [
          [0, 2, 3, 1], [4, 5, 7, 6],
          [0, 1, 5, 4], [2, 6, 7, 3],
          [0, 4, 6, 2], [1, 3, 7, 5],
        ],
      };
    }
    const prism = /^solid-prism-(\d+)$/.exec(shape);
    if (prism) {
      const n = Number(prism[1]);
      const base = regularBase(n);
      const verts = base.concat(base.map((p) => [p[0], p[1], 1]));
      const faces = [base.map((_, i) => i), base.map((_, i) => n + i)];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        faces.push([i, j, n + j, n + i]);
      }
      return { verts, faces };
    }
    const pyramid = /^solid-pyramid-(\d+)$/.exec(shape);
    if (pyramid) {
      const n = Number(pyramid[1]);
      const base = regularBase(n);
      const verts = base.concat([[0.5, 0.5, 1]]);
      const apex = n;
      const faces = [base.map((_, i) => i)];
      for (let i = 0; i < n; i++) faces.push([i, (i + 1) % n, apex]);
      return { verts, faces };
    }
    return null;
  }

  /* Выпуклая оболочка — силуэт фигуры: по ней работает заливка и попадание курсора. */
  function convexHull(pts) {
    const p = pts.slice().sort((u, v) => u.x - v.x || u.y - v.y);
    if (p.length < 3) return p;
    const cross = (o, u, v) => (u.x - o.x) * (v.y - o.y) - (u.y - o.y) * (v.x - o.x);
    const lower = [];
    for (const q of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
      lower.push(q);
    }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) {
      const q = p[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
      upper.push(q);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  /* Геометрия объёмной фигуры в мировых координатах: грани с признаком видимости
     и оттенком, рёбра с признаком скрытости, эллипсы сферы и силуэт.
     Проекция вписывается в прямоугольник тяги с сохранением пропорций, поэтому
     фигура всегда помещается в свои границы и не искажается при изменении размера. */
  function solidGeometry(shape, a, b) {
    const r = rectFromPoints(a, b);
    if (shape === 'solid-sphere') {
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const rx = Math.abs(r.w / 2);
      const ry = Math.abs(r.h / 2);
      const ring = [];
      for (let i = 0; i < 48; i++) {
        const t = (i / 48) * Math.PI * 2;
        ring.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
      }
      return {
        faces: [],
        edges: [],
        curves: [
          { cx, cy, rx, ry, hidden: false },
          { cx, cy, rx: rx * 0.26, ry, hidden: false },
        ],
        outline: ring,
      };
    }
    const mesh = solidMesh(shape);
    if (!mesh) return null;

    const center = [0, 0, 0];
    for (const p of mesh.verts) { center[0] += p[0]; center[1] += p[1]; center[2] += p[2]; }
    center[0] /= mesh.verts.length; center[1] /= mesh.verts.length; center[2] /= mesh.verts.length;

    const proj = mesh.verts.map(isoProject);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of proj) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    const spanX = (x1 - x0) || 1;
    const spanY = (y1 - y0) || 1;
    const s = Math.min(r.w / spanX, r.h / spanY);
    const ox = r.x + (r.w - spanX * s) / 2;
    const oy = r.y + (r.h - spanY * s) / 2;
    const map = (p) => ({ x: ox + (p.x - x0) * s, y: oy + (p.y - y0) * s });

    const inv = 1 / Math.sqrt(3);
    const faces = mesh.faces.map((idx) => {
      const n = faceNormal(idx.map((i) => mesh.verts[i]), center);
      const facing = n[0] * inv + n[1] * inv + n[2] * inv;
      const lambert = Math.max(0, n[0] * SOLID_LIGHT.x + n[1] * SOLID_LIGHT.y + n[2] * SOLID_LIGHT.z);
      return {
        points: idx.map((i) => map(proj[i])),
        visible: facing > 0.01,
        shade: 0.5 + 0.5 * lambert,
      };
    });

    const edgeMap = new Map();
    mesh.faces.forEach((idx, fi) => {
      for (let i = 0; i < idx.length; i++) {
        const p = idx[i];
        const q = idx[(i + 1) % idx.length];
        const key = p < q ? `${p}|${q}` : `${q}|${p}`;
        let e = edgeMap.get(key);
        if (!e) { e = { p, q, visible: false }; edgeMap.set(key, e); }
        if (faces[fi].visible) e.visible = true;
      }
    });
    const edges = Array.from(edgeMap.values()).map((e) => ({
      a: map(proj[e.p]),
      b: map(proj[e.q]),
      hidden: !e.visible,
    }));

    return { faces, edges, curves: [], outline: convexHull(proj.map(map)) };
  }

  /* Рамка круга: диаметр задаётся большей стороной протяжки, знак — направлением.
     Та же арифметика, что у квадрата, но результат — окружность. */
function circleCorners(a, b) {
    return squareCorners(a, b);
  }

  /* Углы квадрата: тяга задаёт сторону, направление протяжки сохраняется */
  function squareCorners(a, b) {
    const side = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    const sx = b.x === a.x ? 1 : Math.sign(b.x - a.x);
    const sy = b.y === a.y ? 1 : Math.sign(b.y - a.y);
    return { x1: a.x, y1: a.y, x2: a.x + sx * side, y2: a.y + sy * side };
  }

  /* ---- цвета ---- */

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function isDarkColor(hex) {
    const { r, g, b } = hexToRgb(hex);
    return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
  }

  /* ---- перенос текста ---- */

  function measureCtx() {
    if (!measureCtx._ctx) {
      const c = document.createElement('canvas');
      measureCtx._ctx = c.getContext('2d');
    }
    return measureCtx._ctx;
  }

  function wrapText(text, maxWidth, font) {
    const ctx = measureCtx();
    ctx.font = font;
    const out = [];
    for (const paragraph of String(text).split('\n')) {
      if (paragraph === '') { out.push(''); continue; }
      const words = paragraph.split(/(\s+)/);
      let line = '';
      for (const token of words) {
        const candidate = line + token;
        if (ctx.measureText(candidate).width > maxWidth && line.trim() !== '') {
          out.push(line.replace(/\s+$/, ''));
          line = token.replace(/^\s+/, '');
        } else {
          line = candidate;
        }
      }
      out.push(line.replace(/\s+$/, ''));
    }
    return out;
  }

  function textMetrics(text, maxWidth, font) {
    const ctx = measureCtx();
    ctx.font = font;
    const lines = wrapText(text, maxWidth, font);
    const m = ctx.measureText('M');
    const lineHeight = (m.actualBoundingBoxAscent || 10) + (m.actualBoundingBoxDescent || 3) + 6;
    let width = 0;
    for (const l of lines) width = Math.max(width, ctx.measureText(l).width);
    return { lines, lineHeight, width: width || 12, ascent: m.actualBoundingBoxAscent || 10 };
  }

  /* ---------------- линейка и транспортир ---------------- */

  const RULER_LEN = 340;          // длина линейки
  const RULER_H = 40;             // ширина линейки
  const PROT_R = 170;             // радиус транспортира
  const PROT_STEP = Math.PI / 18; // засечка транспортира — 10°

  function newInstrument() {
    return { x: 0, y: 0, angle: 0, visible: false, placed: false };
  }

  /* точка экрана в системе координат инструмента */
  function instrumentLocal(pt, inst) {
    const dx = pt.x - inst.x;
    const dy = pt.y - inst.y;
    const c = Math.cos(inst.angle);
    const s = Math.sin(inst.angle);
    return { x: dx * c + dy * s, y: -dx * s + dy * c };
  }

  function instrumentPoint(local, inst) {
    const c = Math.cos(inst.angle);
    const s = Math.sin(inst.angle);
    return { x: inst.x + local.x * c - local.y * s, y: inst.y + local.x * s + local.y * c };
  }

  /* ручка вращения: у линейки — на конце, у транспортира — на дуге */
  function instrumentHandle(kind) {
    return kind === 'ruler' ? { x: RULER_LEN / 2, y: 0 } : { x: 0, y: -PROT_R };
  }

  /* какая часть инструмента под курсором: 'rotate' | 'body' | null */
  function instrumentHit(kind, inst, screenPt) {
    if (!inst || !inst.visible) return null;
    const local = instrumentLocal(screenPt, inst);
    if (dist(local, instrumentHandle(kind)) <= 13) return 'rotate';
    if (kind === 'ruler') {
      return Math.abs(local.x) <= RULER_LEN / 2 + 4 && Math.abs(local.y) <= RULER_H / 2 + 4 ? 'body' : null;
    }
    if (local.y > 6) return null;
    return local.x * local.x + local.y * local.y <= PROT_R * PROT_R ? 'body' : null;
  }

  IB.geom = {
    RULER_LEN, RULER_H, PROT_R, PROT_STEP,
    newInstrument, instrumentLocal, instrumentPoint, instrumentHandle,
    instrumentHit,
    clamp, lerp, dist, deg, rad, round,
    rectFromPoints, rectUnion, rectsIntersect, rectContainsPoint, inflate,
    toScreen, toWorld, viewToScreenRect,
    distToSegment, distToPolyline, distToRectOutline, pointInEllipse, distToEllipseOutline, pointInTriangle,
    distToPolygon, pointInPolygon,
    POLY_SHAPES, isPolyShape, shapePoints, squareCorners, circleCorners, SHAPE_SKEW, SHAPE_TOP,
    SOLID_SHAPES, isSolidShape, solidGeometry, convexHull, regularBase,
    simplifyPoints, strokePath,
    transformRect, handlePoints, hitHandle, HANDLES,
    hexToRgb, rgba, isDarkColor,
    wrapText, textMetrics, measureCtx,
  };
})(window);
