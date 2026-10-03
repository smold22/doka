'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
/* версия и автор берутся из package.json, чтобы окно «О программе»
   и метаданные exe не расходились с манифестом */
const pkg = require('./package.json');

const isMac = process.platform === 'darwin';

let mainWindow = null;
let currentFile = null;

const state = {
  dirty: false,
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#f4f5f7',
    title: 'Доска',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const windowIcon = path.join(__dirname, 'build', 'icon.png');
  if (fsSync.existsSync(windowIcon)) {
    mainWindow.setIcon(windowIcon);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  const notify = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:state', {
        file: currentFile,
        dirty: state.dirty,
      });
      const name = currentFile ? path.basename(currentFile) : 'Доска';
      mainWindow.setTitle(`${state.dirty ? '*' : ''}${name}`);
    }
  };

  mainWindow.on('page-title-updated', (e) => e.preventDefault());
  mainWindow.webContents.on('did-finish-load', notify);

  mainWindow.on('close', async (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    const res = await confirmDiscard();
    if (res === 'save') {
      const ok = await mainWindow.webContents.executeJavaScript(
        'window.IB && window.IB.app ? window.IB.app.requestSave() : null'
      );
      if (ok) {
        state.dirty = false;
        notify();
        mainWindow.close();
      }
    } else if (res === 'discard') {
      /* «Не сохранять» должно означать «не восстановить при следующем запуске»,
         поэтому перед закрытием сносим автосохранение в localStorage */
      try {
        await mainWindow.webContents.executeJavaScript(
          'window.IB && window.IB.app ? window.IB.app.discardChanges() : null'
        );
      } catch (err) {
        /* окно могло уже начать закрываться — закрываем в любом случае */
      }
      state.dirty = false;
      mainWindow.close();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function confirmDiscard() {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Сохранить', 'Не сохранять', 'Отмена'],
    defaultId: 0,
    cancelId: 2,
    title: 'Доска',
    message: 'Сохранить изменения перед закрытием?',
    detail: 'В доске есть несохранённые изменения.',
  });
  return ['save', 'discard', 'cancel'][response];
}

function buildMenu() {
  const send = (channel, ...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
  };

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Файл',
      submenu: [
        { label: 'Новая доска', accelerator: 'CmdOrCtrl+N', click: () => send('menu:command', 'new') },
        { label: 'Открыть…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:command', 'open') },
        { type: 'separator' },
        { label: 'Сохранить', accelerator: 'CmdOrCtrl+S', click: () => send('menu:command', 'save') },
        { label: 'Сохранить как…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('menu:command', 'saveAs') },
        { label: 'Экспорт в PNG…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('menu:command', 'exportPng') },
        { type: 'separator' },
        { label: 'Вставить картинку…', accelerator: 'CmdOrCtrl+Shift+I', click: () => send('menu:command', 'insertImage') },
        { label: 'Копировать доску', click: () => send('menu:command', 'copyBoard') },
        { label: 'Вставить из буфера', click: () => send('menu:command', 'pasteFromClipboard') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Выход' },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { label: 'Отменить', accelerator: 'CmdOrCtrl+Z', click: () => send('menu:command', 'undo') },
        { label: 'Повторить', accelerator: 'CmdOrCtrl+Y', click: () => send('menu:command', 'redo') },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { label: 'Удалить', accelerator: 'Delete', click: () => send('menu:command', 'deleteSelection') },
        { label: 'Выделить всё', accelerator: 'CmdOrCtrl+A', click: () => send('menu:command', 'selectAll') },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Увеличить', accelerator: 'CmdOrCtrl+Plus', click: () => send('menu:command', 'zoomIn') },
        { label: 'Уменьшить', accelerator: 'CmdOrCtrl+-', click: () => send('menu:command', 'zoomOut') },
        { label: 'Масштаб 100%', accelerator: 'CmdOrCtrl+0', click: () => send('menu:command', 'zoomReset') },
        { label: 'Вписать в экран', accelerator: 'CmdOrCtrl+1', click: () => send('menu:command', 'zoomFit') },
        { type: 'separator' },
        { label: 'Сетка', accelerator: 'CmdOrCtrl+Shift+G', click: () => send('menu:command', 'toggleGrid') },
        { label: 'Клетка', accelerator: 'CmdOrCtrl+Shift+C', click: () => send('menu:command', 'toggleCells') },
        { label: 'Сбросить масштаб и центр', click: () => send('menu:command', 'resetView') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Во весь экран' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
      ],
    },
    {
      label: 'Справка',
      submenu: [
        { label: 'Горячие клавиши', accelerator: 'F1', click: () => send('menu:command', 'showShortcuts') },
        {
          label: 'О программе Доска',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'О программе',
              message: 'Доска',
              detail: `Бесконечная доска для рисования.\nВерсия ${app.getVersion()}\nРазработчик ${pkg.author}\n\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- IPC ---------------- */

const FILE_FILTER = [
  { name: 'Доска', extensions: ['inkboard'] },
  { name: 'JSON', extensions: ['json'] },
  { name: 'Все файлы', extensions: ['*'] },
];

const PNG_FILTER = [{ name: 'PNG-изображение', extensions: ['png'] }];

const IMAGE_FILTER = [
  { name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
  { name: 'Все файлы', extensions: ['*'] },
];

const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

/* разумный предел, чтобы вставка случайного гигантского файла
   не положила ни доску, ни экспорт в PNG */
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

ipcMain.handle('image:open', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Вставить картинку',
    filters: IMAGE_FILTER,
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const file = res.filePaths[0];
  try {
    const buf = await fs.readFile(file);
    if (buf.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: 'Файл слишком большой (максимум 24 МБ)' };
    }
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) return { ok: false, error: 'Этот формат не поддерживается' };
    return {
      ok: true,
      file,
      name: path.basename(file),
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('file:new', async () => {
  currentFile = null;
  state.dirty = false;
  return { ok: true };
});

ipcMain.handle('file:open', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Открыть доску',
    filters: FILE_FILTER,
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const file = res.filePaths[0];
  try {
    const text = await fs.readFile(file, 'utf8');
    const data = JSON.parse(text);
    currentFile = file;
    state.dirty = false;
    return { ok: true, file, data };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

async function writeBoard(text, forcedPath) {
  let target = forcedPath || currentFile;
  if (!target) {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Сохранить доску',
      defaultPath: path.join(app.getPath('documents'), 'Доска.inkboard'),
      filters: FILE_FILTER,
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    target = res.filePath;
  }
  try {
    await fs.writeFile(target, text, 'utf8');
    currentFile = target;
    state.dirty = false;
    return { ok: true, file: target };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

ipcMain.handle('file:save', async (_e, { text, forceDialog }) => {
  return writeBoard(text, forceDialog ? null : currentFile);
});

ipcMain.handle('file:exportPng', async (_e, { dataUrl, defaultName }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Экспорт в PNG',
    defaultPath: path.join(app.getPath('pictures'), defaultName || 'doka.png'),
    filters: PNG_FILTER,
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    await fs.writeFile(res.filePath, Buffer.from(base64, 'base64'));
    return { ok: true, file: res.filePath };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('file:reveal', async (_e, file) => {
  if (file) shell.showItemInFolder(file);
  return true;
});

ipcMain.handle('clipboard:write', async (_e, { text, imageDataUrl }) => {
  if (imageDataUrl) {
    const img = nativeImage.createFromDataURL(imageDataUrl);
    clipboard.writeImage(img);
  }
  if (text) clipboard.writeText(text);
  return true;
});

ipcMain.handle('clipboard:read', async () => {
  const text = clipboard.readText();
  const img = clipboard.readImage();
  return { text, imageDataUrl: img && !img.isEmpty() ? img.toDataURL() : null };
});

ipcMain.handle('app:dirty', async (_e, dirty) => {
  state.dirty = !!dirty;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const name = currentFile ? path.basename(currentFile) : 'Доска';
    mainWindow.setTitle(`${state.dirty ? '*' : ''}${name}`);
  }
  return true;
});

ipcMain.handle('app:state', async () => ({ file: currentFile, dirty: state.dirty }));

ipcMain.handle('app:toast', async (_e, { type = 'info', message = '' }) => {
  if (!mainWindow) return true;
  if (type === 'error') {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Доска',
      message: 'Не удалось выполнить действие',
      detail: message,
    });
  }
  return true;
});

/* ---------------- Boot ---------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}
