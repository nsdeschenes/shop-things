import type {ShopThingsBridge, DraftRequest} from '@shop-things/contract';
import {
  actions,
  appReadyAction,
  updateActions,
  updateStateSchema,
  databaseStateSchema,
  draftRequestSchema,
  draftReplySchema,
  draftResolutionSchema,
} from '@shop-things/contract/schemas';

import {controls, isRecord, isToken} from './ipcWire.js';
import type {Validator} from './ipcWire.js';

export interface RendererIpc {
  invoke(channel: string, ...payloads: unknown[]): Promise<unknown>;
  send(channel: string, payload: unknown): void;
  on(channel: string, callback: (event: unknown, payload: unknown) => void): unknown;
  removeListener(
    channel: string,
    callback: (event: unknown, payload: unknown) => void
  ): unknown;
}

const failed = {
  status: 'error',
  error: {code: 'INTERNAL', message: 'The application could not complete the request.'},
} as const;

export function createPreloadBridge(
  ipc: RendererIpc,
  nextId: () => string = () => crypto.randomUUID()
): ShopThingsBridge {
  let document: Promise<string> | null = null;

  const registrations = new Set<Promise<void>>();

  function getDocument(): Promise<string> {
    document ??= (async () => {
      // Renderer scripts can execute before dom-ready grants authorization.
      // Retry only the same main-owned handshake; never change its trust policy.
      for (let attempt = 0; attempt < 20; attempt++) {
        const value = await ipc.invoke(controls.handshake);
        if (isToken(value)) {
          return value;
        }

        await new Promise(resolve => setTimeout(resolve, 50));
      }

      throw new Error('The renderer document is unavailable.');
    })().catch(error => {
      document = null;
      throw error;
    });
    return document;
  }

  function register(
    channel: string,
    payload: Record<string, string>,
    active: () => boolean
  ) {
    const ready = getDocument().then(async documentId => {
      if (active() && (await ipc.invoke(channel, {documentId, ...payload})) !== true) {
        throw new Error('The renderer registration is unavailable.');
      }
    });
    registrations.add(ready);
    // Retain failures until the owner disposes this registration and retries.
    void ready.catch(() => {});
    return () => registrations.delete(ready);
  }

  function call<A, R>(
    name: string,
    definition: {arguments: Validator<A>; result: Validator<R>}
  ) {
    return async (args: A): Promise<R> => {
      try {
        await Promise.all(registrations);
        const result = definition.result.safeParse(
          await ipc.invoke(`shop-things:${name}`, {
            documentId: await getDocument(),
            arguments: args,
          })
        );
        if (result.success) {
          return result.data;
        }
      } catch {
        /* Transport failures never expose native details. */
      }

      const result = definition.result.safeParse(failed);
      if (!result.success) {
        throw new Error('Invalid contract failure schema.');
      }

      return result.data;
    };
  }

  return {
    app: {ready: call('app.ready', appReadyAction)},
    update: {
      check: call('update.check', updateActions['update.check']),
      getState: call('update.getState', updateActions['update.getState']),
      start: call('update.start', updateActions['update.start']),
      retry: call('update.retry', updateActions['update.retry']),
      onStateChanged(callback) {
        const subscriptionId = nextId();
        let active = true;
        function listener(_event: unknown, payload: unknown) {
          if (
            !active ||
            !isRecord(payload, ['subscriptionId', 'state']) ||
            payload.subscriptionId !== subscriptionId
          ) {
            return;
          }

          const state = updateStateSchema.safeParse(payload.state);
          if (state.success) {
            callback(state.data);
          }
        }

        ipc.on(controls.updateChanged, listener);
        const stopRegistration = register(
          controls.updateSubscribe,
          {subscriptionId},
          () => active
        );
        return () => {
          if (!active) {
            return;
          }

          active = false;
          stopRegistration();
          ipc.removeListener(controls.updateChanged, listener);
          void getDocument()
            .then(documentId =>
              ipc.send(controls.updateUnsubscribe, {documentId, subscriptionId})
            )
            .catch(() => {});
        };
      },
    },
    customers: {
      list: call('customers.list', actions['customers.list']),
      get: call('customers.get', actions['customers.get']),
      create: call('customers.create', actions['customers.create']),
      update: call('customers.update', actions['customers.update']),
      delete: call('customers.delete', actions['customers.delete']),
    },
    database: {
      status: () => call('database.status', actions['database.status'])(undefined),
      retry: () => call('database.retry', actions['database.retry'])(undefined),
      create: () => call('database.create', actions['database.create'])(undefined),
      open: () => call('database.open', actions['database.open'])(undefined),
      backup: call('database.backup', actions['database.backup']),
      restore: () => call('database.restore', actions['database.restore'])(undefined),
      onStateChanged(callback) {
        const subscriptionId = nextId();
        let active = true;
        function listener(_event: unknown, payload: unknown) {
          if (
            !active ||
            !isRecord(payload, ['subscriptionId', 'state']) ||
            payload.subscriptionId !== subscriptionId
          ) {
            return;
          }

          const state = databaseStateSchema.safeParse(payload.state);
          if (state.success) {
            callback(state.data);
          }
        }

        ipc.on(controls.stateChanged, listener);
        const stopRegistration = register(
          controls.stateSubscribe,
          {subscriptionId},
          () => active
        );
        return () => {
          if (!active) {
            return;
          }

          active = false;
          stopRegistration();
          ipc.removeListener(controls.stateChanged, listener);
          void getDocument()
            .then(documentId =>
              ipc.send(controls.stateUnsubscribe, {documentId, subscriptionId})
            )
            .catch(() => {});
        };
      },
    },
    imports: {
      commit: call('imports.commit', actions['imports.commit']),
      prepare: call('imports.prepare', actions['imports.prepare']),
      review: call('imports.review', actions['imports.review']),
      resolve: call('imports.resolve', actions['imports.resolve']),
    },
    exports: {csv: call('exports.csv', actions['exports.csv'])},
    drafts: {
      confirmDiscard: () =>
        call('drafts.confirmDiscard', actions['drafts.confirmDiscard'])(undefined),
      registerProtection(protection) {
        const registrationId = nextId();
        let active = true;
        let pending: DraftRequest | null = null;
        function prepare(_event: unknown, payload: unknown) {
          if (
            !active ||
            !isRecord(payload, ['registrationId', 'request']) ||
            payload.registrationId !== registrationId
          ) {
            return;
          }

          const request = draftRequestSchema.safeParse(payload.request);
          if (!request.success) {
            return;
          }

          void (async () => {
            const documentId = await getDocument();
            if (!active || request.data.documentId !== documentId) {
              return;
            }

            const prepared = request.data;
            pending = prepared;
            try {
              const reply = draftReplySchema.parse(
                await protection.prepare(request.data)
              );
              if (
                reply.requestId !== request.data.requestId ||
                reply.documentId !== documentId
              ) {
                throw new Error('Mismatched draft reply.');
              }

              if (active && pending === prepared) {
                ipc.send(controls.draftReply, {documentId, registrationId, reply});
              }
            } catch {
              if (active && pending === prepared) {
                ipc.send(controls.draftFailure, {
                  documentId,
                  registrationId,
                  requestId: request.data.requestId,
                });
              }
            }
          })().catch(() => {});
        }

        function resolve(_event: unknown, payload: unknown) {
          if (
            !active ||
            !isRecord(payload, ['registrationId', 'resolution']) ||
            payload.registrationId !== registrationId
          ) {
            return;
          }

          const resolution = draftResolutionSchema.safeParse(payload.resolution);
          if (
            resolution.success &&
            pending !== null &&
            resolution.data.requestId === pending.requestId &&
            resolution.data.documentId === pending.documentId
          ) {
            pending = null;
            protection.resolve(resolution.data);
          }
        }

        ipc.on(controls.draftPrepare, prepare);
        ipc.on(controls.draftResolve, resolve);
        const stopRegistration = register(
          controls.draftRegister,
          {registrationId},
          () => active
        );
        return () => {
          if (!active) {
            return;
          }

          active = false;
          stopRegistration();
          ipc.removeListener(controls.draftPrepare, prepare);
          ipc.removeListener(controls.draftResolve, resolve);
          void getDocument()
            .then(documentId =>
              ipc.send(controls.draftUnregister, {documentId, registrationId})
            )
            .catch(() => {});
        };
      },
    },
  };
}
