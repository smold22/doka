/* Доска — точка входа, команды, горячие клавиши, работа с файлами */
(function (global) {
  'use strict';

  const IB = global.IB;
  const G = IB.geom;
  const M = IB.model;
  const Paint = IB.paint;
  const Persist = IB.persist;

  const api = window.inkboard;

  /* Толщина инструмента: у кого-то своя, у остальных — общая с пером. */

  /* Три ручки в нижней панели — отдельные инструменты с фиксированным цветом:
     цвет палитры они не трогают, а толщину делят с пером. */
  const PEN_TOOLS = { penBlack: '#000000', penBlue: '#0000FF', penRed: '#FF0000' };

  /* цвет штриха инструмента: у ручек свой, у остальных — цвет палитры */
  function colorFor(tool) {
    return PEN_TOOLS[tool] || state.color;
  }

  /* ключ хранения толщины: ручкам отдаём слот пера */
  function widthKey(tool) {
    return PEN_TOOLS[tool] ? 'pen' : tool;
  }

  function widthFor(tool) {
    const own = state.widths[widthKey(tool)];
    return typeof own === 'number' && own > 0 ? own : state.width;
  }

  function setWidthFor(tool, value) {
    const key = widthKey(tool);
    if (Object.prototype.hasOwnProperty.call(DEFAULT_WIDTHS, key)) {
      state.widths[key] = value;
    }
    state.width = value;
  }

  /* ---------------- состояние ---------------- */

  const prefs = Persist.loadPrefs();

  /* Инструменты, у которых толщина настраивается отдельно. У маркера
     хранится базовая величина: на холсте он всё равно втрое шире. */
  const DEFAULT_WIDTHS = {
    pen: 4, highlighter: 4, line: 4, arrow: 4,
    rect: 4, ellipse: 4, triangle: 4, solid: 4,
  };

  /* Диаметр круга ластика: слайдер в его панели живёт в этих пределах */
  const ERASER_MIN = 8;
  const ERASER_MAX = 160;

  /* переключаемые свойства начертания текста и подписи в истории отмены */
  const FMT_KEYS = ['bold', 'italic', 'underline'];
  const FMT_LABELS = {
    bold: 'Полужирный',
    italic: 'Курсив',
    underline: 'Подчёркивание',
  };

  /* Настройки начертания из файла предыдущей версии могли лежать чем
     угодно: приводим к нашим типам и проверяем гарнитуру. */
  function loadTextFmt(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const family = M.FONT_FAMILIES.some((f) => f.id === src.family) ? src.family : 'ui';
    const align = ['left', 'center', 'right'].includes(src.align) ? src.align : 'left';
    return {
      bold: src.bold === true,
      italic: src.italic === true,
      underline: src.underline === true,
      family,
      align,
    };
  }

  const state = {
  tool: prefs.tool || 'pen',
  color: prefs.color || '#000000',
  /* у «Заливки» свой цвет, независимый от цвета пера */
  fillColor: prefs.fillColor || prefs.color || '#000000',
  hiColor: prefs.hiColor || '#FFFF00',
  /* У каждого инструмента своя толщина: рисуя схему пером, линии можно
     оставить тонкими и не подстраивать их под перо. state.width остаётся
     значением активного инструмента — на него смотрят все рисовалки. */
  widths: Object.assign({}, DEFAULT_WIDTHS, prefs.widths),
  width: prefs.width || 4,
    fill: prefs.fill || 'none',
    eraserWidth: Math.min(ERASER_MAX, Math.max(ERASER_MIN, Number(prefs.eraserWidth) || 24)),
    textSize: prefs.textSize || 28,
    /* начертание нового текста и умолчания панели форматирования */
    textFmt: loadTextFmt(prefs.textFmt),
    showGrid: prefs.showGrid !== false,
    showCells: prefs.showCells === true,
    selection: [],
    view: { pan: { x: 0, y: 0 }, scale: 1 },
    hoveredId: null,
    eraser: null,
    eraserRadius: 20,
    marquee: null,
    /* линейка и транспортир — экранные направляющие, в файл не сохраняются */
    ruler: G.newInstrument(),
    protractor: G.newInstrument(),
    /* режим обучения: транспортир остаётся на доске под пером и маркером */
    protractorLearn: false,
    /* какую фигуру рисует кнопка «Прямоугольник»: сам прямоугольник,
       квадрат, параллелограмм или трапеция */
    shapeVariant: prefs.shapeVariant || 'rect',
    /* круг или овал рисует кнопка «Круг» */
    ellipseVariant: prefs.ellipseVariant || 'circle',
    /* треугольники кнопки «Треугольник» */
    triangleVariant: prefs.triangleVariant || 'triangle',
    solidVariant: prefs.solidVariant || 'solid-box',
    clipboard: null,
    file: null,
    /* название, заданное пользователем: важнее имени файла, но не стирает его */
    title: null,
    dirty: false,
  };

  /* в настройках могли остаться оба флага от прежней версии — фон только один */
  if (state.showCells) state.showGrid = false;

  const store = M.createStore();
  const surface = Paint.makeSurface(document.getElementById('board'));

  let frame = null;

  /* ---------------- приложение ---------------- */

  const app = {
    state,
    store,
    surface,

    /* толщина активного инструмента; жесты и панель настроек берут её отсюда */
    widthFor,
    /* цвет штриха инструмента: у трёх ручек фиксированный, у остальных — палитра */
    colorFor,
    /* толщина меняется из панели: сразу пишем в настройки, иначе правка
       потерялась бы при закрытии доски */
    setWidthFor(tool, value) {
      setWidthFor(tool, value);
      savePrefs();
      ui.syncThickness();
      app.requestRender();
    },

    /* цвет заливки выбирается в палитре и сохраняется отдельно от пера */
    savePrefs() {
      savePrefs();
    },

    /* размер круга ластика: слайдер в панели ластика.
       Диаметр в экранных пикселях и НЕ зависит от зума холста —
       при zoom-out 8px всё ещё видно (по нему и режем: см. interactions) */
    setEraserWidth(value) {
      state.eraserWidth = Math.min(ERASER_MAX, Math.max(ERASER_MIN, Number(value) || ERASER_MIN));
      if (state.eraser) {
        state.eraserRadius = state.eraserWidth / 2;
      }
      savePrefs();
      ui.syncEraser();
      app.requestRender();
    },

    requestRender() {
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        draw();
      });
    },

    onViewChanged() {
      ui.updateZoom();
      ui.updateSelectionBar();
      interactions.layoutEditor();
      /* в жесте стирания показанный круг = радиус доски × масштаб вида —
         пересчитываем на каждый кадр зума, чтобы круг не отставал */
      interactions.syncEraserRadius();
      app.requestRender();
    },

    onSelectionChanged() {
      ui.updateSelectionBar();
      ui.updateCounts();
      ui.syncTextFormat();
      app.requestRender();
    },

    onToolChanged() {
      ui.setTool(state.tool);
      savePrefs();
    },

    onPointerMove(world) {
      ui.updateCoords(world);
    },

    markDirty() {
      Persist.scheduleAutosave(store, state.view, state.title);
      if (state.dirty) return;
      state.dirty = true;
      ui.setFileName(fileLabel(), true);
      api.setDirty(true);
    },

    toast(msg, isError) {
      ui.toast(msg, isError);
    },

    applyColorToSelectionIfText(color) {
      const draft = interactions.editingDraft();
      if (draft) {
        /* правка открыта: цвет ложим в черновик, он уедет в доску при коммите */
        draft.color = color;
        interactions.layoutEditor();
        app.requestRender();
        savePrefs();
        return;
      }
      const obj = singleSelected();
      if (obj) {
        store.patch([{ id: obj.id, before: { color: obj.color }, after: { color } }], 'Цвет');
        app.markDirty();
      }
      savePrefs();
    },

    changeTextSize(delta) {
      state.textSize = G.clamp(state.textSize + delta, 8, 400);
      ui.syncTextSize();
      const draft = interactions.editingDraft();
      if (draft) {
        draft.fontSize = state.textSize;
        interactions.layoutEditor();
        app.requestRender();
      } else {
        const obj = singleSelected();
        if (obj && obj.type === 'text') {
          store.patch(
            [{ id: obj.id, before: { fontSize: obj.fontSize }, after: { fontSize: state.textSize } }],
            'Размер текста'
          );
          app.markDirty();
        }
      }
      savePrefs();
    },

    /* ---------------- форматирование текста ---------------- */

    /* Куда применять формат: открытая правка важнее выделения,
       выделенный текст — важнее умолчаний для нового текста. */
    currentTextFormat() {
      const draft = interactions.editingDraft();
      if (draft) return draft;
      const obj = singleSelected();
      if (obj && obj.type === 'text') return obj;
      return state.textFmt;
    },

    /* выделенные текстовые объекты; при правке — сам черновик */
    textTargets() {
      const draft = interactions.editingDraft();
      if (draft) return [draft];
      return state.selection
        .map((id) => store.get(id))
        .filter((o) => !!o && o.type === 'text');
    },

    /* Полужирный, курсив и подчёркивание переключаются вместе для всего
       выделения; без выделения меняют только умолчания нового текста. */
    toggleTextStyle(key) {
      if (!FMT_KEYS.includes(key)) return;
      const draft = interactions.editingDraft();
      if (draft) {
        draft[key] = !draft[key];
        state.textFmt[key] = draft[key];
        interactions.layoutEditor();
        app.requestRender();
      } else {
        const targets = app.textTargets();
        if (targets.length) {
          const next = !targets[0][key];
          store.patch(
            targets.map((o) => ({ id: o.id, before: { [key]: !!o[key] }, after: { [key]: next } })),
            FMT_LABELS[key]
          );
          state.textFmt[key] = next;
          app.markDirty();
        } else {
          state.textFmt[key] = !state.textFmt[key];
        }
        app.requestRender();
      }
      ui.syncTextFormat();
      savePrefs();
    },

    setTextAlign(align) {
      if (!['left', 'center', 'right'].includes(align)) return;
      const draft = interactions.editingDraft();
      if (draft) {
        draft.align = align;
        interactions.layoutEditor();
        app.requestRender();
      } else {
        const targets = app.textTargets();
        if (targets.length) {
          store.patch(
            targets.map((o) => ({ id: o.id, before: { align: o.align || 'left' }, after: { align } })),
            'Выравнивание текста'
          );
          app.markDirty();
        }
        state.textFmt.align = align;
        app.requestRender();
      }
      ui.syncTextFormat();
      savePrefs();
    },

    setTextFamily(family) {
      if (!M.FONT_FAMILIES.some((f) => f.id === family)) return;
      const draft = interactions.editingDraft();
      if (draft) {
        draft.family = family;
        interactions.layoutEditor();
        app.requestRender();
      } else {
        const targets = app.textTargets();
        if (targets.length) {
          store.patch(
            targets.map((o) => ({ id: o.id, before: { family: o.family || 'ui' }, after: { family } })),
            'Гарнитура'
          );
          app.markDirty();
        }
        state.textFmt.family = family;
        app.requestRender();
      }
      ui.syncTextFormat();
      savePrefs();
    },

    /* правка текста открыта или закрыта: панель показывает блок форматирования */
    onEditingChanged() {
      ui.setEditing(interactions.isEditing());
      ui.updateSelectionBar();
    },

    /* Режим обучения: транспортир живёт на доске, пока его не выключили.
       Прямая по нему по-прежнему рисуется инструментом транспортира. */
    setProtractorLearn(on) {
      const next = !!on;
      if (state.protractorLearn === next) return;
      state.protractorLearn = next;
      /* showInstrument умеет только линейку и транспортир, поэтому
         для рисующих инструментов направляющие просто прячем */
      if (!next) {
        if (state.tool === 'ruler' || state.tool === 'protractor') interactions.showInstrument(state.tool);
        else interactions.hideInstruments();
      }
      interactions.syncGuide();
      ui.syncProtractorLearn();
      app.requestRender();
    },

    /* Выбор фигуры из меню: кнопка «Прямоугольник» начинает рисовать её */
    setShapeVariant(id) {
      setVariant('rect', id);
    },

    setVariant(kind, id) {
      const menu = ui.VARIANT_MENUS[kind];
      if (!menu) return;
      state[menu.stateKey] = menu.pick(id).id;
      ui.syncShapeVariant();
      savePrefs();
      app.requestRender();
    },

    runCommand(command) {
      return commands[command] ? commands[command]() : undefined;
    },
  };

  function singleSelected() {
    return state.selection.length === 1 ? store.get(state.selection[0]) : null;
  }

  const ui = IB.ui.createUI(app);
  const interactions = IB.interactions.createInteractions(app);
  app.interactions = interactions;

  /* ---------------- рендер ---------------- */

  function draw() {
    const targets = interactions.handleTargets();
    const single = state.selection.length === 1;
    Paint.render(surface, {
      store,
      view: state.view,
      selection: state.selection,
      preview: interactions.getPreview(),
      editingId: interactions.editingId(),
      marquee: state.marquee,
      eraser: state.eraser,
      eraserRadius: state.eraserRadius,
      ruler: state.ruler,
      protractor: state.protractor,
      protractorGuide: state.protractorLearn,
      showGrid: state.showGrid,
      showCells: state.showCells,
      hoveredId: state.hoveredId,
      singleSelection: single,
      showHandles: !interactions.isEditing(),
      endpointHandles: single && targets && targets.custom ? targets.custom.map((c) => c.pt) : null,
    });
  }

  /* ---------------- файлы ---------------- */

  function fileLabel() {
    if (state.title) return state.title;
    if (!state.file) return 'Новая доска';
    return state.file.split(/[\\/]/).pop();
  }

  function setFileLabel() {
    ui.setFileName(fileLabel(), state.dirty);
  }

  /* Переименование по двойному клику по названию. Пустое имя снимает
     своё название и возвращает имя файла — иначе шапка осталась бы пустой. */
  function renameBoard(name) {
    const clean = String(name || '').trim().slice(0, 120);
    if (clean === (state.title || '')) {
      setFileLabel();
      return state.title || '';
    }
    state.title = clean || null;
    setFileLabel();
    app.markDirty();
    if (clean) app.toast(`Доска переименована: ${clean}`);
    return state.title || '';
  }

  async function newBoard(force) {
    if (!force && state.dirty && !store.isEmpty()) {
      const answer = window.confirm('Создать новую доску? Несохранённые изменения будут потеряны.');
      if (!answer) return false;
    }
    interactions.finishTextEdit();
    store.clear();
    state.file = null;
    state.title = null;
    state.dirty = false;
    state.selection = [];
    Persist.clearAutosave();
    api.setDirty(false);
    setFileLabel();
    interactions.resetView();
    ui.updateCounts();
    ui.updateSelectionBar();
    app.toast('Создана новая доска');
    return true;
  }

  async function openBoard() {
    if (state.dirty && !store.isEmpty()) {
      const answer = window.confirm('Открыть другую доску? Несохранённые изменения будут потеряны.');
      if (!answer) return;
    }
    interactions.finishTextEdit();
    const res = await api.openFile();
    if (res.canceled) return;
    if (!res.ok) {
      app.toast(`Не удалось открыть файл: ${res.error}`, true);
      return;
    }
    try {
      const { items, viewport, title } = Persist.deserialize(res.data);
      store.load(items);
      state.file = res.file;
      state.title = title;
      state.dirty = false;
      state.selection = [];
      api.setDirty(false);
      setFileLabel();
      if (viewport && typeof viewport.scale === 'number') {
        state.view.scale = G.clamp(viewport.scale, IB.interactions.MIN_SCALE, IB.interactions.MAX_SCALE);
        state.view.pan = { x: viewport.pan.x, y: viewport.pan.y };
        app.onViewChanged();
      } else {
        interactions.fitToContent();
      }
      ui.updateCounts();
      app.toast(`Открыто: ${fileLabel()}`);
    } catch (err) {
      app.toast(String(err && err.message ? err.message : err), true);
    }
  }

  function requestSave(forceDialog) {
    return saveBoard(!!forceDialog);
  }

  async function saveBoard(forceDialog) {
    interactions.finishTextEdit();
    const text = Persist.toText(store, state.view, state.title);
    const res = await api.saveFile(text, forceDialog);
    if (res.canceled) return false;
    if (!res.ok) {
      app.toast(`Не удалось сохранить: ${res.error}`, true);
      return false;
    }
    state.file = res.file;
    state.dirty = false;
    api.setDirty(false);
    setFileLabel();
    Persist.clearAutosave();
    app.toast(`Сохранено: ${fileLabel()}`);
    return true;
  }

  async function exportPng() {
    if (store.isEmpty()) {
      app.toast('Доска пуста — нечего экспортировать', true);
      return;
    }
    const bounds = store.bounds(store.items.map((o) => o.id));
    /* картинки декодируются асинхронно — без этого в PNG попадут рамки-заглушки */
    await Paint.imagesReady(store.items);
    const canvas = Paint.renderToCanvas(store, bounds, { scale: 2, padding: 24, background: '#ffffff' });
    const dataUrl = canvas.toDataURL('image/png');
    const base = (fileLabel() || 'doka').replace(/\.[^.]+$/, '');
    const res = await api.exportPng(dataUrl, `${base}.png`);
    if (res.canceled) return;
    if (!res.ok) {
      app.toast(`Не удалось экспортировать: ${res.error}`, true);
      return;
    }
    app.toast(`PNG сохранён: ${res.file.split(/[\\/]/).pop()}`);
  }

  function copyBoard() {
    const text = Persist.toText(store, state.view, state.title);
    api.writeClipboard({ text });
    app.toast('Доска скопирована в буфер обмена');
  }

  async function pasteFromClipboard() {
    const res = await api.readClipboard();
    if (res.imageDataUrl) {
      const obj = await interactions.insertImage(res.imageDataUrl, 'Картинка из буфера');
      if (obj) app.toast('Вставлена картинка из буфера обмена');
      return;
    }
    if (!res.text) {
      app.toast('Буфер обмена пуст');
      return;
    }
    try {
      const parsed = JSON.parse(res.text);
      if (parsed && Array.isArray(parsed.items)) {
        const count = interactions.importItems(parsed.items);
        app.toast(`Вставлено объектов: ${count}`);
        return;
      }
    } catch (err) { /* не JSON */ }
    app.toast('В буфере обмена нет доски');
  }

  /* Картинка с диска: диалог выбора файла, затем объект в середину вида. */
  async function insertImageFromFile() {
    interactions.finishTextEdit();
    const res = await api.openImage();
    if (!res || res.canceled) return;
    if (!res.ok) {
      app.toast(`Не удалось вставить картинку: ${res.error}`, true);
      return;
    }
    const obj = await interactions.insertImage(res.dataUrl, res.name);
    if (obj) app.toast(`Картинка вставлена: ${res.name}`);
  }

  /* ---------------- команды ---------------- */

  const commands = {
    new: () => newBoard(false),
    open: () => openBoard(),
    save: () => saveBoard(false),
    saveAs: () => saveBoard(true),
    exportPng: () => exportPng(),
    undo: () => {
      const action = store.undo();
      if (!action) return;
      state.selection = state.selection.filter((id) => store.get(id));
      app.markDirty();
      ui.updateCounts();
      app.requestRender();
    },
    redo: () => {
      const action = store.redo();
      if (!action) return;
      app.markDirty();
      ui.updateCounts();
      app.requestRender();
    },
    deleteSelection: () => interactions.deleteSelection(),
    toggleLock: () => interactions.toggleLock(),
    alignLeft: () => alignSelection('alignLeft'),
    alignCenterH: () => alignSelection('alignCenterH'),
    alignRight: () => alignSelection('alignRight'),
    alignTop: () => alignSelection('alignTop'),
    alignCenterV: () => alignSelection('alignCenterV'),
    alignBottom: () => alignSelection('alignBottom'),
    distributeH: () => distributeSelection('x'),
    distributeV: () => distributeSelection('y'),
    clearBoard: () => interactions.clearBoard(),
    selectAll: () => {
      interactions.setTool('select');
      interactions.selectAll();
    },
    duplicate: () => interactions.duplicateSelection(),
    copy: () => interactions.copySelection(false),
    cut: () => interactions.copySelection(true),
    paste: () => interactions.paste(),
    copyBoard: () => copyBoard(),
    pasteFromClipboard: () => pasteFromClipboard(),
    insertImage: () => insertImageFromFile(),
    zoomIn: () => interactions.zoomByStep(1),
    zoomOut: () => interactions.zoomByStep(-1),
    zoomReset: () => interactions.zoomToScale(1),
    zoomFit: () => interactions.fitToContent(),
    resetView: () => interactions.resetView(),
    /* фон рабочей области: none | grid | cells — режимы взаимоисключающие */
    setBackground: (mode) => {
      state.showGrid = mode === 'grid';
      state.showCells = mode === 'cells';
      ui.setGridActive(state.showGrid);
      ui.setCellsActive(state.showCells);
      savePrefs();
      app.requestRender();
    },
    toggleGrid: () => commands.setBackground(state.showGrid && !state.showCells ? 'none' : 'grid'),
    toggleCells: () => commands.setBackground(state.showCells && !state.showGrid ? 'none' : 'cells'),
    showShortcuts: () => ui.showShortcuts(true),
    about: () => openAbout(),
    /* форматирование текста */
    textBold: () => app.toggleTextStyle('bold'),
    textItalic: () => app.toggleTextStyle('italic'),
    textUnderline: () => app.toggleTextStyle('underline'),
    alignTextLeft: () => app.setTextAlign('left'),
    alignTextCenter: () => app.setTextAlign('center'),
    alignTextRight: () => app.setTextAlign('right'),
    /* аргумент — идентификатор гарнитуры из FONT_FAMILIES */
    textFamily: (family) => app.setTextFamily(family),
  };

  /* ---------------- «О программе» и обновления ---------------- */

  const updateView = {
    phase: 'idle', /* idle | checking | latest | available | downloading | downloaded | installing | error */
    current: '',
    latest: null,
    assetName: null,
    assetSize: null,
    received: 0,
    total: 0,
    file: null,
    error: null,
  };
  let aboutAutoChecked = false;

  function fmtMb(bytes) {
    return (bytes / 1048576).toFixed(1).replace('.', ',');
  }

  function updateStatusText() {
    const v = updateView;
    switch (v.phase) {
      case 'checking':
        return 'Проверяем наличие новой версии…';
      case 'latest':
        return `Установлена последняя версия ${v.current}.`;
      case 'available':
        return v.assetName
          ? `Доступна новая версия ${v.latest} (установлена ${v.current}). Нажмите «Скачать», чтобы получить установщик.`
          : `Доступна новая версия ${v.latest}, но установщик не найден в релизе — откройте страницу релизов.`;
      case 'downloading':
        return v.total > 0
          ? `Скачивание: ${fmtMb(v.received)} из ${fmtMb(v.total)} МБ (${Math.floor((v.received / v.total) * 100)}%)`
          : `Скачивание: ${fmtMb(v.received)} МБ…`;
      case 'downloaded':
        return `Установщик ${v.assetName} скачан (${fmtMb(v.total)} МБ). Нажмите «Закрыть и установить».`;
      case 'installing':
        return 'Закрываем программу и запускаем установку…';
      case 'error':
        return v.error || 'Не удалось проверить обновления.';
      default:
        return `Установлена версия ${v.current || '—'}. Нажмите «Проверить обновления».`;
    }
  }

  function renderUpdate() {
    const v = updateView;
    const el = ui.el;
    el.updateStatus.textContent = updateStatusText();
    const showBar = v.phase === 'downloading' && v.total > 0;
    el.updateProgress.hidden = !showBar;
    if (showBar) {
      el.updateBar.style.width = `${Math.min(100, Math.floor((v.received / v.total) * 100))}%`;
    }
    const busy = v.phase === 'checking' || v.phase === 'downloading';
    el.btnCheckUpdate.disabled = busy;
    el.btnCheckUpdate.textContent = v.phase === 'checking'
      ? 'Проверяем…'
      : (v.phase === 'idle' ? 'Проверить обновления' : 'Проверить снова');
    el.btnDownloadUpdate.hidden = v.phase !== 'available';
    el.btnDownloadUpdate.disabled = busy;
    el.btnInstallUpdate.hidden = v.phase !== 'downloaded';
  }

  async function loadAboutInfo() {
    try {
      const info = await api.appInfo();
      ui.el.aboutVersion.textContent = info.version || '—';
      ui.el.aboutAuthor.textContent = info.author || '—';
      ui.el.aboutEngine.textContent = info.electron
        ? `Electron ${info.electron} · Chromium ${info.chrome}`
        : '—';
      if (info.version) {
        updateView.current = info.version;
        if (updateView.phase === 'idle') renderUpdate();
      }
    } catch (err) {
      /* главный процесс обязан отвечать — молча оставляем прочерки */
    }
  }

  async function checkForUpdates() {
    updateView.phase = 'checking';
    updateView.error = null;
    renderUpdate();
    let snap;
    try {
      snap = await api.checkUpdate();
    } catch (err) {
      snap = { phase: 'error', error: `Проверка не удалась: ${String((err && err.message) || err)}` };
    }
    Object.assign(updateView, snap || {});
    renderUpdate();
  }

  async function downloadUpdate() {
    updateView.phase = 'downloading';
    updateView.received = 0;
    updateView.error = null;
    renderUpdate();
    let snap;
    try {
      snap = await api.downloadUpdate();
    } catch (err) {
      snap = { phase: 'error', file: null, error: `Скачивание не удалось: ${String((err && err.message) || err)}` };
    }
    Object.assign(updateView, snap || {});
    renderUpdate();
  }

  async function installUpdate() {
    updateView.phase = 'installing';
    updateView.error = null;
    renderUpdate();
    let snap;
    try {
      snap = await api.installUpdate();
    } catch (err) {
      snap = { ok: false, error: String((err && err.message) || err) };
    }
    if (snap && snap.ok === false) {
      updateView.phase = updateView.file ? 'downloaded' : 'available';
      updateView.error = snap.error || 'Не удалось запустить установщик';
      renderUpdate();
      app.toast(updateView.error, true);
      return;
    }
    /* приложение закрывается; если через секунду окно всё ещё открыто,
       значит, закрытие отменено (диалог сохранения) — возвращаем кнопку */
    setTimeout(() => {
      updateView.phase = updateView.file ? 'downloaded' : 'available';
      renderUpdate();
    }, 1200);
  }

  function openAbout() {
    ui.showAbout(true);
    loadAboutInfo();
    if (!aboutAutoChecked) {
      /* первый раз за сеанс — проверяем сами, чтобы юзер не нажимал вручную */
      aboutAutoChecked = true;
      checkForUpdates();
    } else {
      renderUpdate();
    }
  }

  /* ---------------- настройки ---------------- */

  function setVariant(kind, id) {
    app.setVariant(kind, id);
  }

  function savePrefs() {
    Persist.savePrefs({
      tool: state.tool,
      color: state.color,
      fillColor: state.fillColor,
      hiColor: state.hiColor,
      width: state.width,
      widths: state.widths,
      fill: state.fill,
      eraserWidth: state.eraserWidth,
      textSize: state.textSize,
      textFmt: state.textFmt,
      showGrid: state.showGrid,
      showCells: state.showCells,
      shapeVariant: state.shapeVariant,
      ellipseVariant: state.ellipseVariant,
      triangleVariant: state.triangleVariant,
      solidVariant: state.solidVariant,
    });
  }

  /* ---------------- горячие клавиши ---------------- */

  const TOOL_KEYS = {
    v: 'select', p: 'pen', h: 'highlighter', e: 'eraser',
    t: 'text', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse',
    m: 'ruler', g: 'protractor', f: 'pan',
    u: 'triangle',
    b: 'fill', c: 'solid',
  };

  /* инструмент, к которому возвращаемся после переключения на руку */
  let lastDrawingTool = 'pen';

  /* Ctrl+B/I/U — начертание текста, Ctrl+L/E/R — его выравнивание */
  const TEXT_STYLE_KEYS = { b: 'textBold', i: 'textItalic', u: 'textUnderline' };
  const TEXT_ALIGN_KEYS = { l: 'alignTextLeft', e: 'alignTextCenter', r: 'alignTextRight' };

  function onKeyDown(e) {
    const editing = interactions.isEditing();
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = typeof key === 'string' ? key.toLowerCase() : '';

    if (key === 'F1') {
      e.preventDefault();
      ui.showShortcuts();
      return;
    }

    if (editing) {
      /* форматирование применяется прямо к открытой правке */
      if (mod && TEXT_STYLE_KEYS[lower]) {
        e.preventDefault();
        commands[TEXT_STYLE_KEYS[lower]]();
        return;
      }
      if (mod && !e.shiftKey && TEXT_ALIGN_KEYS[lower]) {
        e.preventDefault();
        commands[TEXT_ALIGN_KEYS[lower]]();
        return;
      }
      /* при правке текста пропускаем только файловые команды */
      if (mod && ['s', 'n', 'o', 'e'].includes(lower)) {
        e.preventDefault();
        if (lower === 's') commands[e.shiftKey ? 'saveAs' : 'save']();
        else if (lower === 'n') commands.new();
        else if (lower === 'o') commands.open();
        else if (e.shiftKey) commands.exportPng();
      }
      return;
    }

    if (key === ' ' && !mod) {
      e.preventDefault();
      if (e.shiftKey) {
        /* Shift + пробел — постоянная рука, обычный пробел — временная */
        if (state.tool === 'pan') interactions.setTool(lastDrawingTool);
        else {
          lastDrawingTool = state.tool;
          interactions.setTool('pan');
        }
      } else {
        interactions.setSpace(true);
      }
      return;
    }

    if (key === 'Escape') {
      e.preventDefault();
      ui.showShortcuts(false);
      ui.showAbout(false);
      ui.closeShapeMenu();
      interactions.finishTextEdit();
      interactions.deselect();
      return;
    }

    if (mod) {
      switch (lower) {
        case 'z':
          e.preventDefault();
          commands[e.shiftKey ? 'redo' : 'undo']();
          return;
        case 'y':
          e.preventDefault();
          commands.redo();
          return;
        case 's':
          e.preventDefault();
          commands[e.shiftKey ? 'saveAs' : 'save']();
          return;
        case 'o':
          e.preventDefault();
          commands.open();
          return;
        case 'n':
          e.preventDefault();
          commands.new();
          return;
        case 'e':
          if (e.shiftKey) {
            e.preventDefault();
            commands.exportPng();
          } else {
            e.preventDefault();
            commands.alignTextCenter();
          }
          return;
        case 'b':
          e.preventDefault();
          commands.textBold();
          return;
        case 'i':
          if (e.shiftKey) {
            e.preventDefault();
            commands.insertImage();
          } else {
            e.preventDefault();
            commands.textItalic();
          }
          return;
        case 'u':
          e.preventDefault();
          commands.textUnderline();
          return;
        case 'l':
          if (e.shiftKey) {
            e.preventDefault();
            commands.toggleLock();
          } else {
            e.preventDefault();
            commands.alignTextLeft();
          }
          return;
        case 'r':
          e.preventDefault();
          commands.alignTextRight();
          return;
        case 'a':
          e.preventDefault();
          commands.selectAll();
          return;
        case 'd':
          e.preventDefault();
          commands.duplicate();
          return;
        case 'c':
          e.preventDefault();
          commands[e.shiftKey ? 'toggleCells' : 'copy']();
          return;
        case 'x':
          e.preventDefault();
          commands.cut();
          return;
        case 'v':
          /* вставку ловим событием paste: у него есть файлы и HTML,
             которых не видно через чтение буфера. Ctrl+V не гасим. */
          return;
        case 'g':
          if (e.shiftKey) {
            e.preventDefault();
            commands.toggleGrid();
          }
          return;
        case '0':
          e.preventDefault();
          commands.zoomReset();
          return;
        case '1':
          e.preventDefault();
          commands.zoomFit();
          return;
        case '=':
        case '+':
          e.preventDefault();
          commands.zoomIn();
          return;
        case '-':
          e.preventDefault();
          commands.zoomOut();
          return;
        default:
          break;
      }
      return;
    }

    if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault();
      interactions.deleteSelection();
      return;
    }
    if (key === 'F2') {
      e.preventDefault();
      const obj = singleSelected();
      if (obj && obj.type === 'text') interactions.startTextEdit(obj);
      return;
    }
    if (key === '?' || (e.shiftKey && key === '/')) {
      e.preventDefault();
      ui.showShortcuts();
      return;
    }
    if (key.startsWith('Arrow') && state.selection.length) {
      e.preventDefault();
      nudge(key, e.shiftKey ? 10 : 1);
      return;
    }
    if (!e.shiftKey && TOOL_KEYS[lower]) {
      e.preventDefault();
      interactions.setTool(TOOL_KEYS[lower]);
    }
  }

  function onKeyUp(e) {
    if (e.key === ' ') interactions.setSpace(false);
  }

  /* Ctrl+V: сначала пробуем данные из самого события (файлы, HTML),
     а если их нет — читаем системный буфер через главный процесс. */
  async function onPaste(e) {
    if (interactions.isEditing()) return;
    e.preventDefault();
    const cd = e.clipboardData;
    const text = cd ? cd.getData('text/plain') : '';
    const html = cd ? cd.getData('text/html') : '';
    const files = cd ? Array.from(cd.files || []) : [];
    const done = await interactions.pasteContent({ files, text, html });
    if (done) return;
    try {
      const data = await api.readClipboard();
      if (data.imageDataUrl) {
        const obj = await interactions.insertImage(data.imageDataUrl, 'Вставленная картинка');
        if (obj) app.toast('Вставлена картинка из буфера обмена');
        return;
      }
      if (data.text) await interactions.pasteContent({ text: data.text });
    } catch (err) { /* буфер недоступен */ }
    app.toast('В буфере обмена нечего вставлять');
  }

  function nudge(key, step) {
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
    const changes = [];
    for (const id of state.selection) {
      const obj = store.get(id);
      if (!obj || obj.locked) continue;
      const before = {};
      const after = {};
      const keys = obj.type === 'shape' ? ['x1', 'y1', 'x2', 'y2'] : obj.type === 'stroke' ? [] : ['x', 'y'];
      if (!keys.length) continue;
      for (const k of keys) {
        before[k] = obj[k];
        after[k] = obj[k] + (k === 'x' || k === 'x1' || k === 'x2' ? dx : dy);
      }
      changes.push({ id, before, after });
    }
    if (changes.length) {
      store.patch(changes, 'Сдвиг');
      app.markDirty();
      app.requestRender();
    }
  }

  /* ---------------- выравнивание и распределение ---------------- */

  /* Положение объекта для патча: только то, что двигается при сдвиге.
     Остальные свойства не трогаем, иначе отмена правки была бы дороже правки. */
  function placementOf(obj) {
    switch (obj.type) {
      case 'stroke':
        return { points: M.clone(obj.points) };
      case 'shape':
        return Array.isArray(obj.points)
          ? { x1: obj.x1, y1: obj.y1, x2: obj.x2, y2: obj.y2, points: M.clone(obj.points) }
          : { x1: obj.x1, y1: obj.y1, x2: obj.x2, y2: obj.y2 };
      default:
        return { x: obj.x, y: obj.y };
    }
  }

  /* Собирает один шаг истории: сдвиг применяется к копии положения,
     поэтому и «до», и «после» хранят собственные массивы точек. */
  function movePatch(objects, deltas, label) {
    const changes = [];
    for (const obj of objects) {
      const d = deltas.get(obj.id);
      if (!d || (Math.abs(d.dx) < 1e-9 && Math.abs(d.dy) < 1e-9)) continue;
      const before = placementOf(obj);
      /* translateObject ждёт полный объект, а у нас только его положение:
         собираем носитель из исходного объекта и сдвинутого положения */
      const carrier = Object.assign({}, obj, before);
      M.translateObject(carrier, d.dx, d.dy);
      changes.push({ id: obj.id, before, after: placementOf(carrier) });
    }
    if (!changes.length) return 0;
    store.patch(changes, label);
    app.markDirty();
    app.requestRender();
    return changes.length;
  }

  const ALIGN_MODES = {
    alignLeft: (union, b) => ({ dx: union.x - b.x, dy: 0 }),
    alignCenterH: (union, b) => ({ dx: (union.x + union.w / 2) - (b.x + b.w / 2), dy: 0 }),
    alignRight: (union, b) => ({ dx: (union.x + union.w) - (b.x + b.w), dy: 0 }),
    alignTop: (union, b) => ({ dx: 0, dy: union.y - b.y }),
    alignCenterV: (union, b) => ({ dx: 0, dy: (union.y + union.h / 2) - (b.y + b.h / 2) }),
    alignBottom: (union, b) => ({ dx: 0, dy: (union.y + union.h) - (b.y + b.h) }),
  };

  const ALIGN_LABELS = {
    alignLeft: 'Выровнено по левому краю',
    alignCenterH: 'Выровнено по центру',
    alignRight: 'Выровнено по правому краю',
    alignTop: 'Выровнено по верхнему краю',
    alignCenterV: 'Выровнено по середине',
    alignBottom: 'Выровнено по нижнему краю',
  };

  function alignSelection(mode) {
    const objects = selectedMovable();
    const rule = ALIGN_MODES[mode];
    if (!rule || objects.length < 2) {
      app.toast('Выделите хотя бы два объекта');
      return 0;
    }
    const union = store.bounds(objects.map((o) => o.id));
    if (!union) return 0;
    const deltas = new Map();
    for (const obj of objects) deltas.set(obj.id, rule(union, M.boundsOf(obj)));
    const n = movePatch(objects, deltas, ALIGN_LABELS[mode]);
    if (n) app.toast(`${ALIGN_LABELS[mode]}: ${n}`);
    return n;
  }

  /* Распределение оставляет крайние объекты на месте, а промежуточные
     раскладывает с одинаковым зазором — так же ведёт себя draw.io. */
  function distributeSelection(axis) {
    const objects = selectedMovable();
    if (objects.length < 3) {
      app.toast('Для распределения нужно выделить хотя бы три объекта');
      return 0;
    }
    const horizontal = axis === 'x';
    const rects = objects
      .map((o) => ({ obj: o, b: M.boundsOf(o) }))
      .sort((p, q) => (horizontal ? p.b.x - q.b.x : p.b.y - q.b.y));
    const first = rects[0].b;
    const last = rects[rects.length - 1].b;
    const middle = rects.slice(1, -1);
    const from = horizontal ? first.x + first.w : first.y + first.h;
    const to = horizontal ? last.x : last.y;
    const used = middle.reduce((sum, r) => sum + (horizontal ? r.b.w : r.b.h), 0);
    const gap = ((to - from - used) / (middle.length + 1));
    const deltas = new Map();
    let cursor = from + gap;
    for (const r of middle) {
      const size = horizontal ? r.b.w : r.b.h;
      const delta = cursor - (horizontal ? r.b.x : r.b.y);
      deltas.set(r.obj.id, horizontal ? { dx: delta, dy: 0 } : { dx: 0, dy: delta });
      cursor += size + gap;
    }
    const label = horizontal ? 'Распределено по горизонтали' : 'Распределено по вертикали';
    const n = movePatch(objects, deltas, label);
    if (n) app.toast(`${label}: ${n}`);
    return n;
  }

  /* Заблокированные объекты выравнивать и распределять бессмысленно:
     они не двигаются, поэтому выпадут из расчёта и собьют остальные. */
  function selectedMovable() {
    return state.selection
      .map((id) => store.get(id))
      .filter((o) => o && !o.locked);
  }

  /* ---------------- интерфейс: события ---------------- */

  function wireUI() {
    /* кнопки-инструменты (в том числе ручки внизу); у кнопок-действий
       например «вставить картинку» data-tool нет */
    for (const b of document.querySelectorAll('.tool')) {
      if (!b.dataset.tool) continue;
      b.addEventListener('click', () => interactions.setTool(b.dataset.tool));
    }

    for (const b of document.querySelectorAll('[data-cmd]')) {
      if (b.closest('#inspector')) continue;
      b.addEventListener('click', () => app.runCommand(b.dataset.cmd));
    }

    /* Название доски переименовывается двойным кликом: одиночный клик
       ничего не делает, чтобы не мешать выбору и подсказке. */
    const fileNameEl = document.getElementById('fileName');
    const beginRename = () => ui.startRename(fileLabel(), renameBoard);
    fileNameEl.addEventListener('dblclick', beginRename);
    fileNameEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== 'F2') return;
      e.preventDefault();
      beginRename();
    });

    document.getElementById('selectionbar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sel]');
      if (!b) return;
      const action = b.dataset.sel;
      if (action === 'dup') interactions.duplicateSelection();
      else if (action === 'lock') {
        interactions.toggleLock();
        ui.updateSelectionBar();
      }
      else if (action === 'delete') interactions.deleteSelection();
      else if (action === 'front' || action === 'back') {
        const ids = store.items.map((o) => o.id);
        const moving = state.selection.slice();
        if (action === 'front') {
          const rest = ids.filter((id) => !moving.includes(id));
          store.reorder(rest.concat(moving), 'Порядок объектов');
        } else {
          const rest = ids.filter((id) => !moving.includes(id));
          store.reorder(moving.concat(rest), 'Порядок объектов');
        }
        interactions.setSelection(moving);
        app.markDirty();
      }
    });

    document.getElementById('closeShortcuts').addEventListener('click', () => ui.showShortcuts(false));
    ui.el.shortcuts.addEventListener('click', (e) => {
      if (e.target === ui.el.shortcuts) ui.showShortcuts(false);
    });

    document.getElementById('closeAbout').addEventListener('click', () => ui.showAbout(false));
    ui.el.about.addEventListener('click', (e) => {
      if (e.target === ui.el.about) ui.showAbout(false);
    });
    ui.el.btnCheckUpdate.addEventListener('click', () => checkForUpdates());
    ui.el.btnDownloadUpdate.addEventListener('click', () => downloadUpdate());
    ui.el.btnInstallUpdate.addEventListener('click', () => installUpdate());
    ui.el.btnReleases.addEventListener('click', () => {
      if (api.openReleases) api.openReleases();
    });
    /* прогресс скачивания шлёт главный процесс — обновляем полосу и проценты */
    if (api.onUpdateProgress) {
      api.onUpdateProgress((p) => {
        if (!p) return;
        updateView.received = p.received || 0;
        updateView.total = p.total || updateView.total;
        if (updateView.phase === 'downloading') renderUpdate();
      });
    }

    /* Меню выбора фигуры живёт само: закрывается кликом вне, Escape и прокруткой */
    document.addEventListener('pointerdown', (e) => {
      if (ui.el.shapeMenu.hidden) return;
      if (e.target.closest('#shapeMenu') || e.target.closest('.tool[data-tool="rect"]')) return;
      ui.closeShapeMenu();
    });
    window.addEventListener('blur', () => ui.closeShapeMenu());
    window.addEventListener('resize', () => ui.closeShapeMenu());

    api.onMenuCommand((command) => app.runCommand(command));
  }

  /* ---------------- запуск ---------------- */

  function boot() {
    surface.resize();
    ui.buildPalettes();
    ui.setTool(state.tool);
    ui.setGridActive(state.showGrid);
    ui.updateZoom();
    ui.syncSwatches();
    ui.syncTextSize();
    /* при запуске показываем толщину того инструмента, который откроется */
    state.width = widthFor(state.tool);
    ui.syncThickness();
    ui.syncEraser();
    ui.syncShapeVariant();
    ui.updateHistory(store.historyState());
    setFileLabel();

    /* картинка декодируется позже — доска перерисовывается, когда она готова */
    Paint.setImageReadyHandler(() => app.requestRender());

    store.on('change', () => {
      app.requestRender();
      ui.updateCounts();
      ui.updateSelectionBar();
    });
    store.on('history', (history) => ui.updateHistory(history));

    interactions.attach();
    wireUI();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('paste', onPaste);
    window.addEventListener('resize', () => {
      if (surface.resize()) {
        app.requestRender();
        ui.updateSelectionBar();
      }
    });
    window.addEventListener('beforeunload', () => interactions.detach());

    const restore = Persist.readAutosave();
    if (restore && restore.items.length) {
      store.load(restore.items);
      state.title = restore.title;
      state.dirty = true;
      api.setDirty(true);
      setFileLabel();
      if (restore.viewport && typeof restore.viewport.scale === 'number') {
        state.view.scale = restore.viewport.scale;
        state.view.pan = { ...restore.viewport.pan };
      } else {
        interactions.fitToContent();
      }
      app.toast('Восстановлена несохранённая доска (Ctrl+S — сохранить)');
    } else {
      interactions.resetView();
    }

    ui.updateCounts();
    ui.updateZoom();
    app.requestRender();

    window.IB = IB;
    IB.app = {
      requestSave: () => saveBoard(false),
      /* вызывается главным процессом перед закрытием, когда пользователь
         выбрал «Не сохранять»: автосохранение надо снести, иначе следующий
         запуск снова восстановит эту доску */
      discardChanges: () => {
        Persist.clearAutosave();
        state.dirty = false;
        api.setDirty(false);
        ui.setFileName(fileLabel(), false);
        return true;
      },
      commands,
      state,
      /* окно «О программе»: state — живое состояние обновлений,
         render — перерисовка (тесты симулируют фазы через state) */
      about: { state: updateView, render: renderUpdate, open: openAbout, check: checkForUpdates },
      widthFor,
      setWidthFor,
      /* цвет штриха инструмента (у ручек — фиксированный) */
      colorFor,
      penTools: PEN_TOOLS,
      /* размер круга ластика задаёт слайдер в его панели */
      setEraserWidth: (v) => app.setEraserWidth(v),
      /* сохранение настроек (цвет пера, цвет заливки и т. д.) */
      savePrefs: () => savePrefs(),
      store,
      interactions,
      ui,
      fileLabel,
      renameBoard,
      requestRender: () => app.requestRender(),
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
