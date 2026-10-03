/* Доска — интерфейс: палитры, панели, подсказки */
(function (global) {
  'use strict';

  const IB = (global.IB = global.IB || {});
  const G = IB.geom;
  const M = IB.model;

  /* Палитра чернил: 29 цветов, пять в ряд, по кругу оттенков. */
  const INK_COLORS = [
    { name: 'Чёрный', hex: '#000000' },
    { name: 'Белый', hex: '#FFFFFF' },
    { name: 'Серый', hex: '#808080' },
    { name: 'Светло-серый', hex: '#C0C0C0' },
    { name: 'Красный', hex: '#FF0000' },
    { name: 'Тёмно-красный', hex: '#CC0000' },
    { name: 'Светло-красный', hex: '#FF6666' },
    { name: 'Бордовый', hex: '#8B0000' },
    { name: 'Оранжевый', hex: '#FF8000' },
    { name: 'Апельсиновый', hex: '#FFA500' },
    { name: 'Тёмно-оранжевый', hex: '#CC6600' },
    { name: 'Жёлтый', hex: '#FFFF00' },
    { name: 'Золотой', hex: '#FFD700' },
    { name: 'Лимонный', hex: '#FFFACD' },
    { name: 'Зелёный', hex: '#00FF00' },
    { name: 'Тёмно-зелёный', hex: '#008000' },
    { name: 'Светло-зелёный', hex: '#90EE90' },
    { name: 'Изумрудный', hex: '#006400' },
    { name: 'Синий', hex: '#0000FF' },
    { name: 'Тёмно-синий', hex: '#0000CC' },
    { name: 'Светло-синий', hex: '#6666FF' },
    { name: 'Navy', hex: '#00008B' },
    { name: 'Голубой', hex: '#87CEEB' },
    { name: 'Фиолетовый', hex: '#800080' },
    { name: 'Светло-фиолетовый', hex: '#EE82EE' },
    { name: 'Индиго', hex: '#4B0082' },
    { name: 'Коричневый', hex: '#A52A2A' },
    { name: 'Шоколадный', hex: '#D2691E' },
    { name: 'Розовый', hex: '#FFC0CB' },
    { name: 'Бирюзовый', hex: '#40E0D0' },
  ];

  /* Палитра маркера: те же 29 цветов, что и у чернил, но отдельный список,
     чтобы маркер и перо не зависели от выбора друг друга. */
  const HI_COLORS = [
    { name: 'Чёрный', hex: '#000000' },
    { name: 'Белый', hex: '#FFFFFF' },
    { name: 'Серый', hex: '#808080' },
    { name: 'Светло-серый', hex: '#C0C0C0' },
    { name: 'Красный', hex: '#FF0000' },
    { name: 'Тёмно-красный', hex: '#CC0000' },
    { name: 'Светло-красный', hex: '#FF6666' },
    { name: 'Бордовый', hex: '#8B0000' },
    { name: 'Оранжевый', hex: '#FF8000' },
    { name: 'Апельсиновый', hex: '#FFA500' },
    { name: 'Тёмно-оранжевый', hex: '#CC6600' },
    { name: 'Жёлтый', hex: '#FFFF00' },
    { name: 'Золотой', hex: '#FFD700' },
    { name: 'Лимонный', hex: '#FFFACD' },
    { name: 'Зелёный', hex: '#00FF00' },
    { name: 'Тёмно-зелёный', hex: '#008000' },
    { name: 'Светло-зелёный', hex: '#90EE90' },
    { name: 'Изумрудный', hex: '#006400' },
    { name: 'Синий', hex: '#0000FF' },
    { name: 'Тёмно-синий', hex: '#0000CC' },
    { name: 'Светло-синий', hex: '#6666FF' },
    { name: 'Navy', hex: '#00008B' },
    { name: 'Голубой', hex: '#87CEEB' },
    { name: 'Фиолетовый', hex: '#800080' },
    { name: 'Светло-фиолетовый', hex: '#EE82EE' },
    { name: 'Индиго', hex: '#4B0082' },
    { name: 'Коричневый', hex: '#A52A2A' },
    { name: 'Шоколадный', hex: '#D2691E' },
    { name: 'Розовый', hex: '#FFC0CB' },
    { name: 'Бирюзовый', hex: '#40E0D0' },
  ];

  const TOOL_LABELS = {
    select: 'Выделение',
    pen: 'Перо',
    penBlack: 'Чёрная ручка',
    penBlue: 'Синяя ручка',
    penRed: 'Красная ручка',
    highlighter: 'Маркер',
    eraser: 'Ластик',
    fill: 'Заливка',
    text: 'Текст',
    line: 'Линия',
    arrow: 'Стрелка',
    rect: 'Прямоугольник',
    ellipse: 'Круг',
    triangle: 'Треугольник',
    solid: 'Объёмная фигура',
    pan: 'Рука',
    ruler: 'Линейка',
    protractor: 'Транспортир',
  };

  /* Фигуры кнопки «Прямоугольник»: выбираются правым кликом по кнопке.
     Иконки повторяют контуры, которые строит geometry.shapePoints. */
  const SHAPE_VARIANTS = [
    { id: 'rect', label: 'Прямоугольник', icon: 'M3.4 5.4h13.2v9.2H3.4z' },
    { id: 'square', label: 'Квадрат', icon: 'M4.4 4.4h11.2v11.2H4.4z' },
    { id: 'rhombus', label: 'Ромб', icon: 'M10 3.4 16.6 10 10 16.6 3.4 10z' },
    { id: 'parallelogram', label: 'Параллелограмм', icon: 'M6.8 5.4h11.2l-3.4 9.2H3.4z' },
    { id: 'trapezoid', label: 'Трапеция', icon: 'M3.4 5.4h9.2l3.6 9.2H3.4z' },
    { id: 'trapezoid-trapezium', label: 'Произвольная трапеция', icon: 'M3.4 16.6h13.2l-4.4-9.2H8.2z' },
    { id: 'trapezoid-iso', label: 'Равнобедренная трапеция', icon: 'M3.4 14.6h13.2l-3.4-9.2H6.8z' },
  ];

  function shapeVariant(id) {
    return SHAPE_VARIANTS.find((v) => v.id === id) || SHAPE_VARIANTS[0];
  }

  /* Фигуры кнопки «Круг»: круг и овал, тоже правый клик по кнопке */
  const ELLIPSE_VARIANTS = [
    { id: 'circle', label: 'Круг', icon: 'M3.4 10a6.6 6.6 0 1 0 13.2 0 6.6 6.6 0 1 0-13.2 0z' },
    { id: 'ellipse', label: 'Овал', icon: 'M10 4.4a6.6 5.6 0 1 0 0 11.2 6.6 5.6 0 1 0 0-11.2z' },
  ];

  function ellipseVariant(id) {
    return ELLIPSE_VARIANTS.find((v) => v.id === id) || ELLIPSE_VARIANTS[0];
  }

  /* Фигуры кнопки «Треугольник»: правый клик по кнопке */
  const TRIANGLE_VARIANTS = [
    { id: 'triangle', label: 'Прямоугольный треугольник', icon: 'M3.4 3.4v13.2h13.2z' },
    { id: 'triangle-obtuse', label: 'Тупоугольный треугольник', icon: 'M4.8 3.4v13.2h11.8z' },
    { id: 'triangle-scalene', label: 'Разносторонний треугольник', icon: 'M3.4 16.6h13.2L10.8 4.4z' },
    { id: 'triangle-iso', label: 'Равнобедренный треугольник', icon: 'M3.4 16.6h13.2L10 3.4z' },
    /* равносторонний отмечен засечками на сторонах — так его не спутать
       с равнобедренным, у которого вершина почти в той же точке */
    {
      id: 'triangle-equilateral',
      label: 'Равносторонний треугольник',
      icon: 'M3.4 16.6h13.2L10 5.2zM5.8 10.4l1.8 1M12.4 10.4l1.8 1M10 15.5v2.2',
    },
  ];

  function triangleVariant(id) {
    return TRIANGLE_VARIANTS.find((v) => v.id === id) || TRIANGLE_VARIANTS[0];
  }

  /* Объёмные фигуры: параллелепипед, пирамиды и призмы с разным числом оснований и сфера.
     Иконки нарисованы в той же изометрии, что и сами фигуры, с видимыми рёбрами сплошной
     линией и скрытыми — пунктиром. */
  const SOLID_VARIANTS = [
    {
      id: 'solid-box', label: 'Параллелепипед',
      icon: 'M10 2.6 17 6.5v8.3L10 18.7 3 14.8V6.5zM3 6.5l7 3.9 7-3.9M10 10.4v8.3',
    },
    {
      id: 'solid-pyramid-3', label: 'Треугольная пирамида',
      icon: 'M10 2.6 17 15.4H3zM10 2.6 6.5 15.4M10 2.6 13.5 15.4',
    },
    {
      id: 'solid-pyramid-4', label: 'Четырёхугольная пирамида',
      icon: 'M10 2.6 17 15.4H3zM3.4 9.2h13.2M10 2.6 10 15.4',
    },
    {
      id: 'solid-pyramid-5', label: 'Пятиугольная пирамида',
      icon: 'M10 2.6 17 12.6l-5.6 5.2L4.4 12.6zM10 2.6 11.4 17.8M10 2.6 4.4 12.6M10 2.6 17 12.6',
    },
    {
      id: 'solid-pyramid-6', label: 'Шестиугольная пирамида',
      icon: 'M10 2.6 17.4 13.2 13.4 18.8H6.6L2.6 13.2zM10 2.6v16.2M10 2.6 6.6 18.8M10 2.6 17.4 13.2',
    },
    {
      id: 'solid-prism-3', label: 'Треугольная призма',
      icon: 'M4.6 6.6 10 3.4l5.4 3.2v7.4L10 17.2 4.6 14zM4.6 6.6 10 9.8l5.4-3.2M10 9.8v7.4',
    },
    {
      id: 'solid-prism-4', label: 'Четырёхугольная призма',
      icon: 'M3.6 6.2 10 2.8l6.4 3.4v7.6L10 17.2 3.6 13.8zM3.6 6.2 10 9.6l6.4-3.4M10 9.6v7.6',
    },
    {
      id: 'solid-prism-5', label: 'Пятиугольная призма',
      icon: 'M10 2.8 17 7.4 14.4 18H5.6L3 7.4zM3 7.4 10 12l7-4.6M10 12v6',
    },
    {
      id: 'solid-sphere', label: 'Сфера',
      icon: 'M10 2.8a7.2 7.2 0 1 0 .01 14.4A7.2 7.2 0 0 0 10 2.8zM2.8 10h14.4M10 2.8c-2.4 1.6-2.4 12.8 0 14.4',
    },
  ];

  function solidVariant(id) {
    return SOLID_VARIANTS.find((v) => v.id === id) || SOLID_VARIANTS[0];
  }

  /* Обе кнопки с вариантами: kind — имя набора, stateKey — поле состояния */
  const VARIANT_MENUS = {
    rect: { list: SHAPE_VARIANTS, pick: shapeVariant, stateKey: 'shapeVariant', key: 'R' },
    ellipse: { list: ELLIPSE_VARIANTS, pick: ellipseVariant, stateKey: 'ellipseVariant', key: 'O' },
    triangle: { list: TRIANGLE_VARIANTS, pick: triangleVariant, stateKey: 'triangleVariant', key: 'U' },
    solid: { list: SOLID_VARIANTS, pick: solidVariant, stateKey: 'solidVariant', key: 'C' },
  };

  function createUI(app) {
    const { state } = app;
    const el = {
      stage: document.getElementById('stage'),
      tools: Array.from(document.querySelectorAll('.tool[data-tool]')),
      inspector: document.getElementById('inspector'),
      inkSwatches: document.getElementById('swatchesInk'),
      inkTitle: document.getElementById('inkTitle'),
      hiSwatches: document.getElementById('swatchesHi'),
      thickness: document.getElementById('thickness'),
      fillRow: document.querySelector('.fill-row'),
      textSizeValue: document.getElementById('textSizeValue'),
      fmtBtns: Array.from(document.querySelectorAll('.fmt-btn[data-fmt]')),
      textAlignBtns: Array.from(document.querySelectorAll('.text-aligns [data-align]')),
      fontSelect: document.getElementById('fontSelect'),
      stTool: document.getElementById('stTool'),
      stCoords: document.getElementById('stCoords'),
      stCount: document.getElementById('stCount'),
      fileName: document.getElementById('fileName'),
      fileRename: document.getElementById('fileRename'),
      zoomReset: document.getElementById('btnZoomReset'),
      btnUndo: document.getElementById('btnUndo'),
      btnRedo: document.getElementById('btnRedo'),
      btnGrid: document.getElementById('btnGrid'),
      btnCells: document.getElementById('btnCells'),
      eraserSlider: document.getElementById('eraserSlider'),
      eraserSizeValue: document.getElementById('eraserSizeValue'),
      protractorLearn: document.getElementById('btnProtractorLearn'),
      shapeMenu: document.getElementById('shapeMenu'),
      variantBtns: {
        rect: document.querySelector('.tool[data-tool="rect"]'),
        ellipse: document.querySelector('.tool[data-tool="ellipse"]'),
        triangle: document.querySelector('.tool[data-tool="triangle"]'),
        solid: document.querySelector('.tool[data-tool="solid"]'),
      },
      selectionBar: document.getElementById('selectionbar'),
      hud: document.getElementById('hud'),
      toast: document.getElementById('toast'),
      shortcuts: document.getElementById('shortcuts'),
      about: document.getElementById('about'),
      aboutVersion: document.getElementById('aboutVersion'),
      aboutAuthor: document.getElementById('aboutAuthor'),
      aboutEngine: document.getElementById('aboutEngine'),
      updateStatus: document.getElementById('updateStatus'),
      updateProgress: document.getElementById('updateProgress'),
      updateBar: document.getElementById('updateBar'),
      btnCheckUpdate: document.getElementById('btnCheckUpdate'),
      btnDownloadUpdate: document.getElementById('btnDownloadUpdate'),
      btnInstallUpdate: document.getElementById('btnInstallUpdate'),
      btnReleases: document.getElementById('btnReleases'),
    };

    let toastTimer = null;

    /* пока открыто поле ввода, панель живёт в режиме «Текст» — так
       форматирование доступно и при инструменте «Выделение» */
    let editing = false;

    /* ---------- палитры ---------- */

    function fillSwatches(container, colors, current, onPick) {
      container.textContent = '';
      for (const { name, hex } of colors) {
        const b = document.createElement('button');
        b.className = 'swatch' + (hex === current ? ' active' : '');
        b.style.background = hex;
        b.dataset.color = hex;
        b.title = name;
        b.setAttribute('aria-label', name);
        b.addEventListener('click', () => {
          onPick(hex);
          for (const node of container.children) node.classList.toggle('active', node.dataset.color === hex);
        });
        container.appendChild(b);
      }
    }

    function buildPalettes() {
      const inkCurrent = () => (state.tool === 'fill' ? state.fillColor : state.color);
      fillSwatches(el.inkSwatches, INK_COLORS, inkCurrent(), (c) => {
        /* «Заливка» выбирает свой цвет и не трогает цвет пера,
           остальные инструменты — наоборот */
        if (state.tool === 'fill') {
          state.fillColor = c;
          syncSwatches();
          app.savePrefs();
          return;
        }
        state.color = c;
        app.applyColorToSelectionIfText(c);
        /* без этого --ink останется прежним, и иконки пера/маркера не перекрасятся */
        syncSwatches();
      });

      fillSwatches(el.hiSwatches, HI_COLORS, state.hiColor, (c) => {
        state.hiColor = c;
        syncSwatches();
      });

      el.thickness.addEventListener('click', (e) => {
        const b = e.target.closest('.th');
        if (!b) return;
        app.setWidthFor(state.tool, Number(b.dataset.w));
      });

      el.fillRow.addEventListener('click', (e) => {
        const b = e.target.closest('.fill-btn');
        if (!b) return;
        state.fill = b.dataset.fill;
        syncFill();
        app.requestRender();
      });

      /* слайдер ластика: диаметр круга-области от минимального до большого */
      el.eraserSlider.addEventListener('input', () => {
        app.setEraserWidth(Number(el.eraserSlider.value));
      });

      /* список гарнитур — из модели: один источник правды для панели и файлов */
      el.fontSelect.textContent = '';
      for (const fam of M.FONT_FAMILIES) {
        const opt = document.createElement('option');
        opt.value = fam.id;
        opt.textContent = fam.label;
        el.fontSelect.appendChild(opt);
      }
      el.fontSelect.addEventListener('change', () => app.setTextFamily(el.fontSelect.value));

      el.inspector.addEventListener('click', (e) => {
        const step = e.target.closest('[data-textsize]');
        if (step) {
          app.changeTextSize(Number(step.dataset.textsize));
          return;
        }
        const fmt = e.target.closest('[data-fmt]');
        if (fmt) {
          app.toggleTextStyle(fmt.dataset.fmt);
          return;
        }
        const align = e.target.closest('[data-align]');
        if (align) {
          app.setTextAlign(align.dataset.align);
          return;
        }
        const cmd = e.target.closest('[data-cmd]');
        if (cmd) app.runCommand(cmd.dataset.cmd);
      });

      el.protractorLearn.addEventListener('click', () => {
        app.setProtractorLearn(!state.protractorLearn);
      });

      el.shapeMenu.addEventListener('click', (e) => {
        const b = e.target.closest('[data-variant]');
        if (!b) return;
        const kind = b.dataset.menu;
        closeShapeMenu();
        app.setVariant(kind, b.dataset.variant);
      });

      /* правый клик по кнопкам с вариантами открывает меню выбора фигуры */
      for (const kind of Object.keys(VARIANT_MENUS)) {
        const btn = el.variantBtns[kind];
        if (!btn) continue;
        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          openShapeMenu(kind, e.clientX, e.clientY);
        });
      }
    }

    /* ---------- меню выбора фигуры ---------- */

    let shapeMenuKind = null;

    function buildShapeMenu(kind) {
      const menu = VARIANT_MENUS[kind];
      el.shapeMenu.textContent = '';
      for (const v of menu.list) {
        const b = document.createElement('button');
        b.dataset.menu = kind;
        b.dataset.variant = v.id;
        b.setAttribute('role', 'menuitemradio');
        b.innerHTML =
          `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${v.icon}"/></svg><span></span>`;
        b.querySelector('span').textContent = v.label;
        el.shapeMenu.appendChild(b);
      }
      shapeMenuKind = kind;
    }

    function syncShapeMenu() {
      const kind = shapeMenuKind;
      if (!kind) return;
      const current = state[VARIANT_MENUS[kind].stateKey];
      for (const b of el.shapeMenu.children) {
        const on = b.dataset.variant === current;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    }

    function openShapeMenu(kind, x, y) {
      buildShapeMenu(kind);
      syncShapeMenu();
      el.shapeMenu.hidden = false;
      /* держим меню в окне, даже если клик был у самого края */
      const w = el.shapeMenu.offsetWidth;
      const h = el.shapeMenu.offsetHeight;
      const left = Math.min(x, Math.max(8, window.innerWidth - w - 8));
      const top = Math.min(y, Math.max(8, window.innerHeight - h - 8));
      el.shapeMenu.style.left = `${Math.max(8, left)}px`;
      el.shapeMenu.style.top = `${Math.max(8, top)}px`;
    }

    function closeShapeMenu() {
      el.shapeMenu.hidden = true;
      shapeMenuKind = null;
    }

    /* Подсказка кнопки с вариантами прямоугольника, круга, треугольника
       и объёмной фигуры. Эти кнопки придуманы в первую очередь для левой
       клавиши: вариант меняют правой, поэтому про неё сказано прямо в
       подсказке, а не только в окне горячих клавиш. */
    const VARIANT_HINT = ' · ПКМ — другие фигуры';

    /* Кнопки рисуют выбранную фигуру, поэтому кнопка и статус показывают
       её название, а иконка — её контур. */
    function syncShapeVariant() {
      for (const kind of Object.keys(VARIANT_MENUS)) {
        const menu = VARIANT_MENUS[kind];
        const v = menu.pick(state[menu.stateKey]);
        const btn = el.variantBtns[kind];
        if (!btn) continue;
        TOOL_LABELS[kind] = v.label;
        const svg = btn.querySelector('svg');
        if (svg) svg.innerHTML = `<path d="${v.icon}"/>`;
        btn.dataset.tip = `${v.label} (${menu.key})${VARIANT_HINT}`;
        btn.setAttribute('aria-label', `${v.label}, варианты — правая кнопка мыши`);
        if (state.tool === kind) el.stTool.textContent = v.label;
      }
      if (!el.shapeMenu.hidden) syncShapeMenu();
    }

    function syncProtractorLearn() {
      el.protractorLearn.classList.toggle('active', !!state.protractorLearn);
    }

    function syncThickness() {
      for (const b of el.thickness.children) {
        b.classList.toggle('active', Number(b.dataset.w) === state.width);
      }
    }

    /* слайдер ластика показывает текущий диаметр круга */
    function syncEraser() {
      el.eraserSlider.value = String(state.eraserWidth);
      el.eraserSizeValue.textContent = String(state.eraserWidth);
    }

    function syncFill() {
      for (const b of el.fillRow.children) {
        b.classList.toggle('active', b.dataset.fill === state.fill);
        b.style.color = state.color;
      }
    }

    function syncTextSize() {
      el.textSizeValue.textContent = String(Math.round(state.textSize));
    }

    /* кнопки начертания и выравнивания показывают формат того, к чему
       применится следующий клик: открытой правки, выделения или умолчаний */
    function syncTextFormat() {
      const fmt = app.currentTextFormat();
      for (const b of el.fmtBtns) {
        const on = !!fmt[b.dataset.fmt];
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      const family = fmt.family || 'ui';
      if (el.fontSelect.value !== family) el.fontSelect.value = family;
      const align = fmt.align || 'left';
      for (const b of el.textAlignBtns) {
        b.classList.toggle('active', b.dataset.align === align);
      }
    }

    function syncSwatches() {
      document.documentElement.style.setProperty('--ink', state.color);
      /* иконка маркера показывает его собственный цвет, а не цвет чернил */
      document.documentElement.style.setProperty('--hi', state.hiColor);
      /* иконка заливки показывает свой цвет, а не цвет пера */
      document.documentElement.style.setProperty('--fillc', state.fillColor);
      /* активный образец зависит от инструмента: у «Заливки» свой цвет */
      const inkNow = state.tool === 'fill' ? state.fillColor : state.color;
      for (const node of el.inkSwatches.children) {
        node.classList.toggle('active', node.dataset.color === inkNow);
      }
      for (const node of el.hiSwatches.children) {
        node.classList.toggle('active', node.dataset.color === state.hiColor);
      }
      syncFill();
    }

    /* ---------- инструменты ---------- */

    function setTool(tool) {
      for (const b of el.tools) b.classList.toggle('active', b.dataset.tool === tool);
      el.stage.className = el.stage.className.replace(/\btool-\S+/g, '').trim();
      el.stage.classList.add(`tool-${tool}`);
      const active = editing ? 'text' : tool;
      for (const block of el.inspector.querySelectorAll('.insp-block')) {
        const list = (block.dataset.for || '').split(/\s+/);
        block.classList.toggle('visible', list.includes(active));
      }
      el.stTool.textContent = TOOL_LABELS[tool] || tool;
      /* палитра при «Заливке» выбирает цвет заливки, а не чернил */
      el.inkTitle.textContent = tool === 'fill' ? 'Цвет заливки' : 'Цвет чернил';
      syncSwatches();
      syncThickness();
      syncFill();
      syncTextSize();
      syncTextFormat();
      syncProtractorLearn();
      updateSelectionBar();
    }

    /* правка текста открыта или закрыта: блоки панели перестраиваются */
    function setEditing(on) {
      editing = !!on;
      setTool(state.tool);
    }

    /* ---------- верхняя панель и статус ---------- */

    function updateZoom() {
      el.zoomReset.textContent = `${Math.round(state.view.scale * 100)}%`;
    }

    function updateHistory(history) {
      el.btnUndo.disabled = !history.canUndo;
      el.btnRedo.disabled = !history.canRedo;
      el.btnUndo.title = history.canUndo ? `Отменить: ${history.undoLabel}` : 'Отменить (Ctrl+Z)';
      el.btnRedo.title = history.canRedo ? `Повторить: ${history.redoLabel}` : 'Повторить (Ctrl+Y)';
    }

    function updateCounts() {
      const n = app.store.items.length;
      el.stCount.textContent = `${n} ${plural(n, 'объект', 'объекта', 'объектов')}`;
      el.hud.classList.toggle('hidden', n > 0);
    }

    function plural(n, one, few, many) {
      const mod10 = n % 10;
      const mod100 = n % 100;
      if (mod10 === 1 && mod100 !== 11) return one;
      if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
      return many;
    }

    function updateCoords(world) {
      if (!world) return;
      const text = `${Math.round(world.x)}, ${Math.round(world.y)}`;
      /* та же запись при каждом движении мыши — лишняя работа для вёрстки */
      if (el.stCoords.textContent !== text) el.stCoords.textContent = text;
    }

    function setFileName(name, dirty) {
      el.fileName.textContent = name;
      el.fileName.classList.toggle('dirty', !!dirty);
    }

    /* Переименование по двойному клику: на месте надписи появляется поле,
       Enter и уход курсора сохраняют, Esc отменяет. */
    const NAME_MAX = 120;

    function startRename(current, onDone) {
      if (el.fileName.hidden) return;
      const input = el.fileRename;
      input.hidden = false;
      el.fileName.hidden = true;
input.value = current;
      input.focus();
      input.select();

      const finish = (commit) => {
        if (input.hidden) return;
        const value = input.value.trim().slice(0, NAME_MAX);
        input.hidden = true;
        el.fileName.hidden = false;
        el.fileName.focus();
        if (commit) onDone(value);
      };

      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      };
      input.onblur = () => finish(true);
    }

    function setGridActive(active) {
      el.btnGrid.classList.toggle('active', !!active);
    }

    function setCellsActive(active) {
      el.btnCells.classList.toggle('active', !!active);
    }

    /* ---------- панель выделения ---------- */

    function updateSelectionBar() {
      if (!state.selection.length || app.interactions.isEditing()) {
        el.selectionBar.hidden = true;
        return;
      }
      const rect = app.store.bounds(state.selection);
      if (!rect) {
        el.selectionBar.hidden = true;
        return;
      }
      const screen = G.viewToScreenRect(rect, state.view);
      const stageRect = el.stage.getBoundingClientRect();
      const bar = el.selectionBar;
      bar.hidden = false;
      const width = bar.offsetWidth || 180;
      const height = bar.offsetHeight || 40;
      let x = screen.x + screen.w / 2 - width / 2;
      let y = screen.y - height - 10;
      if (y < 6) y = screen.y + screen.h + 10;
      x = G.clamp(x, 8, Math.max(8, stageRect.width - width - 8));
      y = G.clamp(y, 6, Math.max(6, stageRect.height - height - 6));
      bar.style.left = `${x}px`;
      bar.style.top = `${y}px`;
    }

    /* ---------- уведомления ---------- */

    function toast(message, isError) {
      el.toast.textContent = message;
      el.toast.classList.toggle('error', !!isError);
      el.toast.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        el.toast.hidden = true;
        toastTimer = null;
      }, isError ? 5000 : 2200);
    }

    function showShortcuts(show) {
      el.shortcuts.hidden = show === false;
    }

    function showAbout(show) {
      el.about.hidden = show === false;
    }

    return {
      el,
      INK_COLORS, TOOL_LABELS,
      buildPalettes, setTool, updateZoom, updateHistory, updateCounts,
      updateCoords, setFileName, startRename, setGridActive, setCellsActive, updateSelectionBar,
      openShapeMenu, closeShapeMenu, syncShapeVariant, VARIANT_MENUS,
      ELLIPSE_VARIANTS, ellipseVariant, TRIANGLE_VARIANTS, triangleVariant,
      SOLID_VARIANTS, solidVariant,
      toast, showShortcuts, showAbout, syncSwatches, syncThickness, syncFill, syncTextSize,
      syncTextFormat, setEditing,
      syncEraser,
      syncProtractorLearn,
    };
  }

  IB.ui = { createUI };
})(window);
