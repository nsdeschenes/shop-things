import * as Sentry from '@sentry/react';
import {CancelledError} from '@tanstack/react-query';

import {CustomerRequestError} from '../packages/interface/src/application/customers';
import {initializeRendererTelemetry} from '../packages/interface/src/application/telemetry';

export function installBrowserWork(resourceUrl: string) {
  window.addEventListener(
    'click',
    () => {
      void Sentry.startSpan(
        {name: 'application.operation', op: 'application.phase'},
        async () => {
          const until = performance.now() + 160;
          while (performance.now() < until) {}

          await new Promise<void>(resolve => {
            const observer = new PerformanceObserver(() => {
              observer.disconnect();
              resolve();
            });
            observer.observe({
              type: PerformanceObserver.supportedEntryTypes.includes(
                'long-animation-frame'
              )
                ? 'long-animation-frame'
                : 'longtask',
            });
            requestAnimationFrame(() => {
              const image = document.createElement('img');
              image.src = resourceUrl;
              image.id = 'PRIVATE_SENTINEL_resource_element';
              document.body.appendChild(image);
              const frameEnd = performance.now() + 100;
              while (performance.now() < frameEnd) {}
            });
            setTimeout(resolve, 1000);
          });
        }
      );
    },
    {once: true}
  );
}

export function captureFailures(dsn: string) {
  const monitoring = initializeRendererTelemetry(
    dsn,
    {errors: 100, traces: 100, logs: 100, metrics: 100},
    'development'
  );
  const first = new Error('PRIVATE_SENTINEL_first');
  const duplicate = Sentry.captureException(first);
  Sentry.captureException(first);
  setTimeout(() => {
    throw first;
  }, 0);
  const distinct = ['PRIVATE_SENTINEL_second', 'PRIVATE_SENTINEL_third'].map(message =>
    Sentry.captureException(new Error(message))
  );
  const linked = Sentry.captureException(
    new RangeError('PRIVATE_SENTINEL_parent', {
      cause: new TypeError('PRIVATE_SENTINEL_cause'),
    })
  );
  const expected = Sentry.captureException(
    new CustomerRequestError({
      code: 'VALIDATION',
      message: 'PRIVATE_SENTINEL_expected',
    })
  );
  const cancelled = Sentry.captureException(new CancelledError());
  monitoring.reportReactError(new SyntaxError('PRIVATE_SENTINEL_react'), {
    componentStack: '\n    at PRIVATE_SENTINEL_component (/PRIVATE_SENTINEL_path:1:2)',
  });
  setTimeout(() => {
    throw new URIError('PRIVATE_SENTINEL_global');
  }, 0);
  void Promise.reject('PRIVATE_SENTINEL_primitive_rejection');
  return {duplicate, distinct, linked, expected, cancelled};
}
