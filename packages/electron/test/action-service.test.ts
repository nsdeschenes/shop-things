import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDatabase, openDatabase, getCustomer } from "@shop-things/db";
import { expect, test } from "vitest";
import { ActionService, databaseOperations } from "../src/action-service.js";
import { fixture, migrationsFolder, success, values } from "./backend-fixture.js";

test("first launch offers selection and CRUD persists through a fresh remembered lifecycle", async () => {
  const f = await fixture();
  try {
    await f.service.start();
    expect(f.service.status()).toEqual({
      available: false,
      selectedPath: null,
      session: null,
      version: 0,
    });
    expect(
      await f.service.handlers["customers.list"]({ session: "absent", query: "" }),
    ).toMatchObject({ status: "error", error: { code: "DATABASE_UNAVAILABLE" } });
    const events: unknown[] = [];
    const unsubscribe = f.service.onStateChanged((state) => events.push(state));
    const selected = success(await f.service.handlers["database.create"]());
    const session = selected.session!;
    const created = success(await f.service.handlers["customers.create"]({ session, values }));
    expect(created.customer).toMatchObject({ id: 1, customerNumber: 1, balance: "12.34" });
    expect(
      success(await f.service.handlers["customers.list"]({ session, query: " smi " })),
    ).toEqual([created]);
    expect(success(await f.service.handlers["customers.get"]({ session, id: 1 }))).toEqual(created);
    const updated = success(
      await f.service.handlers["customers.update"]({
        reference: created.reference,
        changes: { balance: "-1.01" },
      }),
    );
    expect(updated.reference.revision).not.toBe(created.reference.revision);
    expect(
      await f.service.handlers["customers.delete"]({ reference: created.reference }),
    ).toMatchObject({ status: "error", error: { code: "STALE_REVISION" } });
    expect(
      await f.service.handlers["customers.list"]({ session: "wrong", query: "" }),
    ).toMatchObject({ status: "error", error: { code: "STALE_SESSION" } });
    expect(await f.service.handlers["database.open"]()).toMatchObject({ status: "error" });
    expect(await f.settings.read()).toBe(f.choices.create);
    f.service.closeUnprotected();
    const reopened = new ActionService(f.options);
    try {
      await reopened.start();
      expect(reopened.status().session).not.toBe(session);
      expect(await reopened.handlers["customers.get"]({ session, id: 1 })).toMatchObject({
        status: "error",
        error: { code: "STALE_SESSION" },
      });
      const record = success(
        await reopened.handlers["customers.get"]({ session: reopened.status().session!, id: 1 }),
      );
      expect(record.customer.balance).toBe("-1.01");
      success(await reopened.handlers["customers.delete"]({ reference: record.reference }));
      expect(
        await reopened.handlers["customers.get"]({ session: reopened.status().session!, id: 1 }),
      ).toMatchObject({ status: "error", error: { code: "CUSTOMER_DELETED" } });
    } finally {
      reopened.closeUnprotected();
    }

    unsubscribe();
    const count = events.length;
    f.service.closeUnprotected();
    expect(events).toHaveLength(count);
    const handle = openDatabase(f.choices.create!);
    try {
      expect(await getCustomer(handle.db, 1)).toBeNull();
    } finally {
      handle.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("remembered missing file recovery never creates a replacement and Retry recovers", async () => {
  const f = await fixture();
  try {
    const remembered = join(f.directory, "missing.db");
    await f.settings.write(remembered);
    await f.service.start();
    expect(f.service.status()).toMatchObject({
      available: false,
      selectedPath: remembered,
      session: null,
      recoveryError: { code: "DATABASE_UNAVAILABLE" },
    });
    await expect(readFile(remembered)).rejects.toMatchObject({ code: "ENOENT" });
    const initialized = await createDatabase(remembered, { migrationsFolder });
    initialized.close();
    const recovered = success(await f.service.handlers["database.retry"]());
    expect(recovered.available).toBe(true);
    expect(recovered.version).toBe(2);
    expect(recovered.recoveryError).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test("cancelled selection, unsupported/read-only candidates and failed persistence keep state safe", async () => {
  const f = await fixture();
  try {
    f.choices.create = null;
    expect(await f.service.handlers["database.create"]()).toEqual({ status: "cancelled" });
    const invalid = join(f.directory, "unrelated.db");
    const handle = openDatabase(invalid);
    await handle.db.run("create table unrelated(id integer)");
    handle.close();
    f.choices.open = invalid;
    expect(await f.service.handlers["database.open"]()).toMatchObject({
      status: "error",
      error: { code: "DATABASE_UNAVAILABLE" },
    });
    const valid = join(f.directory, "valid.db");
    const recognized = await createDatabase(valid, { migrationsFolder });
    recognized.close();
    await chmod(valid, 0o444);
    f.choices.open = valid;
    expect(await f.service.handlers["database.open"]()).toMatchObject({
      status: "error",
      error: { message: expect.stringContaining("writable") },
    });
    await chmod(valid, 0o600);
    let candidateClosed = false;
    const failing = new ActionService({
      ...f.options,
      settings: {
        read: async () => null,
        write: async () => {
          throw new Error("secret settings path");
        },
      },
      database: {
        ...databaseOperations,
        openExistingDatabase: async (...args) => {
          const candidate = await databaseOperations.openExistingDatabase(...args);
          return {
            ...candidate,
            close: () => {
              candidateClosed = true;
              candidate.close();
            },
          };
        },
      },
    });
    expect(await failing.handlers["database.open"]()).toMatchObject({
      status: "error",
      error: { code: "DATABASE_UNAVAILABLE" },
    });
    expect(candidateClosed).toBe(true);
    expect(failing.status().available).toBe(false);
    failing.closeUnprotected();
    expect(await f.settings.read()).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test("one operation is admitted while status bypasses the gate and internal errors stay safe", async () => {
  const f = await fixture();
  let release!: () => void;
  let reached!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const service = new ActionService({
    ...f.options,
    database: {
      ...databaseOperations,
      listCustomers: async (...args) => {
        reached();
        await pending;
        return databaseOperations.listCustomers(...args);
      },
      createCustomer: async () => {
        throw new Error("native secret stack");
      },
    },
  });
  try {
    const state = success(await service.handlers["database.create"]());
    const call = service.handlers["customers.list"]({ session: state.session!, query: "" });
    await started;
    expect(
      await service.handlers["customers.create"]({ session: state.session!, values }),
    ).toMatchObject({ status: "error", error: { code: "BUSY" } });
    expect(success(await service.handlers["database.status"]())).toEqual(state);
    release();
    expect(success(await call)).toEqual([]);
    expect(await service.handlers["customers.create"]({ session: state.session!, values })).toEqual(
      {
        status: "error",
        error: { code: "INTERNAL", message: "The operation failed. Please try again." },
      },
    );
  } finally {
    release();
    service.closeUnprotected();
    await f.cleanup();
  }
});

test("placeholder shutdown waits admitted work and closes once without renderer coordination", async () => {
  const f = await fixture();
  let release!: () => void;
  let reached!: () => void;
  let closed = 0;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const service = new ActionService({
    ...f.options,
    database: {
      ...databaseOperations,
      createDatabase: async (...args) => {
        const handle = await databaseOperations.createDatabase(...args);
        return {
          ...handle,
          close() {
            closed++;
            handle.close();
          },
        };
      },
      listCustomers: async (...args) => {
        reached();
        await pending;
        return databaseOperations.listCustomers(...args);
      },
    },
  });
  try {
    const state = success(await service.handlers["database.create"]());
    const read = service.handlers["customers.list"]({ session: state.session!, query: "" });
    await entered;
    const closing = service.closeUnprotectedWhenIdle();
    expect(service.closeUnprotectedWhenIdle()).toBe(closing);
    expect(closed).toBe(0);
    expect(
      await service.handlers["customers.create"]({ session: state.session!, values }),
    ).toMatchObject({ error: { code: "BUSY" } });
    release();
    expect(success(await read)).toEqual([]);
    await closing;
    expect(closed).toBe(1);
    expect(service.status()).toMatchObject({ available: false, version: state.version + 1 });
  } finally {
    release();
    await service.closeUnprotectedWhenIdle();
    await f.cleanup();
  }
});
