import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {app, BrowserWindow, ipcMain, Menu, dialog} from 'electron';

import {ActionService} from './actionService.js';
import {isTrustedRendererUrl, trackAuthorizedDocument} from './document.js';
import {DraftCoordinator} from './draftCoordinator.js';
import {registerIpc} from './ipc.js';
import {createNativeDialogs} from './nativeDialogs.js';
import {acknowledgeRestartReady} from './restartSupervisor.js';
import {FileDatabaseSettings} from './settings.js';
import {inspectUpdateCapabilities} from './updateCapabilities.js';
import {UpdateDiscovery} from './updateDiscovery.js';

let updates: UpdateDiscovery | null = null;
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
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));

  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(rendererHtml);
  }
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
    console.error(error);
  }
}

async function reloadWindow(win: BrowserWindow) {
  if (!service || shutdown || win.isDestroyed()) {
    return;
  }

  const result = await service.requestReload(() => {
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
  });
  if (result.status === 'error') {
    await showProtectionFailure();
  }
}

void app.whenReady().then(async () => {
  if (shuttingDown) {
    return;
  }

  const drafts = new DraftCoordinator();
  service = new ActionService({
    settings: new FileDatabaseSettings(join(app.getPath('userData'), 'database.json')),
    migrationBackupDirectory: join(app.getPath('userData'), 'migration-backups'),
    migrationsFolder: app.isPackaged
      ? join(process.resourcesPath, 'migrations')
      : join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations'),
    dialogs: createNativeDialogs(() => window),
    drafts,
    logError: error => {
      console.error(error);
    },
  });

  const capabilities = await inspectUpdateCapabilities({
    packaged: app.isPackaged,
    appVersion: app.getVersion(),
  });
  const {trustedKeys, packageVersion, packageIdentityAvailable} = capabilities;
  const capabilityReasons = [
    'Installation is not available yet.',
    ...capabilities.reasons,
  ];

  updates = new UpdateDiscovery({
    appVersion: app.getVersion(),
    packageVersion,
    trustedKeys,
    capabilityReasons,
    ...(packageIdentityAvailable && process.arch === 'arm64'
      ? {download: {directory: join(app.getPath('userData'), 'updates')}}
      : {}),
  });

  stopIpc = registerIpc({
    updates,
    ipc: ipcMain,
    service,
    drafts,
    currentDocument: () => documentTracker?.currentDocument() ?? null,
    onDocumentChanged,
    onRendererReady: async () => {
      await starting;
      await acknowledgeRestartReady();
    },
    ready: async () => {
      await starting;
    },
    logError: error => {
      console.error(error);
    },
  });
  starting = service.start().catch(error => {
    console.error(error);
  });
  createWindow();
  updates.startChecking();
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
      updates?.startChecking();
    }
  });
});

function closeBackend(quit: boolean): Promise<void> {
  quitRequested ||= quit;
  shutdown ??= (async () => {
    await starting;
    const result = await service?.requestClose();
    if (result?.status === 'success') {
      backendClosed = true;
      if (quitRequested) {
        shuttingDown = true;
        updates?.stop();
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
  updates?.stop();
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
