'use strict';

/* Проверка обновлений и загрузка установщика.
   Здесь только чистая логика и сеть; что показывать в интерфейсе
   и когда закрывать приложение, решают main.js и renderer. */

const fsp = require('node:fs/promises');

const REPO = 'smold22/doka';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/* установщик собирается electron-builder'ом в Doka-Setup-<версия>.exe */
const ASSET_RE = /^Doka-Setup-.*\.exe$/i;

function errMsg(err) {
  return String((err && err.message) || err);
}

function parseVer(v) {
  return String(v == null ? '' : v)
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/* строгое «новее»: 3.0.1 > 3.0.0, 10.0.0 > 9.9.9, одинаковые версии не новее */
function isNewer(a, b) {
  const pa = parseVer(a);
  const pb = parseVer(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function pickAsset(assets) {
  if (!Array.isArray(assets)) return null;
  return assets.find((a) => a && a.name && ASSET_RE.test(a.name) && a.browser_download_url) || null;
}

function timeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

/* свежий релиз с GitHub: возвращает есть ли версия новее текущей
   и ссылку на установщик Windows (если он в релизе есть) */
async function checkLatest(current, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(API_URL, {
    signal: opts.signal || timeoutSignal(10000),
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `Doka/${parseVer(current).join('.')}`,
    },
  });
  if (!res.ok) throw new Error(`GitHub ответил HTTP ${res.status}`);
  const data = await res.json();
  const latest = String((data && data.tag_name) || '').replace(/^v/i, '') || null;
  const asset = pickAsset(data && data.assets);
  return {
    hasUpdate: !!latest && isNewer(latest, current),
    latest,
    assetName: asset ? asset.name : null,
    assetSize: asset && Number.isFinite(asset.size) ? asset.size : null,
    assetUrl: asset ? asset.browser_download_url : null,
  };
}

/* загрузка установщика в файл с прогрессом; оборвавшуюся загрузку удаляем,
   чтобы не остался битый exe */
async function download(url, destPath, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const onProgress = opts.onProgress;
  const res = await fetchImpl(url, {
    signal: opts.signal || timeoutSignal(600000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`сервер ответил HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  try {
    const fh = await fsp.open(destPath, 'w');
    try {
      for await (const chunk of res.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        await fh.write(buf);
        received += buf.length;
        if (onProgress) onProgress({ received, total });
      }
    } finally {
      await fh.close();
    }
    if (total && received !== total) throw new Error('загрузка оборвалась на середине');
  } catch (err) {
    await fsp.unlink(destPath).catch(() => {});
    throw err instanceof Error ? err : new Error(String(err));
  }
  return { received, total };
}

module.exports = { REPO, RELEASES_URL, API_URL, parseVer, isNewer, pickAsset, checkLatest, download, errMsg };
