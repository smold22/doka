/* Доска — модель сцены и история изменений */
(function (global) {
  'use strict';

  const IB = (global.IB = global.IB || {});
  const G = IB.geom;

  const FONT_FAMILY = '"Segoe UI", system-ui, -apple-system, sans-serif';

  /* Гарнитуры текста: в объекте хранится только идентификатор, а полный
     стек живёт здесь — файл доски остаётся переносимым, а на другой
     машине шрифт подставляется из того же семейства. */
  const FONT_FAMILIES = [
    { id: 'ui', label: 'Системный', stack: FONT_FAMILY },
    { id: 'serif', label: 'Антиква', stack: 'Georgia, "Times New Roman", serif' },
    { id: 'mono', label: 'Моноширинный', stack: '"Cascadia Mono", Consolas, "Courier New", monospace' },
    { id: 'hand', label: 'Рукописный', stack: '"Segoe Print", "Comic Sans MS", cursive' },
  ];

  function familyStack(id) {
    const fam = FONT_FAMILIES.find((f) => f.id === id);
    return fam ? fam.stack : FONT_FAMILY;
  }

  let idSeq = 1;
  function newId() {
    return `o${Date.now().toString(36)}${(idSeq++).toString(36)}`;
  }

  /* Шрифт холста: курсив, полужирный и гарнитура собираются из свойств
     объекта, поэтому метрики переноса и рисование всегда совпадают. */
  const FONT = {
    ink: (size, style) => {
      const s = style || {};
      const italic = s.italic ? 'italic ' : '';
      const weight = s.bold ? '700 ' : '';
      return `${italic}${weight}${size}px ${s.family ? familyStack(s.family) : FONT_FAMILY}`;
    },
  };

  /* ---------- фабрики объектов ---------- */

  /* Заблокированный объект нельзя выделить, сдвинуть, стереть или залить.
     Флаг живёт рядом с остальными свойствами объекта, а не в общем списке,
     поэтому переживает копирование, отмену и сохранение в файл доски. */
  function createStroke(opts) {
    return Object.assign(
      {
        id: newId(),
        type: 'stroke',
        kind: 'pen',
        color: '#1b1f26',
        width: 4,
        alpha: 1,
        points: [],
        locked: false,
      },
      opts
    );
  }

  function createShape(shape, opts) {
    return Object.assign(
      {
        id: newId(),
        type: 'shape',
        shape,
        color: '#1b1f26',
        width: 4,
        fill: 'none',
        /* цвет заливки инструмента «Заливка»; без него заливка берёт цвет обводки */
        fillColor: null,
        x1: 0, y1: 0, x2: 0, y2: 0,
        /* только для shape === 'polygon': залитая область произвольной формы */
        points: null,
        locked: false,
      },
      opts
    );
  }

  function createText(opts) {
    return Object.assign(
      {
        id: newId(),
        type: 'text',
        x: 0, y: 0, w: 320, h: 40,
        text: '',
        color: '#1b1f26',
        fontSize: 28,
        align: 'left',
        /* начертание и гарнитура: см. FONT_FAMILIES */
        bold: false,
        italic: false,
        underline: false,
        family: 'ui',
        locked: false,
      },
      opts
    );
  }

  /* картинка хранится как data URL: файл остаётся один и переносится вместе с доской */
  function createImage(opts) {
    return Object.assign(
      {
        id: newId(),
        type: 'image',
        x: 0, y: 0, w: 320, h: 240,
        src: '',
        name: '',
        naturalW: 0,
        naturalH: 0,
        opacity: 1,
        locked: false,
      },
      opts
    );
  }

  /* ---------- метрики и границы ---------- */

  function objectFont(obj) {
    return FONT.ink(obj.fontSize, obj);
  }

  function arrowHeadLength(width) {
    return Math.max(12, width * 3.2);
  }

  function textBox(obj) {
    if (obj.type !== 'text') return null;
    const m = G.textMetrics(obj.text || ' ', obj.w, objectFont(obj));
    return {
      x: obj.x,
      y: obj.y,
      w: Math.max(obj.w, m.width),
      h: Math.max(m.lines.length * m.lineHeight, m.lineHeight),
      lines: m.lines,
      lineHeight: m.lineHeight,
      ascent: m.ascent,
    };
  }

  /* Сдвиг объекта по доске. Живёт в модели, а не в жестах, потому что
     перенос нужен и перетаскиванию, и дублированию, и выравниванию;
     раньше эта логика была продублирована в трёх местах, причём
     копия в дублировании не двигала точки многоугольников. */
  function translateObject(obj, dx, dy) {
    if (!obj) return;
    switch (obj.type) {
      case 'stroke':
        for (const p of obj.points) {
          p.x += dx;
          p.y += dy;
        }
        break;
      case 'shape':
        obj.x1 += dx; obj.y1 += dy; obj.x2 += dx; obj.y2 += dy;
        if (Array.isArray(obj.points)) {
          for (const p of obj.points) { p.x += dx; p.y += dy; }
        }
        break;
      case 'text':
      case 'image':
        obj.x += dx; obj.y += dy;
        break;
      default:
        break;
    }
  }

  function boundsOf(obj) {
    if (!obj) return null;
    switch (obj.type) {
      case 'stroke': {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of obj.points) {
          x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
          x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
        }
        if (!isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
        const pad = obj.kind === 'highlighter' ? obj.width / 2 + 1 : obj.width / 2 + 1.5;
        return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
      }
      case 'shape': {
        if (obj.shape === 'polygon' && Array.isArray(obj.points) && obj.points.length) {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const p of obj.points) {
            x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
            x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
          }
          return G.inflate({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, (obj.width || 1) / 2 + 2);
        }
        const r = G.rectFromPoints({ x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 });
        const extra = obj.shape === 'arrow' ? arrowHeadLength(obj.width) : obj.width / 2 + 2;
        return G.inflate(r, extra + 2);
      }
      case 'text': {
        const b = textBox(obj);
        return { x: b.x, y: b.y, w: b.w, h: b.h };
      }
      case 'image':
        return { x: obj.x, y: obj.y, w: obj.w, h: obj.h };
      default:
        return { x: 0, y: 0, w: 0, h: 0 };
    }
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /* типы объектов, поддерживаемые приложением (липкие заметки удалены) */
  const TYPES = new Set(['stroke', 'shape', 'text', 'image']);

  function isSupported(obj) {
    return !!obj && TYPES.has(obj.type);
  }

  /* ---------- стор ---------- */

  function createStore() {
    const listeners = { change: [], history: [] };
    let items = [];
    let undoStack = [];
    let redoStack = [];
    let limit = 200;
    let suspend = 0;

    const api = {
      get items() {
        return items;
      },

      on(event, cb) {
        (listeners[event] || (listeners[event] = [])).push(cb);
        return () => {
          const arr = listeners[event];
          const i = arr.indexOf(cb);
          if (i >= 0) arr.splice(i, 1);
        };
      },

      emit(event, payload) {
        for (const cb of (listeners[event] || []).slice()) cb(payload);
      },

      changed(detail) {
        if (suspend > 0) return;
        api.emit('change', detail || {});
      },

      get(id) {
        return items.find((o) => o.id === id) || null;
      },

      indexOf(id) {
        return items.findIndex((o) => o.id === id);
      },

      bounds(ids) {
        const rects = ids.map((id) => boundsOf(api.get(id))).filter(Boolean);
        return G.rectUnion(rects);
      },
      /* ---- операции без записи в историю ---- */
      _insert(objects) {
        for (const o of objects) items.push(o);
      },

      _remove(ids) {
        const set = new Set(ids);
        items = items.filter((o) => !set.has(o.id));
      },

      _patch(changes) {
        for (const ch of changes) {
          const obj = api.get(ch.id);
          const props = ch.props || ch.after;
          if (obj && props) Object.assign(obj, props);
        }
      },

      _reorder(ids) {
        const map = new Map(items.map((o) => [o.id, o]));
        const next = [];
        for (const id of ids) {
          const o = map.get(id);
          if (o) { next.push(o); map.delete(id); }
        }
        items = next.concat([...map.values()]);
      },

      snapshot() {
        return items.map((o) => clone(o));
      },

      load(list) {
        items = (list || [])
          .filter(isSupported)
          .map((o) => {
            const obj = Object.assign({}, o);
            if (!obj.id) obj.id = newId();
            return obj;
          });
        undoStack = [];
        redoStack = [];
        api.changed({ full: true });
        api.emit('history', api.historyState());
      },

      clear() {
        api.load([]);
      },

      /* ---- операции с историей ---- */
      insert(objects, options) {
        if (!objects.length) return;
        const opts = options || {};
        const at = opts.at == null ? items.length : G.clamp(opts.at, 0, items.length);
        api._insertAt(objects, at);
        const snapshot = objects.map(clone);
        api.push({
          label: opts.label || (objects.length > 1 ? 'Добавление объектов' : 'Добавление'),
          undo: () => api._remove(snapshot.map((o) => o.id)),
          redo: () => api._insertAt(snapshot, at),
        });
        api.afterChange({ add: snapshot.map((o) => o.id) });
      },

      _insertAt(objects, index) {
        const pos = G.clamp(index, 0, items.length);
        items.splice(pos, 0, ...objects);
      },

      /* полная замена содержимого без записи в историю */
      _replace(list) {
        items = (list || []).slice();
      },

      remove(ids, label) {
        const list = ids.map((id) => api.get(id)).filter(Boolean);
        if (!list.length) return;
        const snapshot = list.map(clone);
        const positions = snapshot.map((o) => items.indexOf(o));
        api._remove(snapshot.map((o) => o.id));
        api.push({
          label: label || (snapshot.length > 1 ? 'Удаление объектов' : 'Удаление'),
          undo: () => {
            snapshot.forEach((o, i) => api._insertAt([o], positions[i] + i));
          },
          redo: () => api._remove(snapshot.map((o) => o.id)),
        });
        api.afterChange({ remove: snapshot.map((o) => o.id) });
      },

      patch(changes, label) {
        const clean = changes.filter((c) => api.get(c.id));
        if (!clean.length) return;
        const before = clean.map((c) => ({ id: c.id, props: clone(c.before || {}) }));
        const after = clean.map((c) => ({ id: c.id, props: clone(c.after || {}) }));
        api._patch(after);
        api.push({
          label: label || 'Изменение',
          undo: () => api._patch(before),
          redo: () => api._patch(after),
        });
        api.afterChange({ patch: after.map((a) => a.id) });
      },

      reorder(ids, label) {
        const before = items.map((o) => o.id);
        const after = ids.slice();
        api._reorder(after);
        api.push({
          label: label || 'Порядок объектов',
          undo: () => api._reorder(before),
          redo: () => api._reorder(after),
        });
        api.afterChange({ reorder: true });
      },

      push(action) {
        undoStack.push(action);
        if (undoStack.length > limit) undoStack.shift();
        redoStack = [];
        api.emit('history', api.historyState());
      },

      afterChange(detail) {
        api.changed(detail);
        api.emit('history', api.historyState());
      },

      beginBatch() {
        suspend++;
      },

      endBatch() {
        suspend = Math.max(0, suspend - 1);
        if (suspend === 0) api.changed({ batch: true });
      },

      undo() {
        const action = undoStack.pop();
        if (!action) return null;
        action.undo();
        redoStack.push(action);
        api.changed({ history: true });
        api.emit('history', api.historyState());
        return action;
      },

      redo() {
        const action = redoStack.pop();
        if (!action) return null;
        action.redo();
        undoStack.push(action);
        api.changed({ history: true });
        api.emit('history', api.historyState());
        return action;
      },

      historyState() {
        return {
          canUndo: undoStack.length > 0,
          canRedo: redoStack.length > 0,
          undoLabel: undoStack.length ? undoStack[undoStack.length - 1].label : null,
          redoLabel: redoStack.length ? redoStack[redoStack.length - 1].label : null,
        };
      },

      isEmpty() {
        return items.length === 0;
      },
    };

    return api;
  }

  IB.model = {
    newId, FONT, FONT_FAMILY, FONT_FAMILIES, familyStack, isSupported,
    createStroke, createShape, createText, createImage,
    boundsOf, translateObject, textBox, objectFont, arrowHeadLength, clone,
    createStore,
  };
})(window);
