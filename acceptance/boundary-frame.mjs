import {randomUUID} from 'node:crypto';

import {BrowserWindow, ipcMain} from 'electron';

import {DraftCoordinator} from '../packages/electron/dist/draftCoordinator.js';

// This additional authorized document belongs only to the boundary fixture. The
// production window retains its secure preferences and its normal IPC namespace.
globalThis.acceptanceCreateAuthorizedFrame = async () => {
  const {registerIpc} = await import(
    process.env.SHOP_THINGS_ACCEPTANCE_FRAME_ADAPTER ?? '../packages/electron/dist/ipc.js'
  );
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
    },
  });
  await window.loadURL('about:blank');
  const document = {
    documentId: randomUUID(),
    url: window.webContents.mainFrame.url,
    frame: window.webContents.mainFrame,
    webContents: window.webContents,
  };
  const calls = [];
  const service = globalThis.acceptanceService;
  const handlers = Object.fromEntries(
    Object.entries(service.handlers).map(([name, handler]) => [
      name,
      (...args) => {
        calls.push(name);
        return handler(...args);
      },
    ])
  );
  function channel(value) {
    return `acceptance-frame:${value}`;
  }

  const stop = registerIpc({
    ipc: {
      handle: (name, listener) => ipcMain.handle(channel(name), listener),
      removeHandler: name => ipcMain.removeHandler(channel(name)),
      on: (name, listener) => ipcMain.on(channel(name), listener),
      removeListener: (name, listener) => ipcMain.removeListener(channel(name), listener),
    },
    service: {handlers, onStateChanged: listener => service.onStateChanged(listener)},
    drafts: new DraftCoordinator(),
    currentDocument: () => (window.isDestroyed() ? null : document),
    onDocumentChanged: () => () => {},
  });
  window.once('closed', stop);
  globalThis.acceptanceFrameCalls = calls;
  return {wc: window.webContents.id, documentId: document.documentId};
};
