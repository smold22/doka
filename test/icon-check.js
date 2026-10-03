'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<html><body></body></html>');

  const png = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png')).toString('base64');
  const info = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ error: true });
      img.src = 'data:image/png;base64,${png}';
    })
  `, true);
  console.log('PNG:', JSON.stringify(info));

  const ico = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.ico'));
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    sizes.push(`${ico[o] || 256}x${ico[o + 1] || 256} (${ico.readUInt32LE(o + 8)} байт)`);
  }
  console.log('ICO:', count, 'изображений:', sizes.join(', '));

  /* рисуем иконку в элемент и сравниваем с исходной картинкой */
  const swatch = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = 16; c.height = 16;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        const mid = ((8 * 16) + 8) * 4;
        resolve({ center: [d[mid], d[mid + 1], d[mid + 2], d[mid + 3]] });
      };
      img.src = 'data:image/png;base64,${png}';
    })
  `, true);
  console.log('Цвет центра 16px:', JSON.stringify(swatch));

  app.exit(0);
});
