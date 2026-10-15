import {expect, test} from 'vitest';

import {scrubBrowserSpan, sanitizeErrorEvent} from '../src/monitoring.js';

test('error privacy preserves native diagnostics and source identity with trusted customer attributes', () => {
  const event = {
    event_id: 'a'.repeat(32),
    future_metadata: {enabled: true},
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
    message: 'PRIVATE_SENTINEL',
    fingerprint: ['customer-editor', 'linked-failure'],
    transaction: '/customers/$customerId',
    contexts: {
      trace: {trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16)},
      customer: {email: 'PRIVATE_SENTINEL'},
      future_runtime: {version: 'next', enabled: true},
    },
    tags: {customerNumber: 12, email: 'PRIVATE_SENTINEL', diagnostic: 'native-tag'},
    extra: {stock: 99, donate: true, diagnostic: 'native-extra'},
    exception: {
      values: [
        {
          type: 'TypeError',
          future: 'native exception metadata',
          value: 'PRIVATE_SENTINEL',
          mechanism: {
            type: 'auto.core.linked_errors',
            handled: true,
            exception_id: 0,
            parent_id: 1,
            future: 'native mechanism metadata',
            source: 'cause',
            data: {name: 'TypeError', code: 'MODULE_NOT_FOUND'},
          },
          stacktrace: {
            frames: [
              {
                filename: '/home/PRIVATE_SENTINEL/project/src/UnlistedFeature.ts',
                abs_path: 'file:///home/PRIVATE_SENTINEL/project/src/UnlistedFeature.ts',
                lineno: 5,
                colno: 3,
                function: 'nativeFunction',
                vars: {email: 'PRIVATE_SENTINEL'},
                pre_context: ['function nativeFunction() {'],
                context_line: '  throw new TypeError();',
                post_context: ['}'],
                source: 'nativeFunction',
              },
            ],
          },
        },
      ],
    },
  };
  expect(sanitizeErrorEvent(event, 'renderer', 'development', {stock: 2})).toBe(event);
  expect(event).toEqual({
    event_id: 'a'.repeat(32),
    future_metadata: {enabled: true},
    timestamp: 123,
    release: '1.0',
    sdk: {
      name: 'sentry.javascript.browser',
      version: '11.4.0',
      integrations: ['LinkedErrors'],
      settings: {infer_ip: 'never'},
    },
    environment: 'development',
    fingerprint: ['customer-editor', 'linked-failure'],
    transaction: '/customers/$customerId',
    contexts: {
      trace: {trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16)},
      future_runtime: {version: 'next', enabled: true},
    },
    tags: {stock: 2, diagnostic: 'native-tag', process: 'renderer'},
    extra: {stock: 2, diagnostic: 'native-extra'},
    exception: {
      values: [
        {
          type: 'TypeError',
          future: 'native exception metadata',
          value: 'Unexpected application failure.',
          mechanism: {
            type: 'auto.core.linked_errors',
            handled: true,
            exception_id: 0,
            parent_id: 1,
            future: 'native mechanism metadata',
            source: 'cause',
            data: {name: 'TypeError', code: 'MODULE_NOT_FOUND'},
          },
          stacktrace: {
            frames: [
              {
                filename: '/home/[Filtered]/project/src/UnlistedFeature.ts',
                abs_path: 'file:///home/[Filtered]/project/src/UnlistedFeature.ts',
                lineno: 5,
                colno: 3,
                function: 'nativeFunction',
                pre_context: ['function nativeFunction() {'],
                context_line: '  throw new TypeError();',
                post_context: ['}'],
                source: 'nativeFunction',
              },
            ],
          },
        },
      ],
    },
  });
  expect(JSON.stringify(event)).not.toContain('PRIVATE_SENTINEL');
});

