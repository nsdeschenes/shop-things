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
