import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import * as Sentry from '@sentry/electron/main';
import {Cause, Effect, Exit} from 'effect';
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
}));

vi.mock('electron', () => ({
  app: {getAppPath: () => '/shop-things', getPath: () => tmpdir()},
  dialog: {showErrorBox: vi.fn()},
}));

vi.mock('@sentry/electron/main', async importOriginal => ({
  ...(await importOriginal<typeof Sentry>()),
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
}));

describe('main Effect telemetry', {concurrent: false}, () => {
  let directory: string;

  beforeEach(async () => {
    await Sentry.close();
    collector.envelopes.length = 0;
    collector.failTransport = false;
    directory = await mkdtemp(join(tmpdir(), 'shop-things-effect-telemetry-'));
    vi.stubEnv('SENTRY_USE_ENVIRONMENT', 'false');
  });

  afterEach(async () => {
    await Sentry.close();
    await rm(directory, {recursive: true, force: true});
    vi.unstubAllEnvs();
  });

  async function telemetry(enabled = true) {
    const path = join(directory, 'telemetry.json');
    await writeFile(
      path,
      JSON.stringify({dsn: enabled ? 'https://public@example.com/1' : null})
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
