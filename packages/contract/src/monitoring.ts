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
const appFiles =
  /\/(?:src|dist)\/(main|telemetry|actionService|ipc|settings|telemetrySettings|files|customerImport|importMatches|document|draftCoordinator|nativeDialogs|customerImportNumbers|ipcWire|preload|preloadBridge)\.(?:js|ts)$/;
const databaseFiles =
  /\/(?:packages\/db|node_modules\/@shop-things\/db)\/(?:src|dist)\/(index|customers|schema|relations|lifecycle)\.(?:js|ts)$/;
const spanId = /^[a-f0-9]{16}$/;
const rendererFile = /\/renderer\/assets\/[^/?#]+\.js$/;
const actionLogTemplate = 'Application action %s completed';
const absoluteModulePath = /^(?:\/|[A-Za-z]:[\\/]|file:)/;
const privateUrlAttribute = /^url\.(?!template$)/;
const privateVitalAttribute =
  /^(?:browser\.web_vital\.[^.]+|lcp)\.(?:url|element|selector|target|id|source(?:\..*)?)$/;

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

interface Stacktrace {
  frames?: {filename?: string; abs_path?: string}[];
}

interface ErrorEvent {
  sdk?: {settings?: {infer_ip?: 'auto' | 'never'}};
  environment?: string;
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  debug_meta?: {images?: object[]};
  modules?: Record<string, string>;
  threads?: {values?: {stacktrace?: Stacktrace}[]};
  exception?: {
    values?: {
      value?: string;
      mechanism?: object;
      stacktrace?: Stacktrace;
    }[];
  };
}

function scrubStacktrace(stacktrace: Stacktrace | undefined): void {
  for (const frame of stacktrace?.frames ?? []) {
    if (frame.filename !== undefined) {
      frame.filename = safeFilename(frame.filename);
    }

    if (frame.abs_path !== undefined) {
      frame.abs_path = safeFilename(frame.abs_path);
    }

    for (const key of ['vars', 'pre_context', 'context_line', 'post_context', 'source']) {
      Reflect.deleteProperty(frame, key);
    }
  }
}

export function sanitizeErrorEvent<T extends ErrorEvent>(
  event: T,
  process: 'main' | 'renderer',
  environment: TelemetryEnvironment,
  attributes: Record<string, unknown> = {}
): T {
  for (const key of [
    'user',
    'request',
    'message',
    'logentry',
    'fingerprint',
    'breadcrumbs',
    'transaction',
    'server_name',
  ]) {
    Reflect.deleteProperty(event, key);
  }

  event.sdk = {...event.sdk, settings: {...event.sdk?.settings, infer_ip: 'never'}};
  event.environment = environment;
  event.extra = safeAttributes(attributes);
  event.tags = {...event.extra, process};
  for (const [name, context] of Object.entries(event.contexts ?? {})) {
    if (name === 'customer' || name === 'user' || name === 'request') {
      delete event.contexts?.[name];
    } else if (typeof context === 'object' && context !== null) {
      scrubPrivateAttributes(context as Record<string, unknown>);
      if (
        name === 'trace' &&
        'data' in context &&
        typeof context.data === 'object' &&
        context.data !== null
      ) {
        scrubPrivateAttributes(context.data as Record<string, unknown>);
      }
    }
  }

  for (const exception of event.exception?.values ?? []) {
    exception.value = 'Unexpected application failure.';
    if (exception.mechanism) {
      Reflect.deleteProperty(exception.mechanism, 'data');
      Reflect.deleteProperty(exception.mechanism, 'source');
    }

    scrubStacktrace(exception.stacktrace);
  }

  for (const thread of event.threads?.values ?? []) {
    scrubStacktrace(thread.stacktrace);
  }

  for (const image of event.debug_meta?.images ?? []) {
    for (const key of ['code_file', 'debug_file']) {
      if (typeof Reflect.get(image, key) === 'string') {
        Reflect.set(image, key, safeFilename(Reflect.get(image, key)));
      }
    }
  }

  for (const name of Object.keys(event.modules ?? {})) {
    if (absoluteModulePath.test(name)) {
      delete event.modules?.[name];
    }
  }

  return event;
}

const privateAttributes = new Set([
  'firstName',
  'lastName',
  'address',
  'city',
  'province',
  'postalCode',
  'phone',
  'email',
  'comments',
  'id',
  'customer',
  'arguments',
  'result',
  'query',
  'queryKey',
  'dsn',
  'path',
  'filename',
  'abs_path',
  'server.address',
  'http.url',
  'http.target',
  'http.request.url',
  'code.file.path',
  'code.filepath',
  'ui.component_name',
  'browser.script.invoker',
  'browser.script.source_url',
  'db.system.name',
  'db.operation.name',
  'db.collection.name',
  'db.query.method',
  'db.query.text',
  'db.statement',
]);
const customerAttributeNames = [
  'customerNumber',
  'stock',
  'previousBalance',
  'balance',
  'donate',
] as const;

export function scrubPrivateAttributes(attributes: Record<string, unknown>): void {
  for (const key of Object.keys(attributes)) {
    if (
      privateAttributes.has(key) ||
      key.startsWith('user.') ||
      key.startsWith('params.') ||
      key.startsWith('db.query.parameter.') ||
      privateUrlAttribute.test(key) ||
      privateVitalAttribute.test(key) ||
      key.startsWith('ui.element.')
    ) {
      delete attributes[key];
    }

    if (
      (key === 'sentry.message.template' ||
        key.startsWith('sentry.message.parameter.')) &&
      !(key in safeAttributes({[key]: attributes[key]}))
    ) {
      delete attributes[key];
    }
  }

  for (const key of customerAttributeNames) {
    if (
      key in attributes &&
      !customerSchema.shape[key].safeParse(attributes[key]).success
    ) {
      delete attributes[key];
    }
  }
}

export function scrubBrowserSpan<
  T extends {name: string; attributes: Record<string, unknown>},
>(span: T, userAgent: string): T {
  if (
    span.name === span.attributes['code.file.path'] ||
    span.name === span.attributes['browser.web_vital.lcp.element'] ||
    span.name === span.attributes['browser.web_vital.inp.target']
  ) {
    span.name = '[Filtered]';
  } else {
    span.name = span.name.replace(/(?:https?|file|blob):\/\/\S+/g, '[Filtered]');
  }

  scrubPrivateAttributes(span.attributes);
  if ('user_agent.original' in span.attributes) {
    span.attributes['user_agent.original'] = userAgent;
  }

  return span;
}

export function shouldSampleTelemetry(percentage: number, random = Math.random): boolean {
  return percentage === 100 || (percentage > 0 && random() < percentage / 100);
}

export function sanitizeLogMetricPayload(
  payload: unknown,
  environment: TelemetryEnvironment,
  process: 'main' | 'renderer'
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

    scrubPrivateAttributes(raw);

    item.attributes = Object.fromEntries(
      Object.entries({...raw, process, 'sentry.environment': environment}).map(
        ([key, value]) => [
          key,
          !customerAttributeNames.some(name => name === key) &&
          key !== 'sentry.environment' &&
          key !== 'process' &&
          typeof item.attributes === 'object' &&
          item.attributes !== null
            ? Reflect.get(item.attributes, key)
            : {
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
