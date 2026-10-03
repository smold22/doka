'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inkboard', {
  openFile: () => ipcRenderer.invoke('file:open'),
  saveFile: (text, forceDialog) => ipcRenderer.invoke('file:save', { text, forceDialog }),
  exportPng: (dataUrl, defaultName) => ipcRenderer.invoke('file:exportPng', { dataUrl, defaultName }),
  openImage: () => ipcRenderer.invoke('image:open'),
  newFile: () => ipcRenderer.invoke('file:new'),
  reveal: (file) => ipcRenderer.invoke('file:reveal', file),
  writeClipboard: (payload) => ipcRenderer.invoke('clipboard:write', payload),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  setDirty: (dirty) => ipcRenderer.invoke('app:dirty', dirty),
  getState: () => ipcRenderer.invoke('app:state'),
  reportError: (message) => ipcRenderer.invoke('app:toast', { type: 'error', message }),
  onMenuCommand: (cb) => {
    const handler = (_e, command) => cb(command);
    ipcRenderer.on('menu:command', handler);
    return () => ipcRenderer.removeListener('menu:command', handler);
  },
  onWindowState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('window:state', handler);
    return () => ipcRenderer.removeListener('window:state', handler);
  },
});
