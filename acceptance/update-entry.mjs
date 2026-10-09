import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {app, BrowserWindow, ipcMain} from 'electron';

import {createDatabase} from '../packages/db/dist/index.js';
import {ActionService} from '../packages/electron/dist/actionService.js';
import {trackAuthorizedDocument} from '../packages/electron/dist/document.js';
import {DraftCoordinator} from '../packages/electron/dist/draftCoordinator.js';
import {registerIpc} from '../packages/electron/dist/ipc.js';
import {FileDatabaseSettings} from '../packages/electron/dist/settings.js';
import {UpdateDiscovery} from '../packages/electron/dist/updateDiscovery.js';

// Only this test entry injects publisher trust and external transport. Production
// main has no environment switch or renderer operation that can do either.
app.setPath('userData', process.env.SHOP_THINGS_ACCEPTANCE_DATA);
await app.whenReady();
const fixture = JSON.parse(
  await readFile(process.env.SHOP_THINGS_UPDATE_FIXTURE, 'utf8')
);
const manifest = Buffer.from(fixture.manifest, 'base64');
const signature = Buffer.from(fixture.signature, 'base64');
const installer = Buffer.from(fixture.installer, 'base64');
const migrationsFolder = fileURLToPath(
  new URL('../packages/db/migrations', import.meta.url)
);
const databasePath = join(app.getPath('userData'), 'customers.sqlite');
const database = await createDatabase(databasePath, {migrationsFolder});
database.close();
const settingsPath = join(app.getPath('userData'), 'database.json');
await writeFile(settingsPath, JSON.stringify({path: databasePath}));
const drafts = new DraftCoordinator();
const service = new ActionService({
  migrationsFolder,
  settings: new FileDatabaseSettings(settingsPath),
  drafts,
  dialogs: {
    createDatabase: async () => null,
    openDatabase: async () => null,
    importCsv: async () => null,
    exportCsv: async () => null,
    backupDatabase: async () => null,
    restoreSource: async () => null,
    restoreDestination: async () => null,
    confirmDiscard: async () => false,
  },
});
await service.start();
globalThis.acceptanceUpdateMode = 'hold';
globalThis.acceptanceUpdateRequests = [];
let release;
const gate = new Promise(resolve => {
  release = resolve;
});
globalThis.acceptanceReleaseUpdateDownload = release;
const updates = new UpdateDiscovery({
  appVersion: '0.3.1',
  packageVersion: '0.3.1',
  trustedKeys: [fixture.publicKey],
  capabilityReasons: ['Installation is not available yet.'],
  request: async url => {
    if (url.startsWith('https://api.github.com/')) {
      return Buffer.from(JSON.stringify([fixture.release]));
    }

    return url.endsWith('.json') ? manifest : signature;
  },
  download: {
    directory: join(app.getPath('userData'), 'updates'),
    transport: async url => {
      globalThis.acceptanceUpdateRequests.push(url);
      if (globalThis.acceptanceUpdateMode === 'failed') {
        throw new Error('Controlled external transport interruption');
      }

      if (globalThis.acceptanceUpdateMode !== 'hold') {
        return new Response(installer);
      }

      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(installer.subarray(0, Math.floor(installer.length / 2)));
            void gate.then(() => {
              controller.enqueue(installer.subarray(Math.floor(installer.length / 2)));
              controller.close();
            });
          },
        })
      );
    },
  },
});
const base = fileURLToPath(new URL('../packages/electron/dist/', import.meta.url));
const html = join(base, 'renderer', 'index.html');
const window = new BrowserWindow({
  width: 1000,
  height: 800,
  webPreferences: {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    preload: join(base, 'preload.cjs'),
  },
});
const tracker = trackAuthorizedDocument(window.webContents, pathToFileURL(html).href);
globalThis.acceptanceUpdateResults = [];
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) =>
  handle(channel, async (...args) => {
    const result = await listener(...args);
    if (channel === 'shop-things:update.start') {
      globalThis.acceptanceUpdateResults.push(result);
    }

    return result;
  });
registerIpc({
  ipc: ipcMain,
  service,
  drafts,
  updates,
  ready: async () => {
    if (globalThis.acceptanceUpdateIpcGate) {
      globalThis.acceptanceUpdateIpcHeld = true;
      await globalThis.acceptanceUpdateIpcGate;
    }
  },
  currentDocument: () => tracker.currentDocument(),
  onDocumentChanged: callback => tracker.onDocumentChanged(callback),
});
await window.loadFile(html);
updates.startChecking();
app.on('before-quit', () => {
  updates.stop();
  service.closeUnprotected();
});
