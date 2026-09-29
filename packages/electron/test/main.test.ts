import { fileURLToPath } from "node:url";
import { beforeEach, expect, test, vi } from "vitest";

// Electron APIs require a desktop runtime; mock that boundary and run the real entry point.
const electron = vi.hoisted(() => {
  const loadURL = vi.fn();
  const loadFile = vi.fn();
  return {
    app: {
      whenReady: vi.fn<() => Promise<void>>(),
      on: vi.fn<(event: string, listener: () => void) => void>(),
      quit: vi.fn(),
      getPath: vi.fn(() => "/tmp/shop-things-main-test-empty-settings"),
      isPackaged: false,
    },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
    BrowserWindow: Object.assign(
      vi.fn(function (this: { loadURL: typeof loadURL; loadFile: typeof loadFile }) {
        this.loadURL = loadURL;
        this.loadFile = loadFile;
      }),
      { getAllWindows: vi.fn<() => object[]>() },
    ),
    loadURL,
    loadFile,
  };
});

vi.mock("electron", () => electron);

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_DEV_SERVER_URL", "");
  electron.app.whenReady.mockResolvedValue(undefined);
  electron.app.getPath.mockReturnValue("/tmp/shop-things-main-test-empty-settings");
  electron.BrowserWindow.getAllWindows.mockReturnValue([]);
});

async function startApp() {
  await import("../src/main.ts");
  await vi.waitFor(() => expect(electron.BrowserWindow).toHaveBeenCalledTimes(1));
}

test("loads the development server when configured", async () => {
  vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5173");
  await startApp();

  expect(electron.BrowserWindow).toHaveBeenCalledWith({
    width: 800,
    height: 600,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  expect(electron.loadURL).toHaveBeenCalledWith("http://127.0.0.1:5173");
  expect(electron.loadFile).not.toHaveBeenCalled();
});

test("loads the bundled renderer without a development server", async () => {
  await startApp();

  expect(electron.loadFile).toHaveBeenCalledWith(
    fileURLToPath(new URL("../src/renderer/index.html", import.meta.url)),
  );
  expect(electron.loadURL).not.toHaveBeenCalled();
});

test("activation opens a window only when none remain", async () => {
  await startApp();
  const activate = electron.app.on.mock.calls.find(([event]) => event === "activate")?.[1];
  if (!activate) {
    throw new Error("The app did not register an activation listener");
  }

  electron.BrowserWindow.getAllWindows.mockReturnValue([{}]);
  activate();
  expect(electron.BrowserWindow).toHaveBeenCalledTimes(1);

  electron.BrowserWindow.getAllWindows.mockReturnValue([]);
  activate();
  expect(electron.BrowserWindow).toHaveBeenCalledTimes(2);
});

test("keeps preload and renderer-dependent protection inactive", async () => {
  await startApp();
  expect(electron.BrowserWindow).toHaveBeenCalledWith({
    width: 800,
    height: 600,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const status = electron.ipcMain.handle.mock.calls.find(
    ([channel]) => channel === "shop-things:database.status",
  )?.[1];
  expect(
    await status?.(
      { sender: {}, senderFrame: {} },
      { documentId: "arbitrary", arguments: undefined },
    ),
  ).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  const closed = electron.app.on.mock.calls.find(([event]) => event === "window-all-closed")?.[1];
  closed?.();
  expect(electron.app.quit).toHaveBeenCalledTimes(process.platform === "darwin" ? 0 : 1);
});

test("placeholder quit waits startup, avoids creating a window and closes the backend once", async () => {
  const { FileDatabaseSettings } = await import("../src/settings.js");
  const { ActionService } = await import("../src/action-service.js");
  let complete!: (value: null) => void;
  const reading = new Promise<null>((resolve) => {
    complete = resolve;
  });
  const read = vi.spyOn(FileDatabaseSettings.prototype, "read").mockReturnValue(reading);
  const close = vi.spyOn(ActionService.prototype, "closeUnprotectedWhenIdle");
  try {
    await import("../src/main.ts");
    await vi.waitFor(() => expect(electron.ipcMain.handle).toHaveBeenCalled());
    const quitting = electron.app.on.mock.calls.find(([event]) => event === "before-quit")?.[1];
    if (!quitting) {
      throw new Error("Missing shutdown listener");
    }

    const event = { preventDefault: vi.fn() };
    Reflect.apply(quitting, undefined, [event]);
    Reflect.apply(quitting, undefined, [event]);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(electron.app.quit).not.toHaveBeenCalled();
    complete(null);
    await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalled());
    expect(electron.BrowserWindow).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    complete(null);
    read.mockRestore();
    close.mockRestore();
  }
});
