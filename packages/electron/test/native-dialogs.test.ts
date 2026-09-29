import type { MessageBoxReturnValue, OpenDialogReturnValue, SaveDialogReturnValue } from "electron";
import { BrowserWindow } from "electron";
import { beforeEach, expect, test, vi } from "vitest";
import { createNativeDialogs } from "../src/native-dialogs.js";

const boundary = vi.hoisted(() => ({
  showOpenDialog: vi.fn<(...args: unknown[]) => Promise<OpenDialogReturnValue>>(),
  showSaveDialog: vi.fn<(...args: unknown[]) => Promise<SaveDialogReturnValue>>(),
  showMessageBox: vi.fn<(...args: unknown[]) => Promise<MessageBoxReturnValue>>(),
}));
vi.mock("electron", () => ({ dialog: boundary, BrowserWindow: vi.fn(function () {}) }));
beforeEach(() => {
  vi.resetAllMocks();
  boundary.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/selected.db"] });
  boundary.showSaveDialog.mockResolvedValue({ canceled: false, filePath: "/destination.db" });
  boundary.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
});

test("database, export and restore dialogs keep paths in main and use the current parent window", async () => {
  let window: BrowserWindow | null = new BrowserWindow();
  const first = window;
  const dialogs = createNativeDialogs(() => window);
  expect(await dialogs.createDatabase()).toBe("/destination.db");
  expect(boundary.showSaveDialog).toHaveBeenLastCalledWith(
    first,
    expect.objectContaining({ title: "Create customer database", defaultPath: "customers.sqlite" }),
  );
  expect(await dialogs.openDatabase()).toBe("/selected.db");
  expect(boundary.showOpenDialog).toHaveBeenLastCalledWith(
    first,
    expect.objectContaining({ properties: ["openFile"] }),
  );
  window = new BrowserWindow();
  expect(await dialogs.exportCsv()).toBe("/destination.db");
  expect(boundary.showSaveDialog).toHaveBeenLastCalledWith(
    window,
    expect.objectContaining({
      title: "Export all saved customers",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    }),
  );
  expect(await dialogs.backupDatabase()).toBe("/destination.db");
  expect(boundary.showSaveDialog).toHaveBeenLastCalledWith(
    window,
    expect.objectContaining({ title: "Back up saved customers" }),
  );
  expect(await dialogs.restoreSource()).toBe("/selected.db");
  expect(boundary.showOpenDialog).toHaveBeenLastCalledWith(
    window,
    expect.objectContaining({ title: "Choose backup to restore" }),
  );
  expect(await dialogs.restoreDestination()).toBe("/destination.db");
  expect(boundary.showSaveDialog).toHaveBeenLastCalledWith(
    window,
    expect.objectContaining({ title: "Create restored working database" }),
  );
  window = null;
  const count = boundary.showOpenDialog.mock.calls.length;
  await expect(dialogs.openDatabase()).rejects.toThrow("window is unavailable");
  expect(boundary.showOpenDialog).toHaveBeenCalledTimes(count);
});

test("cancelled or empty native file selections produce cancellation", async () => {
  const dialogs = createNativeDialogs(() => new BrowserWindow());
  boundary.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: ["/ignored.db"] });
  boundary.showSaveDialog.mockResolvedValue({ canceled: true, filePath: "/ignored.db" });
  for (const method of [
    () => dialogs.createDatabase(),
    () => dialogs.openDatabase(),
    () => dialogs.exportCsv(),
    () => dialogs.backupDatabase(),
    () => dialogs.restoreSource(),
    () => dialogs.restoreDestination(),
  ]) {
    expect(await method()).toBeNull();
  }

  boundary.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
  boundary.showSaveDialog.mockResolvedValue({ canceled: false, filePath: "" });
  expect(await dialogs.openDatabase()).toBeNull();
  expect(await dialogs.createDatabase()).toBeNull();
});

test("only explicit discard approval succeeds and escape/default keep edits", async () => {
  const window = new BrowserWindow();
  const dialogs = createNativeDialogs(() => window);
  expect(await dialogs.confirmDiscard()).toBe(false);
  expect(boundary.showMessageBox).toHaveBeenLastCalledWith(
    window,
    expect.objectContaining({
      buttons: ["Keep editing", "Discard changes"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }),
  );
  boundary.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
  expect(await dialogs.confirmDiscard()).toBe(true);
  boundary.showMessageBox.mockRejectedValue(new Error("native dialog failure"));
  await expect(dialogs.confirmDiscard()).rejects.toThrow("native dialog failure");
});
