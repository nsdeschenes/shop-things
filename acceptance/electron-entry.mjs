import {writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';

import {app, dialog, ipcMain, net, utilityProcess} from 'electron';

// Test-only launcher isolates settings and records actual IPC delivery; the application,
// BrowserWindow, bundled preload, renderer and backend are the built production code.
app.setPath('userData', process.env.SHOP_THINGS_ACCEPTANCE_DATA);
if (process.env.SHOP_THINGS_ACCEPTANCE_PACKAGED === 'true') {
  Object.defineProperty(app, 'isPackaged', {value: true});
  if (process.env.SHOP_THINGS_ACCEPTANCE_RESOURCES) {
    Object.defineProperty(process, 'resourcesPath', {
      value: process.env.SHOP_THINGS_ACCEPTANCE_RESOURCES,
    });
  }
}

if (process.env.SHOP_THINGS_ACCEPTANCE_BOUNDARY) {
  await import('./boundary-observer.mjs');
}

globalThis.acceptanceIpc = [];
globalThis.acceptanceIpcHandlers = [];
globalThis.acceptanceUtilityFork = Reflect.get(utilityProcess, 'fork');
globalThis.acceptanceMonitoringPartitions = [];
if (process.env.SHOP_THINGS_ACCEPTANCE_MONITORING === 'true') {
  const request = net.request.bind(net);
  net.request = options => {
    globalThis.acceptanceMonitoringPartitions.push(
      typeof options === 'object' ? options.partition : null
    );
    return request(options);
  };
}

globalThis.acceptanceDialogs = [];
globalThis.acceptanceDiscard = false;
dialog.showErrorBox = (title, message) => {
  globalThis.acceptanceDialogs.push({title, message});
};

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
ipcMain.handle = (channel, listener) => {
  globalThis.acceptanceIpcHandlers.push(channel);
  return handle(channel, async (...args) => {
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
      if (fault.reject) {
        throw new Error(fault.error.message);
      }

      if (fault.malformed) {
        return fault.error.message;
      }

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
};

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
  process.env.SHOP_THINGS_ACCEPTANCE_DELAY_STARTUP ||
  process.env.SHOP_THINGS_ACCEPTANCE_MONITORING
) {
  globalThis.acceptanceDatabase = await import('../packages/db/dist/index.js');
  globalThis.acceptanceNative = (
    await import('../packages/electron/dist/effectBoundary.js')
  ).native;
  const {ActionService} = await import('../packages/electron/dist/actionService.js');
  // Snapshot the original implementation before installing the startup wrapper.
  const start = Object.getOwnPropertyDescriptor(ActionService.prototype, 'start')?.value;
  if (typeof start !== 'function') {
    throw new TypeError('Expected ActionService.prototype.start to be a method');
  }

  ActionService.prototype.start = async function (...args) {
    globalThis.acceptanceService = this;
    globalThis.acceptanceBackend = Reflect.get(this, 'backend');
    if (process.env.SHOP_THINGS_ACCEPTANCE_DELAY_STARTUP) {
      await new Promise(resolve => {
        globalThis.acceptanceReleaseStartup = resolve;
      });
    }

    return Reflect.apply(start, this, args);
  };
}

if (process.env.SHOP_THINGS_ACCEPTANCE_MONITORING) {
  await installMonitoringProbes();
}

async function installMonitoringProbes() {
  const requireElectron = createRequire(
    new URL('../packages/electron/package.json', import.meta.url)
  );
  const {Effect} = await import(requireElectron.resolve('effect'));
  const {native} = await import('../packages/electron/dist/effectBoundary.js');
  const {effectDatabaseOperations} = await import('../packages/electron/dist/backend.js');
  const database = {...effectDatabaseOperations};
  const {getActiveSpan, spanToJSON, getClient} =
    await import('../packages/electron/node_modules/@sentry/electron/main/index.js');
  function listCustomers(...args) {
    return Effect.gen(function* () {
      const probe = globalThis.acceptanceQueryProbe;
      if (probe) {
        globalThis.acceptanceQueryProbe = null;
        yield* native(async () => {
          globalThis.acceptanceQueryProbeParent = spanToJSON(getActiveSpan());
          const client = args[0].$client;
          await client.all(
            'select firstName from customers where email = ?',
            probe.sentinel
          );
          const statement = client.prepare(
            'select id from customers where email = :PRIVATE_SENTINEL_parameter'
          );
          await statement.raw(true).all({PRIVATE_SENTINEL_parameter: probe.sentinel});
          await statement.raw(false).get({PRIVATE_SENTINEL_parameter: probe.sentinel});
          statement.close();
          await client.run('update customers set stock = stock where id = ?', -1);
          try {
            await client.run(
              'insert into customers (id, customerNumber, firstName) select id, customerNumber, firstName from customers limit 1'
            );
          } catch {
            globalThis.acceptanceQueryConstraintFailed = true;
          }

          const removeStatusFault = getClient().on('spanStart', span => {
            if (spanToJSON(span).name === 'database.query') {
              span.setStatus = () => {
                globalThis.acceptanceQueryStatusFailed = true;
                throw new Error('PRIVATE_SENTINEL_sdk_status');
              };
            }
          });
          try {
            await client.all('select PRIVATE_SENTINEL_column from customers');
          } catch {
            globalThis.acceptanceQueryUnknownFailed = true;
          } finally {
            removeStatusFault();
          }
        });
        yield* database.backupDatabase(args[0], probe.backupPath);
      }

      yield* native(async () => {
        if (globalThis.acceptanceNativeMonitoringFault) {
          const message = globalThis.acceptanceNativeMonitoringFault;
          globalThis.acceptanceNativeMonitoringFault = null;
          throw new TypeError(message);
        }
      });
      return yield* database.listCustomers(...args);
    });
  }

  function updateCustomer(...args) {
    return Effect.gen(function* () {
      yield* native(async () => {
        if (globalThis.acceptanceObservePreparedQuery) {
          const statement = (globalThis.acceptancePreparedQuery ??=
            args[0].$client.prepare('select id from customers where id = ?'));
          await statement.get(args[1].id);
        }

        const concurrent = globalThis.acceptanceConcurrentCustomerMonitoring;
        const stock = args[2]?.stock;
        if (concurrent && (stock === 41 || stock === 42)) {
          await new Promise(resolve => {
            concurrent[stock] = resolve;
          });
          throw new TypeError('PRIVATE_SENTINEL_concurrent_update');
        }

        if (globalThis.acceptanceNativeCustomerMonitoringFault) {
          const message = globalThis.acceptanceNativeCustomerMonitoringFault;
          globalThis.acceptanceNativeCustomerMonitoringFault = null;
          throw new SyntaxError(message);
        }
      });
      return yield* database.updateCustomer(...args);
    });
  }

  function createCustomer(...args) {
    return Effect.gen(function* () {
      yield* native(async () => {
        if (globalThis.acceptanceNativeCustomerMonitoringFault) {
          const message = globalThis.acceptanceNativeCustomerMonitoringFault;
          globalThis.acceptanceNativeCustomerMonitoringFault = null;
          throw new SyntaxError(message);
        }
      });
      return yield* database.createCustomer(...args);
    });
  }

  Object.assign(effectDatabaseOperations, {
    listCustomers,
    updateCustomer,
    createCustomer,
  });
}

await import('../packages/electron/dist/main.js');
