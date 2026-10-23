import type {ActionHandlers, DatabaseState} from '@shop-things/contract';
import {
  createDatabase,
  openExistingDatabase,
  listCustomers,
  getCustomer,
  createCustomer,
  importCustomerBatch,
  updateCustomer,
  deleteCustomer,
  backupDatabase,
} from '@shop-things/db';
import type {DatabaseFailure} from '@shop-things/db/effect';
import {Effect} from 'effect';

import {Backend} from './backend.js';
import type {DraftCoordinator} from './draftCoordinator.js';
import {native, runBoundary} from './effectBoundary.js';
import type {DatabaseSettings} from './settings.js';

export interface BackendDialogs {
  createDatabase(): Promise<string | null>;
  openDatabase(): Promise<string | null>;
  importCsv(): Promise<string | null>;
  exportCsv(): Promise<string | null>;
  backupDatabase(databasePath: string): Promise<string | null>;
  restoreSource(): Promise<string | null>;
  restoreDestination(): Promise<string | null>;
  confirmDiscard(): Promise<boolean>;
}

export const databaseOperations = {
  createDatabase,
  openExistingDatabase,
  listCustomers,
  getCustomer,
  createCustomer,
  importCustomerBatch,
  updateCustomer,
  deleteCustomer,
  backupDatabase,
};

export type DatabaseOperations = typeof databaseOperations;

export type EffectDatabaseOperations = {
  [K in keyof DatabaseOperations]: (
    ...args: Parameters<DatabaseOperations[K]>
  ) => Effect.Effect<Awaited<ReturnType<DatabaseOperations[K]>>, DatabaseFailure>;
};

export interface ActionServiceOptions {
  migrationsFolder: string;
  settings: DatabaseSettings;
  dialogs: BackendDialogs;
  database?: DatabaseOperations;
  effectDatabase?: EffectDatabaseOperations;
  logError?: (error: unknown) => void;
  drafts?: DraftCoordinator;
  phase?: <T>(name: string, work: () => T) => T;
  effectPhase?: <A, E, R>(
    name: string,
    work: () => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
}

type CloseOutcome = Effect.Success<ReturnType<Backend['requestClose']>>;

export class ActionService {
  readonly handlers: Omit<ActionHandlers, 'telemetry.status' | 'telemetry.save'>;
  readonly effectHandlers: Backend['handlers'];
  private readonly backend: Backend;
  private pendingClose: Promise<CloseOutcome> | null = null;
  private pendingUnprotectedClose: Promise<void> | null = null;

  constructor(options: ActionServiceOptions) {
    this.backend = new Backend(options);
    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    const effects: Record<
      string,
      (...args: unknown[]) => Effect.Effect<unknown, unknown>
    > = {};
    for (const [name, handler] of Object.entries(this.backend.handlers)) {
      const original = (...args: unknown[]) =>
        runBoundary(Reflect.apply(handler, this.backend.handlers, args));
      handlers[name] = original;
      effects[name] = (...args: unknown[]) =>
        Effect.suspend(() =>
          handlers[name] === original
            ? Reflect.apply(handler, this.backend.handlers, args)
            : native(() => handlers[name]!(...args))
        );
    }

    this.handlers = handlers as typeof this.handlers;
    this.effectHandlers = effects as typeof this.effectHandlers;
  }

  status(): DatabaseState {
    return this.backend.status();
  }
  onStateChanged(callback: (state: DatabaseState) => void): () => void {
    return this.backend.onStateChanged(callback);
  }
  start(): Promise<void> {
    return runBoundary(this.backend.start());
  }
  closeUnprotected(): void {
    this.backend.closeUnprotected();
  }
  closeUnprotectedWhenIdle(): Promise<void> {
    if (this.pendingUnprotectedClose) {
      return this.pendingUnprotectedClose;
    }

    this.pendingUnprotectedClose = runBoundary(
      this.backend.closeUnprotectedWhenIdle()
    ).finally(() => {
      this.pendingUnprotectedClose = null;
    });
    return this.pendingUnprotectedClose;
  }
  requestClose(): Promise<CloseOutcome> {
    if (this.pendingClose) {
      return this.pendingClose;
    }

    if (this.backend.lifecyclePending) {
      return runBoundary(this.backend.requestClose());
    }

    this.pendingClose = runBoundary(this.backend.requestClose()).finally(() => {
      this.pendingClose = null;
    });
    return this.pendingClose;
  }
  requestReload(scheduleReload: () => void | Promise<void>) {
    return runBoundary(this.backend.requestReload(scheduleReload));
  }
}
