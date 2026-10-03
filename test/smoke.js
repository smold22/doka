'use strict';

/* Smoke-тест: запускает renderer в скрытом окне, имитирует работу инструментов
   и проверяет целостность модели, истории и сохранения.
   Запуск: npx electron test/smoke.js */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fsProm = require('node:fs/promises');
const Update = require('../lib/update');

/* заглушки IPC, чтобы тест не зависел от main.js */
ipcMain.handle('app:dirty', () => true);
/* буфер обмена теста: тест может подложить картинку и текст */
const fakeClipboard = { text: '', imageDataUrl: null };
/* повторяем поведение main.js: запись в буфер заменяет его содержимое */
ipcMain.handle('clipboard:write', (_e, payload = {}) => {
  fakeClipboard.text = payload.text || '';
  fakeClipboard.imageDataUrl = payload.imageDataUrl || null;
  return true;
});
ipcMain.handle('clipboard:read', () => ({
  text: fakeClipboard.text,
  imageDataUrl: fakeClipboard.imageDataUrl,
}));
ipcMain.handle('app:toast', () => true);
ipcMain.handle('image:open', () => ({ ok: false, canceled: true }));
/* заглушки «О программе» и обновлений: сеть в тестах не ходим */
ipcMain.handle('app:info', () => ({
  version: '0.0.0-test',
  author: 'Тест',
  electron: process.versions.electron,
  chrome: process.versions.chrome,
}));
ipcMain.handle('update:check', () => ({
  phase: 'latest',
  current: '0.0.0-test',
  latest: null,
  assetName: null,
  assetSize: null,
  received: 0,
  total: 0,
  file: null,
  error: null,
}));
ipcMain.handle('update:download', () => ({
  phase: 'error',
  current: '0.0.0-test',
  latest: null,
  assetName: null,
  assetSize: null,
  received: 0,
  total: 0,
  file: null,
  error: 'Скачивание не удалось: тест',
}));
ipcMain.handle('update:install', () => ({ ok: false, error: 'Тест: установка недоступна' }));
ipcMain.handle('update:openPage', () => true);

const results = [];
let failed = 0;

function report(name, ok, extra) {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed++;
}

app.disableHardwareAcceleration();

const HARD_TIMEOUT = setTimeout(() => {
  console.log('\n===== InkBoard smoke =====');
  console.log('FAIL  тест не завершился за отведённое время');
  console.log('===== итог: 0 из 1 =====\n');
  app.exit(1);
}, 60000);

/* логика обновлений: версии, поиск установщика, загрузка — всё без сети */
async function runUpdateTests() {
  report('update: 3.0.1 новее 3.0.0', Update.isNewer('3.0.1', '3.0.0') === true);
  report('update: одинаковые версии не новее', Update.isNewer('3.0.0', '3.0.0') === false);
  report('update: 10.0.0 новее 9.9.9 (числовой порядок)', Update.isNewer('10.0.0', '9.9.9') === true);
  report('update: префикс v в теге учитывается', Update.isNewer('v3.1.0', '3.0.0') === true);
  report('update: старая версия не новее', Update.isNewer('2.9.0', '3.0.0') === false);

  const asset = Update.pickAsset([
    { name: 'latest.yml', browser_download_url: 'u1' },
    { name: 'Doka-Setup-3.1.0.exe', browser_download_url: 'u2', size: 42 },
  ]);
  report('update: установщик находится среди ассетов', !!asset && asset.browser_download_url === 'u2');
  report('update: без установщика в релизе — null', Update.pickAsset([{ name: 'latest.yml' }]) === null);

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const fresh = await Update.checkLatest('3.0.0', {
    fetchImpl: async () => json({
      tag_name: 'v9.9.9',
      assets: [{ name: 'Doka-Setup-9.9.9.exe', browser_download_url: 'http://x/i.exe', size: 123 }],
    }),
  });
  report('update: checkLatest видит новую версию', fresh.hasUpdate === true && fresh.latest === '9.9.9');
  report('update: checkLatest отдаёт установщик', fresh.assetName === 'Doka-Setup-9.9.9.exe' && fresh.assetSize === 123);

  const old = await Update.checkLatest('3.0.0', { fetchImpl: async () => json({ tag_name: 'v2.0.0', assets: [] }) });
  report('update: старый релиз не считается обновлением', old.hasUpdate === false);

  let httpErr = false;
  try { await Update.checkLatest('3.0.0', { fetchImpl: async () => json({}, 500) }); } catch (err) { httpErr = true; }
  report('update: ошибка GitHub не замалчивается', httpErr);

  /* duck-типы вместо Response: точный контроль над content-length и телом */
  const payload = Buffer.alloc(2048, 7);
  const okRes = () => ({
    ok: true,
    headers: { get: (h) => (h === 'content-length' ? String(payload.length) : null) },
    body: (async function* () { yield payload; })(),
  });
  const dest = path.join(os.tmpdir(), `doka-update-test-${process.pid}.exe`);
  let progressCalls = 0;
  const got = await Update.download('http://x/i.exe', dest, {
    fetchImpl: async () => okRes(),
    onProgress: () => { progressCalls++; },
  });
  const written = await fsProm.stat(dest).catch(() => null);
  await fsProm.unlink(dest).catch(() => {});
  report('update: загрузка пишет файл целиком', got.received === payload.length && !!written && written.size === payload.length);
  report('update: загрузка сообщает прогресс', progressCalls > 0);

  const dest2 = path.join(os.tmpdir(), `doka-update-test-broken-${process.pid}.exe`);
  let brokeErr = false;
  try {
    await Update.download('http://x/i.exe', dest2, {
      fetchImpl: async () => ({
        ok: true,
        headers: { get: (h) => (h === 'content-length' ? String(payload.length + 100) : null) },
        body: (async function* () { yield payload; })(),
      }),
    });
  } catch (err) { brokeErr = true; }
  const leftover = await fsProm.stat(dest2).then(() => true, () => false);
  report('update: неполная загрузка откатывается', brokeErr && !leftover);
}

