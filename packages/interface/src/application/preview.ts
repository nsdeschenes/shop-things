/* oxlint-disable import/no-named-export -- Temporary preview controls stay outside the public contract. */
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

import {recordPreviewBackup, recordPreviewExport} from './previewFiles';

export type PreviewOutcome = 'success' | 'cancelled' | 'error';
const outcomes = new WeakMap<Client, (outcome: PreviewOutcome) => void>();
const recoveries = new WeakMap<Client, () => void>();
export function simulatePreviewRecovery(client: Client) {
  recoveries.get(client)?.();
}

export function setPreviewOutcome(client: Client, outcome: PreviewOutcome) {
  outcomes.get(client)?.(outcome);
}

const digits = /^\d+$/;
const uppercase = /[A-Z]/g;

// One instance per document. Never connect browser preview to native storage.
export default function createPreviewClient(
  confirmDiscard: () => Promise<boolean> = async () => false
): Client {
  let state: DatabaseState = {
    available: true,
    selectedPath: 'Preview: temporary customers.sqlite',
    session: crypto.randomUUID(),
    version: 1,
  };
  const customers: CustomerRecord[] = [];
  const listeners = new Set<(state: DatabaseState) => void>();
  let participant: Parameters<Client['drafts']['registerProtection']>[0] | null = null;
  let outcome: PreviewOutcome = 'success';
  async function transition(action: string) {
    const owner = participant;
    if (!owner) {
      return error(
        'INTERNAL',
        'The preview could not prepare this operation. Try again.'
      );
    }

    const request = {requestId: crypto.randomUUID(), documentId: crypto.randomUUID()};
    let committed = false;
    try {
      const reply = await owner.prepare(request);
      if (
        participant !== owner ||
        reply.requestId !== request.requestId ||
        reply.documentId !== request.documentId
      ) {
        return error('INTERNAL', 'The preview document changed. Try again.');
      }

      if (reply.hasUnsavedDraft && !(await confirmDiscard())) {
        return {status: 'cancelled' as const};
      }

      if (outcome === 'cancelled') {
        return {status: 'cancelled' as const};
      }

      if (outcome === 'error') {
        return error(
          'DATABASE_UNAVAILABLE',
          'Simulated file failure. Choose another name or location and try again.'
        );
      }

      customers.length = 0;
      nextId = 1;
      state = {
        available: true,
        selectedPath: `Preview: ${action} customers.sqlite`,
        session: crypto.randomUUID(),
        version: state.version + 1,
      };
      for (const listener of listeners) {
        listener(structuredClone(state));
      }

      committed = true;
      return {status: 'success' as const, value: structuredClone(state)};
    } catch {
      return error(
        'INTERNAL',
        'The preview could not prepare this operation. Try again.'
      );
    } finally {
      owner.resolve({...request, outcome: committed ? 'committed' : 'aborted'});
    }
  }

  function compareText(first: string, second: string) {
    const a = first.replace(uppercase, value => value.toLowerCase());
    const b = second.replace(uppercase, value => value.toLowerCase());
    return a < b ? -1 : a > b ? 1 : 0;
  }

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

  async function disabled() {
    return {
      status: 'error' as const,
      error: {
        code: 'DATABASE_UNAVAILABLE' as const,
        message: 'This action is not available yet.',
      },
    };
  }

  async function savedFile(session: string, action: 'backup' | 'csv') {
    if (!state.available || !current(session)) {
      return error('STALE_SESSION', 'The preview database changed.');
    }

    if (outcome === 'cancelled') {
      return {status: 'cancelled' as const};
    }

    if (outcome === 'error') {
      return error(
        'INTERNAL',
        'Simulated file failure. Choose another name or location and try again.'
      );
    }

    if (action === 'backup') {
      recordPreviewBackup(client, {customers, nextId});
    } else {
      recordPreviewExport(client, customers);
    }

    return {
      status: 'success' as const,
      value: {
        path: `Preview: ${action === 'backup' ? 'customers-backup.sqlite' : 'all-saved-customers.csv'}`,
      },
    };
  }

  const client: Client = {
    customers: {
      list: async ({session, query}) => {
        if (!current(session)) {
          return error('STALE_SESSION', 'The preview database changed.');
        }

        const needle = query.trim().toLocaleLowerCase();
        const number =
          digits.test(needle) && Number.isSafeInteger(Number(needle))
            ? Number(needle)
            : -1;
        const value = customers
          .filter(
            ({customer}) =>
              !needle ||
              customer.firstName.toLocaleLowerCase().includes(needle) ||
              customer.lastName.toLocaleLowerCase().includes(needle) ||
              customer.customerNumber === number
          )
          .toSorted(
            (first, second) =>
              compareText(first.customer.lastName, second.customer.lastName) ||
              compareText(first.customer.firstName, second.customer.firstName) ||
              (first.customer.customerNumber ?? -1) -
                (second.customer.customerNumber ?? -1) ||
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
      retry: () => transition('retry'),
      create: () => transition('create'),
      open: () => transition('open'),
      backup: ({session}) => savedFile(session, 'backup'),
      restore: disabled,
      onStateChanged: listener => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    exports: {csv: ({session}) => savedFile(session, 'csv')},
    drafts: {
      confirmDiscard: async () =>
        (await confirmDiscard())
          ? {status: 'success', value: {approved: true}}
          : {status: 'cancelled'},
      registerProtection: owner => {
        participant = owner;
        return () => {
          if (participant === owner) {
            participant = null;
          }
        };
      },
    },
  };
  recoveries.set(client, () => {
    state = {
      available: false,
      selectedPath: 'Preview: remembered customers.sqlite',
      session: null,
      version: state.version + 1,
      recoveryError: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'Simulated remembered-file failure. Retry or choose Create/Open.',
      },
    };
    for (const listener of listeners) {
      listener(structuredClone(state));
    }
  });
  outcomes.set(client, value => {
    outcome = value;
  });
  return client;
}
