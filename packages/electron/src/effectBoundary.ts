import {Cause, Effect} from 'effect';

export class NativeFailure {
  readonly _tag = 'NativeFailure';
  constructor(readonly cause: unknown) {}
}

export function native<A>(work: () => PromiseLike<A>): Effect.Effect<A, NativeFailure> {
  return Effect.uninterruptible(
    Effect.tryPromise({
      try: () => Promise.resolve(work()),
      catch: cause => new NativeFailure(cause),
    })
  );
}

export function immediateError(error: unknown): unknown {
  if (
    error instanceof NativeFailure ||
    (typeof error === 'object' &&
      error !== null &&
      '_tag' in error &&
      error._tag === 'DatabaseNativeError' &&
      'cause' in error)
  ) {
    return error.cause;
  }

  return error;
}

export function originalCause<E>(cause: Cause.Cause<E>): unknown {
  return immediateError(Cause.squash(cause));
}

export function runBoundary<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(
    Effect.catchCause(program, cause => Effect.fail(originalCause(cause)))
  );
}
