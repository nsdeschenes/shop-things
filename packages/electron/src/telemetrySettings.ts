import {randomUUID} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import type {TelemetrySettingsState} from '@shop-things/contract';
import {telemetryDsnSchema} from '@shop-things/contract/schemas';

export class FileTelemetrySettings {
  readonly startupDsn: string | null;
  private savedDsn: string | null;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly settingsPath: string,
    logError?: (error: unknown) => void
  ) {
    let dsn: string | null = null;
    try {
      if (statSync(settingsPath).size > 8192) {
        throw new Error('Monitoring settings are too large.');
      }

      const value: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (
        typeof value !== 'object' ||
        value === null ||
        Object.keys(value).length !== 1 ||
        !('dsn' in value)
      ) {
        throw new Error('Monitoring settings are invalid.');
      }

      dsn = telemetryDsnSchema.nullable().parse(value.dsn);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        logError?.(error);
      }
    }

    this.startupDsn = dsn;
    this.savedDsn = dsn;
  }

  status(): TelemetrySettingsState {
    return {
      savedDsn: this.savedDsn,
      activeDsn: this.startupDsn,
      activeEnabled: this.startupDsn !== null,
      restartRequired: this.savedDsn !== this.startupDsn,
    };
  }

  save(dsn: string | null): Promise<TelemetrySettingsState> {
    const parsed = telemetryDsnSchema.nullable().parse(dsn);
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.settingsPath), {recursive: true});
      const temporary = `${this.settingsPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({dsn: parsed}), {
          flag: 'wx',
          mode: 0o600,
        });
        await rename(temporary, this.settingsPath);
        this.savedDsn = parsed;
      } finally {
        await rm(temporary, {force: true});
      }

      return this.status();
    });
    this.writes = write.catch(() => {});
    return write;
  }
}
