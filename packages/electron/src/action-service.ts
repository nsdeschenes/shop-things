/* oxlint-disable import/no-named-export -- Backend APIs are consumed by IPC and packaged runners. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  createDatabase,
  openExistingDatabase,
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  DatabaseError,
} from "@shop-things/db";
import type { CustomerChanges, CustomerData, DatabaseHandle } from "@shop-things/db";
import type {
  ActionHandlers,
  ActionResults,
  ContractError,
  CustomerRecord,
  DatabaseState,
  ErrorCode,
  UpdateCustomerInput,
} from "@shop-things/contract";
import type { DatabaseSettings } from "./settings.js";

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
};
export type DatabaseOperations = typeof databaseOperations;
type Outcome<T> =
  | { status: "success"; value: T }
  | Exclude<ActionResults["database.status"], { status: "success" }>;
class ActionError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function definedChanges(changes: UpdateCustomerInput): CustomerChanges {
  return {
    ...(changes.firstName !== undefined ? { firstName: changes.firstName } : {}),
    ...(changes.lastName !== undefined ? { lastName: changes.lastName } : {}),
    ...(changes.address !== undefined ? { address: changes.address } : {}),
    ...(changes.city !== undefined ? { city: changes.city } : {}),
    ...(changes.province !== undefined ? { province: changes.province } : {}),
    ...(changes.postalCode !== undefined ? { postalCode: changes.postalCode } : {}),
    ...(changes.homePhone !== undefined ? { homePhone: changes.homePhone } : {}),
    ...(changes.email !== undefined ? { email: changes.email } : {}),
    ...(changes.stock !== undefined ? { stock: changes.stock } : {}),
    ...(changes.balance !== undefined ? { balance: changes.balance } : {}),
    ...(changes.previousBalance !== undefined ? { previousBalance: changes.previousBalance } : {}),
    ...(changes.donate !== undefined ? { donate: changes.donate } : {}),
    ...(changes.comments !== undefined ? { comments: changes.comments } : {}),
    ...(changes.customerNumber !== undefined ? { customerNumber: changes.customerNumber } : {}),
  };
}

export interface ActionServiceOptions {
  migrationsFolder: string;
  settings: DatabaseSettings;
  dialogs: BackendDialogs;
  database?: DatabaseOperations;
  logError?: (error: unknown) => void;
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

  constructor(private readonly options: ActionServiceOptions) {
    this.database = options.database ?? databaseOperations;
    this.handlers = {
      "database.status": async () => ({ status: "success", value: this.status() }),
      "database.retry": () => this.admit(() => this.retry()),
      "database.create": () => this.admit(() => this.select("create")),
      "database.open": () => this.admit(() => this.select("open")),
      "customers.list": (args) =>
        this.admit(async () => {
          const handle = this.requireSession(args.session);
          return (await this.database.listCustomers(handle.db, args.query)).map((row) =>
            this.record(row),
          );
        }),
      "customers.get": (args) =>
        this.admit(async () => {
          const row = await this.database.getCustomer(
            this.requireSession(args.session).db,
            args.id,
          );
          if (!row) {
            throw new ActionError(
              "CUSTOMER_DELETED",
              "This customer no longer exists. Reload the list.",
            );
          }

          return this.record(row);
        }),
      "customers.create": (args) =>
        this.admit(async () =>
          this.record(
            await this.database.createCustomer(this.requireSession(args.session).db, args.values),
          ),
        ),
      "customers.update": (args) =>
        this.admit(async () =>
          this.record(
            await this.database.updateCustomer(
              this.requireSession(args.reference.session).db,
              args.reference,
              definedChanges(args.changes),
            ),
          ),
        ),
      "customers.delete": (args) =>
        this.admit(async () => {
          await this.database.deleteCustomer(
            this.requireSession(args.reference.session).db,
            args.reference,
          );
          return { deleted: true as const };
        }),
      "database.backup": async () => this.unavailableFeature(),
      "database.restore": async () => this.unavailableFeature(),
      "exports.csv": async () => this.unavailableFeature(),
      "drafts.confirmDiscard": async () => this.unavailableFeature(),
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
    await this.admit(() => this.retry());
  }
  closeUnprotected(): void {
    if (this.busy) {
      throw new Error("Wait for the current database operation");
    }

    this.active?.close();
    this.active = null;
    this.publish({ available: false, selectedPath: this.state.selectedPath, session: null });
  }
  private unavailableFeature(): { status: "error"; error: ContractError } {
    return {
      status: "error",
      error: {
        code: "DATABASE_UNAVAILABLE",
        message: "Protected coordination is not available yet.",
      },
    };
  }
  private record(row: CustomerData): CustomerRecord {
    const { revision, ...customer } = row;
    if (!this.state.session) {
      throw new ActionError("DATABASE_UNAVAILABLE", "Choose a database first.");
    }

    return { customer, reference: { session: this.state.session, id: row.id, revision } };
  }
  private requireSession(session: string): DatabaseHandle {
    if (!this.active) {
      throw new ActionError("DATABASE_UNAVAILABLE", "Create or open a customer database first.");
    }

    if (this.state.session !== session) {
      throw new ActionError(
        "STALE_SESSION",
        "The selected database changed. Reload the customer list.",
      );
    }

    return this.active;
  }
  private publish(next: Omit<DatabaseState, "version">): void {
    this.state = { ...next, version: this.state.version + 1 };
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
      return { code: error.code, message: error.message };
    }

    if (error instanceof DatabaseError) {
      switch (error.code) {
        case "NOT_FOUND":
          return {
            code: "CUSTOMER_DELETED",
            message: "This customer no longer exists. Reload the list.",
          };
        case "STALE_CUSTOMER":
          return {
            code: "STALE_REVISION",
            message: "This customer changed. Reload before editing.",
          };
        case "VALIDATION":
        case "CUSTOMER_NUMBER_CONFLICT":
        case "MONEY_PRECISION":
          return { code: "VALIDATION", message: error.message };
        case "READ_ONLY":
          return {
            code: "DATABASE_UNAVAILABLE",
            message: "The database is read-only. Choose a writable copy.",
          };
        case "UNSUPPORTED_DATABASE":
          return {
            code: "DATABASE_UNAVAILABLE",
            message:
              "Choose a supported Shop Things database. Legacy or unrelated files cannot be opened.",
          };
      }
    }

    this.options.logError?.(error);
    return { code: "INTERNAL", message: "The operation failed. Please try again." };
  }
  private async admit<T>(work: () => Promise<T | null>): Promise<Outcome<T>> {
    if (this.busy) {
      return {
        status: "error",
        error: {
          code: "BUSY",
          message: "Another operation is running. Please try again when it finishes.",
        },
      };
    }

    this.busy = true;
    try {
      const value = await work();
      return value === null ? { status: "cancelled" } : { status: "success", value };
    } catch (error) {
      return { status: "error", error: this.safeError(error) };
    } finally {
      this.busy = false;
    }
  }
  private async retry(): Promise<DatabaseState> {
    if (this.active) {
      throw new ActionError(
        "DATABASE_UNAVAILABLE",
        "Protected coordination is required to reopen the active database.",
      );
    }

    try {
      const path = await this.options.settings.read();
      if (!path) {
        return this.status();
      }

      this.state = { ...this.state, selectedPath: path };
      await this.prepareCandidate(path, false);
      return this.status();
    } catch (error) {
      const safe = this.safeError(error);
      const recoveryError =
        safe.code === "INTERNAL"
          ? {
              code: "DATABASE_UNAVAILABLE" as const,
              message: "The remembered database could not be opened. Retry or choose Create/Open.",
            }
          : safe;
      this.publish({
        available: false,
        selectedPath: this.state.selectedPath,
        session: null,
        recoveryError,
      });
      throw new ActionError(recoveryError.code, recoveryError.message);
    }
  }
  private async select(kind: "create" | "open"): Promise<DatabaseState | null> {
    if (this.active) {
      throw new ActionError(
        "DATABASE_UNAVAILABLE",
        "Protected coordination is required to switch databases.",
      );
    }

    const path = await (kind === "create"
      ? this.options.dialogs.createDatabase()
      : this.options.dialogs.openDatabase());
    if (path === null) {
      return null;
    }

    try {
      await this.prepareCandidate(resolve(path), kind === "create");
      return this.status();
    } catch (error) {
      this.publish({
        available: false,
        selectedPath: this.state.selectedPath,
        session: null,
        recoveryError: this.safeError(error),
      });
      throw error;
    }
  }
  private async prepareCandidate(path: string, creation: boolean): Promise<void> {
    let candidate: DatabaseHandle | null = null;
    try {
      const open = creation ? this.database.createDatabase : this.database.openExistingDatabase;
      candidate = await open(path, { migrationsFolder: this.options.migrationsFolder });
      await this.options.settings.write(path);
    } catch (error) {
      candidate?.close();
      if (error instanceof DatabaseError) {
        throw error;
      }

      this.options.logError?.(error);
      throw new ActionError(
        "DATABASE_UNAVAILABLE",
        "The database could not be selected. Check the file and folder permissions, then retry.",
      );
    }

    this.active?.close();
    this.active = candidate;
    this.publish({ available: true, selectedPath: path, session: randomUUID() });
  }
}
