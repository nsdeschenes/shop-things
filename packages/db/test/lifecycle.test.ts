import * as filesystem from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createDatabase} from '@shop-things/db';
import * as database from '@shop-things/db/effect';
import {migrate} from 'drizzle-orm/tursodatabase/migrator';
import {Cause, Effect, Exit} from 'effect';
import {afterEach, assert, expect, test, vi} from 'vitest';

import {openDatabase} from '../dist/database.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof filesystem>();
  return {...original, open: vi.fn(original.open), unlink: vi.fn(original.unlink)};
});
vi.mock('../dist/database.js', async importOriginal => {
  const original = await importOriginal<typeof import('../dist/database.js')>();
  return {...original, openDatabase: vi.fn(original.openDatabase)};
});
vi.mock('drizzle-orm/tursodatabase/migrator', async importOriginal => {
  const original =
    await importOriginal<typeof import('drizzle-orm/tursodatabase/migrator')>();
  return {...original, migrate: vi.fn(original.migrate)};
});

const originalFilesystem = await vi.importActual<typeof filesystem>('node:fs/promises');
const originalDatabase =
  await vi.importActual<typeof import('../dist/database.js')>('../dist/database.js');
const originalMigrator = await vi.importActual<
  typeof import('drizzle-orm/tursodatabase/migrator')
