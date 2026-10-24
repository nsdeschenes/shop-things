import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute} from 'node:path';

import {Effect, Exit} from 'effect';

import {NativeFailure, originalCause, native, runBoundary} from './effectBoundary.js';

export interface DatabaseSettings {
  read(): Promise<string | null>;
  write(path: string): Promise<void>;
  readEffect?(): Effect.Effect<string | null, NativeFailure>;
  writeEffect?(path: string): Effect.Effect<void, NativeFailure>;
}

export class FileDatabaseSettings implements DatabaseSettings {
  constructor(private readonly settingsPath: string) {}

  read(): Promise<string | null> {
    return runBoundary(this.readEffect());
  }
  write(path: string): Promise<void> {
    return runBoundary(this.writeEffect(path));
  }

  readEffect(): Effect.Effect<string | null, NativeFailure> {
    return Effect.gen({self: this}, function* () {
      const read = yield* Effect.exit(native(() => readFile(this.settingsPath, 'utf8')));
      if (Exit.isFailure(read)) {
        const error = originalCause(read.cause);
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return null;
        }

        return yield* Effect.failCause(read.cause);
      }

      const value: unknown = JSON.parse(read.value);
      if (
        typeof value !== 'object' ||
        value === null ||
        !('path' in value) ||
        typeof value.path !== 'string' ||
        !isAbsolute(value.path)
      ) {
        throw new Error('Remembered database settings are invalid');
      }

      return value.path;
    });
  }

  writeEffect(path: string): Effect.Effect<void, NativeFailure> {
    return Effect.gen({self: this}, function* () {
      yield* native(() => mkdir(dirname(this.settingsPath), {recursive: true}));
      const temporary = `${this.settingsPath}.${randomUUID()}.tmp`;
      const written = yield* Effect.exit(
        Effect.gen({self: this}, function* () {
          yield* native(() =>
            writeFile(temporary, JSON.stringify({path}), {flag: 'wx', mode: 0o600})
          );
          yield* native(() => rename(temporary, this.settingsPath));
        })
      );
      yield* native(() => rm(temporary, {force: true}));
      if (Exit.isFailure(written)) {
        return yield* Effect.failCause(written.cause);
      }
    }).pipe(Effect.uninterruptible);
  }
}
