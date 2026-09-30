import type {Client, CustomerRecord, DatabaseState} from '@shop-things/contract';

// One instance per document. Never connect browser preview to native storage.
export default function createPreviewClient(
  confirmDiscard: () => Promise<boolean> = async () => false
): Client {
  const state: DatabaseState = {
    available: true,
    selectedPath: 'Preview: temporary customers.sqlite',
    session: crypto.randomUUID(),
    version: 1,
  };
  const customers: CustomerRecord[] = [];
  async function disabled() {
    return {
      status: 'error' as const,
      error: {
        code: 'DATABASE_UNAVAILABLE' as const,
        message: 'This action is not available yet.',
      },
    };
  }

  return {
    customers: {
      list: async () => ({status: 'success', value: customers}),
      get: disabled,
      create: disabled,
      update: disabled,
      delete: disabled,
    },
    database: {
      status: async () => ({status: 'success', value: state}),
      retry: async () => ({status: 'success', value: state}),
      create: disabled,
      open: disabled,
      backup: disabled,
      restore: disabled,
      onStateChanged: () => () => {},
    },
    exports: {csv: disabled},
    drafts: {
      confirmDiscard: async () =>
        (await confirmDiscard())
          ? {status: 'success', value: {approved: true}}
          : {status: 'cancelled'},
      registerProtection: () => () => {},
    },
  };
}