>('drizzle-orm/tursodatabase/migrator');
const options = {
  migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function withDestination(work: (path: string) => Promise<void>) {
  const directory = await filesystem.mkdtemp(join(tmpdir(), 'database-lifecycle-'));
  try {
    await work(join(directory, 'app.db'));
  } finally {
    await filesystem.rm(directory, {recursive: true, force: true});
  }
}

const adapters = [
  {
    name: 'Effect',
    failure: async (path: string) => {
      const exit = await Effect.runPromiseExit(database.createDatabase(path, options));
      assert(Exit.isFailure(exit));
      const failure = Cause.squash(exit.cause);
      assert.instanceOf(failure, database.DatabaseNativeError);
      return failure.cause;
    },
  },
  {
    name: 'Promise',
    failure: async (path: string) => {
      return createDatabase(path, options).then(
        handle => {
          handle.close();
          throw new Error('Expected database creation to fail');
        },
        (error: unknown) => error
      );
    },
  },
];

test.each(adapters)(
  '$name removes its destination when the initial file close fails',
  async adapter => {
    await withDestination(async path => {
      const error = new Error('reservation close failed');
      vi.mocked(filesystem.open).mockImplementationOnce(async (filePath, flags) => {
        const file = await originalFilesystem.open(filePath, flags);
        const close = file.close.bind(file);
        vi.spyOn(file, 'close').mockImplementationOnce(async () => {
          await close();
          throw error;
        });
        return file;
      });

      expect(await adapter.failure(path)).toBe(error);
      expect(openDatabase).not.toHaveBeenCalled();
      await expect(filesystem.stat(path)).rejects.toMatchObject({code: 'ENOENT'});
    });
  }
);

test.each(adapters)(
  '$name removes its destination when handle construction fails',
  async adapter => {
    await withDestination(async path => {
      const error = new Error('handle construction failed');
      vi.mocked(openDatabase).mockImplementationOnce(() => {
        throw error;
      });

      expect(await adapter.failure(path)).toBe(error);
      expect(filesystem.unlink).toHaveBeenCalledWith(path);
      await expect(filesystem.stat(path)).rejects.toMatchObject({code: 'ENOENT'});
    });
  }
);

test.each(adapters)(
  '$name selects close failure and still unlinks after migration failure',
  async adapter => {
    await withDestination(async path => {
      const migrationError = new Error('migration failed');
      const closeError = new Error('candidate close failed');
      const events: string[] = [];
      vi.mocked(openDatabase).mockImplementationOnce((filePath, openOptions) => {
        const handle = originalDatabase.openDatabase(filePath, openOptions);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementationOnce(() => {
          events.push('close');
          close();
          throw closeError;
        });
        return handle;
      });
      vi.mocked(migrate).mockRejectedValueOnce(migrationError);
      vi.mocked(filesystem.unlink).mockImplementationOnce(async filePath => {
        events.push('unlink');
        await originalFilesystem.unlink(filePath);
      });

      expect(await adapter.failure(path)).toBe(closeError);
      expect(events).toEqual(['close', 'unlink']);
      await expect(filesystem.stat(path)).rejects.toMatchObject({code: 'ENOENT'});
    });
  }
);

test.each(adapters)(
  '$name preserves close error identity when unlink also fails',
  async adapter => {
    await withDestination(async path => {
      const migrationError = new Error('migration failed');
      const closeError = new Error('candidate close failed');
      const unlinkError = new Error('unlink failed');
      vi.mocked(openDatabase).mockImplementationOnce((filePath, openOptions) => {
        const handle = originalDatabase.openDatabase(filePath, openOptions);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementationOnce(() => {
          close();
          throw closeError;
        });
        return handle;
      });
      vi.mocked(migrate).mockRejectedValueOnce(migrationError);
      vi.mocked(filesystem.unlink).mockRejectedValueOnce(unlinkError);

      expect(await adapter.failure(path)).toBe(closeError);
      expect(filesystem.unlink).toHaveBeenCalledWith(path);
    });
  }
);

test.each(adapters)(
  '$name selects unlink failure over the initialization failure',
  async adapter => {
    await withDestination(async path => {
      const migrationError = new Error('migration failed');
      const unlinkError = new Error('unlink failed');
      vi.mocked(migrate).mockRejectedValueOnce(migrationError);
      vi.mocked(filesystem.unlink).mockRejectedValueOnce(unlinkError);

      expect(await adapter.failure(path)).toBe(unlinkError);
      expect((await filesystem.stat(path)).isFile()).toBe(true);
    });
  }
);

test('exclusive creation failure preserves an existing destination', async () => {
  await withDestination(async path => {
    await filesystem.writeFile(path, 'existing database contents');

    await expect(createDatabase(path, options)).rejects.toMatchObject({code: 'EEXIST'});
    expect(await filesystem.readFile(path, 'utf8')).toBe('existing database contents');
    expect(filesystem.unlink).not.toHaveBeenCalled();
    expect(openDatabase).not.toHaveBeenCalled();
  });
});

test('a recoverable construction failure permits a usable database at the same path', async () => {
  await withDestination(async path => {
    const error = new Error('recoverable construction failure');
    vi.mocked(openDatabase).mockImplementationOnce(() => {
      throw error;
    });
    await expect(createDatabase(path, options)).rejects.toBe(error);
    await expect(filesystem.stat(path)).rejects.toMatchObject({code: 'ENOENT'});

    const handle = await createDatabase(path, options);
    try {
      expect(await handle.db.all('select 42 as value')).toEqual([{value: 42}]);
      expect((await filesystem.stat(path)).isFile()).toBe(true);
    } finally {
      handle.close();
    }
  });
});

test('interrupted creation waits for native migration settlement before close and unlink', async () => {
  await withDestination(async path => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    vi.mocked(openDatabase).mockImplementationOnce((filePath, openOptions) => {
      const candidate = originalDatabase.openDatabase(filePath, openOptions);
      const close = candidate.close.bind(candidate);
      vi.spyOn(candidate, 'close').mockImplementationOnce(() => {
        events.push('close');
        close();
      });
      return candidate;
    });
    vi.mocked(migrate).mockImplementationOnce(async (db, config) => {
      events.push('migration started');
      started.resolve();
      await release.promise;
      await originalMigrator.migrate(db, config);
      events.push('migration settled');
    });
    vi.mocked(filesystem.unlink).mockImplementationOnce(async filePath => {
      events.push('unlink');
      await originalFilesystem.unlink(filePath);
    });
    const pending = Effect.runPromiseExit(database.createDatabase(path, options), {
      signal: controller.signal,
    });
    try {
      await started.promise;
      controller.abort();
      await Promise.resolve();
      expect(events).toEqual(['migration started']);
      release.resolve();
      const exit = await pending;
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(events).toEqual([
        'migration started',
        'migration settled',
        'close',
        'unlink',
      ]);
      await expect(filesystem.stat(path)).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      release.resolve();
      await pending;
    }
  });
});
