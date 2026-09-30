import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {app, BrowserWindow, ipcMain} from 'electron';

import {ActionService} from './actionService.js';
import {DraftCoordinator} from './draftCoordinator.js';
import {registerIpc} from './ipc.js';
import {createNativeDialogs} from './nativeDialogs.js';
import {FileDatabaseSettings} from './settings.js';

let window: BrowserWindow | null = null;
let service: ActionService | null = null;
let stopIpc: (() => void) | null = null;
let starting: Promise<void> | null = null;
let shutdown: Promise<void> | null = null;
let shuttingDown = false;
let backendClosed = false;

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {contextIsolation: true, sandbox: true, nodeIntegration: false},
  });
  window = win;
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    const rendererHtml = join(
      dirname(fileURLToPath(import.meta.url)),
      'renderer',
      'index.html'
    );
    void win.loadFile(rendererHtml);
  }
}

void app.whenReady().then(async () => {
  if (shuttingDown) {
    return;
  }

  const drafts = new DraftCoordinator();
  service = new ActionService({
    settings: new FileDatabaseSettings(join(app.getPath('userData'), 'database.json')),
    migrationsFolder: app.isPackaged
      ? join(process.resourcesPath, 'migrations')
      : join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations'),
    dialogs: createNativeDialogs(() => window),
    drafts,
    logError: error => {
      console.error(error);
    },
  });

  // The backend is ready, while renderer authorization/protected hooks remain inactive.
  stopIpc = registerIpc({
    ipc: ipcMain,
    service,
    drafts,
    currentDocument: () => null,
    onDocumentChanged: () => () => {},
    logError: error => {
      console.error(error);
    },
  });
  starting = service.start();
  await starting;
  if (shuttingDown) {
    return;
  }

  createWindow();
  app.on('activate', () => {
    if (!shuttingDown && BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

function closeBackend(): Promise<void> {
  shuttingDown = true;
  shutdown ??= (async () => {
    await starting;
    await service?.closeUnprotectedWhenIdle();
    stopIpc?.();
    stopIpc = null;
    backendClosed = true;
  })();
  return shutdown;
}

app.on('before-quit', event => {
  if (backendClosed) {
    return;
  }

  event.preventDefault();
  void closeBackend().then(() => {
    app.quit();
  });
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
