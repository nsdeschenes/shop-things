import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient, applyNewerDatabaseState } from "@shop-things/contract/client";
import type { DatabaseState, ShopThingsBridge } from "@shop-things/contract";
import { expect, test } from "vitest";

type BackendModule = typeof import("../src/action-service.js");
type DraftModule = typeof import("../src/draft-coordinator.js");
type SettingsModule = typeof import("../src/settings.js");
function success<T>(
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

// This journey imports only emitted runtime code. Run prerequisite/main builds before this test.
test("compiled client and real compiled backend complete the saved-data lifecycle", async () => {
  const electronPackage = fileURLToPath(new URL("..", import.meta.url));
  const backend: BackendModule = await import(
    pathToFileURL(join(electronPackage, "dist/action-service.js")).href
  );
  const draftsModule: DraftModule = await import(
    pathToFileURL(join(electronPackage, "dist/draft-coordinator.js")).href
  );
  const settingsModule: SettingsModule = await import(
    pathToFileURL(join(electronPackage, "dist/settings.js")).href
  );
  const database = await import("@shop-things/db");
  const directory = await mkdtemp(join(tmpdir(), "shop-things-connected-"));
  const migrationsFolder = fileURLToPath(new URL("../../db/migrations", import.meta.url));
  const workingPath = join(directory, "working.db"),
    backupPath = join(directory, "backup.db"),
    restoredPath = join(directory, "restored.db"),
    csvPath = join(directory, "customers.csv");
  const connections = new Set<object>();
  function track(handle: Awaited<ReturnType<typeof backend.databaseOperations.createDatabase>>) {
    connections.add(handle);
    return {
      ...handle,
      close() {
        handle.close();
        connections.delete(handle);
      },
    };
  }

  const operations = {
    ...backend.databaseOperations,
    createDatabase: async (...args: Parameters<typeof backend.databaseOperations.createDatabase>) =>
      track(await backend.databaseOperations.createDatabase(...args)),
    openExistingDatabase: async (
      ...args: Parameters<typeof backend.databaseOperations.openExistingDatabase>
    ) => track(await backend.databaseOperations.openExistingDatabase(...args)),
  };
  const drafts = new draftsModule.DraftCoordinator();
  const settings = new settingsModule.FileDatabaseSettings(join(directory, "settings.json"));
  const options = {
    migrationsFolder,
    settings,
    drafts,
    database: operations,
    dialogs: {
      createDatabase: async () => workingPath,
      openDatabase: async () => restoredPath,
      exportCsv: async () => csvPath,
      backupDatabase: async () => backupPath,
      restoreSource: async () => backupPath,
      restoreDestination: async () => restoredPath,
      confirmDiscard: async () => true,
    },
  };
  const service = new backend.ActionService(options);
  let releaseInitial!: () => void;
  let initialReached!: () => void;
  const initialGate = new Promise<void>((done) => {
    releaseInitial = done;
  });
  const initialStarted = new Promise<void>((done) => {
    initialReached = done;
  });
  let holdInitial = true;
  function bridgeFor(target: InstanceType<BackendModule["ActionService"]>): ShopThingsBridge {
    return {
      customers: {
        list: target.handlers["customers.list"],
        get: target.handlers["customers.get"],
        create: target.handlers["customers.create"],
        update: target.handlers["customers.update"],
        delete: target.handlers["customers.delete"],
      },
      database: {
        async status() {
          const response = await target.handlers["database.status"]();
          if (holdInitial) {
            holdInitial = false;
            initialReached();
            await initialGate;
          }

          return response;
        },
        retry: target.handlers["database.retry"],
        create: target.handlers["database.create"],
        open: target.handlers["database.open"],
        backup: target.handlers["database.backup"],
        restore: target.handlers["database.restore"],
        onStateChanged: (callback) => target.onStateChanged(callback),
      },
      exports: { csv: target.handlers["exports.csv"] },
      drafts: {
        confirmDiscard: target.handlers["drafts.confirmDiscard"],
        registerProtection(protection) {
          const participant = {
            documentId: "connected-document",
            prepare(request: Parameters<typeof protection.prepare>[0]) {
              void protection
                .prepare(request)
                .then((reply) => {
                  drafts.reply(participant, reply);
                })
                .catch(() => {
                  drafts.reply(participant, null);
                });
            },
            resolve: protection.resolve,
          };
          return drafts.register(participant);
        },
      },
    };
  }

  const client = createClient(bridgeFor(service));
  let state: DatabaseState | null = null;
  const events: DatabaseState[] = [];
  const unsubscribe = client.database.onStateChanged((next) => {
    events.push(next);
    state = applyNewerDatabaseState(state, next);
  });
  let frozen = false,
    unsavedDraft = "local unsaved edits",
    selection: number | null = 1;
  const unregister = client.drafts.registerProtection({
    async prepare(request) {
      frozen = true;
      return { ...request, hasUnsavedDraft: unsavedDraft !== "" };
    },
    resolve(resolution) {
      frozen = false;
      if (resolution.outcome === "committed") {
        unsavedDraft = "";
        selection = null;
      }
    },
  });
  let fresh: InstanceType<BackendModule["ActionService"]> | null = null;
  try {
    await service.start();
    expect(service.status().available).toBe(false);
    expect(connections.size).toBe(0);
    expect(await client.customers.list({ session: "absent", query: "" })).toMatchObject({
      status: "error",
      error: { code: "DATABASE_UNAVAILABLE" },
    });
    const initial = client.database.status();
    await initialStarted;
    const createdState = success(await client.database.create());
    expect(createdState.selectedPath).toBe(workingPath);
    expect(connections.size).toBe(1);
    releaseInitial();
    state = applyNewerDatabaseState(state, success(await initial));
    expect(state).toEqual(createdState);
    const session = createdState.session!;
    const values = {
      firstName: "Ada",
      lastName: "Lovelace",
      address: "",
      city: "",
      province: "",
      postalCode: "",
      homePhone: "",
      email: "",
      stock: 0,
      balance: "12.34",
      previousBalance: "-1.01",
      donate: false,
      comments: 'Saved "notes", line\ntwo',
    };
    const created = success(await client.customers.create({ session, values }));
    expect(created.customer).toEqual({ ...values, id: 1, customerNumber: 1 });
    expect(created.reference).toEqual({ session, id: 1, revision: expect.any(String) });
    expect(success(await client.customers.list({ session, query: "" }))).toEqual([created]);
    expect(success(await client.customers.get({ session, id: 1 }))).toEqual(created);
    const updated = success(
      await client.customers.update({
        reference: created.reference,
        changes: { stock: 3, balance: "23.45" },
      }),
    );
    expect(updated.customer).toEqual({ ...created.customer, stock: 3, balance: "23.45" });
    expect(updated.reference.revision).not.toBe(created.reference.revision);
    expect(await client.customers.delete({ reference: created.reference })).toMatchObject({
      status: "error",
      error: { code: "STALE_REVISION" },
    });
    expect(success(await client.customers.list({ session, query: " love " }))).toEqual([updated]);
    success(
      await client.customers.create({
        session,
        values: { ...values, firstName: "Grace", lastName: "Hopper" },
      }),
    );
    const csv = success(await client.exports.csv({ session }));
    expect(csv.path).toBe(csvPath);
    const content = await readFile(csvPath, "utf8");
    expect(content).toContain('"Ada"');
    expect(content).toContain('"Grace"');
    expect(content).toContain('"23.45"');
    expect(content).toContain('"Saved ""notes"", line\ntwo"');
    expect(content).not.toContain(unsavedDraft);
    expect(content).not.toContain("revision");
    expect(success(await client.database.backup({ session }))).toEqual({ path: backupPath });
    expect(frozen).toBe(false);
    expect(unsavedDraft).toBe("local unsaved edits");
    const sourceBackup = await readFile(backupPath);
    const modified = success(
      await client.customers.update({
        reference: updated.reference,
        changes: { balance: "99.99" },
      }),
    );
    const snapshot = await database.openExistingDatabase(backupPath, { migrationsFolder });
    try {
      expect((await database.getCustomer(snapshot.db, 1))?.balance).toBe("23.45");
    } finally {
      snapshot.close();
    }

    const restored = success(await client.database.restore());
    expect(restored.selectedPath).toBe(restoredPath);
    expect(restored.session).not.toBe(session);
    expect(connections.size).toBe(1);
    expect(await readFile(backupPath)).toEqual(sourceBackup);
    expect(await settings.read()).toBe(restoredPath);
    expect({ frozen, unsavedDraft, selection }).toEqual({
      frozen: false,
      unsavedDraft: "",
      selection: null,
    });
    const restoredRecord = success(
      await client.customers.get({ session: restored.session!, id: 1 }),
    );
    expect(restoredRecord.customer.balance).toBe("23.45");
    expect(
      await client.customers.update({
        reference: modified.reference,
        changes: { balance: "1.00" },
      }),
    ).toMatchObject({ status: "error", error: { code: "STALE_SESSION" } });
    const original = await database.openExistingDatabase(workingPath, { migrationsFolder });
    try {
      expect((await database.getCustomer(original.db, 1))?.balance).toBe("99.99");
    } finally {
      original.close();
    }

    success(await service.requestClose());
    expect(connections.size).toBe(0);
    fresh = new backend.ActionService(options);
    await fresh.start();
    const freshClient = createClient(bridgeFor(fresh));
    const reopened = success(await freshClient.database.status());
    expect(reopened.selectedPath).toBe(restoredPath);
    expect(reopened.session).not.toBe(restored.session);
    expect(
      await freshClient.customers.delete({ reference: restoredRecord.reference }),
    ).toMatchObject({ status: "error", error: { code: "STALE_SESSION" } });
    const current = success(await freshClient.customers.get({ session: reopened.session!, id: 1 }));
    expect(current.customer).toEqual(restoredRecord.customer);
    expect(success(await freshClient.customers.delete({ reference: current.reference }))).toEqual({
      deleted: true,
    });
    expect(await freshClient.customers.get({ session: reopened.session!, id: 1 })).toMatchObject({
      status: "error",
      error: { code: "CUSTOMER_DELETED" },
    });
    expect(
      success(await freshClient.customers.list({ session: reopened.session!, query: "" })),
    ).toHaveLength(1);
    success(await fresh.requestClose());
    expect(connections.size).toBe(0);
    const persisted = await database.openExistingDatabase(restoredPath, { migrationsFolder });
    try {
      expect(await database.getCustomer(persisted.db, 1)).toBeNull();
      expect((await database.listCustomers(persisted.db)).map((row) => row.firstName)).toEqual([
        "Grace",
      ]);
    } finally {
      persisted.close();
    }

    unsubscribe();
    const eventCount = events.length;
    service.closeUnprotected();
    expect(events).toHaveLength(eventCount);
  } finally {
    releaseInitial();
    unsubscribe();
    unregister();
    service.closeUnprotected();
    fresh?.closeUnprotected();
    expect(connections.size).toBe(0);
    await rm(directory, { recursive: true, force: true });
  }
});
