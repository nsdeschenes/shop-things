import {app, dialog, ipcMain} from 'electron';

// Test-only launcher isolates settings and records actual IPC delivery; the application,
// BrowserWindow, bundled preload, renderer and backend are the built production code.
app.setPath('userData', process.env.SHOP_THINGS_ACCEPTANCE_DATA);
globalThis.acceptanceIpc = [];
globalThis.acceptanceDialogs = [];
globalThis.acceptanceDiscard = false;
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  globalThis.acceptanceDialogs.push(options);
  return {
    response:
      options.message === 'Discard unsaved changes?' && globalThis.acceptanceDiscard
        ? 1
        : 0,
  };
};

if (process.env.SHOP_THINGS_ACCEPTANCE_CREATE_PATH) {
  dialog.showSaveDialog = async () => ({
    canceled: false,
    filePath: process.env.SHOP_THINGS_ACCEPTANCE_CREATE_PATH,
  });
}

const handle = ipcMain.handle.bind(ipcMain);
globalThis.acceptanceDenyHandshake = process.env.SHOP_THINGS_ACCEPTANCE_DENY_HANDSHAKE;
ipcMain.handle = (channel, listener) =>
  handle(channel, async (...args) => {
    globalThis.acceptanceIpc.push(channel);
    if (channel === 'shop-things:document' && globalThis.acceptanceDenyHandshake) {
      if (globalThis.acceptanceDenyHandshake !== 'always') {
        globalThis.acceptanceDenyHandshake = null;
      }

      return null;
    }

    const result = await listener(...args);
    if (
      channel === 'shop-things:database.status' &&
      process.env.SHOP_THINGS_ACCEPTANCE_DELAY_STATUS &&
      !globalThis.acceptanceStatusDelayed
    ) {
      globalThis.acceptanceStatusDelayed = true;
      globalThis.acceptanceHeldStatus = result;
      await new Promise(resolve => {
        globalThis.acceptanceReleaseStatus = resolve;
      });
    }

    return result;
  });
await import('../packages/electron/dist/main.js');
