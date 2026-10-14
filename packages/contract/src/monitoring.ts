import type {ActionName, TelemetryEnvironment} from './index.js';
import {
  actions,
  customerSchema,
  createCustomerInputSchema,
  errorCodeSchema,
  telemetryEnvironmentSchema,
} from './schemas.js';

const operationNames = new Set([
  ...Object.keys(actions),
  'application.startup',
  'application.shutdown',
  'application.reload',
  'database.query',
  'database.createDatabase',
  'database.openExistingDatabase',
  'database.listCustomers',
  'database.getCustomer',
  'database.createCustomer',
  'database.updateCustomer',
  'database.deleteCustomer',
  'database.importCustomerBatch',
  'database.backupDatabase',
  'import.read',
  'import.match',
  'export.write',
  'restore.copy',
  '/',
  '/settings',
  '/settings/database',
  '/settings/monitoring',
  '/customers',
  '/customers/$customerId',
  '/customers/import',
  '/customers/new',
]);
const errorTypes = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'DatabaseError',
]);
const appFiles =
  /\/(?:src|dist)\/(main|telemetry|actionService|ipc|settings|telemetrySettings|files|customerImport|importMatches|document|draftCoordinator|nativeDialogs|customerImportNumbers|ipcWire|preload|preloadBridge)\.(?:js|ts)$/;
const databaseFiles =
  /\/(?:packages\/db|node_modules\/@shop-things\/db)\/(?:src|dist)\/(index|customers|schema|relations|lifecycle)\.(?:js|ts)$/;
const traceId = /^[a-f0-9]{32}$/;
const spanId = /^[a-f0-9]{16}$/;
const rendererFile = /\/renderer\/assets\/[^/?#]+\.js$/;
const actionLogTemplate = 'Application action %s completed';

export const dataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  frameContextLines: 0,
  graphQL: {document: false, variables: false},
  genAI: {inputs: false, outputs: false},
} as const;

export function safeOperation(value: unknown): string {
  return typeof value === 'string' && operationNames.has(value)
    ? value
    : 'application.operation';
}

export function safeAttributes(attributes: Record<string, unknown> = {}) {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'sentry.message.template' && value === actionLogTemplate) {
      safe[key] = value;
    } else if (
      key === 'sentry.message.parameter.0' &&
      typeof value === 'string' &&
      Object.hasOwn(actions, value)
    ) {
      safe[key] = value;
    } else if (key === 'sentry.environment') {
      const parsed = telemetryEnvironmentSchema.safeParse(value);
      if (parsed.success) {
        safe[key] = parsed.data;
      }
    } else if (
      key === 'sentry.trace.parent_span_id' &&
      typeof value === 'string' &&
      spanId.test(value)
    ) {
      safe[key] = value;
    } else if (
      key === 'sentry.op' &&
      ['application.phase', 'application.client', 'navigation', 'pageload'].includes(
        String(value)
      )
    ) {
      safe[key] = String(value);
    } else if (key === 'action' || key === 'operation' || key === 'route') {
      safe[key] = safeOperation(value);
    } else if (key === 'process' && (value === 'main' || value === 'renderer')) {
      safe[key] = value;
    } else if (
      key === 'outcome' &&
      ['success', 'cancelled', 'error'].includes(String(value))
    ) {
      safe[key] = String(value);
    } else if (
      key === 'code' &&
      errorCodeSchema.safeParse(value).success &&
      typeof value === 'string'
    ) {
      safe[key] = value;
    } else if (
      key === 'customerNumber' ||
      key === 'stock' ||
      key === 'previousBalance' ||
      key === 'balance' ||
      key === 'donate'
    ) {
      const parsed = customerSchema.shape[key].safeParse(value);
      if (parsed.success) {
        safe[key] = parsed.data;
      }
    } else if (
      key === 'sentry.timestamp.sequence' &&
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      safe[key] = value;
    } else if (
      key === 'duration_ms' &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0
    ) {
      safe[key] = value;
    }
  }

  return safe;
}

