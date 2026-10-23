import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import * as databaseOperations from '@shop-things/db/effect';
import {app, BrowserWindow, ipcMain, Menu, dialog} from 'electron';

import {ActionService} from './actionService.js';
import {isTrustedRendererUrl, trackAuthorizedDocument} from './document.js';
import {DraftCoordinator} from './draftCoordinator.js';
import {registerIpc} from './ipc.js';
import {createNativeDialogs} from './nativeDialogs.js';
import {FileDatabaseSettings} from './settings.js';
import {createMainTelemetry} from './telemetry.js';
import {FileTelemetrySettings} from './telemetrySettings.js';

let window: BrowserWindow | null = null;
let service: ActionService | null = null;
let stopIpc: (() => void) | null = null;
let starting: Promise<void> | null = null;
let shutdown: Promise<void> | null = null;
let shuttingDown = false;
let backendClosed = false;
let quitRequested = false;
let documentTracker: ReturnType<typeof trackAuthorizedDocument> | null = null;
const documentListeners = new Set<() => void>();
const abortedLoad = /^ERR_ABORTED\b/;
const telemetrySettings = new FileTelemetrySettings(
  join(app.getPath('userData'), 'telemetry.json'),
  console.error,
  app.isPackaged ? 'production' : 'development'
);
const telemetry = createMainTelemetry(
  telemetrySettings,
  `shop-things@${app.getVersion()}`
);
function logError(error: unknown) {
  console.error(error);
  telemetry.captureException(error);
}

function onDocumentChanged(callback: () => void) {
  documentListeners.add(callback);
  return () => {
    documentListeners.delete(callback);
  };
}

function createWindow() {
  const baseDirectory = dirname(fileURLToPath(import.meta.url));
  const rendererHtml = join(baseDirectory, 'renderer', 'index.html');
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const approvedUrl = devServerUrl || pathToFileURL(rendererHtml).href;
  let initialLoading = true;
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(baseDirectory, 'preload.cjs'),
    },
  });
  window = win;
  backendClosed = false;
  win.on('close', event => {
    if (backendClosed) {
      return;
    }

    event.preventDefault();
    void closeBackend(false);
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      ((input.key.toLowerCase() === 'r' && (input.control || input.meta)) ||
        input.key === 'F5')
    ) {
      event.preventDefault();
      void reloadWindow(win);
    }
  });
  documentTracker?.dispose();
  documentTracker = trackAuthorizedDocument(win.webContents, approvedUrl);
  documentTracker.onDocumentChanged(() => {
    for (const listener of documentListeners) {
      listener();
    }
  });
  win.webContents.on('will-frame-navigate', event => {
    if (!event.isMainFrame || !isTrustedRendererUrl(event.url, approvedUrl)) {
      event.preventDefault();
    }
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, approvedUrl)) {
      event.preventDefault();
    }
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url, approvedUrl)) {
      event.preventDefault();
    }
  });
  win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (!initialLoading && isMainFrame && code !== -3) {
      telemetry.captureException(new Error('Renderer load failed.'));
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') {
      telemetry.captureException(new Error('Renderer process exited.'));
    }
  });
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));

  const loaded = devServerUrl ? win.loadURL(devServerUrl) : win.loadFile(rendererHtml);
  void loaded
    .catch(error => {
      if (
        error instanceof Error &&
        (('code' in error && error.code === 'ERR_ABORTED') ||
          ('errno' in error && error.errno === -3) ||
          abortedLoad.test(error.message))
      ) {
        return;
      }

      logError(error);
    })
    .finally(() => {
      initialLoading = false;
    });
}

async function showProtectionFailure() {
  try {
    await dialog.showMessageBox({
      type: 'error',
      message: 'The application could not prepare this operation.',
      detail:
        'The application remains open. Wait for the editor to respond, then try again.',
      buttons: ['OK'],
    });
  } catch (error) {
    logError(error);
  }
}

async function reloadWindow(win: BrowserWindow) {
  if (!service || shutdown || win.isDestroyed()) {
    return;
  }

  const result = await telemetry.phase('application.reload', () =>
    service!.requestReload(() => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) {
        throw new Error('The renderer is unavailable.');
      }

      return new Promise<void>(resolve => {
        setImmediate(() => {
          if (!win.isDestroyed()) {
            win.webContents.reload();
          }

          resolve();
        });
      });
    })
  );
  if (result.status === 'error') {
    await showProtectionFailure();
  }
}

