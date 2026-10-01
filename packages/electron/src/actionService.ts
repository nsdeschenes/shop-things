/* oxlint-disable import/no-named-export -- Backend APIs are consumed by IPC and packaged runners. */
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';

import type {
  ActionHandlers,
  ActionResults,
  ContractError,
  CustomerRecord,
  DatabaseState,
  ErrorCode,
  UpdateCustomerInput,
} from '@shop-things/contract';
import {
  createDatabase,
  openExistingDatabase,
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  DatabaseError,
  backupDatabase,
} from '@shop-things/db';
import type {CustomerChanges, CustomerData, DatabaseHandle} from '@shop-things/db';

import type {DraftCoordinator, DraftLease} from './draftCoordinator.js';
import {
  copyBackup,
  removeDatabaseFile,
  temporaryPath,
  writeCustomerCsv,
} from './files.js';
import type {DatabaseSettings} from './settings.js';

export interface BackendDialogs {
  createDatabase(): Promise<string | null>;
  openDatabase(): Promise<string | null>;
  exportCsv(): Promise<string | null>;
  backupDatabase(): Promise<string | null>;
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
  updateCustomer,
  deleteCustomer,
  backupDatabase,
};

export type DatabaseOperations = typeof databaseOperations;

type Outcome<T> =
  | {status: 'success'; value: T}
  | Exclude<ActionResults['database.status'], {status: 'success'}>;

class ActionError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
  }
}

function definedChanges(changes: UpdateCustomerInput): CustomerChanges {
  return {
    ...(changes.firstName !== undefined ? {firstName: changes.firstName} : {}),
    ...(changes.lastName !== undefined ? {lastName: changes.lastName} : {}),
    ...(changes.address !== undefined ? {address: changes.address} : {}),
    ...(changes.city !== undefined ? {city: changes.city} : {}),
    ...(changes.province !== undefined ? {province: changes.province} : {}),
    ...(changes.postalCode !== undefined ? {postalCode: changes.postalCode} : {}),
    ...(changes.phone !== undefined ? {phone: changes.phone} : {}),
    ...(changes.email !== undefined ? {email: changes.email} : {}),
    ...(changes.stock !== undefined ? {stock: changes.stock} : {}),
    ...(changes.balance !== undefined ? {balance: changes.balance} : {}),
    ...(changes.previousBalance !== undefined
      ? {previousBalance: changes.previousBalance}
      : {}),
    ...(changes.donate !== undefined ? {donate: changes.donate} : {}),
    ...(changes.comments !== undefined ? {comments: changes.comments} : {}),
    ...(changes.customerNumber !== undefined
      ? {customerNumber: changes.customerNumber}
      : {}),
  };
}

export interface ActionServiceOptions {
  migrationsFolder: string;
  settings: DatabaseSettings;
  dialogs: BackendDialogs;
  database?: DatabaseOperations;
  logError?: (error: unknown) => void;
  drafts?: DraftCoordinator;
}

export class ActionService {
  readonly handlers: ActionHandlers;
  private readonly database: DatabaseOperations;
  private active: DatabaseHandle | null = null;
  private state: DatabaseState = {
    available: false,
    selectedPath: null,
    session: null,
    version: 0,
  };
  private readonly listeners = new Set<(state: DatabaseState) => void>();
  private busy = false;
  private activeOperation: Promise<void> | null = null;
  private closePending = false;
  private pendingUnprotectedClose: Promise<void> | null = null;
  private pendingClose: Promise<Outcome<{closed: true}>> | null = null;

