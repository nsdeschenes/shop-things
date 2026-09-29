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
    },
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
  electron.BrowserWindow.getAllWindows.mockReturnValue([]);
});

async function startApp() {
  await import("../src/main.ts");
  await vi.waitFor(() => expect(electron.BrowserWindow).toHaveBeenCalledTimes(1));
}

test("loads the development server when configured", async () => {
  vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5173");
  await startApp();

  expect(electron.BrowserWindow).toHaveBeenCalledWith({ width: 800, height: 600 });
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
