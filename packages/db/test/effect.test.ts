import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  backupDatabase,
  createDatabase,
  importCustomerBatch,
  listCustomers,
  openDatabase,
} from '@shop-things/db';
import type {DatabaseHandle} from '@shop-things/db';
import * as database from '@shop-things/db/effect';
import {Cause, Effect, Exit} from 'effect';
import {assert, expect, test, vi} from 'vitest';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

async function fixture(
  work: (handle: DatabaseHandle, directory: string) => Promise<void>
) {
  const directory = await mkdtemp(join(tmpdir(), 'database-effect-'));
  const handle = await createDatabase(join(directory, 'app.db'), {migrationsFolder});
  try {
    await work(handle, directory);
  } finally {
    vi.restoreAllMocks();
    handle.close();
    await rm(directory, {recursive: true, force: true});
  }
}

test('interrupted import waits for native BEGIN settlement before rolling back', async () => {
  await fixture(async ({db}) => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const run = db.run.bind(db);
    vi.spyOn(db, 'run').mockImplementation(statement => {
      const query = run(statement);
      const execute = query.execute.bind(query);
      vi.spyOn(query, 'execute').mockImplementation(async () => {
        if (statement === 'BEGIN IMMEDIATE') {
          const result = await execute();
          events.push('began');
          started.resolve();
          await release.promise;
          events.push('settled');
          return result;
        }

        events.push(typeof statement === 'string' ? statement : 'SQL');
        return execute();
      });
      return query;
    });
    const plan = vi.fn(() => [{customerNumber: 1, firstName: 'Interrupted'}]);
    const pending = Effect.runPromiseExit(
      database
        .importCustomerBatch(db, plan)
        .pipe(Effect.ensuring(Effect.sync(() => events.push('released')))),
      {signal: controller.signal}
    );
    await started.promise;
    controller.abort();
    await Promise.resolve();
    expect(events).toEqual(['began']);
    release.resolve();
    const exit = await pending;
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(events).toEqual(['began', 'settled', 'ROLLBACK', 'released']);
    expect(plan).not.toHaveBeenCalled();
    expect(await listCustomers(db)).toEqual([]);
    expect(
      await importCustomerBatch(db, () => [{customerNumber: 1, firstName: 'After'}])
    ).toMatchObject([{firstName: 'After'}]);
  });
});

test('native failure keeps its immediate cause and Promise compatibility rejects that same object', async () => {
  await fixture(async ({db}, directory) => {
    const original = new Error('native backup failure', {
      cause: new Error('nested cause'),
    });
    vi.spyOn(db, 'run').mockRejectedValue(original);
    const exit = await Effect.runPromiseExit(
      database.backupDatabase(db, join(directory, 'backup.db'))
    );
    assert(Exit.isFailure(exit));
    const failure = Cause.squash(exit.cause);
    assert.instanceOf(failure, database.DatabaseNativeError);
    expect(failure.cause).toBe(original);

    await expect(backupDatabase(db, join(directory, 'backup.db'))).rejects.toBe(original);
  });
});

test('import rollback failure overrides a planner failure without changing the native error identity', async () => {
  await fixture(async ({db}) => {
    const plannerError = new Error('planner failed');
    const rollbackError = new Error('rollback failed');
    const run = db.run.bind(db);
    vi.spyOn(db, 'run').mockImplementation(statement => {
      const query = run(statement);
      const execute = query.execute.bind(query);
      vi.spyOn(query, 'execute').mockImplementation(async () => {
        const result = await execute();
        if (statement === 'ROLLBACK') {
          throw rollbackError;
        }

        return result;
      });
      return query;
    });
    await expect(
      importCustomerBatch(db, () => {
        throw plannerError;
      })
    ).rejects.toBe(rollbackError);
    expect(await listCustomers(db)).toEqual([]);
  });
});

test('null import planner rolls back and leaves the connection available for the next import', async () => {
  await fixture(async ({db}) => {
    expect(
      await Effect.runPromise(database.importCustomerBatch(db, () => null))
    ).toBeNull();
    expect(
      await Effect.runPromise(
        database.importCustomerBatch(db, () => [
          {customerNumber: 2, firstName: 'Imported'},
        ])
      )
    ).toMatchObject([{customerNumber: 2}]);
  });
});

test('interrupted recognition waits for a pending native query before closing its handle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-recognition-'));
  const handle = openDatabase(join(directory, 'unrecognized.db'));
  let closed = false;
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  const all = handle.db.all.bind(handle.db);
  vi.spyOn(handle.db, 'all').mockImplementation(statement => {
    const query = all(statement);
    const execute = query.execute.bind(query);
    vi.spyOn(query, 'execute').mockImplementation(async () => {
      started.resolve();
      try {
        await release.promise;
        return await execute();
      } finally {
        events.push('settled');
      }
    });
    return query;
  });
  try {
    const pending = Effect.runPromiseExit(
      Effect.acquireUseRelease(
        Effect.succeed(handle),
        resource => database.recognizeDatabase(resource.db),
        resource =>
          Effect.sync(() => {
            events.push('closed');
            resource.close();
            closed = true;
          })
      ),
      {signal: controller.signal}
    );
    await started.promise;
    controller.abort();
    await Promise.resolve();
    expect(events).toEqual([]);
    release.resolve();
    const exit = await pending;
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(events).toEqual(['settled', 'closed']);
  } finally {
    release.resolve();
    vi.restoreAllMocks();
    if (!closed) {
      handle.close();
    }

    await rm(directory, {recursive: true, force: true});
  }
});

test('successful candidates survive the opening scope and failed creation removes its file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-candidate-'));
  try {
    const handle = await Effect.runPromise(
      Effect.scoped(
        database.createDatabase(join(directory, 'app.db'), {migrationsFolder})
      )
    );
    try {
      expect(await Effect.runPromise(database.listCustomers(handle.db))).toEqual([]);
    } finally {
      handle.close();
    }

    const failedPath = join(directory, 'failed.db');
    await expect(
      Effect.runPromise(
        database.createDatabase(failedPath, {
          migrationsFolder: join(directory, 'missing'),
        })
      )
    ).rejects.toBeInstanceOf(database.DatabaseNativeError);
    await expect(stat(failedPath)).rejects.toMatchObject({code: 'ENOENT'});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('an import conflict rolls back earlier rows from the same locked plan', async () => {
  await fixture(async ({db}) => {
    await expect(
      importCustomerBatch(db, saved => {
        expect(saved).toEqual([]);
        return [
          {customerNumber: 1, firstName: 'First'},
          {customerNumber: 1, firstName: 'Conflict'},
        ];
      })
    ).rejects.toMatchObject({code: 'CUSTOMER_NUMBER_CONFLICT'});
    expect(await listCustomers(db)).toEqual([]);
  });
});

test('a failed cancellation rollback is retried before returning the original failure', async () => {
  await fixture(async ({db}) => {
    const original = new Error('first rollback failed');
    const run = db.run.bind(db);
    let rollbacks = 0;
    vi.spyOn(db, 'run').mockImplementation(statement => {
      const query = run(statement);
      if (statement === 'ROLLBACK') {
        rollbacks++;
        if (rollbacks === 1) {
          vi.spyOn(query, 'execute').mockRejectedValue(original);
        }
      }

      return query;
    });
    await expect(importCustomerBatch(db, () => null)).rejects.toBe(original);
    expect(rollbacks).toBe(2);
    expect(
      await importCustomerBatch(db, () => [{customerNumber: 1, firstName: 'After'}])
    ).toMatchObject([{customerNumber: 1}]);
  });
});
