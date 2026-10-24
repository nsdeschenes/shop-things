import {Effect} from 'effect';

export function nativePromise<A>(work: () => PromiseLike<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({try: work, catch: error => error});
}

export const runRenderer = Effect.runPromise;

export const nextMicrotask = Effect.callback<void>(resume => {
  queueMicrotask(() => resume(Effect.void));
});