void app
  .whenReady()
  .then(async () => {
    if (shuttingDown) {
      return;
    }

    const drafts = new DraftCoordinator();
    service = new ActionService({
      effectDatabase: {
        createDatabase: (path, options) =>
          telemetry.phaseEffect('database.createDatabase', () =>
            databaseOperations.createDatabase(path, {
              ...options,
              ...telemetry.databaseOptions,
            })
          ),
        openExistingDatabase: (path, options) =>
          telemetry.phaseEffect('database.openExistingDatabase', () =>
            databaseOperations.openExistingDatabase(path, {
              ...options,
              ...telemetry.databaseOptions,
            })
          ),
        listCustomers: (...args) =>
          telemetry.phaseEffect('database.listCustomers', () =>
            databaseOperations.listCustomers(...args)
          ),
        getCustomer: (...args) =>
          telemetry.phaseEffect('database.getCustomer', () =>
            databaseOperations.getCustomer(...args)
          ),
        createCustomer: (...args) =>
          telemetry.phaseEffect('database.createCustomer', () =>
            databaseOperations.createCustomer(...args)
          ),
        updateCustomer: (...args) =>
          telemetry.phaseEffect('database.updateCustomer', () =>
            databaseOperations.updateCustomer(...args)
          ),
        deleteCustomer: (...args) =>
          telemetry.phaseEffect('database.deleteCustomer', () =>
            databaseOperations.deleteCustomer(...args)
          ),
        importCustomerBatch: (...args) =>
          telemetry.phaseEffect('database.importCustomerBatch', () =>
            databaseOperations.importCustomerBatch(...args)
          ),
        backupDatabase: (...args) =>
          telemetry.phaseEffect('database.backupDatabase', () =>
            databaseOperations.backupDatabase(...args)
          ),
      },
      settings: new FileDatabaseSettings(join(app.getPath('userData'), 'database.json')),
      migrationsFolder: app.isPackaged
        ? join(process.resourcesPath, 'migrations')
        : join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations'),
      dialogs: createNativeDialogs(() => window),
      phase: telemetry.phase,
      effectPhase: telemetry.phaseEffect,
      drafts,
      logError,
    });

    stopIpc = registerIpc({
      ipc: ipcMain,
      telemetrySettings,
      observeAction: telemetry.observeAction,
      service,
      drafts,
      currentDocument: () => documentTracker?.currentDocument() ?? null,
      onDocumentChanged,
      ready: async () => {
        await starting;
      },
      logError,
    });
    starting = telemetry
      .phase('application.startup', () => service!.start())
      .catch(logError);
    createWindow();
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{role: 'appMenu' as const}] : []),
        {label: 'File', submenu: [{role: 'quit'}]},
        {role: 'editMenu'},
        {
          label: 'View',
          submenu: [
            {
              label: 'Reload',
              accelerator: 'CmdOrCtrl+R',
              click: () => {
                if (window) {
                  void reloadWindow(window);
                }
              },
            },
          ],
        },
        {role: 'windowMenu'},
      ])
    );
    app.on('activate', () => {
      if (!shuttingDown && BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  })
  .catch(logError);

function closeBackend(quit: boolean): Promise<void> {
  quitRequested ||= quit;
  shutdown ??= (async () => {
    await starting;
    const result = await telemetry.phase('application.shutdown', () =>
      service?.requestClose()
    );
    if (result?.status === 'success') {
      await telemetry.flush();
      backendClosed = true;
      if (quitRequested) {
        shuttingDown = true;
        stopIpc?.();
        stopIpc = null;
        app.quit();
      } else {
        window?.close();
      }
    } else if (result?.status === 'error') {
      await showProtectionFailure();
    }
  })().finally(() => {
    shutdown = null;
    quitRequested = false;
  });
  return shutdown;
}

app.on('before-quit', event => {
  if (backendClosed) {
    return;
  }

  event.preventDefault();
  void closeBackend(true);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Development shutdown requests travel only over the parent process IPC channel.
if (process.env.VITE_DEV_SERVER_URL && process.send) {
  process.on('message', (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'shop-things:quit'
    ) {
      app.quit();
    }
  });
}
