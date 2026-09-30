// Acceptance-only extra namespace. The application still uses its shipped sandboxed preload.
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('acceptanceBoundaryRaw', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  send: (channel, payload) => ipcRenderer.send(channel, payload),
});
