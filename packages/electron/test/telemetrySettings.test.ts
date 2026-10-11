import {mkdtemp, readFile, writeFile, mkdir, rm, stat, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {defaultTelemetrySampling} from '@shop-things/contract/schemas';
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
      savedSampling: {...defaultTelemetrySampling},
      activeSampling: {...defaultTelemetrySampling},
      activeEnabled: false,
      restartRequired: false,
    });
    await writeFile(
      join(directory, 'database.json'),
      '{"path":"/private/customers.sqlite"}'
    );
    await Promise.all([
      settings.save({dsn: first, sampling: defaultTelemetrySampling}),
      settings.save({dsn: second, sampling: defaultTelemetrySampling}),
    ]);
    expect(settings.status()).toEqual({
      savedDsn: second,
      activeDsn: null,
      savedSampling: {...defaultTelemetrySampling},
      activeSampling: {...defaultTelemetrySampling},
      activeEnabled: false,
      restartRequired: true,
    });
    expect(await readFile(path, 'utf8')).toBe(
      JSON.stringify({dsn: second, sampling: defaultTelemetrySampling})
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, 'database.json'), 'utf8')).toBe(
      '{"path":"/private/customers.sqlite"}'
    );
    expect(await readdir(directory)).toEqual(['database.json', 'telemetry.json']);
    const restarted = new FileTelemetrySettings(path);
    await restarted.save({dsn: first, sampling: defaultTelemetrySampling});
    expect(restarted.status()).toEqual({
      savedDsn: first,
      activeDsn: second,
      savedSampling: {...defaultTelemetrySampling},
      activeSampling: {...defaultTelemetrySampling},
      activeEnabled: true,
      restartRequired: true,
    });
    await restarted.save({dsn: second, sampling: defaultTelemetrySampling});
    expect(restarted.status().restartRequired).toBe(false);
    await restarted.save({dsn: null, sampling: defaultTelemetrySampling});
    expect(restarted.status()).toEqual({
      savedDsn: null,
      activeDsn: second,
      savedSampling: {...defaultTelemetrySampling},
      activeSampling: {...defaultTelemetrySampling},
      activeEnabled: true,
      restartRequired: true,
    });
    expect(new FileTelemetrySettings(path).status().activeEnabled).toBe(false);
    for (const corrupt of [
      '{',
      '{"dsn":42}',
      '{"dsn":"https://public@host/1?private=secret"}',
      '{"dsn":null,"extra":true}',
      '{"dsn":"https://public@host/1","sampling":{"errors":-1,"traces":100}}',
      '{"dsn":"https://public@host/1","sampling":{"errors":100,"traces":101}}',
      '{"dsn":"https://public@host/1","sampling":{"errors":100,"traces":100,"logs":-1}}',
      '{"dsn":"https://public@host/1","sampling":{"errors":100,"traces":100,"metrics":101}}',
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
    await expect(
      settings.save({
        dsn: second,
        sampling: {...defaultTelemetrySampling, errors: 25, traces: 0},
      })
    ).rejects.toThrow();
    expect(settings.status()).toEqual({
      savedDsn: first,
      activeDsn: first,
      savedSampling: {...defaultTelemetrySampling},
      activeSampling: {...defaultTelemetrySampling},
      activeEnabled: true,
      restartRequired: false,
    });
    expect(await readdir(directory)).toEqual(['telemetry.json']);
    await rm(path, {recursive: true});
    await settings.save({dsn: second, sampling: defaultTelemetrySampling});
    expect(settings.status().savedDsn).toBe(second);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('legacy files keep full sampling and sampling-only saves apply on restart without exposing mutable state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-sampling-'));
  const path = join(directory, 'telemetry.json');
  try {
    await writeFile(
      path,
      JSON.stringify({dsn: first, sampling: {errors: 50, traces: 25}})
    );
    expect(new FileTelemetrySettings(path).status().activeSampling).toEqual({
      errors: 50,
      traces: 25,
      logs: 100,
      metrics: 100,
    });
    await writeFile(path, JSON.stringify({dsn: first}));
    const settings = new FileTelemetrySettings(path);
    expect(settings.status().activeSampling).toEqual(defaultTelemetrySampling);
    const sampling = {errors: 12.5, traces: 0, logs: 25, metrics: 75.5};
    const saved = settings.save({dsn: first, sampling});
    sampling.errors = 99;
    await saved;
    expect(settings.status()).toMatchObject({
      savedDsn: first,
      activeDsn: first,
      savedSampling: {errors: 12.5, traces: 0, logs: 25, metrics: 75.5},
      activeSampling: defaultTelemetrySampling,
      restartRequired: true,
    });
    settings.status().savedSampling.errors = 99;
    settings.status().activeSampling.errors = 99;
    expect(settings.status().savedSampling.errors).toBe(12.5);
    expect(settings.startupSampling.errors).toBe(100);
    expect(Object.isFrozen(settings.startupSampling)).toBe(true);
    expect(new FileTelemetrySettings(path).status()).toMatchObject({
      activeSampling: {errors: 12.5, traces: 0, logs: 25, metrics: 75.5},
      restartRequired: false,
    });
    await settings.save({dsn: first, sampling: defaultTelemetrySampling});
    expect(settings.status().restartRequired).toBe(false);
    for (const field of ['logs', 'metrics'] as const) {
      await settings.save({
        dsn: first,
        sampling: {...defaultTelemetrySampling, [field]: 0},
      });
      expect(settings.status().restartRequired).toBe(true);
      expect(settings.status().activeSampling).toEqual(defaultTelemetrySampling);
      await settings.save({dsn: first, sampling: defaultTelemetrySampling});
      expect(settings.status().restartRequired).toBe(false);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
