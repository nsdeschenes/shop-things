import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGunzip} from 'node:zlib';

import {expect, test} from '@playwright/test';

import launchElectron from './launchElectron.js';

interface BrowserSignal {
  event_id?: string;
  name?: string;
  tags?: {process?: string};
  extra?: Record<string, unknown>;
  sdk: {
    name: string;
    version: string;
    integrations: string[];
    settings: {infer_ip: string};
  };
  exception: {
    values: {
      mechanism: {
        type: string;
        handled?: boolean;
        parent_id?: number;
        exception_id?: number;
      };
      stacktrace: {frames: unknown[]};
    }[];
  };
  attributes: Record<string, {value: string | number | boolean}>;
}

test('native browser diagnostics and error capture retain SDK fidelity without private payloads', async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-browser-monitoring-'));
  const envelopes: string[] = [];
  const browserFixture = await readFile(
    new URL('../acceptance-reports/harness/telemetry-errors.mjs', import.meta.url),
    'utf8'
  );
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    response.setHeader('Timing-Allow-Origin', '*');
    if (request.method === 'GET') {
      if (request.url?.startsWith('/telemetry-work.js')) {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(browserFixture);
      } else {
        response.setHeader('Content-Type', 'image/png');
        response.end(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
            'base64'
          )
        );
      }

      return;
    }

    let body = '';
    const bodyStream =
      request.headers['content-encoding'] === 'gzip'
        ? request.pipe(createGunzip())
        : request;
    bodyStream.setEncoding('utf8');
    bodyStream.on('data', chunk => {
      body += chunk;
    });
    bodyStream.on('end', () => {
      if (request.method !== 'OPTIONS') {
        envelopes.push(body);
      }

      response.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Collector did not bind.');
  }

  await writeFile(
    join(directory, 'telemetry.json'),
    JSON.stringify({dsn: `http://public@127.0.0.1:${address.port}/1`})
  );
  const application = await launchElectron(directory);
  function signals(type: string) {
    return envelopes.flatMap(body => {
      const lines = body.split('\n');
      const values: BrowserSignal[] = [];
      for (let index = 1; index + 1 < lines.length; index += 2) {
        if (JSON.parse(lines[index]!).type === type) {
          const payload = JSON.parse(lines[index + 1]!);
          values.push(...(payload.items ?? [payload]));
        }
      }

      return values;
    });
  }

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', {name: 'Set Up Your Database'})).toBeVisible();
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const content = document.createElement('div');
        content.id = 'PRIVATE_SENTINEL_lcp_element';
        content.className = 'PRIVATE_SENTINEL_lcp_class';
        content.textContent = 'PRIVATE_SENTINEL_visible_content '.repeat(20);
        content.style.cssText =
          'font-size:40px;line-height:1.2;width:90vw;height:250px;background:#eee';
        document.body.prepend(content);
        const spacer = document.createElement('div');
        document.body.prepend(spacer);
        setTimeout(() => {
          spacer.style.height = '120px';
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              Reflect.set(window, 'acceptanceLayoutShiftFinished', true);
            })
          );
        }, 700);
      });
    });
    await page.reload();
    await expect
      .poll(() =>
        page.evaluate(() => Boolean(Reflect.get(window, 'acceptanceLayoutShiftFinished')))
      )
      .toBe(true);
    const runtime = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      longFrame: PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'),
      paints: performance.getEntriesByType('paint').map(entry => entry.name),
      navigationTiming: performance.getEntriesByType('navigation').length > 0,
    }));
    await page.evaluate(() => {
      const carrier = Reflect.get(Reflect.get(globalThis, '__SENTRY__'), '11.4.0');
      const scope = carrier.acs?.getCurrentScope() ?? carrier.defaultCurrentScope;
      scope.setAttributes({
        'browser.secret.value': 123,
        'browser.web_vital.lcp.element': 'PRIVATE_SENTINEL_poisoned_selector',
        customerNumber: 123456,
        stock: 123,
      });
      scope.setExtras({email: 'PRIVATE_SENTINEL_extra', diagnostic: 'native-extra'});
      scope.setUser({email: 'PRIVATE_SENTINEL_email'});
    });
    await page.evaluate(async origin => {
      const module = await import(
        `${origin}/telemetry-work.js?private=PRIVATE_SENTINEL_query`
      );
      module.installBrowserWork(
        `${origin}/PRIVATE_SENTINEL_resource.png?private=PRIVATE_SENTINEL_query`
      );
    }, `http://127.0.0.1:${address.port}`);
    await page.getByRole('link', {name: 'Settings', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Settings', exact: true})
    ).toBeVisible();
    await expect
      .poll(
        () =>
          signals('span').some(span => span.attributes?.['browser.web_vital.inp.value']),
        {timeout: 15000}
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          signals('span').some(
            span =>
              span.attributes?.['sentry.op']?.value ===
              (runtime.longFrame ? 'ui.long_animation_frame' : 'ui.long_task')
          ),
        {timeout: 15000}
      )
      .toBe(true);
    await application.evaluate(({BrowserWindow}) =>
      BrowserWindow.getAllWindows()[0]!.hide()
    );
    await expect
      .poll(
        () =>
          signals('span').some(
            span => Number(span.attributes?.['browser.web_vital.cls.value']?.value) > 0
          ),
        {timeout: 15000}
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          signals('span').some(span => span.attributes?.['browser.web_vital.lcp.value']),
        {timeout: 15000}
      )
      .toBe(true);
    const harness = await readFile(
      new URL('../acceptance-reports/harness/telemetry-errors.mjs', import.meta.url),
      'utf8'
    );
    const ids = await page.evaluate(
      async ({source, dsn}) => {
        const module = await import(
          URL.createObjectURL(new Blob([source], {type: 'text/javascript'}))
        );
        return module.captureFailures(dsn);
      },
      {source: harness, dsn: `http://public@127.0.0.1:${address.port}/1`}
    );
    await expect
      .poll(
        () => signals('event').filter(event => event.tags?.process === 'renderer').length,
        {timeout: 15000}
      )
      .toBe(7);
    const events = signals('event').filter(event => event.tags?.process === 'renderer');
    expect(events.filter(event => event.event_id === ids.duplicate)).toHaveLength(1);
    for (const id of ids.distinct) {
      expect(events.some(event => event.event_id === id)).toBe(true);
    }

    expect(
      events.some(
        event => event.event_id === ids.expected || event.event_id === ids.cancelled
      )
    ).toBe(false);
    const linked = events.find(event => event.event_id === ids.linked)!;
    expect(linked.exception.values).toHaveLength(2);
    expect(linked.exception.values[0].mechanism.source).toBe('cause');
    expect(linked.exception.values[0].mechanism.parent_id).toBe(
      linked.exception.values[1].mechanism.exception_id
    );
    expect(
      events.some(event =>
        event.exception.values.some(
          exception =>
            exception.mechanism.type === 'auto.browser.global_handlers.onerror' &&
            exception.mechanism.handled === false
        )
      )
    ).toBe(true);
    expect(
      events.some(event =>
        event.exception.values.some(
          exception =>
            exception.mechanism.type ===
              'auto.browser.global_handlers.onunhandledrejection' &&
            exception.mechanism.handled === false
        )
      )
    ).toBe(true);
    expect(
      events.some(event =>
        event.exception.values.some(
          exception => exception.mechanism.type === 'auto.function.react.error_handler'
        )
      )
    ).toBe(true);
    for (const event of events) {
      expect(event.sdk).toMatchObject({
        name: 'sentry.javascript.react',
        version: '11.4.0',
        settings: {infer_ip: 'never'},
      });
      expect(event.sdk.integrations).toEqual(
        expect.arrayContaining(['GlobalHandlers', 'Dedupe', 'LinkedErrors'])
      );
      expect(event.tags).toEqual({process: 'renderer'});
      expect(event.extra).toEqual({diagnostic: 'native-extra'});
    }

    expect(linked.exception.values[1].stacktrace.frames.length).toBeGreaterThan(1);
    expect(
      events.some(event =>
        event.exception.values.some(exception =>
          exception.stacktrace?.frames?.some(frame => frame.function === 'CustomerEditor')
        )
      )
    ).toBe(true);
    if (runtime.longFrame) {
      await expect
        .poll(
          () =>
            signals('span').some(span =>
              String(span.attributes?.['code.file.path']?.value).endsWith(
                '/telemetry-work.js'
              )
            ),
          {timeout: 15000}
        )
        .toBe(true);
    }

    const spans = signals('span');
    expect(
      spans.some(span => span.attributes?.['browser.secret.value']?.value === 123)
    ).toBe(true);
    for (const vital of ['cls', 'lcp', 'inp']) {
      const span = spans.find(
        span => Number(span.attributes?.[`browser.web_vital.${vital}.value`]?.value) > 0
      )!;
      const value = span.attributes[`browser.web_vital.${vital}.value`].value;
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
      expect(span.attributes['user_agent.original'].value).toBe(runtime.userAgent);
    }

    const pageload = spans.find(
      span =>
        span.attributes?.['sentry.op']?.value === 'pageload' &&
        span.attributes?.['browser.web_vital.fcp.value']
    );
    for (const [paint, metric] of [
      ['first-paint', 'fp'],
      ['first-contentful-paint', 'fcp'],
    ] as const) {
      if (runtime.paints.includes(paint)) {
        expect(pageload).toBeDefined();
        expect(
          Number.isFinite(pageload!.attributes[`browser.web_vital.${metric}.value`].value)
        ).toBe(true);
      }
    }

    if (runtime.navigationTiming) {
      expect(pageload).toBeDefined();
      expect(
        Number.isFinite(pageload!.attributes['browser.web_vital.ttfb.value'].value)
      ).toBe(true);
      expect(
        Number.isFinite(pageload!.attributes['browser.web_vital.ttfb.request_time'].value)
      ).toBe(true);
    }

    expect(
      spans.some(
        span =>
          String(span.attributes?.['sentry.op']?.value).startsWith('resource.') &&
          Number.isFinite(span.attributes?.['http.request.response_end']?.value)
      )
    ).toBe(true);
    expect(
      spans.some(span => span.attributes?.['sentry.op']?.value === 'browser.response')
    ).toBe(true);
    expect(envelopes.join('\n')).not.toContain('PRIVATE_SENTINEL');
    expect(
      spans.some(span => span.attributes?.customerNumber || span.attributes?.stock)
    ).toBe(false);
  } finally {
    await testInfo.attach('native-browser-envelopes.json', {
      body: JSON.stringify(envelopes, null, 2),
      contentType: 'application/json',
    });
    await application.close().catch(() => {});
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, {recursive: true, force: true});
  }
});