  constructor(private readonly options: ActionServiceOptions) {
    this.database = options.database ?? databaseOperations;
    this.handlers = {
      'database.status': async () => ({status: 'success', value: this.status()}),
      'database.retry': () =>
        this.admit(() => this.transition(lease => this.retry(lease))),
      'database.create': () =>
        this.admit(() => this.transition(lease => this.select('create', lease))),
      'database.open': () =>
        this.admit(() => this.transition(lease => this.select('open', lease))),
      'customers.list': args =>
        this.admit(async () => {
          const handle = this.requireSession(args.session);
          return (await this.database.listCustomers(handle.db, args.query)).map(row =>
            this.record(row)
          );
        }),
      'customers.get': args =>
        this.admit(async () => {
          const row = await this.database.getCustomer(
            this.requireSession(args.session).db,
            args.id
          );
          if (!row) {
            throw new ActionError(
              'CUSTOMER_DELETED',
              'This customer no longer exists. Reload the list.'
            );
          }

          return this.record(row);
        }),
      'customers.create': args =>
        this.admit(async () =>
          this.record(
            await this.database.createCustomer(
              this.requireSession(args.session).db,
              args.values
            )
          )
        ),
      'customers.update': args =>
        this.admit(async () =>
          this.record(
            await this.database.updateCustomer(
              this.requireSession(args.reference.session).db,
              args.reference,
              definedChanges(args.changes)
            )
          )
        ),
      'customers.delete': args =>
        this.admit(async () => {
          await this.database.deleteCustomer(
            this.requireSession(args.reference.session).db,
            args.reference
          );
          return {deleted: true as const};
        }),
      'database.backup': args => this.admit(() => this.backup(args.session)),
      'database.restore': () =>
        this.admit(() => this.transition(lease => this.restore(lease))),
      'exports.csv': args => this.admit(() => this.exportCsv(args.session)),
      'drafts.confirmDiscard': async () => {
        try {
          return (await this.options.dialogs.confirmDiscard())
            ? {status: 'success', value: {approved: true}}
            : {status: 'cancelled'};
        } catch (error) {
          return {status: 'error', error: this.safeError(error)};
        }
      },
    };
  }

  status(): DatabaseState {
    return structuredClone(this.state);
  }

