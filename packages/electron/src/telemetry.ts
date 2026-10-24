import {AsyncLocalStorage} from 'node:async_hooks';

import {SentryEffectTracer} from '@sentry/effect/server';
import * as Sentry from '@sentry/electron/main';
import {
  init as initializeTelemetry,
  dedupeIntegration,
  linkedErrorsIntegration,
} from '@sentry/node';
import type {ActionName} from '@shop-things/contract';
import {
  dataCollection,
  safeAttributes,
  safeSignalAttributes,
  sanitizeErrorEvent,
  signalNames,
  logMessages,
  shouldSampleTelemetry,
  sanitizeLogMetricPayload,
} from '@shop-things/contract/monitoring';
import * as Effect from 'effect/Effect';

import {createQuerySpans} from './querySpans.js';
import {FileTelemetrySettings} from './telemetrySettings.js';

export function createMainTelemetry(settings: FileTelemetrySettings, release: string) {
  let enabled = settings.startupDsn !== null;
  const actionContext = new AsyncLocalStorage<
    Record<string, string | number | boolean>
  >();
  const querySpans = createQuerySpans(settings.environment, () =>
    actionContext.getStore()
  );
  if (enabled) {
    try {
      process.env.SENTRY_USE_ENVIRONMENT = 'false';
      // Electron init installs SDK IPC outside the application's document authorization.
      initializeTelemetry({
        dsn: settings.startupDsn!,
        release,
        environment: settings.environment,
        spotlight: false,
        traceLifecycle: 'stream',
        debug: false,
        transport: Sentry.makeElectronTransport,
        shutdownTimeout: 1500,
        defaultIntegrations: false,
        integrations: [
          Sentry.onUncaughtExceptionIntegration(),
          Sentry.onUnhandledRejectionIntegration(),
          dedupeIntegration(),
          linkedErrorsIntegration(),
        ],
        dataCollection: {...dataCollection, httpBodies: []},
        includeServerName: false,
        sendClientReports: false,
        maxBreadcrumbs: 0,
        sampleRate: settings.startupSampling.errors / 100,
        tracesSampleRate: settings.startupSampling.traces / 100,
        tracePropagationTargets: [],
        beforeSend(event, hint) {
          return sanitizeErrorEvent(
            event,
            'main',
            settings.environment,
            hint.data?.actionAttributes
          );
        },
        beforeSendSpan: querySpans.project,
        beforeSendLog(log) {
          return logMessages.has(String(log.message)) &&
            shouldSampleTelemetry(settings.startupSampling.logs)
            ? {
                ...log,
                attributes: {
                  ...log.attributes,
                  ...safeSignalAttributes({
                    ...actionContext.getStore(),
                    ...log.attributes,
                  }),
                  process: 'main',
                },
              }
            : null;
        },
        beforeSendMetric(metric) {
          return signalNames.has(metric.name) &&
            shouldSampleTelemetry(settings.startupSampling.metrics)
            ? {
                ...metric,
                attributes: {
                  ...metric.attributes,
                  ...safeSignalAttributes({
                    ...actionContext.getStore(),
                    ...metric.attributes,
                  }),
                  process: 'main',
                },
              }
            : null;
        },
      });
      // Streaming merges scope attributes before beforeSendSpan.
      Sentry.getClient()?.on('spanStart', span => {
        span.setAttributes(
          safeSignalAttributes({
            ...actionContext.getStore(),
            ...Sentry.spanToJSON(span).attributes,
          })
        );
      });
      Sentry.getClient()?.on('beforeEnvelope', ([, items]) => {
        for (const [header, payload] of items) {
          if (header.type === 'span') {
            querySpans.sanitizeEnvelope(payload);
          } else if (header.type === 'log' || header.type === 'trace_metric') {
            sanitizeLogMetricPayload(payload, settings.environment, 'main');
          }
        }
      });
    } catch {
      enabled = false;
    }
  }

  function captureException(error: unknown, attributes: Record<string, unknown> = {}) {
    if (!enabled) {
      return;
    }

    try {
      const span = Sentry.getActiveSpan();
      Sentry.captureException(error, {
        data: {
          actionAttributes: safeAttributes({
            ...actionContext.getStore(),
            ...(span ? Sentry.spanToJSON(span).attributes : {}),
            ...attributes,
          }),
        },
      });
    } catch {}
  }

  function phase<T>(name: string, work: () => T): T {
    if (!enabled) {
      return work();
    }

    let started = false;
    let output: T;
    let applicationFailed = false;
    let applicationError: unknown;
    try {
      return Sentry.startSpan({name, op: 'application.phase'}, () => {
        started = true;
        try {
          output = work();
          return output;
        } catch (error) {
          applicationFailed = true;
          applicationError = error;
          throw error;
        }
      });
    } catch {
      if (!started) {
        return work();
      }

      if (applicationFailed) {
        throw applicationError;
      }

      return output!;
    }
  }

  function phaseEffect<A, E, R>(
    name: string,
    work: () => Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> {
    return Effect.suspend(() =>
      enabled
        ? Effect.suspend(work).pipe(
            Effect.withSpan(name, {attributes: {'sentry.op': 'application.phase'}}),
            Effect.withTracer(SentryEffectTracer)
          )
        : work()
    );
  }

  async function observeAction<T>(
    name: ActionName,
    work: () => Promise<T>,
    customerAttributes: Readonly<Record<string, string | number | boolean>> = {}
  ): Promise<T> {
    const actionAttributes = safeAttributes({...customerAttributes, action: name});
    return actionContext.run(actionAttributes, () =>
      phase(name, async () => {
        const start = performance.now();
        if (enabled) {
          try {
            Sentry.getActiveSpan()?.setAttributes(actionAttributes);
          } catch {}
        }

        let outcome = 'error';
        let code: unknown;
        try {
          const result = await work();
          if (typeof result === 'object' && result !== null && 'status' in result) {
            outcome = String(result.status);
            if (
              'error' in result &&
              typeof result.error === 'object' &&
              result.error !== null &&
              'code' in result.error
            ) {
              code = result.error.code;
            }
          }

          return result;
        } catch (error) {
          captureException(error, actionAttributes);
          throw error;
        } finally {
          if (enabled) {
            try {
              const attributes = safeAttributes({
                ...actionAttributes,
                outcome,
                code,
                process: 'main',
              });
              Sentry.getActiveSpan()?.setStatus({code: outcome === 'error' ? 2 : 1});
              Sentry.logger.info(
                Sentry.logger.fmt`Application action ${name} completed`,
                attributes
              );
              Sentry.metrics.count('application.action.count', 1, {attributes});
              Sentry.metrics.distribution(
                'application.action.duration',
                performance.now() - start,
                {unit: 'millisecond', attributes}
              );
            } catch {}
          }
        }
      })
    );
  }

  async function flush(timeoutMs = 1500) {
    if (!enabled) {
      return;
    }

    try {
      await Sentry.flush(timeoutMs);
    } catch {}
  }

  const databaseOptions = enabled ? {queryObserver: querySpans.observer} : {};
  return {captureException, observeAction, phase, phaseEffect, flush, databaseOptions};
}
