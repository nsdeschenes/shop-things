import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actions,
  databaseStateSchema,
  draftRequestSchema,
  draftReplySchema,
  draftResolutionSchema,
  customerRecordSchema,
} from "../dist/schemas.js";
import { createClient, getClient, applyNewerDatabaseState } from "../dist/client.js";

const unavailableBridge = /bridge is unavailable/;
const mismatchedReply = /does not match/;

const state = { available: false, selectedPath: null, session: null, version: 0 };
const values = {
  firstName: "A",
  lastName: "",
  address: "",
  city: "",
  province: "",
  postalCode: "",
  homePhone: "",
  email: "",
  stock: 0,
  balance: "0.00",
  previousBalance: "0.00",
  donate: false,
  comments: "",
};
const reference = { session: "session", id: 1, revision: "revision" };
const record = { customer: { ...values, id: 1, customerNumber: 1 }, reference };
function makeBridge() {
  const listeners = new Set();
  let protection;
  const bridge = {
    customers: {
      list: async () => ({ status: "success", value: [record] }),
      get: async () => ({ status: "success", value: record }),
      create: async () => ({ status: "success", value: record }),
      update: async () => ({ status: "success", value: record }),
      delete: async () => ({ status: "success", value: { deleted: true } }),
    },
    database: {
      status: async () => ({ status: "success", value: state }),
      retry: async () => ({ status: "cancelled" }),
      create: async () => ({ status: "cancelled" }),
      open: async () => ({ status: "cancelled" }),
      backup: async () => ({ status: "success", value: { path: "/backup" } }),
      restore: async () => ({ status: "cancelled" }),
      onStateChanged(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
    exports: { csv: async () => ({ status: "success", value: { path: "/export" } }) },
    drafts: {
      confirmDiscard: async () => ({ status: "success", value: { approved: true } }),
      registerProtection(value) {
        protection = value;
        return () => {
          protection = undefined;
        };
      },
    },
  };
  return {
    bridge,
    listeners,
    get protection() {
      return protection;
    },
  };
}

test("strict schemas reject malformed arguments, writes and envelopes", () => {
  for (const [name, definition] of Object.entries(actions)) {
    assert.equal(definition.arguments.safeParse({ arbitrary: 1 }).success, false, name);
    for (const payload of [
      { status: "success" },
      { status: "cancelled", value: 1 },
      { status: "error", error: { code: "OTHER", message: "bad" } },
      { status: "error", error: { code: "INTERNAL", message: "bad", stack: "secret" } },
    ]) {
      assert.equal(definition.result.safeParse(payload).success, false, name);
    }
  }

  for (const extra of [
    { id: 1 },
    { customerNumber: 1 },
    { balance: 1 },
    { balance: "1.234" },
    { donate: 1 },
  ]) {
    assert.equal(
      actions["customers.create"].arguments.safeParse({
        session: "s",
        values: { ...values, ...extra },
      }).success,
      false,
    );
  }

  assert.equal(
    actions["customers.update"].arguments.safeParse({ reference, changes: { id: 2 } }).success,
    false,
  );
  assert.equal(
    actions["customers.update"].arguments.safeParse({
      reference: { session: "s", id: 1 },
      changes: {},
    }).success,
    false,
  );
  assert.equal(
    customerRecordSchema.safeParse({ ...record, reference: { ...reference, id: 2 } }).success,
    false,
  );
  assert.equal(databaseStateSchema.safeParse({ ...state, available: true }).success, false);
  assert.equal(draftRequestSchema.safeParse({ requestId: "r" }).success, false);
  assert.equal(
    draftReplySchema.safeParse({ requestId: "r", documentId: "d", hasUnsavedDraft: 1 }).success,
    false,
  );
  assert.equal(
    draftResolutionSchema.safeParse({ requestId: "r", documentId: "d", outcome: "unknown" })
      .success,
    false,
  );
});
test("named calls preserve outcomes and contain rejected or malformed transport", async () => {
  const { bridge } = makeBridge();
  const client = createClient(bridge);
  assert.deepEqual(await client.customers.list({ session: "s", query: "" }), {
    status: "success",
    value: [record],
  });
  assert.deepEqual(await client.database.open(), { status: "cancelled" });
  const expected = { status: "error", error: { code: "STALE_SESSION", message: "Reload." } };
  bridge.customers.get = async () => expected;
  assert.deepEqual(await client.customers.get({ session: "s", id: 1 }), expected);
  bridge.customers.get = async () => {
    throw new Error("private stack/database detail");
  };

  assert.deepEqual(await client.customers.get({ session: "s", id: 1 }), {
    status: "error",
    error: { code: "INTERNAL", message: "The application could not complete the request." },
  });
  bridge.customers.get = async () => ({ status: "success", value: "malformed" });
  assert.equal((await client.customers.get({ session: "s", id: 1 })).error.code, "INTERNAL");
  let calls = 0;
  bridge.customers.create = async () => {
    calls++;
    return { status: "success", value: record };
  };

  assert.equal(
    (await client.customers.create({ session: "s", values: { ...values, id: 2 } })).error.code,
    "VALIDATION",
  );
  assert.equal(calls, 0);
  assert.throws(() => getClient(), unavailableBridge);
  globalThis.window = { shopThings: {} };
  assert.throws(() => getClient(), unavailableBridge);
  globalThis.window = { shopThings: bridge };
  assert.equal((await getClient().database.status()).status, "success");
  delete globalThis.window;
});
test("validated payload-only subscriptions unsubscribe and reject invalid drafts", async () => {
  const fixture = makeBridge();
  const client = createClient(fixture.bridge);
  const delivered = [];
  const unsubscribe = client.database.onStateChanged((value) => delivered.push(value));
  const listener = [...fixture.listeners][0];
  listener({ ...state, version: -1 });
  listener(state);
  assert.deepEqual(delivered, [state]);
  unsubscribe();
  unsubscribe();
  listener({ ...state, version: 1 });
  assert.equal(fixture.listeners.size, 0);
  assert.equal(delivered.length, 1);
  let prepares = 0;
  const resolutions = [];
  const stop = client.drafts.registerProtection({
    prepare: async (request) => {
      prepares++;
      return { ...request, hasUnsavedDraft: true };
    },
    resolve: (payload) => resolutions.push(payload),
  });
  const handler = fixture.protection;
  await assert.rejects(handler.prepare({ requestId: "r" }));
  assert.equal(prepares, 0);
  assert.deepEqual(await handler.prepare({ requestId: "r", documentId: "d" }), {
    requestId: "r",
    documentId: "d",
    hasUnsavedDraft: true,
  });
  handler.resolve({ requestId: "r", documentId: "d", outcome: "invalid" });
  assert.equal(resolutions.length, 0);
  handler.resolve({ requestId: "wrong", documentId: "d", outcome: "aborted" });
  assert.equal(resolutions.length, 0);
  handler.resolve({ requestId: "r", documentId: "d", outcome: "aborted" });
  assert.equal(resolutions.length, 1);
  handler.resolve({ requestId: "r", documentId: "d", outcome: "committed" });
  assert.equal(resolutions.length, 1);
  stop();
  handler.resolve({ requestId: "r", documentId: "d", outcome: "committed" });
  assert.equal(resolutions.length, 1);
  await assert.rejects(handler.prepare({ requestId: "r", documentId: "d" }));
  assert.equal(fixture.protection, undefined);
  client.drafts.registerProtection({
    prepare: async () => ({ requestId: "wrong", documentId: "d", hasUnsavedDraft: false }),
    resolve() {},
  });
  await assert.rejects(
    fixture.protection.prepare({ requestId: "r", documentId: "d" }),
    mismatchedReply,
  );
});
test("a later event cannot be overwritten by initial status", () => {
  const event = { ...state, version: 2 };
  assert.equal(applyNewerDatabaseState(event, state), event);
  assert.equal(applyNewerDatabaseState(event, { ...state, version: 2 }), event);
  assert.equal(applyNewerDatabaseState(null, event), event);
});
