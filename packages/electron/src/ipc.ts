import type {ActionHandlers, ActionName, DraftRequest} from '@shop-things/contract';
import {
  actions,
  databaseStateSchema,
  draftRequestSchema,
  draftResolutionSchema,
} from '@shop-things/contract/schemas';

import type {ActionService} from './actionService.js';
import type {DraftCoordinator, DraftParticipant} from './draftCoordinator.js';
import type {Validator} from './ipcWire.js';
import {controls, isRecord, isToken} from './ipcWire.js';

export interface IpcSender {
  sender: unknown;
  senderFrame: unknown;
}

export interface MainIpc {
  handle(
    channel: string,
    callback: (event: IpcSender, ...payloads: unknown[]) => unknown
  ): void;
  removeHandler(channel: string): void;
  on(
    channel: string,
    callback: (event: IpcSender, ...payloads: unknown[]) => void
  ): unknown;
  removeListener(
    channel: string,
    callback: (event: IpcSender, ...payloads: unknown[]) => void
  ): unknown;
}

export interface ApprovedDocument {
  documentId: string;
  url: string;
  frame: {url: string};
  webContents: {
    mainFrame: unknown;
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

export interface IpcOptions {
  ipc: MainIpc;
  service: Pick<ActionService, 'handlers' | 'onStateChanged'>;
  drafts: DraftCoordinator;
  currentDocument(): ApprovedDocument | null;
  onDocumentChanged(callback: () => void): () => void;
  logError?: (error: unknown) => void;
  ready?: () => Promise<void>;
}

const denied = {
  status: 'error',
  error: {code: 'UNAUTHORIZED', message: 'This document is not authorized.'},
} as const;

const invalid = {
  status: 'error',
  error: {code: 'VALIDATION', message: 'Invalid request arguments.'},
} as const;

const failed = {
  status: 'error',
  error: {code: 'INTERNAL', message: 'The application could not complete the request.'},
} as const;

export function registerIpc(options: IpcOptions): () => void {
  const {ipc, service, drafts} = options;
  const handlerChannels: string[] = [];
  const listeners = new Map<string, (event: IpcSender, ...payloads: unknown[]) => void>();
  const subscriptions = new Map<string, ApprovedDocument>();
  let registration: {
    id: string;
    document: ApprovedDocument;
    participant: DraftParticipant;
    request: DraftRequest | null;
    stop(): void;
  } | null = null;

  function authorized(event: IpcSender): ApprovedDocument | null {
    const document = options.currentDocument();
    return document &&
      !document.webContents.isDestroyed() &&
      event.sender === document.webContents &&
      event.senderFrame === document.frame &&
      document.webContents.mainFrame === document.frame &&
      document.frame.url === document.url
      ? document
      : null;
  }

  function current(document: ApprovedDocument): boolean {
    const value = options.currentDocument();
    return (
      value !== null &&
      value.documentId === document.documentId &&
      value.webContents === document.webContents &&
      value.frame === document.frame &&
      value.webContents.mainFrame === value.frame &&
      value.frame.url === document.url &&
      !value.webContents.isDestroyed()
    );
  }

  function handle(
    channel: string,
    callback: (event: IpcSender, ...payloads: unknown[]) => unknown
  ) {
    ipc.handle(channel, callback);
    handlerChannels.push(channel);
  }

  function listen(
    channel: string,
    callback: (event: IpcSender, ...payloads: unknown[]) => void
  ) {
    ipc.on(channel, callback);
    listeners.set(channel, callback);
  }

  function registerAction<A, R>(
    name: string,
    definition: {arguments: Validator<A>; result: Validator<R>},
    handler: (args: A) => Promise<unknown>
  ) {
    handle(`shop-things:${name}`, async (event, ...payloads) => {
      const document = authorized(event);
      const payload = payloads[0];
      if (
        !document ||
        !isRecord(payload, ['documentId', 'arguments']) ||
        payload.documentId !== document.documentId
      ) {
        return denied;
      }

      if (payloads.length !== 1) {
        return invalid;
      }

      const args = definition.arguments.safeParse(payload.arguments);
      if (!args.success) {
        return invalid;
      }

      try {
        await options.ready?.();
        if (!current(document)) {
          return denied;
        }

        const result = definition.result.safeParse(await handler(args.data));
        if (!result.success) {
          options.logError?.(result.error);
          return failed;
        }

        return result.data;
      } catch (error) {
        options.logError?.(error);
        return failed;
      }
    });
  }

  // Explicit wrappers preserve each schema's argument/result pairing without transport assertions.
  const handlers: ActionHandlers = service.handlers;
  const registrations: {[K in ActionName]: () => void} = {
    'imports.commit': () =>
      registerAction('imports.commit', actions['imports.commit'], args =>
        handlers['imports.commit'](args)
      ),
    'imports.prepare': () =>
      registerAction('imports.prepare', actions['imports.prepare'], args =>
        handlers['imports.prepare'](args)
      ),
    'imports.resolve': () =>
      registerAction('imports.resolve', actions['imports.resolve'], args =>
        handlers['imports.resolve'](args)
      ),
    'imports.review': () =>
      registerAction('imports.review', actions['imports.review'], args =>
        handlers['imports.review'](args)
      ),
    'customers.list': () =>
      registerAction('customers.list', actions['customers.list'], args =>
        handlers['customers.list'](args)
      ),
    'customers.get': () =>
      registerAction('customers.get', actions['customers.get'], args =>
        handlers['customers.get'](args)
      ),
    'customers.create': () =>
      registerAction('customers.create', actions['customers.create'], args =>
        handlers['customers.create'](args)
      ),
    'customers.update': () =>
      registerAction('customers.update', actions['customers.update'], args =>
        handlers['customers.update'](args)
      ),
    'customers.delete': () =>
      registerAction('customers.delete', actions['customers.delete'], args =>
        handlers['customers.delete'](args)
      ),
    'database.status': () =>
      registerAction('database.status', actions['database.status'], () =>
        handlers['database.status']()
      ),
    'database.retry': () =>
      registerAction('database.retry', actions['database.retry'], () =>
        handlers['database.retry']()
      ),
    'database.create': () =>
      registerAction('database.create', actions['database.create'], () =>
        handlers['database.create']()
      ),
    'database.open': () =>
      registerAction('database.open', actions['database.open'], () =>
        handlers['database.open']()
      ),
    'database.backup': () =>
      registerAction('database.backup', actions['database.backup'], args =>
        handlers['database.backup'](args)
      ),
    'database.restore': () =>
      registerAction('database.restore', actions['database.restore'], () =>
        handlers['database.restore']()
      ),
    'exports.csv': () =>
      registerAction('exports.csv', actions['exports.csv'], args =>
        handlers['exports.csv'](args)
      ),
    'drafts.confirmDiscard': () =>
      registerAction('drafts.confirmDiscard', actions['drafts.confirmDiscard'], () =>
        handlers['drafts.confirmDiscard']()
      ),
  };
  for (const register of Object.values(registrations)) {
    register();
  }

  handle(controls.handshake, (event, ...payloads) =>
    payloads.length === 0 ? (authorized(event)?.documentId ?? null) : null
  );

  function control(event: IpcSender, payloads: unknown[], keys: string[]) {
    const document = authorized(event);
    const payload = payloads[0];
    if (
      !document ||
      payloads.length !== 1 ||
      !isRecord(payload, keys) ||
      payload.documentId !== document.documentId
    ) {
      return null;
    }

    return {document, payload};
  }

  function subscribe(event: IpcSender, ...payloads: unknown[]) {
    const input = control(event, payloads, ['documentId', 'subscriptionId']);
    if (input && isToken(input.payload.subscriptionId)) {
      subscriptions.set(input.payload.subscriptionId, input.document);
      return true;
    }

    return false;
  }

  listen(controls.stateSubscribe, subscribe);
  handle(controls.stateSubscribe, subscribe);

  listen(controls.stateUnsubscribe, (event, ...payloads) => {
    const input = control(event, payloads, ['documentId', 'subscriptionId']);
    if (
      input &&
      isToken(input.payload.subscriptionId) &&
      subscriptions.get(input.payload.subscriptionId)?.documentId ===
        input.document.documentId
    ) {
      subscriptions.delete(input.payload.subscriptionId);
    }
  });

  const stopDocument = options.onDocumentChanged(() => {
    registration?.stop();
    registration = null;
    subscriptions.clear();
  });

  const stopState = service.onStateChanged(payload => {
    const state = databaseStateSchema.safeParse(payload);
    if (!state.success) {
      options.logError?.(state.error);
      return;
    }

    for (const [subscriptionId, document] of subscriptions) {
      if (!current(document)) {
        subscriptions.delete(subscriptionId);
        continue;
      }

      try {
        document.webContents.send(controls.stateChanged, {
          subscriptionId,
          state: state.data,
        });
      } catch (error) {
        subscriptions.delete(subscriptionId);
        options.logError?.(error);
      }
    }
  });

  function registerProtection(event: IpcSender, ...payloads: unknown[]) {
    const input = control(event, payloads, ['documentId', 'registrationId']);
    if (!input || !isToken(input.payload.registrationId)) {
      return false;
    }

    registration?.stop();
    const id = input.payload.registrationId;
    const document = input.document;
    const participant: DraftParticipant = {
      documentId: document.documentId,
      prepare(payload) {
        if (!current(document)) {
          throw new Error('The authorized document changed.');
        }

        if (registration?.participant === participant) {
          registration.request = payload;
        }

        document.webContents.send(controls.draftPrepare, {
          registrationId: id,
          request: draftRequestSchema.parse(payload),
        });
      },
      resolve(payload) {
        if (registration?.participant === participant) {
          registration.request = null;
        }

        if (current(document)) {
          document.webContents.send(controls.draftResolve, {
            registrationId: id,
            resolution: draftResolutionSchema.parse(payload),
          });
        }
      },
    };
    registration = {
      id,
      document,
      participant,
      request: null,
      stop: drafts.register(participant),
    };
    return true;
  }

  listen(controls.draftRegister, registerProtection);
  handle(controls.draftRegister, registerProtection);

  listen(controls.draftUnregister, (event, ...payloads) => {
    const input = control(event, payloads, ['documentId', 'registrationId']);
    if (
      input &&
      registration &&
      registration.id === input.payload.registrationId &&
      registration.document.documentId === input.document.documentId
    ) {
      registration.stop();
      registration = null;
    }
  });

  listen(controls.draftReply, (event, ...payloads) => {
    const input = control(event, payloads, ['documentId', 'registrationId', 'reply']);
    if (
      input &&
      registration &&
      registration.id === input.payload.registrationId &&
      registration.document.documentId === input.document.documentId
    ) {
      drafts.reply(registration.participant, input.payload.reply);
    }
  });

  listen(controls.draftFailure, (event, ...payloads) => {
    const input = control(event, payloads, ['documentId', 'registrationId', 'requestId']);
    if (
      input &&
      registration &&
      registration.id === input.payload.registrationId &&
      registration.document.documentId === input.document.documentId &&
      registration.request?.requestId === input.payload.requestId
    ) {
      drafts.reply(registration.participant, {});
    }
  });

  return () => {
    registration?.stop();
    registration = null;
    stopState();
    stopDocument();
    subscriptions.clear();
    for (const channel of handlerChannels) {
      ipc.removeHandler(channel);
    }

    for (const [channel, listener] of listeners) {
      ipc.removeListener(channel, listener);
    }
  };
}
