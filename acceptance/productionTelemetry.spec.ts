import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGunzip} from 'node:zlib';

import {expect, test} from '@playwright/test';

import launchElectron from './launchElectron.js';

test('packaged mode labels every signal from both processes as production', async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-environment-'));
  const envelopes: string[] = [];
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
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

  const settingsPath = join(directory, 'telemetry.json');
  const insecureDsn = 'http://public@ingest.example.invalid/1';
  const hostileSettings = JSON.stringify({dsn: insecureDsn});
  await writeFile(settingsPath, hostileSettings);
  await cp(
    new URL('../packages/db/migrations', import.meta.url),
    join(directory, 'resources', 'migrations'),
    {recursive: true}
  );
  const launchEnvironment = {
    SHOP_THINGS_ACCEPTANCE_PACKAGED: 'true',
    SHOP_THINGS_ACCEPTANCE_RESOURCES: join(directory, 'resources'),
    SHOP_THINGS_ACCEPTANCE_CREATE_PATH: join(
      directory,
      'PRIVATE_SENTINEL_packaged.sqlite'
    ),
    SENTRY_ENVIRONMENT: 'PRIVATE_SENTINEL_environment',
  };
  let application = await launchElectron(directory, launchEnvironment);
  try {
    let page = await application.firstWindow();
    await expect(page.getByRole('heading', {name: 'Set Up Your Database'})).toBeVisible();
    expect(
      await page.evaluate(() => window.shopThings!.telemetry.status())
    ).toMatchObject({
      status: 'success',
      value: {environment: 'production', activeDsn: null, activeEnabled: false},
    });
    await expect(page.locator('meta[content^="connect-src"]')).toHaveAttribute(
      'content',
      "connect-src 'none'"
    );
    function hasTelemetryClient() {
      const sentry = Reflect.get(globalThis, '__SENTRY__');
      const carrier = sentry && Reflect.get(sentry, '11.4.0');
      return Boolean(
        (carrier?.acs?.getCurrentScope() ?? carrier?.defaultCurrentScope)?.getClient()
      );
    }

    expect(await application.evaluate(hasTelemetryClient)).toBe(false);
    expect(await page.evaluate(hasTelemetryClient)).toBe(false);

    expect(
      await page.evaluate(
        dsn =>
          window.shopThings!.telemetry.save({
            dsn,
            sampling: {errors: 100, traces: 100, logs: 100, metrics: 100},
          }),
        insecureDsn
      )
    ).toMatchObject({status: 'error', error: {code: 'INTERNAL'}});
    expect(await readFile(settingsPath, 'utf8')).toBe(hostileSettings);
    await page.getByRole('link', {name: 'Settings', exact: true}).click();
    await page.getByRole('tab', {name: 'Monitoring'}).click();
    const input = page.getByRole('textbox', {name: 'Sentry DSN'});
    await input.fill(insecureDsn);
    await page.getByRole('button', {name: 'Save monitoring'}).click();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert')).toContainText(
      'Use an HTTPS Sentry DSN in production'
    );
    expect(await readFile(settingsPath, 'utf8')).toBe(hostileSettings);
    await application.close();
    expect(envelopes).toEqual([]);
    await writeFile(
      settingsPath,
      JSON.stringify({
        dsn: `http://public@127.0.0.1:${address.port}/1`,
      })
    );
    application = await launchElectron(directory, launchEnvironment);
    page = await application.firstWindow();
    await expect(page.getByRole('heading', {name: 'Set Up Your Database'})).toBeVisible();
    expect(await application.evaluate(({app}) => app.isPackaged)).toBe(true);
    expect(
      await page.evaluate(() => window.shopThings!.telemetry.status())
    ).toMatchObject({
      value: {environment: 'production', activeEnabled: true},
    });
    await page.getByRole('button', {name: 'Create database', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    await page.getByRole('link', {name: 'Database settings', exact: true}).click();
    await page.getByRole('tab', {name: 'Monitoring'}).click();
    await page.evaluate(() => {
      const carrier = Reflect.get(Reflect.get(globalThis, '__SENTRY__'), '11.4.0');
      const scope = carrier.acs?.getCurrentScope() ?? carrier.defaultCurrentScope;
      scope.setAttributes({'sentry.environment': 'development'});
      setTimeout(() => {
        throw new RangeError('PRIVATE_SENTINEL_renderer');
      }, 0);
    });
    await application.evaluate(() => {
      const carrier = Reflect.get(Reflect.get(globalThis, '__SENTRY__'), '11.4.0');
      const scope = carrier.acs?.getCurrentScope() ?? carrier.defaultCurrentScope;
      scope.setAttributes({'sentry.environment': 'development'});
      setTimeout(() => {
        throw new TypeError('PRIVATE_SENTINEL_main');
      }, 0);
    });
    await page.getByRole('tab', {name: 'Database'}).click();
    await page.getByRole('tab', {name: 'Monitoring'}).click();
    await page.getByRole('spinbutton', {name: 'Error sampling (%)'}).fill('99');
    await page.getByRole('button', {name: 'Save monitoring'}).click();
    await expect(page.getByRole('status')).toContainText('Restart Shop Things');
    function signals(type: string, process: string) {
      return envelopes.flatMap(envelope => {
        const lines = envelope.trim().split('\n');
        const found = [];
        for (let index = 1; index + 1 < lines.length; index += 2) {
          if (JSON.parse(lines[index]!).type !== type) {
            continue;
          }

          const payload = JSON.parse(lines[index + 1]!);
          found.push(
            ...(payload.items ?? [payload]).filter(
              (item: {
                tags?: {process?: string};
                attributes?: {process?: {value: string}};
              }) =>
                item.tags?.process === process ||
                item.attributes?.process?.value === process
            )
          );
        }

        return found;
      });
    }

    for (const process of ['main', 'renderer']) {
      for (const type of ['event', 'span', 'log', 'trace_metric']) {
        await expect
          .poll(() => signals(type, process).length, {timeout: 25000})
          .toBeGreaterThan(0);
        expect(
          signals(type, process).every(item =>
            type === 'event'
              ? item.environment === 'production'
              : item.attributes?.['sentry.environment']?.value === 'production'
          )
        ).toBe(true);
      }

      for (const type of ['log', 'trace_metric']) {
        await expect
          .poll(
            () =>
              signals(type, process).some(
                item => item.attributes?.action?.value === 'telemetry.save'
              ),
            {timeout: 15000}
          )
          .toBe(true);
      }
    }

    await expect
      .poll(
        () =>
          signals('span', 'main').some(
            item =>
              item.name === 'database.query' &&
              item.attributes?.['sentry.op']?.value === 'db.query'
          ),
        {timeout: 15000}
      )
      .toBe(true);

    await application.close();
    expect(envelopes.join('\n')).not.toContain('PRIVATE_SENTINEL');
    await testInfo.attach('production-environment-envelopes.json', {
      body: JSON.stringify(envelopes, null, 2),
      contentType: 'application/json',
    });
  } finally {
    await application.close().catch(() => {});
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, {recursive: true, force: true});
  }
});