async function run() {
  await runUpdateTests();

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const consoleErrors = [];
  /* В этой версии Electron console-message передаёт (event, level, message, line, sourceId) */
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      consoleErrors.push(message);
      console.log(`[renderer error] ${message}\n  в ${sourceId}:${line}`);
    }
  });
  win.webContents.on('preload-error', (_e, p, err) => {
    console.log(`[preload error] ${p} ${err && err.message}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    consoleErrors.push(`render-process-gone: ${JSON.stringify(details)}`);
  });

  /* Настройки прошлого прогона не должны влиять на этот: выбранный вариант
     фигуры сохраняется и иначе ломает проверки в зависимости от запуска. */
  await win.webContents.session.clearStorageData();

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 700));

  /* тест кладёт в буфер обмена картинку и проверяет вставку из настоящего IPC */
  const clipPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';
  fakeClipboard.imageDataUrl = clipPng;
  fakeClipboard.text = '';

  const lines = await win.webContents.executeJavaScript(`(${testSource.toString()})()`, true);
  for (const line of lines) report(line.name, line.ok, line.extra);
  report('нет ошибок в консоли', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  clearTimeout(HARD_TIMEOUT);
  console.log('\n===== InkBoard smoke =====');
  for (const r of results) console.log(r);
  console.log(`===== итог: ${results.length - failed} из ${results.length} =====\n`);

  app.exit(failed ? 1 : 0);
}

app.whenReady().then(() => {
  run().catch((err) => {
    clearTimeout(HARD_TIMEOUT);
    console.log('\n===== InkBoard smoke =====');
    console.log(`FAIL  непойманая ошибка запуска теста — ${(err && err.stack) || err}`);
    console.log('===== итог: 0 из 1 =====\n');
    app.exit(1);
  });
});

/* проверки бывают и синхронные, и асинхронные (загрузка картинки) —
   результат всегда один, ожидание обеспечивает executeJavaScript */
async function testSource() {
  const lines = [];
  const t = (name, fn, diag) => {
    const describe = (v) => (diag ? diag() : String(v));
    try {
      const res = fn();
      if (res && typeof res.then === 'function') {
        return res.then(
          (v) => lines.push({ name, ok: v === true || v === undefined, extra: v === true || v === undefined ? undefined : describe(v) }),
          (err) => lines.push({ name, ok: false, extra: (err && err.message) || String(err) })
        );
      }
      lines.push({ name, ok: res === true || res === undefined, extra: res === true || res === undefined ? undefined : describe(res) });
      return undefined;
    } catch (err) {
      lines.push({ name, ok: false, extra: (err && err.message) || String(err) });
      return undefined;
    }
  };

  const testErrors = [];
  window.addEventListener('error', (e) => {
    testErrors.push(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  });

  try {

  const IB = window.IB;
  const app = IB && IB.app;
  const canvas = document.getElementById('board');
  const overlay = document.getElementById('overlay');
  const st = app.state;
  const store = app.store;
  const itc = app.interactions;
  const ui = app.ui;
  /* картинка 4×4 для проверки вставки из буфера */
  const pastePng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';
  const pastePngBase64 = pastePng.split(',')[1];

  /* Тест должен начинаться с чистого холста при любом состоянии localStorage:
     иначе приложение восстановит автосохранение прошлого прогона (чужая панорама
     и масштаб), и проверки геометрии начнут падать в зависимости от запуска. */
  IB.persist.clearAutosave();
  itc.resetView();
  st.selection = [];

  const fire = (type, x, y, opts) => {
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent(type, Object.assign({
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
      button: 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: true,
      clientX: rect.left + x, clientY: rect.top + y,
    }, opts || {})));
  };

  const toScreen = (p) => ({
    x: p.x * st.view.scale + st.view.pan.x,
    y: p.y * st.view.scale + st.view.pan.y,
  });

  const gesture = (from, to) => {
    fire('pointerdown', from.x, from.y);
    fire('pointermove', to.x, to.y);
    fire('pointerup', to.x, to.y);
  };

  t('модуль IB и приложение инициализированы', () => !!app && !!store && !!itc);
  t('canvas размера окна', () => canvas.width > 100 && canvas.height > 100);
  /* без touch-action: none браузер забирает жест пера и шлёт pointercancel:
     на планшете рисуется одна черточка, дальше ввод не приходит */
  t('холст не отдаёт жест браузеру (touch-action: none)', () =>
    getComputedStyle(canvas).touchAction === 'none');
  t('перо пишет после прерывания жеста (pointercancel)', () => {
    store.clear();
    itc.setTool('pen');
    fire('pointerdown', 120, 120);
    fire('pointermove', 160, 150);
    fire('pointercancel', 160, 150);
    const afterCancel = store.items.length;
    fire('pointerdown', 240, 200);
    fire('pointermove', 280, 230);
    fire('pointerup', 280, 230);
    return afterCancel === 1 && store.items.length === 2 &&
      store.items.every((o) => o.type === 'stroke');
  });
  /* 10 инструментов: ластик и выделение перенесены в нижнюю панель */
  t('10 инструментов в боковой панели', () => document.querySelectorAll('#toolrail .tool').length === 10);
  t('ластик и выделение перенесены в нижнюю панель', () =>
    !!document.querySelector('#toolbar-bottom .tool[data-tool="eraser"]') &&
    !!document.querySelector('#toolbar-bottom .tool[data-tool="select"]') &&
    !document.querySelector('#toolrail .tool[data-tool="eraser"]') &&
    !document.querySelector('#toolrail .tool[data-tool="select"]'));
  t('липких заметок не осталось', () =>
    !document.querySelector('#toolrail .tool[data-tool="sticky"]') &&
    !document.getElementById('swatchesSticky') &&
    !document.querySelector('.insp-block[data-for="sticky"]'));
  /* палитра чернил задана пользователем */
  const INK_PALETTE = [
    'Чёрный:#000000', 'Белый:#FFFFFF', 'Серый:#808080', 'Светло-серый:#C0C0C0',
    'Красный:#FF0000', 'Тёмно-красный:#CC0000', 'Светло-красный:#FF6666', 'Бордовый:#8B0000',
    'Оранжевый:#FF8000', 'Апельсиновый:#FFA500', 'Тёмно-оранжевый:#CC6600', 'Жёлтый:#FFFF00',
    'Золотой:#FFD700', 'Лимонный:#FFFACD', 'Зелёный:#00FF00', 'Тёмно-зелёный:#008000',
    'Светло-зелёный:#90EE90', 'Изумрудный:#006400', 'Синий:#0000FF', 'Тёмно-синий:#0000CC',
    'Светло-синий:#6666FF', 'Navy:#00008B', 'Голубой:#87CEEB', 'Фиолетовый:#800080',
    'Светло-фиолетовый:#EE82EE', 'Индиго:#4B0082', 'Коричневый:#A52A2A', 'Шоколадный:#D2691E',
    'Розовый:#FFC0CB', 'Бирюзовый:#40E0D0',
  ];
  t('палитра чернил — 29 заданных цветов', () =>
    document.querySelectorAll('#swatchesInk .swatch').length === INK_PALETTE.length);
  t('палитра чернил совпадает с заданной по порядку и названиям', () => {
    const nodes = Array.from(document.querySelectorAll('#swatchesInk .swatch'));
    return nodes.every((n, i) => {
      const [name, hex] = INK_PALETTE[i].split(':');
      return n.dataset.color === hex && n.title === name;
    });
  });
t('иконка пера показывает выбранный цвет чернил', () => {
    itc.setTool('eraser');
    const penBtn = document.querySelector('.tool[data-tool="pen"]');
    const rgb = (el) => getComputedStyle(el).color;
    const hexToRgb = (h) => {
      const n = parseInt(h.slice(1), 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    for (const hex of ['#FF0000', '#000000', '#0000FF', '#FFD700', '#800080', '#D2691E', '#40E0D0']) {
      document.querySelector(`#swatchesInk .swatch[data-color="${hex}"]`).click();
      if (rgb(penBtn) !== hexToRgb(hex)) return false;
      if (!document.querySelector(`#swatchesInk .swatch[data-color="${hex}"].active`)) return false;
    }
    return true;
  });

  t('палитра маркера — те же 29 заданных цветов, но отдельный список', () => {
    const hiNodes = Array.from(document.querySelectorAll('#swatchesHi .swatch'));
    const inkNodes = Array.from(document.querySelectorAll('#swatchesInk .swatch'));
    /* набор цветов тот же, но узлы палитр разные — выбор независим */
    return hiNodes.length === INK_PALETTE.length && inkNodes.length === INK_PALETTE.length &&
      hiNodes.every((n, i) => {
        const [name, hex] = INK_PALETTE[i].split(':');
        return n.dataset.color === hex && n.title === name;
      }) &&
      hiNodes[0] !== inkNodes[0];
  });
  t('выбор в палитре маркера не двигает палитру чернил', () => {
    document.querySelector('#swatchesInk .swatch[data-color="#4B0082"]').click();
    document.querySelector('#swatchesHi .swatch[data-color="#FFD700"]').click();
    const ink = document.querySelector('#swatchesInk .swatch.active');
    const hi = document.querySelector('#swatchesHi .swatch.active');
    return !!ink && !!hi && ink.dataset.color === '#4B0082' && hi.dataset.color === '#FFD700' &&
      document.querySelectorAll('#swatchesInk .swatch.active').length === 1 &&
      document.querySelectorAll('#swatchesHi .swatch.active').length === 1;
  });

  t('иконка маркера показывает свой цвет, а не цвет чернил', () => {
    const hiBtn = document.querySelector('.tool[data-tool="highlighter"]');
    const penBtn = document.querySelector('.tool[data-tool="pen"]');
    const rgb = (el) => getComputedStyle(el).color;
    const hexToRgb = (h) => {
      const n = parseInt(h.slice(1), 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    for (const hex of ['#FFFF00', '#90EE90', '#87CEEB', '#EE82EE', '#FF8000']) {
      document.querySelector(`#swatchesHi .swatch[data-color="${hex}"]`).click();
      if (rgb(hiBtn) !== hexToRgb(hex)) return false;
      if (!document.querySelector(`#swatchesHi .swatch[data-color="${hex}"].active`)) return false;
    }
    /* выбор маркера не должен двигать цвет пера */
    return rgb(penBtn) === hexToRgb(st.color);
  });

  t('маркер рисует своим цветом, перо — чернилами', () => {
    document.querySelector('#swatchesHi .swatch[data-color="#87CEEB"]').click();
    document.querySelector('#swatchesInk .swatch[data-color="#FF0000"]').click();
    store.clear();
    itc.setTool('highlighter');
    gesture(toScreen({ x: -200, y: 40 }), toScreen({ x: -60, y: 90 }));
    const hiStroke = store.items[store.items.length - 1];
    itc.setTool('pen');
    gesture(toScreen({ x: -200, y: 140 }), toScreen({ x: -60, y: 190 }));
    const penStroke = store.items[store.items.length - 1];
    return store.items.length === 2 && hiStroke.kind === 'highlighter' &&
      hiStroke.color === '#87CEEB' && penStroke.kind === 'pen' &&
      penStroke.color === '#FF0000';
  });
  t('образцы цвета круглые, обводка выбора круглая', () => {
    itc.setTool('pen');
    const box = document.querySelector('#swatchesInk');
    const swatches = Array.from(document.querySelectorAll('.swatch'));
    const active = box.querySelector('.swatch.active');
    const KEYS = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'];
    /* обе палитры круглые, а не скруглённые квадраты */
    const round = (el) => {
      const cs = getComputedStyle(el);
      /* радиус в процентах равносилен половине стороны */
      return KEYS.every((k) => {
        const r = cs[k];
        return r.endsWith('%') ? parseFloat(r) === 50 : parseFloat(r) === el.offsetWidth / 2;
      });
    };
    if (!active || !swatches.length || !swatches.every(round)) return false;
    /* обводка выбранного цвета тоже круглая */
    const after = getComputedStyle(active, '::after');
    return after.borderTopWidth === '2px' && after.borderRadius === '50%' &&
      KEYS.every((k) => parseFloat(after[k]) === 50);
  });

  t('панель инструментов — карточка 60px со скруглением 8px', () => {
    const rail = document.getElementById('toolrail');
    const cs = getComputedStyle(rail);
    const stage = document.getElementById('stage').getBoundingClientRect();
    const rect = rail.getBoundingClientRect();
    return cs.position === 'absolute' && rect.width === 60 &&
      parseFloat(cs.borderTopLeftRadius) === 8 &&
      cs.boxShadow !== 'none' &&
      Math.round(rect.left - stage.left) === 16 && Math.round(rect.top - stage.top) === 16 &&
      rect.left + rect.width > stage.left;
  });
  /* боковая колонка компактнее нижней панели: 52×46 с иконками 24px */
  t('кнопки боковой панели 52x46 с иконками 24px', () => {
    const buttons = Array.from(document.querySelectorAll('#toolrail .tool'));
    const ok = buttons.every((b) => b.offsetWidth === 52 && b.offsetHeight === 46);
    const icons = buttons.map((b) => getComputedStyle(b.querySelector('svg')));
    const painted = (cs) => (cs.fill === 'none' && cs.stroke !== 'none') ||
      (cs.fill !== 'none' && cs.stroke === 'none');
    return ok && buttons.every((b) => b.dataset.tip) &&
      icons.every((cs) => cs.width === '24px' && cs.height === '24px') &&
      icons.every(painted);
  });
  t('нижняя панель выросла вместе с иконками', () => {
    const bar = document.getElementById('toolbar-bottom');
    const stage = document.getElementById('stage').getBoundingClientRect();
    const rect = bar.getBoundingClientRect();
    const buttons = Array.from(bar.querySelectorAll('.tool'));
    const seps = Array.from(bar.querySelectorAll('.tool-sep-v'));
    return buttons.every((b) => b.offsetWidth === 52 && b.offsetHeight === 52) &&
      buttons.every((b) => getComputedStyle(b.querySelector('svg')).width === '26px') &&
      /* карточка шире своей высоты: иначе значки просто наехали бы друг на друга */
      rect.width > rect.height &&
      Math.round(stage.bottom - rect.bottom) === 16 &&
      Math.abs((rect.left + rect.width / 2) - (stage.left + stage.width / 2)) < 1.5 &&
      seps.every((s) => parseFloat(getComputedStyle(s).height) >= 32);
  });
  /* Боковая панель прокручивается, если инструментов не помещается в окно,
     поэтому проверяем, что карточка сама помещается в холст, а кнопки
     внутри неё не наезжают друг на друга. */
  t('иконка в кнопке не перекрывает соседей', () => {
    const rail = document.querySelector('#toolrail');
    const boxes = Array.from(document.querySelectorAll('#toolrail .tool, #toolbar-bottom .tool'))
      .map((b) => b.getBoundingClientRect());
    for (let i = 1; i < boxes.length; i += 1) {
      if (boxes[i].left < boxes[i - 1].right - 0.5 &&
          boxes[i].top < boxes[i - 1].bottom - 0.5) return false;
    }
    const stage = document.getElementById('stage').getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const railInside = railRect.top >= stage.top - 0.5 && railRect.bottom <= stage.bottom + 0.5 &&
      railRect.left >= stage.left - 0.5 && railRect.right <= stage.right + 0.5;
    return boxes.every((b) => b.width > 0 && b.height > 0) && railInside;
  });
  t('иконка пера в боковой панели — силуэт 24×24', () => {
    const svg = document.querySelector('#toolrail .tool[data-tool="pen"] svg');
    return svg.classList.contains('solid') && svg.getAttribute('viewBox') === '0 0 24 24' &&
      svg.querySelectorAll('path').length === 1;
  });
  t('иконка маркера в боковой панели — силуэт 80×80', () => {
    const svg = document.querySelector('#toolrail .tool[data-tool="highlighter"] svg');
    return svg.classList.contains('solid') && svg.getAttribute('viewBox') === '0 0 80 80' &&
      svg.querySelectorAll('path').length === 1;
  });
  t('иконка ластика в нижней панели — силуэт 16×16', () => {
    const svg = document.querySelector('#toolbar-bottom .tool[data-tool="eraser"] svg');
    return svg.classList.contains('solid') && svg.getAttribute('viewBox') === '0 0 16 16' &&
      svg.querySelectorAll('path').length === 1;
  });
  t('силуэтные иконки заливаются, а не обводятся', () => {
    const cs = getComputedStyle(document.querySelector('#toolrail .tool[data-tool="pen"] svg.solid'));
    return cs.fill !== 'none' && cs.stroke === 'none';
  });
  t('иконка пера отличается от маркера', () => {
    const get = (tool) => document.querySelector(`.tool[data-tool="${tool}"] svg path`)
      .getAttribute('d');
    return get('pen') !== get('highlighter') && get('pen') !== get('eraser');
  });
  t('иконки ручек внизу остались контурными', () => {
    return Array.from(document.querySelectorAll('#toolbar-bottom .pen-pick')).every((b) => {
      const svg = b.querySelector('svg');
      const cs = getComputedStyle(svg);
      return svg.getAttribute('viewBox') === '0 0 20 20' && !svg.classList.contains('solid') &&
        cs.fill === 'none' && cs.stroke !== 'none';
    });
  });
  t('активный инструмент выделен серой заливкой', () => {
    itc.setTool('rect');
    const active = document.querySelector('#toolrail .tool.active');
    const isRect = active.dataset.tool === 'rect';
    const bg = getComputedStyle(active).backgroundColor;
    const other = getComputedStyle(document.querySelector('#toolrail .tool[data-tool="pen"]')).backgroundColor;
    itc.setTool('pen');
    return isRect && bg === 'rgb(225, 223, 221)' && other !== bg;
  });
  /* группы: рисование и фигуры — два разделителя; выделение убрано вниз */
  t('группы инструментов разделены двумя разделителями', () =>
    document.querySelectorAll('#toolrail .tool-sep').length === 2);

  /* ---------------- сетка и клетка ---------------- */

  t('кнопка «Клетка» стоит рядом с «Сетка»', () => {
    const grid = document.getElementById('btnGrid');
    const cells = document.getElementById('btnCells');
    return !!cells && cells.previousElementSibling === grid && cells.dataset.cmd === 'toggleCells';
  });

  t('клетка переключается и снимает точки сетки', () => {
    app.commands.setBackground('none');
    app.commands.toggleGrid();
    const gridOn = st.showGrid === true && st.showCells === false;
    app.commands.toggleCells();
    const cellsOn = st.showCells === true && st.showGrid === false;
    app.commands.toggleCells();
    const off = st.showCells === false && st.showGrid === false;
    return gridOn && cellsOn && off;
  });

  t('Сетка и Клетка переключаются туда-обратно, активна ровно одна', () => {
    const active = () => ['btnGrid', 'btnCells']
      .filter((id) => document.getElementById(id).classList.contains('active'));
    const state = () => [st.showGrid, st.showCells];
    app.commands.setBackground('none');
    if (active().length !== 0) return false;

    app.commands.toggleGrid();
    if (state().join() !== 'true,false' || active().join() !== 'btnGrid') return false;
    app.commands.toggleCells();
    if (state().join() !== 'false,true' || active().join() !== 'btnCells') return false;
    app.commands.toggleGrid();
    if (state().join() !== 'true,false' || active().join() !== 'btnGrid') return false;
    app.commands.toggleCells();
    if (state().join() !== 'false,true' || active().join() !== 'btnCells') return false;
    app.commands.toggleGrid();
    if (state().join() !== 'true,false' || active().join() !== 'btnGrid') return false;
    /* повторное нажатие снимает фон */
    app.commands.toggleGrid();
    if (state().join() !== 'false,false' || active().length !== 0) return false;
    /* и обратно из пустого фона */
    app.commands.toggleCells();
    if (state().join() !== 'false,true' || active().join() !== 'btnCells') return false;
    app.commands.setBackground('none');
    return state().join() === 'false,false' && active().length === 0;
  });

  t('клетка рисует линии по своему шагу', () => {
    const calls = [];
    const record = (name) => (...args) => calls.push([name, ...args]);
    const ctx = {
      save: record('save'),
      restore: record('restore'),
      beginPath: record('beginPath'),
      moveTo: record('moveTo'),
      lineTo: record('lineTo'),
      stroke: record('stroke'),
      set strokeStyle(v) { calls.push(['strokeStyle', v]); },
      set lineWidth(v) { calls.push(['lineWidth', v]); },
    };
    const view = { scale: 1, pan: { x: 0, y: 0 } };
    IB.paint.drawCells(ctx, view, 400, 300);
    const step = IB.paint.cellStep(view);
    /* линии лежат на шаге клетки, с поправкой в полпикселя на чёткость */
    const onStep = (v) => [0, 0.5, -0.5].some((d) => {
      const q = (v - d) / step;
      return Math.abs(q - Math.round(q)) < 1e-6;
    });
    const moves = calls.filter((c) => c[0] === 'moveTo');
    const lines = calls.filter((c) => c[0] === 'lineTo');
    const widths = calls.filter((c) => c[0] === 'lineWidth');
    const colors = calls.filter((c) => c[0] === 'strokeStyle');
    return moves.length > 10 && lines.length === moves.length &&
      moves.every((c) => onStep(c[1]) && onStep(c[2])) &&
      widths.length === 1 && widths[0][1] === 1 &&
      colors.length === 1 && /^#[0-9a-f]{6}$/i.test(colors[0][1]) &&
      calls.filter((c) => c[0] === 'stroke').length === 1;
  });

  t('шаг клетки задан в единицах доски, а не экрана', () => {
    const stepAt = (scale) => IB.paint.cellStep({ scale, pan: { x: 0, y: 0 } });
    /* при увеличении клетка растёт вместе с рисунком */
    return stepAt(1) === 32 && stepAt(2) === 32 && stepAt(0.5) === 32;
  });
  t('клетка на экране растёт пропорционально зуму', () => {
    /* размер клетки в пикселях = шаг × масштаб: увеличили вдвое — клетка вдвое */
    const px = (scale) => IB.paint.cellStep({ scale, pan: { x: 0, y: 0 } }) * scale;
    const base = px(1);
    return Math.abs(px(2) - base * 2) < 1e-9 && Math.abs(px(4) - base * 4) < 1e-9 &&
      /* 0.5 — ещё не мелко, клетка честно уменьшается вдвое */
      Math.abs(px(0.5) - base / 2) < 1e-9;
  });
  t('сильно отдалённый холст всё ещё показывает читаемую клетку', () => {
    /* на совсем мелком масштабе клетка удваивается, иначе превращается в муть */
    const at = (scale) => {
      const step = IB.paint.cellStep({ scale, pan: { x: 0, y: 0 } });
      return { step, px: step * scale };
    };
    const small = at(0.05);
    const base = at(1);
    return small.px >= 14 && small.step % base.step === 0 && small.step > base.step;
  });
  t('шаг клетки не перестраивается во время зума', () => {
    /* раньше шаг подстраивался под экран и «прыгал» на ходу анимации */
    const scales = [0.6, 0.9, 1, 1.4, 2, 3.2];
    const steps = scales.map((s) => IB.paint.cellStep({ scale: s, pan: { x: 0, y: 0 } }));
    return steps.every((s) => s === steps[0]);
  });
  t('точки сетки, наоборот, держат экранный размер', () => {
    const at = (scale) => IB.paint.gridStep({ scale, pan: { x: 0, y: 0 } }) * scale;
    return at(1) > 0 && at(2) > 0 && at(0.5) > 0;
  });

  t('на ходу зума клетка тянется за рисунком, а не отстаёт', () => {
    const cellScale = (scale) => {
      const s = IB.paint.cellStep({ scale, pan: { x: 0, y: 0 } });
      return s * scale; /* клетка на экране, px */
    };
    const at1 = cellScale(1);
    const at2 = cellScale(2);
    const at4 = cellScale(4);
    return Math.abs(at2 / at1 - 2) < 1e-9 && Math.abs(at4 / at2 - 2) < 1e-9;
  });

  t('фон холста меняется: пусто / точки / клетка', () => {
    const canvas = document.getElementById('board');
    const scene = (showGrid, showCells) => ({
      store,
      view: st.view,
      selection: [],
      preview: null,
      marquee: null,
      eraser: null,
      eraserTargets: null,
      showGrid,
      showCells,
      hoveredId: null,
      singleSelection: false,
      showHandles: true,
      endpointHandles: null,
    });
    const surface = IB.paint.makeSurface(canvas);
    surface.resize();
    IB.paint.render(surface, scene(false, false));
    const blank = canvas.toDataURL();
    IB.paint.render(surface, scene(true, false));
    const dots = canvas.toDataURL();
    IB.paint.render(surface, scene(false, true));
    const cells = canvas.toDataURL();
    app.requestRender();
    return blank !== dots && dots !== cells && blank !== cells;
  });

  store.clear();

  /* перо */
  itc.setTool('pen');
  fire('pointerdown', 300, 300);
  fire('pointermove', 330, 320);
  fire('pointermove', 360, 340);
  fire('pointerup', 360, 340);
  t('перо создаёт штрих', () => store.items.length === 1 && store.items[0].type === 'stroke' && store.items[0].points.length >= 3);

  /* маркер */
  itc.setTool('highlighter');
  fire('pointerdown', 300, 380);
  fire('pointermove', 360, 380);
  fire('pointerup', 360, 380);
  t('маркер создаёт штрих повышенной прозрачности', () =>
    store.items.length === 2 && store.items[1].kind === 'highlighter' && store.items[1].width >= 12);

  /* прямоугольник */
  itc.setTool('rect');
  fire('pointerdown', 420, 300);
  fire('pointermove', 520, 380);
  fire('pointerup', 520, 380);
  t('прямоугольник создан', () => {
    const o = store.items[2];
    return !!o && o.type === 'shape' && o.shape === 'rect' && o.x2 > o.x1 && o.y2 > o.y1;
  });

  /* круг */
  itc.setTool('ellipse');
  fire('pointerdown', 420, 420);
  fire('pointermove', 500, 470);
  fire('pointerup', 500, 470);
  t('круг создан', () => store.items.length === 4 && store.items[3].shape === 'circle');

  /* линия со стрелкой */
  itc.setTool('arrow');
  fire('pointerdown', 560, 420);
  fire('pointermove', 640, 300);
  fire('pointerup', 640, 300);
  t('стрелка создана', () => store.items.length === 5 && store.items[4].shape === 'arrow');

  /* текст */
  itc.setTool('text');
  fire('pointerdown', 680, 200);
  const ta = overlay.querySelector('textarea');
  t('редактор текста открыт', () => !!ta);
  if (ta) {
    ta.value = 'Тестовый текст';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    itc.commitTextEdit();
  }
  t('текстовый объект сохранён', () => {
    const note = store.items.find((o) => o.type === 'text');
    return !!note && note.text === 'Тестовый текст' && note.h > 10;
  });

  itc.setTool('text');
  fire('pointerdown', 680, 520);
  const ta2 = overlay.querySelector('textarea');
  t('второй редактор текста открыт', () => !!ta2);
  if (ta2) {
    ta2.value = 'Обычный текст для проверки';
    ta2.dispatchEvent(new Event('input', { bubbles: true }));
    itc.commitTextEdit();
  }
  t('текстовый объект создан', () =>
    !!store.items.find((o) => o.type === 'text' && o.text === 'Обычный текст для проверки'));

  t('редактор закрыт после ввода', () => overlay.querySelector('textarea') === null);

  /* отмена правки текста */
  const textObj = store.items.find((o) => o.type === 'text' && o.text === 'Обычный текст для проверки');
  itc.startTextEdit(textObj);
  const ta3 = overlay.querySelector('textarea');
  if (ta3) {
    ta3.value = 'Черновик';
    ta3.dispatchEvent(new Event('input', { bubbles: true }));
    itc.cancelTextEdit();
  }
  t('отменённая правка не применяется', () => store.get(textObj.id).text === 'Обычный текст для проверки');

  /* правка существующего текста фиксируется в модели (регрессия: store.patch не применялся) */
  itc.startTextEdit(textObj);
  const ta4 = overlay.querySelector('textarea');
  if (ta4) {
    ta4.value = 'Покупки и дела';
    ta4.dispatchEvent(new Event('input', { bubbles: true }));
    itc.commitTextEdit();
  }
  t('правка существующего текста сохранена', () => store.get(textObj.id).text === 'Покупки и дела');
  t('история правки текста создана', () => store.historyState().undoLabel === 'Правка текста');
  store.undo();
  t('отмена возвращает текст', () => store.get(textObj.id).text === 'Обычный текст для проверки');
  store.redo();
  t('повтор применяет правку текста', () => store.get(textObj.id).text === 'Покупки и дела');

  /* Escape сохраняет набранный текст */
  itc.setTool('text');
  fire('pointerdown', 300, 600);
  const ta6 = overlay.querySelector('textarea');
  if (ta6) {
    ta6.value = 'Черновик';
    ta6.dispatchEvent(new Event('input', { bubbles: true }));
    ta6.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
  t('Escape сохраняет текст', () => {
    const texts = store.items.filter((o) => o.type === 'text');
    return !!texts.find((o) => o.text === 'Черновик') && overlay.querySelector('textarea') === null;
  });

  /* смена инструмента фиксирует редактор */
  itc.setTool('text');
  fire('pointerdown', 620, 600);
  const ta7 = overlay.querySelector('textarea');
  if (ta7) {
    ta7.value = 'Перед сменой инструмента';
    ta7.dispatchEvent(new Event('input', { bubbles: true }));
  }
  itc.setTool('select');
  t('смена инструмента сохраняет текст', () =>
    !!store.items.find((o) => o.text === 'Перед сменой инструмента') && !itc.isEditing());

  /* регрессия: текст должен не только попасть в модель, но и рисоваться на холсте
     (ранее paintText брал box.ascent, которого не было в textBox → координата y = NaN
      и fillText не рисовал ничего: текст «исчезал» после смены инструмента) */
  t('зафиксированный текст рисуется на холсте', () => {
    const note = store.items.find((o) => o.text === 'Перед сменой инструмента');
    if (!note) return 'текст не найден в модели';
    const box = IB.model.textBox(note);
    if (!box || !Number.isFinite(box.ascent) || box.ascent <= 0) return 'у textBox нет ascent: ' + (box && box.ascent);
    const bounds = IB.model.boundsOf(note);
    const scene = {
      store, view: st.view, selection: [], preview: null, marquee: null,
      eraser: null, eraserTargets: null, showGrid: false, showCells: false, hoveredId: null,
      singleSelection: false, showHandles: true, endpointHandles: null,
    };
    const surface = IB.paint.makeSurface(canvas);
    surface.resize();
    const saved = store.items.slice();
    store.items.length = 0;
    IB.paint.render(surface, scene);
    const blank = canvas.toDataURL();
    store.items.push(note);
    IB.paint.render(surface, scene);
    const withText = canvas.toDataURL();
    store.items.length = 0;
    for (const o of saved) store.items.push(o);
    app.requestRender();
    return blank !== withText;
  });
  t('textBox отдаёт ascent для базовой линии', () => {
    const note = store.items.find((o) => o.text === 'Перед сменой инструмента');
    if (!note) return true;
    const box = IB.model.textBox(note);
    return box.ascent > 0 && box.lineHeight > box.ascent;
  });

  /* patch применяет произвольные свойства (цвет) */
  const colored = store.get(textObj.id);
  store.patch([{ id: colored.id, before: { color: colored.color }, after: { color: '#e81123' } }], 'Цвет');
  t('patch меняет цвет текста', () => store.get(textObj.id).color === '#e81123');
  store.undo();
  t('отмена patch возвращает цвет', () => store.get(textObj.id).color === colored.color);

  /* липкие заметки из старых файлов не открываются — проверка в конце (сбросит доску) */

  /* выделение и перемещение */
  itc.setTool('select');
  const stroke = store.items[0];
  st.selection = [stroke.id];
  const p0 = { ...stroke.points[0] };
  const s0 = toScreen(p0);
  fire('pointerdown', s0.x, s0.y);
  fire('pointermove', s0.x + 60, s0.y + 40);
  fire('pointerup', s0.x + 60, s0.y + 40);
  t('штрих перемещается указателем', () => {
    const p = store.items[0].points[0];
    return Math.abs(p.x - p0.x) > 20 && Math.abs(p.y - p0.y) > 10;
  }, () => `tool=${st.tool} sel=${st.selection.join(',')} id=${stroke.id} item0=${store.items[0].id} type=${store.items[0].type} dx=${store.items[0].points[0].x - p0.x} dy=${store.items[0].points[0].y - p0.y} всего=${store.items.length} scale=${st.view.scale} zoomFit=${app.commands.zoomFit}`);
  store.undo();
  t('отмена возвращает штрих на место', () => {
    const p = store.items[0].points[0];
    return Math.abs(p.x - p0.x) < 0.001 && Math.abs(p.y - p0.y) < 0.001;
  });
  store.redo();
  t('повтор возвращает штрих на новое место', () => Math.abs(store.items[0].points[0].x - p0.x) > 20);

  /* маркерная рамка выделяет всё */
  const total = store.items.length;
  st.selection = [];
  fire('pointerdown', 1100, 700);
  fire('pointermove', 200, 120);
  fire('pointerup', 200, 120);
  t('рамка выделяет объекты', () => st.selection.length === total);

  /* масштабирование текста за хэндл */
  const note = store.items.find((o) => o.type === 'text' && o.text === 'Тестовый текст');
  st.selection = [note.id];
  const font0 = store.get(note.id).fontSize;
  const b = IB.model.boundsOf(note);
  const corner = toScreen({ x: b.x + b.w, y: b.y + b.h });
  fire('pointerdown', corner.x, corner.y);
  fire('pointermove', corner.x + 40, corner.y + 40);
  fire('pointerup', corner.x + 40, corner.y + 40);
  t('размер текста меняется за хэндл', () => store.get(note.id).fontSize > font0 + 1);
  store.undo();
  t('отмена возвращает размер текста', () => Math.abs(store.get(note.id).fontSize - font0) < 0.001);
  store.redo();

  /* ластик: контур режется по кругу, текст и заливки уходят целиком,
     выделение не меняется */
  itc.setTool('eraser');
  t('ластик не рисует рамки вокруг объектов', () => !('eraserTargets' in st));

  /* размеры инструментов в меню: пятно должно быть круглым, а не полоской,
     и расти вместе с номером размера */
  const dotsAreRoundAndGrow = (list) => {
    /* размеры кнопки берём из стилей: блок может быть скрыт (ширина 0),
       а проверять само пятно это не мешает */
    for (const b of list) {
      const dot = getComputedStyle(b, '::after');
      const btnW = parseFloat(getComputedStyle(b).width);
      const btnH = parseFloat(getComputedStyle(b).height);
      /* круг: ширина равна высоте, радиус — половина стороны,
         иначе это скруглённый квадрат, а не круг */
      const w = parseFloat(dot.width);
      const h = parseFloat(dot.height);
      if (!(w > 0) || Math.abs(w - h) > 0.5) return `размер ${b.dataset.w}: ${w}x${h}`;
      const r = dot.borderTopLeftRadius;
      const radius = r.endsWith('%') ? (parseFloat(r) / 100) * w : parseFloat(r);
      if (Math.abs(radius - w / 2) > 0.5) return `радиус ${b.dataset.w}: ${r} при ширине ${w}`;
      /* пятно помещается в кнопку */
      if (w > btnW - 4 || h > btnH - 2) return `пятно ${b.dataset.w} не влезло в кнопку ${btnW}x${btnH}`;
    }
    /* чем больше номер размера, тем крупнее пятно */
    const widths = list.map((b) => parseFloat(getComputedStyle(b, '::after').width));
    for (let i = 1; i < widths.length; i += 1) {
      if (!(widths[i] > widths[i - 1])) return `размер ${list[i].dataset.w} не крупнее предыдущего`;
    }
    return true;
  };

  /* размеры пера и маркера */
  const inkSizes = Array.from(document.querySelectorAll('#thickness .th'));
  t('у пера и маркера пять размеров', () => inkSizes.length === 5);
  t('размеры пера и маркера — 2, 4, 8, 14 и 24', () =>
    inkSizes.map((b) => Number(b.dataset.w)).join(',') === '2,4,8,14,24');
  t('размеры пера и маркера показаны круглыми пятнами', () => dotsAreRoundAndGrow(inkSizes));
  t('блок толщины виден и у пера, и у маркера', () => {
    const block = document.querySelector('#thickness').closest('.insp-block');
    const shows = (tool) => {
      itc.setTool(tool);
      return block.classList.contains('visible');
    };
    const res = ['pen', 'highlighter', 'rect', 'ellipse', 'triangle', 'solid', 'line', 'arrow', 'ruler', 'protractor'].map(shows);
    itc.setTool('pen');
    return res.every(Boolean);
  });
  t('клик по размеру пера меняет толщину штриха', () => {
    itc.setTool('pen');
    const btn = document.querySelector('#thickness .th[data-w="24"]');
    btn.click();
    const wide = st.width;
    const active = btn.classList.contains('active');
    document.querySelector('#thickness .th[data-w="4"]').click();
    const narrow = st.width;
    return wide === 24 && narrow === 4 && active;
  });

  /* в меню ластика осталась только кнопка очистки */
  t('у ластика есть кнопка «Очистить доску»', () => {
    const b = document.querySelector('[data-cmd="clearBoard"]');
    const block = b && b.closest('.insp-block');
    return !!b && b.textContent.trim() === 'Очистить доску' &&
      block && block.dataset.for === 'eraser';
  });
  t('у ластика слайдер круга без режима роста', () => {
    const block = document.querySelector('[data-cmd="clearBoard"]').closest('.insp-block');
    const toggle = block.querySelector('[data-cmd="toggleAdaptiveEraser"]');
    const slider = block.querySelector('#eraserSlider');
    return !!slider && slider.type === 'range' &&
      block.querySelectorAll('.th').length === 0 &&
      toggle === null && !document.getElementById('btnAdaptiveEraser') &&
      block.querySelectorAll('.mini-actions button').length === 1;
  });
  t('в блоке ластика нет палитр и прочих настроек', () => {
    const block = document.querySelector('[data-cmd="clearBoard"]').closest('.insp-block');
    const stray = block.querySelectorAll('.swatches, .fill-row, .thickness, .insp-size, select, .align-grid');
    const kids = Array.from(block.children)
      .map((n) => n.className)
      .filter((c) => c !== 'insp-hint');
    return stray.length === 0 && kids.every((c) => /insp-title|mini-actions|eraser-size/.test(c));
  });
  t('кнопка очистки видна только у ластика', () => {
    const block = document.querySelector('[data-cmd="clearBoard"]').closest('.insp-block');
    itc.setTool('eraser');
    const withEraser = block.classList.contains('visible');
    itc.setTool('pen');
    const withPen = block.classList.contains('visible');
    itc.setTool('eraser');
    return withEraser && !withPen;
  });
  itc.setTool('eraser');
  t('слайдер ластика меняет размер круга', () => {
    const slider = document.getElementById('eraserSlider');
    slider.value = '40';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    const shown = document.getElementById('eraserSizeValue').textContent;
    const saved = IB.persist.loadPrefs().eraserWidth;
    return st.eraserWidth === 40 && shown === '40' && saved === 40 ? true
      : `width=${st.eraserWidth} shown=${shown} saved=${saved}`;
  });
  t('круг ластика растёт вместе со слайдером', () => {
    /* радиус — экранные пиксели: половина диаметра из слайдера,
       без привязки к масштабу холста */
    const sp = toScreen({ x: 0, y: 0 });
    fire('pointermove', sp.x, sp.y);
    const want = st.eraserWidth / 2;
    return Math.abs(st.eraserRadius - want) < 1e-9 && st.eraserRadius > 24 / 2
      ? true : `radius=${st.eraserRadius} want=${want}`;
  });
  t('слайдер ластика не выходит за пределы', () => {
    app.setEraserWidth(1000);
    const big = st.eraserWidth;
    app.setEraserWidth(1);
    const small = st.eraserWidth;
    const slider = document.getElementById('eraserSlider');
    const shown = document.getElementById('eraserSizeValue').textContent;
    return big === 160 && small === 8 && slider.value === '8' && shown === '8'
      ? true : `big=${big} small=${small} shown=${shown}`;
  });
  t('курсор ластика — полупрозрачный круг без крестика', () => {
    const board = document.getElementById('board');
    const eraser = getComputedStyle(board).cursor;
    itc.setTool('pen');
    const pen = getComputedStyle(board).cursor;
    itc.setTool('eraser');
    return eraser === 'none' && pen === 'crosshair' ? true : `eraser=${eraser} pen=${pen}`;
  });
  t('круг ластика не привязан к масштабу холста', () => {
    /* экранный диаметр из слайдера постоянен при любом зуме: zoom-out
       не прячет круг, а pointermove после зума не должен вернуть ×scale */
    app.setEraserWidth(40);
    const scale0 = st.view.scale;
    itc.zoomAt({ x: 320, y: 240 }, 2);
    const h = toScreen({ x: 0, y: 0 });
    fire('pointermove', h.x, h.y);
    const atZoom = st.view.scale === scale0 * 2
      && st.eraserRadius === st.eraserWidth / 2;
    itc.zoomAt({ x: 320, y: 240 }, scale0 / st.view.scale);
    const restored = Math.abs(st.view.scale - scale0) < 1e-9
      && st.eraserRadius === st.eraserWidth / 2;
    return atZoom && restored ? true
      : `scale=${st.view.scale} radius=${st.eraserRadius} want=${st.eraserWidth / 2}`;
  });
  t('при зуме ластик стирает ровно по нарисованному кругу', () => {
    /* 20 экранных пикселей при scale=2 → радиус 10 единиц доски: нарезка
       обязана совпасть с кругом, иначе рисуем одно — стираем другое */
    app.setEraserWidth(40);
    const scale0 = st.view.scale;
    itc.zoomAt({ x: 320, y: 240 }, 2);
    const w = IB.geom.toWorld({ x: 320, y: 240 }, st.view);
    const row = { x: w.x, y: w.y + 77 };
    itc.setTool('pen');
    const start = toScreen({ x: row.x - 40, y: row.y });
    fire('pointerdown', start.x, start.y);
    for (let i = -39; i <= 40; i++) {
      const s = toScreen({ x: row.x + i, y: row.y });
      fire('pointermove', s.x, s.y);
    }
    const end = toScreen({ x: row.x + 40, y: row.y });
    fire('pointerup', end.x, end.y);
    itc.setTool('eraser');
    const hit = toScreen(row);
    fire('pointerdown', hit.x, hit.y);
    fire('pointermove', hit.x, hit.y + 2);
    fire('pointerup', hit.x, hit.y + 2);
    const pieces = store.items.filter((o) => o.type === 'stroke'
      && o.points.some((p) => Math.abs(p.y - row.y) < 1e-9
        && Math.abs(p.x - row.x) <= 40.001));
    const xs = pieces.flatMap((p) => p.points.map((q) => Math.abs(q.x - row.x)));
    const minDx = xs.length ? Math.min(...xs) : NaN;
    itc.zoomAt({ x: 320, y: 240 }, scale0 / st.view.scale);
    return pieces.length >= 1 && minDx >= 9.5 && minDx <= 11.5
      && xs.some((d) => d > 30)
      ? true : `pieces=${pieces.length} minDx=${minDx} n=${xs.length}`;
  });
  st.eraserWidth = 60;
  const beforeShapeErase = store.items.length;
  const victim = store.items.find((o) => o.type === 'shape'
    && (o.shape === 'ellipse' || o.shape === 'circle'));
  const selBefore = st.selection.slice();
  const victimBounds = IB.model.boundsOf(victim);
  /* кликаем по верхней точке контура: в центре касание не задевает контур */
  const vcx = (victim.x1 + victim.x2) / 2;
  const vp = toScreen({ x: vcx, y: victim.y1 });
  fire('pointerdown', vp.x, vp.y);
  t('ластик сразу режет контур круга при нажатии', () => store.get(victim.id) === null);
  fire('pointermove', vp.x + 2, vp.y + 2);
  fire('pointerup', vp.x + 2, vp.y + 2);
  t('от круга остались обломки контура внутри его же рамки', () => {
    /* круг пустой: ластик коснулся верхней точки контура — сверху разрыв */
    const arcs = store.items.filter((o) => o.type === 'stroke' &&
      o.points.length > 1 &&
      o.points.every((p) => p.x >= victimBounds.x - 1 && p.x <= victimBounds.x + victimBounds.w + 1 &&
        p.y >= victimBounds.y - 1 && p.y <= victimBounds.y + victimBounds.h + 1));
    return arcs.length >= 1 && store.items.length === beforeShapeErase + arcs.length - 1
      ? true : `обломков=${arcs.length} было=${beforeShapeErase} стало=${store.items.length}`;
  });
  t('ластик стёр только контур круга', () => {
    const others = store.items.filter((o) => o.type !== 'stroke');
    return others.length >= 1 && others.every((o) => o.id !== victim.id);
  });
  t('ластик не меняет выделение', () => JSON.stringify(st.selection) === JSON.stringify(selBefore));
  itc.setTool('select');

  /* история */
  const afterErase = store.items.length;
  app.commands.undo();
  t('отмена возвращает стёртый объект', () => store.get(victim.id) !== null);
  app.commands.redo();
  t('повтор снова удаляет', () => store.get(victim.id) === null && store.items.length === afterErase);
  app.commands.undo();
  t('цепочка истории согласована', () => store.items.length === beforeShapeErase);

  while (!store.isEmpty() && store.historyState().canUndo) app.commands.undo();
  t('полная отмена очищает доску', () => store.isEmpty());
  while (store.historyState().canRedo) app.commands.redo();
  t('полный повтор возвращает доску к состоянию после стирания', () =>
    store.items.length === afterErase
      ? true
      : `стало ${store.items.length}, ожидалось ${afterErase}; типы=${store.items.map((o) => o.type).join(',')}; undo=${JSON.stringify(store.historyState())}`);

  /* сохранение / загрузка */
  t('сериализация и разбор совпадают', () => {
    const parsed = IB.persist.fromText(IB.persist.toText(store, st.view));
    return parsed.items.length === store.items.length &&
      JSON.stringify(parsed.viewport.scale) === JSON.stringify(st.view.scale);
  });

  /* название доски: двойной клик по «Новая доска» */
  const nameEl = document.getElementById('fileName');
  const nameInput = document.getElementById('fileRename');
  const type = (input, value, key) => {
    input.value = value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  };
  t('в шапке есть название доски и скрытое поле', () =>
    nameEl.id === 'fileName' && nameEl.textContent.trim() === 'Новая доска' &&
    nameInput && nameInput.hidden && nameInput.tagName === 'INPUT');
  t('одиночный клик по названию ничего не делает', () => {
    st.title = null;
    st.file = null;
    app.renameBoard('');
    nameEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return nameInput.hidden && nameEl.hidden === false && nameEl.textContent === 'Новая доска';
  });
  t('двойной клик открывает поле ввода', () => {
    nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return !nameInput.hidden && nameEl.hidden && nameInput.value === 'Новая доска' &&
      document.activeElement === nameInput;
  });
  t('Enter сохраняет новое название', () => {
    type(nameInput, 'Планёрка', 'Enter');
    const ok = nameInput.hidden && nameEl.hidden === false &&
      nameEl.textContent === 'Планёрка' && st.title === 'Планёрка' && app.fileLabel() === 'Планёрка';
    return ok ? true
      : `hidden=${nameInput.hidden} el.hidden=${nameEl.hidden} text=${nameEl.textContent} title=${st.title}`;
  });
  t('переименование отмечает доску как изменённую', () => st.dirty === true);
  t('поле ввода не оставляет после себя мусора', () =>
    nameInput.hidden && !document.querySelector('#fileName + input:not([hidden])'));
  t('двойной клик снова открывает поле с текущим названием', () => {
    nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return !nameInput.hidden && nameInput.value === 'Планёрка';
  });
  t('введённое значение редактируется перед Enter', () => {
    nameInput.value = 'Планёрка на среду';
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return st.title === 'Планёрка на среду' && nameEl.textContent === 'Планёрка на среду';
  });
  t('Escape отменяет переименование', () => {
    nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    nameInput.value = 'не сохранится';
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return nameInput.hidden && st.title === 'Планёрка на среду' &&
      nameEl.textContent === 'Планёрка на среду';
  });
  t('уход курсора из поля сохраняет название', () => {
    nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    nameInput.value = 'Заметки по доске';
    nameInput.dispatchEvent(new Event('blur'));
    return st.title === 'Заметки по доске' && nameEl.textContent === 'Заметки по доске';
  });
  t('пустое название возвращает имя файла', () => {
    st.file = 'C:\\docs\\план.doc';
    nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    nameInput.value = '   ';
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return st.title === null && app.fileLabel() === 'план.doc' && nameEl.textContent === 'план.doc';
  });
  t('слишком длинное название обрезается', () => {
    app.renameBoard('а'.repeat(300));
    return st.title.length === 120 && nameEl.textContent === 'а'.repeat(120);
  });
  t('название доски сохраняется в файле и читается обратно', () => {
    const parsed = IB.persist.fromText(IB.persist.toText(store, st.view, st.title));
    return parsed.title === st.title &&
      JSON.parse(IB.persist.toText(store, st.view, st.title)).title === st.title;
  });
  t('в файле без названия оно не появляется', () => {
    const json = JSON.parse(IB.persist.toText(store, st.view, ''));
    return json.title === null && IB.persist.fromText(JSON.stringify({ items: [] })).title === null;
  });
  t('название доски не ломает старый формат файла', () => {
    const legacy = { format: 'inkboard-board', version: 1, items: [] };
    const parsed = IB.persist.fromText(JSON.stringify(legacy));
    return parsed.items.length === 0 && parsed.title === null;
  });

  /* «Не сохранять» при закрытии: автосохранение обязано исчезнуть, иначе
     следующий запуск снова откроет эту же доску */
  t('автосохранение восстанавливает доску после перезапуска', () => {
    IB.persist.clearAutosave();
    IB.persist.scheduleAutosave(store, st.view, st.title);
    return new Promise((resolve) => {
      setTimeout(() => {
        const raw = window.localStorage.getItem('inkboard.autosave.v1');
        if (!raw) return resolve('автосохранение не записалось');
        const parsed = IB.persist.fromText(raw);
        resolve(parsed.items.length > 0 ? true : 'в автосохранении пусто');
      }, 1400);
    });
  });
  t('«Не сохранять» сносит автосохранение и снимает метку изменений', () => {
    st.dirty = true;
    const done = app.discardChanges();
    if (done !== true) return 'discardChanges вернул не true';
    return window.localStorage.getItem('inkboard.autosave.v1') === null && st.dirty === false
      ? true
      : 'автосохранение осталось в localStorage';
  });
  t('после «Не сохранять» автосохранение не восстанавливается', () =>
    IB.persist.readAutosave() === null ? true : 'доска всё ещё восстанавливается');
  t('показ окна закрытия не трогает автосохранение', () => {
    /* сама функция запроса сохранения не должна сносить автосохранение:
       иначе несохранённая доска потерялась бы при отмене закрытия */
    IB.persist.scheduleAutosave(store, st.view, null);
    return new Promise((resolve) => {
      setTimeout(() => {
        const has = window.localStorage.getItem('inkboard.autosave.v1') !== null;
        IB.persist.clearAutosave();
        resolve(has ? true : 'автосохранение пропало зря');
      }, 1400);
    });
  });
  st.title = null;
  st.file = null;
  st.dirty = false;
  nameEl.textContent = 'Новая доска';

  /* попадание и границы */
  t('попадание по штриху', () => {
    const s = store.items.find((o) => o.type === 'stroke');
    const mid = s.points[Math.floor(s.points.length / 2)];
    return !!IB.hit.hitTest(store, mid, 8);
  });
  t('объединение границ', () => {
    const r = store.bounds(store.items.map((o) => o.id));
    return r && r.w > 100 && r.h > 50;
  });

  /* наконечник стрелки: острый, не обрезанный круглой шапкой стержня */
  const solo = (obj) => {
    obj.id = obj.id || 'solo';
    const r = IB.geom.inflate(IB.geom.rectFromPoints(
      { x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 }
    ), IB.model.arrowHeadLength(obj.width) + 6);
    const pad = 8;
    const c = IB.paint.renderToCanvas({ items: [obj] }, r, { scale: 1, padding: pad });
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    /* фон непрозрачно-белый, поэтому ищем тёмные пиксели, а не alpha */
    const ink = (px, py) => {
      if (px < 0 || py < 0 || px >= c.width || py >= c.height) return false;
      const i = (py * c.width + px) * 4;
      return d[i] < 128 && d[i + 1] < 128 && d[i + 2] < 128;
    };
    /* renderToCanvas: deviceX = worldX - r.x + pad, значит worldX = px + r.x - pad */
    return { r, c, d, ink, sx: r.x - pad, sy: r.y - pad };
  };
  const arrowOf = (x1, y1, x2, y2) => ({
    x1, y1, x2, y2, width: 4, color: '#000000', shape: 'arrow', type: 'shape',
  });

  t('вершина стрелки совпадает с её концом', () => {
    const a = arrowOf(100, 300, 400, 120);
    const { c, ink, sx, sy } = solo(a);
    const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const tipAlong = (a.x2 - a.x1) * ux + (a.y2 - a.y1) * uy;
    let best = -Infinity;
    let opaque = 0;
    for (let py = 0; py < c.height; py++) {
      for (let px = 0; px < c.width; px++) {
        if (!ink(px, py)) continue;
        opaque++;
        const wx = px + sx;
        const wy = py + sy;
        best = Math.max(best, (wx - a.x1) * ux + (wy - a.y1) * uy);
      }
    }
    if (!opaque) return 'стрелка не отрисовалась';
    /* остриё должно упираться в x2/y2: круглая шапка дала бы вылет в 1-3 px */
    const over = best - tipAlong;
    return over <= 1.5 && over >= -3
      ? true
      : `вылет за остриё ${over.toFixed(2)}px`;
  });

  t('острота наконечника: у вершины пикселей не толще, чем у основания', () => {
    const a = arrowOf(100, 300, 400, 120);
    const { ink, sx, sy } = solo(a);
    const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    /* поперечная ширина заливки на расстоянии от вершины и у основания головки */
    const crossWidth = (dist) => {
      let min = Infinity;
      let max = -Infinity;
      for (let k = -60; k <= 60; k += 0.25) {
        const px = a.x2 - ux * dist - uy * k;
        const py = a.y2 - uy * dist + ux * k;
        /* здесь идём от мира к пикселю, поэтому смещение вычитаем */
        const ix = Math.round(px - sx);
        const iy = Math.round(py - sy);
        if (ink(ix, iy)) {
          if (k < min) min = k;
          if (k > max) max = k;
        }
      }
      return max < min ? 0 : max - min;
    };
    /* 1.5px от вершины: у острия заливка заметно уже, чем у основания головки.
       С круглой шапкой стержня здесь была бы полная толщина линии. */
    const atTip = crossWidth(1.5);
    const atBase = crossWidth(IB.model.arrowHeadLength(a.width) * 0.6);
    return atBase > 4 && atTip < atBase * 0.4
      ? true
      : `у вершины ${atTip.toFixed(1)}px, у основания ${atBase.toFixed(1)}px`;
  });

  t('попадание по широкой части наконечника работает', () => {
    const a = arrowOf(0, 0, 300, 0);
    const headLen = IB.model.arrowHeadLength(4);
    const target = { items: [a] };
    const midHead = { x: 300 - headLen * 0.7, y: headLen * 0.38 };
    const shaft = { x: 150, y: 2 };
    const far = { x: 150, y: 40 };
    const hitsHead = !!IB.hit.hitTest(target, midHead, 6);
    const hitsShaft = !!IB.hit.hitTest(target, shaft, 6);
    const misses = !!IB.hit.hitTest(target, far, 6);
    return hitsHead && hitsShaft && !misses
      ? true
      : `головка=${hitsHead} стержень=${hitsShaft} промах=${misses}`;
  });

  t('очень короткая стрелка не ломает наконечник', () => {
    const a = arrowOf(0, 0, 6, 0);
    const { c, ink } = solo(a);
    let opaque = 0;
    for (let py = 0; py < c.height; py++) for (let px = 0; px < c.width; px++) if (ink(px, py)) opaque++;
    return opaque > 0 ? true : 'короткая стрелка не отрисовалась';
  });

  t('вырожденная стрелка в одну точку не бросает исключение', () => {
    const a = arrowOf(10, 10, 10, 10);
    const { c, ink } = solo(a);
    let opaque = 0;
    for (let py = 0; py < c.height; py++) for (let px = 0; px < c.width; px++) if (ink(px, py)) opaque++;
    return opaque > 0 ? true : 'точка не отрисовалась';
  });

  t('линия без наконечника остаётся прямой до самого конца', () => {
    const l = { x1: 0, y1: 0, x2: 200, y2: 0, width: 4, color: '#000000', shape: 'line', type: 'shape' };
    const { c, ink, sx } = solo(l);
    let opaque = 0;
    let maxX = -Infinity;
    for (let py = 0; py < c.height; py++) {
      for (let px = 0; px < c.width; px++) {
        if (!ink(px, py)) continue;
        opaque++;
        maxX = Math.max(maxX, px + sx);
      }
    }
    if (!opaque) return 'линия не отрисовалась';
    return Math.abs(maxX - 200) <= 3 ? true : `конец линии на ${maxX}, ожидалось 200`;
  });

  /* экспорт PNG */
  t('рендер доски в PNG', () => {
    const r = store.bounds(store.items.map((o) => o.id));
    const c = IB.paint.renderToCanvas(store, r, { scale: 1, padding: 8 });
    return c.width > 50 && c.toDataURL('image/png').indexOf('data:image/png') === 0;
  });

  /* масштаб и панорамирование: зум анимируется, поэтому ждём его конца */
  const waitZoom = async () => {
    for (let i = 0; i < 90; i++) {
      if (!itc.isZooming()) return;
      await new Promise((r) => setTimeout(r, 16));
    }
  };
  const s0scale = st.view.scale;
  await t('zoomIn увеличивает масштаб', async () => {
    app.commands.zoomIn();
    await waitZoom();
    return st.view.scale > s0scale;
  });
  await t('zoomOut возвращает масштаб', async () => {
    app.commands.zoomOut();
    await waitZoom();
    return Math.abs(st.view.scale - s0scale) < 0.0001;
  });
  app.commands.zoomFit();
  t('zoomFit вписывает доску', () => st.view.scale > 0.05 && st.view.scale <= 1.5);

  /* панно пробелом */
  const pan0 = { ...st.view.pan };
  itc.setSpace(true);
  fire('pointerdown', 600, 400, { button: 0 });
  fire('pointermove', 660, 460);
  fire('pointerup', 660, 460);
  itc.setSpace(false);
  t('перемещение холста меняет панораму', () => Math.abs(st.view.pan.x - pan0.x) > 30);

  /* зум колёсиком: анимация едет кадрами, поэтому ждём её окончания */
  const wheel = (opts) => canvas.dispatchEvent(new WheelEvent('wheel', {
    clientX: 640, clientY: 400, bubbles: true, cancelable: true, ...opts,
  }));
  /* ждём, пока зум доедет до цели (или пройдёт 1.5 с) */
  const settle = async () => {
    for (let i = 0; i < 90; i++) {
      if (!itc.isZooming()) return;
      await new Promise((r) => setTimeout(r, 16));
    }
  };

  await t('Ctrl + колёсико масштабирует', async () => {
    const s1 = st.view.scale;
    wheel({ deltaY: -240, ctrlKey: true });
    await settle();
    return st.view.scale > s1;
  });

  await t('колёсико без Ctrl масштабирует', async () => {
    /* уменьшаем заранее: после предыдущего зума масштаб уперся в потолок (8),
       и расти ему больше некуда — проверка была бы бессмысленной */
    wheel({ deltaY: 240 });
    await settle();
    const s2 = st.view.scale;
    wheel({ deltaY: -240 });
    await settle();
    return st.view.scale > s2;
  });

  await t('колёсико вниз уменьшает масштаб', async () => {
    const s3 = st.view.scale;
    wheel({ deltaY: 240 });
    await settle();
    return st.view.scale < s3;
  });

  await t('колёсико по строкам тоже масштабирует', async () => {
    const s4 = st.view.scale;
    wheel({ deltaY: -240, deltaMode: 1 });
    await settle();
    return st.view.scale > s4;
  });

  /* зум плавный: масштаб растёт по кадрам, а не сразу до цели */
  await t('масштаб меняется не скачком, а постепенно', async () => {
    /* предыдущие щелчки довели масштаб до потолка (8): там ему расти некуда,
       и «плавность» нечего измерять */
    app.commands.zoomReset();
    await settle();
    const before = st.view.scale;
    /* шаг 0.6: цель 1.82× остаётся в пределах потолка (8) */
    wheel({ deltaY: -60 });
    const moving = itc.isZooming();
    /* один кадр — уже движение, но ещё не финал */
    await new Promise((r) => setTimeout(r, 30));
    const midway = st.view.scale;
    await settle();
    const after = st.view.scale;
    const target = before * Math.exp(0.6);
    return moving && midway > before && midway < target - 1e-6 && after > midway &&
      Math.abs(after - target) < 1e-6;
  });

  await t('во время зума зум живой ровно в одном экземпляре', async () => {
    /* кадры просит и rAF, и таймер (нужен для скрытого окна). Если очередь
       не одна, каждый таймер заводит свой следующий, шаги множатся и зум
       дёргается вместо плавного хода */
    app.commands.zoomReset();
    await settle();
    const before = st.view.scale;
    /* шаг 0.9: цель 2.46×, потолок 8 не мешает */
    wheel({ deltaY: -90 });
    const samples = [];
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 24));
      samples.push(st.view.scale);
    }
    await settle();
    const target = before * Math.exp(0.9);
    /* каждый замер не меньше предыдущего: откатов назад не бывает */
    const mono = samples.every((s, i) => i === 0 || s >= samples[i - 1] - 1e-9);
    /* масштаб двигался не один раз, а на каждом замере */
    const moved = samples.filter((s) => s > before + 1e-9).length;
    return mono && moved >= 5 && st.view.scale >= samples[samples.length - 1] &&
      Math.abs(st.view.scale - target) < 1e-6
      ? true
      : `mono=${mono} moved=${moved} s=${samples.map((s) => s.toFixed(3)).join(',')} target=${target}`;
  });

  await t('зум одного жеста не дублируется кадрами', async () => {
    /* считаем, сколько раз доска перерисовалась за один щелчок: шагов должно
       быть столько, сколько кадров анимации, а не в разы больше */
    app.commands.zoomReset();
    await settle();
    const real = window.requestAnimationFrame;
    const realTimeout = window.setTimeout;
    let frames = 0;
    window.requestAnimationFrame = (fn) => real.call(window, (...a) => { frames += 1; return fn(...a); });
    window.setTimeout = (fn, ms, ...a) => realTimeout.call(window, fn, ms, ...a);
    wheel({ deltaY: -120 });
    await settle();
    window.requestAnimationFrame = real;
    window.setTimeout = realTimeout;
    /* анимация длится ~300 мс: это примерно 18 кадров при 60 Гц,
       40 — уже перебор, значит очередь кадров размножилась */
    return frames >= 2 && frames <= 40 ? true : `кадров: ${frames}`;
  });

  await t('точка под курсором остаётся на месте при зуме', async () => {
    /* точка считается в координатах холста: у страницы есть верхняя
       шапка, поэтому координаты события на 52px больше координат холста */
    const rect = canvas.getBoundingClientRect();
    const at = { x: 640 - rect.left, y: 400 - rect.top };
    const anchorBefore = IB.geom.toWorld(at, st.view);
    wheel({ deltaY: -120 });
    await settle();
    const anchorAfter = IB.geom.toWorld(at, st.view);
    const dx = Math.abs(anchorBefore.x - anchorAfter.x);
    const dy = Math.abs(anchorBefore.y - anchorAfter.y);
    return dx < 0.5 && dy < 0.5 ? true : `dx=${dx} dy=${dy}`;
  });

  await t('зум доезжает ровно до целевого масштаба', async () => {
    const target = st.view.scale * Math.exp(-2.4);
    wheel({ deltaY: 240 });
    await settle();
    return Math.abs(st.view.scale - target) < 1e-6;
  });

  await t('Shift + колёсико двигает холст вбок, не масштаб', async () => {
    const pan0wheel = { ...st.view.pan };
    const s5 = st.view.scale;
    wheel({ deltaY: -240, shiftKey: true });
    await settle();
    return st.view.pan.x !== pan0wheel.x && Math.abs(st.view.scale - s5) < 1e-9;
  });

  await t('горизонтальная прокрутка тачпада двигает холст', async () => {
    const pan0wheel2 = { ...st.view.pan };
    const s6 = st.view.scale;
    wheel({ deltaX: 120, deltaY: 0 });
    await settle();
    return st.view.pan.x !== pan0wheel2.x && Math.abs(st.view.scale - s6) < 1e-9;
  });

  await t('быстрые щелчки колеса суммируются в один зум', async () => {
    /* мелкий шаг, иначе цель упрётся в потолок масштаба (8) */
    const before = st.view.scale;
    for (let i = 0; i < 5; i++) wheel({ deltaY: -40 });
    await settle();
    /* пять щелчков по 0.4 дают ровно суммарный зум exp(2) */
    return Math.abs(st.view.scale - before * Math.exp(2)) < 1e-6;
  });

  await t('Ctrl + плюс и минус тоже едут плавно', async () => {
    const before = st.view.scale;
    app.commands.zoomIn();
    const moving = itc.isZooming();
    await new Promise((r) => setTimeout(r, 30));
    const midway = st.view.scale;
    await settle();
    return moving && midway > before && Math.abs(st.view.scale - before * 1.2) < 1e-6;
  });

  await t('Ctrl + 0 возвращает 100 %', async () => {
    app.commands.zoomReset();
    await settle();
    return Math.abs(st.view.scale - 1) < 1e-9;
  });

  /* буфер обмена */
  app.commands.selectAll();
  const clipboardCount = st.selection.length;
  itc.copySelection(false);
  t('копирование в буфер', () => !!st.clipboard && st.clipboard.items.length === clipboardCount);
  itc.deleteSelection();
  t('удаление выделенного', () => store.isEmpty());
  const imported = itc.importItems(st.clipboard.items);
  t('вставка из буфера восстанавливает объекты', () =>
    imported === clipboardCount && store.items.length === clipboardCount, `стало ${store.items.length}`);
  t('вставленные объекты выделены', () => st.selection.length === clipboardCount);

  /* липкие заметки удалены: старые файлы и буфер обмена их не восстанавливают */
  t('липкая заметка из файла игнорируется', () => {
    store.load([
      IB.model.createText({ x: 10, y: 10, text: 'из файла' }),
      { id: 'legacy', type: 'sticky', x: 0, y: 0, w: 200, h: 200, text: 'старая заметка', color: '#ffe97a', fontSize: 22 },
    ]);
    return store.items.length === 1 && store.items[0].text === 'из файла';
  });
  t('липкая заметка из буфера игнорируется', () =>
    itc.importItems([{ type: 'sticky', x: 0, y: 0, w: 10, h: 10, text: 'x', fontSize: 10, color: '#fff' }]) === 0);
  t('объект неизвестного типа игнорируется', () =>
    itc.importItems([{ type: 'sticky', x: 0, y: 0 }, { type: 'text', x: 5, y: 5, text: 'ок', fontSize: 20 }]) === 1);

  /* название программы: в заголовке окна остаётся, в шапке доски — нет */
  t('в заголовке окна — «Доска», а в шапке только имя доски', () => {
    const brand = document.querySelector('.brand');
    const stray = brand.querySelector('.brand-mark, .brand-name');
    const hasName = !!document.getElementById('fileName');
    return document.title === 'Доска' && hasName && !stray ? true
      : `title=${document.title}, лишнее=${stray && stray.className}`;
  });

  t('имя доски не отчерчено вертикальной чертой', () => {
    /* черта отделяла название программы, которого в шапке больше нет */
    const el = document.getElementById('fileName');
    const cs = getComputedStyle(el);
    const border = cs.borderLeftWidth === '0px' || cs.borderLeftStyle === 'none';
    const padding = parseFloat(cs.paddingLeft) === 0;
    return border && padding ? true
      : `граница=${cs.borderLeftWidth} ${cs.borderLeftStyle}, отступ=${cs.paddingLeft}`;
  });

  /* ---------------- выбор фигуры у прямоугольника ---------------- */

  store.clear();
  /* Проверки ниже сверяют мировые координаты с точностью до долей пикселя,
     поэтому вид должен быть чистым: после тестов зума остаётся панорама. */
  app.commands.resetView();
  itc.setTool('rect');
  const rectBtnEl = document.querySelector('.tool[data-tool="rect"]');
  const shapeMenu = document.getElementById('shapeMenu');
  t('у кнопки «Прямоугольник» есть меню выбора фигуры', () => !!rectBtnEl && !!shapeMenu);

  const menuOpen = (kind, x = 120, y = 200) => {
    document.querySelector(`.tool[data-tool="${kind}"]`)
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  };
  menuOpen('rect');

  t('правый клик открывает меню фигур', () => !shapeMenu.hidden && shapeMenu.children.length === 7);
  t('в меню семь фигур: прямоугольник и шесть новых', () =>
    Array.from(shapeMenu.children).map((b) => b.dataset.variant).join(',') ===
    'rect,square,rhombus,parallelogram,trapezoid,trapezoid-trapezium,trapezoid-iso');
  t('пункты меню подписаны по-русски', () =>
    Array.from(shapeMenu.children).map((b) => b.querySelector('span').textContent).join('|') ===
    'Прямоугольник|Квадрат|Ромб|Параллелограмм|Трапеция|Произвольная трапеция|Равнобедренная трапеция');
  t('в меню есть иконки фигур', () =>
    Array.from(shapeMenu.children).every((b) => {
      const svg = b.querySelector('svg');
      return svg && svg.getAttribute('viewBox') === '0 0 20 20' && b.querySelector('path');
    }));

  const menuPick = (kind, id) => {
    menuOpen(kind);
    shapeMenu.querySelector(`[data-menu="${kind}"][data-variant="${id}"]`).click();
  };
  const pickShape = (id) => menuPick('rect', id);

  t('выбор фигуры закрывает меню и меняет подсказку кнопки', () => {
    pickShape('square');
    return shapeMenu.hidden === true &&
      st.shapeVariant === 'square' &&
      rectBtnEl.dataset.tip === 'Квадрат (R) · ПКМ — другие фигуры' &&
      document.getElementById('stTool').textContent === 'Квадрат' ? true
      : `${rectBtnEl.dataset.tip} / ${document.getElementById('stTool').textContent}`;
  });

  /* тяга задаёт основание и высоту: вершины считает geometry.shapePoints */
  const ptsOf = (shape, x1, y1, x2, y2) =>
    IB.geom.shapePoints(shape, { x: x1, y: y1 }, { x: x2, y: y2 });

  t('квадрат по тяге остаётся квадратом', () => {
    store.clear();
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 260, y: 180 }));
    const o = store.items[0];
    if (!o || o.shape !== 'square') return `получилась ${o && o.shape}`;
    const side = Math.abs(o.x2 - o.x1);
    const side2 = Math.abs(o.y2 - o.y1);
    return Math.abs(side - side2) < 1e-9 && side === 160
      ? true
      : `стороны ${side}×${side2}`;
  });

  const variants = ['square', 'rhombus', 'parallelogram', 'trapezoid', 'trapezoid-iso'];
  t('все пять фигур рисуются кнопкой «Прямоугольник»', () => {
    for (const v of variants) {
      store.clear();
      pickShape(v);
      gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 300, y: 220 }));
      const o = store.items[0];
      if (!o || o.shape !== v) return `${v}: получилась ${o && o.shape}`;
    }
    pickShape('rect');
    return true;
  });

  t('ромб: все четыре стороны равны', () => {
    const p = ptsOf('rhombus', 0, 0, 200, 100);
    const len = (i) => {
      const a = p[i];
      const b = p[(i + 1) % 4];
      return Math.hypot(b.x - a.x, b.y - a.y);
    };
    const sides = [len(0), len(1), len(2), len(3)];
    const eq = sides.every((s) => Math.abs(s - sides[0]) < 1e-9);
    /* вершины лежат на средних линиях рамки — ромб вписан в прямоугольник тяги */
    const onMid = p[0].x === 100 && p[0].y === 0 && p[1].x === 200 && p[1].y === 50;
    return eq && onMid ? true : JSON.stringify(sides);
  });

  t('параллелограмм: боковые стороны параллельны и равны', () => {
    const p = ptsOf('parallelogram', 0, 0, 200, 100);
    const sideA = { x: p[2].x - p[1].x, y: p[2].y - p[1].y };
    const sideB = { x: p[3].x - p[0].x, y: p[3].y - p[0].y };
    const baseA = { x: p[1].x - p[0].x, y: p[1].y - p[0].y };
    const baseB = { x: p[2].x - p[3].x, y: p[2].y - p[3].y };
    const same = (u, v) => Math.abs(u.x - v.x) < 1e-9 && Math.abs(u.y - v.y) < 1e-9;
    /* верхнее основание сдвинуто, но параллельно нижнему и той же длины */
    return same(sideA, sideB) && same(baseA, baseB) && p[0].x - p[3].x === 60
      ? true
      : JSON.stringify(p);
  });

  t('прямоугольная трапеция: левая сторона строго вертикальна', () => {
    const p = ptsOf('trapezoid', 0, 0, 200, 100);
    const leftVertical = p[0].x === p[3].x;
    const topShorter = Math.abs(p[2].x - p[3].x) === 100;
    /* верхнее основание втрое короче нижнего */
    return leftVertical && topShorter ? true : JSON.stringify(p);
  });

  t('равнобедренная трапеция симметрична', () => {
    const p = ptsOf('trapezoid-iso', 0, 0, 200, 100);
    const topW = p[2].x - p[3].x;
    const insetL = p[3].x - p[0].x;
    const insetR = p[1].x - p[2].x;
    return topW === 100 && insetL === insetR ? true : JSON.stringify({ topW, insetL, insetR });
  });

  t('заливка новых фигур заливает только их', () => {
    store.clear();
    st.fill = 'solid';
    for (const v of variants) {
      store.clear();
      pickShape(v);
      gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 300, y: 220 }));
      const o = store.items[0];
      if (!o || o.fill !== 'solid') return `${v}: заливка ${o && o.fill}`;
    }
    st.fill = 'none';
    pickShape('rect');
    return true;
  });

  t('попадание по контуру и внутрь новых фигур', () => {
    store.clear();
    pickShape('trapezoid-iso');
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 300, y: 260 }));
    const o = store.items[0];
    const r = IB.model.boundsOf(o);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    /* без заливки фигура ловится только по контуру */
    const topEdge = !!IB.hit.hitTest(store, { x: cx, y: r.y }, 6);
    /* точка на левой наклонной стороне */
    const sl = { x: r.x + (r.w / 4) * 0.75, y: r.y + r.h * 0.25 };
    const leftEdge = !!IB.hit.hitTest(store, sl, 6);
    o.fill = 'solid';
    const filled = !!IB.hit.hitTest(store, { x: cx, y: cy }, 6);
    o.fill = 'none';
    /* пустой угол рамки у трапеции ничем не занят */
    const outsideMiss = IB.hit.hitTest(store, { x: r.x + 4, y: r.y + 4 }, 6) === null;
    return topEdge && leftEdge && filled && outsideMiss ? true
      : `top=${topEdge} left=${leftEdge} filled=${filled} miss=${outsideMiss}`;
  });

  t('фигуры переживают сохранение и загрузку', () => {
    store.clear();
    variants.forEach((v, i) => {
      pickShape(v);
      gesture(toScreen({ x: 120 + i * 220, y: 120 }), toScreen({ x: 280 + i * 220, y: 240 }));
    });
    const parsed = IB.persist.fromText(IB.persist.toText(store, st.view));
    return parsed.items.map((o) => o.shape).join(',') === variants.join(',')
      ? true
      : parsed.items.map((o) => o.shape).join(',');
  });

  t('растягивание за угол не ломает квадрат', () => {
    store.clear();
    pickShape('square');
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 260, y: 260 }));
    const o = store.items[0];
    itc.setSelection([o.id]);
    const b = IB.model.boundsOf(o);
    const c = IB.geom.handlePoints(b).se;
    const s1 = toScreen({ x: c.x, y: c.y });
    const s2 = toScreen({ x: c.x + 120, y: c.y });
    itc.setTool('select');
    fire('pointerdown', s1.x, s1.y);
    fire('pointermove', s2.x, s2.y);
    fire('pointerup', s2.x, s2.y);
    const nb = IB.model.boundsOf(o);
    return Math.abs(nb.w - nb.h) < 0.51 ? true : `${nb.w.toFixed(1)}×${nb.h.toFixed(1)}`;
  });

  t('Escape закрывает меню фигур', () => {
    menuOpen('rect');
    const opened = !shapeMenu.hidden;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return opened && shapeMenu.hidden === true ? true : `opened=${opened}`;
  });

  store.clear();
  itc.setTool('rect');
  pickShape('rect');
  t('исходный прямоугольник возвращается выбором из меню', () =>
    st.shapeVariant === 'rect' && rectBtnEl.dataset.tip === 'Прямоугольник (R) · ПКМ — другие фигуры');

  /* ---------------- круг и овал ---------------- */

  store.clear();
  const ellipseBtnEl = document.querySelector('.tool[data-tool="ellipse"]');
  t('у кнопки «Круг» есть меню выбора фигуры', () => !!ellipseBtnEl);
  menuOpen('ellipse');
  t('правый клик по «Кругу» открывает меню круга и овала', () =>
    !shapeMenu.hidden && shapeMenu.children.length === 2);
  t('в меню круга: круг и овал', () =>
    Array.from(shapeMenu.children).map((b) => b.dataset.variant).join(',') === 'circle,ellipse' &&
    Array.from(shapeMenu.children).map((b) => b.querySelector('span').textContent).join('|') ===
    'Круг|Овал');

  t('круг по умолчанию круглый, а не овальный', () =>
    st.ellipseVariant === 'circle' && ellipseBtnEl.dataset.tip === 'Круг (O) · ПКМ — другие фигуры');

  itc.setTool('ellipse');
  t('протяжка по диагонали рисует круг, а не овал', () => {
    store.clear();
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 300, y: 220 }));
    const o = store.items[0];
    if (!o || o.shape !== 'circle') return `получилась ${o && o.shape}`;
    const w = Math.abs(o.x2 - o.x1);
    const h = Math.abs(o.y2 - o.y1);
    return Math.abs(w - h) < 1e-9 && w === 200 ? true : `${w}×${h}`;
  });

  t('у круга диаметр задаётся большей стороной протяжки', () => {
    store.clear();
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 100, y: 400 }));
    const o = store.items[0];
    const w = Math.abs(o.x2 - o.x1);
    const h = Math.abs(o.y2 - o.y1);
    return w === 300 && h === 300 ? true : `${w}×${h}`;
  });

  t('выбор овала меняет кнопку и рисует овал', () => {
    menuPick('ellipse', 'ellipse');
    if (st.ellipseVariant !== 'ellipse') return `вариант ${st.ellipseVariant}`;
    if (ellipseBtnEl.dataset.tip !== 'Овал (O) · ПКМ — другие фигуры') return `подсказка ${ellipseBtnEl.dataset.tip}`;
    store.clear();
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 300, y: 220 }));
    const o = store.items[0];
    return o && o.shape === 'ellipse' && Math.abs(o.x2 - o.x1) === 200 &&
      Math.abs(o.y2 - o.y1) === 120 ? true : `${o && o.shape}`;
  });

  t('круг и овал переживают сохранение и загрузку', () => {
    store.clear();
    menuPick('ellipse', 'circle');
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 300, y: 300 }));
    menuPick('ellipse', 'ellipse');
    gesture(toScreen({ x: 360, y: 100 }), toScreen({ x: 560, y: 220 }));
    const parsed = IB.persist.fromText(IB.persist.toText(store, st.view));
    return parsed.items.map((o) => o.shape).join(',') === 'circle,ellipse'
      ? true
      : parsed.items.map((o) => o.shape).join(',');
  });

  t('растягивание за угол не ломает круг', () => {
    store.clear();
    menuPick('ellipse', 'circle');
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 300, y: 300 }));
    const o = store.items[0];
    itc.setSelection([o.id]);
    const c = IB.geom.handlePoints(IB.model.boundsOf(o)).se;
    const s1 = toScreen({ x: c.x, y: c.y });
    const s2 = toScreen({ x: c.x + 120, y: c.y });
    itc.setTool('select');
    fire('pointerdown', s1.x, s1.y);
    fire('pointermove', s2.x, s2.y);
    fire('pointerup', s2.x, s2.y);
    const nb = IB.model.boundsOf(o);
    return Math.abs(nb.w - nb.h) < 0.51 ? true : `${nb.w.toFixed(1)}×${nb.h.toFixed(1)}`;
  });

  t('незалитый круг ловится по контуру, а не по углам рамки', () => {
    store.clear();
    itc.setTool('ellipse');
    menuPick('ellipse', 'circle');
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 300, y: 300 }));
    const o = store.items[0];
    if (!o || o.shape !== 'circle') return `получилась ${o && o.shape}`;
    const r = IB.model.boundsOf(o);
    const cx = r.x + r.w / 2;
    const onContour = !!IB.hit.hitTest(store, { x: cx, y: r.y }, 6);
    const onSide = !!IB.hit.hitTest(store, { x: cx, y: r.y + r.h / 2 }, 6);
    /* середина без заливки не ловится: попадать надо по контуру */
    const centreMiss = IB.hit.hitTest(store, { x: cx, y: r.y + r.h / 2 - 10 }, 6) === null;
    /* угол габаритов окружности не принадлежит ни контуру, ни заливке */
    const cornerMiss = IB.hit.hitTest(store, { x: r.x + 3, y: r.y + 3 }, 6) === null;
    o.fill = 'solid';
    const centreFilled = !!IB.hit.hitTest(store, { x: cx, y: r.y + r.h / 2 - 10 }, 6);
    const cornerStillMiss = IB.hit.hitTest(store, { x: r.x + 3, y: r.y + 3 }, 6) === null;
    o.fill = 'none';
    return onContour && onSide && centreMiss && cornerMiss && centreFilled && cornerStillMiss ? true
      : `on=${onContour} side=${onSide} miss=${centreMiss} corner=${cornerMiss} filled=${centreFilled} corner2=${cornerStillMiss}`;
  });

  menuPick('ellipse', 'circle');
  store.clear();

  /* ---------------- прямоугольный и равнобедренный треугольники ---------------- */

  store.clear();
  const triangleBtnEl = document.querySelector('.tool[data-tool="triangle"]');
  t('кнопка «Треугольник» есть в панели инструментов', () => !!triangleBtnEl);
  /* подсказку кнопки переписывает syncShapeVariant под текущий вариант */
  t('подсказка кнопки — прямоугольный треугольник (U)', () =>
    triangleBtnEl.dataset.tip === 'Прямоугольный треугольник (U) · ПКМ — другие фигуры' && st.triangleVariant === 'triangle');

  menuOpen('triangle');
  t('правый клик по «Треугольнику» открывает меню', () =>
    !shapeMenu.hidden && shapeMenu.children.length === 5);
  t('в меню треугольника пять фигур: прямоугольный, тупоугольный, разносторонний, равнобедренный и равносторонний', () =>
    Array.from(shapeMenu.children).map((b) => b.dataset.variant).join(',') ===
    'triangle,triangle-obtuse,triangle-scalene,triangle-iso,triangle-equilateral' &&
    Array.from(shapeMenu.children).map((b) => b.querySelector('span').textContent).join('|') ===
    'Прямоугольный треугольник|Тупоугольный треугольник|Разносторонний треугольник|Равнобедренный треугольник|Равносторонний треугольник');

  itc.setTool('triangle');
  t('протяжка рисует прямоугольный треугольник', () => {
    store.clear();
    itc.setTool('triangle');
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 300, y: 260 }));
    const o = store.items[0];
    return o && o.shape === 'triangle' ? true : `${o && o.shape}`;
  });

  t('равнобедренный треугольник симметричен, прямоугольный — нет', () => {
    const rt = ptsOf('triangle', 0, 0, 200, 160);
    const iso = ptsOf('triangle-iso', 0, 0, 200, 160);
    /* у прямоугольного один катет строго вертикален */
    const rightAngle = rt[0].x === rt[1].x && rt[1].y === rt[2].y;
    /* у равнобедренного вершина ровно по центру основания */
    const symmetric = iso[2].x - iso[0].x === iso[1].x - iso[2].x;
    const baseline = iso[0].y === iso[1].y;
    return rightAngle && symmetric && baseline ? true
      : JSON.stringify({ rightAngle, symmetric, baseline, iso });
  });

  t('выбор равнобедренного меняет кнопку и рисует его', () => {
    menuPick('triangle', 'triangle-iso');
    if (st.triangleVariant !== 'triangle-iso') return `вариант ${st.triangleVariant}`;
    if (triangleBtnEl.dataset.tip !== 'Равнобедренный треугольник (U) · ПКМ — другие фигуры') return `подсказка ${triangleBtnEl.dataset.tip}`;
    store.clear();
    itc.setTool('triangle');
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 320, y: 280 }));
    const o = store.items[0];
    return o && o.shape === 'triangle-iso' ? true : `${o && o.shape}`;
  });

  t('круг, овал и треугольники переживают сохранение и загрузку', () => {
    store.clear();
    menuPick('ellipse', 'circle');
    itc.setTool('ellipse');
    gesture(toScreen({ x: 80, y: 80 }), toScreen({ x: 220, y: 220 }));
    menuPick('triangle', 'triangle-iso');
    itc.setTool('triangle');
    gesture(toScreen({ x: 300, y: 80 }), toScreen({ x: 460, y: 220 }));
    menuPick('triangle', 'triangle');
    itc.setTool('triangle');
    gesture(toScreen({ x: 540, y: 80 }), toScreen({ x: 700, y: 220 }));
    const parsed = IB.persist.fromText(IB.persist.toText(store, st.view));
    return parsed.items.map((o) => o.shape).join(',') === 'circle,triangle-iso,triangle'
      ? true
      : parsed.items.map((o) => o.shape).join(',');
  });

  t('треугольник ловится по контуру, угол рамки — нет', () => {
    store.clear();
    menuPick('triangle', 'triangle');
    itc.setTool('triangle');
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 300, y: 260 }));
    const o = store.items[0];
    const r = IB.model.boundsOf(o);
    /* гипотенуза идёт из левого верхнего угла в правый нижний */
    const midHyp = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    const onHyp = !!IB.hit.hitTest(store, midHyp, 6);
    /* правый верхний угол рамки пуст */
    const cornerMiss = IB.hit.hitTest(store, { x: r.x + r.w - 3, y: r.y + 3 }, 6) === null;
    o.fill = 'solid';
    const cornerStillMiss = IB.hit.hitTest(store, { x: r.x + r.w - 3, y: r.y + 3 }, 6) === null;
    o.fill = 'none';
    return onHyp && cornerMiss && cornerStillMiss ? true
      : `hyp=${onHyp} corner=${cornerMiss} cornerFilled=${cornerStillMiss}`;
  });

  t('клавиша U выбирает инструмент «Треугольник»', () => {
    itc.setTool('select');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true }));
    return st.tool === 'triangle' ? true : `инструмент ${st.tool}`;
  });

  /* ---------------- блокировка объекта ---------------- */

  store.clear();
  /* точка на левой стороне прямоугольника — по ней объект ловится контуром */
  const lockedEdge = (o) => ({ x: o.x1, y: (o.y1 + o.y2) / 2 });
  const lockedMiddle = (o) => ({ x: (o.x1 + o.x2) / 2, y: (o.y1 + o.y2) / 2 });
  const lockBtn = document.querySelector('#selectionbar [data-sel="lock"]');
  t('в панели выделения есть кнопка блокировки', () =>
    !!lockBtn && /Блокировать/i.test(lockBtn.getAttribute('title')));

  /* рисуем фигуру, блокируем её и проверяем все инструменты подряд.
     Набираем по левой стороне: у незалитого прямоугольника ловится
     только контур, середина пустая. */
  const lockedRect = () => {
    store.clear();
    menuPick('rect', 'rect');
    itc.setTool('rect');
    gesture(toScreen({ x: 120, y: 120 }), toScreen({ x: 320, y: 280 }));
    const o = store.items[0];
    itc.setTool('select');
    const c = toScreen(lockedEdge(o));
    fire('pointerdown', c.x, c.y);
    fire('pointerup', c.x, c.y);
    if (st.selection.length !== 1) return null;
    app.commands.toggleLock();
    return o;
  };

  t('заблокированный объект выделяется обычным кликом', () => {
    const o = lockedRect();
    if (!o) return 'не удалось выделить и заблокировать';
    if (o.locked !== true) return 'флаг не выставлен';
    st.selection = [];
    const c = toScreen(lockedEdge(o));
    fire('pointerdown', c.x, c.y);
    fire('pointerup', c.x, c.y);
    return st.selection.length === 1 && st.selection[0] === o.id ? true
      : `в выделении ${st.selection.length}`;
  });

  t('заблокированный объект не ловится ластиком и заливкой', () => {
    const o = lockedRect();
    if (!o) return 'нет заблокированного объекта';
    const inside = lockedEdge(o);
    const missed = IB.hit.hitTest(store, inside, 6) === null;
    const visible = !!IB.hit.hitTest(store, inside, 6, true);
    return missed && visible ? true : `missed=${missed} visibleWithFlag=${visible}`;
  });

  t('заблокированный объект не двигается мышью', () => {
    const o = lockedRect();
    if (!o) return 'нет заблокированного объекта';
    const before = { x1: o.x1, y1: o.y1 };
    const from = toScreen(lockedEdge(o));
    fire('pointerdown', from.x, from.y);
    fire('pointermove', from.x + 120, from.y + 90);
    fire('pointerup', from.x + 120, from.y + 90);
    return o.x1 === before.x1 && o.y1 === before.y1 ? true
      : `сдвинулся на ${(o.x1 - before.x1).toFixed(1)}, ${(o.y1 - before.y1).toFixed(1)}`;
  });

  t('в смешанном выделении двигаются только незаблокированные', () => {
    store.clear();
    menuPick('rect', 'rect');
    itc.setTool('rect');
    gesture(toScreen({ x: 120, y: 120 }), toScreen({ x: 320, y: 280 }));
    const lockedObj = store.items[0];
    itc.setTool('select');
    const e1 = toScreen(lockedEdge(lockedObj));
    fire('pointerdown', e1.x, e1.y);
    fire('pointerup', e1.x, e1.y);
    app.commands.toggleLock();
    const lockedBefore = { x1: lockedObj.x1, y1: lockedObj.y1 };

    menuPick('rect', 'rect');
    itc.setTool('rect');
    gesture(toScreen({ x: 500, y: 120 }), toScreen({ x: 700, y: 280 }));
    const freeObj = store.items[1];
    itc.setTool('select');
    const e2 = toScreen(lockedEdge(freeObj));
    fire('pointerdown', e2.x, e2.y);
    fire('pointerup', e2.x, e2.y);
    fire('pointerdown', e2.x, e2.y, { shiftKey: true });
    const freeBefore = freeObj.x1;

    fire('pointerdown', e2.x, e2.y);
    fire('pointermove', e2.x + 100, e2.y + 60);
    fire('pointerup', e2.x + 100, e2.y + 60);
    const lockedHeld = lockedObj.x1 === lockedBefore.x1 && lockedObj.y1 === lockedBefore.y1;
    const freeMoved = freeObj.x1 > freeBefore;
    return lockedHeld && freeMoved ? true
      : `lockedHeld=${lockedHeld} freeMoved=${(freeObj.x1 - freeBefore).toFixed(1)}`;
  });

  t('сдвиг стрелками игнорирует заблокированный объект', () => {
    const o = lockedRect();
    if (!o) return 'нет заблокированного объекта';
    const c = toScreen(lockedEdge(o));
    fire('pointerdown', c.x, c.y);
    fire('pointerup', c.x, c.y);
    const before = o.x1;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    return o.x1 === before ? true : `сдвинулся на ${(o.x1 - before).toFixed(1)}`;
  });

  t('рамка выделения обходит заблокированный объект', () => {
    const o = lockedRect();
    if (!o) return 'нет заблокированного объекта';
    st.selection = [];
    const a = toScreen({ x: o.x1 - 60, y: o.y1 - 60 });
    const b = toScreen({ x: o.x2 + 60, y: o.y2 + 60 });
    fire('pointerdown', a.x, a.y);
    fire('pointermove', b.x, b.y);
    fire('pointerup', b.x, b.y);
    return st.selection.indexOf(o.id) === -1 ? true : `захвачен ${st.selection.length}`;
  });

  t('ластик не стирает заблокированный объект', () => {
    const o = lockedRect();
    if (!o) return 'нет заблокированного объекта';
    const c = toScreen(lockedEdge(o));
    itc.setTool('eraser');
    fire('pointerdown', c.x, c.y);
    fire('pointermove', c.x + 6, c.y + 6);
    fire('pointerup', c.x + 6, c.y + 6);
    itc.setTool('select');
    return store.get(o.id) ? true : 'объект стёрт';
  });

  t('заливка не достаёт заблокированный объект', () => {
    const o = lockedRect();
    if (!o) return 'нет заблокированного объекта';
    o.fill = 'none';
    const c = toScreen(lockedMiddle(o));
    itc.setTool('fill');
    fire('pointerdown', c.x, c.y);
    fire('pointerup', c.x, c.y);
    itc.setTool('select');
    return o.fill === 'none' ? true : `залилось: ${o.fill}`;
  });

  t('выделить всё не захватывает заблокированный объект', () => {
    const o = lockedRect();
    if (!o) return 'нет заблокированного объекта';
    store.insert([IB.model.createText({ text: 'свободный', x: 700, y: 700, w: 200, h: 40 })]);
    app.commands.selectAll();
    const hasLocked = st.selection.indexOf(o.id) !== -1;
    const hasFree = st.selection.length === 1;
    st.selection = [];
    return !hasLocked && hasFree ? true : `locked=${hasLocked} всего ${st.selection.length}`;
  });

  t('удаление выделения игнорирует заблокированный объект', () => {
    const o = lockedRect();
    if (!o) return 'нет заблокированного объекта';
    st.selection = [o.id];
    itc.deleteSelection();
    return store.get(o.id) ? true : 'объект удалён';
  });

  t('очистка доски оставляет заблокированный объект', () => {
    const o = lockedRect();
    if (!o) return 'нет заблокированного объекта';
    store.insert([IB.model.createText({ text: 'свободный', x: 700, y: 700, w: 200, h: 40 })]);
    itc.clearBoard();
    const keptLocked = !!store.get(o.id);
    const keptFree = store.items.length === 1;
    return keptLocked && keptFree ? true
      : `заблокирован ${keptLocked}, осталось ${store.items.length}`;
  });

  t('Ctrl+Shift+L снимает блокировку с выделения', () => {
    const o = lockedRect();
    if (!o) return 'нет заблокированного объекта';
    const c = toScreen(lockedEdge(o));
    fire('pointerdown', c.x, c.y);
    fire('pointerup', c.x, c.y);
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'L', ctrlKey: true, shiftKey: true, bubbles: true,
    }));
    return o.locked === false ? true : `locked=${o.locked}`;
  });

  t('кнопка замка в панели выделения снимает блокировку', () => {
    const o = lockedRect();
    if (!o) return 'нет заблокированного объекта';
    if (!lockBtn) return 'нет кнопки блокировки';
    st.selection = [];
    const c = toScreen(lockedEdge(o));
    fire('pointerdown', c.x, c.y);
    fire('pointerup', c.x, c.y);
    if (st.selection[0] !== o.id) return `выделено ${st.selection.length}`;
    lockBtn.click();
    const unlocked = o.locked === false;
    /* и объект снова поддаётся редактированию */
    const free = !IB.hit.hitTest(store, lockedEdge(o), 6, true).locked;
    return unlocked && free ? true : `locked=${o.locked}`;
  });

  t('повторное включение блокировки записывается в историю', () => {
    const o = lockedRect();
    if (!o) return 'нет заблокированного объекта';
    st.selection = [o.id];
    app.commands.toggleLock();
    st.selection = [o.id];
    app.commands.toggleLock();
    app.commands.undo();
    return o.locked === false ? true : `после отмены locked=${o.locked}`;
  });

  t('блокировка переживает сохранение и загрузку файла', () => {
    const o = lockedRect();
    if (!o) return 'нет заблокированного объекта';
    const parsed = IB.persist.fromText(IB.persist.toText(store, st.view));
    return parsed.items[0].locked === true ? true
      : `locked=${parsed.items[0].locked}`;
  });

  t('у новых объектов блокировка выключена', () => {
    const made = [
      IB.model.createStroke({ points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }),
      IB.model.createShape('rect'),
      IB.model.createText({ text: 'x' }),
      IB.model.createImage({ src: 'data:image/png;base64,' }),
    ];
    return made.every((o) => o.locked === false) ? true
      : made.map((o) => o.type).join(',');
  });

  store.clear();
  st.selection = [];

  /* ---------------- выравнивание и распределение ---------------- */

  store.clear();
  itc.setTool('select');

  /* три прямоугольника разного размера и положения */
  const boxes = [
    { x1: 100, y1: 100, x2: 300, y2: 220 },
    { x1: 420, y1: 160, x2: 560, y2: 360 },
    { x1: 700, y1: 60, x2: 900, y2: 140 },
  ];
  const makeBoxes = () => {
    store.clear();
    st.selection = [];
    menuPick('rect', 'rect');
    for (const b of boxes) {
      itc.setTool('rect');
      gesture(toScreen({ x: b.x1, y: b.y1 }), toScreen({ x: b.x2, y: b.y2 }));
    }
    itc.setTool('select');
    return store.items.slice();
  };
  const leftOf = (o) => IB.model.boundsOf(o).x;
  const topOf = (o) => IB.model.boundsOf(o).y;
  const rightOf = (o) => { const b = IB.model.boundsOf(o); return b.x + b.w; };
  const bottomOf = (o) => { const b = IB.model.boundsOf(o); return b.y + b.h; };
  const selectAllMovable = () => { app.commands.selectAll(); };

  t('в инспекторе выделения есть кнопки выравнивания', () => {
    const cmds = Array.from(document.querySelectorAll('.insp-block[data-for="select"] [data-cmd]'))
      .map((b) => b.dataset.cmd);
    const want = ['alignLeft', 'alignCenterH', 'alignRight', 'alignTop', 'alignCenterV',
      'alignBottom', 'distributeH', 'distributeV'];
    const missing = want.filter((c) => cmds.indexOf(c) === -1);
    return missing.length === 0 ? true : `нет кнопок: ${missing.join(',')}`;
  });

  t('кнопки выравнивания видны только у инструмента «Выделение»', () => {
    itc.setTool('pen');
    const hidden = !document.querySelector('.insp-block[data-for="select"].visible');
    itc.setTool('select');
    const shown = !!document.querySelector('.insp-block[data-for="select"].visible');
    return hidden && shown ? true : `hidden=${hidden} shown=${shown}`;
  });

  t('выравнивание по левому краю сводит объекты к общей границе', () => {
    const objs = makeBoxes();
    selectAllMovable();
    app.commands.alignLeft();
    const xs = objs.map(leftOf);
    const same = xs.every((x) => Math.abs(x - xs[0]) < 0.001);
    return same ? true : `границы: ${xs.map((x) => x.toFixed(1)).join(', ')}`;
  });

  t('выравнивание по правому краю сводит правые стороны', () => {
    const objs = makeBoxes();
    selectAllMovable();
    app.commands.alignRight();
    const xs = objs.map(rightOf);
    return xs.every((x) => Math.abs(x - xs[0]) < 0.001) ? true
      : `правые: ${xs.map((x) => x.toFixed(1)).join(', ')}`;
  });

  t('выравнивание по центру сводит середины по горизонтали', () => {
    const objs = makeBoxes();
    selectAllMovable();
    app.commands.alignCenterH();
    const mids = objs.map((o) => { const b = IB.model.boundsOf(o); return b.x + b.w / 2; });
    return mids.every((m) => Math.abs(m - mids[0]) < 0.001) ? true
      : `середины: ${mids.map((m) => m.toFixed(1)).join(', ')}`;
  });

  t('выравнивание по верхнему и нижнему краю работает', () => {
    const objs = makeBoxes();
    selectAllMovable();
    app.commands.alignTop();
    const tops = objs.map(topOf);
    const topOk = tops.every((v) => Math.abs(v - tops[0]) < 0.001);
    selectAllMovable();
    app.commands.alignBottom();
    const bots = objs.map(bottomOf);
    const bottomOk = bots.every((v) => Math.abs(v - bots[0]) < 0.001);
    return topOk && bottomOk ? true : `top=${topOk} bottom=${bottomOk}`;
  });

  t('выравнивание по середине по вертикали работает', () => {
    const objs = makeBoxes();
    selectAllMovable();
    app.commands.alignCenterV();
    const mids = objs.map((o) => { const b = IB.model.boundsOf(o); return b.y + b.h / 2; });
    return mids.every((m) => Math.abs(m - mids[0]) < 0.001) ? true
      : `середины: ${mids.map((m) => m.toFixed(1)).join(', ')}`;
  });

  t('выравнивание не двигает объекты по другой оси', () => {
    const objs = makeBoxes();
    const before = objs.map(topOf);
    selectAllMovable();
    app.commands.alignLeft();
    const after = objs.map(topOf);
    return before.every((v, i) => Math.abs(v - after[i]) < 0.001) ? true : 'верх поехал';
  });

  t('выравнивание отменяется одним Ctrl+Z', () => {
    const objs = makeBoxes();
    const before = objs.map(leftOf);
    selectAllMovable();
    app.commands.alignLeft();
    app.commands.undo();
    const after = objs.map(leftOf);
    return before.every((v, i) => Math.abs(v - after[i]) < 0.001) ? true : 'отмена не вернула';
  });

  t('выравнивание работает и для штрихов и для текста', () => {
    store.clear();
    st.selection = [];
    itc.setTool('pen');
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 200, y: 180 }));
    itc.setTool('text');
    const t1 = toScreen({ x: 500, y: 300 });
    fire('pointerdown', t1.x, t1.y);
    const ta = document.getElementById('overlay').querySelector('textarea');
    if (ta) {
      ta.value = 'Подпись';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      itc.commitTextEdit();
    }
    if (store.items.length !== 2) return `объектов: ${store.items.length}`;
    itc.setTool('select');
    app.commands.selectAll();
    const objs = store.items.slice();
    const leftBefore = objs.map(leftOf);
    app.commands.alignRight();
    const rights = objs.map(rightOf);
    const rightsOk = rights.every((v) => Math.abs(v - rights[0]) < 0.001);
    /* правый край задаёт самый правый объект, он не движется —
       значит левый из двух обязан сдвинуться */
    const held = objs.map(leftOf);
    const movedApart = Math.abs(held[0] - leftBefore[0]) > 1;
    return rightsOk && movedApart ? true : `rights=${rightsOk} apart=${movedApart}`;
  });

  t('заблокированные объекты не участвуют в выравнивании', () => {
    const objs = makeBoxes();
    const frozen = leftOf(objs[2]);
    st.selection = [objs[2].id];
    app.commands.toggleLock();
    selectAllMovable();
    app.commands.alignLeft();
    const stillThere = Math.abs(leftOf(objs[2]) - frozen) < 0.001;
    const othersAligned = objs.slice(0, 2).map(leftOf)
      .every((x) => Math.abs(x - leftOf(objs[0])) < 0.001);
    return stillThere && othersAligned ? true
      : `lockedHeld=${stillThere} aligned=${othersAligned}`;
  });

  t('выравнивание одного объекста ничего не делает', () => {
    const objs = makeBoxes();
    st.selection = [objs[0].id];
    const before = leftOf(objs[0]);
    const n = app.commands.alignLeft();
    return n === 0 && Math.abs(leftOf(objs[0]) - before) < 0.001 ? true : `сдвинуто на ${n}`;
  });

  const gapsOf = (objs, horizontal) => {
    const list = objs
      .map((o) => IB.model.boundsOf(o))
      .sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
    const out = [];
    for (let i = 0; i + 1 < list.length; i++) {
      out.push(horizontal
        ? list[i + 1].x - (list[i].x + list[i].w)
        : list[i + 1].y - (list[i].y + list[i].h));
    }
    return out;
  };

  t('распределение по горизонтали даёт равные промежутки', () => {
    const objs = makeBoxes();
    const before = gapsOf(objs, true);
    const equal = before.every((g) => Math.abs(g - before[0]) < 0.001);
    selectAllMovable();
    app.commands.distributeH();
    const after = gapsOf(objs, true);
    const nowEqual = after.every((g) => Math.abs(g - after[0]) < 0.001);
    return !equal && nowEqual ? true
      : `до ${before.map((g) => g.toFixed(1))} / после ${after.map((g) => g.toFixed(1))}`;
  });

  t('распределение по вертикали даёт равные промежутки', () => {
    const objs = makeBoxes();
    const before = gapsOf(objs, false);
    const equal = before.every((g) => Math.abs(g - before[0]) < 0.001);
    selectAllMovable();
    app.commands.distributeV();
    const after = gapsOf(objs, false);
    const nowEqual = after.every((g) => Math.abs(g - after[0]) < 0.001);
    return !equal && nowEqual ? true
      : `до ${before.map((g) => g.toFixed(1))} / после ${after.map((g) => g.toFixed(1))}`;
  });

  t('распределение оставляет крайние объекты на месте', () => {
    const objs = makeBoxes();
    const leftBefore = leftOf(objs[0]);
    const rightBefore = rightOf(objs[2]);
    selectAllMovable();
    app.commands.distributeH();
    return Math.abs(leftOf(objs[0]) - leftBefore) < 0.001 &&
      Math.abs(rightOf(objs[2]) - rightBefore) < 0.001 ? true : 'крайние сдвинулись';
  });

  t('распределение отменяется одним Ctrl+Z', () => {
    const objs = makeBoxes();
    const before = objs.map(leftOf);
    selectAllMovable();
    app.commands.distributeH();
    app.commands.undo();
    const after = objs.map(leftOf);
    return before.every((v, i) => Math.abs(v - after[i]) < 0.001) ? true : 'отмена не вернула';
  });

  t('распределение требует трёх объектов', () => {
    const objs = makeBoxes();
    st.selection = [objs[0].id, objs[1].id];
    const before = leftOf(objs[1]);
    const n = app.commands.distributeH();
    return n === 0 && Math.abs(leftOf(objs[1]) - before) < 0.001 ? true : `сработало на ${n}`;
  });

  t('полный цикл: выровняли, разнесли, отменили — доска как была', () => {
    const objs = makeBoxes();
    const before = objs.map((o) => JSON.stringify(IB.model.boundsOf(o)));
    selectAllMovable();
    app.commands.alignCenterH();
    app.commands.distributeV();
    app.commands.undo();
    app.commands.undo();
    const after = objs.map((o) => JSON.stringify(IB.model.boundsOf(o)));
    return before.every((v, i) => v === after[i]) ? true : 'состояние не восстановилось';
  });

  store.clear();
  st.selection = [];

  /* ---------------- постоянный размер ластика ---------------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  store.clear();
  itc.setTool('eraser');
  st.eraserWidth = 24;
  const baseR = st.eraserWidth / 2;

  /* радиус строго равен базовому: роста по скорости больше нет */
  t('синхронные события держат базовый радиус', () => {
    store.clear();
    itc.setTool('pen');
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 200, y: 200 }));
    itc.setTool('eraser');
    const a = toScreen({ x: 150, y: 150 });
    fire('pointerdown', a.x, a.y);
    const radii = [];
    for (let i = 0; i < 6; i += 1) {
      fire('pointermove', a.x + i * 90, a.y);
      radii.push(st.eraserRadius);
    }
    fire('pointerup', a.x + 500, a.y);
    const held = radii.every((r) => Math.abs(r - baseR * st.view.scale) < 0.001);
    return held ? true : `радиусы: ${radii.map((r) => r.toFixed(1)).join(', ')}`;
  });

  /* медленное движение: скорость мала, ластик остаётся базового размера */
  await t('на медленном движении ластик не растёт', async () => {
    store.clear();
    itc.setTool('eraser');
    const start = toScreen({ x: 100, y: 100 });
    fire('pointerdown', start.x, start.y);
    const radii = [];
    for (let i = 1; i <= 5; i += 1) {
      /* 6 пикселей за 120 мс — это ~50 px/s, далеко от порога роста */
      fire('pointermove', start.x + i * 6, start.y);
      await sleep(120);
      radii.push(st.eraserRadius);
    }
    fire('pointerup', start.x + 30, start.y);
    const base = baseR * st.view.scale;
    const held = radii.every((r) => Math.abs(r - base) < 0.001);
    return held ? true : `радиусы: ${radii.map((r) => r.toFixed(1)).join(', ')}`;
  });

  /* быстрое движение: размер остаётся базовым — роста по скорости нет */
  await t('на быстром движении ластик не растёт', async () => {
    store.clear();
    itc.setTool('eraser');
    const start = toScreen({ x: 100, y: 400 });
    fire('pointerdown', start.x, start.y);
    const radii = [];
    for (let i = 1; i <= 6; i += 1) {
      /* 300 пикселей за 10 мс — порядка 30000 px/s, заведомо быстро */
      fire('pointermove', start.x + i * 300, start.y);
      await sleep(10);
      radii.push(st.eraserRadius);
    }
    fire('pointerup', start.x + 2000, start.y);
    const base = baseR * st.view.scale;
    const held = radii.every((r) => Math.abs(r - base) < 0.001);
    return held ? true : `радиусы: ${radii.map((r) => r.toFixed(1)).join(', ')}`;
  });

  store.clear();
  st.selection = [];

  menuPick('triangle', 'triangle');
  store.clear();
  itc.setTool('ellipse');

  /* ---------------- объёмные фигуры ---------------- */

  store.clear();
  const solidBtnEl = document.querySelector('.tool[data-tool="solid"]');
  t('кнопка «Объёмная фигура» есть в панели инструментов', () => !!solidBtnEl);
  /* как у «Прямоугольника» и «Треугольника», подсказку переписывает
     syncShapeVariant под текущий вариант */
  t('подсказка кнопки — Параллелепипед (C)', () =>
    solidBtnEl.dataset.tip === 'Параллелепипед (C) · ПКМ — другие фигуры' && st.solidVariant === 'solid-box');

  menuOpen('solid');
  const SOLID_IDS = 'solid-box,solid-pyramid-3,solid-pyramid-4,solid-pyramid-5,solid-pyramid-6,' +
    'solid-prism-3,solid-prism-4,solid-prism-5,solid-sphere';
  t('правый клик по «Объёмной фигуре» открывает меню', () =>
    !shapeMenu.hidden && shapeMenu.children.length === 9);
  t('в меню все девять объёмных фигур', () =>
    Array.from(shapeMenu.children).map((b) => b.dataset.variant).join(',') === SOLID_IDS);
  t('объёмные фигуры подписаны по-русски', () =>
    Array.from(shapeMenu.children).map((b) => b.querySelector('span').textContent).join('|') ===
    'Параллелепипед|Треугольная пирамида|Четырёхугольная пирамида|Пятиугольная пирамида|' +
    'Шестиугольная пирамида|Треугольная призма|Четырёхугольная призма|Пятиугольная призма|Сфера');
  t('у всех объёмных фигур есть иконки', () =>
    Array.from(shapeMenu.children).every((b) => {
      const svg = b.querySelector('svg');
      return svg && svg.getAttribute('viewBox') === '0 0 20 20' && b.querySelector('path');
    }));

  t('иконки равностороннего и равнобедренного треугольника различимы', () => {
    /* вершины у них почти в одной точке, поэтому равносторонний помечен
       засечками на сторонах — иначе их легко перепутать в меню */
    menuOpen('triangle');
    const get = (id) => {
      const b = shapeMenu.querySelector(`[data-variant="${id}"] path`);
      return b ? b.getAttribute('d') : '';
    };
    const iso = get('triangle-iso');
    const eq = get('triangle-equilateral');
    const differ = iso && eq && iso !== eq;
    /* у равностороннего должны быть засечки: четыре отдельные команды */
    const strokes = (eq.match(/[M]/g) || []).length;
    return differ && strokes >= 4 ? true : `совпадают=${iso === eq}, засечек=${strokes}`;
  });

  t('активный вариант отмечен в меню', () => {
    menuPick('triangle', 'triangle-equilateral');
    menuOpen('triangle');
    const marked = Array.from(shapeMenu.children)
      .filter((b) => b.classList.contains('active'))
      .map((b) => b.dataset.variant);
    const checked = shapeMenu.querySelector('[aria-checked="true"]');
    menuPick('triangle', 'triangle');
    return marked.length === 1 && marked[0] === 'triangle-equilateral' && checked
      ? true : `отмечено: ${marked.join(',')}`;
  });

  t('клавиша C выбирает инструмент «Объёмная фигура»', () => {
    itc.setTool('select');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    return st.tool === 'solid' ? true : `инструмент ${st.tool}`;
  });

  const solidRect = { x1: 0, y1: 0, x2: 240, y2: 200 };
  const geoOf = (id) => IB.geom.solidGeometry(id, { x: solidRect.x1, y: solidRect.y1 }, { x: solidRect.x2, y: solidRect.y2 });

  /* площадь многоугольника: нужна, чтобы отличить грань от выродившейся в линию */
  const areaOf = (pts) => {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s / 2);
  };

  t('каждая объёмная фигура строится из граней и рёбер', () => {
    const bad = [];
    for (const id of SOLID_IDS.split(',')) {
      const geo = geoOf(id);
      /* у сферы вместо сетки эллипсы, поэтому проверяем любой из двух способов */
      const hasBody = geo.faces.length > 0 || geo.curves.length > 0;
      if (!geo || !hasBody || geo.outline.length < 3) bad.push(id);
    }
    return bad.length === 0 ? true : bad.join(',');
  });

  t('у каждой объёмной фигуры есть видимые рёбра и затенение граней', () => {
    const bad = [];
    for (const id of SOLID_IDS.split(',')) {
      const geo = geoOf(id);
      if (geo.faces.length === 0) {
        /* сфера: объём дают эллипсы сечения */
        if (geo.curves.length < 2) bad.push(id);
        continue;
      }
      const visibleEdges = geo.edges.filter((e) => !e.hidden).length;
      const litFaces = geo.faces.filter((f) => f.visible && f.shade > 0 && f.shade <= 1 &&
        areaOf(f.points) > 1).length;
      if (litFaces < 2 || visibleEdges < 3) bad.push(id);
    }
    return bad.length === 0 ? true : bad.join(',');
  });

  t('объёмная фигура помещается в свою рамку', () => {
    const bad = [];
    for (const id of SOLID_IDS.split(',')) {
      const geo = geoOf(id);
      const all = [];
      for (const f of geo.faces) for (const p of f.points) all.push(p);
      for (const e of geo.edges) { all.push(e.a); all.push(e.b); }
      for (const c of geo.curves) {
        all.push({ x: c.cx - c.rx, y: c.cy - c.ry });
        all.push({ x: c.cx + c.rx, y: c.cy + c.ry });
      }
      const outside = all.some((p) =>
        p.x < solidRect.x1 - 0.5 || p.y < solidRect.y1 - 0.5 ||
        p.x > solidRect.x2 + 0.5 || p.y > solidRect.y2 + 0.5);
      if (outside) bad.push(id);
    }
    return bad.length === 0 ? true : bad.join(',');
  });

  t('у четырёхугольной призмы три грани, ни одна не вырождена', () => {
    const geo = geoOf('solid-prism-4');
    const visible = geo.faces.filter((f) => f.visible);
    const areas = visible.map((f) => areaOf(f.points));
    return visible.length === 3 && areas.every((a) => a > 1) ? true
      : `visible=${visible.length} areas=${areas.map((a) => a.toFixed(2))}`;
  });

  t('у параллелепипеда ровно три скрытых ребра', () => {
    const geo = geoOf('solid-box');
    const hidden = geo.edges.filter((e) => e.hidden).length;
    return hidden === 3 ? true : `скрытых ${hidden}`;
  });

  t('протяжка рисует выбранную объёмную фигуру', () => {
    store.clear();
    menuPick('solid', 'solid-pyramid-5');
    itc.setTool('solid');
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 340, y: 300 }));
    const o = store.items[0];
    return o && o.type === 'shape' && o.shape === 'solid-pyramid-5' ? true : `${o && o.shape}`;
  });

  t('выбор варианта меняет подсказку и содержимое меню', () => {
    const ok = solidBtnEl.dataset.tip === 'Пятиугольная пирамида (C) · ПКМ — другие фигуры' &&
      st.solidVariant === 'solid-pyramid-5' &&
      document.getElementById('stTool').textContent === 'Пятиугольная пирамида';
    return ok ? true : `${solidBtnEl.dataset.tip} / ${st.solidVariant}`;
  });

  t('объёмная фигура ловится внутри и не ловится в углу рамки', () => {
    const o = store.items[0];
    const b = IB.model.boundsOf(o);
    /* геометрия строится в рамке самой фигуры, а не в условной */
    const geo = IB.geom.solidGeometry(o.shape, { x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 });
    const mid = geo.outline.reduce(
      (acc, p) => ({ x: acc.x + p.x / geo.outline.length, y: acc.y + p.y / geo.outline.length }),
      { x: 0, y: 0 });
    const inside = !!IB.hit.hitTest(store, mid, 6);
    /* угол габаритов лежит вне силуэта */
    const cornerMiss = IB.hit.hitTest(store, { x: b.x + 2, y: b.y + 2 }, 6) === null;
    return inside && cornerMiss ? true : `inside=${inside} corner=${cornerMiss}`;
  });

  t('объёмные фигуры переживают сохранение и загрузку', () => {
    store.clear();
    itc.setTool('solid');
    for (const id of ['solid-box', 'solid-prism-3', 'solid-sphere']) {
      menuPick('solid', id);
      itc.setTool('solid');
      gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 260, y: 240 }));
    }
    const parsed = IB.persist.fromText(IB.persist.toText(store, st.view));
    return parsed.items.map((o) => o.shape).join(',') === 'solid-box,solid-prism-3,solid-sphere'
      ? true
      : parsed.items.map((o) => o.shape).join(',');
  });

  t('заливка граней объёмной фигуры не съедает контур', () => {
    store.clear();
    menuPick('solid', 'solid-box');
    itc.setTool('solid');
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 300, y: 260 }));
    const o = store.items[0];
    o.fill = 'solid';
    const painted = IB.paint.paintObjectToDataURL
      ? !!IB.paint.paintObjectToDataURL(store, o)
      : true;
    o.fill = 'none';
    return o.shape === 'solid-box' && painted ? true : `${o.shape}`;
  });

  t('у объёмной фигуры видны блок толщины и режим заливки', () => {
    itc.setTool('solid');
    const shown = Array.from(document.querySelectorAll('.insp-block.visible'))
      .map((b) => b.dataset.for);
    const hasThickness = shown.some((f) => (f || '').split(/\s+/).includes('solid')) &&
      !!document.querySelector('.insp-block.visible #thickness');
    const hasFill = !!document.querySelector('.insp-block.visible .fill-row');
    return hasThickness && hasFill ? true : shown.join(' | ');
  });

  menuPick('solid', 'solid-box');
  store.clear();
  itc.setTool('ellipse');

  /* ---------------- палитра и подсказки у фигур ---------------- */

  t('у каждой фигуры справа показывается та же палитра, что у пера', () => {
    const block = document.getElementById('swatchesInk').closest('.insp-block');
    itc.setTool('pen');
    const penColors = Array.from(document.querySelectorAll('#swatchesInk .swatch'))
      .map((n) => n.dataset.color);
    const bad = [];
    for (const tool of ['rect', 'ellipse', 'triangle', 'solid', 'line', 'arrow']) {
      itc.setTool(tool);
      const shown = block.classList.contains('visible');
      const colors = Array.from(document.querySelectorAll('#swatchesInk .swatch'))
        .map((n) => n.dataset.color);
      if (!shown) bad.push(tool + ': блок скрыт');
      else if (colors.join() !== penColors.join()) bad.push(tool + ': палитра отличается от пера');
    }
    itc.setTool('pen');
    return bad.length === 0 ? true : bad.join(', ');
  });

  t('палитра красит линию и стрелку', () => {
    store.clear();
    const draw = (tool) => {
      itc.setTool(tool);
      document.querySelector('#swatchesInk .swatch[data-color="#FF0000"]').click();
      store.clear();
      gesture(toScreen({ x: 120, y: 120 }), toScreen({ x: 320, y: 260 }));
      return store.items[0];
    };
    const line = draw('line');
    const arrow = draw('arrow');
    const ok = !!line && line.shape === 'line' && line.color === '#FF0000' &&
      !!arrow && arrow.shape === 'arrow' && arrow.color === '#FF0000';
    st.color = '#000000';
    return ok ? true : `линия ${line && line.color}, стрелка ${arrow && arrow.color}`;
  });

  t('палитра фигуры действительно красит её', () => {
    store.clear();
    menuPick('rect', 'rect');
    itc.setTool('rect');
    const target = document.querySelector('#swatchesInk .swatch[data-color="#FF0000"]');
    if (!target) return 'нет красного образца';
    target.click();
    gesture(toScreen({ x: 100, y: 100 }), toScreen({ x: 260, y: 240 }));
    const o = store.items[0];
    const ok = !!o && o.color === '#FF0000';
    app.commands.selectAll();
    return ok ? true : `цвет фигуры ${o && o.color}`;
  });

  t('у фигур видны толщина и режим заливки', () => {
    const thickness = document.getElementById('thickness').closest('.insp-block');
    const fillRow = document.querySelector('.fill-row').closest('.insp-block');
    const tools = ['rect', 'ellipse', 'triangle', 'solid'];
    const bad = [];
    for (const tool of tools) {
      itc.setTool(tool);
      if (!thickness.classList.contains('visible')) bad.push(tool + ': толщина');
      if (!fillRow.classList.contains('visible')) bad.push(tool + ': заливка');
    }
    itc.setTool('pen');
    return bad.length === 0 ? true : bad.join(', ');
  });

  t('подсказка фигуры зовёт правую кнопку мыши', () => {
    const tools = ['rect', 'ellipse', 'triangle', 'solid'];
    const bad = [];
    for (const tool of tools) {
      const btn = document.querySelector(`.tool[data-tool="${tool}"]`);
      const tip = btn.dataset.tip || '';
      const label = btn.getAttribute('aria-label') || '';
      if (!/ПКМ/.test(tip)) bad.push(tool + ': в подсказке нет ПКМ');
      if (!/прав/i.test(label)) bad.push(tool + ': в подсказке для чтения с экрана нет слов�� правая');
    }
    return bad.length === 0 ? true : bad.join(', ');
  });

  t('подсказка следует за выбранным вариантом и сохраняет напоминание', () => {
    menuPick('rect', 'rhombus');
    const tip = document.querySelector('.tool[data-tool="rect"]').dataset.tip;
    menuPick('rect', 'rect');
    const back = document.querySelector('.tool[data-tool="rect"]').dataset.tip;
    const ok = tip.indexOf('Ромб (R)') === 0 && tip.indexOf('ПКМ') > 0 &&
      back.indexOf('Прямоугольник (R)') === 0 && back.indexOf('ПКМ') > 0;
    return ok ? true : `ромб: ${tip} / прямоугольник: ${back}`;
  });

  t('у линии и стрелки подсказка остаётся короткой', () => {
    /* вариантов у них нет, поэтому звать правую кнопку незачем */
    const line = document.querySelector('.tool[data-tool="line"]').dataset.tip || '';
    const arrow = document.querySelector('.tool[data-tool="arrow"]').dataset.tip || '';
    return !/ПКМ/.test(line) && !/ПКМ/.test(arrow) ? true : `line=${line} arrow=${arrow}`;
  });

  t('толщина линии и стрелки настраивается справа', () => {
    const block = document.getElementById('thickness').closest('.insp-block');
    itc.setTool('line');
    const shown = block.classList.contains('visible');
    if (!shown) { itc.setTool('pen'); return 'блок толщины скрыт у линии'; }
    const draw = (tool, w) => {
      itc.setTool(tool);
      document.querySelector(`#thickness .th[data-w="${w}"]`).click();
      store.clear();
      gesture(toScreen({ x: 120, y: 120 }), toScreen({ x: 320, y: 260 }));
      return store.items[0];
    };
    const thinLine = draw('line', 2);
    const thickLine = draw('line', 24);
    const thinArrow = draw('arrow', 4);
    const thickArrow = draw('arrow', 14);
    /* выбранная точка отмечена в блоке толщины */
    const marked = document.querySelector('#thickness .th[data-w="14"]').classList.contains('active');
    st.width = 4;
    itc.setTool('pen');
    const ok = thinLine && thinLine.width === 2 && thickLine && thickLine.width === 24 &&
      thinArrow && thinArrow.width === 4 && thickArrow && thickArrow.width === 14 && marked;
    return ok ? true : `линия ${thinLine && thinLine.width}/${thickLine && thickLine.width}, ` +
      `стрелка ${thinArrow && thinArrow.width}/${thickArrow && thickArrow.width}, отметка=${marked}`;
  });

  t('у каждого инструмента своя толщина', () => {
    /* перо и линия настраиваются независимо: толстая линия не тянет за
       собой перо, и наоборот */
    itc.setTool('line');
    document.querySelector('#thickness .th[data-w="24"]').click();
    const lineWidth = st.width;
    itc.setTool('pen');
    const penAfterSwitch = st.width;
    document.querySelector('#thickness .th[data-w="2"]').click();
    const penWidth = st.width;
    itc.setTool('line');
    const lineBack = st.width;
    itc.setTool('pen');
    const penBack = st.width;
    const ok = lineWidth === 24 && penAfterSwitch !== 24 && penWidth === 2 &&
      lineBack === 24 && penBack === 2;
    return ok ? true
      : `линия ${lineWidth}/${lineBack}, перо ${penAfterSwitch}/${penWidth}/${penBack}`;
  });

  t('толщина каждого инструмента переживает переключения туда-обратно', () => {
    const want = { line: 14, arrow: 8, rect: 24, ellipse: 2 };
    for (const tool of Object.keys(want)) {
      itc.setTool(tool);
      document.querySelector(`#thickness .th[data-w="${want[tool]}"]`).click();
    }
    itc.setTool('select');
    const bad = [];
    for (const tool of Object.keys(want)) {
      itc.setTool(tool);
      if (st.width !== want[tool]) bad.push(`${tool}: ${st.width} вместо ${want[tool]}`);
    }
    const ok = bad.length === 0;
    if (ok) {
      /* и наоборот: инструмент, который не трогали, своего толщину не меняет */
      itc.setTool('pen');
      if (st.width !== 2) bad.push(`перо: ${st.width} вместо 2`);
    }
    itc.setTool('select');
    /* возвращаем исходные значения, чтобы не ломать следующие проверки */
    for (const tool of ['line', 'arrow', 'rect', 'ellipse', 'pen']) {
      itc.setTool(tool);
      document.querySelector('#thickness .th[data-w="4"]').click();
    }
    return ok && !bad.length ? true : bad.join(', ');
  });

  t('толщина фиксируется в настройках', () => {
    itc.setTool('arrow');
    document.querySelector('#thickness .th[data-w="24"]').click();
    const saved = IB.persist.loadPrefs().widths;
    const ok = saved && saved.arrow === 24;
    itc.setTool('arrow');
    document.querySelector('#thickness .th[data-w="4"]').click();
    return ok ? true : `в настройках arrow=${saved && saved.arrow}`;
  });

  t('первая и вторая толщина маркера дают разные линии', () => {
    /* маркер рисуется втрое шире базы: раньше нижний порог 12 склеивал
       пресеты 2 и 4 — оба давали одинаковую линию в 12 пикселей */
    itc.setTool('highlighter');
    const draw = (w) => {
      document.querySelector(`#thickness .th[data-w="${w}"]`).click();
      store.clear();
      fire('pointerdown', 200, 300);
      fire('pointermove', 260, 300);
      fire('pointerup', 260, 300);
      return store.items[0] && store.items[0].width;
    };
    const w2 = draw(2);
    const w4 = draw(4);
    const w8 = draw(8);
    /* возвращаем прежнюю толщину маркера и чистим доску */
    document.querySelector('#thickness .th[data-w="4"]').click();
    store.clear();
    itc.setTool('pen');
    return w2 === 6 && w4 === 12 && w8 === 24 ? true
      : `2→${w2}, 4→${w4}, 8→${w8}`;
  });

  menuPick('rect', 'rect');
  store.clear();
  itc.setTool('pen');

  /* ---------------- щелчок без протяжки ---------------- */

  t('щелчок квадратом даёт квадрат, а кругом — круг', () => {
    app.commands.resetView();
    const click = (tool, variant) => {
      menuPick(tool, variant);
      itc.setTool(tool);
      store.clear();
      const p = toScreen({ x: 400, y: 400 });
      fire('pointerdown', p.x, p.y);
      fire('pointerup', p.x, p.y);
      return store.items[0];
    };
    /* без протяжки рамка по умолчанию 140×100 — привести её к квадрату
       обязан момент отпускания, а не протяжка */
    const sq = click('rect', 'square');
    const ci = click('ellipse', 'circle');
    if (!sq || !ci) return 'фигура не создана';
    const sqW = Math.abs(sq.x2 - sq.x1);
    const sqH = Math.abs(sq.y2 - sq.y1);
    const ciW = Math.abs(ci.x2 - ci.x1);
    const ciH = Math.abs(ci.y2 - ci.y1);
    const sqOk = Math.abs(sqW - sqH) < 1e-9;
    const ciOk = Math.abs(ciW - ciH) < 1e-9;
    return sqOk && ciOk ? true
      : `квадрат ${sqW.toFixed(2)}×${sqH.toFixed(2)}, круг ${ciW.toFixed(2)}×${ciH.toFixed(2)}`;
  });

  t('щелчок равносторонним треугольником даёт равносторонний', () => {
    /* рамка клика по умолчанию 140×100 слишком пологая: настоящая высота
       равностороннего треугольника в неё не влезает, и он сливается с
       равнобедренным. Поэтому клик приводит рамку к квадрату. */
    app.commands.resetView();
    menuPick('triangle', 'triangle-equilateral');
    itc.setTool('triangle');
    store.clear();
    const p = toScreen({ x: 400, y: 400 });
    fire('pointerdown', p.x, p.y);
    fire('pointerup', p.x, p.y);
    const o = store.items[0];
    if (!o) return 'фигура не создана';
    const pts = IB.geom.shapePoints(o.shape, { x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 });
    const base = Math.abs(pts[1].x - pts[0].x);
    const height = Math.abs(pts[2].y - pts[0].y);
    const ratio = height / base;
    const eq = Math.abs(ratio - Math.sqrt(3) / 2) < 1e-9;
    /* и он должен отличаться от равнобедренного при том же щелчке */
    menuPick('triangle', 'triangle-iso');
    itc.setTool('triangle');
    store.clear();
    fire('pointerdown', p.x, p.y);
    fire('pointerup', p.x, p.y);
    const iso = store.items[0];
    const isoPts = IB.geom.shapePoints(iso.shape, { x: iso.x1, y: iso.y1 }, { x: iso.x2, y: iso.y2 });
    const isoHeight = Math.abs(isoPts[2].y - isoPts[0].y);
    const differ = Math.abs(height - isoHeight) > 1;
    menuPick('triangle', 'triangle');
    return eq && differ ? true
      : `равносторонний h/base=${ratio.toFixed(4)}, равнобедренный h=${isoHeight.toFixed(2)}`;
  });

  t('остальные фигуры при щелчке остаются прямоугольником 140×100', () => {
    app.commands.resetView();
    const out = [];
    for (const pair of [['rect', 'rect'], ['ellipse', 'ellipse'],
      ['triangle', 'triangle-iso'], ['solid', 'solid-box']]) {
      menuPick(pair[0], pair[1]);
      itc.setTool(pair[0]);
      store.clear();
      const p = toScreen({ x: 400, y: 400 });
      fire('pointerdown', p.x, p.y);
      fire('pointerup', p.x, p.y);
      const o = store.items[0];
      if (!o) { out.push(pair[1] + ': нет'); continue; }
      const w = Math.abs(o.x2 - o.x1);
      const h = Math.abs(o.y2 - o.y1);
      if (Math.abs(w - 140) > 0.5 || Math.abs(h - 100) > 0.5) {
        out.push(pair[1] + ': ' + w.toFixed(1) + '×' + h.toFixed(1));
      }
    }
    return out.length === 0 ? true : out.join(', ');
  });

  menuPick('ellipse', 'circle');
  itc.setTool('ellipse');

  /* ---------------- аудит геометрии всех вариантов ----------------

     Каждый вариант тянем тремя жестами: вниз-вправо, вверх-влево и по
     диагонали. Смотрим на координаты самого объекта, а не на boundsOf:
     тот добавляет поля обводки и сравнению не поддаётся.

     Равносторонний треугольник — единственное исключение из правила
     «фигура заполняет рамку тяги»: он строится по настоящим пропорциям
     (высота = сторона × √3⁄2), поэтому при тяге 200×100 выходит
     200×173,21. Это сделано намеренно, см. shapePoints. */

  const ownBox = (o) => {
    if (o.type === 'shape' && IB.geom.isPolyShape(o.shape)) {
      const pts = IB.geom.shapePoints(o.shape, { x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 });
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    return {
      x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2),
      w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1),
    };
  };

  const GEOM_DRAGS = [
    { ax: 100, ay: 100, bx: 300, by: 200, w: 200, h: 100 },
    { ax: 300, ay: 200, bx: 100, by: 100, w: 200, h: 100 },
    { ax: 100, ay: 100, bx: 241, by: 241, w: 141, h: 141 },
  ];

  const GEOM_ROWS = [
    ['rect', 'rect', 'fill'], ['rect', 'square', 'square'],
    ['rect', 'rhombus', 'fill'], ['rect', 'parallelogram', 'fill'],
    ['rect', 'trapezoid', 'fill'], ['rect', 'trapezoid-trapezium', 'fill'],
    ['rect', 'trapezoid-iso', 'fill'],
    ['ellipse', 'circle', 'square'], ['ellipse', 'ellipse', 'fill'],
    ['triangle', 'triangle', 'fill'], ['triangle', 'triangle-obtuse', 'fill'],
    ['triangle', 'triangle-scalene', 'fill'], ['triangle', 'triangle-iso', 'fill'],
    ['triangle', 'triangle-equilateral', 'equilateral'],
    ['solid', 'solid-box', 'solid'], ['solid', 'solid-pyramid-3', 'solid'],
    ['solid', 'solid-pyramid-4', 'solid'], ['solid', 'solid-pyramid-5', 'solid'],
    ['solid', 'solid-pyramid-6', 'solid'], ['solid', 'solid-prism-3', 'solid'],
    ['solid', 'solid-prism-4', 'solid'], ['solid', 'solid-prism-5', 'solid'],
    ['solid', 'solid-sphere', 'solid'],
  ];

  const EQ_RATIO = Math.sqrt(3) / 2;

  const auditOne = (tool, variant, kind) => {
    menuPick(tool, variant);
    itc.setTool(tool);
    const notes = [];
    for (const d of GEOM_DRAGS) {
      store.clear();
      gesture(toScreen({ x: d.ax, y: d.ay }), toScreen({ x: d.bx, y: d.by }));
      const o = store.items[0];
      if (!o || o.shape !== variant) { notes.push(`получилась ${o && o.shape}`); continue; }
      const b = ownBox(o);
      if (kind === 'square') {
        if (!(Math.abs(b.w - d.w) < 0.01 && Math.abs(b.h - d.w) < 0.01)) {
          notes.push(`${b.w.toFixed(2)}×${b.h.toFixed(2)}, ждали квадрат ${d.w}`);
        }
      } else if (kind === 'solid') {
        const inside = b.x >= 99.5 && b.y >= 99.5 &&
          b.x + b.w <= 100.5 + d.w && b.y + b.h <= 100.5 + d.h;
        const ratio = b.w / b.h;
        const dragRatio = d.w / d.h;
        if (!inside || Math.abs(ratio - dragRatio) > 0.02) {
          notes.push(`вписана=${inside}, пропорция ${ratio.toFixed(2)} против ${dragRatio.toFixed(2)}`);
        }
      } else if (kind === 'equilateral') {
        const wantH = b.w * EQ_RATIO;
        if (!(Math.abs(b.h - wantH) < 0.01)) {
          notes.push(`высота ${b.h.toFixed(2)}, ждали ${wantH.toFixed(2)}`);
        }
      } else if (!(Math.abs(b.w - d.w) < 0.01 && Math.abs(b.h - d.h) < 0.01)) {
        notes.push(`${b.w.toFixed(2)}×${b.h.toFixed(2)} вместо ${d.w}×${d.h}`);
      }
    }
    return notes;
  };

  t('все фигуры заполняют свою рамку тяги', () => {
    app.commands.resetView();
    const bad = [];
    for (const [tool, variant, kind] of GEOM_ROWS) {
      if (kind === 'equilateral') continue;
      const notes = auditOne(tool, variant, kind);
      if (notes.length) bad.push(tool + '/' + variant + ': ' + notes.join(', '));
    }
    return bad.length === 0 ? true : bad.join(' | ');
  });

  t('квадрат и круг держат пропорции при тяге в любую сторону', () => {
    app.commands.resetView();
    const bad = [];
    for (const [tool, variant] of [['rect', 'square'], ['ellipse', 'circle']]) {
      const notes = auditOne(tool, variant, 'square');
      if (notes.length) bad.push(tool + '/' + variant + ': ' + notes.join(', '));
    }
    return bad.length === 0 ? true : bad.join(' | ');
  });

  t('объёмные фигуры вписываются в рамку и не искажаются', () => {
    app.commands.resetView();
    const bad = [];
    for (const [tool, variant] of GEOM_ROWS.filter((r) => r[2] === 'solid')) {
      const notes = auditOne(tool, variant, 'solid');
      if (notes.length) bad.push(tool + '/' + variant + ': ' + notes.join(', '));
    }
    return bad.length === 0 ? true : bad.join(' | ');
  });

  t('равносторонний треугольник держит настоящие пропорции', () => {
    app.commands.resetView();
    /* основание на всю ширину тяги, высота настоящая — сторона × √3⁄2 —
       либо вся высота рамки, если тяга пологая и треугольник в неё не влез */
    const notes = [];
    for (const d of GEOM_DRAGS) {
      const pts = IB.geom.shapePoints('triangle-equilateral',
        { x: 0, y: 0 }, { x: d.w, y: d.h });
      const base = Math.abs(pts[1].x - pts[0].x);
      const height = Math.abs(pts[2].y - pts[0].y);
      if (Math.abs(base - d.w) > 0.01) notes.push(`основание ${base.toFixed(2)} вместо ${d.w}`);
      const want = Math.min(d.h, (d.w * Math.sqrt(3)) / 2);
      if (Math.abs(height - want) > 0.01) notes.push(`высота ${height.toFixed(2)} вместо ${want.toFixed(2)}`);
    }
    return notes.length === 0 ? true : notes.join(', ');
  });

  t('равносторонний треугольник не прыгает при отпускании кнопки', () => {
    /* Рамка при отпускании обязана совпасть с тем, что было в последний
       кадр протяжки. Раньше она доприводилась до квадрата и треугольник
       разом вырастал уже после того, как указатель отпустили. */
    app.commands.resetView();
    store.clear();
    menuPick('triangle', 'triangle-equilateral');
    itc.setTool('triangle');
    const from = { x: 100, y: 100 };
    const to = { x: 400, y: 250 };
    fire('pointerdown', toScreen(from).x, toScreen(from).y);
    for (let i = 1; i <= 5; i++) {
      const world = {
        x: from.x + ((to.x - from.x) * i) / 5,
        y: from.y + ((to.y - from.y) * i) / 5,
      };
      fire('pointermove', toScreen(world).x, toScreen(world).y);
    }
    const live = itc.getPreview();
    if (!live) return 'нет фигуры в процессе рисования';
    const liveFrame = { w: Math.abs(live.x2 - live.x1), h: Math.abs(live.y2 - live.y1) };
    fire('pointerup', toScreen(to).x, toScreen(to).y);
    const o = store.items[0];
    if (!o) return 'фигура не создана';
    const doneFrame = { w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
    menuPick('triangle', 'triangle');
    const same = Math.abs(liveFrame.w - doneFrame.w) < 1e-9 &&
      Math.abs(liveFrame.h - doneFrame.h) < 1e-9;
    return same ? true
      : `в процессе ${liveFrame.w}×${liveFrame.h}, на доске ${doneFrame.w}×${doneFrame.h}`;
  });

  t('равносторонний треугольник идёт за курсором во всю ширину тяги', () => {
    /* при пологой протяжке треугольник не должен оставаться узким
       посреди рамки — иначе он визуально не следует за указателем */
    app.commands.resetView();
    const wides = [[300, 100], [400, 120], [260, 90]];
    const bad = [];
    for (const [dw, dh] of wides) {
      const pts = IB.geom.shapePoints('triangle-equilateral', { x: 0, y: 0 }, { x: dw, y: dh });
      const xs = pts.map((p) => p.x);
      const span = Math.max(...xs) - Math.min(...xs);
      const fits = Math.max(...pts.map((p) => p.y)) <= dh + 1e-9 &&
        Math.min(...pts.map((p) => p.y)) >= -1e-9;
      if (Math.abs(span - dw) > 0.01) bad.push(`ширина ${span.toFixed(1)} вместо ${dw}`);
      if (!fits) bad.push(`вылез за рамку ${dw}×${dh}`);
    }
    return bad.length === 0 ? true : bad.join(', ');
  });

t('равносторонний заполняет рамку по высоте на пологой тяге', () => {
    /* Осознанное следствие. Основание закреплено на верхней стороне, вершина
       смотрит вниз — как у равнобедренного. Когда тяга пологая, настоящая
       высота равностороннего не влезает и урезается до высоты рамки. На
       высокой рамке высота — настоящая, сторона × √3⁄2. */
    const at = (dw, dh) => IB.geom
      .shapePoints('triangle-equilateral', { x: 0, y: 0 }, { x: dw, y: dh });
    const shallow = at(200, 100);
    const shallowH = Math.max(...shallow.map((p) => p.y)) - Math.min(...shallow.map((p) => p.y));
    const tall = at(200, 300);
    const tallH = Math.max(...tall.map((p) => p.y)) - Math.min(...tall.map((p) => p.y));
    const shallowOk = Math.abs(shallowH - 100) < 1e-9;
    const tallOk = Math.abs(tallH - 200 * Math.sqrt(3) / 2) < 1e-9;
    return shallowOk && tallOk ? true
      : `на пологой высота=${shallowH.toFixed(2)} (ждали 100), на высокой высота=${tallH.toFixed(2)} (ждали ${(200 * Math.sqrt(3) / 2).toFixed(2)})`;
  });

  t('равносторонний треугольник умещается в рамку', () => {
    /* при настоящей высоте вершина уходила за верх тяги — теперь нет */
    const bad = [];
    for (const [dw, dh] of [[200, 150], [140, 100], [300, 100], [100, 300]]) {
      const top = IB.geom.shapePoints('triangle-equilateral', { x: 0, y: 0 }, { x: dw, y: dh });
      const minY = Math.min(...top.map((p) => p.y));
      const maxY = Math.max(...top.map((p) => p.y));
      if (minY < -1e-9 || maxY > dh + 1e-9) bad.push(`${dw}×${dh}: верх ${minY.toFixed(2)}, низ ${maxY.toFixed(2)}`);
    }
    return bad.length === 0 ? true : bad.join(', ');
  });

  store.clear();
  st.selection = [];
  itc.setTool('select');

  /* ---------------- инструмент «Заливка» ---------------- */

  const fillBtn = document.querySelector('.tool[data-tool="fill"]');
  t('кнопка «Заливка» есть в панели инструментов', () =>
    !!fillBtn && fillBtn.dataset.tip === 'Заливка (B)');

  t('цвет заливки и цвет пера не зависят друг от друга', () => {
    /* у каждого инструмента свой цвет: палитра при активной заливке
       меняет только заливку, при перо — только перо */
    const rgb = (el) => getComputedStyle(el).color;
    const hexToRgb = (h) => {
      const n = parseInt(h.slice(1), 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    const penBtn = document.querySelector('.tool[data-tool="pen"]');
    const activeSwatch = () => {
      const a = document.querySelector('#swatchesInk .swatch.active');
      return a && a.dataset.color;
    };
    const savedPen = st.color;
    const savedFill = st.fillColor;
    let fail = '';

    itc.setTool('fill');
    const titleFill = document.getElementById('inkTitle').textContent;
    document.querySelector('#swatchesInk .swatch[data-color="#FF0000"]').click();
    if (st.fillColor !== '#FF0000') fail = `цвет заливки ${st.fillColor}`;
    else if (st.color !== savedPen) fail = `цвет пера сбился на ${st.color}`;
    else if (rgb(penBtn) !== hexToRgb(savedPen)) fail = 'иконка пера перекрасилась от заливки';
    else if (rgb(fillBtn) !== hexToRgb('#FF0000')) fail = `иконка заливки ${rgb(fillBtn)}`;
    else if (activeSwatch() !== '#FF0000') fail = `активный образец ${activeSwatch()}`;

    if (!fail) {
      itc.setTool('pen');
      document.querySelector('#swatchesInk .swatch[data-color="#0000FF"]').click();
      if (st.color !== '#0000FF') fail = `цвет пера ${st.color}`;
      else if (st.fillColor !== '#FF0000') fail = `цвет заливки сбился на ${st.fillColor}`;
      else if (rgb(fillBtn) !== hexToRgb('#FF0000')) fail = 'иконка заливки перекрасилась от пера';
      else if (activeSwatch() !== '#0000FF') fail = `активный образец ${activeSwatch()}`;
    }

    const titlePen = document.getElementById('inkTitle').textContent;
    /* возвращаем исходные цвета: палитра может содержать не всё */
    st.color = savedPen;
    st.fillColor = savedFill;
    ui.syncSwatches();
    if (!fail && titleFill !== 'Цвет заливки') fail = `заголовок при заливке: ${titleFill}`;
    if (!fail && titlePen !== 'Цвет чернил') fail = `заголовок при перо: ${titlePen}`;
    return fail === '' ? true : fail;
  });

  t('цвет заливки переживает настройки', () => {
    itc.setTool('fill');
    const saved = st.fillColor;
    document.querySelector('#swatchesInk .swatch[data-color="#FF8000"]').click();
    const ok = IB.persist.loadPrefs().fillColor === '#FF8000';
    /* возвращаем исходный цвет и записываем его в настройки */
    st.fillColor = saved;
    ui.syncSwatches();
    app.savePrefs();
    return ok ? true : `в настройках fillColor=${IB.persist.loadPrefs().fillColor}`;
  });

  t('клавиша B выбирает инструмент «Заливка»', () => {
    itc.setTool('select');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    return st.tool === 'fill' ? true : `инструмент ${st.tool}`;
  });

  t('у «Заливки» видны палитра цвета и режим заливки', () => {
    itc.setTool('fill');
    const blocks = Array.from(document.querySelectorAll('.insp-block.visible'));
    const hasColors = blocks.some((b) => b.contains(document.getElementById('swatchesInk')));
    const hasFill = blocks.some((b) => b.contains(document.querySelector('.fill-row')));
    return hasColors && hasFill ? true : `цвет=${hasColors} заливка=${hasFill}`;
  });

  t('выбор «Заливки» поднимает режим с «без заливки» до сплошной', () => {
    st.fill = 'none';
    itc.setTool('rect');
    itc.setTool('fill');
    return st.fill === 'solid' ? true : `режим ${st.fill}`;
  });

  /* рисуем фигуру с нужным режимом и потом заливаем кликом изнутри */
  const SHAPE_TOOL = {
    circle: 'ellipse', ellipse: 'ellipse',
    triangle: 'triangle', 'triangle-iso': 'triangle',
  };
  const drawShape = (shapeId, x1, y1, x2, y2, fillMode) => {
    const tool = SHAPE_TOOL[shapeId] || 'rect';
    st.fill = fillMode;
    itc.setTool(tool);
    menuPick(tool, shapeId);
    gesture(toScreen({ x: x1, y: y1 }), toScreen({ x: x2, y: y2 }));
    return store.items[store.items.length - 1];
  };
  const fillClick = (p, alreadyFillTool) => {
    if (!alreadyFillTool) itc.setTool('fill');
    fire('pointerdown', toScreen(p).x, toScreen(p).y);
    fire('pointerup', toScreen(p).x, toScreen(p).y);
  };

  t('клик изнутри пустой фигуры заливает её цветом инструмента', () => {
    store.clear();
    st.color = '#1b1f26';
    const o = drawShape('rect', 100, 100, 300, 220, 'none');
    st.fillColor = '#FF0000';
    fillClick({ x: 200, y: 160 });
    return o.fill === 'solid' && o.fillColor === '#FF0000' && o.color === '#1b1f26'
      ? true : `fill=${o.fill} fillColor=${o.fillColor} color=${o.color}`;
  });

  t('фигура, нарисованная с заливкой, берёт цвет заливки, а обводка — цвет пера', () => {
    store.clear();
    st.color = '#1b1f26';
    st.fillColor = '#00AA55';
    const o = drawShape('rect', 100, 100, 300, 220, 'solid');
    return o.fill === 'solid' && o.fillColor === '#00AA55' && o.color === '#1b1f26'
      ? true : `fillColor=${o.fillColor} color=${o.color}`;
  });

  t('заливка не трогает цвет и толщину обводки', () => {
    store.clear();
    st.color = '#1b1f26';
    const o = drawShape('rect', 100, 100, 300, 220, 'none');
    const before = { color: o.color, width: o.width };
    st.fillColor = '#FF0000';
    fillClick({ x: 200, y: 160 });
    return o.color === before.color && o.width === before.width && o.fillColor === '#FF0000'
      ? true : `color=${o.color} width=${o.width}`;
  });

  t('полупрозрачный режим ставит tint', () => {
    store.clear();
    st.fillColor = '#00AA00';
    const o = drawShape('rect', 100, 100, 300, 220, 'none');
    st.fill = 'tint';
    fillClick({ x: 200, y: 160 });
    return o.fill === 'tint' && o.fillColor === '#00AA00' ? true : `fill=${o.fill}`;
  });

  t('режим «без заливки» снимает заливку', () => {
    store.clear();
    st.color = '#0000FF';
    const o = drawShape('rect', 100, 100, 300, 220, 'solid');
    itc.setTool('fill');
    st.fill = 'none';
    fillClick({ x: 200, y: 160 }, true);
    return o.fill === 'none' && o.fillColor === null ? true : `fill=${o.fill} fillColor=${o.fillColor}`;
  });

  t('заливка работает и для круга, и для треугольника', () => {
    store.clear();
    st.fillColor = '#CC00CC';
    const circle = drawShape('circle', 100, 100, 300, 300, 'none');
    fillClick({ x: 200, y: 200 });
    const tri = drawShape('triangle', 400, 100, 600, 300, 'none');
    fillClick({ x: 450, y: 250 });
    return circle.fill === 'solid' && circle.fillColor === '#CC00CC' &&
      tri.fill === 'solid' && tri.fillColor === '#CC00CC'
      ? true : `circle=${circle.fill} tri=${tri.fill}`;
  });

  t('повторный клик тем же цветом не создаёт лишний шаг истории', () => {
    store.clear();
    st.fillColor = '#112233';
    drawShape('rect', 100, 100, 300, 220, 'none');
    fillClick({ x: 200, y: 160 });
    const s1 = JSON.stringify(store.historyState());
    fillClick({ x: 200, y: 160 });
    return JSON.stringify(store.historyState()) === s1 ? true : 'история выросла';
  });

  t('клик по пустому месту не заливает и не пишет историю', () => {
    store.clear();
    st.color = '#112233';
    const o = drawShape('rect', 100, 100, 300, 220, 'none');
    itc.setTool('fill');
    const s1 = JSON.stringify(store.historyState());
    fire('pointerdown', toScreen({ x: 900, y: 800 }).x, toScreen({ x: 900, y: 800 }).y);
    fire('pointerup', toScreen({ x: 900, y: 800 }).x, toScreen({ x: 900, y: 800 }).y);
    return o.fill === 'none' && JSON.stringify(store.historyState()) === s1 ? true : 'что-то изменилось';
  });

  t('линии и стрелки «Заливка» не трогает', () => {
    store.clear();
    const line = IB.model.createShape('line', { x1: 0, y1: 0, x2: 100, y2: 0, fill: 'none' });
    store._insert([line]);
    const hit = IB.hit.hitFillTarget(store, { x: 50, y: 0 }, 6);
    return hit === null ? true : `попал в ${hit.shape}`;
  });

  t('заливку можно отменить и повторить', () => {
    store.clear();
    st.fillColor = '#445566';
    const o = drawShape('rect', 100, 100, 300, 220, 'none');
    fillClick({ x: 200, y: 160 });
    if (o.fill !== 'solid') return 'не залилось';
    app.commands.undo();
    const undone = o.fill === 'none' && o.fillColor === null;
    app.commands.redo();
    const redone = o.fill === 'solid' && o.fillColor === '#445566';
    return undone && redone ? true : `undo=${undone} redo=${redone}`;
  });

  t('история хранит шаг с названием «Заливка»', () => {
    store.clear();
    st.fillColor = '#778899';
    drawShape('rect', 100, 100, 300, 220, 'none');
    fillClick({ x: 200, y: 160 });
    return store.historyState().undoLabel === 'Заливка' ? true : `шаг ${store.historyState().undoLabel}`;
  });

  t('заливка с отдельным цветом переживает сохранение и загрузку', () => {
    store.clear();
    st.fillColor = '#123456';
    drawShape('rect', 100, 100, 300, 220, 'none');
    fillClick({ x: 200, y: 160 });
    const parsed = IB.persist.fromText(IB.persist.toText(store, st.view));
    const p = parsed.items[0];
    return p && p.fill === 'solid' && p.fillColor === '#123456'
      ? true : `fill=${p && p.fill} fillColor=${p && p.fillColor}`;
  });

  /* ---- заливка области, ограниченной несколькими объектами ---- */

  const drawLine = (x1, y1, x2, y2) => {
    itc.setTool('line');
    gesture(toScreen({ x: x1, y: y1 }), toScreen({ x: x2, y: y2 }));
    return store.items[store.items.length - 1];
  };

  t('треугольник, разделённый линией, заливается по частям', () => {
    store.clear();
    st.color = '#1b1f26';
    const tri = drawShape('triangle-iso', 100, 100, 300, 300, 'none');
    drawLine(200, 100, 200, 300);
    st.fillColor = '#FF8800';
    fillClick({ x: 150, y: 250 });
    const poly = store.items.find((o) => o.shape === 'polygon');
    if (!poly) return 'область не создана';
    const maxX = Math.max(...poly.points.map((p) => p.x));
    return poly.fillColor === '#FF8800' && maxX <= 215 && tri.fill === 'none'
      ? true : `maxX=${maxX.toFixed(1)} tri.fill=${tri.fill} fillColor=${poly.fillColor}`;
  });

  t('залитая область лежит под фигурами, чтобы линия осталась видна', () =>
    store.items[0] && store.items[0].shape === 'polygon'
      ? true : `нижний объект ${store.items[0] && store.items[0].shape}`);

  t('вторая половина заливается отдельной областью', () => {
    st.fillColor = '#0088FF';
    fillClick({ x: 250, y: 250 });
    const polys = store.items.filter((o) => o.shape === 'polygon');
    if (polys.length !== 2) return `областей ${polys.length}`;
    const left = polys.find((p) => Math.max(...p.points.map((q) => q.x)) <= 215);
    const right = polys.find((p) => Math.min(...p.points.map((q) => q.x)) >= 185);
    return left && right ? true : 'не разделилось на две половины';
  });

  t('повторная заливка области меняет цвет, а не создаёт новую', () => {
    st.fillColor = '#00CC00';
    fillClick({ x: 150, y: 250 });
    const polys = store.items.filter((o) => o.shape === 'polygon');
    const left = polys.find((p) => Math.max(...p.points.map((q) => q.x)) <= 215);
    return polys.length === 2 && left && left.fillColor === '#00CC00'
      ? true : `областей ${polys.length} цвет=${left && left.fillColor}`;
  });

  t('заливка области отменяется и повторяется', () => {
    store.clear();
    st.color = '#1b1f26';
    drawShape('triangle-iso', 100, 100, 300, 300, 'none');
    drawLine(200, 100, 200, 300);
    st.fillColor = '#AA0044';
    fillClick({ x: 150, y: 250 });
    const created = store.items.some((o) => o.shape === 'polygon');
    app.commands.undo();
    const gone = !store.items.some((o) => o.shape === 'polygon');
    app.commands.redo();
    const back = store.items.some((o) => o.shape === 'polygon');
    return created && gone && back ? true : `created=${created} gone=${gone} back=${back}`;
  });

  t('область можно залить внутри замкнутого штриха', () => {
    store.clear();
    st.color = '#1b1f26';
    store._insert([IB.model.createStroke({
      points: [
        { x: 100, y: 300 }, { x: 200, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 },
      ],
    })]);
    st.fillColor = '#2255AA';
    fillClick({ x: 200, y: 260 });
    const poly = store.items.find((o) => o.shape === 'polygon');
    return poly && poly.fillColor === '#2255AA' ? true : 'область не создана';
  });

  t('залитая область переживает сохранение и загрузку', () => {
    const parsed = IB.persist.fromText(IB.persist.toText(store, st.view));
    const p = parsed.items.find((o) => o.shape === 'polygon');
    return p && Array.isArray(p.points) && p.points.length >= 3 && p.fillColor === '#2255AA'
      ? true : 'полигон не сохранился';
  });

  /* посторонние объекты далеко не должны coarsen сетку заливки */
  t('посторонние объекты вдалеке не мешают заливке части', () => {
    store.clear();
    st.color = '#1b1f26';
    store._insert([IB.model.createShape('rect', {
      x1: 2000, y1: 2000, x2: 6000, y2: 6000, color: '#888888', fill: 'none',
    })]);
    const tri = drawShape('triangle-iso', 100, 100, 300, 300, 'none');
    drawLine(200, 100, 200, 300);
    st.fillColor = '#33AA66';
    fillClick({ x: 150, y: 250 });
    const poly = store.items.find((o) => o.shape === 'polygon');
    if (!poly) return 'область не создана';
    const maxX = Math.max(...poly.points.map((p) => p.x));
    return maxX <= 215 && tri.fill === 'none'
      ? true : `maxX=${maxX.toFixed(1)} tri.fill=${tri.fill}`;
  });

  t('«без заливки» снимает заливку с разделённой фигуры', () => {
    store.clear();
    st.color = '#1b1f26';
    const tri = drawShape('triangle-iso', 100, 100, 300, 300, 'none');
    drawLine(200, 100, 200, 300);
    /* состояние после прежней ошибки: фигура залита целиком */
    tri.fill = 'solid';
    tri.fillColor = '#33AA66';
    itc.setTool('fill');
    st.fill = 'none';
    fillClick({ x: 150, y: 250 }, true);
    return tri.fill === 'none' && tri.fillColor === null
      ? true : `fill=${tri.fill} fillColor=${tri.fillColor}`;
  });

  t('делитель, не отсекающий часть, не создаёт область', () => {
    store.clear();
    st.color = '#1b1f26';
    const rect = drawShape('rect', 100, 100, 300, 220, 'none');
    /* короткая линия от края внутрь ничего не отделяет */
    drawLine(100, 160, 200, 160);
    st.fillColor = '#AA3311';
    fillClick({ x: 260, y: 160 });
    return rect.fill === 'solid' && !store.items.some((o) => o.shape === 'polygon')
      ? true : `fill=${rect.fill} полигонов=${store.items.filter((o) => o.shape === 'polygon').length}`;
  });

  menuPick('rect', 'rect');
  menuPick('triangle', 'triangle');
  store.clear();
  itc.setTool('ellipse');

  /* ---------------- стирание: контур режется по кругу ----------------
      то, что внутри круга ластика, исчезает; снаружи штрих остаётся */

  store.clear();
  itc.setTool('eraser');
  st.eraserWidth = 30;

  const longStroke = IB.model.createStroke({
    kind: 'pen', color: '#e81123', width: 6,
    points: [{ x: -400, y: 200 }, { x: -300, y: 200 }, { x: -200, y: 200 }, { x: -100, y: 200 }, { x: 0, y: 200 }],
  });
  store._insert([longStroke]);
  app.requestRender();
  const selBeforeErase = st.selection.slice();
  const mid = toScreen({ x: -200, y: 200 });
  fire('pointerdown', mid.x, mid.y);
  t('ластик режет штрих на два обломка уже при нажатии', () => {
    /* круг радиусом 15 вырезает центральный участок: слева и справа
       остаются куски, ни одна точка не попадает внутрь круга */
    const left = store.items.filter((o) => o.type === 'stroke' && o.color === '#e81123');
    const inside = left.some((o) => o.points.some(
      (p) => Math.hypot(p.x - (-200), p.y - 200) < 14.999));
    return store.get(longStroke.id) === null && left.length === 2 && !inside
      ? true : `обломков=${left.length} внутри=${inside}`;
  });
  t('во время стирания история не растёт', () =>
    store.historyState().undoLabel !== 'Стирание');
  fire('pointermove', mid.x + 30, mid.y);
  fire('pointerup', mid.x + 30, mid.y);
  t('после протяжки зазор растёт, а хвосты не возвращаются', () => {
    /* второй круг в 30 правее: зазор становится шире, штрих по-прежнему
       разрезан на два обломка, пустота между ними не заполняется */
    const left = store.items.filter((o) => o.type === 'stroke' && o.color === '#e81123');
    const inside = left.some((o) => o.points.some(
      (p) => (Math.hypot(p.x - (-200), p.y - 200) < 14.999 ||
              Math.hypot(p.x - (-170), p.y - 200) < 14.999)));
    return left.length === 2 && !inside
      ? true : `обломков=${left.length} внутри=${inside}`;
  });
  t('ластик не меняет выделение при стирании', () =>
    JSON.stringify(st.selection) === JSON.stringify(selBeforeErase));

  const shortStroke = IB.model.createStroke({
    kind: 'pen', color: '#0078d4', width: 6,
    points: [{ x: 300, y: 300 }, { x: 320, y: 300 }],
  });
  store._insert([shortStroke]);
  app.requestRender();
  const dp = toScreen({ x: 310, y: 300 });
  fire('pointerdown', dp.x, dp.y);
  fire('pointerup', dp.x, dp.y);
  t('ластик стирает короткий штрих целиком', () => store.get(shortStroke.id) === null);

  app.commands.undo();
  t('отмена возвращает короткий штрих', () => {
    const parts = store.items.filter((o) => o.type === 'stroke' && o.color === '#0078d4');
    return parts.length === 1 && parts[0].points.length === 2;
  });
  app.commands.undo();
  t('отмена возвращает длинный штрих целиком, пять точек', () => {
    const back = store.items.filter((o) => o.type === 'stroke' && o.color === '#e81123');
    return back.length === 1 && back[0].points.length === 5;
  });
  t('возвращённый штрих сохраняет цвет и толщину', () => {
    const back = store.items.filter((o) => o.type === 'stroke' && o.color === '#e81123');
    return back.length === 1 && back[0].width === longStroke.width && back[0].kind === 'pen';
  });
  app.commands.redo();
  app.commands.redo();
  t('повтор стирания снова режет штрих и убирает короткий', () =>
    store.get(longStroke.id) === null &&
    store.items.filter((o) => o.type === 'stroke' && o.color === '#e81123').length === 2 &&
    store.get(shortStroke.id) === null);
  store.clear();

  t('у края штрих подрезается, а не исчезает целиком', () => {
    /* круг радиусом 15 у самого начала срезает только начало штриха */
    const edge = IB.model.createStroke({
      kind: 'pen', color: '#e81123', width: 6,
      points: [{ x: -400, y: 200 }, { x: -300, y: 200 }, { x: -200, y: 200 }, { x: -100, y: 200 }, { x: 0, y: 200 }],
    });
    store.insert([edge]);
    const ep = toScreen({ x: -395, y: 200 });
    fire('pointerdown', ep.x, ep.y);
    fire('pointerup', ep.x, ep.y);
    const left = store.items.filter((o) => o.type === 'stroke' && o.color === '#e81123');
    const pts = left.length === 1 ? left[0].points : [];
    const minX = pts.length ? Math.min.apply(null, pts.map((p) => p.x)) : Infinity;
    return store.get(edge.id) === null && left.length === 1 && minX > -400
      ? true : `обломков=${left.length} minX=${minX}`;
  });
  t('за один жест текст уходит целиком, а штрих и контур режутся', () => {
    store.clear();
    const a = IB.model.createStroke({
      kind: 'pen', color: '#e81123', width: 6,
      points: [{ x: 0, y: 500 }, { x: 300, y: 500 }],
    });
    const b = IB.model.createText({ x: 100, y: 480, text: 'под штрихом', w: 200, h: 40 });
    /* фигура перекрывает штрих: круг ластика задевает и то, и другое */
    const c = IB.model.createShape('ellipse', { x1: 140, y1: 470, x2: 260, y2: 530 });
    store.insert([a, b, c]);
    const sp = toScreen({ x: 150, y: 500 });
    fire('pointerdown', sp.x, sp.y);
    fire('pointerup', sp.x, sp.y);
    /* текст не режется — он уходит целиком; штрих разрезан надвое,
       от контура круга остаются обломки-штрихи */
    const textGone = store.get(b.id) === null;
    const shapeGone = store.get(c.id) === null;
    const strokes = store.items.filter((o) => o.type === 'stroke');
    return textGone && shapeGone && strokes.length >= 3
      ? true : `text=${textGone} shape=${shapeGone} strokes=${strokes.length}`;
  });
  t('объект вне области ластика остаётся на месте', () => {
    store.clear();
    const near = IB.model.createStroke({
      kind: 'pen', color: '#107c10', width: 6,
      points: [{ x: 0, y: 500 }, { x: 300, y: 500 }],
    });
    const far = IB.model.createStroke({
      kind: 'pen', color: '#0078d4', width: 6,
      points: [{ x: 0, y: 800 }, { x: 300, y: 800 }],
    });
    store.insert([near, far]);
    const sp = toScreen({ x: 150, y: 500 });
    fire('pointerdown', sp.x, sp.y);
    fire('pointerup', sp.x, sp.y);
    /* ближний штрих разрезан (оригинала больше), дальний цел */
    const pieces = store.items.filter((o) => o.type === 'stroke' && o.color === '#107c10');
    const res = store.get(near.id) === null && pieces.length === 2 &&
      store.get(far.id) !== null && store.items.length === 3;
    store.clear();
    return res;
  });

  /* стирание при движении: доска меняется сразу, история — один шаг на жест */
  store.insert([IB.model.createStroke({
    kind: 'pen', color: '#107c10', width: 6,
    points: [{ x: 100, y: 200 }, { x: 200, y: 200 }, { x: 300, y: 200 }],
  })]);
  const green = store.items.find((o) => o.color === '#107c10');
  const beforeGesture = store.items.length;
  const gp = toScreen({ x: 200, y: 200 });
  fire('pointerdown', gp.x, gp.y);
  t('ластик стирает сразу при нажатии, до отпускания', () => store.get(green.id) === null);
  t('во время стирания история не меняется', () =>
    store.historyState().undoLabel === 'Добавление' && store.items.length !== beforeGesture);
  fire('pointerup', gp.x, gp.y);
  t('короткое нажатие тоже попадает в историю', () =>
    store.historyState().undoLabel === 'Стирание');
  app.commands.undo();
  t('короткое нажатие отменяется целиком', () => store.get(green.id) !== null);

  /* теперь жест с протяжкой: стирание видно на каждом движении */
  const fresh = IB.model.createStroke({
    kind: 'pen', color: '#107c10', width: 6,
    points: [{ x: 100, y: 300 }, { x: 200, y: 300 }, { x: 300, y: 300 }],
  });
  store.insert([fresh]);
  const mp = toScreen({ x: 120, y: 300 });
  fire('pointerdown', mp.x, mp.y);
  fire('pointermove', mp.x + 40, mp.y);
  t('ластик убирает штрих по ходу движения', () => store.get(fresh.id) === null);
  t('во время жеста история всё ещё не меняется', () =>
    store.historyState().undoLabel === 'Добавление');
  fire('pointermove', mp.x + 120, mp.y);
  fire('pointerup', mp.x + 120, mp.y);
  t('стирание одним жестом добавляет ровно один шаг истории', () =>
    store.historyState().undoLabel === 'Стирание');
  t('жест ластиком отменяется целиком', () => {
    const n = store.items.length;
    app.commands.undo();
    const restored = store.get(fresh.id) !== null;
    app.commands.redo();
    return restored && store.get(fresh.id) === null && store.items.length === n;
  });

  store.clear();

  /* ---------------- линейка и транспортир ---------------- */

  const G = IB.geom;
  const bar = document.getElementById('toolbar-bottom');
  const rulerBtn = bar.querySelector('.tool[data-tool="ruler"]');
  const protBtn = bar.querySelector('.tool[data-tool="protractor"]');
  t('внизу своя панель измерительных инструментов', () => !!bar && !!rulerBtn && !!protBtn);
  t('у линейки и транспортира подсказки с клавишами', () =>
    rulerBtn.dataset.tip === 'Линейка (M)' && protBtn.dataset.tip === 'Транспортир (G)');
  t('иконки линейки и транспортира — линейные svg 20×20', () => {
    const svgs = [rulerBtn.querySelector('svg'), protBtn.querySelector('svg')];
    return svgs.every((s) => s && s.getAttribute('viewBox') === '0 0 20 20');
  });
  t('блок «Образец» удалён из инспектора', () =>
    !document.querySelector('.insp-block[data-for="protractor"] .insp-sample') &&
    !document.querySelector('#inspector img'));

  const penPicks = Array.from(document.querySelectorAll('#toolbar-bottom .pen-pick'));
  t('в нижней панели три ручки', () => penPicks.length === 3);
  t('ручки чёрная, синяя и красная', () =>
    penPicks.map((b) => b.dataset.pen).join(',') === '#000000,#0000FF,#FF0000');
  t('у ручек есть подсказки', () => penPicks.every((b) => b.dataset.tip && b.getAttribute('aria-label')));
  t('иконка ручки — линейный svg 20×20', () =>
    penPicks.every((b) => {
      const s = b.querySelector('svg');
      return s && s.getAttribute('viewBox') === '0 0 20 20';
    }));
  t('цвета ручек заданы переменной', () => {
    const blue = penPicks[1];
    const color = getComputedStyle(blue.querySelector('svg')).color;
    return color === 'rgb(0, 0, 255)';
  });
  t('ручки отделены вертикальной чертой', () => {
    const sep = bar.querySelector('.tool-sep-v:last-of-type');
    if (!sep) return false;
    const cs = getComputedStyle(sep);
    return parseFloat(cs.width) === 1 && parseFloat(cs.height) >= 20;
  });
  /* три ручки — отдельные инструменты с фиксированным цветом */
  t('каждая ручка — отдельный инструмент', () => {
    const ids = ['penBlack', 'penBlue', 'penRed'];
    const names = ['Чёрная ручка', 'Синяя ручка', 'Красная ручка'];
    const ink = document.getElementById('swatchesInk').closest('.insp-block');
    const thick = Array.from(document.querySelectorAll('.insp-block'))
      .find((b) => (b.dataset.for || '').split(/\s+/).includes('penRed'));
    const bad = [];
    for (let i = 0; i < ids.length; i += 1) {
      penPicks[i].click();
      if (st.tool !== ids[i]) bad.push(`${ids[i]}: tool=${st.tool}`);
      if (document.getElementById('stTool').textContent !== names[i]) bad.push(`${ids[i]}: статус`);
      if (!document.getElementById('stage').classList.contains(`tool-${ids[i]}`)) bad.push(`${ids[i]}: stage`);
      if (document.querySelector('#toolbar-bottom .pen-pick.active') !== penPicks[i]) bad.push(`${ids[i]}: не подсвечена`);
      /* палитра для ручек не нужна, толщина — та же, что у пера */
      if (ink.classList.contains('visible')) bad.push(`${ids[i]}: палитра видна`);
      if (!thick || !thick.classList.contains('visible')) bad.push(`${ids[i]}: толщина скрыта`);
    }
    return bad.length === 0 ? true : bad.join(', ');
  });
  t('ручка рисует своим цветом, палитра не меняется', () => {
    store.clear();
    itc.setTool('rect');
    document.querySelector('#swatchesInk .swatch[data-color="#FF0000"]').click();
    if (st.color !== '#FF0000') return 'палитра не применилась: ' + st.color;
    penPicks[1].click(); /* синяя ручка */
    fire('pointerdown', 200, 300);
    fire('pointermove', 280, 340);
    fire('pointerup', 280, 340);
    const stroke = store.items[store.items.length - 1];
    return store.items.length === 1 && stroke.type === 'stroke' && stroke.color === '#0000FF' &&
      st.color === '#FF0000'
      ? true : `штрихов=${store.items.length} цвет=${stroke && stroke.color} палитра=${st.color}`;
  });
  t('«Перо» рисует цветом палитры и её показывает', () => {
    itc.setTool('pen');
    fire('pointerdown', 400, 300);
    fire('pointermove', 460, 340);
    fire('pointerup', 460, 340);
    const stroke = store.items[store.items.length - 1];
    const ink = document.getElementById('swatchesInk').closest('.insp-block');
    return stroke.color === '#FF0000' && ink.classList.contains('visible')
      ? true : `цвет=${stroke && stroke.color} палитра=${ink.classList.contains('visible')}`;
  });
  t('клик по ручке не двигает палитру — они развязаны', () => {
    document.querySelector('#swatchesInk .swatch[data-color="#000000"]').click();
    const before = document.querySelector('#swatchesInk .swatch.active').dataset.color;
    penPicks[2].click(); /* красная: палитра остаётся на своём цвете */
    const active = document.querySelector('#swatchesInk .swatch.active');
    const after = active && active.dataset.color;
    return before === '#000000' && after === '#000000' && st.color === '#000000'
      ? true : `палитра ${before}→${after} цвет=${st.color}`;
  });
  t('выбор ручки виден: подсвечена только нажатая', () => {
    penPicks[1].click(); /* синяя */
    const marked = Array.from(document.querySelectorAll('#toolbar-bottom .pen-pick.active'))
      .map((b) => b.dataset.tool).join(',');
    return marked === 'penBlue' && st.tool === 'penBlue'
      ? true : `инструмент=${st.tool} подсвечена=${marked}`;
  });
  t('«Перо» и ручки — разные инструменты', () => {
    penPicks[0].click();
    document.querySelector('#toolrail .tool[data-tool="pen"]').click();
    const marked = document.querySelectorAll('#toolbar-bottom .pen-pick.active').length;
    return st.tool === 'pen' && marked === 0 &&
      document.getElementById('stTool').textContent === 'Перо'
      ? true : `инструмент=${st.tool} подсвечено ручек=${marked}`;
  });

  /* палитра для пера вернулась и от ручек внизу не зависит */
  t('при перо палитра «Цвет чернил» справа видна', () => {
    itc.setTool('pen');
    const block = document.getElementById('swatchesInk').closest('.insp-block');
    return block.classList.contains('visible');
  });
  t('палитра видна и для текста и фигур, и для пера', () => {
    const block = document.getElementById('swatchesInk').closest('.insp-block');
    const bad = [];
    for (const tool of ['pen', 'text', 'rect', 'fill', 'line']) {
      itc.setTool(tool);
      if (!block.classList.contains('visible')) bad.push(tool + ': скрыта');
    }
    itc.setTool('pen');
    return bad.length === 0 ? true : bad.join(', ');
  });

  t('панель внизу по центру холста', () => {
    const cs = getComputedStyle(bar);
    const box = bar.getBoundingClientRect();
    const stage = document.getElementById('stage').getBoundingClientRect();
    return cs.position === 'absolute' && cs.bottom === '16px' && cs.zIndex === '30' &&
      Math.abs((box.left + box.width / 2) - (stage.left + stage.width / 2)) < 1 &&
      Math.abs(stage.bottom - box.bottom) < 17;
  });

  store.clear();
  itc.setTool('ruler');
  t('линейка появляется в центре холста', () =>
    st.ruler.visible && !st.protractor.visible && st.ruler.x > 0 && st.ruler.y > 0);
  t('нижняя панель показывает активный инструмент', () => rulerBtn.classList.contains('active'));
  t('статус называет инструмент', () => document.getElementById('stTool').textContent === 'Линейка');
  t('блок с подсказкой про инструмент показан в инспекторе', () => {
    const block = Array.from(document.querySelectorAll('.insp-block'))
      .find((b) => (b.dataset.for || '').includes('ruler'));
    return !!block && block.classList.contains('visible');
  });
  t('засечки транспортира идут через 10°', () =>
    Math.abs((G.PROT_STEP * 180) / Math.PI - 10) < 1e-9);

  /* Пиксели транспортира: первая шкала внутри дуги, вторая — снаружи,
     над ней, с зеркальными числами 180° слева до 0° справа. */
  const drawProtractorTo = (inst, guide) => {
    const c = document.createElement('canvas');
    c.width = 560;
    c.height = 460;
    const surf = { canvas: c, ctx: c.getContext('2d'), dpr: 1, width: 560, height: 460 };
    IB.paint.render(surf, {
      store: { items: [] },
      view: { pan: { x: 0, y: 0 }, scale: 1 },
      selection: [],
      preview: null,
      marquee: null,
      eraser: null,
      ruler: Object.assign(G.newInstrument(), { visible: false }),
      protractor: inst,
      protractorGuide: guide,
      showGrid: false,
      showCells: false,
      hoveredId: null,
    });
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    /* кольцо тёмных пикселей вокруг центра транспортира */
    const ring = (from, to, level) => {
      let n = 0;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (!(d[i] < level && d[i + 1] < level && d[i + 2] < level)) continue;
          const rad = Math.hypot(x - inst.x, y - inst.y);
          if (rad >= from && rad <= to) n++;
        }
      }
      return n;
    };
    return ring;
  };

  const prRing = drawProtractorTo(Object.assign(G.newInstrument(),
    { x: 280, y: 380, angle: 0, visible: true }), false);
  t('первая шкала осталась внутри дуги', () => {
    const n = prRing(G.PROT_R - 34, G.PROT_R - 8, 150);
    return n > 60 ? true : `пикселей ${n}`;
  });
  t('вторая шкала нарисована над дугой', () => {
    const n = prRing(G.PROT_R + 12, G.PROT_R + 34, 150);
    return n > 60 ? true : `пикселей над дугой ${n}`;
  });
  t('вторая шкала видна и в режиме обучения', () => {
    const ring = drawProtractorTo(Object.assign(G.newInstrument(),
      { x: 280, y: 380, angle: 0, visible: true }), true);
    const n = ring(G.PROT_R + 12, G.PROT_R + 34, 215);
    return n > 60 ? true : `пикселей над дугой ${n}`;
  });

  st.ruler.angle = Math.PI / 6;
  st.ruler.x = 980;
  st.ruler.y = 120;
  const rFrom = toScreen({ x: -60, y: 0 });
  const rTo = toScreen({ x: 40, y: 57.7 });
  gesture(rFrom, rTo);
  const rLine = store.items.find((o) => o.type === 'shape');
  t('линейка рисует прямую параллельно себе', () => {
    const a = Math.atan2(rLine.y2 - rLine.y1, rLine.x2 - rLine.x1);
    return Math.abs(a - st.ruler.angle) < 1e-6;
  });
  t('линейка берёт длину по проекции', () =>
    Math.abs(Math.hypot(rLine.x2 - rLine.x1, rLine.y2 - rLine.y1) - 115.4) < 1);
  t('линейка не оставляет подписей на доске', () =>
    store.items.length === 1 && store.items[0].type === 'shape');
  t('линейка сохраняет цвет и толщину чернил', () => rLine.color === st.color && rLine.width === st.width);
  t('линия линейки — один шаг истории', () =>
    store.historyState().undoLabel === 'Добавление' && store.items.length === 1);
  app.commands.undo();
  t('отмена убирает линию', () => store.isEmpty());
  app.commands.redo();
  t('повтор возвращает линию', () => store.items.length === 1);

  const rotHandle = G.instrumentPoint(G.instrumentHandle('ruler'), st.ruler);
  gesture(rotHandle, { x: st.ruler.x, y: st.ruler.y - 220 });
  t('ручка вращает линейку', () => Math.abs(st.ruler.angle + Math.PI / 2) < 0.01);
const rBefore = { x: st.ruler.x, y: st.ruler.y };
  gesture({ x: rBefore.x, y: rBefore.y }, { x: rBefore.x + 130, y: rBefore.y + 50 });
  t('корпус линейки перетаскивается', () =>
    Math.abs(st.ruler.x - Math.round(rBefore.x + 130)) <= 1 &&
    Math.abs(st.ruler.y - Math.round(rBefore.y + 50)) <= 1);
  t('перенос линейки не создаёт объектов', () => store.items.length === 1);

  itc.setTool('protractor');
  st.protractor.x = 120;
  st.protractor.y = 620;
  t('транспортир показывается, линейка прячется', () => st.protractor.visible && !st.ruler.visible);
  t('нижняя панель переключает активную кнопку', () =>
    protBtn.classList.contains('active') && !rulerBtn.classList.contains('active'));
  gesture(toScreen({ x: -60, y: 100 }), toScreen({ x: 20, y: 179 }));
  const pLine = store.items.find((o) => o.type === 'shape');
  const pAngle = Math.atan2(pLine.y2 - pLine.y1, pLine.x2 - pLine.x1);
  t('транспортир держит угол кратный 10°', () =>
    Math.abs(pAngle / (Math.PI / 18) - Math.round(pAngle / (Math.PI / 18))) < 1e-9);
  t('транспортир не оставляет подписей на доске', () =>
    store.items.length === 2 && store.items.every((o) => o.type === 'shape'));

  app.commands.undo();
  app.commands.undo();
  t('обе линии отменяются по одной', () => store.isEmpty());

  itc.setTool('ruler');
  gesture(toScreen({ x: 0, y: 0 }), toScreen({ x: 2, y: 0 }));
  t('щелчок без протяжки ничего не рисует', () => store.isEmpty());
  gesture({ x: st.ruler.x, y: st.ruler.y }, { x: st.ruler.x + 60, y: st.ruler.y });
  t('щелчок по самому инструменту не рисует линию', () => store.isEmpty());

  itc.setTool('pen');
  t('смена инструмента прячет направляющие', () => !st.ruler.visible && !st.protractor.visible);
  t('направляющие не попадают в файл доски', () => !JSON.stringify(store.items).includes('ruler'));
  t('подписи замера больше не рисуются', () => !('measure' in st));

  /* ---------------- режим обучения транспортиром ---------------- */

  const learnBtn = document.getElementById('btnProtractorLearn');
  t('у транспортира есть кнопка «Пользование транспортиром»', () =>
    !!learnBtn && learnBtn.textContent.trim() === 'Пользование транспортиром');
  const learnBlock = learnBtn && learnBtn.closest('.insp-block');
  t('кнопка обучения живёт в блоке только для транспортира', () =>
    !!learnBlock && learnBlock.dataset.for.trim() === 'protractor');

  itc.setTool('protractor');
  t('блок обучения показан у транспортира и спрятан у пера', () => {
    const onProtractor = learnBlock.classList.contains('visible');
    itc.setTool('pen');
    const onPen = learnBlock.classList.contains('visible');
    itc.setTool('protractor');
    return onProtractor && !onPen ? true : `protractor=${onProtractor} pen=${onPen}`;
  });
  t('надпись в кнопке обучения помещается целиком', () => {
    if (!learnBtn) return 'нет кнопки';
    const insp = document.getElementById('inspector');
    if (learnBtn.getBoundingClientRect().right > insp.getBoundingClientRect().right + 0.5) {
      return 'кнопка шире инспектора';
    }
    /* текст переносится, поэтому высота кнопки растёт, а обрезать его нечем */
    if (learnBtn.scrollHeight > learnBtn.clientHeight + 1) {
      return `текст обрезан: ${learnBtn.scrollHeight} > ${learnBtn.clientHeight}`;
    }
    if (learnBtn.getBoundingClientRect().height < 32) return 'кнопка ниже 32px';
    return true;
  });

  const protBefore = store.items.length;
  learnBtn.click();
  t('включение режима помечает кнопку активной', () =>
    st.protractorLearn === true && learnBtn.classList.contains('active'));
  t('включение режима не добавляет объекты на доску', () => store.items.length === protBefore);

  itc.setTool('pen');
  t('в режиме обучения транспортир остаётся под пером', () =>
    st.protractorLearn === true && st.protractor.visible === true);

  st.protractor.x = 300;
  st.protractor.y = 400;
  t('пером рисуется поверх транспортира', () => {
    const n0 = store.items.length;
    gesture(toScreen({ x: 250, y: 350 }), toScreen({ x: 350, y: 330 }));
    return store.items.length === n0 + 1 ? true : `прибавилось ${store.items.length - n0}`;
  });
  t('маркером тоже рисуется поверх транспортира', () => {
    itc.setTool('highlighter');
    const n0 = store.items.length;
    gesture(toScreen({ x: 250, y: 450 }), toScreen({ x: 350, y: 470 }));
    const ok = store.items.length === n0 + 1;
    itc.setTool('pen');
    return ok;
  });

  const gBefore = { x: st.protractor.x, y: st.protractor.y };
  t('Alt + перетаскивание двигает транспортир под пером', () => {
    const n0 = store.items.length;
    const from = { x: gBefore.x + 90, y: gBefore.y - 90 };
    fire('pointerdown', from.x, from.y, { altKey: true });
    fire('pointermove', from.x + 60, from.y + 30, { altKey: true });
    fire('pointerup', from.x + 60, from.y + 30, { altKey: true });
    const moved = Math.abs(st.protractor.x - (gBefore.x + 60)) <= 1
      && Math.abs(st.protractor.y - (gBefore.y + 30)) <= 1;
    return moved && store.items.length === n0
      ? true
      : `позиция ${st.protractor.x},${st.protractor.y}, штрихов +${store.items.length - n0}`;
  });

  t('Alt + перетаскивание вращает транспортир за синюю ручку', () => {
    const handle = G.instrumentPoint(G.instrumentHandle('protractor'), st.protractor);
    const to = { x: handle.x + 120, y: handle.y + 60 };
    fire('pointerdown', handle.x, handle.y, { altKey: true });
    fire('pointermove', to.x, to.y, { altKey: true });
    fire('pointerup', to.x, to.y, { altKey: true });
    const want = Math.atan2(to.y - st.protractor.y, to.x - st.protractor.x);
    return Math.abs(st.protractor.angle - want) < 1e-9
      ? true
      : `угол ${st.protractor.angle}, ждали ${want}`;
  });

  t('перенос транспортира не создаёт объектов и шагов истории', () => {
    const n0 = store.items.length;
    const from = { x: st.protractor.x + 90, y: st.protractor.y - 90 };
    fire('pointerdown', from.x, from.y, { altKey: true });
    fire('pointermove', from.x - 40, from.y, { altKey: true });
    fire('pointerup', from.x - 40, from.y, { altKey: true });
    return store.items.length === n0;
  });

  t('транспортир обучения не попадает в файл доски', () =>
    !JSON.stringify(store.items).includes('protractor'));

  learnBtn.click();
  t('выключение режима снимает отметку и прячет транспортир', () =>
    st.protractorLearn === false &&
    !learnBtn.classList.contains('active') &&
    st.protractor.visible === false ? true
      : `learn=${st.protractorLearn} active=${learnBtn.classList.contains('active')} visible=${st.protractor.visible}`);

  itc.setTool('rect');

  /* ---------------- рука: перетаскивание холста ---------------- */

  const panBtn = bar.querySelector('.tool[data-tool="pan"]');
  const imgBtn = bar.querySelector('#toolbar-bottom .tool[data-cmd="insertImage"]');
  t('внизу есть кнопка руки', () => !!panBtn && panBtn.dataset.tip.indexOf('Рука') === 0);
  t('внизу есть кнопка вставки картинки', () =>
    !!imgBtn && imgBtn.dataset.tip.indexOf('картинку') > 0 && !!imgBtn.querySelector('svg'));
  t('иконки руки и картинки — линейные svg 20×20', () =>
    [panBtn, imgBtn].every((b) => {
      const s = b.querySelector('svg');
      return s && s.getAttribute('viewBox') === '0 0 20 20';
    }));

  store.clear();
  itc.setTool('pan');
  t('рука выбирается и подсвечивается в нижней панели', () =>
    st.tool === 'pan' && panBtn.classList.contains('active') &&
    document.getElementById('stTool').textContent === 'Рука');
  t('курсор над холстом — рука', () =>
    getComputedStyle(document.getElementById('board')).cursor === 'grab');

  const handStart = { ...st.view.pan };
  const handScale = st.view.scale;
  gesture({ x: 400, y: 300 }, { x: 460, y: 340 });
  t('рука двигает холст за указателем', () =>
    Math.abs(st.view.pan.x - (handStart.x + 60)) < 1 && Math.abs(st.view.pan.y - (handStart.y + 40)) < 1);
  t('перенос холста не меняет масштаб', () => st.view.scale === handScale);
  t('перенос холста не создаёт объектов и шагов истории', () =>
    store.isEmpty() && !store.historyState().canUndo);
  t('рука ничего не стирает', () => !st.eraser);

  itc.setTool('pen');
  gesture(toScreen({ x: -100, y: -60 }), toScreen({ x: 40, y: 20 }));
  t('после руки перо снова рисует', () => store.items.length === 1);
  app.commands.undo();
  const idlePan = { ...st.view.pan };
  itc.setTool('pan');
  gesture({ x: 300, y: 200 }, { x: 300, y: 200 });
  t('короткий клик рукой не двигает холст', () =>
    Math.abs(st.view.pan.x - idlePan.x) < 1e-9 && store.isEmpty());
  itc.setTool('pen');

  /* ---------------- картинки ---------------- */

  /* настоящий PNG 4×4, чтобы проверка шла через реальный декодер браузера */
  const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';
  /* и заметная плашка 40×24 — с ней удобно проверять перенос и растяжение */
  const solidCanvas = document.createElement('canvas');
  solidCanvas.width = 40;
  solidCanvas.height = 24;
  const solidCtx = solidCanvas.getContext('2d');
  solidCtx.fillStyle = '#e81123';
  solidCtx.fillRect(0, 0, 40, 24);
  const solidUrl = solidCanvas.toDataURL('image/png');

  store.clear();
  itc.setTool('select');
  t('модель умеет картинки', () => {
    const img = IB.model.createImage({ src: pngDataUrl, name: 'точка.png' });
    return img.type === 'image' && IB.model.isSupported(img) &&
      IB.model.boundsOf(img).w === img.w;
  });
  t('картинка — поддерживаемый тип для доски и буфера', () =>
    IB.model.isSupported({ type: 'image' }) && !IB.model.isSupported({ type: 'sticky' }));

  const inserted = await itc.insertImage(pngDataUrl, 'точка.png');
  t('картинка вставляется на доску', () =>
    !!inserted && store.items.length === 1 && store.items[0].type === 'image');
  t('вставленная картинка выделена', () => st.selection.length === 1 && st.selection[0] === inserted.id);
  t('размер картинки взят у файла', () =>
    inserted.naturalW === 4 && inserted.naturalH === 4 && inserted.w === 4 && inserted.h === 4);
  t('картинка стоит по центру текущего вида', () => {
    const b = IB.model.boundsOf(inserted);
    const center = G.toWorld({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }, st.view);
    return Math.abs(b.x + b.w / 2 - center.x) < 1 && Math.abs(b.y + b.h / 2 - center.y) < 1;
  });
  store.clear();

  /* дальше работаем с плашкой: её видно и за неё не цепляются хэндлы */
  const pic = await itc.insertImage(solidUrl, 'плашка.png');
  t('плашка вставлена и выделена', () =>
    !!pic && pic.naturalW === 40 && pic.naturalH === 24 && st.selection.length === 1);
  await t('картинка декодируется браузером', async () => {
    await IB.paint.imagesReady(store.items);
    return true;
  });

  const picCenter = (obj) => G.toScreen({ x: obj.x + obj.w / 2, y: obj.y + obj.h / 2 }, st.view);
  const centerBefore = { ...pic };
  gesture(picCenter(centerBefore), picCenter(centerBefore));
  t('клик выбирает картинку', () => st.selection.length === 1 && st.selection[0] === pic.id);

  /* сдвиг задаём в экранных пикселях, поэтому пересчитываем ожидание в world:
     к этому моменту тест уже крутил масштаб колёсиком */
  const k = st.view.scale;
  const dragFrom = { x: picCenter(pic).x, y: picCenter(pic).y };
  gesture(dragFrom, { x: dragFrom.x + 60, y: dragFrom.y + 40 });
  const movedPic = store.get(pic.id);
  t('картинку можно перетащить', () =>
    Math.abs(movedPic.x - (centerBefore.x + 60 / k)) < 1 &&
    Math.abs(movedPic.y - (centerBefore.y + 40 / k)) < 1);
  t('перенос картинки — один шаг истории', () => store.historyState().undoLabel === 'Перемещение');
  app.commands.undo();
  t('отмена возвращает картинку на место', () =>
    Math.abs(store.get(pic.id).x - centerBefore.x) < 1 && store.items.length === 1);
  app.commands.redo();

  const beforeResize = { w: pic.w, h: pic.h };
  const handle = G.handlePoints(G.viewToScreenRect(IB.model.boundsOf(store.get(pic.id)), st.view)).se;
  gesture(handle, { x: handle.x + 40, y: handle.y + 40 });
  const afterResize = store.get(pic.id);
  t('картинку можно растянуть за угол', () =>
    afterResize.w > beforeResize.w && afterResize.h > beforeResize.h);
  t('размер картинки не перевернёлся', () => afterResize.w > 0 && afterResize.h > 0);
  app.commands.undo();
  app.commands.undo();

  t('картинка попадает под прямоугольное выделение', () =>
    store.items.length === 1 &&
    IB.hit.objectsInRect(store, IB.model.boundsOf(store.items[0]), false).length === 1);
  t('ластик не удаляет картинку', () => {
    itc.setTool('eraser');
    st.eraserWidth = 40;
    const at = picCenter(store.get(pic.id));
    fire('pointerdown', at.x, at.y);
    fire('pointerup', at.x, at.y);
    const kept = store.items.length === 1 && !!store.get(pic.id);
    const noStep = store.historyState().undoLabel !== 'Стирание';
    return kept && noStep
      ? true : `осталось=${store.items.length} шаг=${store.historyState().undoLabel}`;
  });
  /* картинка не мешает стирать: штрих под ней уходит, сама она цела */
  t('ластик стирает штрих под картинкой, картинка остаётся', () => {
    const at = picCenter(store.get(pic.id));
    const w = G.toWorld(at, st.view);
    const cross = IB.model.createStroke({
      kind: 'pen', color: '#e81123', width: 6,
      points: [{ x: w.x - 300, y: w.y }, { x: w.x + 300, y: w.y }],
    });
    const keep = store.items.slice();
    store._insert([cross]);
    itc.setTool('eraser');
    st.eraserWidth = 30;
    fire('pointerdown', at.x, at.y);
    fire('pointerup', at.x, at.y);
    const strokeGone = store.get(cross.id) === null;
    const parts = store.items.filter((o) => o.type === 'stroke').length;
    const picOk = !!store.get(pic.id) && store.items.length === parts + 1;
    store._replace(keep); /* доска возвращается к одной картинке */
    return strokeGone && picOk
      ? true : `штрих=${strokeGone} обломков=${parts} картинка=${picOk}`;
  });

  t('картинка переживает сохранение и открытие', () => {
    const text = IB.persist.toText(store, st.view);
    const back = IB.persist.fromText(text);
    const img = back.items.find((o) => o.type === 'image');
    return !!img && img.src === solidUrl && img.naturalW === 40;
  });
  /* выделяем именно картинку: иначе в буфер попадёт всё, что было выделено раньше */
  st.selection = [pic.id];
  app.commands.copy();
  t('картинка попала в буфер обмена', () =>
    st.clipboard && st.clipboard.items.length === 1 && st.clipboard.items[0].type === 'image');
  app.commands.paste();
  t('картинка копируется и вставляется', () =>
    store.items.length === 2 && store.items.every((o) => o.type === 'image'));
  /* после дублирования выделены только копии: удаление убирает их, оригинал остаётся */
  t('картинка дублируется и удаляется', () => {
    app.commands.deleteSelection();
    app.commands.selectAll();
    app.commands.duplicate();
    const afterDuplicate = store.items.length;
    app.commands.deleteSelection();
    const afterCopies = store.items.length;
    app.commands.selectAll();
    app.commands.deleteSelection();
    return afterDuplicate === 2 && afterCopies === 1 && store.isEmpty();
  });

  /* картинка рисуется на холсте: после декодирования пиксель в её центре
     совпадает с цветом, который мы туда положили */
  store.clear();
  const painted = await itc.insertImage(solidUrl, 'плашка.png');
  await IB.paint.imagesReady(store.items);
  app.requestRender();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  t('картинка действительно рисуется на холсте', () => {
    const b = IB.model.boundsOf(painted);
    const cx = document.querySelector('#board').getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const pt = G.toScreen({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, st.view);
    const px = cx.getImageData(Math.round(pt.x * dpr), Math.round(pt.y * dpr), 1, 1).data;
    return px[0] > 180 && px[1] < 80 && px[2] < 80;
  });
  t('размер картинки при вставке ограничен', () => painted.w <= 640 && painted.h <= 640);
  store.clear();

  /* рука должна панорамировать холст, даже если под курсором выделенная картинка */
  const handPic = await itc.insertImage(solidUrl, 'плашка.png');
  itc.setTool('select');
  gesture(picCenter(handPic), picCenter(handPic));
  t('картинка выделена перед проверкой руки', () => st.selection.length === 1);
  itc.setTool('pan');
  const panBeforePic = { ...st.view.pan };
  const picBefore = { x: handPic.x, y: handPic.y };
  const screenBefore = picCenter(handPic);
  gesture(picCenter(handPic), { x: picCenter(handPic).x + 70, y: picCenter(handPic).y + 50 });
  const picAfter = store.get(handPic.id);
  const screenAfter = picCenter(picAfter);
  t('рука не панорамирует, когда схвачена картинка', () =>
    Math.abs(st.view.pan.x - panBeforePic.x) < 1e-9 && Math.abs(st.view.pan.y - panBeforePic.y) < 1e-9);
  t('рукой выделенная картинка едет по доске', () =>
    Math.abs(picAfter.x - (picBefore.x + 70 / st.view.scale)) < 1 &&
    Math.abs(picAfter.y - (picBefore.y + 50 / st.view.scale)) < 1);
  t('картинка остаётся под курсором', () =>
    Math.abs(screenAfter.x - (screenBefore.x + 70)) < 1 &&
    Math.abs(screenAfter.y - (screenBefore.y + 50)) < 1);
  t('картинка остаётся выделенной после переноса рукой', () => st.selection.length === 1);
  t('перенос рукой не меняет содержимое доски', () =>
    store.items.length === 1 && store.items[0].type === 'image');
  t('перенос рукой записывается в историю', () => store.historyState().canUndo);
  app.commands.undo();
  t('перенос картинки рукой отменяется', () =>
    Math.abs(store.get(handPic.id).x - picBefore.x) < 1e-9 &&
    Math.abs(store.get(handPic.id).y - picBefore.y) < 1e-9);

  /* рука по-прежнему тянет холст, если под курсором не выделенного объекта */
  gesture({ x: 40, y: 40 }, { x: 100, y: 80 });
  t('рука тянет холст мимо выделенной картинки', () =>
    Math.abs(st.view.pan.x - (panBeforePic.x + 60)) < 1 &&
    Math.abs(st.view.pan.y - (panBeforePic.y + 40)) < 1);
  t('панорамирование мимо картинки её не двигает', () =>
    Math.abs(store.get(handPic.id).x - picBefore.x) < 1e-9 &&
    Math.abs(store.get(handPic.id).y - picBefore.y) < 1e-9);
  store.clear();
  itc.setTool('pen');

  /* тот же захват через настоящий клик по кнопке «Рука» и нескольких pointermove */
  const handPic2 = await itc.insertImage(solidUrl, 'плашка.png');
  itc.setTool('select');
  gesture(picCenter(handPic2), picCenter(handPic2));
  panBtn.click();
  t('клик по кнопке «Рука» включает инструмент', () => st.tool === 'pan');
  const panReal = { ...st.view.pan };
  const worldReal = { x: handPic2.x, y: handPic2.y };
  const c0 = picCenter(handPic2);
  fire('pointerdown', c0.x, c0.y);
  for (let i = 1; i <= 5; i += 1) fire('pointermove', c0.x + 20 * i, c0.y + 15 * i);
  fire('pointerup', c0.x + 100, c0.y + 75);
  const picReal = store.get(handPic2.id);
  t('через кнопку «Рука» холст не едет, едет картинка', () =>
    Math.abs(st.view.pan.x - panReal.x) < 1e-9 && Math.abs(st.view.pan.y - panReal.y) < 1e-9 &&
    Math.abs(picReal.x - (worldReal.x + 100 / st.view.scale)) < 1 &&
    Math.abs(picReal.y - (worldReal.y + 75 / st.view.scale)) < 1);
  store.clear();
  itc.setTool('pen');

  const bad = await itc.insertImage('data:image/png;base64,не-base64', 'битая.png');
  t('битая картинка не попадает на доску', () => bad === null && store.isEmpty());
  t('подсказка об ошибке показана', () => !document.getElementById('toast').hidden);

  /* «Очистить доску» из меню ластика */
  store.clear();
  itc.setTool('pen');
  gesture(toScreen({ x: -320, y: 120 }), toScreen({ x: -140, y: 180 }));
  store.insert([IB.model.createText({ x: 20, y: 20, text: 'текст на доске', w: 200, h: 40 })]);
  store.insert([IB.model.createImage({ src: pastePng, name: 'pic.png' })]);
  const fillCount = store.items.length;
  t('перед очисткой на доске штрих, текст и картинка', () =>
    fillCount === 3 && new Set(store.items.map((o) => o.type)).size === 3);

  itc.setTool('eraser');
  document.querySelector('[data-cmd="clearBoard"]').click();
  t('кнопка «Очистить доску» удаляет всё', () => store.isEmpty());
  t('очистка доски — один шаг истории', () =>
    store.historyState().undoLabel === 'Очистка доски' && store.historyState().canUndo);

  app.commands.undo();
  t('очистка доски отменяется одним Ctrl+Z', () =>
    store.items.length === fillCount &&
    store.items.some((o) => o.type === 'stroke') &&
    store.items.some((o) => o.type === 'text') &&
    store.items.some((o) => o.type === 'image'));
  app.commands.redo();
  t('повтор очистки снова удаляет всё', () => store.isEmpty());
  app.commands.undo();

  st.selection = [store.items[0].id];
  document.querySelector('[data-cmd="clearBoard"]').click();
  t('очистка доски снимает выделение', () => store.isEmpty() && st.selection.length === 0);
  app.commands.undo();

  store.clear();
  const clearedEmpty = app.commands.clearBoard();
  t('очистка пустой доски ничего не ломает', () => store.isEmpty() && !store.historyState().canUndo);
  t('очистка пустой доски не добавляет шаг истории', () => clearedEmpty === 0);
  t('очистка пустой доски показывает подсказку', () =>
    /пуста/i.test(document.getElementById('toast').textContent));
  store.clear();
  itc.setTool('pen');

  /* Ctrl+V: в буфере лежит картинка — она должна стать объектом доски */
  st.clipboard = null;
  /* системный буфер тоже чистим: копирование выше положило туда JSON доски */
  await window.inkboard.writeClipboard({ text: '', imageDataUrl: pastePng });
  await app.commands.paste();
  t('картинка из буфера вставляется как объект', () =>
    store.items.length === 1 && store.items[0].type === 'image' &&
    store.items[0].naturalW === 4);
  t('вставленная из буфера картинка выделена', () => st.selection.length === 1);
  store.clear();

  /* Ctrl+V из внешнего источника: обычный текст */
  itc.setTool('pen');
  document.querySelector('#swatchesInk .swatch[data-color="#FF0000"]').click();
  await t('текст из буфера вставляется как объект', async () => {
    st.selection = [];
    st.clipboard = null;
    const kind = await itc.pasteContent({ text: 'Привет из буфера' });
    const obj = store.items[0];
    return kind === 'text' && store.items.length === 1 && obj.type === 'text' &&
      obj.text === 'Привет из буфера';
  });
  t('вставленный текст выделен и виден', () => {
    const obj = store.items[0];
    return st.selection.length === 1 && st.selection[0] === obj.id &&
      obj.h > 0 && obj.w >= 60 && isFinite(obj.x) && isFinite(obj.y);
  });
  t('вставленный текст берёт цвет и размер инструмента', () => {
    const obj = store.items[0];
    return obj.color === '#FF0000' && obj.fontSize > 0;
  });
  store.clear();

  await t('Ctrl+V: событие paste вставляет текст', async () => {
    st.selection = [];
    st.clipboard = null;
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Событие вставки');
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    return store.items.length === 1 && store.items[0].type === 'text' &&
      store.items[0].text === 'Событие вставки';
  });
  store.clear();

  await t('Ctrl+V: картинка из файла вставляется как объект', async () => {
    st.selection = [];
    st.clipboard = null;
    const bin = atob(pastePngBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'из буфера.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    const obj = store.items[0];
    return store.items.length === 1 && obj.type === 'image' && obj.naturalW === 4;
  });
  store.clear();

  await t('Ctrl+V: картинка из HTML вставляется как объект', async () => {
    st.selection = [];
    st.clipboard = null;
    const dt = new DataTransfer();
    dt.setData('text/html', `<p>caption</p><img src="data:image/png;base64,${pastePngBase64}">`);
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    return store.items.length === 1 && store.items[0].type === 'image' &&
      store.items[0].naturalW === 4;
  });
  store.clear();

  await t('Ctrl+V: многострочный текст становится несколькими объектами', async () => {
    st.selection = [];
    st.clipboard = null;
    const dt = new DataTransfer();
    dt.setData('text/plain', 'первая\nвторая\nтретья');
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    const texts = store.items.filter((o) => o.type === 'text');
    return texts.length === 3 && texts.map((o) => o.text).join(',') === 'первая,вторая,третья' &&
      /* строки не наезжают друг на друга */
      texts[1].y > texts[0].y;
  });
  store.clear();

  await t('Ctrl+V: объекты доски из буфера вставляются как раньше', async () => {
    st.selection = [];
    st.clipboard = null;
    const dt = new DataTransfer();
    dt.setData('text/plain', JSON.stringify({
      format: IB.persist.FORMAT, version: IB.persist.VERSION,
      items: [IB.model.createText({ x: 10, y: 20, text: 'из другого окна', w: 200, h: 40 })],
    }));
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    return store.items.length === 1 && store.items[0].type === 'text' &&
      store.items[0].text === 'из другого окна';
  });
  store.clear();

  await t('Ctrl+V: пустой буфер не добавляет объектов', async () => {
    st.selection = [];
    st.clipboard = null;
    const dt = new DataTransfer();
    /* и системный буфер пуст: событие paste не должно ничего вставить */
    await window.inkboard.writeClipboard({ text: '', imageDataUrl: null });
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    return store.isEmpty();
  });

  await t('Ctrl+V не перехватывается при правке текста', async () => {
    store.clear();
    st.selection = [];
    st.clipboard = null;
    itc.startTextEdit(null, { x: 0, y: 0 });
    const ta = document.querySelector('#overlay textarea');
    ta.value = 'правится';
    const dt = new DataTransfer();
    dt.setData('text/plain', 'НЕ ДОЛЖНО ВСТАВЛЯТЬСЯ');
    const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(evt);
    await new Promise((r) => setTimeout(r, 60));
    /* событие не отменено: текст вставится в textarea как обычно,
       и на доску при этом ничего не попало */
    const kept = !evt.defaultPrevented && store.isEmpty();
    itc.finishTextEdit();
    return kept;
  });
  store.clear();

  /* ---------- форматирование текста ---------- */

  store.clear();
  st.selection = [];
  /* умолчания берём свои, а не из прошлого прогона */
  st.textFmt = { bold: false, italic: false, underline: false, family: 'ui', align: 'left' };
  itc.setTool('text');
  ui.syncTextFormat();
  const fmt = IB.model.createText({ x: 40, y: 60, text: 'Начертание', w: 240, fontSize: 24 });
  store.insert([fmt]);
  st.selection = [fmt.id];
  ui.syncTextFormat();

  t('новый текст: начертание по умолчанию выключено', () => {
    const o = store.get(fmt.id);
    return o.bold === false && o.italic === false && o.underline === false &&
      o.family === 'ui' && o.align === 'left';
  });
  t('обычный шрифт — без 700 и курсива', () => {
    const f = IB.model.objectFont(store.get(fmt.id));
    return !f.includes('700') && !f.includes('italic') && f.includes('24px');
  });

  app.commands.textBold();
  t('полужирный применяется к выделенному тексту', () => store.get(fmt.id).bold === true);
  t('шрифт полужирного начинается с 700', () =>
    /^700 24px /.test(IB.model.objectFont(store.get(fmt.id))));
  app.commands.textItalic();
  app.commands.textUnderline();
  t('курсив и подчёркивание включены', () => {
    const o = store.get(fmt.id);
    return o.italic === true && o.underline === true;
  });
  t('шрифт курсива — italic и 700', () =>
    /^italic 700 24px /.test(IB.model.objectFont(store.get(fmt.id))));
  t('кнопки начертания подсвечены в панели', () =>
    ['bold', 'italic', 'underline'].every((k) => {
      const b = document.querySelector(`.fmt-btn[data-fmt="${k}"]`);
      return b.classList.contains('active') && b.getAttribute('aria-pressed') === 'true';
    }));

  t('начертание отменяется по шагам и возвращается повтором', () => {
    store.undo(); store.undo(); store.undo();
    const o = store.get(fmt.id);
    const plain = o.bold === false && o.italic === false && o.underline === false;
    store.redo(); store.redo(); store.redo();
    const back = store.get(fmt.id);
    return plain && back.bold === true && back.italic === true && back.underline === true;
  });

  app.commands.alignTextCenter();
  t('текст выровнен по центру', () => store.get(fmt.id).align === 'center');
  t('кнопка выравнивания по центру активна', () =>
    document.querySelector('[data-align="center"]').classList.contains('active'));
  app.commands.alignTextRight();
  t('текст выровнен по правому краю', () => store.get(fmt.id).align === 'right');
  app.commands.alignTextLeft();
  t('текст снова по левому краю', () => store.get(fmt.id).align === 'left');

  app.commands.textFamily('mono');
  t('гарнитура меняется на моноширинную', () =>
    IB.model.objectFont(store.get(fmt.id)).includes('Consolas'));
  t('список гарнитур совпадает с моделью', () => {
    const ids = Array.from(document.getElementById('fontSelect').options).map((o) => o.value);
    return ids.length === IB.model.FONT_FAMILIES.length && ids.includes('mono') &&
      document.getElementById('fontSelect').value === 'mono';
  });
  app.commands.textFamily('ui');
  t('гарнитура вернулась к системной', () =>
    IB.model.objectFont(store.get(fmt.id)).includes('Segoe UI'));

  t('подчёркивание меняет отрисовку текста', () => {
    const obj = store.get(fmt.id);
    const scene = {
      store, view: st.view, selection: [], preview: null, marquee: null,
      eraser: null, eraserTargets: null, showGrid: false, showCells: false, hoveredId: null,
      singleSelection: false, showHandles: true, endpointHandles: null,
    };
    const surface = IB.paint.makeSurface(canvas);
    surface.resize();
    const saved = store.items.slice();
    const frame = (on) => {
      store.items.length = 0;
      store.items.push(Object.assign({}, obj, { underline: on }));
      IB.paint.render(surface, scene);
      return canvas.toDataURL();
    };
    const plain = frame(false);
    const under = frame(true);
    store.items.length = 0;
    for (const o of saved) store.items.push(o);
    app.requestRender();
    return plain !== under;
  });

  /* правка: формат сначала ложится в черновик, в доску — одним шагом */
  store.clear();
  st.selection = [];
  const editing = IB.model.createText({ x: 10, y: 10, text: 'Правка', w: 200, fontSize: 20 });
  store.insert([editing]);
  itc.setTool('select');
  itc.startTextEdit(store.get(editing.id));
  const ta0 = document.querySelector('#overlay textarea');
  t('правка открыта и блок форматирования виден при «Выделении»', () =>
    itc.isEditing() && !!ta0 && !!itc.editingDraft() &&
    document.querySelector('.insp-block[data-for="text"]').classList.contains('visible'));
  t('поле ввода повторяет начертание объекта', () =>
    ta0.style.fontWeight === '400' && ta0.style.fontStyle === 'normal' &&
    ta0.style.textAlign === 'left');
  app.commands.textItalic();
  t('курсив уходит в черновик, а не в доску', () =>
    itc.editingDraft().italic === true && store.get(editing.id).italic === false);
  t('поле ввода стало курсивом', () => ta0.style.fontStyle === 'italic');
  itc.commitTextEdit();
  t('коммит пишет курсив в доску', () => store.get(editing.id).italic === true);
  t('правка закрыта', () => !itc.isEditing() && !document.querySelector('#overlay textarea') &&
    !document.querySelector('.insp-block[data-for="text"]').classList.contains('visible'));
  store.undo();
  t('отмена коммита возвращает текст без курсива', () => store.get(editing.id).italic === false);
  store.clear();

  /* переписывание текста: клик инструментом «Текст» по написанному тексту
     открывает его правку, а не создаёт новый набор поверх старого */
  const rewrite = IB.model.createText({ x: 40, y: 40, text: 'Старый текст', w: 240, fontSize: 24 });
  store.insert([rewrite]);
  itc.setTool('text');
  const rewriteAt = G.toScreen({ x: rewrite.x + 30, y: rewrite.y + 8 }, st.view);
  fire('pointerdown', rewriteAt.x, rewriteAt.y);
  const rwTa = overlay.querySelector('textarea');
  t('клик «Текстом» по написанному тексту открывает его правку', () =>
    itc.isEditing() && !!rwTa && store.items.length === 1 && !!store.get(rewrite.id));
  t('набор сразу переписывает старый текст — содержимое выделено целиком', () =>
    !!rwTa && rwTa.value === 'Старый текст' && rwTa.selectionStart === 0 &&
    rwTa.selectionEnd === rwTa.value.length);
  t('правимый текст не рисуется под прозрачным полем ввода', () => {
    const obj = store.get(rewrite.id);
    const surface = IB.paint.makeSurface(canvas);
    surface.resize();
    const fakeStore = { items: [obj], get: () => null };
    const base = {
      store: fakeStore, view: st.view, selection: [], preview: null, marquee: null,
      eraser: null, showGrid: false, showCells: false, hoveredId: null,
      singleSelection: false, showHandles: false, endpointHandles: null,
    };
    IB.paint.render(surface, Object.assign({}, base, { editingId: obj.id }));
    const hidden = canvas.toDataURL();
    IB.paint.render(surface, Object.assign({}, base, { editingId: null }));
    const shown = canvas.toDataURL();
    app.requestRender();
    return hidden !== shown;
  });
  itc.cancelTextEdit();
  store.clear();

  /* умолчания панели, когда ничего не выделено */
  st.selection = [];
  /* после выделения умолчания поменялись — возвращаем чистое состояние */
  st.textFmt = { bold: false, italic: false, underline: false, family: 'ui', align: 'left' };
  ui.syncTextFormat();
  app.commands.textBold();
  t('без выделения переключается умолчание нового текста', () =>
    st.textFmt.bold === true &&
    document.querySelector('.fmt-btn[data-fmt="bold"]').classList.contains('active'));
  itc.insertText('Полужирный текст');
  t('новый текст берёт умолчание панели', () =>
    store.items.length === 1 && store.items[0].bold === true);
  store.clear();
  st.selection = [];
  app.commands.textBold();
  t('умолчание снято', () => st.textFmt.bold === false);

  t('Ctrl+B с клавиатуры делает выделение полужирным', () => {
    const o = IB.model.createText({ x: 0, y: 0, text: 'Клавиши', w: 200 });
    store.insert([o]);
    st.selection = [o.id];
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'b', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    return store.get(o.id).bold === true;
  });
  store.clear();
  st.selection = [];
  st.textFmt = { bold: false, italic: false, underline: false, family: 'ui', align: 'left' };
  itc.setTool('pen');
  ui.syncTextFormat();

  /* размер пера и маркера влияет на сам штрих */
  const inkWidthOf = (tool, w) => {
    store.clear();
    itc.setTool(tool);
    st.width = w;
    ui.syncThickness();
    fire('pointerdown', 500, 500);
    fire('pointermove', 560, 520);
    fire('pointerup', 560, 520);
    const s = store.items[0];
    return s && s.type === 'stroke' ? s.width : null;
  };
  t('толщина пера пишет штрих выбранной толщины', () => {
    const thin = inkWidthOf('pen', 4);
    const thick = inkWidthOf('pen', 24);
    return thin === 4 && thick === 24;
  });
  t('маркер остаётся шире пера в тех же размерах', () => {
    const hi = inkWidthOf('highlighter', 8);
    const pen = inkWidthOf('pen', 8);
    return hi >= pen * 3;
  });
  t('самый толстый размер пера заметно толще самого тонкого', () => {
    const thin = inkWidthOf('pen', 2);
    const thick = inkWidthOf('pen', 24);
    return thin < thick && thick / thin >= 10;
  });
  st.width = 4;
  ui.syncThickness();

  /* ---------- «О программе» и обновления ---------- */

  app.commands.about();
  const aboutEl = document.getElementById('about');
  t('О программе: окно открывается', () => aboutEl.hidden === false);
  t('О программе: кнопка «Закрыть и установить» скрыта', () =>
    document.getElementById('btnInstallUpdate').hidden === true);
  t('О программе: кнопка «Скачать» скрыта', () =>
    document.getElementById('btnDownloadUpdate').hidden === true);
  /* инфо и авто-проверка приходят асинхронно: info из app:info,
     статус — из update:check (оба без сети, заглушки главного процесса) */
  await new Promise((r) => setTimeout(r, 150));
  t('О программе: показана версия из главного процесса', () =>
    document.getElementById('aboutVersion').textContent === '0.0.0-test');
  t('О программе: авто-проверка завершилась', () =>
    document.getElementById('updateStatus').textContent.includes('последняя версия'));

  const aboutState = app.about.state;
  const aboutRender = app.about.render;

  Object.assign(aboutState, {
    phase: 'available', latest: '9.9.9', assetName: 'Doka-Setup-9.9.9.exe',
    received: 0, total: 0, file: null, error: null,
  });
  aboutRender();
  t('Обновление: новая версия — появляется «Скачать»', () =>
    document.getElementById('btnDownloadUpdate').hidden === false
    && document.getElementById('updateStatus').textContent.includes('9.9.9'));
  t('Обновление: до скачивания установка недоступна', () =>
    document.getElementById('btnInstallUpdate').hidden === true);

  Object.assign(aboutState, { phase: 'downloading', total: 4000, received: 1000 });
  aboutRender();
  t('Обновление: полоса прогресса показывает 25%', () =>
    document.getElementById('updateProgress').hidden === false
    && document.getElementById('updateBar').style.width === '25%'
    && document.getElementById('updateStatus').textContent.includes('25%'));

  Object.assign(aboutState, { phase: 'downloaded', received: 4000, file: 'C:\\Temp\\Doka-Setup-9.9.9.exe' });
  aboutRender();
  t('Обновление: после скачивания — «Закрыть и установить»', () =>
    document.getElementById('btnInstallUpdate').hidden === false
    && document.getElementById('btnDownloadUpdate').hidden === true);

  Object.assign(aboutState, { phase: 'error', error: 'В релизе нет установщика Windows' });
  aboutRender();
  t('Обновление: ошибка видна в статусе', () =>
    document.getElementById('updateStatus').textContent.includes('нет установщика'));

  t('О программе: Escape закрывает окно', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return aboutEl.hidden === true;
  });

  itc.setTool('pen');
  return lines;
  } catch (err) {
    lines.push({ name: 'исключение в теле теста', ok: false, extra: (err && err.stack) || String(err) });
    return lines;
  } finally {
    if (testErrors.length) lines.push({ name: 'ошибки в окне теста', ok: false, extra: testErrors.join(' | ') });
  }
}
