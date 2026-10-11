import * as Sentry from '@sentry/node';
import type {ActionName} from '@shop-things/contract';
import {
  dataCollection,
  safeTrace,
  safeAttributes,
  safeErrorType,
  safeFilename,
  safeOperation,
  signalNames,
  logMessages,
} from '@shop-things/contract/monitoring';

import {FileTelemetrySettings} from './telemetrySettings.js';

export function createMainTelemetry(settings: FileTelemetrySettings, release: string) {
  let enabled = settings.startupDsn !== null;
  const captured = new WeakSet<object>();
  if (enabled) {
    try {
      process.env.SENTRY_USE_ENVIRONMENT = 'false';
      Sentry.init({
        dsn: settings.startupDsn!,
        release,
        environment: 'production',
        spotlight: false,
        traceLifecycle: 'stream',
        debug: false,
        defaultIntegrations: false,
        integrations: [
          Sentry.onUncaughtExceptionIntegration(),
          Sentry.onUnhandledRejectionIntegration(),
        ],
        dataCollection: {...dataCollection, httpBodies: []},
        includeServerName: false,
        sendClientReports: false,
        maxBreadcrumbs: 0,
        tracesSampleRate: 1,
        tracePropagationTargets: [],
        beforeSend(event) {
          return {
            type: undefined,
            sdk: {settings: {infer_ip: 'never' as const}},
            event_id: event.event_id ?? '',
            timestamp: event.timestamp ?? Date.now() / 1000,
            level: event.level ?? 'error',
            contexts: safeTrace(event.contexts?.trace),
            platform: 'node',
            release,
            environment: 'production',
            tags: {process: 'main'},
            exception: {
              values:
                event.exception?.values?.slice(-1).map(exception => ({
                  mechanism: {
                    type: 'generic',
                    handled: exception.mechanism?.handled ?? true,
                  },
                  type: safeErrorType(exception.type),
                  value: 'Unexpected application failure.',
                  stacktrace: {
                    frames:
                      exception.stacktrace?.frames?.slice(-30).map(frame => ({
                        filename: safeFilename(frame.filename),
                        lineno: frame.lineno ?? 0,
                        colno: frame.colno ?? 0,
                        in_app: safeFilename(frame.filename) !== 'app:///external',
                      })) ?? [],
                  },
                })) ?? [],
            },
          };
        },
        beforeSendSpan(span) {
          return {
            trace_id: span.trace_id,
            span_id: span.span_id,
            ...(span.parent_span_id ? {parent_span_id: span.parent_span_id} : {}),
            name: safeOperation(span.name),
            start_timestamp: span.start_timestamp,
            ...(span.end_timestamp !== undefined
              ? {end_timestamp: span.end_timestamp}
              : {}),
            status: span.status,
            is_segment: span.is_segment,
            attributes: {...safeAttributes(span.attributes), process: 'main'},
          };
        },
        beforeSendLog(log) {
          return logMessages.has(String(log.message))
            ? {...log, attributes: {...safeAttributes(log.attributes), process: 'main'}}
            : null;
        },
        beforeSendMetric(metric) {
          return signalNames.has(metric.name)
            ? {
                ...metric,
                attributes: {...safeAttributes(metric.attributes), process: 'main'},
              }
            : null;
        },
      });
    } catch {
      enabled = false;
    }
  }

  function captureException(error: unknown) {
    if (!enabled) {
      return;
    }

    try {
      if (typeof error === 'object' && error !== null) {
        if (captured.has(error)) {
          return;
        }

        captured.add(error);
      }

      Sentry.captureException(error);
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

  async function observeAction<T>(name: ActionName, work: () => Promise<T>): Promise<T> {
    return phase(name, async () => {
      const start = performance.now();
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
      } finally {
        if (enabled) {
          try {
            const attributes = safeAttributes({
              action: name,
              outcome,
              code,
              process: 'main',
            });
            Sentry.getActiveSpan()?.setStatus({code: outcome === 'error' ? 2 : 1});
            Sentry.logger.info('Application action completed', attributes);
            Sentry.metrics.count('application.action.count', 1, {attributes});
            Sentry.metrics.distribution(
              'application.action.duration',
              performance.now() - start,
              {unit: 'millisecond', attributes}
            );
          } catch {}
        }
      }
    });
  }

  async function flush(timeoutMs = 1500) {
    if (!enabled) {
      return;
    }

    try {
      await Sentry.flush(timeoutMs);
    } catch {}
  }

  return {captureException, observeAction, phase, flush};
}
