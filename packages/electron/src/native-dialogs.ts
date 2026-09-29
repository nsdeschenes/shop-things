/* oxlint-disable import/no-named-export -- Main consumes the native dialog factory as a backend boundary. */
import { dialog } from "electron";
import type { BrowserWindow } from "electron";
import type { BackendDialogs } from "./action-service.js";

const databaseFilters = [
  { name: "Shop Things database", extensions: ["sqlite", "sqlite3", "db"] },
  { name: "All files", extensions: ["*"] },
];

export function createNativeDialogs(getWindow: () => BrowserWindow | null): BackendDialogs {
  function currentWindow(): BrowserWindow {
    const window = getWindow();
    if (!window) {
      throw new Error("The application window is unavailable");
    }

    return window;
  }

  async function chooseExisting(title: string): Promise<string | null> {
    const result = await dialog.showOpenDialog(currentWindow(), {
      title,
      properties: ["openFile"],
      filters: databaseFilters,
    });
    return result.canceled ? null : result.filePaths[0] || null;
  }

  async function chooseDestination(
    title: string,
    defaultPath: string,
    csv = false,
  ): Promise<string | null> {
    const result = await dialog.showSaveDialog(currentWindow(), {
      title,
      defaultPath,
      filters: csv ? [{ name: "CSV", extensions: ["csv"] }] : databaseFilters,
    });
    return result.canceled ? null : result.filePath || null;
  }

  return {
    createDatabase: () => chooseDestination("Create customer database", "customers.sqlite"),
    openDatabase: () => chooseExisting("Open customer database"),
    exportCsv: () => chooseDestination("Export all saved customers", "customers.csv", true),
    backupDatabase: () => chooseDestination("Back up saved customers", "customers-backup.sqlite"),
    restoreSource: () => chooseExisting("Choose backup to restore"),
    restoreDestination: () =>
      chooseDestination("Create restored working database", "customers-restored.sqlite"),
    async confirmDiscard() {
      const result = await dialog.showMessageBox(currentWindow(), {
        type: "question",
        message: "Discard unsaved changes?",
        detail: "Your edits have not been saved.",
        buttons: ["Keep editing", "Discard changes"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
  };
}
