import {Effect} from 'effect';

import type {AppDatabase} from './database.js';
import {native} from './failure.js';
import type {DatabaseFailure} from './failure.js';

interface TransactionOptions<A> {
  begin?: string;
  rollbackResult?: (result: A) => boolean;
  retryRollbackFailure?: boolean;
}

export function transaction<A>(
  db: AppDatabase,
  body: Effect.Effect<A, DatabaseFailure>,
  {
    begin = 'BEGIN',
    rollbackResult = () => false,
    retryRollbackFailure = false,
  }: TransactionOptions<A> = {}
): Effect.Effect<A, DatabaseFailure> {
  return Effect.uninterruptibleMask(restore =>
    Effect.gen(function* () {
      yield* native(() => db.run(begin));
      const result = yield* restore(body).pipe(
        Effect.catchCause(cause =>
          native(() => db.run('ROLLBACK')).pipe(
            Effect.flatMap(() => Effect.failCause(cause))
          )
        )
      );
      if (rollbackResult(result)) {
        const rollback = native(() => db.run('ROLLBACK'));
        yield* retryRollbackFailure
          ? rollback.pipe(
              Effect.catchCause(cause =>
                rollback.pipe(Effect.flatMap(() => Effect.failCause(cause)))
              )
            )
          : rollback;
      } else {
        yield* native(() => db.run('COMMIT')).pipe(
          Effect.catchCause(cause =>
            native(() => db.run('ROLLBACK')).pipe(
              Effect.flatMap(() => Effect.failCause(cause))
            )
          )
        );
      }

      return result;
    })
  );
}
