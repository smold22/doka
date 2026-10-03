/* Доска — отрисовка холста */
(function (global) {
  'use strict';

  const IB = (global.IB = global.IB || {});
  const G = IB.geom;
  const M = IB.model;

  const SELECT_COLOR = '#2f7be8';

  function makeSurface(canvas) {
    const ctx = canvas.getContext('2d', { alpha: true });
    const surface = { canvas, ctx, dpr: window.devicePixelRatio || 1, width: 0, height: 0 };

    surface.resize = function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (surface.width === w && surface.height === h && surface.dpr === dpr) return false;
      surface.width = w;
      surface.height = h;
      surface.dpr = dpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      return true;
    };

    return surface;
  }

  function applyView(ctx, view, dpr) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(view.pan.x, view.pan.y);
    ctx.scale(view.scale, view.scale);
  }

  /* ---------------- сетка ---------------- */

  /* Точки сетки держат постоянный размер на экране: это фон, а не
     измерение, поэтому он не должен «дышать» при зуме. */
  function gridStep(view) {
    const target = 28;
    const raw = target / view.scale;
    const pow = Math.pow(2, Math.round(Math.log2(raw)));
    return Math.max(8, pow);
  }

  /* А клетка — наоборот: это тетрадь в клетку, её шаг задан в единицах доски.
     Значит, при увеличении клетка должна расти вместе с рисунком, иначе
     масштаб доски и масштаб клетки расходятся. Шаг удваивается только
     когда клетка на экране стала нечитаемой (сильно отдалены холст). */
  const CELL_BASE = 32;
  const CELL_MIN_PX = 14;

  function cellStep(view) {
    let step = CELL_BASE;
    while (step * view.scale < CELL_MIN_PX) step *= 2;
    return step;
  }

  function drawGrid(ctx, view, width, height) {
    const step = gridStep(view);
    const a = G.toWorld({ x: 0, y: 0 }, view);
    const b = G.toWorld({ x: width, y: height }, view);
    const x0 = Math.floor(a.x / step) * step;
    const y0 = Math.floor(a.y / step) * step;

    ctx.save();
    ctx.beginPath();
    for (let x = x0; x <= b.x; x += step) {
      for (let y = y0; y <= b.y; y += step) {
        ctx.rect(x - 0.75, y - 0.75, 1.5, 1.5);
      }
    }
    ctx.fillStyle = '#cfd6e0';
    ctx.fill();
    ctx.restore();
  }

  /* ---------------- клетка ---------------- */

  const CELL_COLOR = '#d7dce4';

  function drawCells(ctx, view, width, height) {
    const step = cellStep(view);
    const half = 0.5 / view.scale;
    const a = G.toWorld({ x: 0, y: 0 }, view);
    const b = G.toWorld({ x: width, y: height }, view);
    const x0 = Math.floor(a.x / step) * step - step;
    const y0 = Math.floor(a.y / step) * step - step;
    const x1 = b.x + step;
    const y1 = b.y + step;

    ctx.save();
    ctx.beginPath();
    for (let x = x0; x <= x1; x += step) {
      ctx.moveTo(x + half, y0);
      ctx.lineTo(x + half, y1);
    }
    for (let y = y0; y <= y1; y += step) {
      ctx.moveTo(x0, y + half);
      ctx.lineTo(x1, y + half);
    }
    ctx.strokeStyle = CELL_COLOR;
    ctx.lineWidth = 1 / view.scale;
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------- объекты ---------------- */

  function paintStroke(ctx, obj) {
    if (!obj.points.length) return;
    const path = G.strokePath(obj.points);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (obj.kind === 'highlighter') {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.34;
      ctx.strokeStyle = obj.color;
      ctx.lineWidth = obj.width;
      ctx.stroke(path);
      ctx.restore();
    } else {
      ctx.save();
      ctx.globalAlpha = obj.alpha == null ? 1 : obj.alpha;
      ctx.strokeStyle = obj.color;
      ctx.lineWidth = obj.width;
      ctx.stroke(path);
      ctx.restore();
    }
  }

  function fillStyleFor(obj) {
    /* цвет заливки необязателен: без него заливаем цветом обводки */
    const base = obj.fillColor || obj.color;
    if (obj.fill === 'solid') return base;
    if (obj.fill === 'tint') return G.rgba(base, 0.18);
    return null;
  }

  function paintShape(ctx, obj) {
    const r = G.rectFromPoints({ x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 });
    const width = obj.width;

    if (obj.shape === 'line' || obj.shape === 'arrow') {
      const dx = obj.x2 - obj.x1;
      const dy = obj.y2 - obj.y1;
      const total = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      /* наконечник не длиннее самой стрелки, иначе у короткой стрелки
         головка съедает весь стержень и наконечник теряется */
      const headLen = obj.shape === 'arrow' ? Math.min(M.arrowHeadLength(width), total * 0.9) : 0;
      /* стержень обрывается внутри головки: круглая шапка обрезки дошла бы
         до самой вершины и сделала бы конец тупым */
      const notch = headLen * 0.72;
      const shaftEnd = total - notch;
      const sx = obj.x1 + shaftEnd * Math.cos(angle);
      const sy = obj.y1 + shaftEnd * Math.sin(angle);

      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = obj.color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(obj.x1, obj.y1);
      ctx.lineTo(sx, sy);
      ctx.stroke();
      if (headLen > 0) {
        const ux = Math.cos(angle);
        const uy = Math.sin(angle);
        ctx.beginPath();
        ctx.moveTo(obj.x2, obj.y2);
        ctx.lineTo(obj.x2 - headLen * Math.cos(angle - Math.PI / 7), obj.y2 - headLen * Math.sin(angle - Math.PI / 7));
        ctx.lineTo(obj.x2 - notch * ux, obj.y2 - notch * uy);
        ctx.lineTo(obj.x2 - headLen * Math.cos(angle + Math.PI / 7), obj.y2 - headLen * Math.sin(angle + Math.PI / 7));
        ctx.closePath();
        ctx.fillStyle = obj.color;
        ctx.fill();
      }
      ctx.restore();
      return;
    }

    if (G.isSolidShape(obj.shape)) {
      paintSolid(ctx, obj);
      return;
    }

    const fill = fillStyleFor(obj);
    ctx.save();
    ctx.beginPath();
    if (obj.shape === 'ellipse' || obj.shape === 'circle') {
      /* у круга рамка всегда квадратная, поэтому эллипс выходит окружностью */
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.abs(r.w / 2), Math.abs(r.h / 2), 0, 0, Math.PI * 2);
    } else if (obj.shape === 'polygon' && Array.isArray(obj.points) && obj.points.length >= 3) {
      /* залитая область инструмента «Заливка»: произвольный многоугольник */
      ctx.moveTo(obj.points[0].x, obj.points[0].y);
      for (let i = 1; i < obj.points.length; i++) ctx.lineTo(obj.points[i].x, obj.points[i].y);
      ctx.closePath();
    } else if (G.isPolyShape(obj.shape)) {
      /* вершины выводит модель: заливка идёт по тому же пути, что и контур,
         поэтому край не съедается обводкой */
      const pts = G.shapePoints(obj.shape, { x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 });
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    } else {
      const radius = Math.min(8, Math.abs(r.w) / 6, Math.abs(r.h) / 6);
      roundRectPath(ctx, r.x, r.y, r.w, r.h, radius);
    }
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.lineJoin = 'round';
    ctx.strokeStyle = obj.color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
  }

  /* Объёмная фигура: видимые грани заливаются с оттенком по наклону нормали,
   скрытые рёбра рисуются тонким пунктиром, видимые — сплошной обводкой.
   Оттенок берётся от цвета инструмента, поэтому фигура остаётся в палитре. */
