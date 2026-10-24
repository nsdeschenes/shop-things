import {Effect} from 'effect';

export class DatabaseError extends Error {
  readonly _tag = 'DatabaseError';

  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export class DatabaseNativeError {
  readonly _tag = 'DatabaseNativeError';

  constructor(readonly cause: unknown) {}
}

export type DatabaseFailure = DatabaseError | DatabaseNativeError;

export function databaseFailure(error: unknown): DatabaseFailure {
  return error instanceof DatabaseError ? error : new DatabaseNativeError(error);
}

export function attempt<A>(work: () => A): Effect.Effect<A, DatabaseFailure> {
  return Effect.try({try: work, catch: databaseFailure});
}

export function native<A>(work: () => PromiseLike<A>): Effect.Effect<A, DatabaseFailure> {
  // Turso and filesystem promises cannot be cancelled. Cleanup must wait for settlement.
  return Effect.uninterruptible(
    Effect.tryPromise({try: () => Promise.resolve(work()), catch: databaseFailure})
  );
}
