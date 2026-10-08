import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {app, dialog, ipcMain} from 'electron';

// Test-only launcher isolates settings and records actual IPC delivery; the application,
// BrowserWindow, bundled preload, renderer and backend are the built production code.
app.setPath('userData', process.env.SHOP_THINGS_ACCEPTANCE_DATA);
if (process.env.SHOP_THINGS_ACCEPTANCE_BOUNDARY) {
  await import('./boundary-observer.mjs');
}

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

globalThis.acceptanceFiles = [];
globalThis.acceptancePickers = [];
async function selectedFile(kind, args) {
  globalThis.acceptancePickers.push({
    kind,
    title: args.at(-1).title,
    windowId: args[0].id,
  });
  const selection = globalThis.acceptanceFiles.shift();
  if (selection?.hold) {
    globalThis.acceptancePickerHeld = true;
    await new Promise(resolve => {
      globalThis.acceptanceReleasePicker = resolve;
    });
    globalThis.acceptancePickerHeld = false;
  }

  const path =
    selection?.path ??
    (kind === 'save' ? process.env.SHOP_THINGS_ACCEPTANCE_CREATE_PATH : null);
  return kind === 'save'
    ? {canceled: !path, filePath: path}
    : {canceled: !path, filePaths: path ? [path] : []};
}

dialog.showSaveDialog = async (...args) => selectedFile('save', args);
dialog.showOpenDialog = async (...args) => selectedFile('open', args);

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

    if (
      globalThis.acceptanceFault?.channel === channel &&
      globalThis.acceptanceFault.before
    ) {
      const fault = globalThis.acceptanceFault;
      globalThis.acceptanceFault = null;
      const result = {status: 'error', error: fault.error};
      if (fault.hold) {
        globalThis.acceptanceHeldRead = {channel, result};
        await new Promise(resolve => {
          globalThis.acceptanceReleaseRead = resolve;
        });
      }

      return result;
    }

    const result = await listener(...args);
    if (globalThis.acceptanceFault?.channel === channel) {
      const fault = globalThis.acceptanceFault;
      globalThis.acceptanceFault = null;
      if (fault.hold) {
        globalThis.acceptanceHeldRead = {channel, result};
        await new Promise(resolve => {
          globalThis.acceptanceReleaseRead = resolve;
        });
      }

      if (fault.error) {
        return {status: 'error', error: fault.error};
      }
    }

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
if (process.env.SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS) {
  const {createDatabase, createCustomer} = await import('../packages/db/dist/index.js');
  const databasePath = join(app.getPath('userData'), 'customers.sqlite');
  const handle = await createDatabase(databasePath, {
    migrationsFolder: new URL('../packages/db/migrations', import.meta.url).pathname,
  });
  const values = {
    firstName: '',
    lastName: '',
    address: '',
    city: '',
    province: '',
    postalCode: '',
    phone: '',
    email: '',
    stock: 0,
    balance: '0.00',
    previousBalance: '0.00',
    donate: false,
    comments: '',
  };
  await createCustomer(handle.db, {...values, firstName: 'Zed', lastName: 'Two'});
  await createCustomer(handle.db, {
    ...values,
    firstName: 'Alpha',
    lastName: 'One',
    phone: '+1 (902) 555-1234',
    balance: '-1.23',
    previousBalance: '10.00',
  });
  await createCustomer(handle.db, {
    ...values,
    firstName: 'Numbered',
    lastName: 'Three',
    donate: false,
  });
  handle.close();
  await writeFile(
    join(app.getPath('userData'), 'database.json'),
    JSON.stringify({path: databasePath})
  );
}

if (
  process.env.SHOP_THINGS_ACCEPTANCE_RECOVERY ||
  process.env.SHOP_THINGS_ACCEPTANCE_LIFECYCLE ||
  process.env.SHOP_THINGS_ACCEPTANCE_DELAY_STARTUP
) {
  globalThis.acceptanceDatabase = await import('../packages/db/dist/index.js');
  const {ActionService} = await import('../packages/electron/dist/actionService.js');
  // Snapshot the original implementation before installing the startup wrapper.
  const start = Object.getOwnPropertyDescriptor(ActionService.prototype, 'start')?.value;
  if (typeof start !== 'function') {
    throw new TypeError('Expected ActionService.prototype.start to be a method');
  }

  ActionService.prototype.start = async function (...args) {
    globalThis.acceptanceService = this;
    if (process.env.SHOP_THINGS_ACCEPTANCE_DELAY_STARTUP) {
      await new Promise(resolve => {
        globalThis.acceptanceReleaseStartup = resolve;
      });
    }

    return Reflect.apply(start, this, args);
  };
}

await import('../packages/electron/dist/main.js');
