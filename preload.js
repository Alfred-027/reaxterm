'use strict';
// Puente seguro entre la interfaz y el proceso principal
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const ALLOWED = ['store:', 'term:', 'sftp:', 'tunnel:', 'tools:', 'launch:', 'data:', 'moba:', 'app:', 'clip:', 'secret:', 'dialog:', 'ui:'];
const allowed = (ch) => ALLOWED.some((p) => ch.startsWith(p));

contextBridge.exposeInMainWorld('rx', {
  invoke: (ch, ...args) => {
    if (!allowed(ch)) throw new Error('Canal no permitido: ' + ch);
    return ipcRenderer.invoke(ch, ...args);
  },
  write: (id, data) => ipcRenderer.send('term:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
  reply: (id, value) => ipcRenderer.send('ui:prompt-reply', id, value),
  on: (ch, cb) => {
    if (!allowed(ch)) throw new Error('Canal no permitido: ' + ch);
    const listener = (_e, ...args) => cb(...args);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
  },
  pathForFile: (file) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path),
});
