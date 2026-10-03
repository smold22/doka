/* Доска — попадание указателя по объектам */
(function (global) {
  'use strict';

  const IB = (global.IB = global.IB || {});
  const G = IB.geom;
  const M = IB.model;

  /* Объёмная фигура попадает под курсор, если он внутри её силуэта или рядом
   с любым ребром: сетка состоит из отдельных рёбер, а не из одного контура. */
function solidHit(obj, pt, tolerance) {
  const geo = G.solidGeometry(obj.shape, { x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 });
  if (!geo) return false;
  if (G.pointInPolygon(pt, geo.outline)) return true;
  const tol = obj.width / 2 + tolerance;
  for (const e of geo.edges) {
    if (G.distToSegment(pt, e.a, e.b) <= tol) return true;
  }
  for (const c of geo.curves) {
    const rect = { x: c.cx - c.rx, y: c.cy - c.ry, w: c.rx * 2, h: c.ry * 2 };
    if (G.distToEllipseOutline(pt, rect) <= tol) return true;
  }
  return false;
}

/* Заблокированный объект нельзя стереть и залить: hitTest по умолчанию
     его пропускает, а инструмент «Выделение» зовёт его с includeLocked —
     так объект можно выбрать и снять блокировку, не показывая скрытых
     сочетаний клавиш. */
function hitObject(obj, pt, tolerance, includeLocked) {
    if (obj.locked && !includeLocked) return false;
    const bounds = M.boundsOf(obj);
    if (!G.rectsIntersect(bounds, { x: pt.x - tolerance, y: pt.y - tolerance, w: tolerance * 2, h: tolerance * 2 })) {
      return false;
    }

    switch (obj.type) {
      case 'stroke': {
        const tol = Math.max(tolerance, obj.width / 2);
        return G.distToPolyline(pt, obj.points) <= tol;
      }
      case 'shape': {
        if (obj.shape === 'line') {
          return G.distToSegment(pt, { x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 }) <= obj.width / 2 + tolerance;
        }
        if (obj.shape === 'arrow') {
          const tip = { x: obj.x2, y: obj.y2 };
          const base = { x: obj.x1, y: obj.y1 };
          const total = Math.hypot(tip.x - base.x, tip.y - base.y);
          if (total < 1e-6) {
            return G.distToSegment(pt, base, tip) <= obj.width / 2 + tolerance;
          }
          const angle = Math.atan2(tip.y - base.y, tip.x - base.x);
          /* та же геометрия, что при отрисовке: головка шире стержня,
             поэтому по ней тоже нужно попадать */
          const headLen = Math.min(M.arrowHeadLength(obj.width), total * 0.9);
          const ux = Math.cos(angle);
          const uy = Math.sin(angle);
          const notch = headLen * 0.72;
          const p1 = { x: tip.x - headLen * Math.cos(angle - Math.PI / 7), y: tip.y - headLen * Math.sin(angle - Math.PI / 7) };
          const p3 = { x: tip.x - headLen * Math.cos(angle + Math.PI / 7), y: tip.y - headLen * Math.sin(angle + Math.PI / 7) };
          if (G.pointInTriangle(pt, tip, p1, p3) || G.pointInTriangle(pt, p1, { x: tip.x - notch * ux, y: tip.y - notch * uy }, p3)) {
            return true;
          }
          const shaftEnd = { x: base.x + (total - notch) * ux, y: base.y + (total - notch) * uy };
          return G.distToSegment(pt, base, shaftEnd) <= obj.width / 2 + tolerance;
        }
        if (obj.shape === 'polygon') {
          const pts = Array.isArray(obj.points) ? obj.points : [];
          if (pts.length < 3) return false;
          if (obj.fill && obj.fill !== 'none') return G.pointInPolygon(pt, pts);
          return G.distToPolygon(pt, pts, true) <= obj.width / 2 + tolerance;
        }
        const r = G.rectFromPoints({ x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 });
        if (obj.shape === 'ellipse' || obj.shape === 'circle') {
          if (obj.fill && obj.fill !== 'none') return G.pointInEllipse(pt, r);
          /* контур, а не рамка: иначе круг ловился бы за углы габаритов */
          return G.distToEllipseOutline(pt, r) <= obj.width / 2 + tolerance;
        }
        if (G.isSolidShape(obj.shape)) return solidHit(obj, pt, tolerance);
        if (G.isPolyShape(obj.shape)) {
          const pts = G.shapePoints(obj.shape, { x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 });
          if (obj.fill && obj.fill !== 'none') return G.pointInPolygon(pt, pts);
          return G.distToPolygon(pt, pts, true) <= obj.width / 2 + tolerance;
        }
        if (obj.fill && obj.fill !== 'none') return G.rectContainsPoint(r, pt);
        return G.distToRectOutline(pt, r) <= obj.width / 2 + tolerance;
      }
      case 'text':
        return G.rectContainsPoint(bounds, pt);
      case 'image':
        return G.rectContainsPoint(bounds, pt);
      default:
        return false;
    }
  }

  function hitTest(store, pt, tolerance, includeLocked) {
    const tol = tolerance == null ? 6 : tolerance;
    for (let i = store.items.length - 1; i >= 0; i--) {
      if (hitObject(store.items[i], pt, tol, includeLocked)) return store.items[i];
    }
    return null;
  }

  function hitTestIds(store, pt, tolerance, includeLocked) {
    const obj = hitTest(store, pt, tolerance, includeLocked);
    return obj ? [obj.id] : [];
  }

  function objectsInRect(store, rect, fully) {
    const out = [];
    for (const obj of store.items) {
      if (obj.locked) continue;
      const b = M.boundsOf(obj);
      if (fully) {
        if (
          b.x >= rect.x && b.y >= rect.y &&
          b.x + b.w <= rect.x + rect.w && b.y + b.h <= rect.y + rect.h
        ) out.push(obj.id);
      } else if (G.rectsIntersect(b, rect)) {
        out.push(obj.id);
      }
    }
    return out;
  }

  function objectsInCircle(store, center, radius) {
    const rect = { x: center.x - radius, y: center.y - radius, w: radius * 2, h: radius * 2 };
    const out = [];
    for (const obj of store.items) {
      if (obj.locked) continue;
      const b = M.boundsOf(obj);
      if (G.rectsIntersect(b, rect)) out.push(obj.id);
    }
    return out;
  }

  /* Попадание по внутренней области фигуры независимо от того, залита ли она.
     Нужно инструменту «Заливка»: контур пустой фигуры тонкий, целиться в него
     неудобно. Линии и стрелки не заливаются. */
  function fillInterior(obj, pt, tolerance) {
    if (obj.type !== 'shape') return false;
    if (obj.shape === 'line' || obj.shape === 'arrow') return false;
    if (obj.shape === 'polygon') {
      const pts = Array.isArray(obj.points) ? obj.points : [];
      if (pts.length < 3) return false;
      return G.pointInPolygon(pt, pts) || G.distToPolygon(pt, pts, true) <= tolerance;
    }
    const r = G.rectFromPoints({ x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 });
    if (obj.shape === 'ellipse' || obj.shape === 'circle') {
      return G.pointInEllipse(pt, r) || G.distToEllipseOutline(pt, r) <= obj.width / 2 + tolerance;
    }
    if (G.isSolidShape(obj.shape)) return solidHit(obj, pt, tolerance);
    if (G.isPolyShape(obj.shape)) {
      const pts = G.shapePoints(obj.shape, { x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 });
      return G.pointInPolygon(pt, pts) || G.distToPolygon(pt, pts, true) <= obj.width / 2 + tolerance;
    }
    return G.rectContainsPoint(r, pt) || G.distToRectOutline(pt, r) <= obj.width / 2 + tolerance;
  }

  function hitFillTarget(store, pt, tolerance) {
    const tol = tolerance == null ? 6 : tolerance;
    for (let i = store.items.length - 1; i >= 0; i--) {
      if (store.items[i].locked) continue;
      if (fillInterior(store.items[i], pt, tol)) return store.items[i];
    }
    return null;
  }

  /* Верхняя залитая область под точкой: залитые фигуры и созданные инструментом
     «Заливка» многоугольники. Повторный клик по области должен перекрашивать её,
     а не порождать вторую. */
  function hitFilledInterior(store, pt, tolerance) {
    const tol = tolerance == null ? 6 : tolerance;
    for (let i = store.items.length - 1; i >= 0; i--) {
      const o = store.items[i];
      if (o.locked) continue;
      if (o.type === 'shape' && o.fill && o.fill !== 'none' && fillInterior(o, pt, tol)) return o;
    }
    return null;
  }

  IB.hit = {
    hitObject, hitTest, hitTestIds, hitFillTarget, hitFilledInterior, objectsInRect, objectsInCircle,
  };
})(window);