  onStateChanged(callback: (state: DatabaseState) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  async start(): Promise<void> {
    // Cold startup runs before any renderer/document exists. Public recovery calls
    // always use the protected transition path once the application is running.
    await this.admit(() => this.retry());
  }

  closeUnprotected(): void {
    if (this.busy) {
      throw new Error('Wait for the current database operation');
    }

    this.active?.close();
    this.active = null;
    this.publish({
      available: false,
      selectedPath: this.state.selectedPath,
      session: null,
    });
  }

  // Placeholder application shutdown: wait for work without activating renderer draft hooks.
  closeUnprotectedWhenIdle(): Promise<void> {
    if (this.pendingUnprotectedClose) {
      return this.pendingUnprotectedClose;
    }

    this.closePending = true;
    this.pendingUnprotectedClose = (async () => {
      await this.activeOperation;
      this.closeUnprotected();
    })().finally(() => {
      this.closePending = false;
      this.pendingUnprotectedClose = null;
    });
    return this.pendingUnprotectedClose;
  }

  async requestReload(
    scheduleReload: () => void | Promise<void>
  ): Promise<Outcome<{reloaded: true}>> {
    if (this.closePending) {
      return {
        status: 'error',
        error: {
          code: 'BUSY',
          message:
            'A protected lifecycle operation is already running. Try again when it finishes.',
        },
      };
    }

    this.closePending = true;
    try {
      await this.activeOperation;
      const reloaded = await this.transition(async lease => {
        lease?.assertCurrent();
        // Schedule replacement after the correlated committed resolution is delivered.
        const scheduled = scheduleReload();
        lease?.finish('committed');
        // Keep lifecycle admission closed until the scheduled replacement begins.
        await scheduled;
        return {reloaded: true as const};
      }, true);
      return reloaded === null
        ? {status: 'cancelled'}
        : {status: 'success', value: reloaded};
    } catch (error) {
      return {status: 'error', error: this.safeError(error)};
    } finally {
      this.closePending = false;
    }
  }

  requestClose(): Promise<Outcome<{closed: true}>> {
    if (this.pendingClose) {
      return this.pendingClose;
    }

    if (this.closePending) {
      return Promise.resolve({
        status: 'error',
        error: {
          code: 'BUSY',
          message:
            'A protected lifecycle operation is already running. Try again when it finishes.',
        },
      });
    }

    this.closePending = true;
    this.pendingClose = this.closeProtected().finally(() => {
      this.closePending = false;
      this.pendingClose = null;
    });
    return this.pendingClose;
  }

  private async closeProtected(): Promise<Outcome<{closed: true}>> {
    try {
      await this.activeOperation;
      const closed = await this.transition(async lease => {
        lease?.assertCurrent();
        this.closeUnprotected();
        return {closed: true as const};
      }, true);
      return closed === null ? {status: 'cancelled'} : {status: 'success', value: closed};
    } catch (error) {
      return {status: 'error', error: this.safeError(error)};
    }
  }

  private async transition<T>(
    work: (lease?: DraftLease) => Promise<T | null>,
    closing = false
  ): Promise<T | null> {
    if (!this.active && !closing && !this.options.drafts) {
      return work();
    }

    if (!this.options.drafts) {
      throw new ActionError(
        'DATABASE_UNAVAILABLE',
        'Protected draft coordination is unavailable. Keep the application open.'
      );
    }

    const lease = await this.options.drafts.prepare();
    let committed = false;
    try {
      if (lease.hasUnsavedDraft && !(await this.options.dialogs.confirmDiscard())) {
        return null;
      }

      lease.assertCurrent();
      const value = await work(lease);
      committed = value !== null;
      return value;
    } finally {
      lease.finish(committed ? 'committed' : 'aborted');
    }
  }

  private async exportCsv(session: string): Promise<{path: string} | null> {
    const handle = this.requireSession(session);
    const selected = await this.options.dialogs.exportCsv();
    if (selected === null) {
      return null;
    }

    const path = resolve(selected);
    await writeCustomerCsv(path, await this.database.listCustomers(handle.db));
    return {path};
  }

  private async backup(session: string): Promise<{path: string} | null> {
    const handle = this.requireSession(session);
    const selected = await this.options.dialogs.backupDatabase();
    if (selected === null) {
      return null;
    }

    const path = resolve(selected);
    const temporary = temporaryPath(path);
    try {
      await this.database.backupDatabase(handle.db, temporary);
      await copyFile(temporary, path, constants.COPYFILE_EXCL);
    } finally {
      await removeDatabaseFile(temporary);
    }

    return {path};
  }

  private async restore(lease?: DraftLease): Promise<DatabaseState | null> {
    const source = await this.options.dialogs.restoreSource();
    if (source === null) {
      return null;
    }

    const destination = await this.options.dialogs.restoreDestination();
    if (destination === null) {
      return null;
    }

    const path = resolve(destination);
    await copyBackup(resolve(source), path);
    try {
      await this.prepareCandidate(path, false, lease);
    } catch (error) {
      await removeDatabaseFile(path);
      throw error;
    }

    return this.status();
  }

  private record(row: CustomerData): CustomerRecord {
    const {revision, ...customer} = row;
    if (!this.state.session) {
      throw new ActionError('DATABASE_UNAVAILABLE', 'Choose a database first.');
    }

    return {customer, reference: {session: this.state.session, id: row.id, revision}};
  }

  private requireSession(session: string): DatabaseHandle {
    if (!this.active) {
      throw new ActionError(
        'DATABASE_UNAVAILABLE',
        'Create or open a customer database first.'
      );
    }

    if (this.state.session !== session) {
      throw new ActionError(
        'STALE_SESSION',
        'The selected database changed. Reload the customer list.'
      );
    }

    return this.active;
  }

  private publish(next: Omit<DatabaseState, 'version'>): void {
    this.state = {...next, version: this.state.version + 1};
    for (const listener of this.listeners) {
      try {
        listener(this.status());
      } catch (error) {
        this.options.logError?.(error);
      }
    }
  }

  private safeError(error: unknown): ContractError {
    if (error instanceof ActionError) {
      return {code: error.code, message: error.message};
    }

    if (error instanceof DatabaseError) {
      switch (error.code) {
        case 'NOT_FOUND':
          return {
            code: 'CUSTOMER_DELETED',
            message: 'This customer no longer exists. Reload the list.',
          };
        case 'STALE_CUSTOMER':
          return {
            code: 'STALE_REVISION',
            message: 'This customer changed. Reload before editing.',
          };
        case 'VALIDATION':
        case 'CUSTOMER_NUMBER_CONFLICT':
        case 'MONEY_PRECISION':
          return {code: 'VALIDATION', message: error.message};
        case 'READ_ONLY':
          return {
            code: 'DATABASE_UNAVAILABLE',
            message: 'The database is read-only. Choose a writable copy.',
          };
        case 'UNSUPPORTED_DATABASE':
          return {
            code: 'DATABASE_UNAVAILABLE',
            message:
              'Choose a supported Shop Things database. Legacy or unrelated files cannot be opened.',
          };
      }
    }

    if (error instanceof Error && 'code' in error) {
      if (error.code === 'EEXIST') {
        return {
          code: 'DATABASE_UNAVAILABLE',
          message:
            'A file already exists at this destination. Choose another name or location.',
        };
      }

      if (error.code === 'EACCES' || error.code === 'EROFS' || error.code === 'ENOENT') {
        return {
          code: 'DATABASE_UNAVAILABLE',
          message:
            'The file could not be saved. Choose a writable folder and a new filename, then try again.',
        };
      }
    }

    this.options.logError?.(error);
    return {
      code: 'INTERNAL',
      message:
        'The operation failed. Check the file and folder permissions, then try again.',
    };
  }

  private async admit<T>(work: () => Promise<T | null>): Promise<Outcome<T>> {
    if (this.busy || this.closePending) {
      return {
        status: 'error',
        error: {
          code: 'BUSY',
          message: 'Another operation is running. Please try again when it finishes.',
        },
      };
    }

    this.busy = true;
    let release!: () => void;
    this.activeOperation = new Promise<void>(done => {
      release = done;
    });

    try {
      const value = await work();
      return value === null ? {status: 'cancelled'} : {status: 'success', value};
    } catch (error) {
      return {status: 'error', error: this.safeError(error)};
    } finally {
      this.busy = false;
      this.activeOperation = null;
      release();
    }
  }
  private async retry(lease?: DraftLease): Promise<DatabaseState> {
    try {
      const path = await this.options.settings.read();
      if (!path) {
        return this.status();
      }

      if (!this.active) {
        this.state = {...this.state, selectedPath: path};
      }

      await this.prepareCandidate(path, false, lease);
      return this.status();
    } catch (error) {
      const safe = this.safeError(error);
      const recoveryError =
        safe.code === 'INTERNAL'
          ? {
              code: 'DATABASE_UNAVAILABLE' as const,
              message:
                'The remembered database could not be opened. Retry or choose Create/Open.',
            }
          : safe;
      if (!this.active) {
        this.publish({
          available: false,
          selectedPath: this.state.selectedPath,
          session: null,
          recoveryError,
        });
      }

      throw new ActionError(recoveryError.code, recoveryError.message);
    }
  }

  private async select(
    kind: 'create' | 'open',
    lease?: DraftLease
  ): Promise<DatabaseState | null> {
    const path = await (kind === 'create'
      ? this.options.dialogs.createDatabase()
      : this.options.dialogs.openDatabase());
    if (path === null) {
      return null;
    }

    try {
      await this.prepareCandidate(resolve(path), kind === 'create', lease);
      return this.status();
    } catch (error) {
      if (!this.active) {
        this.publish({
          available: false,
          selectedPath: this.state.selectedPath,
          session: null,
          recoveryError: this.safeError(error),
        });
      }

      throw error;
    }
  }

  private async prepareCandidate(
    path: string,
    creation: boolean,
    lease?: DraftLease
  ): Promise<void> {
    let candidate: DatabaseHandle | null = null;
    try {
      const open = creation
        ? this.database.createDatabase
        : this.database.openExistingDatabase;
      candidate = await open(path, {migrationsFolder: this.options.migrationsFolder});
      lease?.assertCurrent();
      await this.options.settings.write(path);
      try {
        lease?.assertCurrent();
      } catch (error) {
        if (this.state.selectedPath) {
          await this.options.settings.write(this.state.selectedPath);
        }

        throw error;
      }
    } catch (error) {
      candidate?.close();
      if (error instanceof DatabaseError) {
        throw error;
      }

      if (
        creation &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        throw new ActionError(
          'DATABASE_UNAVAILABLE',
          'A file already exists at this destination. Choose another name or location.'
        );
      }

      this.options.logError?.(error);
      throw new ActionError(
        'DATABASE_UNAVAILABLE',
        'The database could not be selected. Check the file and folder permissions, then retry.'
      );
    }

    const superseded = this.active;
    this.active = candidate;
    this.publish({available: true, selectedPath: path, session: randomUUID()});
    try {
      superseded?.close();
    } catch (error) {
      this.options.logError?.(error);
    }
  }
}