test('browser diagnostics retain native metadata and static identities while excluding private carriers', () => {
  const attributes = {
    'sentry.op': 'ui.future.vital',
    'browser.web_vital.future.value': 243,
    'browser.future.status': 'new SDK enum',
    'code.function.name': 'nativeFunction',
    'code.file.path': '/Users/PRIVATE_SENTINEL/project/renderer/assets/chunk-ABC123.js',
    'code.filepath': 'src/UnlistedFeature.ts',
    'browser.script.source_url':
      'https://cdn.example.com/telemetry-work.js?private=PRIVATE_SENTINEL',
    'browser.script.invoker_type': 'user-callback',
    'ui.component_name': 'CustomerEditor',
    'server.address': 'cdn.example.com',
    'url.scheme': 'https',
    'url.domain': 'cdn.example.com',
    'url.future.metadata': 'native diagnostic',
    'url.template': '/customers/$customerId',
    'db.system.name': 'sqlite',
    'db.operation.name': 'SELECT',
    'db.collection.name': 'customers',
    'db.query.method': 'all',
    'user_agent.original': 'actual browser UA',
    'browser.web_vital.lcp.element': 'PRIVATE_SENTINEL',
    'browser.web_vital.inp.target': 'PRIVATE_SENTINEL',
    'browser.web_vital.cls.source.1': 'PRIVATE_SENTINEL',
    'browser.script.invoker': 'PRIVATE_SENTINEL',
    'url.full': 'PRIVATE_SENTINEL',
    'url.path.parameter.customerId': 'PRIVATE_SENTINEL',
    'url.query': 'PRIVATE_SENTINEL',
    'url.fragment': 'PRIVATE_SENTINEL',
    'params.customerId': 'PRIVATE_SENTINEL',
    'db.statement': 'PRIVATE_SENTINEL',
    'db.query.text': 'PRIVATE_SENTINEL',
    'db.query.parameter.1': 'PRIVATE_SENTINEL',
    email: 'PRIVATE_SENTINEL',
    'user.email': 'PRIVATE_SENTINEL',
    stock: 'null',
  };
  const span = {name: attributes['code.file.path'], attributes, future_metadata: true};
  expect(scrubBrowserSpan(span)).toBe(span);
  expect(span).toEqual({
    name: '/Users/[Filtered]/project/renderer/assets/chunk-ABC123.js',
    future_metadata: true,
    attributes: {
      'sentry.op': 'ui.future.vital',
      'browser.web_vital.future.value': 243,
      'browser.future.status': 'new SDK enum',
      'code.function.name': 'nativeFunction',
      'code.file.path': '/Users/[Filtered]/project/renderer/assets/chunk-ABC123.js',
      'code.filepath': 'src/UnlistedFeature.ts',
      'browser.script.source_url': 'https://cdn.example.com/telemetry-work.js',
      'browser.script.invoker_type': 'user-callback',
      'ui.component_name': 'CustomerEditor',
      'server.address': 'cdn.example.com',
      'url.scheme': 'https',
      'url.domain': 'cdn.example.com',
      'url.future.metadata': 'native diagnostic',
      'url.template': '/customers/$customerId',
      'db.system.name': 'sqlite',
      'db.operation.name': 'SELECT',
      'db.collection.name': 'customers',
      'db.query.method': 'all',
      'user_agent.original': 'actual browser UA',
    },
  });
  expect(JSON.stringify(span)).not.toContain('PRIVATE_SENTINEL');
  expect(
    scrubBrowserSpan({
      name: 'https://cdn.example.com/asset.js?private=secret',
      attributes: {},
    }).name
  ).toBe('https://cdn.example.com/asset.js');
  expect(
    scrubBrowserSpan({
      name: 'PRIVATE_SENTINEL',
      attributes: {'browser.web_vital.lcp.element': 'PRIVATE_SENTINEL'},
    }).name
  ).toBe('[Filtered]');
});

test('native source maps, modules, threads and unknown absolute source paths survive', () => {
  const event = {
    debug_meta: {
      images: [
        {
          type: 'sourcemap',
          code_file: '/home/PRIVATE_SENTINEL/project/renderer/assets/chunk-ABC123.js',
          debug_file:
            'C:\\Users\\PRIVATE_SENTINEL\\project\\dist\\UnlistedFeature.js.map',
          debug_id: 'native-debug-id',
        },
      ],
    },
    modules: {
      '/Users/PRIVATE_SENTINEL/project/node_modules/other/index.js': '1.0',
      '/opt/app/unlisted-module.js': '2.0',
      '@sdk/module': '3.0',
    },
    threads: {
      values: [
        {
          id: 7,
          stacktrace: {
            frames: [
              {
                filename: '/opt/app/unlisted-thread.js',
                function: 'nativeThread',
                future: true,
                vars: {email: 'PRIVATE_SENTINEL'},
              },
            ],
          },
        },
      ],
    },
  };
  sanitizeErrorEvent(event, 'main', 'production');
  expect(event.debug_meta.images).toEqual([
    {
      type: 'sourcemap',
      code_file: '/home/[Filtered]/project/renderer/assets/chunk-ABC123.js',
      debug_file: 'C:/Users/[Filtered]/project/dist/UnlistedFeature.js.map',
      debug_id: 'native-debug-id',
    },
  ]);
  expect(event.modules).toEqual({
    '/Users/[Filtered]/project/node_modules/other/index.js': '1.0',
    '/opt/app/unlisted-module.js': '2.0',
    '@sdk/module': '3.0',
  });
  expect(event.threads.values).toEqual([
    {
      id: 7,
      stacktrace: {
        frames: [
          {
            filename: '/opt/app/unlisted-thread.js',
            function: 'nativeThread',
            future: true,
          },
        ],
      },
    },
  ]);
  expect(JSON.stringify(event)).not.toContain('PRIVATE_SENTINEL');
});
