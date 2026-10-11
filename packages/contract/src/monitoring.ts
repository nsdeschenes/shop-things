import {actions, errorCodeSchema} from './schemas.js';

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
  /\/(?:src|dist)\/(main|telemetry|actionService|ipc|settings|telemetrySettings|files|customerImport|importMatches)\.(?:js|ts)$/;
const traceId = /^[a-f0-9]{32}$/;
const spanId = /^[a-f0-9]{16}$/;
const rendererFile = /\/renderer\/assets\/[^/?#]+\.js$/;

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
  const safe: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (
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

export function safeErrorType(value: unknown) {
  return typeof value === 'string' && errorTypes.has(value) ? value : 'Error';
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
  'Application action completed',
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