function paintSolid(ctx, obj) {
  const geo = G.solidGeometry(obj.shape, { x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 });
  if (!geo) return;
  const base = obj.fillColor || obj.color;
  ctx.save();
  ctx.globalAlpha = obj.alpha == null ? 1 : obj.alpha;
  for (const face of geo.faces) {
    if (!face.visible) continue;
    ctx.beginPath();
    ctx.moveTo(face.points[0].x, face.points[0].y);
    for (let i = 1; i < face.points.length; i++) ctx.lineTo(face.points[i].x, face.points[i].y);
    ctx.closePath();
    ctx.fillStyle = G.rgba(base, 0.10 + 0.22 * face.shade);
    ctx.fill();
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = obj.color;
  if (geo.edges.some((e) => e.hidden)) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.globalAlpha = (obj.alpha == null ? 1 : obj.alpha) * 0.45;
    ctx.lineWidth = Math.max(1, obj.width * 0.6);
    ctx.beginPath();
    for (const e of geo.edges) {
      if (!e.hidden) continue;
      ctx.moveTo(e.a.x, e.a.y);
      ctx.lineTo(e.b.x, e.b.y);
    }
    ctx.stroke();
    ctx.restore();
  }
  ctx.lineWidth = obj.width;
  ctx.beginPath();
  for (const e of geo.edges) {
    if (e.hidden) continue;
    ctx.moveTo(e.a.x, e.a.y);
    ctx.lineTo(e.b.x, e.b.y);
  }
  for (const c of geo.curves) {
    ctx.moveTo(c.cx + c.rx, c.cy);
    ctx.ellipse(c.cx, c.cy, c.rx, c.ry, 0, 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
  }

  function paintText(ctx, obj) {
    const box = M.textBox(obj);
    ctx.save();
    ctx.fillStyle = obj.color;
    ctx.font = M.objectFont(obj);
    ctx.textAlign = obj.align === 'center' ? 'center' : obj.align === 'right' ? 'right' : 'left';
    const x = obj.align === 'center' ? obj.x + obj.w / 2 : obj.align === 'right' ? obj.x + box.w : obj.x;
    let y = box.y + box.ascent;
    for (const line of box.lines) {
      ctx.fillText(line, x, y);
      y += box.lineHeight;
    }
    ctx.restore();
  }

  /* ---------------- картинки ---------------- */

/* Раз.decode по data URL идёт асинхронно, поэтому держим кэш готовых
     картинок и перерисовываем доску, когда пришла новая. */
  const imageCache = new Map();
  let onImageReady = null;

  function setImageReadyHandler(fn) {
    onImageReady = fn;
  }

  function imageFor(src) {
    if (!src) return null;
    const cached = imageCache.get(src);
    if (cached) return cached.complete && cached.naturalWidth ? cached : null;
    const img = new Image();
    img.decoding = 'async';
    img.addEventListener('load', () => {
      if (onImageReady) onImageReady();
    });
    img.src = src;
    imageCache.set(src, img);
    return null;
  }

  /* гарантирует, что все картинки доски загружены — нужно перед экспортом в PNG */
  function imagesReady(items) {
    const pending = [];
    for (const obj of items || []) {
      if (obj.type !== 'image' || !obj.src) continue;
      const img = imageFor(obj.src);
      if (!img) {
        pending.push(new Promise((resolve) => {
          const wait = new Image();
          const done = () => resolve();
          wait.addEventListener('load', done, { once: true });
          wait.addEventListener('error', done, { once: true });
          wait.src = obj.src;
        }));
      }
    }
    return Promise.all(pending);
  }

  function paintImage(ctx, obj) {
    const img = imageFor(obj.src);
    const w = Math.max(1, obj.w);
    const h = Math.max(1, obj.h);
    if (!img) {
      /* пока файл не прочитан — рамка-заглушка на его месте */
      ctx.save();
      ctx.fillStyle = 'rgba(247, 248, 250, 0.9)';
      ctx.fillRect(obj.x, obj.y, w, h);
      ctx.strokeStyle = 'rgba(50, 49, 48, 0.35)';
      ctx.lineWidth = 1 / (ctx.getTransform().a || 1);
      ctx.strokeRect(obj.x + 0.5, obj.y + 0.5, w - 1, h - 1);
      ctx.restore();
      return;
    }
    ctx.save();
    if (obj.opacity != null && obj.opacity !== 1) ctx.globalAlpha = obj.opacity;
    ctx.drawImage(img, obj.x, obj.y, w, h);
    ctx.restore();
  }

  function paintObject(ctx, obj) {
    switch (obj.type) {
      case 'stroke': paintStroke(ctx, obj); break;
      case 'shape': paintShape(ctx, obj); break;
      case 'text': paintText(ctx, obj); break;
      case 'image': paintImage(ctx, obj); break;
      default: break;
    }
  }

  /* ---------------- оверлеи (экранные координаты) ---------------- */

  function dashRect(ctx, r) {
    ctx.save();
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
    ctx.restore();
  }

  /* Рамка заблокированного объекта: сплошная, без хэндлов и с замочком
     в углу — так сразу видно, что объект выбран, но не редактируется. */
  function drawLockChrome(ctx, r) {
    ctx.save();
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
    const size = 9;
    const cx = Math.round(r.x + r.w) - size / 2 - 1;
    const cy = Math.round(r.y) + size / 2 + 1;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.rect(cx - size / 2, cy - size / 2, size, size);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx - size * 0.22, cy - size * 0.06, size * 0.2, Math.PI, 0);
    ctx.stroke();
    ctx.restore();
  }

  function drawSelectionChrome(ctx, screenRect, options) {
    const opts = options || {};
    if (!screenRect) return;
    dashRect(ctx, screenRect);
    if (opts.handles === false) return;
    const size = 8;
    const pts = G.handlePoints(screenRect);
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = 1.5;
    for (const key of G.HANDLES) {
      const p = pts[key];
      const x = p.x - size / 2;
      const y = p.y - size / 2;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, size, size, 2) : ctx.rect(x, y, size, size);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawStrokeUnderway(ctx, stroke) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (stroke.kind === 'highlighter') {
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.34;
    }
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.stroke(G.strokePath(stroke.points));
    ctx.restore();
  }

  function drawRubberBand(ctx, preview, view) {
    if (!preview) return;
    ctx.save();
    applyView(ctx, view, window.devicePixelRatio || 1);
    if (preview.type === 'stroke') {
      drawStrokeUnderway(ctx, preview);
    } else if (preview.type === 'shape') {
      paintShape(ctx, preview);
    } else if (preview.type === 'text') {
      paintObject(ctx, preview);
    }
    ctx.restore();
  }

  function drawEraserCursor(ctx, pt, radius, scale) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(47, 123, 232, 0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(47, 123, 232, 0.8)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------- линейка и транспортир ---------------- */

  const INSTRUMENT_COLOR = '#2f7be8';

  function drawInstrumentBase(ctx, inst) {
    ctx.translate(inst.x, inst.y);
    ctx.rotate(inst.angle);
  }

  function drawRotateHandle(ctx, x, y) {
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = INSTRUMENT_COLOR;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  function drawRuler(ctx, ruler) {
    const h = G.RULER_H;
    const l = G.RULER_LEN / 2;
    ctx.save();
    drawInstrumentBase(ctx, ruler);
    ctx.beginPath();
    roundRectPath(ctx, -l, -h / 2, G.RULER_LEN, h, 6);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(47, 123, 232, 0.85)';
    ctx.stroke();
    /* засечки: короткие каждые 10 px, длинные каждые 50 */
    ctx.beginPath();
    for (let x = -l + 10; x < l - 4; x += 10) {
      const long = Math.round(x + l) % 50 === 0;
      ctx.moveTo(x, -h / 2);
      ctx.lineTo(x, -h / 2 + (long ? 14 : 7));
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(50, 49, 48, 0.55)';
    ctx.stroke();
    drawRotateHandle(ctx, l, 0);
    ctx.restore();
  }

  function drawProtractor(ctx, protractor, guide) {
    const r = G.PROT_R;
    ctx.save();
    /* в режиме обучения транспортир полупрозрачный: по нему ришут пером и маркером */
    if (guide) ctx.globalAlpha = 0.6;
    drawInstrumentBase(ctx, protractor);
    ctx.beginPath();
    ctx.arc(0, 0, r, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = guide ? 'rgba(255, 255, 255, 0.72)' : 'rgba(255, 255, 255, 0.9)';
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(47, 123, 232, 0.85)';
    ctx.stroke();
    /* засечки каждые 10°, длинные каждые 30° */
    ctx.beginPath();
    const marks = 18;
    for (let i = 0; i <= marks; i += 1) {
      const a = Math.PI + (i * Math.PI) / marks;
      const major = i % 3 === 0;
      const c = Math.cos(a);
      const s = Math.sin(a);
      ctx.moveTo(c * r, s * r);
      ctx.lineTo(c * (r - (major ? 16 : 9)), s * (r - (major ? 16 : 9)));
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(50, 49, 48, 0.55)';
    ctx.stroke();

    /* одна числовая шкала: 0–180° */
    ctx.save();
    ctx.fillStyle = 'rgba(38, 37, 36, 0.92)';
    ctx.font = '800 11px system-ui, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 9; i += 1) {
      const deg = i * 20;
      const a = Math.PI + (deg * Math.PI) / 180;
      const dist = r - 22;
      ctx.fillText(deg === 0 || deg === 180 ? `${deg}°` : String(deg),
        Math.cos(a) * dist, Math.sin(a) * dist + 1);
    }
    ctx.restore();

    /* Вторая шкала — над дугой, снаружи транспортира. Засечки те же самые,
       а числа зеркальные: 180° слева до 0° справа, поэтому угол читается
       и от второго луча. */
    const out = r + 9;
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, out, Math.PI, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(50, 49, 48, 0.35)';
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i <= marks; i += 1) {
      const a = Math.PI + (i * Math.PI) / marks;
      const len = i % 3 === 0 ? 7 : 4;
      const c = Math.cos(a);
      const s = Math.sin(a);
      ctx.moveTo(c * out, s * out);
      ctx.lineTo(c * (out + len), s * (out + len));
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(50, 49, 48, 0.45)';
    ctx.stroke();

    ctx.fillStyle = 'rgba(38, 37, 36, 0.75)';
    ctx.font = '700 10px system-ui, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 9; i += 1) {
      const deg = 180 - i * 20;
      const a = Math.PI + (i * Math.PI) / 9;
      const dist = r + 27;
      ctx.fillText(deg === 0 || deg === 180 ? `${deg}°` : String(deg),
        Math.cos(a) * dist, Math.sin(a) * dist);
    }
    ctx.restore();

    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(47, 123, 232, 0.85)';
    ctx.fill();
    /* ручка вращения остаётся заметной даже у полупрозрачного транспортира */
    if (guide) ctx.globalAlpha = 1;
    drawRotateHandle(ctx, 0, -r);
    ctx.restore();
  }

  /* ---------------- основной рендер ---------------- */

  function render(surface, scene) {
    const { ctx, dpr } = surface;
    const { store, view, selection, preview, marquee, eraser, showGrid, showCells, hoveredId } = scene;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, surface.width, surface.height);

    applyView(ctx, view, dpr);

    if (showCells) drawCells(ctx, view, surface.width, surface.height);
    else if (showGrid) drawGrid(ctx, view, surface.width, surface.height);

    const selected = new Set(selection);
    for (const obj of store.items) {
      if (selected.has(obj.id) && scene.dimSelected) continue;
      paintObject(ctx, obj);
    }
    if (scene.dimSelected) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      for (const obj of store.items) {
        if (selected.has(obj.id)) paintObject(ctx, obj);
      }
      ctx.restore();
    }

    drawRubberBand(ctx, preview, view);

    /* оверлеи в экранных координатах */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (eraser) drawEraserCursor(ctx, eraser, scene.eraserRadius || 20, view.scale);

    if (scene.ruler && scene.ruler.visible) drawRuler(ctx, scene.ruler);
    if (scene.protractor && scene.protractor.visible) drawProtractor(ctx, scene.protractor, scene.protractorGuide);

    if (marquee) {
      ctx.save();
      ctx.fillStyle = 'rgba(47, 123, 232, 0.1)';
      ctx.strokeStyle = 'rgba(47, 123, 232, 0.9)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      const r = G.rectFromPoints(marquee.a, marquee.b);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
      ctx.restore();
    }

    if (selection.length) {
      const rects = selection
        .map((id) => store.get(id))
        .filter(Boolean)
        .map((obj) => G.viewToScreenRect(M.boundsOf(obj), view));
      for (const r of rects) {
        /* у заблокированного объекта рамка сплошная: пунктир остаётся
           признаком выделения, с которым можно работать */
        const locked = rects.length === 1 &&
          (store.get(selection[0]) || {}).locked;
        if (locked) drawLockChrome(ctx, G.inflate(r, 2));
        else if (rects.length > 1 || scene.singleSelection) dashRect(ctx, G.inflate(r, 2));
      }
      const union = G.rectUnion(rects);
      /* union === null, если выделение ссылается на уже удалённые объекты
         (например, стёрли ластиком, а выделение ещё не обновилось) */
      if (!union) {
        /* ничего обводить нечего */
      } else if (scene.singleSelection && !(store.get(selection[0]) || {}).locked) {
        drawSelectionChrome(ctx, G.inflate(union, 2), { handles: scene.showHandles !== false });
      } else if (!scene.singleSelection) {
        dashRect(ctx, G.inflate(union, 2));
      }
    }

    if (scene.endpointHandles && scene.endpointHandles.length) {
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = SELECT_COLOR;
      ctx.lineWidth = 1.5;
      for (const p of scene.endpointHandles) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    if (hoveredId) {      const obj = store.get(hoveredId);
      if (obj && !selection.includes(hoveredId)) {
        const r = G.viewToScreenRect(M.boundsOf(obj), view);
        ctx.save();
        ctx.strokeStyle = 'rgba(47, 123, 232, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.restore();
      }
    }
  }

  /* ---------------- экспорт ---------------- */

  function renderToCanvas(store, bounds, options) {
    const opts = options || {};
    const scale = opts.scale || 2;
    const pad = opts.padding == null ? 24 : opts.padding;
    const background = opts.background || '#ffffff';
    const w = Math.max(1, Math.ceil((bounds.w + pad * 2) * scale));
    const h = Math.max(1, Math.ceil((bounds.h + pad * 2) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(-bounds.x + pad, -bounds.y + pad);
    for (const obj of store.items) paintObject(ctx, obj);
    ctx.restore();
    return canvas;
  }

  IB.paint = {
    makeSurface, applyView, render, renderToCanvas, paintObject, drawSelectionChrome,
    drawRubberBand, gridStep, cellStep, drawCells, roundRectPath, SELECT_COLOR,
    setImageReadyHandler, imagesReady,
  };
})(window);
