import type {
  Client,
  CustomerRecord,
  DatabaseState,
  ContractError,
  CustomerReference,
} from '@shop-things/contract';
import {
  createCustomerInputSchema,
  updateCustomerInputSchema,
} from '@shop-things/contract/schemas';

// One instance per document. Never connect browser preview to native storage.
export default function createPreviewClient(
  confirmDiscard: () => Promise<boolean> = async () => false
): Client {
  const state: DatabaseState = {
    available: true,
    selectedPath: null,
    session: crypto.randomUUID(),
    version: 1,
  };
  const customers: CustomerRecord[] = [];
  let nextId = 1;

  function error(code: ContractError['code'], message: string) {
    return {status: 'error' as const, error: {code, message}};
  }

  function current(session: string) {
    return session === state.session;
  }

  function retained(reference: CustomerReference) {
    if (!current(reference.session)) {
      return error('STALE_SESSION', 'The preview database changed.');
    }

    const record = customers.find(value => value.customer.id === reference.id);
    if (!record) {
      return error('CUSTOMER_DELETED', 'This customer no longer exists.');
    }

    if (record.reference.revision !== reference.revision) {
      return error('STALE_REVISION', 'This customer changed. Reload before saving.');
    }

    return record;
  }

  function money(value: string) {
    const negative = value.startsWith('-');
    const [whole, fraction = ''] = value.replace('-', '').split('.');
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    if (cents > 100000000000000n) {
      throw new Error('Balance is outside the supported range.');
    }

    return (
      (negative && cents !== 0n ? '-' : '') +
      BigInt(whole).toString() +
      '.' +
      fraction.padEnd(2, '0')
    );
  }

  async function unsupported() {
    return error('INTERNAL', 'File operations are unavailable in browser preview.');
  }

  const client: Client = {
    customers: {
      list: async ({session, query}) => {
        if (!current(session)) {
          return error('STALE_SESSION', 'The preview database changed.');
        }

        const needle = query.trim().toLowerCase();
        const value = customers
          .filter(
            ({customer}) =>
              !needle ||
              customer.firstName.toLowerCase().includes(needle) ||
              customer.lastName.toLowerCase().includes(needle) ||
              String(customer.customerNumber) === needle
          )
          .toSorted(
            (first, second) =>
              first.customer.customerNumber - second.customer.customerNumber ||
              first.customer.id - second.customer.id
          );
        return {status: 'success', value: structuredClone(value)};
      },
      get: async ({session, id}) => {
        if (session !== state.session) {
          return {
            status: 'error',
            error: {code: 'STALE_SESSION', message: 'The preview database changed.'},
          };
        }

        const record = customers.find(customer => customer.customer.id === id);
        return record
          ? {status: 'success', value: structuredClone(record)}
          : {
              status: 'error',
              error: {
                code: 'CUSTOMER_DELETED',
                message: 'This customer no longer exists.',
              },
            };
      },
      create: async ({session, values}) => {
        if (!current(session)) {
          return error('STALE_SESSION', 'The preview database changed.');
        }

        const parsed = createCustomerInputSchema.safeParse(values);
        if (!parsed.success || (!values.firstName.trim() && !values.lastName.trim())) {
          return error('VALIDATION', 'Enter a first name, a last name, or both.');
        }

        try {
          let customerNumber = 1;
          const usedNumbers = new Set(
            customers.map(record => record.customer.customerNumber)
          );
          while (usedNumbers.has(customerNumber)) {
            customerNumber++;
          }

          const record: CustomerRecord = {
            customer: {
              ...parsed.data,
              id: nextId,
              customerNumber,
              balance: money(values.balance),
              previousBalance: money(values.previousBalance),
            },
            reference: {session, id: nextId, revision: crypto.randomUUID()},
          };
          customers.push(record);
          nextId++;
          return {status: 'success', value: structuredClone(record)};
        } catch (failure) {
          return error(
            'VALIDATION',
            failure instanceof Error ? failure.message : 'Check the entered values.'
          );
        }
      },
      update: async ({reference, changes}) => {
        const record = retained(reference);
        if ('status' in record) {
          return record;
        }

        const parsed = updateCustomerInputSchema.safeParse(changes);
        if (!parsed.success) {
          return error('VALIDATION', 'Check the entered values.');
        }

        const customer = {...record.customer, ...parsed.data};
        if (!customer.firstName.trim() && !customer.lastName.trim()) {
          return error('VALIDATION', 'Enter a first name, a last name, or both.');
        }

        if (
          customers.some(
            value =>
              value !== record &&
              value.customer.customerNumber === customer.customerNumber
          )
        ) {
          return error('VALIDATION', 'This customer number is already used.');
        }

        try {
          customer.balance = money(customer.balance);
          customer.previousBalance = money(customer.previousBalance);
        } catch {
          return error('VALIDATION', 'Balance is outside the supported range.');
        }

        record.customer = customer;
        record.reference = {...reference, revision: crypto.randomUUID()};
        return {status: 'success', value: structuredClone(record)};
      },
      delete: async ({reference}) => {
        const record = retained(reference);
        if ('status' in record) {
          return record;
        }

        customers.splice(customers.indexOf(record), 1);
        return {status: 'success', value: {deleted: true}};
      },
    },
    database: {
      status: async () => ({status: 'success', value: structuredClone(state)}),
      retry: unsupported,
      create: unsupported,
      open: unsupported,
      backup: unsupported,
      restore: unsupported,
      listMigrationSnapshots: async () => ({
        status: 'success',
        value: {snapshots: [], unavailableCount: 0},
      }),
      restoreMigrationSnapshot: unsupported,
      onStateChanged: () => () => {},
    },
    imports: {
      prepare: unsupported,
      review: unsupported,
      resolve: unsupported,
      commit: unsupported,
    },
    exports: {csv: unsupported},
    drafts: {
      confirmDiscard: async () =>
        (await confirmDiscard())
          ? {status: 'success', value: {approved: true}}
          : {status: 'cancelled'},
      registerProtection: () => () => {},
    },
  };
  return client;
}
