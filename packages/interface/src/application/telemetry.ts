import * as Sentry from '@sentry/react';
import type {TelemetryEnvironment, TelemetrySampling} from '@shop-things/contract';
import type {ClientObserver} from '@shop-things/contract/client';
import {
  dataCollection,
  safeAttributes,
  safeSignalAttributes,
  sanitizeErrorEvent,
  safeBrowserAttributes,
  safeBrowserSpanName,
  signalNames,
  logMessages,
  shouldSampleTelemetry,
  sanitizeLogMetricPayload,
} from '@shop-things/contract/monitoring';
import {isCancelledError} from '@tanstack/react-query';
import type {AnyRouter} from '@tanstack/react-router';
import type {ErrorInfo} from 'react';

import {CustomerRequestError} from './customers';

export function initializeRendererTelemetry(
  dsn: string | null,
  sampling: TelemetrySampling,
  environment: TelemetryEnvironment
): {
  observe: ClientObserver;
  captureException: (error: unknown) => void;
  reportReactError: (error: unknown, errorInfo: ErrorInfo) => void;
  instrumentRouter: (router: AnyRouter) => void;
} {
  const userAgent = navigator.userAgent;
  let enabled = dsn !== null;
  if (enabled) {
    try {
      Sentry.init({
        dsn: dsn ?? undefined,
        environment,
        spotlight: false,
        traceLifecycle: 'stream',
        defaultIntegrations: false,
        integrations: [
          Sentry.globalHandlersIntegration(),
          Sentry.dedupeIntegration(),
          Sentry.linkedErrorsIntegration(),
        ],
        dataCollection: {...dataCollection, httpBodies: []},
        sendClientReports: false,
        maxBreadcrumbs: 0,
        sampleRate: sampling.errors / 100,
        tracesSampleRate: sampling.traces / 100,
        tracePropagationTargets: [],
        beforeSend(event, hint) {
          if (
            hint.originalException instanceof CustomerRequestError ||
            isCancelledError(hint.originalException)
          ) {
            return null;
          }

          return sanitizeErrorEvent(
            event,
            'renderer',
            environment,
            hint.data?.actionAttributes
          );
        },
        beforeSendSpan(span) {
          span.name = safeBrowserSpanName(span.attributes['sentry.op'], span.name);
          span.attributes = {
            ...safeBrowserAttributes(span.attributes, userAgent),
            process: 'renderer',
            'sentry.environment': environment,
          };
          return span;
        },
        beforeSendLog(log) {
          return logMessages.has(String(log.message)) &&
            shouldSampleTelemetry(sampling.logs)
            ? {
                ...log,
                attributes: {
                  ...safeSignalAttributes(log.attributes),
                  process: 'renderer',
                },
              }
            : null;
        },
        beforeSendMetric(metric) {
          return signalNames.has(metric.name) && shouldSampleTelemetry(sampling.metrics)
            ? {
                ...metric,
                attributes: {
                  ...safeSignalAttributes(metric.attributes),
                  process: 'renderer',
                },
              }
            : null;
        },
      });
      // Streaming merges scope attributes before beforeSendSpan.
      Sentry.getClient()?.on('spanStart', span => {
        span.setAttributes(safeSignalAttributes(Sentry.spanToJSON(span).attributes));
      });
      Sentry.getClient()?.on('beforeEnvelope', ([, items]) => {
        for (const [header, payload] of items) {
          if (header.type === 'log' || header.type === 'trace_metric') {
            sanitizeLogMetricPayload(payload, environment);
          }
        }
      });
    } catch {
      enabled = false;
    }
  }

  function captureException(error: unknown, attributes: Record<string, unknown> = {}) {
    if (!enabled || error === null || error === undefined) {
      return;
    }

    try {
      Sentry.captureException(error, {
        data: {actionAttributes: safeAttributes(attributes)},
      });
    } catch {}
  }

  function observe(observation: Parameters<ClientObserver>[0]) {
    if (!enabled) {
      return;
    }

    try {
      const attributes = safeAttributes({
        ...observation.attributes,
        action: observation.action,
        outcome: observation.outcome,
        code: observation.errorCode,
        process: 'renderer',
      });
      const span = Sentry.startInactiveSpan({
        name: observation.action,
        op: 'application.client',
        attributes,
        startTime: (Date.now() - observation.durationMs) / 1000,
      });
      try {
        Sentry.withActiveSpan(span, () => {
          if (observation.fault?.kind === 'transport') {
            captureException(observation.fault.error, attributes);
          } else if (observation.fault) {
            captureException(new Error('Malformed application response.'), attributes);
          }

          span.setStatus({code: observation.outcome === 'error' ? 2 : 1});
          Sentry.logger.info(
            Sentry.logger.fmt`Application action ${observation.action} completed`,
            attributes
          );
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
          detectRedirects: false,
          linkPreviousTrace: 'off',
        })
      );
    } catch {}
  }

  const reportReactError = enabled
    ? Sentry.reactErrorHandler(error => console.error(error))
    : (error: unknown, _errorInfo: ErrorInfo) => console.error(error);

  return {observe, captureException, reportReactError, instrumentRouter};
}
