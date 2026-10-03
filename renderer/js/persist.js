/* Доска — сохранение, загрузка, автосохранение */
(function (global) {
  'use strict';

  const IB = (global.IB = global.IB || {});
  /* ключи и маркер формата сохранены прежними: старые доски должны открываться */
  const AUTOSAVE_KEY = 'inkboard.autosave.v1';
  const PREFS_KEY = 'inkboard.prefs.v1';
  const FORMAT = 'inkboard-board';
  const VERSION = 1;

  function serialize(store, view, title) {
    return {
      format: FORMAT,
      version: VERSION,
      app: 'Доска',
      /* название доски живёт в файле, а не в настройках: переименованная
         доска должна остаться переименованной на любом компьютере */
      title: typeof title === 'string' && title ? title : null,
      savedAt: new Date().toISOString(),
      viewport: view
        ? { pan: { x: view.pan.x, y: view.pan.y }, scale: view.scale }
        : null,
      items: store.snapshot(),
    };
  }

  function toText(store, view, title) {
    return JSON.stringify(serialize(store, view, title), null, 2);
  }

  function deserialize(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Файл не содержит данных доски.');
    }
    if (data.format && data.format !== FORMAT) {
      throw new Error(`Неподдерживаемый формат: ${data.format}`);
    }
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.some((o) => !o || typeof o.type !== 'string')) {
      throw new Error('Повреждённые данные доски.');
    }
    return {
      items,
      viewport: data.viewport || null,
      /* в старых файлах названия нет — это не ошибка, просто «Новая доска» */
      title: typeof data.title === 'string' && data.title ? data.title : null,
    };
  }

  function fromText(text) {
    return deserialize(JSON.parse(text));
  }

  /* ---------- автосохранение ---------- */

  let autosaveTimer = null;

  function scheduleAutosave(store, view, title) {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      try {
        localStorage.setItem(AUTOSAVE_KEY, toText(store, view, title));
      } catch (err) {
        /* переполнено хранилище — не критично */
      }
    }, 1200);
  }

  function readAutosave() {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return null;
      return fromText(raw);
    } catch (err) {
      return null;
    }
  }

  function clearAutosave() {
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch (err) {
      /* ignore */
    }
  }

  /* ---------- настройки интерфейса ---------- */

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      return {};
    }
  }

  function savePrefs(prefs) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (err) {
      /* ignore */
    }
  }

  IB.persist = {
    FORMAT, VERSION,
    serialize, toText, deserialize, fromText,
    scheduleAutosave, readAutosave, clearAutosave,
    loadPrefs, savePrefs,
  };
})(window);
