/* oxlint-disable import/no-named-export -- Backend APIs are consumed by IPC and packaged runners. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionServiceOptions, BackendDialogs } from "../src/action-service.js";
import { ActionService } from "../src/action-service.js";
import { FileDatabaseSettings } from "../src/settings.js";

export const migrationsFolder = fileURLToPath(new URL("../../db/migrations", import.meta.url));
export const values = {
  firstName: "Anne",
  lastName: "Smith",
  address: "",
  city: "",
  province: "",
  postalCode: "",
  homePhone: "",
  email: "",
  stock: 0,
  balance: "12.34",
  previousBalance: "0.00",
  donate: false,
  comments: "",
};
export function success<T>(
  result:
    | { status: "success"; value: T }
    | { status: "cancelled" }
    | { status: "error"; error: unknown },
): T {
  if (result.status !== "success") {
    throw new Error(`Expected success: ${JSON.stringify(result)}`);
  }

  return result.value;
}

export async function fixture(overrides: Partial<ActionServiceOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "shop-things-backend-"));
  const choices = {
    create: join(directory, "work.db") as string | null,
    open: null as string | null,
    csv: join(directory, "customers.csv") as string | null,
    backup: join(directory, "backup.db") as string | null,
    restoreSource: join(directory, "backup.db") as string | null,
    restoreDestination: join(directory, "restored.db") as string | null,
    discard: true,
  };
  const dialogs: BackendDialogs = {
    createDatabase: async () => choices.create,
    openDatabase: async () => choices.open,
    exportCsv: async () => choices.csv,
    backupDatabase: async () => choices.backup,
    restoreSource: async () => choices.restoreSource,
    restoreDestination: async () => choices.restoreDestination,
    confirmDiscard: async () => choices.discard,
  };
  const settings = new FileDatabaseSettings(join(directory, "settings.json"));
  const options = { migrationsFolder, settings, dialogs, ...overrides };
  const service = new ActionService(options);
  return {
    directory,
    choices,
    options,
    service,
    settings,
    cleanup: async () => {
      service.closeUnprotected();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
