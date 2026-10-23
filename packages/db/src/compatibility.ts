import {Cause, Effect, Exit} from 'effect';

import {DatabaseNativeError} from './failure.js';
import type {DatabaseFailure} from './failure.js';

export function promiseAdapter<Args extends unknown[], A>(
  operation: (...args: Args) => Effect.Effect<A, DatabaseFailure>
): (...args: Args) => Promise<A> {
  return async (...args) => {
    const exit = await Effect.runPromiseExit(operation(...args));
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }

    const error = Cause.squash(exit.cause);
    throw error instanceof DatabaseNativeError ? error.cause : error;
  };
}
