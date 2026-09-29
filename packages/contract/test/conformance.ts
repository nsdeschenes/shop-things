import type { ActionHandlers, CustomerRecord, ShopThingsBridge } from "@shop-things/contract";
import { createClient } from "@shop-things/contract/client";

export async function conformance(bridge: ShopThingsBridge, handlers: ActionHandlers) {
  const client = createClient(bridge);
  const result = await client.customers.list({ session: "session", query: "Smith" });
  if (result.status === "success") {
    const records: CustomerRecord[] = result.value;
    await client.customers.update({
      reference: records[0]!.reference,
      changes: { balance: "12.34" },
    });
  }

  // @ts-expect-error Result must be narrowed before reading success value.
  void result.value;
  // @ts-expect-error List requires a session.
  await client.customers.list({ query: "Smith" });
  await client.customers.update({
    reference: { session: "s", id: 1, revision: "r" },
    // @ts-expect-error Numeric money is not a transport value.
    changes: { balance: 12 },
  });
  await client.customers.update({
    // @ts-expect-error Revision is required for update.
    reference: { session: "s", id: 1 },
    changes: { firstName: "A" },
  });
  await client.customers.update({
    reference: { session: "s", id: 1, revision: "r" },
    // @ts-expect-error Generated identity cannot be edited.
    changes: { id: 2 },
  });
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
  await client.customers.create({ session: "s", values });
  // @ts-expect-error Creation excludes generated business number.
  await client.customers.create({ session: "s", values: { ...values, customerNumber: 1 } });
  // @ts-expect-error Creation excludes generated identity.
  await client.customers.create({ session: "s", values: { ...values, id: 1 } });
  // @ts-expect-error Arbitrary filesystem paths are forbidden.
  await client.database.open({ path: "/tmp/file" });
  // @ts-expect-error Wrong identifier type.
  await client.customers.get({ session: "s", id: "1" });
  // @ts-expect-error Handler result must match the schema.
  const incompatible: ActionHandlers["customers.get"] = async () => ({
    status: "success",
    value: 1,
  });
  void incompatible;
  // @ts-expect-error Complete handler map is required.
  const incomplete: ActionHandlers = { "customers.list": handlers["customers.list"] };
  void incomplete;
  client.database.onStateChanged((state) => {
    void state.version;
  });
  client.drafts.registerProtection({
    prepare: async (request) => ({ ...request, hasUnsavedDraft: true }),
    resolve: (payload) => {
      void payload.outcome;
    },
  });
}
