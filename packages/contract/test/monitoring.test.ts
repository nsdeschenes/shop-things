import {expect, test} from 'vitest';

import {scrubBrowserSpan, sanitizeErrorEvent} from '../src/monitoring.js';

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
      customer: {email: 'PRIVATE_SENTINEL'},
      future_runtime: {version: 'next', enabled: true},
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
                function: 'nativeFunction',
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
    contexts: {
      trace: {trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16)},
      future_runtime: {version: 'next', enabled: true},
    },
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
              {
                filename: 'app:///telemetry.js',
                lineno: 5,
                colno: 3,
                function: 'nativeFunction',
              },
              {filename: 'app:///renderer.js', lineno: 8, colno: 9},
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

test('browser diagnostics preserve future SDK names, operations and measurements', () => {
  const attributes = {
    'sentry.op': 'ui.future.vital',
    'sentry.origin': 'auto.future.browser',
    'sentry.pageload.span_id': 'a'.repeat(16),
    'browser.web_vital.future.value': 243,
    'browser.future.status': 'new SDK enum',
    'browser.secret.value': 123,
    'browser.future.id': 'native SDK ID',
    'code.function.name': 'nativeFunction',
    'browser.web_vital.lcp.element': 'PRIVATE_SENTINEL',
    'browser.web_vital.lcp.id': 'PRIVATE_SENTINEL',
    'browser.web_vital.lcp.url': 'PRIVATE_SENTINEL',
    'browser.web_vital.inp.target': 'PRIVATE_SENTINEL',
    'url.path.parameter.customerId': 'PRIVATE_SENTINEL',
    'params.customerId': 'PRIVATE_SENTINEL',
    'browser.web_vital.cls.source.1': 'PRIVATE_SENTINEL',
    'code.file.path': 'PRIVATE_SENTINEL',
    'ui.component_name': 'PRIVATE_SENTINEL',
    email: 'PRIVATE_SENTINEL',
    'user.email': 'PRIVATE_SENTINEL',
    'user.id': 'PRIVATE_SENTINEL',
    'sentry.message.template': 'PRIVATE_SENTINEL',
    'sentry.message.parameter.0': 'PRIVATE_SENTINEL',
    'db.statement': 'PRIVATE_SENTINEL',
    stock: 'null',
    'user_agent.original': 'PRIVATE_SENTINEL',
  };
  const span = {name: 'Native SDK diagnostic', attributes, future_metadata: true};
  expect(scrubBrowserSpan(span, 'actual browser UA')).toBe(span);
  expect(span).toEqual({
    name: 'Native SDK diagnostic',
    future_metadata: true,
    attributes: {
      'sentry.op': 'ui.future.vital',
      'sentry.origin': 'auto.future.browser',
      'sentry.pageload.span_id': 'a'.repeat(16),
      'browser.web_vital.future.value': 243,
      'browser.future.status': 'new SDK enum',
      'browser.secret.value': 123,
      'browser.future.id': 'native SDK ID',
      'code.function.name': 'nativeFunction',
      'user_agent.original': 'actual browser UA',
    },
  });
  expect(
    scrubBrowserSpan({name: '/customers_/$customerId', attributes: {}}, 'UA').name
  ).toBe('/customers_/$customerId');
  expect(
    scrubBrowserSpan({name: 'http://host/PRIVATE_SENTINEL', attributes: {}}, 'UA').name
  ).toBe('[Filtered]');
  expect(
    scrubBrowserSpan(
      {name: 'CustomerEditor', attributes: {'ui.component_name': 'CustomerEditor'}},
      'UA'
    ).name
  ).toBe('CustomerEditor');
});

test('error privacy preserves future exception identities, graph metadata and frame fields', () => {
  const event = {
    future_metadata: {enabled: true},
    debug_meta: {
      images: [
        {
          type: 'sourcemap',
          code_file: '/PRIVATE_SENTINEL/bundle.js',
          debug_id: 'native-debug-id',
        },
      ],
    },
    modules: {'/PRIVATE_SENTINEL/module.js': '1.0', '@sdk/module': '2.0'},
    threads: {
      values: [
        {
          id: 7,
          stacktrace: {
            frames: [
              {
                filename: '/PRIVATE_SENTINEL/thread.js',
                function: 'nativeThread',
                vars: {secret: 'PRIVATE_SENTINEL'},
              },
            ],
          },
        },
      ],
    },
    contexts: {runtime: {name: 'future SDK runtime', future: 42}},
    exception: {
      values: [
        {
          type: 'NativeFutureError',
          value: 'PRIVATE_SENTINEL',
          future: 'native exception metadata',
          mechanism: {
            type: 'auto.future.integration',
            exception_id: 37,
            parent_id: 99,
            future: 'native mechanism metadata',
            source: 'PRIVATE_SENTINEL',
            data: {secret: 'PRIVATE_SENTINEL'},
          },
          stacktrace: {
            frames: [
              {
                filename: '/private/src/telemetry.ts',
                abs_path: '/private/src/telemetry.ts',
                function: 'nativeFunction',
                lineno: 12,
                colno: 7,
                in_app: false,
                future: true,
                vars: {secret: 'PRIVATE_SENTINEL'},
                pre_context: ['PRIVATE_SENTINEL'],
              },
            ],
          },
        },
      ],
    },
  };
  sanitizeErrorEvent(event, 'main', 'production');
  expect(event.future_metadata).toEqual({enabled: true});
  expect(event.debug_meta.images).toEqual([
    {type: 'sourcemap', code_file: 'app:///external', debug_id: 'native-debug-id'},
  ]);
  expect(event.modules).toEqual({'@sdk/module': '2.0'});
  expect(event.threads.values).toEqual([
    {
      id: 7,
      stacktrace: {frames: [{filename: 'app:///external', function: 'nativeThread'}]},
    },
  ]);
  expect(event.contexts.runtime).toEqual({name: 'future SDK runtime', future: 42});
  expect(event.exception.values[0]).toEqual({
    type: 'NativeFutureError',
    value: 'Unexpected application failure.',
    future: 'native exception metadata',
    mechanism: {
      type: 'auto.future.integration',
      exception_id: 37,
      parent_id: 99,
      future: 'native mechanism metadata',
    },
    stacktrace: {
      frames: [
        {
          filename: 'app:///telemetry.js',
          abs_path: 'app:///telemetry.js',
          function: 'nativeFunction',
          lineno: 12,
          colno: 7,
          in_app: false,
          future: true,
        },
      ],
    },
  });
  expect(JSON.stringify(event)).not.toContain('PRIVATE_SENTINEL');
});
