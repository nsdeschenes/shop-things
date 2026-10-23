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
import * as Effect from 'effect/Effect';
import * as Semaphore from 'effect/Semaphore';

export class FileTelemetrySettings {
  readonly startupDsn: string | null;
  readonly startupSampling: Readonly<TelemetrySampling>;
  private saved: TelemetryConfiguration;
  private readonly writes = Semaphore.makeUnsafe(1);

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
    return Effect.runPromise(
      this.writes.withPermit(
        Effect.gen({self: this}, function* () {
          yield* Effect.tryPromise({
            try: () => mkdir(dirname(this.settingsPath), {recursive: true}),
            catch: error => error,
          });
          const temporary = `${this.settingsPath}.${randomUUID()}.tmp`;
          const written = yield* Effect.exit(
            Effect.gen({self: this}, function* () {
              yield* Effect.tryPromise({
                try: () =>
                  writeFile(temporary, JSON.stringify(parsed), {
                    flag: 'wx',
                    mode: 0o600,
                  }),
                catch: error => error,
              });
              yield* Effect.tryPromise({
                try: () => rename(temporary, this.settingsPath),
                catch: error => error,
              });
              this.saved = parsed;
            })
          );
          yield* Effect.tryPromise({
            try: () => rm(temporary, {force: true}),
            catch: error => error,
          });
          yield* written;
          return this.status();
        }).pipe(Effect.uninterruptible)
      )
    );
  }
}