export function customerArgumentAttributes(action: ActionName, args: unknown) {
  if (typeof args !== 'object' || args === null) {
    return {};
  }

  const values =
    action === 'customers.create' && 'values' in args
      ? args.values
      : action === 'customers.update' && 'changes' in args
        ? args.changes
        : null;
  if (typeof values !== 'object' || values === null) {
    return {};
  }

  const attributes: Record<string, unknown> = {};
  for (const key of [
    'customerNumber',
    'stock',
    'previousBalance',
    'balance',
    'donate',
  ] as const) {
    if (key in values) {
      attributes[key] = Reflect.get(values, key);
    }
  }

  for (const key of ['balance', 'previousBalance'] as const) {
    const parsed = createCustomerInputSchema.shape[key].safeParse(attributes[key]);
    if (parsed.success) {
      const [whole, fraction = ''] = parsed.data.split('.');
      attributes[key] = `${whole}.${fraction.padEnd(2, '0')}`;
    }
  }

  return safeAttributes(attributes);
}

export function safeErrorType(value: unknown) {
  return typeof value === 'string' && errorTypes.has(value) ? value : 'Error';
}

export function safeSignalAttributes(attributes: Record<string, unknown> = {}) {
  // Explicit placeholders block SDK scope values for omitted customer fields.
  // Span and final envelope filters reject these invalid domain values.
  return {
    customerNumber: 'null',
    stock: 'null',
    previousBalance: 'null',
    balance: 'null',
    donate: 'null',
    ...safeAttributes(attributes),
  };
}

export function safeFilename(value: unknown): string {
  if (typeof value !== 'string') {
    return 'app:///external';
  }

  const normalized = value.replaceAll('\\', '/');
  const match = normalized.match(appFiles);
  if (match) {
    return `app:///${match[1]}.js`;
  }

  const databaseMatch = normalized.match(databaseFiles);
  if (databaseMatch) {
    return `app:///db/${databaseMatch[1]}.js`;
  }

  if (rendererFile.test(normalized)) {
    return 'app:///renderer.js';
  }

  return 'app:///external';
}

export const signalNames = new Set([
  'application.action.count',
  'application.action.duration',
]);
export const logMessages = new Set([
  ...Object.keys(actions).map(action => `Application action ${action} completed`),
  'Application lifecycle completed',
]);

export function safeTrace(trace: {trace_id?: unknown; span_id?: unknown} | undefined) {
  return trace &&
    typeof trace.trace_id === 'string' &&
    traceId.test(trace.trace_id) &&
    typeof trace.span_id === 'string' &&
    spanId.test(trace.span_id)
    ? {trace: {trace_id: trace.trace_id, span_id: trace.span_id}}
    : {};
}

const errorEventFields = new Set([
  'event_id',
  'timestamp',
  'level',
  'platform',
  'release',
  'dist',
  'sdk',
  'environment',
  'contexts',
  'tags',
  'extra',
  'exception',
]);
const mechanismTypes = new Set([
  'generic',
  'chained',
  'auto.core.linked_errors',
  'auto.browser.global_handlers.onerror',
  'auto.browser.global_handlers.onunhandledrejection',
  'auto.node.onunhandledrejection',
  'auto.function.react.error_handler',
]);

interface ErrorEvent {
  sdk?: {settings?: {infer_ip?: 'auto' | 'never'}};
  environment?: string;
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: {trace?: {trace_id?: string; span_id?: string}};
  exception?: {
    values?: {
      type?: string;
      value?: string;
      mechanism?: {
        type: string;
        handled?: boolean;
        synthetic?: boolean;
        is_exception_group?: boolean;
        exception_id?: number;
        parent_id?: number;
      };
      stacktrace?: {
        frames?: {
          filename?: string;
          lineno?: number;
          colno?: number;
          in_app?: boolean;
        }[];
      };
    }[];
  };
}

function retainFields(value: object, fields: ReadonlySet<string>) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) {
      Reflect.deleteProperty(value, key);
    }
  }
}

