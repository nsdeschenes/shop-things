import {expect, test} from 'vitest';

import {
  safeBrowserAttributes,
  safeBrowserSpanName,
  sanitizeErrorEvent,
} from '../src/monitoring.js';

test('error privacy preserves native identity, linked mechanisms and every frame', () => {
  const event = {
    event_id: 'a'.repeat(32),
    timestamp: 123,
    release: '1.0',
    sdk: {
      name: 'sentry.javascript.browser',
      version: '11.4.0',
      integrations: ['LinkedErrors'],
      settings: {infer_ip: 'auto' as const},
    },
    user: {email: 'PRIVATE_SENTINEL'},
    request: {url: 'PRIVATE_SENTINEL'},
    fingerprint: ['PRIVATE_SENTINEL'],
    message: 'PRIVATE_SENTINEL',
    contexts: {
      trace: {trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16)},
      private: {data: 'PRIVATE_SENTINEL'},
    },
    tags: {customerNumber: 12, email: 'PRIVATE_SENTINEL'},
    extra: {stock: 99},
    exception: {
      values: [
        {
          type: 'TypeError',
          value: 'PRIVATE_SENTINEL',
          mechanism: {
            type: 'auto.core.linked_errors',
            handled: true,
            exception_id: 0,
            parent_id: 1,
            source: 'PRIVATE_SENTINEL',
            data: {name: 'PRIVATE_SENTINEL'},
          },
          stacktrace: {
            frames: [
              {
                filename: '/private/src/telemetry.ts',
                lineno: 5,
                colno: 3,
                function: 'PRIVATE_SENTINEL',
                vars: {email: 'PRIVATE_SENTINEL'},
              },
              {
                filename: '/private/renderer/assets/chunk.js',
                lineno: 8,
                colno: 9,
                context_line: 'PRIVATE_SENTINEL',
              },
            ],
          },
        },
        {
          type: 'RangeError',
          value: 'PRIVATE_SENTINEL',
          mechanism: {
            type: 'auto.browser.global_handlers.onerror',
            handled: false,
            exception_id: 1,
          },
        },
      ],
    },
  };
  expect(sanitizeErrorEvent(event, 'renderer', 'development', {stock: 2})).toBe(event);
  expect(event).toEqual({
    event_id: 'a'.repeat(32),
    timestamp: 123,
    release: '1.0',
    sdk: {
      name: 'sentry.javascript.browser',
      version: '11.4.0',
      integrations: ['LinkedErrors'],
      settings: {infer_ip: 'never'},
    },
    environment: 'development',
    contexts: {trace: {trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16)}},
    tags: {stock: 2, process: 'renderer'},
    extra: {stock: 2},
    exception: {
      values: [
        {
          type: 'TypeError',
          value: 'Unexpected application failure.',
          mechanism: {
            type: 'auto.core.linked_errors',
            handled: true,
            exception_id: 0,
            parent_id: 1,
          },
          stacktrace: {
            frames: [
              {filename: 'app:///telemetry.js', lineno: 5, colno: 3, in_app: true},
              {filename: 'app:///renderer.js', lineno: 8, colno: 9, in_app: true},
            ],
          },
        },
        {
          type: 'RangeError',
          value: 'Unexpected application failure.',
          mechanism: {
            type: 'auto.browser.global_handlers.onerror',
            handled: false,
            exception_id: 1,
          },
        },
      ],
    },
  });
  expect(JSON.stringify(event)).not.toContain('PRIVATE_SENTINEL');
});

test('browser diagnostics retain finite measurements and genuine runtime user agent only', () => {
  const input = {
    'sentry.op': 'ui.webvital.lcp',
    'sentry.origin': 'auto.http.browser.lcp',
    'sentry.pageload.span_id': 'a'.repeat(16),
    'browser.web_vital.lcp.value': 243,
    'browser.web_vital.lcp.size': 12,
    'browser.web_vital.lcp.render_time': Number.POSITIVE_INFINITY,
    'browser.web_vital.lcp.element': 'PRIVATE_SENTINEL',
    'browser.web_vital.lcp.url': 'PRIVATE_SENTINEL',
    'user_agent.original': 'PRIVATE_SENTINEL',
    'browser.secret.value': 123,
    'code.file.path': 'PRIVATE_SENTINEL',
    'ui.component_name': 'PRIVATE_SENTINEL',
    constructor: 'PRIVATE_SENTINEL',
    toString: 'PRIVATE_SENTINEL',
  };
  expect(safeBrowserAttributes(input, 'actual browser UA')).toEqual({
    'sentry.op': 'ui.webvital.lcp',
    'sentry.origin': 'auto.http.browser.lcp',
    'sentry.pageload.span_id': 'a'.repeat(16),
    'browser.web_vital.lcp.value': 243,
    'browser.web_vital.lcp.size': 12,
    'user_agent.original': 'actual browser UA',
  });
  expect(safeBrowserSpanName('ui.webvital.lcp', 'PRIVATE_SENTINEL')).toBe(
    'Largest contentful paint'
  );
  expect(
    safeBrowserAttributes(
      {...input, 'sentry.op': 'application.client'},
      'actual browser UA'
    )
  ).toEqual({'sentry.op': 'application.client'});
});
