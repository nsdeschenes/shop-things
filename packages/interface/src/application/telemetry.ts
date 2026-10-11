import * as Sentry from '@sentry/react';
import type {ClientObserver} from '@shop-things/contract/client';
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
import {isCancelledError} from '@tanstack/react-query';
import type {AnyRouter} from '@tanstack/react-router';

import {CustomerRequestError} from './customers';

const browserDiagnosticSpans = /^(?:browser|resource|ui|http|measure)(?:\.|$)/;

export function initializeRendererTelemetry(dsn: string | null): {
  observe: ClientObserver;
  captureException: (error: unknown) => void;
  instrumentRouter: (router: AnyRouter) => void;
} {
  const captured = new WeakSet<object>();
  let enabled = dsn !== null;
  if (enabled) {
    try {
      Sentry.init({
        dsn: dsn ?? undefined,
        spotlight: false,
        traceLifecycle: 'stream',
        defaultIntegrations: false,
        integrations: [],
        dataCollection: {...dataCollection, httpBodies: []},
        sendClientReports: false,
        maxBreadcrumbs: 0,
        tracesSampleRate: 1,
        tracePropagationTargets: [],
        ignoreSpans: [{op: browserDiagnosticSpans}],
        beforeSend(event) {
          return {
            type: undefined,
            sdk: {settings: {infer_ip: 'never' as const}},
            event_id: event.event_id ?? '',
            timestamp: event.timestamp ?? Date.now() / 1000,
            level: event.level ?? 'error',
            contexts: safeTrace(event.contexts?.trace),
            platform: 'javascript',
            tags: {process: 'renderer'},
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
            name: safeOperation(span.name.replace('/customers_', '/customers')),
            start_timestamp: span.start_timestamp,
            ...(span.end_timestamp !== undefined
              ? {end_timestamp: span.end_timestamp}
              : {}),
            status: span.status,
            is_segment: span.is_segment,
            attributes: {...safeAttributes(span.attributes), process: 'renderer'},
          };
        },
        beforeSendLog(log) {
          return logMessages.has(String(log.message))
            ? {
                ...log,
                attributes: {...safeAttributes(log.attributes), process: 'renderer'},
              }
            : null;
        },
        beforeSendMetric(metric) {
          return signalNames.has(metric.name)
            ? {
                ...metric,
                attributes: {...safeAttributes(metric.attributes), process: 'renderer'},
              }
            : null;
        },
      });
    } catch {
      enabled = false;
    }
  }

  function captureException(error: unknown) {
    if (!enabled || error instanceof CustomerRequestError || isCancelledError(error)) {
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

  if (enabled) {
    window.addEventListener('error', event => captureException(event.error));
    window.addEventListener('unhandledrejection', event =>
      captureException(event.reason)
    );
    window.addEventListener('pagehide', () => {
      void Sentry.flush(1000).catch(() => {});
    });
  }

  function observe(observation: Parameters<ClientObserver>[0]) {
    if (!enabled) {
      return;
    }

    try {
      const attributes = safeAttributes({
        action: observation.action,
        outcome: observation.outcome,
        code: observation.errorCode,
        process: 'renderer',
      });
      const span = Sentry.startInactiveSpan({
        name: observation.action,
        op: 'application.client',
        startTime: (Date.now() - observation.durationMs) / 1000,
      });
      try {
        Sentry.withActiveSpan(span, () => {
          if (observation.fault?.kind === 'transport') {
            captureException(observation.fault.error);
          } else if (observation.fault) {
            captureException(new Error('Malformed application response.'));
          }

          span.setStatus({code: observation.outcome === 'error' ? 2 : 1});
          Sentry.logger.info('Application action completed', attributes);
          Sentry.metrics.count('application.action.count', 1, {attributes});
          Sentry.metrics.distribution(
            'application.action.duration',
            observation.durationMs,
            {unit: 'millisecond', attributes}
          );
        });
      } finally {
        span.end();
      }
    } catch {}
  }

  function instrumentRouter(router: AnyRouter) {
    if (!enabled) {
      return;
    }

    try {
      Sentry.addIntegration(
        Sentry.tanstackRouterBrowserTracingIntegration(router, {
          traceFetch: false,
          traceXHR: false,
          enableHTTPTimings: false,
          enableLongTask: false,
          enableLongAnimationFrame: false,
          webVitals: {
            ignore: ['cls', 'inp', 'lcp'],
            softNavigations: false,
            bfcacheNavigations: false,
          },
          instrumentBfcacheRestore: false,
          detectRedirects: false,
          linkPreviousTrace: 'off',
        })
      );
    } catch {}
  }

  return {observe, captureException, instrumentRouter};
}
