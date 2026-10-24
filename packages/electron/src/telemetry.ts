import {AsyncLocalStorage} from 'node:async_hooks';

import {
  init as initializeTelemetry,
  SentryEffectLogger,
  SentryEffectTracer,
} from '@sentry/effect/server';
import * as Sentry from '@sentry/electron/main';
import {dedupeIntegration, linkedErrorsIntegration} from '@sentry/node';
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
import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  Logger,
  Metric,
  References,
  Tracer,
} from 'effect';

import {native, originalCause, runBoundary} from './effectBoundary.js';
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
  const logger = Logger.make(options => {
    const messages = Array.isArray(options.message) ? options.message : [options.message];
    if (
      messages.length !== 1 ||
      typeof messages[0] !== 'string' ||
      !logMessages.has(messages[0])
    ) {
      return;
    }

    // The SDK logger omits Effect annotations. Carry only approved fields into its send hook.
    const annotations = safeAttributes(
      options.fiber.getRef(References.CurrentLogAnnotations)
    );
    try {
      actionContext.run(
        {...annotations, ...safeSignalAttributes(actionContext.getStore())},
        () => SentryEffectLogger.log(options)
      );
    } catch {}
  });
  const tracerLayer = Layer.succeed(Tracer.Tracer, SentryEffectTracer);
  const signalLayer = Layer.mergeAll(
    Logger.layer([logger]),
    Layer.effect(
      Metric.MetricRegistry,
      Effect.acquireRelease(
        Effect.sync((): Metric.MetricRegistry => new Map()),
        registry =>
          Effect.sync(() => exportMetrics(registry)).pipe(
            Effect.catchCause(() => Effect.void)
          )
      )
    )
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
          const action = actionContext.getStore()?.action;
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
                  ...(typeof action === 'string' &&
                  log.message === `Application action ${action} completed`
                    ? {
                        'sentry.message.template': 'Application action %s completed',
                        'sentry.message.parameter.0': action,
                      }
                    : {}),
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
            Effect.provide(Layer.fresh(signalLayer)),
            Effect.withSpan(name, {attributes: {'sentry.op': 'application.phase'}}),
            Effect.provide(tracerLayer)
          )
        : work()
    );
  }

  async function observeAction<T>(
    name: ActionName,
    work: () => Promise<T>,
    customerAttributes: Readonly<Record<string, string | number | boolean>> = {}
  ): Promise<T> {
    if (!enabled) {
      return work();
    }

    const actionAttributes = safeAttributes({...customerAttributes, action: name});
    return actionContext.run(actionAttributes, () =>
      phase(name, () =>
        runBoundary(
          Effect.gen(function* () {
            const start = yield* Clock.monotonicTimeNanos;
            yield* Effect.sync(() => {
              try {
                Sentry.getActiveSpan()?.setAttributes(actionAttributes);
              } catch {}
            });
            return yield* native(work).pipe(
              Effect.onExit(exit =>
                recordCompletion(name, actionAttributes, start, exit).pipe(
                  Effect.catchCause(() => Effect.void)
                )
              )
            );
          }).pipe(Effect.provide(Layer.mergeAll(tracerLayer, signalLayer)))
        )
      )
    );
  }

  function recordCompletion(
    name: ActionName,
    actionAttributes: Record<string, string | number | boolean>,
    start: bigint,
    exit: Exit.Exit<unknown, unknown>
  ) {
    return Effect.gen(function* () {
      const elapsed = Number((yield* Clock.monotonicTimeNanos) - start) / 1_000_000;
      let outcome = 'error';
      let code: unknown;
      if (Exit.isSuccess(exit)) {
        const result = exit.value;
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
      } else if (!Cause.hasInterruptsOnly(exit.cause)) {
        captureException(originalCause(exit.cause), actionAttributes);
      }

      const attributes = safeAttributes({
        ...actionAttributes,
        outcome,
        code,
        process: 'main',
      });
      yield* Effect.sync(() =>
        Sentry.getActiveSpan()?.setStatus({code: outcome === 'error' ? 2 : 1})
      );
      yield* Effect.logInfo(`Application action ${name} completed`).pipe(
        Effect.annotateLogs(attributes)
      );
      yield* recordActionMetrics(elapsed, attributes);
    });
  }

  function recordActionMetrics(
    duration: number,
    attributes: Record<string, string | number | boolean>
  ) {
    const count = Metric.counter('application.action.count');
    const elapsed = Metric.histogram('application.action.duration', {boundaries: []});
    return Effect.gen(function* () {
      yield* Metric.update(count, 1);
      yield* Metric.update(elapsed, duration);
    }).pipe(
      Effect.provideService(
        Metric.CurrentMetricAttributes,
        Object.fromEntries(
          Object.entries(attributes)
            .filter(([key]) => ['action', 'outcome', 'code', 'process'].includes(key))
            .map(([key, value]) => [key, String(value)])
        )
      )
    );
  }

  function exportMetrics(registry: Metric.MetricRegistry) {
    if (!enabled) {
      return;
    }

    // Scoped registries export once before their span ends, including failures and shutdown.
    // The SDK's periodic global exporter loses individual durations and has no final export.
    for (const metric of Metric.snapshotUnsafe(
      Context.make(Metric.MetricRegistry, registry)
    )) {
      const attributes = safeAttributes({
        ...metric.attributes,
        ...safeSignalAttributes(actionContext.getStore()),
      });
      try {
        if (metric.id === 'application.action.count' && metric.type === 'Counter') {
          Sentry.metrics.count(metric.id, Number(metric.state.count), {attributes});
        } else if (
          metric.id === 'application.action.duration' &&
          metric.type === 'Histogram' &&
          metric.state.count === 1
        ) {
          // Each action records exactly one duration in its private registry.
          Sentry.metrics.distribution(metric.id, metric.state.sum, {
            unit: 'millisecond',
            attributes,
          });
        }
      } catch {}
    }
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
