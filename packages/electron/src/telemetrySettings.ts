import {randomUUID} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import type {
  TelemetryConfiguration,
  TelemetryEnvironment,
  TelemetrySampling,
  TelemetrySettingsState,
} from '@shop-things/contract';
import {
  defaultTelemetrySampling,
  telemetryConfigurationSchema,
  telemetryDsnSchemaForEnvironment,
  telemetrySamplingSchema,
} from '@shop-things/contract/schemas';

export class FileTelemetrySettings {
  readonly startupDsn: string | null;
  readonly startupSampling: Readonly<TelemetrySampling>;
  private saved: TelemetryConfiguration;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly settingsPath: string,
    logError?: (error: unknown) => void,
    readonly environment: TelemetryEnvironment = 'development'
  ) {
    let configuration: TelemetryConfiguration = {
      dsn: null,
      sampling: {...defaultTelemetrySampling},
    };
    try {
      if (statSync(settingsPath).size > 8192) {
        throw new Error('Monitoring settings are too large.');
      }

      const value: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
      configuration = telemetryConfigurationSchema
        .extend({
          dsn: telemetryDsnSchemaForEnvironment(environment).nullable(),
          sampling: telemetrySamplingSchema.default(defaultTelemetrySampling),
        })
        .parse(value);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        logError?.(new Error('Could not load monitoring settings.'));
      }
    }

    this.startupDsn = configuration.dsn;
    this.startupSampling = Object.freeze({...configuration.sampling});
    this.saved = configuration;
  }

  status(): TelemetrySettingsState {
    return {
      environment: this.environment,
      savedDsn: this.saved.dsn,
      activeDsn: this.startupDsn,
      savedSampling: {...this.saved.sampling},
      activeSampling: {...this.startupSampling},
      activeEnabled: this.startupDsn !== null,
      restartRequired:
        this.saved.dsn !== this.startupDsn ||
        this.saved.sampling.errors !== this.startupSampling.errors ||
        this.saved.sampling.traces !== this.startupSampling.traces ||
        this.saved.sampling.logs !== this.startupSampling.logs ||
        this.saved.sampling.metrics !== this.startupSampling.metrics,
    };
  }

  save(configuration: TelemetryConfiguration): Promise<TelemetrySettingsState> {
    const parsed = telemetryConfigurationSchema
      .extend({dsn: telemetryDsnSchemaForEnvironment(this.environment).nullable()})
      .parse(configuration);
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.settingsPath), {recursive: true});
      const temporary = `${this.settingsPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(parsed), {
          flag: 'wx',
          mode: 0o600,
        });
        await rename(temporary, this.settingsPath);
        this.saved = parsed;
      } finally {
        await rm(temporary, {force: true});
      }

      return this.status();
    });
    this.writes = write.catch(() => {});
    return write;
  }
}