export function sanitizeErrorEvent<T extends ErrorEvent>(
  event: T,
  process: 'main' | 'renderer',
  environment: TelemetryEnvironment,
  attributes: Record<string, unknown> = {}
): T {
  retainFields(event, errorEventFields);
  event.sdk = {...event.sdk, settings: {...event.sdk?.settings, infer_ip: 'never'}};
  event.environment = environment;
  event.contexts = safeTrace(event.contexts?.trace);
  event.extra = safeAttributes(attributes);
  event.tags = {...event.extra, process};
  if (event.exception) {
    retainFields(event.exception, new Set(['values']));
  }

  for (const exception of event.exception?.values ?? []) {
    retainFields(exception, new Set(['type', 'value', 'mechanism', 'stacktrace']));
    exception.type = safeErrorType(exception.type);
    exception.value = 'Unexpected application failure.';
    const mechanism = exception.mechanism;
    if (mechanism) {
      retainFields(
        mechanism,
        new Set([
          'type',
          'handled',
          'synthetic',
          'is_exception_group',
          'exception_id',
          'parent_id',
        ])
      );
      if (!mechanismTypes.has(mechanism.type)) {
        mechanism.type = 'generic';
      }

      for (const key of ['handled', 'synthetic', 'is_exception_group'] as const) {
        if (typeof mechanism[key] !== 'boolean') {
          delete mechanism[key];
        }
      }

      for (const key of ['exception_id', 'parent_id'] as const) {
        const value = mechanism[key];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
          delete mechanism[key];
        }
      }
    }

    if (exception.stacktrace) {
      retainFields(exception.stacktrace, new Set(['frames']));
    }

    for (const frame of exception.stacktrace?.frames ?? []) {
      retainFields(frame, new Set(['filename', 'lineno', 'colno', 'in_app']));
      frame.filename = safeFilename(frame.filename);
      frame.in_app = frame.filename !== 'app:///external';
      for (const key of ['lineno', 'colno'] as const) {
        const value = frame[key];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
          delete frame[key];
        }
      }
    }
  }

  return event;
}

const browserSpanNames: Record<string, string> = {
  'ui.webvital.cls': 'Cumulative layout shift',
  'ui.webvital.lcp': 'Largest contentful paint',
  'ui.interaction.click': 'Click',
  'ui.interaction.hover': 'Hover',
  'ui.interaction.drag': 'Drag',
  'ui.interaction.press': 'Press',
  'ui.long_task': 'Main thread long task',
  'ui.long_animation_frame': 'Main thread long animation frame',
  'browser.paint': 'Browser paint',
  'browser.unload_event': 'Browser unload',
  'browser.redirect': 'Browser redirect',
  'browser.dom_content_loaded_event': 'DOM content loaded',
  'browser.load_event': 'Browser load',
  'browser.connect': 'Browser connection',
  'browser.tls_ssl': 'Browser TLS',
  'browser.cache': 'Browser cache',
  'browser.dns': 'Browser DNS',
  'browser.request': 'Browser request',
  'browser.response': 'Browser response',
  resource: 'Resource',
  ...Object.fromEntries(
    [
      'script',
      'link',
      'img',
      'css',
      'audio',
      'video',
      'iframe',
      'other',
      'worker',
      'icon',
      'frame',
      'object',
      'ping',
      'track',
    ].map(kind => [`resource.${kind}`, `Resource ${kind}`])
  ),
  measure: 'Browser measurement',
  mark: 'Browser mark',
};
const browserNumericAttributes = new Set([
  ...['cls', 'lcp', 'inp', 'fp', 'fcp', 'ttfb'].map(
    vital => `browser.web_vital.${vital}.value`
  ),
  'browser.web_vital.ttfb.request_time',
  'browser.web_vital.lcp.load_time',
  'browser.web_vital.lcp.render_time',
  'browser.web_vital.lcp.size',
  'sentry.exclusive_time',
  'browser.performance.time_origin',
  'browser.performance.navigation.activation_start',
  'http.response.status_code',
  'http.response.size',
  'http.response.body.size',
  'http.response.body.decoded_size',
  'http.redirect_count',
  ...[
    'redirect_start',
    'redirect_end',
    'worker_start',
    'fetch_start',
    'domain_lookup_start',
    'domain_lookup_end',
    'connect_start',
    'secure_connection_start',
    'connection_end',
    'request_start',
    'response_start',
    'response_end',
    'time_to_first_byte',
  ].map(timing => `http.request.${timing}`),
  'network.connection.rtt',
  'device.memory.estimated_capacity',
  'device.processor_count',
]);
const browserEnums: Record<string, readonly string[]> = {
  'sentry.origin': [
    'auto.http.browser.cls',
    'auto.http.browser.lcp',
    'auto.http.browser.inp',
    'auto.ui.browser.metrics',
    'auto.resource.browser.metrics',
    'auto.pageload.react.tanstack_router',
    'auto.navigation.react.tanstack_router',
    'auto.pageload.browser',
    'auto.navigation.browser',
    'auto.navigation.browser.bfcache',
  ],
  'browser.navigation.type': [
    'navigate',
    'reload',
    'back-forward',
    'back-forward-cache',
    'prerender',
    'restore',
    'soft-navigation',
  ],
  'browser.web_vital.inp.interaction_type': ['click', 'hover', 'drag', 'press'],
  'browser.paint.type': ['first-paint', 'first-contentful-paint'],
  'resource.render_blocking_status': ['blocking', 'non-blocking'],
};

