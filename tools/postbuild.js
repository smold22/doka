'use strict';

/* Постобработка: вписывает иконку и метаданные в собранный exe приложения.
   electron-builder запускается с signAndEditExecutable=false, потому что
   распаковка winCodeSign на Windows требует прав на создание символьных ссылок.
   Запуск: node tools/postbuild.js (автоматически после npm run dist) */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

function findRcedit() {
  const cacheRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache', 'winCodeSign');
  if (!fs.existsSync(cacheRoot)) return null;
  const stack = [cacheRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === 'rcedit-x64.exe' && fs.statSync(full).size > 1000) return full;
    }
  }
  return null;
}

const exe = path.join(root, 'dist', 'win-unpacked', `${pkg.build.productName}.exe`);
const icon = path.join(root, 'build', 'icon.ico');

if (!fs.existsSync(exe)) {
  console.log('postbuild: dist/win-unpacked не найден — пропуск');
  process.exit(0);
}

const rcedit = findRcedit();
if (!rcedit) {
  console.log('postbuild: rcedit не найден в кэше electron-builder — пропуск');
  process.exit(0);
}

const args = [
  exe,
  '--set-icon', icon,
  '--set-version-string', 'FileDescription', `${pkg.build.productName} — бесконечная доска`,
  '--set-version-string', 'ProductName', pkg.build.productName,
  '--set-version-string', 'CompanyName', pkg.author,
  '--set-version-string', 'InternalName', pkg.build.productName,
  '--set-version-string', 'OriginalFilename', `${pkg.build.productName}.exe`,
  '--set-file-version', pkg.version,
  '--set-product-version', pkg.version,
];

try {
  execFileSync(rcedit, args, { stdio: 'inherit' });
  console.log('postbuild: иконка и метаданные записаны в', path.relative(root, exe));
} catch (err) {
  console.warn('postbuild: rcedit завершился с ошибкой —', err.message);
}
