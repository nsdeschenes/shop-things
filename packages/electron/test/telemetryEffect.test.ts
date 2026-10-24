import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import * as Sentry from '@sentry/electron/main';
import {Cause, Effect, Exit, Metric} from 'effect';
import {afterEach, assert, beforeEach, describe, expect, test, vi} from 'vitest';

import {createMainTelemetry} from '../src/telemetry.js';
import {FileTelemetrySettings} from '../src/telemetrySettings.js';

type Envelope = Parameters<ReturnType<typeof Sentry.makeElectronTransport>['send']>[0];

const traceIdPattern = /^[a-f0-9]{32}$/;
const spanIdPattern = /^[a-f0-9]{16}$/;
const privateErrorPattern =
  /private-(?:typed-effect-error|effect-defect|capture-control)/;
const collector = vi.hoisted(() => ({
  envelopes: new Array<Envelope>(),
  failTransport: false,
  failMetric: false,
}));

vi.mock('electron', () => ({
  app: {getAppPath: () => '/shop-things', getPath: () => tmpdir()},
  dialog: {showErrorBox: vi.fn()},
}));

vi.mock('@sentry/electron/main', async importOriginal => {
  const original = await importOriginal<typeof Sentry>();
  return {
    ...original,
    metrics: {
      ...original.metrics,
      count: (...args: Parameters<typeof Sentry.metrics.count>) => {
        if (collector.failMetric) {
          throw new Error('private-effect-export-error');
        }

        return original.metrics.count(...args);
      },
    },
    makeElectronTransport: () => {
      if (collector.failTransport) {
        throw new Error('transport initialization failed');
      }

      return {
        send: async (envelope: Envelope) => {
          collector.envelopes.push(structuredClone(envelope));
          return {statusCode: 200};
        },
        flush: async () => true,
      };
    },
  };
});