export function safeBrowserSpanName(op: unknown, name: string): string {
  return typeof op === 'string' && Object.hasOwn(browserSpanNames, op)
    ? browserSpanNames[op]!
    : safeOperation(name.replace('/customers_', '/customers'));
}

export function safeBrowserAttributes(
  attributes: Record<string, unknown>,
  userAgent: string
) {
  const safe = safeAttributes(attributes);
  const op = attributes['sentry.op'];
  if (
    typeof op !== 'string' ||
    !(Object.hasOwn(browserSpanNames, op) || op === 'pageload' || op === 'navigation')
  ) {
    return safe;
  }

  safe['sentry.op'] = op;
  for (const [key, value] of Object.entries(attributes)) {
    if (
      browserNumericAttributes.has(key) &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0
    ) {
      safe[key] = value;
    } else if (
      typeof value === 'string' &&
      Object.hasOwn(browserEnums, key) &&
      browserEnums[key]?.includes(value)
    ) {
      safe[key] = value;
    } else if (
      key === 'sentry.pageload.span_id' &&
      typeof value === 'string' &&
      spanId.test(value)
    ) {
      safe[key] = value;
    } else if (key === 'sentry.segment.name' || key === 'sentry.transaction') {
      safe[key] = safeOperation(
        typeof value === 'string' ? value.replace('/customers_', '/customers') : value
      );
    }
  }

  if (
    'browser.web_vital.lcp.value' in safe ||
    'browser.web_vital.cls.value' in safe ||
    'browser.web_vital.inp.value' in safe
  ) {
    safe['user_agent.original'] = userAgent;
  }

  return safe;
}

export function shouldSampleTelemetry(percentage: number, random = Math.random): boolean {
  return percentage === 100 || (percentage > 0 && random() < percentage / 100);
}

export function sanitizeLogMetricPayload(
  payload: unknown,
  environment: TelemetryEnvironment
): void {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('items' in payload) ||
    !Array.isArray(payload.items)
  ) {
    return;
  }

  const items: unknown[] = payload.items;
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('attributes' in item)) {
      continue;
    }

    const raw: Record<string, unknown> = {};
    if (typeof item.attributes === 'object' && item.attributes !== null) {
      for (const [key, attribute] of Object.entries(item.attributes)) {
        if (typeof attribute === 'object' && attribute !== null && 'value' in attribute) {
          raw[key] = attribute.value;
        }
      }
    }

    item.attributes = Object.fromEntries(
      Object.entries({...safeAttributes(raw), 'sentry.environment': environment}).map(
        ([key, value]) => [
          key,
          {
            type:
              typeof value === 'number'
                ? Number.isInteger(value)
                  ? 'integer'
                  : 'double'
                : typeof value,
            value,
          },
        ]
      )
    );
  }
}
