import type {z} from 'zod';

import type {ShopThingsBridge, Client, DatabaseState, DraftRequest} from './index.js';
import {
  actions,
  databaseStateSchema,
  draftRequestSchema,
  draftReplySchema,
  draftResolutionSchema,
} from './schemas.js';

const internalError = {
  status: 'error',
  error: {code: 'INTERNAL', message: 'The application could not complete the request.'},
} as const;

function validatedCall<A, R extends z.ZodType>(
  definition: {arguments: z.ZodType<A>; result: R},
  call: (args: A) => Promise<unknown>
) {
  return async (args: A): Promise<z.output<R>> => {
    const parsed = definition.arguments.safeParse(args);
    if (!parsed.success) {
      return definition.result.parse({
        status: 'error',
        error: {code: 'VALIDATION', message: 'Invalid request arguments.'},
      });
    }

    try {
      const result = definition.result.safeParse(await call(parsed.data));
      return result.success ? result.data : definition.result.parse(internalError);
    } catch {
      return definition.result.parse(internalError);
    }
  };
}

export function createClient(bridge: ShopThingsBridge): Client {
  return {
    customers: {
      list: validatedCall(actions['customers.list'], args => bridge.customers.list(args)),
      get: validatedCall(actions['customers.get'], args => bridge.customers.get(args)),
      create: validatedCall(actions['customers.create'], args =>
        bridge.customers.create(args)
      ),
      update: validatedCall(actions['customers.update'], args =>
        bridge.customers.update(args)
      ),
      delete: validatedCall(actions['customers.delete'], args =>
        bridge.customers.delete(args)
      ),
    },
    database: {
      status: () =>
        validatedCall(actions['database.status'], () => bridge.database.status())(
          undefined
        ),
      retry: () =>
        validatedCall(actions['database.retry'], () => bridge.database.retry())(
          undefined
        ),
      create: () =>
        validatedCall(actions['database.create'], () => bridge.database.create())(
          undefined
        ),
      open: () =>
        validatedCall(actions['database.open'], () => bridge.database.open())(undefined),
      backup: validatedCall(actions['database.backup'], args =>
        bridge.database.backup(args)
      ),
      restore: () =>
        validatedCall(actions['database.restore'], () => bridge.database.restore())(
          undefined
        ),
      onStateChanged(callback) {
        let subscribed = true;
        const unsubscribe = bridge.database.onStateChanged(payload => {
          const parsed = databaseStateSchema.safeParse(payload);
          if (subscribed && parsed.success) {
            callback(parsed.data);
          }
        });
        return () => {
          if (subscribed) {
            subscribed = false;
            unsubscribe();
          }
        };
      },
    },
    exports: {
      csv: validatedCall(actions['exports.csv'], args => bridge.exports.csv(args)),
    },
    drafts: {
      confirmDiscard: () =>
        validatedCall(actions['drafts.confirmDiscard'], () =>
          bridge.drafts.confirmDiscard()
        )(undefined),
      registerProtection(protection) {
        let subscribed = true;
        let pending: DraftRequest | null = null;
        const unsubscribe = bridge.drafts.registerProtection({
          async prepare(payload) {
            if (!subscribed) {
              throw new Error('Draft protection is unavailable.');
            }

            const request = draftRequestSchema.parse(payload);
            pending = request;
            const reply = draftReplySchema.parse(await protection.prepare(request));
            if (
              !subscribed ||
              pending !== request ||
              reply.requestId !== request.requestId ||
              reply.documentId !== request.documentId
            ) {
              throw new Error('Draft reply does not match request.');
            }

            return reply;
          },
          resolve(payload) {
            const parsed = draftResolutionSchema.safeParse(payload);
            if (
              subscribed &&
              parsed.success &&
              pending !== null &&
              parsed.data.requestId === pending.requestId &&
              parsed.data.documentId === pending.documentId
            ) {
              pending = null;
              protection.resolve(parsed.data);
            }
          },
        });
        return () => {
          if (subscribed) {
            subscribed = false;
            unsubscribe();
          }
        };
      },
    },
  };
}

export function getClient(): Client {
  const candidate = Reflect.get(globalThis, 'window');
  const bridge: unknown =
    typeof candidate === 'object' && candidate !== null
      ? Reflect.get(candidate, 'shopThings')
      : undefined;
  if (!isBridge(bridge)) {
    throw new Error('Shop Things preload bridge is unavailable.');
  }

  return createClient(bridge);
}

function isBridge(value: unknown): value is ShopThingsBridge {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const groups = {
    customers: ['list', 'get', 'create', 'update', 'delete'],
    database: [
      'status',
      'retry',
      'create',
      'open',
      'backup',
      'restore',
      'onStateChanged',
    ],
    exports: ['csv'],
    drafts: ['confirmDiscard', 'registerProtection'],
  };

  return Object.entries(groups).every(([name, methods]) => {
    const group: unknown = Reflect.get(value, name);
    return (
      typeof group === 'object' &&
      group !== null &&
      methods.every(method => typeof Reflect.get(group, method) === 'function')
    );
  });
}

export function applyNewerDatabaseState(
  current: DatabaseState | null,
  incoming: DatabaseState
): DatabaseState {
  return current === null || incoming.version > current.version ? incoming : current;
}