describe('main Effect telemetry', {concurrent: false}, () => {
  let directory: string;

  beforeEach(async () => {
    await Sentry.close();
    collector.envelopes.length = 0;
    collector.failTransport = false;
    collector.failMetric = false;
    directory = await mkdtemp(join(tmpdir(), 'shop-things-effect-telemetry-'));
    vi.stubEnv('SENTRY_USE_ENVIRONMENT', 'false');
  });

  afterEach(async () => {
    await Sentry.close();
    await rm(directory, {recursive: true, force: true});
    vi.unstubAllEnvs();
  });

  async function telemetry(
    enabled = true,
    sampling = {errors: 100, traces: 100, logs: 100, metrics: 100}
  ) {
    const path = join(directory, 'telemetry.json');
    await writeFile(
      path,
      JSON.stringify({dsn: enabled ? 'https://public@example.com/1' : null, sampling})
    );
    return createMainTelemetry(
      new FileTelemetrySettings(path, undefined, 'production'),
      'effect-test-release'
    );
  }

  function events() {
    return collector.envelopes.flatMap(([, items]) =>
      items.flatMap(([header, payload]) =>
        header.type === 'event' ? [payload as Sentry.ErrorEvent] : []
      )
    );
  }

  interface Signal {
    name?: string;
    body?: string;
    value?: number;
    trace_id?: string;
    span_id?: string;
    attributes?: Record<string, {value: unknown}>;
  }

  function signals(type: 'log' | 'trace_metric') {
    return collector.envelopes.flatMap(([, items]) =>
      items.flatMap(([header, payload]) =>
        header.type === type ? (payload as {items: Signal[]}).items : []
      )
    );
  }

  test('forwards approved Effect logs with severity and safe annotations without serializing private messages', async () => {
    const main = await telemetry();
    let serialized = false;
    const privateMessage = {
      toJSON() {
        serialized = true;
        throw new Error('private-effect-object');
      },
    };
    await Effect.runPromise(
      main.phaseEffect('database.listCustomers', () =>
        Effect.gen(function* () {
          yield* Effect.logWarning('Application lifecycle completed').pipe(
            Effect.annotateLogs({
              outcome: 'success',
              firstName: 'private-effect-annotation',
              stock: '91',
            })
          );
          yield* Effect.logInfo('private-effect-message');
          yield* Effect.logInfo(privateMessage);
        })
      )
    );
    await main.flush();

    expect(serialized).toBe(false);
    expect(signals('log')).toHaveLength(1);
    expect(signals('log')[0]).toMatchObject({
      body: 'Application lifecycle completed',
      level: 'warn',
      attributes: {
        outcome: {value: 'success'},
        'sentry.origin': {value: 'auto.log.effect'},
      },
    });
    const payload = JSON.stringify(collector.envelopes);
    expect(payload).not.toContain('private-effect-');
    expect(signals('log')[0]?.attributes?.stock).toBeUndefined();
  });

  test('exports isolated Effect metrics once when a phase succeeds, fails or is interrupted', async () => {
    const main = await telemetry();
    const count = Metric.counter('application.action.count');
    const duration = Metric.histogram('application.action.duration', {boundaries: []});
    await Effect.runPromise(Metric.update(count, 999));
    for (const outcome of ['success', 'failure', 'interrupt'] as const) {
      const exit = await Effect.runPromiseExit(
        main.phaseEffect('database.listCustomers', () =>
          Effect.gen(function* () {
            yield* Metric.update(count, 2);
            yield* Metric.update(duration, 12.5);
            yield* Metric.update(Metric.counter('private-effect-metric'), 1);
            if (outcome === 'failure') {
              return yield* Effect.fail('private-effect-failure');
            }

            if (outcome === 'interrupt') {
              return yield* Effect.interrupt;
            }
          }).pipe(
            Effect.provideService(Metric.CurrentMetricAttributes, {
              action: 'customers.list',
              outcome: 'success',
              firstName: 'private-effect-metric-attribute',
              stock: '91',
            })
          )
        )
      );
      expect(Exit.isSuccess(exit)).toBe(outcome === 'success');
    }

    await main.flush();

    const metrics = signals('trace_metric');
    expect(
      metrics.filter(item => item.name === count.id).map(item => item.value)
    ).toEqual([2, 2, 2]);
    expect(
      metrics.filter(item => item.name === duration.id).map(item => item.value)
    ).toEqual([12.5, 12.5, 12.5]);
    expect(metrics.every(item => item.attributes?.stock === undefined)).toBe(true);
    expect(
      metrics.every(
        item =>
          traceIdPattern.test(item.trace_id ?? '') &&
          spanIdPattern.test(item.span_id ?? '')
      )
    ).toBe(true);
    expect(events()).toEqual([]);
    expect(JSON.stringify(collector.envelopes)).not.toContain('private-effect-');
  });

  test('keeps nested phase registries separate and exports each once', async () => {
    const main = await telemetry();
    const count = Metric.counter('application.action.count');
    await Effect.runPromise(
      main.phaseEffect('database.listCustomers', () =>
        Effect.gen(function* () {
          yield* Metric.update(count, 2);
          yield* main.phaseEffect('database.getCustomer', () => Metric.update(count, 3));
          expect((yield* Metric.value(count)).count).toBe(2);
        })
      )
    );
    await main.flush();

    expect(signals('trace_metric').map(item => item.value)).toEqual([3, 2]);
  });

  test('records concurrent action completions once with their own attributes and original errors', async () => {
    const main = await telemetry();
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const success = {status: 'success', value: 42};
    const expected = {status: 'error', error: {code: 'BUSY'}};
    const failure = new Error('private-effect-action-error');
    let executions = 0;
    const first = main.observeAction(
      'customers.update',
      async () => {
        executions++;
        await held;
        return success;
      },
      {stock: 7, balance: '1.20'}
    );
    expect(
      await main.observeAction('customers.list', async () => {
        executions++;
        return expected;
      })
    ).toBe(expected);
    release();
    expect(await first).toBe(success);
    await expect(
      main.observeAction('customers.delete', async () => {
        executions++;
        throw failure;
      })
    ).rejects.toBe(failure);
    await main.flush();

    expect(executions).toBe(3);
    const logs = signals('log');
    expect(logs).toHaveLength(3);
    expect(
      logs.find(item => item.attributes?.action?.value === 'customers.update')
    ).toMatchObject({
      attributes: {
        stock: {value: 7},
        balance: {value: '1.20'},
        outcome: {value: 'success'},
        'sentry.message.template': {value: 'Application action %s completed'},
        'sentry.message.parameter.0': {value: 'customers.update'},
      },
    });
    expect(
      logs
        .filter(item => item.attributes?.action?.value !== 'customers.update')
        .every(
          item =>
            item.attributes?.stock === undefined && item.attributes?.balance === undefined
        )
    ).toBe(true);
    expect(
      logs.find(item => item.attributes?.action?.value === 'customers.list')
    ).toMatchObject({attributes: {outcome: {value: 'error'}, code: {value: 'BUSY'}}});
    const metrics = signals('trace_metric');
    expect(
      metrics
        .filter(item => item.name === 'application.action.count')
        .map(item => item.value)
    ).toEqual([1, 1, 1]);
    expect(
      metrics.filter(item => item.name === 'application.action.duration')
    ).toHaveLength(3);
    expect(
      metrics
        .filter(item => item.name === 'application.action.duration')
        .every(item => Number.isFinite(item.value) && item.value! >= 0)
    ).toBe(true);
    expect(events()).toHaveLength(1);
    expect(JSON.stringify(collector.envelopes)).not.toContain(
      'private-effect-action-error'
    );
  });

  test.each([
    {logs: 0, metrics: 100},
    {logs: 100, metrics: 0},
  ])('samples Effect logs and metrics independently: %j', async sampling => {
    const main = await telemetry(true, {errors: 100, traces: 100, ...sampling});
    const result = {status: 'success'};
    expect(await main.observeAction('customers.list', async () => result)).toBe(result);
    await main.flush();
    expect(signals('log')).toHaveLength(sampling.logs === 0 ? 0 : 1);
    expect(signals('trace_metric')).toHaveLength(sampling.metrics === 0 ? 0 : 2);
  });

  test('keeps application results and errors when an SDK metric export throws', async () => {
    const main = await telemetry();
    collector.failMetric = true;
    const result = {status: 'success', value: 42};
    const failure = new Error('private-effect-operation-error');
    let executions = 0;
    expect(
      await main.observeAction('customers.list', async () => {
        executions++;
        return result;
      })
    ).toBe(result);
    await expect(
      main.observeAction('customers.delete', async () => {
        executions++;
        throw failure;
      })
    ).rejects.toBe(failure);
    await main.flush();

    expect(executions).toBe(2);
    expect(signals('log')).toHaveLength(2);
    expect(signals('trace_metric').map(item => item.name)).toEqual([
      'application.action.duration',
      'application.action.duration',
    ]);
    expect(events()).toHaveLength(1);
    expect(JSON.stringify(collector.envelopes)).not.toContain('private-effect-');
  });

  test.each(['disabled', 'initialization fails'])(
    'keeps action execution and error identity when monitoring is %s',
    async mode => {
      collector.failTransport = mode === 'initialization fails';
      const main = await telemetry(mode !== 'disabled');
      const result = {status: 'success'};
      const failure = new Error('private-effect-disabled-error');
      let executions = 0;
      expect(
        await main.observeAction('customers.list', async () => {
          executions++;
          return result;
        })
      ).toBe(result);
      await expect(
        main.observeAction('customers.delete', async () => {
          executions++;
          throw failure;
        })
      ).rejects.toBe(failure);
      await main.flush();

      expect(executions).toBe(2);
      expect(collector.envelopes).toEqual([]);
    }
  );

  test('delivers Effect SDK metadata through the existing exception boundary', async () => {
    const main = await telemetry();
    main.captureException(new Error('private-metadata-error'), {
      action: 'customers.list',
    });
    await main.flush();

    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      release: 'effect-test-release',
      environment: 'production',
      sdk: {
        name: 'sentry.javascript.effect',
        version: '11.4.0',
        packages: [
          {name: 'npm:@sentry/effect', version: '11.4.0'},
          {name: 'npm:@sentry/node', version: '11.4.0'},
        ],
        integrations: [
          'OnUncaughtException',
          'OnUnhandledRejection',
          'Dedupe',
          'LinkedErrors',
          'SpanStreaming',
        ],
      },
      tags: {action: 'customers.list'},
    });
    expect(JSON.stringify(collector.envelopes)).not.toContain('private-metadata-error');
  });

  test('completes native action, asynchronous Effect phase and native child on one trace', async () => {
    const main = await telemetry();
    const result = {status: 'success', value: 42};
    let executions = 0;
    const program = main.phaseEffect('database.listCustomers', () => {
      executions++;
      return Effect.gen(function* () {
        yield* Effect.sleep('1 millis');
        return yield* Effect.promise(() =>
          Sentry.startSpan(
            {name: 'database.getCustomer', op: 'application.phase'},
            async span => {
              span.setAttribute('customerName', 'private-effect-attribute');
              span.addEvent('private-effect-event');
              await Promise.resolve();
              return result;
            }
          )
        );
      });
    });

    expect(executions).toBe(0);
    expect(
      await main.observeAction('customers.list', () => Effect.runPromise(program))
    ).toBe(result);
    expect(executions).toBe(1);
    await main.flush();

    const spans = collector.envelopes.flatMap(([, items]) =>
      items.flatMap(([header, payload]) =>
        header.type === 'span'
          ? (payload as {items: Array<ReturnType<typeof Sentry.spanToJSON>>}).items
          : []
      )
    );
    expect(spans).toHaveLength(3);
    const action = spans.find(span => span.name === 'customers.list');
    const phase = spans.find(span => span.name === 'database.listCustomers');
    const child = spans.find(span => span.name === 'database.getCustomer');
    expect(action).toMatchObject({
      status: 'ok',
      trace_id: expect.stringMatching(traceIdPattern),
      span_id: expect.stringMatching(spanIdPattern),
      attributes: {
        action: {value: 'customers.list'},
        process: {value: 'main'},
        'sentry.environment': {value: 'production'},
      },
    });
    expect(phase).toMatchObject({
      trace_id: action!.trace_id,
      parent_span_id: action!.span_id,
      status: 'ok',
      attributes: {'sentry.op': {value: 'application.phase'}},
    });
    expect(child).toMatchObject({
      trace_id: action!.trace_id,
      parent_span_id: phase!.span_id,
      status: 'ok',
      attributes: {action: {value: 'customers.list'}},
    });
    expect(events()).toEqual([]);
    const payload = JSON.stringify(collector.envelopes);
    expect(payload).not.toContain('private-effect-attribute');
    expect(payload).not.toContain('private-effect-event');
  });

  test.each(['enabled', 'disabled', 'initialization fails'])(
    'preserves lazy work and exits when monitoring is %s',
    async mode => {
      collector.failTransport = mode === 'initialization fails';
      const enabled = mode === 'enabled';
      const main = await telemetry(mode !== 'disabled');
      const value = {answer: 42};
      const failure = new Error('private-typed-effect-error');
      const defect = new Error('private-effect-defect');
      let executions = 0;
      function phase<A, E>(work: Effect.Effect<A, E>) {
        return main.phaseEffect('database.listCustomers', () => {
          executions++;
          return work;
        });
      }

      const success = phase(Effect.succeed(value));
      expect(executions).toBe(0);
      expect(await Effect.runPromise(success)).toBe(value);
      expect(executions).toBe(1);
      const failed = await Effect.runPromiseExit(phase(Effect.fail(failure)));
      const died = await Effect.runPromiseExit(phase(Effect.die(defect)));
      const interrupted = await Effect.runPromiseExit(phase(Effect.interrupt));
      expect(failed).toMatchObject({
        _tag: 'Failure',
        cause: {reasons: [{_tag: 'Fail', error: failure}]},
      });
      expect(died).toMatchObject({
        _tag: 'Failure',
        cause: {reasons: [{_tag: 'Die', defect}]},
      });
      assert(Exit.isFailure(failed));
      assert(Exit.isFailure(died));
      assert(Exit.isFailure(interrupted));
      expect(Cause.squash(failed.cause)).toBe(failure);
      expect(Cause.squash(died.cause)).toBe(defect);
      expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
      expect(executions).toBe(4);
      await main.flush();
      expect(events()).toEqual([]);

      main.captureException(new Error('private-capture-control'));
      await main.flush();
      expect(events()).toHaveLength(enabled ? 1 : 0);
      expect(events().map(event => event.sdk?.name)).toEqual(
        enabled ? ['sentry.javascript.effect'] : []
      );
      expect(collector.envelopes.length === 0).toBe(!enabled);
      expect(JSON.stringify(collector.envelopes)).not.toMatch(privateErrorPattern);
    }
  );
});
