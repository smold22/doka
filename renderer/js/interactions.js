/* Доска — работа с указателем, инструменты, редактирование текста */
(function (global) {
  'use strict';

  const IB = (global.IB = global.IB || {});
  const G = IB.geom;
  const M = IB.model;
  const Hit = IB.hit;
  const Paint = IB.paint;
  const Region = IB.region;

  const MIN_SCALE = 0.05;
  const MAX_SCALE = 8;
  const HANDLE_SIZE = 9;

  function createInteractions(app) {
    const { state, store, surface } = app;
    const canvas = surface.canvas;
    const overlay = document.getElementById('overlay');

    let drag = null;      // текущий жест
    let editor = null;    // активный редактор текста
    let spaceDown = false;
    let lastPointer = { x: 0, y: 0 };

    /* ---------------- преобразования вида ---------------- */

    function zoomAt(screenPt, factor) {
      stopZoomAnim();
      const before = G.toWorld(screenPt, state.view);
      const scale = G.clamp(state.view.scale * factor, MIN_SCALE, MAX_SCALE);
      if (scale === state.view.scale) return;
      state.view.scale = scale;
      state.view.pan.x = screenPt.x - before.x * scale;
      state.view.pan.y = screenPt.y - before.y * scale;
      app.requestRender();
      app.onViewChanged();
    }

    /* ---------------- плавный зум ---------------- */

    /* Масштаб едет к цели по кадрам, а не скачком. Кадр всегда считается
       от точки под курсором, поэтому холст «едет» к мыши, а не к центру. */
    const ZOOM_MIN_MS = 110;
    const ZOOM_MAX_MS = 300;

    let zoomAnim = null;
    let zoomFrame = 0;
    let zoomTimer = 0;

    function stopZoomAnim() {
      zoomAnim = null;
      clearZoomQueue();
    }

    function applyZoomFrame(world, screen, scale) {
      state.view.scale = scale;
      state.view.pan.x = screen.x - world.x * scale;
      state.view.pan.y = screen.y - world.y * scale;
      app.requestRender();
      app.onViewChanged();
    }

    /* Кадры просим и через requestAnimationFrame, и таймером: в скрытом
       окне кадров нет, и зум иначе замирает на середине пути. Но очередь
       должна быть одна на оба источника — иначе каждый таймер заводит
       свой следующий, число шагов растёт лавиной, и зум дёргается. */
    function clearZoomQueue() {
      if (zoomFrame) {
        cancelAnimationFrame(zoomFrame);
        zoomFrame = 0;
      }
      if (zoomTimer) {
        clearTimeout(zoomTimer);
        zoomTimer = 0;
      }
    }

    function scheduleZoomFrame() {
      clearZoomQueue();
      zoomFrame = requestAnimationFrame(runZoomAnim);
      zoomTimer = setTimeout(runZoomAnim, 16);
    }

    function runZoomAnim() {
      zoomFrame = 0;
      if (!zoomAnim) {
        clearZoomQueue();
        return;
      }
      const a = zoomAnim;
      const t = G.clamp((performance.now() - a.start) / a.dur, 0, 1);
      /* мягкое торможение к концу: без него масштаб «дёргается» на стопе */
      const k = 1 - (1 - t) * (1 - t) * (1 - t);
      /* масштаб интерполируем по логарифму: так шаг зума одинаковый
         и на 10 %, и на 800 % */
      const scale = a.from * Math.pow(a.to / a.from, k);
      applyZoomFrame(a.world, a.screen, scale);
      if (t < 1) scheduleZoomFrame();
      else {
        zoomAnim = null;
        clearZoomQueue();
      }
    }

    /* Куда зум едет прямо сейчас: пока анимация жива — в её цель,
       иначе в текущий масштаб. */
    function zoomTarget() {
      return zoomAnim ? zoomAnim.to : state.view.scale;
    }

    /* Плавно приводит масштаб к целевому, удерживая точку под курсором. */
    function zoomTo(screenPt, targetScale) {
      const to = G.clamp(targetScale, MIN_SCALE, MAX_SCALE);
      if (Math.abs(to - state.view.scale) < 1e-9) {
        stopZoomAnim();
        return;
      }
      const sameAnchor = zoomAnim && zoomAnim.screen.x === screenPt.x && zoomAnim.screen.y === screenPt.y;
      const from = state.view.scale;
      zoomAnim = {
        from,
        to,
        world: G.toWorld(screenPt, state.view),
        screen: { x: screenPt.x, y: screenPt.y },
        /* отсчёт сдвинут на кадр назад, иначе первый кадр ничего не
           меняет и зум кажется «залипающим» на щелчке колеса */
        start: sameAnchor ? zoomAnim.start : performance.now() - 16,
        dur: sameAnchor ? zoomAnim.dur : ZOOM_MIN_MS,
      };
      /* чем больше расстояние, тем дольше едем, но не дольше потолка */
      const dist = Math.abs(Math.log(to / from));
      zoomAnim.dur = G.clamp(ZOOM_MIN_MS + dist * 160, ZOOM_MIN_MS, ZOOM_MAX_MS);
      /* цель обновилась на ходу — перезапускаем очередь кадров от новой цели,
         иначе зум поедет по старой и упирается в потолок */
      scheduleZoomFrame();
    }

    function zoomByStep(dir) {
      const center = { x: surface.width / 2, y: surface.height / 2 };
      zoomTo(center, state.view.scale * (dir > 0 ? 1.2 : 1 / 1.2));
    }

    function zoomToScale(scale, center) {
      const c = center || { x: surface.width / 2, y: surface.height / 2 };
      zoomTo(c, scale);
    }

    function fitToContent() {
      stopZoomAnim();
      if (store.isEmpty()) {
        state.view.scale = 1;
        state.view.pan = { x: surface.width / 2, y: surface.height / 2 };
        app.requestRender();
        app.onViewChanged();
        return;
      }
      const b = store.bounds(store.items.map((o) => o.id));
      const pad = 60;
      const scale = G.clamp(
        Math.min((surface.width - pad * 2) / Math.max(b.w, 1), (surface.height - pad * 2) / Math.max(b.h, 1)),
        MIN_SCALE,
        1.5
      );
      state.view.scale = scale;
      state.view.pan.x = surface.width / 2 - (b.x + b.w / 2) * scale;
      state.view.pan.y = surface.height / 2 - (b.y + b.h / 2) * scale;
      app.requestRender();
      app.onViewChanged();
    }

    function resetView() {
      stopZoomAnim();
      state.view.scale = 1;
      state.view.pan = { x: surface.width / 2, y: surface.height / 2 };
      app.requestRender();
      app.onViewChanged();
    }

    /* ---------------- снимки для трансформаций ---------------- */

    function snapshotOf(objects) {
      return objects.map((o) => ({ id: o.id, props: M.clone(o) }));
    }

    function commitTransform(snapshot, label) {
      const changes = [];
      for (const snap of snapshot) {
        const obj = store.get(snap.id);
        if (!obj) continue;
        const before = {};
        const after = {};
        for (const key of Object.keys(snap.props)) {
          if (key === 'id') continue;
          const was = snap.props[key];
          const now = obj[key];
          if (JSON.stringify(was) !== JSON.stringify(now)) {
            before[key] = M.clone(was);
            after[key] = M.clone(now);
          }
        }
        if (Object.keys(after).length) changes.push({ id: snap.id, before, after });
      }
      if (changes.length) store.patch(changes, label);
      else app.requestRender();
    }

    function translateObject(obj, dx, dy) {
      M.translateObject(obj, dx, dy);
    }

    function applyRectToObject(obj, from, to) {
      const sx = from.w ? to.w / from.w : 1;
      const sy = from.h ? to.h / from.h : 1;
      const mapX = (x) => to.x + (x - from.x) * sx;
      const mapY = (y) => to.y + (y - from.y) * sy;

      switch (obj.type) {
        case 'stroke':
          for (const p of obj.points) {
            p.x = mapX(p.x);
            p.y = mapY(p.y);
          }
          obj.width = Math.max(1, obj.width * Math.min(sx, sy));
          break;
        case 'shape': {
          if (Array.isArray(obj.points)) {
            for (const p of obj.points) {
              p.x = mapX(p.x);
              p.y = mapY(p.y);
            }
            break;
          }
          obj.x1 = mapX(obj.x1);
          obj.x2 = mapX(obj.x2);
          obj.y1 = mapY(obj.y1);
          obj.y2 = mapY(obj.y2);
          /* растягивание по одной оси не должно ломать квадрат и круг */
          if (obj.shape === 'square' || obj.shape === 'circle') {
            const side = Math.max(Math.abs(obj.x2 - obj.x1), Math.abs(obj.y2 - obj.y1));
            obj.x2 = obj.x1 + (obj.x2 < obj.x1 ? -side : side);
            obj.y2 = obj.y1 + (obj.y2 < obj.y1 ? -side : side);
          }
          obj.width = Math.max(1, obj.width * Math.min(sx, sy));
          break;
        }
        case 'text': {
          obj.x = mapX(obj.x);
          obj.y = mapY(obj.y);
          const factor = Math.min(Math.abs(sx), Math.abs(sy));
          obj.fontSize = G.clamp(obj.fontSize * factor, 8, 400);
          obj.w = Math.max(60, obj.w * sx);
          break;
        }
        case 'image': {
          obj.x = mapX(obj.x);
          obj.y = mapY(obj.y);
          obj.w = Math.max(8, obj.w * sx);
          obj.h = Math.max(8, obj.h * sy);
          break;
        }
        default:
          break;
      }
    }

    /* ---------------- выделение ---------------- */

    function selectionRect() {
      if (!state.selection.length) return null;
      const b = store.bounds(state.selection);
      return b;
    }

    function singleObject() {
      return state.selection.length === 1 ? store.get(state.selection[0]) : null;
    }

    function handleTargets() {
      const obj = singleObject();
      if (obj && obj.type === 'shape' && (obj.shape === 'line' || obj.shape === 'arrow')) {
        const view = state.view;
        return {
          custom: [
            { key: 'p1', pt: G.toScreen({ x: obj.x1, y: obj.y1 }, view) },
            { key: 'p2', pt: G.toScreen({ x: obj.x2, y: obj.y2 }, view) },
          ],
          rect: G.viewToScreenRect(M.boundsOf(obj), view),
        };
      }
      const rect = selectionRect();
      if (!rect) return null;
      return { rect: G.viewToScreenRect(rect, state.view) };
    }

    function hitHandleAt(screenPt) {
      const targets = handleTargets();
      if (!targets) return null;
      if (targets.custom) {
        for (const c of targets.custom) {
          if (G.dist(c.pt, screenPt) <= HANDLE_SIZE) return c.key;
        }
        return null;
      }
      return G.hitHandle(targets.rect, screenPt, HANDLE_SIZE);
    }

    function setSelection(ids) {
      state.selection = ids.slice();
      app.requestRender();
      app.onSelectionChanged();
    }

    function deselect() {
      if (!state.selection.length) return;
      setSelection([]);
    }

    /* Заблокированные объекты не попадают ни в рамку выделения, ни в выделение
       целиком, ни под удаление — иначе блокировка ничего бы не защищала. */
    function unlockedIds(ids) {
      return ids.filter((id) => {
        const o = store.get(id);
        return !!o && !o.locked;
      });
    }

    function selectAll() {
      setSelection(unlockedIds(store.items.map((o) => o.id)));
    }

    /* Блокировка переключается на выделенном: если заблокирован хоть один,
       снимаем блокировку со всех, иначе — блокируем всё выделение. */
    function toggleLock() {
      const ids = state.selection.slice();
      if (!ids.length) return false;
      const lock = !ids.some((id) => {
        const o = store.get(id);
        return o && o.locked;
      });
      const changes = ids
        .map((id) => ({ id, before: { locked: !lock }, after: { locked: lock } }))
        .filter((c) => !!store.get(c.id));
      if (!changes.length) return false;
      store.patch(changes, lock ? 'Блокировка' : 'Снятие блокировки');
      app.markDirty();
      return lock;
    }

    function deleteSelection() {
      if (!state.selection.length) return;
      const ids = unlockedIds(state.selection);
      setSelection([]);
      /* закрываем редактор, иначе останется «висящее» поле ввода удалённого объекта */
      if (editor) finishTextEdit();
      if (!ids.length) return;
      store.remove(ids);
      app.markDirty();
    }

    /* Полная очистка доски. Один шаг истории: Ctrl+Z возвращает всё
       на место, поэтому подтверждение здесь лишнее. */
    function clearBoard() {
      if (store.isEmpty()) {
        app.toast('Доска уже пуста');
        return 0;
      }
      const all = store.items.length;
      const ids = unlockedIds(store.items.map((o) => o.id));
      setSelection([]);
      finishTextEdit();
      if (!ids.length) {
        app.toast(`Доска не пуста: ${all} объект(ов) заблокировано`);
        return 0;
      }
      const count = store.remove(ids, 'Очистка доски');
      app.markDirty();
      const kept = all - ids.length;
      app.toast(kept
        ? `Доска очищена: удалено ${count}, заблокировано оставлено ${kept}`
        : `Доска очищена: удалено объектов — ${count}`);
      return count;
    }

    function duplicateSelection(offset) {
      if (!state.selection.length) return;
      const d = offset == null ? 24 / state.view.scale : offset;
      const copies = state.selection
        .map((id) => store.get(id))
        .filter(Boolean)
        .map((o) => {
          const copy = M.clone(o);
          copy.id = M.newId();
          M.translateObject(copy, d, d);
          return copy;
        });
      store.insert(copies);
      setSelection(copies.map((c) => c.id));
      app.markDirty();
    }

    /* ---------------- буфер обмена ---------------- */

    function copySelection(cut) {
      if (!state.selection.length) return;
      const items = state.selection.map((id) => store.get(id)).filter(Boolean).map(M.clone);
      state.clipboard = { items };
      /* одиночная картинка кладётся в буфер ещё и как изображение —
         тогда её можно вставить в другое приложение */
      const single = items.length === 1 && items[0].type === 'image' ? items[0] : null;
      try {
        window.inkboard.writeClipboard({
          text: JSON.stringify({ format: IB.persist.FORMAT, version: IB.persist.VERSION, items }),
          imageDataUrl: single ? single.src : null,
        });
      } catch (err) { /* ignore */ }
      if (cut) deleteSelection();
      else app.toast(`Скопировано: ${items.length}`);
    }

    function importItems(items) {
      const copies = (items || [])
        .filter(M.isSupported)
        .map((o) => {
          const copy = M.clone(o);
          copy.id = M.newId();
          return copy;
        });
      if (!copies.length) return 0;
      store.insert(copies);
      setSelection(copies.map((c) => c.id));
      app.markDirty();
      return copies.length;
    }

    /* ---------------- картинки ---------------- */

    /* Максимальный размер картинки при вставке: она не должна закрывать
       всю доску целиком. Пропорции сохраняются. */
    const MAX_IMAGE_SIDE = 640;

    function loadImageSize(src) {
      return new Promise((resolve) => {
        const img = new Image();
        img.addEventListener('load', () => resolve({ w: img.naturalWidth, h: img.naturalHeight }), { once: true });
        img.addEventListener('error', () => resolve(null), { once: true });
        img.src = src;
      });
    }

    function fitImageSize(w, h) {
      if (!w || !h) return { w: 320, h: 240 };
      const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(w, h));
      return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
    }

    /* Ставит картинку в середину текущего вида. Возвращает созданный объект. */
    async function insertImage(src, name, offset) {
      if (!src) return null;
      const size = await loadImageSize(src);
      if (!size) {
        app.toast('Не удалось прочитать картинку', true);
        return null;
      }
      const fit = fitImageSize(size.w, size.h);
      const center = G.toWorld({ x: surface.width / 2, y: surface.height / 2 }, state.view);
      const step = offset == null ? 0 : offset;
      const obj = M.createImage({
        src,
        name: name || '',
        naturalW: size.w,
        naturalH: size.h,
        w: fit.w,
        h: fit.h,
        x: Math.round(center.x - fit.w / 2 + step),
        y: Math.round(center.y - fit.h / 2 + step),
      });
      store.insert([obj]);
      setSelection([obj.id]);
      app.markDirty();
      return obj;
    }

    /* ---------------- вставка текста ---------------- */

    /* Каждая строка вставляется своим объектом: так текст можно двигать и
       править по частям. Шрифт и цвет берутся у текущего инструмента. */
    function insertText(text) {
      const clean = String(text || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
      if (!clean.trim()) return 0;
      finishTextEdit();
      const scale = state.view.scale;
      const center = G.toWorld({ x: surface.width / 2, y: surface.height / 2 }, state.view);
      const fontSize = G.clamp(state.textSize / scale, 8, 200);
      const made = clean.split('\n').map((line, i) => {
        const draft = M.createText({
          x: center.x,
          y: center.y + i * fontSize * 1.4,
          w: 320 / scale,
          fontSize,
          color: state.color,
          text: line,
          bold: state.textFmt.bold,
          italic: state.textFmt.italic,
          underline: state.textFmt.underline,
          family: state.textFmt.family,
          align: state.textFmt.align,
        });
        const box = M.textBox(draft);
        draft.h = box.lines.length * box.lineHeight;
        draft.w = Math.max(60, box.w);
        return draft;
      });
      store.insert(made);
      setSelection(made.map((o) => o.id));
      app.markDirty();
      app.requestRender();
      return made.length;
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => resolve(String(reader.result || '')), { once: true });
        reader.addEventListener('error', () => resolve(''), { once: true });
        reader.readAsDataURL(file);
      });
    }

    /* Общая вставка: картинка из буфера, объекты доски или обычный текст.
       Приоритет у картинки — в буфере текст есть почти всегда. */
    async function pasteContent({ files = [], text = '', html = '' } = {}) {
      const file = (files || []).find((f) => /^image\//i.test(f.type));
      if (file) {
        const obj = await insertImage(await readFileAsDataUrl(file), file.name || 'Вставленная картинка');
        if (obj) app.toast('Вставлена картинка из буфера обмена');
        return obj ? 'image' : null;
      }
      /* из браузера картинка часто приходит только как data URL внутри HTML */
      const inHtml = html && html.match(/<img[^>]+src="(data:image\/[^"]+)"/i);
      if (inHtml) {
        const obj = await insertImage(inHtml[1], 'Вставленная картинка');
        if (obj) app.toast('Вставлена картинка из буфера обмена');
        return obj ? 'image' : null;
      }
      if (!text) return null;
      try {
        const parsed = JSON.parse(text);
        if (parsed && Array.isArray(parsed.items)) {
          const count = importItems(parsed.items);
          app.toast(`Вставлено объектов: ${count}`);
          return 'items';
        }
      } catch (err) { /* не JSON — значит это обычный текст */ }
      const count = insertText(text);
      app.toast(count ? `Вставлен текст${count > 1 ? `: строк — ${count}` : ''}` : 'В буфере обмена нечего вставлять');
      return count ? 'text' : null;
    }

    async function paste() {
      if (state.clipboard && state.clipboard.items.length) {
        const count = importItems(state.clipboard.items);
        app.toast(`Вставлено объектов: ${count}`);
        return;
      }
      let data;
      try {
        data = await window.inkboard.readClipboard();
      } catch (err) {
        app.toast('В буфере обмена нечего вставлять');
        return;
      }
      if (data.imageDataUrl) {
        const obj = await insertImage(data.imageDataUrl, 'Вставленная картинка');
        if (obj) app.toast('Вставлена картинка из буфера обмена');
        return;
      }
      await pasteContent({ text: data.text || '' });
    }

    /* ---------------- редактор текста ---------------- */

    /* правка началась или закончилась: панель настроек показывает
       блок форматирования текста, пока открыто поле ввода */
    function notifyEditing() {
      if (app.onEditingChanged) app.onEditingChanged();
    }

    /* черновик открытой правки: на него сразу ложатся цвет, размер и
       начертание, а в доску они попадают одним patch при коммите */
    function editingDraft() {
      return editor ? editor.draft : null;
    }

    function makeEditor(draft, isNew, origin) {
      const ta = document.createElement('textarea');
      ta.value = draft.text || '';
      ta.spellcheck = false;
      overlay.appendChild(ta);
      editor = { draft, isNew, origin, ta, pointerStart: null };
      layoutEditor();
      ta.focus();
      if (isNew) ta.setSelectionRange(ta.value.length, ta.value.length);
      /* существующий текст выделяется целиком: набор сразу его переписывает,
         щелчок внутри поля ставит курсор и снимает выделение */
      else ta.select();
      notifyEditing();

      ta.addEventListener('input', () => {
        editor.draft.text = ta.value;
        layoutEditor();
        app.markDirty();
        app.requestRender();
      });
      ta.addEventListener('keydown', (e) => {
        /* сочетания с Ctrl/Alt обрабатываются глобально (сохранение и т. п.) */
        if (!(e.ctrlKey || e.metaKey || e.altKey)) e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          /* Escape фиксирует набранный текст: отменять начатое неожиданно */
          if (ta.value.replace(/\s+$/, '')) commitTextEdit();
          else cancelTextEdit();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          commitTextEdit();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          const s = ta.selectionStart;
          const v = ta.value;
          ta.value = `${v.slice(0, s)}\t${v.slice(ta.selectionEnd)}`;
          editor.draft.text = ta.value;
          ta.selectionStart = ta.selectionEnd = s + 1;
          layoutEditor();
          app.requestRender();
        }
      });
      ta.addEventListener('blur', () => {
        if (editor && editor.ta === ta) commitTextEdit();
      });
      ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    }

    function layoutEditor() {
      if (!editor) return;
      const { draft, ta } = editor;
      const scale = state.view.scale;
      const box = M.textBox(draft);
      const lineHeight = box.lineHeight;

      const width = Math.max(box.w * scale, 40);
      const height = Math.max(lineHeight * box.lines.length * scale, lineHeight * scale);
      const origin = G.toScreen({ x: box.x, y: box.y }, state.view);

      ta.style.fontSize = `${draft.fontSize * scale}px`;
      ta.style.lineHeight = `${lineHeight * scale}px`;
      ta.style.width = `${width}px`;
      ta.style.height = `${height}px`;
      ta.style.left = `${origin.x}px`;
      ta.style.top = `${origin.y}px`;
      ta.style.transform = 'none';
      /* начертание и цвет поля ввода повторяют объект: пока идёт правка,
         именно textarea показывает текст, а не холст */
      ta.style.fontFamily = M.familyStack(draft.family);
      ta.style.fontWeight = draft.bold ? '700' : '400';
      ta.style.fontStyle = draft.italic ? 'italic' : 'normal';
      ta.style.textDecoration = draft.underline ? 'underline' : 'none';
      ta.style.textAlign = draft.align === 'center' ? 'center' : draft.align === 'right' ? 'right' : 'left';
      ta.style.color = draft.color;
    }

    function draftForPaint() {
      if (!editor) return null;
      const draft = { ...editor.draft };
      draft.text = ''; // текст показывает textarea
      return draft;
    }

    function startTextEdit(target, point) {
      if (editor) commitTextEdit();
      if (target) {
        if (target.type !== 'text') return;
        const draft = M.clone(target);
        makeEditor(draft, false, target.id);
        setSelection([target.id]);
        app.requestRender();
        return;
      }
      const scale = state.view.scale;
      const draft = M.createText({
        x: point.x, y: point.y,
        w: 320 / scale,
        fontSize: G.clamp(state.textSize / scale, 8, 200),
        color: state.color,
        bold: state.textFmt.bold,
        italic: state.textFmt.italic,
        underline: state.textFmt.underline,
        family: state.textFmt.family,
        align: state.textFmt.align,
      });
      makeEditor(draft, true, null);
      app.requestRender();
    }

    function commitTextEdit() {
      if (!editor) return;
      const { draft, isNew, origin, ta } = editor;
      const text = ta.value.replace(/\s+$/, '');
      editor = null;
      if (ta.parentNode) ta.parentNode.removeChild(ta);
      notifyEditing();

      if (!text) {
        app.requestRender();
        return;
      }
      draft.text = text;
      if (isNew) {
        const box = M.textBox(draft);
        draft.h = box.lines.length * box.lineHeight;
        draft.w = Math.max(60, box.w);
        store.insert([draft]);
        setSelection([draft.id]);
      } else {
        const obj = store.get(origin);
        if (obj) {
          /* текст, геометрия и начертание пишутся одним patch:
             отмена возвращает объект к состоянию до правки целиком */
          const probe = Object.assign({}, obj, draft, { text });
          const box = M.textBox(probe);
          const before = { text: obj.text, h: obj.h, w: obj.w };
          const after = {
            text,
            h: box.lines.length * box.lineHeight,
            w: Math.max(60, box.w),
          };
          for (const key of ['fontSize', 'color', 'align', 'bold', 'italic', 'underline', 'family']) {
            if (obj[key] !== draft[key]) {
              before[key] = obj[key];
              after[key] = draft[key];
            }
          }
          store.patch([{ id: obj.id, before, after }], 'Правка текста');
        }
      }
      app.markDirty();
      app.requestRender();
    }

    function cancelTextEdit() {
      if (!editor) return;
      const { ta } = editor;
      editor = null;
      if (ta.parentNode) ta.parentNode.removeChild(ta);
      notifyEditing();
      app.requestRender();
    }

    /* Escape: сохраняем набранное, пустое удаляем */
    function finishTextEdit() {
      if (!editor) return;
      if (editor.ta.value.replace(/\s+$/, '')) commitTextEdit();
      else cancelTextEdit();
    }

    const isEditing = () => !!editor;

    /* id правимого объекта: его не рисуем — текст показывает само поле
       ввода, иначе старый набор виден под новым */
    const editingId = () => (editor && editor.origin ? editor.origin : null);

    /* ---------------- указатель ---------------- */

    function pointerPos(e) {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    /* ---------------- линейка и транспортир ---------------- */

    function currentInstrument(kind) {
      return kind === 'ruler' ? state.ruler : state.protractor;
    }

    /* инструмент появляется в центре холста и живёт, пока выбран его инструмент */
    function showInstrument(kind) {
      state.ruler.visible = false;
      state.protractor.visible = false;
      const inst = currentInstrument(kind);
      inst.visible = true;
      if (!inst.placed) {
        inst.x = Math.round(surface.width / 2);
        inst.y = Math.round(surface.height / 2);
        inst.placed = true;
      }
      syncGuide();
    }

    function hideInstruments() {
      state.ruler.visible = false;
      state.protractor.visible = false;
    }

    /* В режиме обучения транспортир не прячется при смене инструмента:
       он лежит под пером и маркером, по нему и рисуют. */
    function syncGuide() {
      if (!state.protractorLearn) return;
      const inst = state.protractor;
      inst.visible = true;
      if (!inst.placed) {
        inst.x = Math.round(surface.width / 2);
        inst.y = Math.round(surface.height / 2);
        inst.placed = true;
      }
    }

    /* Alt + перетаскивание цепляет транспортир, пока пером и маркером рисуют */
    function grabProtractor(e, screen) {
      if (!e.altKey || !state.protractor.visible) return false;
      if (state.tool === 'protractor') return false;
      const part = G.instrumentHit('protractor', state.protractor, screen);
      if (part === 'rotate') {
        drag = { type: 'inst-rotate', inst: state.protractor };
      } else if (part === 'body') {
        drag = {
          type: 'inst-move',
          inst: state.protractor,
          start: { x: state.protractor.x, y: state.protractor.y },
          startScreen: { ...screen },
        };
      } else {
        return false;
      }
      return true;
    }

    /* линейка держит направление, транспортир — угол кратный PROT_STEP.
       Подписей замера нет: инструменты работают молча, на доску попадает только линия */
    function startMeasure(kind, world) {
      const shape = M.createShape('line', {
        color: state.color,
        width: state.width,
        fill: 'none',
        x1: world.x, y1: world.y, x2: world.x, y2: world.y,
      });
      return {
        type: 'measure', kind, shape, origin: world,
        inst: currentInstrument(kind), len: 0, angle: 0, moved: false,
      };
    }

    function updateMeasure(d, world) {
      const dx = world.x - d.origin.x;
      const dy = world.y - d.origin.y;
      let angle;
      let len;
      if (d.kind === 'ruler') {
        angle = d.inst.angle;
        len = dx * Math.cos(angle) + dy * Math.sin(angle);
      } else {
        len = Math.hypot(dx, dy);
        const rel = Math.atan2(dy, dx) - d.inst.angle;
        angle = d.inst.angle + Math.round(rel / G.PROT_STEP) * G.PROT_STEP;
      }
      d.angle = angle;
      d.len = len;
      d.shape.x2 = d.origin.x + Math.cos(angle) * len;
      d.shape.y2 = d.origin.y + Math.sin(angle) * len;
      d.moved = true;
    }

    function onPointerDown(e) {
      /* отменяем стандартное поведение: фокус не должен уходить с редактора текста */
      if (e.button === 0 || e.button === 1) e.preventDefault();
      if (editor && !e.target.closest('textarea')) {
        commitTextEdit();
      }
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (err) { /* указатель мог быть уже освобождён */ }
      const screen = pointerPos(e);
      const world = G.toWorld(screen, state.view);
      lastPointer = screen;

      const wantsPan = e.button === 1 || spaceDown || state.tool === 'pan';
      if (wantsPan) {
        /* схватили выделенное — переносим объект вместо панорамирования */
        if (state.tool === 'pan' && !spaceDown && e.button === 0 && startGrabSelected(world)) {
          app.requestRender();
          return;
        }
        drag = { type: 'pan', startScreen: screen, startPan: { ...state.view.pan }, moved: false };
        document.getElementById('stage').classList.add('panning');
        app.requestRender();
        return;
      }
      if (e.button !== 0) return;

      /* перо и маркер рисуют перетаскиванием, поэтому транспортир в режиме
         обучения цепляется зажатым Alt */
      if (grabProtractor(e, screen)) {
        app.requestRender();
        return;
      }

      switch (state.tool) {
        case 'pen':
        case 'penBlack':
        case 'penBlue':
        case 'penRed':
        case 'highlighter': {
          const highlighter = state.tool === 'highlighter';
          const stroke = M.createStroke({
            kind: highlighter ? 'highlighter' : 'pen',
            /* у маркера своя палитра, у пера — общие чернила,
               у трёх ручек — фиксированный цвет инструмента.
               Ровно втрое против базовой толщины, без нижнего порога:
               порог 12 склеивал первые два пресета (2 и 4), и оба
               рисовались одинаковой линией в 12 пикселей. */
            color: highlighter ? (state.hiColor || state.color) : app.colorFor(state.tool),
            width: highlighter ? state.width * 3 : state.width,
            points: [world],
          });
          drag = { type: 'draw', stroke, scale: state.view.scale, moved: false };
          break;
        }
        case 'eraser': {
          /* экранный диаметр → единицы доски: нарезка совпадает с кругом */
          const boardR = (state.eraserWidth / 2) / state.view.scale;
          const d = {
            type: 'erase',
            circles: [],
            radius: boardR,
            scale: state.view.scale,
            base: store.snapshot(),
            applied: 0,
          };
          drag = d;
          state.eraser = screen;
          syncEraserRadius();
          collectErase(d, world);
          eraseNow(d);
          break;
        }
        case 'text': {
          /* клик по уже написанному тексту открывает его правку: иначе
             новый набор ложится прямо поверх старого */
          const hit = Hit.hitTest(store, world, 8 / state.view.scale);
          if (hit && hit.type === 'text') startTextEdit(hit);
          else startTextEdit(null, world);
          break;
        }
        case 'line':
        case 'arrow':
        case 'rect':
        case 'ellipse':
        case 'triangle': {
          /* кнопки «Прямоугольник», «Круг» и «Треугольник» рисуют выбранную фигуру */
          const kind = state.tool === 'rect' ? state.shapeVariant
            : state.tool === 'ellipse' ? state.ellipseVariant
              : state.tool === 'triangle' ? state.triangleVariant
                : state.tool;
          const shape = M.createShape(kind, {
            color: state.color,
            width: state.width,
            fill: state.fill,
            /* залитая фигура берёт цвет заливки, а не цвет обводки */
            fillColor: state.fill === 'none' ? null : state.fillColor,
            x1: world.x, y1: world.y, x2: world.x, y2: world.y,
          });
          drag = { type: 'shape', shape, origin: world, moved: false };
          break;
        }
        case 'solid': {
          /* кнопка «Объёмные фигуры» рисует выбранную пространственную фигуру */
          const shape = M.createShape(state.solidVariant, {
            color: state.color,
            width: state.width,
            fill: state.fill,
            fillColor: state.fill === 'none' ? null : state.fillColor,
            x1: world.x, y1: world.y, x2: world.x, y2: world.y,
          });
          drag = { type: 'shape', shape, origin: world, moved: false };
          break;
        }
        case 'select': {
          startSelectGesture(e, screen, world);
          break;
        }
        case 'fill': {
          applyFillAt(world);
          break;
        }
        case 'ruler':
        case 'protractor': {
          const inst = currentInstrument(state.tool);
          const part = G.instrumentHit(state.tool, inst, screen);
          if (part === 'rotate') {
            drag = { type: 'inst-rotate', inst };
          } else if (part === 'body') {
            drag = { type: 'inst-move', inst, start: { x: inst.x, y: inst.y }, startScreen: { ...screen } };
          } else {
            drag = startMeasure(state.tool, world);
          }
          break;
        }
        default:
          break;
      }
      app.requestRender();
    }

    /* Инструмент «Заливка»: клик красит область вокруг точки. Если фигура
       разделена линией или другими фигурами — красится только эта часть
       (новый многоугольник под фигурами), иначе заливается сама фигура.
       Один клик — один шаг истории. */
    function applyFillAt(world) {
      const tol = 6 / state.view.scale;
      const fill = state.fill;
      const target = Hit.hitFilledInterior(store, world, tol)
        || Hit.hitFillTarget(store, world, tol);

      /* «без заливки» снимает заливку с той фигуры, под которой стоит клик */
      if (fill === 'none') {
        if (target) fillShape(target, 'none', null);
        return;
      }
      /* цветом своей палитры, а не цветом пера: у заливки он свой */
      const fillColor = state.fillColor;
      /* уже залитая область (в т.ч. созданная заливкой) просто перекрашивается */
      if (target && target.shape === 'polygon') {
        fillShape(target, fill, fillColor);
        return;
      }
      /* фигура целая — красим её */
      if (target && !Region.subdivided(store, target)) {
        fillShape(target, fill, fillColor);
        return;
      }

      /* фигура разделена: красим только область под курсором */
      const region = Region.extract(store, world, { scale: state.view.scale });
      /* контур не собрался: молчать лучше, чем залить всё целиком */
      if (!region) return;
      const whole = target ? Region.interiorArea(target) : 0;
      if (whole > 0 && region.area >= whole * 0.92) {
        fillShape(target, fill, fillColor);
        return;
      }
      const poly = M.createShape('polygon', {
        points: region.points,
        color: fillColor,
        width: 1,
        fill,
        fillColor,
      });
      /* под существующими фигурами и линиями: они остаются видимыми поверх заливки */
      store.insert([poly], { at: 0, label: 'Заливка' });
      app.markDirty();
      app.requestRender();
    }

    function fillShape(target, fill, fillColor) {
      const before = {
        fill: target.fill,
        fillColor: target.fillColor == null ? null : target.fillColor,
      };
      if (before.fill === fill && before.fillColor === fillColor) return;
      store.patch([{ id: target.id, before, after: { fill, fillColor } }], 'Заливка');
      app.markDirty();
      app.requestRender();
    }

    function startSelectGesture(e, screen, world) {
      const handle = hitHandleAt(screen);
      if (handle) {
        const objects = state.selection.map((id) => store.get(id)).filter(Boolean);
        /* заблокированный объект показывается выделенным, но не меняет размер */
        if (objects.length && objects.every((o) => o.locked)) return;
        const snap = snapshotOf(objects);
        const rect = selectionRect();
        if (handle === 'p1' || handle === 'p2') {
          const obj = objects[0];
          drag = { type: 'endpoint', handle, obj, snapshot: snap, start: world, moved: false };
        } else {
          drag = { type: 'resize', handle, objects, snapshot: snap, startRect: rect, start: world, moved: false };
        }
        return;
      }

      /* Заблокированный объект виден указателю: его можно выбрать и снять
         с него блокировку. Двигать при этом нельзя — снимок для переноса
         собирается только из незаблокированных объектов выделения. */
      const hit = Hit.hitTest(store, world, 6 / state.view.scale, true);
      if (hit && hit.locked) {
        const next = e.shiftKey
          ? state.selection.includes(hit.id)
            ? state.selection.filter((id) => id !== hit.id)
            : state.selection.concat([hit.id])
          : [hit.id];
        setSelection(next);
        drag = { type: 'maybe-move', start: world, moved: false, ids: next, locked: true };
        return;
      }
      if (hit) {
        if (e.shiftKey) {
          const next = state.selection.includes(hit.id)
            ? state.selection.filter((id) => id !== hit.id)
            : state.selection.concat([hit.id]);
          setSelection(next);
          drag = { type: 'maybe-move', start: world, moved: false, ids: next };
        } else {
          if (!state.selection.includes(hit.id)) setSelection([hit.id]);
          drag = { type: 'maybe-move', start: world, moved: false, ids: state.selection.slice() };
        }
        return;
      }

      if (!e.shiftKey) setSelection([]);
      drag = {
        type: 'marquee',
        startScreen: screen,
        start: world,
        additive: e.shiftKey,
        base: state.selection.slice(),
        moved: false,
      };
    }

    /* Рукой можно схватить выделенное: тогда едет сам объект, а холст и остальное
       содержимое остаются на месте. Если под курсором ничего выделенного нет —
       работает обычное перетаскивание холста. */
    function startGrabSelected(world) {
      if (!state.selection.length) return false;
      const ids = state.selection.filter((id) => store.get(id));
      if (!ids.length) return false;
      const rect = store.bounds(ids);
      /* хватаем только за прямоугольник выделения, а не за любое место доски */
      if (!rect || !G.rectContainsPoint(rect, world)) return false;
      drag = {
        type: 'maybe-move',
        start: world,
        moved: false,
        ids,
      };
      return true;
    }

  function collectErase(d, world) {
      const step = Math.max(2, d.radius / 2);
      const last = d.circles[d.circles.length - 1];
      if (last) {
        const len = G.dist(last, world);
        if (len < step * 0.4) return;
        const parts = Math.max(1, Math.ceil(len / step));
        for (let i = 1; i <= parts; i += 1) {
          d.circles.push({
            x: last.x + ((world.x - last.x) * i) / parts,
            y: last.y + ((world.y - last.y) * i) / parts,
            r: d.radius,
          });
        }
      } else {
        d.circles.push({ x: world.x, y: world.y, r: d.radius });
      }
    }

    /* Стирание при движении: ластик режет контур по своему кругу — внутри
       круга контур исчезает, снаружи остаётся. Текст и залитые фигуры
       удаляются целиком, как только задеты; картинки ластик не трогает.
       Выделение не меняется. */
    function eraseFrom(base, circles) {
      if (!circles || !circles.length) return { items: base, cut: false };
      const touched = new Set();
      for (const c of circles) {
        for (const id of Hit.objectsInCircle({ items: base }, c, c.r)) touched.add(id);
      }
      if (!touched.size) return { items: base, cut: false };
      const items = [];
      let cut = false;
      for (const o of base) {
        if (!touched.has(o.id)) {
          items.push(o);
          continue;
        }
        const pieces = eraserPieces(o, circles);
        if (pieces === 'keep') {
          items.push(o); /* bbox задет, но контур цел — не трогаем */
          continue;
        }
        cut = true;
        if (!pieces) continue; /* удалён целиком */
        for (const p of pieces) items.push(p);
      }
      return { items, cut };
    }

    /* Что ластик делает с объектом: null — удалить целиком, 'keep' — контур
       цел или объект трогать нельзя, массив — заменить обломками. */
    function eraserPieces(o, circles) {
      if (o.type === 'stroke') return cutStroke(o, circles);
      if (o.type === 'shape') {
        if (o.shape === 'line' || o.shape === 'arrow') return cutLine(o, circles);
        /* залитая и объёмная фигура уходят целиком при касании */
        if ((o.fill && o.fill !== 'none') || G.isSolidShape(o.shape)) return null;
        return cutShapeOutline(o, circles);
      }
      /* картинка не стирается: её вытирают только выделением и Delete */
      if (o.type === 'image') return 'keep';
      /* текст удаляется целиком при касании */
      return null;
    }

    function cutStroke(o, circles) {
      const pieces = cutPieces(o.points, circles);
      if (pieces === 'keep') return 'keep';
      if (!pieces.length) return null;
      return pieces.map((pts) => {
        const c = M.clone(o);
        c.id = M.newId();
        c.points = pts;
        return c;
      });
    }

    function cutLine(o, circles) {
      const pts = [{ x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 }];
      const pieces = cutPieces(pts, circles);
      if (pieces === 'keep') return 'keep';
      if (!pieces.length) return null;
      const tip = pts[1];
      return pieces.map((p) => {
        const c = M.clone(o);
        c.id = M.newId();
        c.x1 = p[0].x;
        c.y1 = p[0].y;
        c.x2 = p[p.length - 1].x;
        c.y2 = p[p.length - 1].y;
        /* наконечник остаётся на уцелевшем конце; обломок без него — линия */
        if (o.shape === 'arrow' &&
            (c.x2 !== tip.x || c.y2 !== tip.y)) c.shape = 'line';
        return c;
      });
    }

    function cutShapeOutline(o, circles) {
      const pts = outlinePoints(o);
      if (!pts || pts.length < 2) return null;
      const pieces = cutPieces(pts, circles);
      if (pieces === 'keep') return 'keep';
      if (!pieces.length) return null;
      /* обломки контура становятся штрихами: только их и можно резать */
      return pieces.map((p) => M.createStroke({
        kind: 'pen', color: o.color, width: o.width, points: p,
      }));
    }

    /* 'keep' — ломаная не задета, иначе куски снаружи всех кругов */
    function cutPieces(pts, circles) {
      const pieces = clipPolyline(pts, circles);
      const same = pieces.length === 1 && pieces[0].length === pts.length &&
        pieces[0].every((p, i) => p.x === pts[i].x && p.y === pts[i].y);
      return same ? 'keep' : pieces;
    }

    /* Отрезок a→b лежит внутри круга на интервале [t0, t1] (0..1):
       решаем |a + t(b − a) − c|² = r² и берём участки под нулём. */
    function insideRuns(a, b, circles) {
      const runs = [];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const A = dx * dx + dy * dy;
      for (const c of circles) {
        const fx = a.x - c.x;
        const fy = a.y - c.y;
        if (A === 0) {
          if (fx * fx + fy * fy <= c.r * c.r) runs.push([0, 1]);
          continue;
        }
        const B = 2 * (fx * dx + fy * dy);
        const C = fx * fx + fy * fy - c.r * c.r;
        const disc = B * B - 4 * A * C;
        if (disc <= 0) continue;
        const sq = Math.sqrt(disc);
        const t0 = Math.max(0, (-B - sq) / (2 * A));
        const t1 = Math.min(1, (-B + sq) / (2 * A));
        if (t0 < t1) runs.push([t0, t1]);
      }
      if (!runs.length) return [];
      runs.sort((p, q) => p[0] - q[0]);
      const merged = [runs[0].slice()];
      for (let i = 1; i < runs.length; i += 1) {
        const last = merged[merged.length - 1];
        if (runs[i][0] <= last[1]) last[1] = Math.max(last[1], runs[i][1]);
        else merged.push(runs[i].slice());
      }
      return merged;
    }

    const lerpPt = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

    /* режет ломаную по объединению кругов: куски снаружи остаются */
    function clipPolyline(pts, circles) {
      if (pts.length < 2 || !circles.length) return [pts];
      const pieces = [];
      let cur = null;
      const flush = () => {
        if (cur && cur.length >= 2) pieces.push(cur);
        cur = null;
      };
      for (let i = 0; i < pts.length - 1; i += 1) {
        const a = pts[i];
        const b = pts[i + 1];
        const runs = insideRuns(a, b, circles);
        let pos = 0;
        for (const run of runs) {
          const s = run[0];
          const e = run[1];
          if (s > pos) {
            /* кусок снаружи перед входом в круг */
            if (pos === 0) { if (!cur) cur = [a]; } else if (!cur) cur = [lerpPt(a, b, pos)];
            cur.push(s < 1 ? lerpPt(a, b, s) : b);
            if (s < 1) flush();
          }
          pos = Math.max(pos, e);
        }
        if (pos < 1) {
          /* хвост снаружи до конца отрезка */
          if (pos === 0) { if (!cur) cur = [a]; } else if (!cur) cur = [lerpPt(a, b, pos)];
          cur.push(b);
        }
      }
      flush();
      return pieces;
    }

    /* контур объекта как замкнутая ломаная; null — резать нечего */
    function outlinePoints(o) {
      if (o.type !== 'shape') return null;
      const a = { x: o.x1, y: o.y1 };
      const b = { x: o.x2, y: o.y2 };
      if (o.shape === 'line' || o.shape === 'arrow') return [a, b];
      if (o.shape === 'polygon' && Array.isArray(o.points) && o.points.length >= 3) {
        return o.points;
      }
      if (o.shape === 'ellipse' || o.shape === 'circle') {
        return ellipseOutline(G.rectFromPoints(a, b));
      }
      if (o.shape === 'rect') return roundRectOutline(G.rectFromPoints(a, b));
      if (G.isPolyShape(o.shape)) return G.shapePoints(o.shape, a, b);
      return null;
    }

    /* контур эллипса такими же точками, как его рисует холст; путь замкнут */
    function ellipseOutline(r) {
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const rx = Math.abs(r.w / 2);
      const ry = Math.abs(r.h / 2);
      const pts = [];
      for (let i = 0; i < 72; i += 1) {
        const a = (i / 72) * Math.PI * 2;
        pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
      }
      pts.push({ x: pts[0].x, y: pts[0].y });
      return pts;
    }

    /* прямоугольник со скруглёнными углами — как roundRectPath в paintShape */
    function roundRectOutline(r) {
      const w = Math.abs(r.w);
      const h = Math.abs(r.h);
      const rad = Math.min(8, w / 6, h / 6);
      const x0 = r.x;
      const y0 = r.y;
      const x1 = r.x + w;
      const y1 = r.y + h;
      const pts = [];
      const arc = (cx, cy, from) => {
        for (let i = 0; i <= 6; i += 1) {
          const ang = from + (i / 6) * (Math.PI / 2);
          pts.push({ x: cx + rad * Math.cos(ang), y: cy + rad * Math.sin(ang) });
        }
      };
      arc(x0 + rad, y0 + rad, Math.PI);
      arc(x1 - rad, y0 + rad, Math.PI * 1.5);
      arc(x1 - rad, y1 - rad, 0);
      arc(x0 + rad, y1 - rad, Math.PI * 0.5);
      pts.push({ x: pts[0].x, y: pts[0].y });
      return pts;
    }

    /* применяем стирание к доске прямо сейчас, без записи в историю */
    function eraseNow(d) {
      const res = eraseFrom(d.base, d.circles);
      if (!res.cut && d.applied) return;
      store._replace(res.items.map((o) => M.clone(o)));
      d.applied = res.cut ? 1 : 0;
      app.requestRender();
    }

    /* по отпусканию — один шаг истории на весь жест */
    function commitErase(d) {
      if (!d || !d.circles.length) return false;
      const res = eraseFrom(d.base, d.circles);
      if (!res.cut) return false;
      const before = d.base.map((o) => M.clone(o));
      const after = res.items.map((o) => M.clone(o));
      if (before.length === after.length &&
          before.every((o, i) => o.id === after[i].id)) return false;
      store._replace(after.map((o) => M.clone(o)));
      store.push({
        label: 'Стирание',
        undo: () => store._replace(before.map((o) => M.clone(o))),
        redo: () => store._replace(after.map((o) => M.clone(o))),
      });
      store.afterChange({ full: true });
      app.requestRender();
      return true;
    }

    /* Круг ластика — в экранных пикселях: диаметр из слайдера НЕ зависит
       от зума (иначе zoom-out прячет и самый большой размер). Поэтому в
       жесте стирания drag.radius хранится в единицах доски как
       (слайдер/2)/scale — нарезанная область всегда равна нарисованному
       кругу, а нарисованный показывает экранное значение */
    function syncEraserRadius() {
      if (drag && drag.type === 'erase') {
        state.eraserRadius = drag.radius * state.view.scale;
      } else {
        state.eraserRadius = state.eraserWidth / 2;
      }
    }

    /* курсор пишем только при смене значения: запись того же значения
       на каждом движении мыши заставляет браузер пересчитывать стили */
    function setCanvasCursor(value) {
      if (canvas.style.cursor !== value) canvas.style.cursor = value;
    }

    function onPointerMove(e) {
      const screen = pointerPos(e);
      lastPointer = screen;
      const world = G.toWorld(screen, state.view);
      app.onPointerMove(world, screen);

      /* Перерисовываем только когда что-то действительно изменилось:
         раньше каждыйmousemove пускал полный кадр, и на большом холсте
         (во весь экран) основной поток не справлялся — курсор дёргался. */
      let repaint = false;

      if (state.tool === 'eraser') {
        state.eraser = screen;
        syncEraserRadius();
        repaint = true; /* круг ластика следует за курсором */
      }

      if (!drag) {
        if (state.tool === 'select') {
          const handle = hitHandleAt(screen);
          const over = handle || Hit.hitTest(store, world, 6 / state.view.scale);
          const nextHover = over && over.id ? over.id : null;
          setCanvasCursor(handle
            ? (handle === 'p1' || handle === 'p2' ? 'move' : 'nwse-resize')
            : over ? 'move' : 'default');
          if (nextHover !== state.hoveredId) {
            state.hoveredId = nextHover;
            repaint = true;
          }
        } else if (state.tool === 'ruler' || state.tool === 'protractor') {
          const part = G.instrumentHit(state.tool, currentInstrument(state.tool), screen);
          setCanvasCursor(part === 'rotate' ? 'pointer' : part === 'body' ? 'grab' : 'crosshair');
        } else if (e.altKey && state.protractor.visible && state.tool !== 'protractor') {
          /* транспортир виден под пером и маркером: подсказываем, что Alt его возьмёт */
          const part = G.instrumentHit('protractor', state.protractor, screen);
          setCanvasCursor(part === 'rotate' ? 'pointer' : part === 'body' ? 'grab' : 'default');
        } else if (state.hoveredId !== null) {
          state.hoveredId = null;
          repaint = true;
        }
        if (repaint) app.requestRender();
        return;
      }

      switch (drag.type) {
        case 'pan': {
          state.view.pan.x = drag.startPan.x + (screen.x - drag.startScreen.x);
          state.view.pan.y = drag.startPan.y + (screen.y - drag.startScreen.y);
          if (G.dist(drag.startScreen, screen) > 2) drag.moved = true;
          app.onViewChanged();
          break;
        }
        case 'draw': {
          const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
          const minDist = 0.6 / drag.scale;
          for (const ev of events.length ? events : [e]) {
            const p = G.toWorld(pointerPos(ev), state.view);
            const pts = drag.stroke.points;
            const last = pts[pts.length - 1];
            if (!last || G.dist(last, p) >= minDist) {
              pts.push(p);
              drag.moved = true;
            }
          }
          break;
        }
        case 'erase': {
          syncEraserRadius();
          const was = drag.circles.length;
          collectErase(drag, world);
          if (drag.circles.length !== was) eraseNow(drag);
          app.requestRender();
          break;
        }
        case 'inst-move': {
          drag.inst.x = Math.round(drag.start.x + (screen.x - drag.startScreen.x));
          drag.inst.y = Math.round(drag.start.y + (screen.y - drag.startScreen.y));
          break;
        }
        case 'inst-rotate': {
          drag.inst.angle = Math.atan2(screen.y - drag.inst.y, screen.x - drag.inst.x);
          break;
        }
        case 'measure': {
          updateMeasure(drag, world);
          break;
        }
        case 'shape': {
          const dx = world.x - drag.origin.x;
          const dy = world.y - drag.origin.y;
          let x2 = world.x;
          let y2 = world.y;
          if (e.shiftKey && (drag.shape.shape === 'line' || drag.shape.shape === 'arrow')) {
            const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(dx, dy);
            x2 = drag.origin.x + Math.cos(angle) * len;
            y2 = drag.origin.y + Math.sin(angle) * len;
          }
          if (e.altKey) {
            x2 = drag.origin.x - dx;
            y2 = drag.origin.y - dy;
          }
          /* квадрат и круг держат пропорции на ходу протяжки, а не только при отпускании */
          if (drag.shape.shape === 'square') {
            const sq = G.squareCorners(drag.origin, { x: x2, y: y2 });
            x2 = sq.x2;
            y2 = sq.y2;
          } else if (drag.shape.shape === 'circle') {
            const cc = G.circleCorners(drag.origin, { x: x2, y: y2 });
            x2 = cc.x2;
            y2 = cc.y2;
          }
          drag.shape.x2 = x2;
          drag.shape.y2 = y2;
          drag.moved = true;
          break;
        }
        case 'maybe-move': {
          const dx = world.x - drag.start.x;
          const dy = world.y - drag.start.y;
          /* выделенный заблокированный объект можно снять с блокировки,
             но сдвинуть его нельзя */
          if (drag.locked) break;
          if (!drag.moved && G.dist(drag.start, world) * state.view.scale < 3) break;
          if (!drag.moved) {
            drag.moved = true;
            /* в смешанном выделении сдвигаются только незаблокированные */
            drag.snapshot = snapshotOf(
              drag.ids.map((id) => store.get(id)).filter((o) => o && !o.locked)
            );
          }
          if (!drag.snapshot.length) break;
          for (const snap of drag.snapshot) {
            const obj = store.get(snap.id);
            if (!obj) continue;
            Object.assign(obj, M.clone(snap.props));
            translateObject(obj, dx, dy);
          }
          break;
        }
        case 'marquee': {
          drag.moved = G.dist(drag.startScreen, screen) > 3;
          state.marquee = drag.moved
            ? { a: G.toScreen(drag.start, state.view), b: screen }
            : null;
          break;
        }
        case 'resize': {
          const dx = world.x - drag.start.x;
          const dy = world.y - drag.start.y;
          for (const snap of drag.snapshot) {
            const obj = store.get(snap.id);
            if (!obj) continue;
            Object.assign(obj, M.clone(snap.props));
          }
          const next = G.transformRect(drag.startRect, drag.handle, dx, dy, 12);
          if (drag.objects.length === 1) {
            applyRectToObject(drag.objects[0], drag.startRect, next);
          } else {
            for (const obj of drag.objects) {
              const b = M.boundsOf(obj);
              const rel = {
                x: drag.startRect.x + ((b.x + b.w / 2 - drag.startRect.x) / drag.startRect.w) * next.w,
                y: drag.startRect.y + ((b.y + b.h / 2 - drag.startRect.y) / drag.startRect.h) * next.h,
                w: (b.w / drag.startRect.w) * next.w,
                h: (b.h / drag.startRect.h) * next.h,
              };
              const mapped = {
                x: rel.x - rel.w / 2,
                y: rel.y - rel.h / 2,
                w: rel.w,
                h: rel.h,
              };
              applyRectToObject(obj, b, mapped);
            }
          }
          drag.moved = true;
          break;
        }
        case 'endpoint': {
          const obj = drag.obj;
          const snap = drag.snapshot.find((s) => s.id === obj.id);
          Object.assign(obj, M.clone(snap.props));
          if (e.shiftKey) {
            const dx = world.x - obj.x1;
            const dy = world.y - obj.y1;
            const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 8)) * (Math.PI / 8);
            const len = Math.hypot(dx, dy);
            obj.x2 = obj.x1 + Math.cos(angle) * len;
            obj.y2 = obj.y1 + Math.sin(angle) * len;
          } else if (drag.handle === 'p1') {
            obj.x1 = world.x;
            obj.y1 = world.y;
          } else {
            obj.x2 = world.x;
            obj.y2 = world.y;
          }
          drag.moved = true;
          break;
        }
        default:
          break;
      }
      app.requestRender();
    }

    function onPointerUp(e) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch (err) { /* уже освобождён */ }
      document.getElementById('stage').classList.remove('panning');
      if (!drag) return;
      const d = drag;
      drag = null;
      state.marquee = null;

      switch (d.type) {
        case 'draw': {
          if (d.stroke.points.length === 1) {
            d.stroke.points.push({
              x: d.stroke.points[0].x + 0.01,
              y: d.stroke.points[0].y + 0.01,
            });
          }
          store.insert([d.stroke]);
          app.markDirty();
          break;
        }
        case 'erase': {
          if (commitErase(d)) app.markDirty();
          break;
        }
        case 'shape': {
          const s = d.shape;
          if (s.shape === 'rect' || s.shape === 'ellipse' || s.shape === 'circle'
            || G.isPolyShape(s.shape) || G.isSolidShape(s.shape)) {
            if (Math.abs(s.x2 - s.x1) < 6) s.x2 = s.x1 + 140 / state.view.scale;
            if (Math.abs(s.y2 - s.y1) < 6) s.y2 = s.y1 + 100 / state.view.scale;
          } else if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 6) {
            s.x2 = s.x1 + 140 / state.view.scale;
          }
          /* Квадрат, круг и равносторонний треугольник приводятся к равным сторонам
             и здесь, а не только при протяжке: иначе клик без движения давал бы
             прямоугольник вместо квадрата и овал вместо круга. Равностороннему
             треугольнику квадратная рамка нужна ещё и потому, что в пологой
             рамке его настоящая высота не влезает и он сливается с
             равнобедренным. */
          /* Приведение к квадрату — только если жест не двигался, то есть это был
             щелчок, а не протяжка. Иначе рамка в момент отпускания прыгала бы
             под курсором: фигура догоняла бы указатель уже после того, как
             его отпустили. У квадрата и круга рамку выравнивает ещё и движение,
             у равностороннего треугольника — только этот щелчок. */
          if (!d.moved && (s.shape === 'square' || s.shape === 'circle' ||
            s.shape === 'triangle-equilateral')) {
            const sq = G.squareCorners({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
            s.x2 = sq.x2;
            s.y2 = sq.y2;
          }
          store.insert([s]);
          app.markDirty();
          break;
        }
        case 'measure': {
          if (d.moved && Math.abs(d.len) * state.view.scale > 8) {
            store.insert([d.shape]);
            app.markDirty();
          } else {
            app.requestRender();
          }
          break;
        }
        case 'inst-move':
        case 'inst-rotate': {
          canvas.style.cursor = '';
          app.requestRender();
          break;
        }
        case 'maybe-move': {
          if (d.moved) {
            commitTransform(d.snapshot, 'Перемещение');
            app.markDirty();
          }
          break;
        }
        case 'marquee': {
          if (d.moved) {
            const rect = G.rectFromPoints(d.start, G.toWorld(pointerPos(e), state.view));
            const found = Hit.objectsInRect(store, rect, false);
            const merged = d.additive ? Array.from(new Set(d.base.concat(found))) : found;
            setSelection(merged);
          }
          break;
        }
        case 'resize':
        case 'endpoint': {
          if (d.moved) {
            commitTransform(d.snapshot, 'Изменение размера');
            app.markDirty();
          } else {
            app.requestRender();
          }
          break;
        }
        default:
          break;
      }
      app.requestRender();
    }

    /* Колёсико масштабирует доску плавно. Ctrl нужен только для совместимости
       со старыми привычками и для пинча тачпада, который приходит с ctrlKey.
       Сдвиг в сторону уводит холст вбок — вертикальная прокрутка больших
       досок всё ещё нужна. */

    /* Накопленный шаг колеса: пока зум едет, новые щелчки складываются с ним,
       иначе быстрая прокрутка «теряла» бы шаг. */
    const wheelZoom = { delta: 0, at: null };

    function applyWheelZoom() {
      if (!wheelZoom.at || wheelZoom.delta === 0) return;
      const factor = Math.exp(-wheelZoom.delta * 0.01);
      /* отсчёт от цели анимации, а не от текущего кадра: пять быстрых
         щелчков подряд дают один большой зум, а не пять полущёлков */
      zoomTo(wheelZoom.at, zoomTarget() * factor);
      wheelZoom.delta = 0;
    }

    function onWheel(e) {
      e.preventDefault();
      if (editor) layoutEditor();
      const sideways = e.shiftKey && !e.ctrlKey && !e.metaKey;
      if (sideways) {
        const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        stopZoomAnim();
        state.view.pan.x -= delta;
        app.onViewChanged();
        app.requestRender();
        return;
      }
      if (e.deltaY === 0 && e.deltaX !== 0) {
        /* горизонтальная прокрутка тачпада — это всё ещё сдвиг холста */
        stopZoomAnim();
        state.view.pan.x -= e.deltaX;
        app.onViewChanged();
        app.requestRender();
        return;
      }
      /* шаг колеса приходит в разных единицах: пиксели, строки или страницы */
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      /* прокрутка накапливается: пока едет анимация, целевой масштаб
         суммируется, и быстрый «щелчок» колесом даёт один большой зум */
      wheelZoom.delta += e.deltaY * unit;
      wheelZoom.at = pointerPos(e);
      applyWheelZoom();
    }

    function onDoubleClick(e) {
      const screen = pointerPos(e);
      const world = G.toWorld(screen, state.view);
      const hit = Hit.hitTest(store, world, 8 / state.view.scale);
      if (hit && hit.type === 'text') {
        startTextEdit(hit);
        return;
      }
      if (!hit) {
        setTool('select');
        setSelection([]);
      }
    }

    function onContextMenu(e) {
      e.preventDefault();
      const screen = pointerPos(e);
      const world = G.toWorld(screen, state.view);
      const hit = Hit.hitTest(store, world, 6 / state.view.scale);
      if (hit && !state.selection.includes(hit.id)) setSelection([hit.id]);
      if (hit && hit.type === 'text') startTextEdit(store.get(hit.id));
    }

    function setTool(tool) {
      /* не теряем набранный текст при смене инструмента */
      if (tool !== state.tool && editor) commitTextEdit();
      state.tool = tool;
      /* у каждого инструмента своя толщина — переключаемся на его */
      state.width = app.widthFor(tool);
      /* у «Заливки» нет смысла в режиме «без заливки» — по клику сразу красим */
      if (tool === 'fill' && state.fill === 'none') state.fill = 'solid';
      /* рукой и выделением можно работать вместе: выделение не сбрасываем */
      if (tool !== 'select' && tool !== 'pan') setSelection([]);
      state.eraser = null;
      canvas.style.cursor = '';
      if (tool === 'ruler' || tool === 'protractor') showInstrument(tool);
      else {
        hideInstruments();
        syncGuide();
      }
      app.onToolChanged();
      app.requestRender();
    }

    function getPreview() {
      if (drag && drag.type === 'draw') return drag.stroke;
      if (drag && drag.type === 'shape') return drag.shape;
      if (drag && drag.type === 'measure') return drag.shape;
      if (editor) return draftForPaint();
      return null;
    }

    function setSpace(down) {
      if (spaceDown === down) return;
      spaceDown = down;
      const stage = document.getElementById('stage');
      stage.classList.toggle('tool-pan', down);
      if (down) state.hoveredId = null;
      app.requestRender();
    }

    /* ---------------- подписка ---------------- */

    function attach() {
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerUp);
      canvas.addEventListener('pointerleave', () => {
        if (!drag) {
          state.eraser = null;
          state.hoveredId = null;
          app.requestRender();
        }
      });
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('dblclick', onDoubleClick);
      canvas.addEventListener('contextmenu', onContextMenu);
      window.addEventListener('blur', () => {
        setSpace(false);
        if (editor) commitTextEdit();
      });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && editor) commitTextEdit();
      });
    }

    function detach() {
      stopZoomAnim();
      finishTextEdit();
    }

    return {
      attach, detach, setTool, setSpace, getPreview, syncGuide, showInstrument, hideInstruments,
      zoomAt, zoomTo, zoomByStep, zoomToScale, fitToContent, resetView,
      syncEraserRadius,
      isZooming: () => !!zoomAnim,
      setSelection, deselect, selectAll, deleteSelection, clearBoard, duplicateSelection, toggleLock,
      copySelection, paste, pasteContent, importItems, insertImage, insertText,
      startTextEdit, commitTextEdit, cancelTextEdit, finishTextEdit, isEditing, editingId,
      editingDraft,
      layoutEditor,
      handleTargets,
      lastPointer,
    };
  }

  IB.interactions = { createInteractions, MIN_SCALE, MAX_SCALE };
})(window);
