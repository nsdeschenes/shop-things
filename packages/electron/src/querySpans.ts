import * as Sentry from '@sentry/electron/main';
import type {TelemetryEnvironment} from '@shop-things/contract';
import {safeAttributes, safeOperation} from '@shop-things/contract/monitoring';
import {safeQueryAttributes} from '@shop-things/db';
import type {QueryObserver, QueryCompletion, SafeQueryDetails} from '@shop-things/db';

const traceIdPattern = /^[a-f0-9]{32}$/;
const spanIdPattern = /^[a-f0-9]{16}$/;

type SpanJSON = ReturnType<typeof Sentry.spanToJSON>;
interface OwnedQuery {
  details: SafeQueryDetails;
  action: Record<string, string | number | boolean>;
  completion?: QueryCompletion;
}

export function createQuerySpans(
  environment: TelemetryEnvironment,
  currentAction: () => Record<string, string | number | boolean> | undefined
) {
  const owned = new Map<string, OwnedQuery>();
  function key(traceId: string, spanId: string) {
    return `${traceId}:${spanId}`;
  }

  function observer(details: Readonly<SafeQueryDetails>): ReturnType<QueryObserver> {
    let span: Sentry.Span;
    let query: OwnedQuery;
    let spanKey: string | undefined;
    try {
      query = {details: {...details}, action: safeAttributes(currentAction())};
      span = Sentry.startInactiveSpan({
        name: 'database.query',
        op: 'db.query',
        attributes: query.action,
      });
      if (span.isRecording()) {
        const context = span.spanContext();
        spanKey = key(context.traceId, context.spanId);
        owned.set(spanKey, query);
      }
    } catch {
      return;
    }

    let finished = false;
    return completion => {
      if (finished) {
        return;
      }

      finished = true;
      query.completion = {...completion};
      try {
        span.setStatus({code: completion.outcome === 'error' ? 2 : 1});
      } catch {}

      try {
        span.end();
      } catch {
        if (spanKey) {
          owned.delete(spanKey);
        }
      }
    };
  }

  function project(span: SpanJSON): SpanJSON {
    try {
      const query = owned.get(key(span.trace_id, span.span_id));
      const attributes = query
        ? safeAttributes(query.action)
        : safeAttributes(span.attributes);
      if (query) {
        Object.assign(attributes, safeQueryAttributes(query.details), {
          'sentry.op': 'db.query',
        });
        if (query.completion) {
          Object.assign(
            attributes,
            safeAttributes({
              outcome: query.completion.outcome,
              duration_ms: query.completion.durationMs,
            })
          );
        }
      }

      return {
        trace_id: traceIdPattern.test(span.trace_id) ? span.trace_id : '0'.repeat(32),
        span_id: spanIdPattern.test(span.span_id) ? span.span_id : '0'.repeat(16),
        ...(spanIdPattern.test(span.parent_span_id ?? '')
          ? {parent_span_id: span.parent_span_id}
          : {}),
        name: query
          ? 'database.query'
          : span.name === 'database.query'
            ? 'application.operation'
            : safeOperation(span.name),
        start_timestamp: Number.isFinite(span.start_timestamp) ? span.start_timestamp : 0,
        ...(Number.isFinite(span.end_timestamp)
          ? {end_timestamp: span.end_timestamp}
          : {}),
        status: query
          ? query.completion?.outcome === 'error'
            ? 'error'
            : 'ok'
          : span.status === 'error'
            ? 'error'
            : 'ok',
        is_segment: span.is_segment === true,
        attributes: {...attributes, process: 'main', 'sentry.environment': environment},
      };
    } catch {
      return {
        trace_id: '0'.repeat(32),
        span_id: '0'.repeat(16),
        name: 'application.operation',
        start_timestamp: 0,
        status: 'error',
        is_segment: false,
        attributes: {process: 'main', 'sentry.environment': environment},
      };
    }
  }

  function sanitizeEnvelope(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null || !('items' in payload)) {
      return;
    }

    const items: unknown[] = Array.isArray(payload.items) ? payload.items : [];
    payload.items = items.flatMap(item => {
      try {
        if (typeof item !== 'object' || item === null) {
          return [];
        }

        const raw = item as SpanJSON;
        const attributes: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(raw.attributes ?? {})) {
          if (typeof value === 'object' && value !== null && 'value' in value) {
            attributes[name] = value.value;
          }
        }

        const projected = project({...raw, attributes});
        owned.delete(key(raw.trace_id, raw.span_id));
        return [
          {
            ...projected,
            end_timestamp: projected.end_timestamp ?? projected.start_timestamp,
            attributes: Object.fromEntries(
              Object.entries(projected.attributes).map(([name, value]) => [
                name,
                {
                  type:
                    typeof value === 'number'
                      ? Number.isInteger(value)
                        ? 'integer'
                        : 'double'
                      : typeof value,
                  value,
                },
              ])
            ),
          },
        ];
      } catch {
        return [];
      }
    });
  }

  return {observer, project, sanitizeEnvelope};
}
