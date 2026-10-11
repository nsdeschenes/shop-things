import {mkdtemp, readFile, writeFile, mkdir, rm, stat, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import {FileTelemetrySettings} from '../src/telemetrySettings.js';

const first = 'https://public@ingest.example.com/42';
const second = 'http://local@localhost:9000/sentry/43';

test('missing and corrupt settings fail closed, writes are private, ordered and independent, and startup is immutable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-settings-'));
  const path = join(directory, 'telemetry.json');
  try {
    const settings = new FileTelemetrySettings(path);
    expect(settings.status()).toEqual({
      savedDsn: null,
      activeDsn: null,
      activeEnabled: false,
      restartRequired: false,
    });
    await writeFile(
      join(directory, 'database.json'),
      '{"path":"/private/customers.sqlite"}'
    );
    await Promise.all([settings.save(first), settings.save(second)]);
    expect(settings.status()).toEqual({
      savedDsn: second,
      activeDsn: null,
      activeEnabled: false,
      restartRequired: true,
    });
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify({dsn: second}));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, 'database.json'), 'utf8')).toBe(
      '{"path":"/private/customers.sqlite"}'
    );
    expect(await readdir(directory)).toEqual(['database.json', 'telemetry.json']);
    const restarted = new FileTelemetrySettings(path);
    await restarted.save(first);
    expect(restarted.status()).toEqual({
      savedDsn: first,
      activeDsn: second,
      activeEnabled: true,
      restartRequired: true,
    });
    await restarted.save(second);
    expect(restarted.status().restartRequired).toBe(false);
    await restarted.save(null);
    expect(restarted.status()).toEqual({
      savedDsn: null,
      activeDsn: second,
      activeEnabled: true,
      restartRequired: true,
    });
    expect(new FileTelemetrySettings(path).status().activeEnabled).toBe(false);
    for (const corrupt of [
      '{',
      '{"dsn":42}',
      '{"dsn":"https://public@host/1?private=secret"}',
      '{"dsn":null,"extra":true}',
    ]) {
      await writeFile(path, corrupt);
      const errors: unknown[] = [];
      expect(
        new FileTelemetrySettings(path, error => errors.push(error)).status()
          .activeEnabled
      ).toBe(false);
      expect(errors).toHaveLength(1);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('a failed atomic replacement retains saved and active state and the next save can succeed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-failed-write-'));
  const path = join(directory, 'telemetry.json');
  try {
    await writeFile(path, JSON.stringify({dsn: first}));
    const settings = new FileTelemetrySettings(path);
    await rm(path);
    await mkdir(path);
    await expect(settings.save(second)).rejects.toThrow();
    expect(settings.status()).toEqual({
      savedDsn: first,
      activeDsn: first,
      activeEnabled: true,
      restartRequired: false,
    });
    expect(await readdir(directory)).toEqual(['telemetry.json']);
    await rm(path, {recursive: true});
    await settings.save(second);
    expect(settings.status().savedDsn).toBe(second);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
