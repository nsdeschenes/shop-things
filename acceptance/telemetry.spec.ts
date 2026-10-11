import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from '@playwright/test';

import launchElectron from './launchElectron.js';

test('production monitoring activates only on cold restart and delivers private signals from both processes', async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-monitoring-'));
  const envelopes: string[] = [];
  const destinations: string[] = [];
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') {
      response.end();
      return;
    }

    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => {
      envelopes.push(body);
      destinations.push(request.url ?? '');
      response.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let unselectedDeliveries = 0;
  const unselected = createServer((request, response) => {
    unselectedDeliveries += 1;
    request.resume();
    response.end('{}');
  });
  await new Promise<void>(resolve => unselected.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const unselectedAddress = unselected.address();
  if (
    !address ||
    typeof address === 'string' ||
    !unselectedAddress ||
    typeof unselectedAddress === 'string'
  ) {
    throw new Error('Collector did not bind.');
  }

  const dsn = `http://public@127.0.0.1:${address.port}/1`;
  const launchEnvironment = {
    SENTRY_USE_ENVIRONMENT: 'true',
    SENTRY_TRACE: `${'a'.repeat(32)}-${'b'.repeat(16)}-1`,
    SENTRY_BAGGAGE: `sentry-trace_id=${'a'.repeat(32)},sentry-public_key=public,sentry-transaction=PRIVATE_SENTINEL_environment,sentry-sampled=true`,
    SENTRY_TRACE_LIFECYCLE: 'static',
    SENTRY_SPOTLIGHT: `http://127.0.0.1:${unselectedAddress.port}/spotlight`,
    SHOP_THINGS_ACCEPTANCE_MONITORING: 'true',
    SHOP_THINGS_ACCEPTANCE_CREATE_PATH: join(
      directory,
      'PRIVATE_SENTINEL_database.sqlite'
    ),
  };
  let application = await launchElectron(directory, launchEnvironment);
  try {
    let page = await application.firstWindow();
    await expect(page.getByRole('heading', {name: 'Set Up Your Database'})).toBeVisible();
    expect(
      await page.evaluate(() => window.shopThings!.telemetry.status())
    ).toMatchObject({status: 'success', value: {activeEnabled: false}});
    await page.getByRole('button', {name: 'Create database', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    const databaseSettings = await readFile(join(directory, 'database.json'), 'utf8');
    const result = await page.evaluate(
      dsn =>
        window.shopThings!.telemetry.save({
          dsn,
          sampling: {errors: 100, traces: 100, logs: 100, metrics: 100},
        }),
      dsn
    );
    expect(result).toMatchObject({
      status: 'success',
      value: {savedDsn: dsn, activeEnabled: false, restartRequired: true},
    });
    await page.waitForTimeout(1000);
    expect(envelopes).toEqual([]);
    await application.close();
    application = await launchElectron(directory, launchEnvironment);
    page = await application.firstWindow();
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    expect(
      await page.evaluate(() => window.shopThings!.telemetry.status())
    ).toMatchObject({
      status: 'success',
      value: {activeDsn: dsn, activeEnabled: true, restartRequired: false},
    });
    const sentinel = 'PRIVATE_SENTINEL_customer_email_path_sql_query';
    const customerAttributes = {
      customerNumber: 73021,
      stock: 9,
      previousBalance: '-100.00',
      balance: '134.25',
      donate: false,
      firstName: sentinel,
      lastName: sentinel,
      address: sentinel,
      city: sentinel,
      province: sentinel,
      postalCode: sentinel,
      phone: sentinel,
      email: `${sentinel}@example.com`,
      comments: sentinel,
      id: sentinel,
      customer: {email: sentinel},
    };
    await page.evaluate(attributes => {
      const carrier = Reflect.get(Reflect.get(globalThis, '__SENTRY__'), '11.4.0');
      const scope = carrier.acs?.getCurrentScope() ?? carrier.defaultCurrentScope;
      scope.setAttributes(attributes);
      scope.setUser({
        id: attributes.id,
        email: attributes.email,
        username: attributes.firstName,
      });
    }, customerAttributes);
    await application.evaluate((_electron, attributes) => {
      const carrier = Reflect.get(Reflect.get(globalThis, '__SENTRY__'), '11.4.0');
      const scope = carrier.acs?.getCurrentScope() ?? carrier.defaultCurrentScope;
      scope.setAttributes(attributes);
      scope.setUser({
        id: attributes.id,
        email: attributes.email,
        username: attributes.firstName,
      });
    }, customerAttributes);
    await page.evaluate(async sentinel => {
      const status = await window.shopThings!.database.status();
      if (status.status !== 'success' || !status.value.session) {
        throw new Error('Database did not start.');
      }

      const values = {
        firstName: sentinel,
        lastName: sentinel,
        address: sentinel,
        city: sentinel,
        province: sentinel,
        postalCode: sentinel,
        phone: sentinel,
        email: `${sentinel}@example.com`,
        stock: 0,
        balance: '0.00',
        previousBalance: '0.00',
        donate: false,
        comments: sentinel,
      };
      const created = await window.shopThings!.customers.create({
        session: status.value.session,
        values,
      });
      if (created.status !== 'success') {
        throw new Error('Could not seed privacy record.');
      }

      await window.shopThings!.customers.list({
        session: status.value.session,
        query: sentinel,
      });
    }, sentinel);
    await application.evaluate((_electron, sentinel) => {
      Reflect.set(globalThis, 'acceptanceNativeMonitoringFault', sentinel);
    }, sentinel);
    await page.getByRole('button', {name: 'Refresh customers'}).click();
    await expect(page.getByRole('button', {name: 'Retry refresh'})).toBeVisible();
    await page.evaluate(sentinel => {
      window.dispatchEvent(
        new ErrorEvent('error', {
          message: sentinel,
          error: null,
        })
      );
      setTimeout(() => {
        throw new RangeError(sentinel);
      }, 0);
    }, sentinel);
    await application.evaluate((_electron, sentinel) => {
      setTimeout(() => {
        throw new URIError(sentinel);
      }, 0);
    }, sentinel);
    await page.getByRole('button', {name: 'Retry refresh'}).click();
    await page.getByRole('link', {name: `${sentinel} ${sentinel}`, exact: true}).click();
    await expect(
      page.getByRole('textbox', {name: 'First name', exact: true})
    ).toHaveValue(sentinel);
    await page.getByRole('link', {name: 'Back to customers'}).click();
    await page.getByRole('link', {name: 'Add customer', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'New Customer', exact: true})
    ).toBeVisible();
    await page.getByRole('link', {name: 'Customer records Shop Things'}).click();
    await page.getByRole('link', {name: 'Database settings', exact: true}).click();
    const importPath = join(directory, 'PRIVATE_SENTINEL_import.csv');
    await writeFile(
      importPath,
      'customerNumber,firstName,lastName,address,city,province,postalCode,phone,email,stock,balance,previousBalance,donate,comments\n,PRIVATE_SENTINEL_import,,,,,,,,0,0.00,0.00,false,\n'
    );
    await application.evaluate((_electron, path) => {
      Reflect.get(globalThis, 'acceptanceFiles').push({path});
    }, importPath);
    await page.getByRole('button', {name: 'Import customers', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Import Customers', exact: true})
    ).toBeVisible();
    await page.getByRole('button', {name: 'Cancel', exact: true}).click();
    await page.evaluate(() => window.shopThings!.database.status());
    type Signal = {
      name?: string;
      trace_id?: string;
      span_id?: string;
      tags?: {process?: string};
      attributes?: Record<string, {value: unknown}>;
    };
    function signals(type: string, process: string, start = 0): Signal[] {
      return envelopes.slice(start).flatMap(envelope => {
        const lines = envelope.trim().split('\n');
        const found: Signal[] = [];
        for (let index = 1; index + 1 < lines.length; index += 2) {
          if (JSON.parse(lines[index]!).type !== type) {
            continue;
          }

          const payload = JSON.parse(lines[index + 1]!);
          const items: Signal[] = payload.items ?? [payload];
          found.push(
            ...items.filter(
              item =>
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
          .poll(
            () => signals(type, process).length,
            {timeout: 25000},
            `${process} ${type} delivered`
          )
          .toBeGreaterThan(0);
      }
    }

    const nativeTransport = await application.evaluate(
      ({ipcMain, session, utilityProcess}) => ({
        partitions: Reflect.get(globalThis, 'acceptanceMonitoringPartitions'),
        persistent: session.fromPartition('sentry-electron').isPersistent(),
        sdkListeners: ipcMain
          .eventNames()
          .filter(name => String(name).startsWith('sentry-ipc')),
        sdkHandlers: Reflect.get(globalThis, 'acceptanceIpcHandlers').filter(
          (name: string) => name.startsWith('sentry-ipc')
        ),
        utilityForkUnchanged:
          utilityProcess.fork === Reflect.get(globalThis, 'acceptanceUtilityFork'),
      })
    );
    expect(nativeTransport.partitions.length).toBeGreaterThan(0);
    expect(
      nativeTransport.partitions.every((name: string) => name === 'sentry-electron')
    ).toBe(true);
    expect(nativeTransport.persistent).toBe(false);
    expect(nativeTransport.sdkListeners).toEqual([]);
    expect(nativeTransport.sdkHandlers).toEqual([]);
    expect(nativeTransport.utilityForkUnchanged).toBe(true);

    for (const route of [
      '/customers/$customerId',
      '/customers/new',
      '/customers/import',
    ]) {
      await expect
        .poll(
          () =>
            signals('span', 'renderer').some(
              item =>
                item.name === route &&
                item.attributes?.['sentry.op']?.value === 'navigation'
            ),
          {timeout: 15000}
        )
        .toBe(true);
    }

    expect(
      signals('span', 'renderer').some(
        item => item.attributes?.['sentry.op']?.value === 'pageload'
      )
    ).toBe(true);
    expect(
      signals('span', 'renderer').some(item => item.name === 'application.operation')
    ).toBe(false);

    expect(JSON.stringify(signals('event', 'main'))).toContain('"type":"TypeError"');
    await expect
      .poll(() => JSON.stringify(signals('event', 'main')), {timeout: 15000})
      .toContain('"type":"URIError"');
    expect(JSON.stringify(signals('event', 'renderer'))).toContain('"type":"RangeError"');
    expect(signals('event', 'main')).toHaveLength(2);
    expect(signals('event', 'renderer')).toHaveLength(1);
    for (const process of ['main', 'renderer']) {
      const span = signals('span', process).find(item => item.name === 'database.status');
      expect(span).toBeDefined();
      expect(span?.attributes?.['sentry.op']?.value).toBe(
        process === 'main' ? 'application.phase' : 'application.client'
      );
      await expect
        .poll(
          () =>
            signals('log', process).some(
              item =>
                item.trace_id === span?.trace_id &&
                item.attributes?.['sentry.trace.parent_span_id']?.value ===
                  span?.span_id &&
                item.attributes?.action?.value === 'database.status'
            ),
          {timeout: 15000}
        )
        .toBe(true);
      expect(
        signals('trace_metric', process).some(
          item =>
            item.trace_id === span?.trace_id &&
            item.span_id === span?.span_id &&
            item.attributes?.action?.value === 'database.status'
        )
      ).toBe(true);
    }

    for (const process of ['main', 'renderer']) {
      for (const type of ['log', 'trace_metric']) {
        await expect
          .poll(
            () =>
              signals(type, process).some(
                item =>
                  item.attributes?.customerNumber?.value === 73021 &&
                  item.attributes?.stock?.value === 9 &&
                  item.attributes?.previousBalance?.value === '-100.00' &&
                  item.attributes?.balance?.value === '134.25' &&
                  item.attributes?.donate?.value === false
              ),
            {timeout: 15000}
          )
          .toBe(true);
      }
    }

    for (const [index, failure] of ['reject', 'malformed'].entries()) {
      await application.evaluate((_electron, failure) => {
        Reflect.set(globalThis, 'acceptanceFault', {
          channel: 'shop-things:customers.list',
          before: true,
          [failure]: true,
          error: {message: 'PRIVATE_SENTINEL_transport'},
        });
      }, failure);
      await page
        .getByRole('button', {
          name: index === 0 ? 'Refresh customers' : 'Retry refresh',
        })
        .click();
      await expect(page.getByRole('button', {name: 'Retry refresh'})).toBeVisible();
      await expect
        .poll(() => signals('event', 'renderer').length, {timeout: 15000})
        .toBe(index + 2);
    }

    await page.getByRole('button', {name: 'Retry refresh'}).click();
    await expect(page.getByRole('button', {name: 'Refresh customers'})).toBeVisible();

    expect(await readFile(join(directory, 'database.json'), 'utf8')).toBe(
      databaseSettings
    );
    const payloads = envelopes.join('\n');
    await testInfo.attach('monitoring-envelopes.json', {
      body: JSON.stringify(envelopes, null, 2),
      contentType: 'application/json',
    });
    expect(payloads).not.toContain(sentinel);
    expect(payloads).not.toContain(directory);
    expect(payloads).not.toContain(dsn);
    expect(payloads).not.toContain('PRIVATE_SENTINEL');
    expect(payloads).not.toContain('a'.repeat(32));
    expect(payloads).not.toContain('b'.repeat(16));
    expect(payloads).not.toContain('"request":');
    expect(payloads).not.toContain('"user":');
    expect(payloads).not.toContain('"breadcrumbs":');
    expect(payloads).not.toContain('"server_name":');
    expect(payloads).not.toContain('"url.full":');
    expect(payloads).not.toContain('"url.path":');
    expect(payloads).not.toContain('"params.customerId":');
    expect(payloads).not.toContain('"url.path.parameter.customerId":');
    expect(JSON.parse(await readFile(join(directory, 'telemetry.json'), 'utf8'))).toEqual(
      {dsn, sampling: {errors: 100, traces: 100, logs: 100, metrics: 100}}
    );
    const changedDsn = `http://public@127.0.0.1:${address.port}/2`;
    await page.getByRole('link', {name: 'Database settings', exact: true}).click();
    await page.getByRole('textbox', {name: 'Sentry DSN'}).fill(changedDsn);
    await page.getByRole('spinbutton', {name: 'Error sampling (%)'}).fill('0');
    await page.getByRole('spinbutton', {name: 'Trace sampling (%)'}).fill('0');
    await page.getByRole('button', {name: 'Save monitoring'}).click();
    await expect(page.getByRole('status')).toContainText('Restart Shop Things');
    expect(
      await page.evaluate(() => window.shopThings!.telemetry.status())
    ).toMatchObject({
      value: {
        activeDsn: dsn,
        savedDsn: changedDsn,
        activeSampling: {errors: 100, traces: 100, logs: 100, metrics: 100},
        savedSampling: {errors: 0, traces: 0, logs: 100, metrics: 100},
        restartRequired: true,
      },
    });
    await page.evaluate(() => {
      setTimeout(() => {
        throw new SyntaxError('PRIVATE_SENTINEL_sampling');
      }, 0);
    });
    await application.evaluate(() => {
      setTimeout(() => {
        throw new SyntaxError('PRIVATE_SENTINEL_sampling');
      }, 0);
    });
    await expect.poll(() => signals('event', 'renderer').length).toBe(4);
    await expect.poll(() => signals('event', 'main').length).toBe(3);
    expect(destinations.some(value => value.startsWith('/api/2/'))).toBe(false);
    await page.screenshot({path: testInfo.outputPath('settings.png'), fullPage: true});
    await testInfo.attach('settings.png', {
      path: testInfo.outputPath('settings.png'),
      contentType: 'image/png',
    });
    await application.close();
    const samplingStart = envelopes.length;
    application = await launchElectron(directory, launchEnvironment);
    page = await application.firstWindow();
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    expect(
      await page.evaluate(() => window.shopThings!.telemetry.status())
    ).toMatchObject({
      value: {
        activeDsn: changedDsn,
        activeSampling: {errors: 0, traces: 0, logs: 100, metrics: 100},
        restartRequired: false,
      },
    });
    await page.evaluate(() => {
      setTimeout(() => {
        throw new SyntaxError('PRIVATE_SENTINEL_sampling');
      }, 0);
    });
    await application.evaluate(() => {
      setTimeout(() => {
        throw new SyntaxError('PRIVATE_SENTINEL_sampling');
      }, 0);
    });
    await expect
      .poll(() => destinations.some(value => value.startsWith('/api/2/')), {
        timeout: 15000,
      })
      .toBe(true);
    await page.getByRole('link', {name: 'Database settings', exact: true}).click();
    await page.getByRole('spinbutton', {name: 'Log sampling (%)'}).fill('0');
    await page.getByRole('button', {name: 'Save monitoring'}).click();
    await expect(page.getByRole('status')).toContainText('Restart Shop Things');
    expect(
      await page.evaluate(() => window.shopThings!.telemetry.status())
    ).toMatchObject({
      value: {
        activeDsn: changedDsn,
        activeEnabled: true,
        activeSampling: {errors: 0, traces: 0, logs: 100, metrics: 100},
        restartRequired: true,
      },
    });
    for (const process of ['main', 'renderer']) {
      await expect
        .poll(() => signals('log', process, samplingStart).length, {timeout: 15000})
        .toBeGreaterThan(0);
      await expect
        .poll(() => signals('trace_metric', process, samplingStart).length, {
          timeout: 15000,
        })
        .toBeGreaterThan(0);
    }

    await application.close();
    for (const process of ['main', 'renderer']) {
      expect(signals('event', process, samplingStart)).toEqual([]);
      expect(signals('span', process, samplingStart)).toEqual([]);
    }

    expect(envelopes.join('\n')).not.toContain('PRIVATE_SENTINEL_sampling');
    await testInfo.attach('monitoring-sampling-envelopes.json', {
      body: JSON.stringify(envelopes.slice(samplingStart), null, 2),
      contentType: 'application/json',
    });
    for (const sampling of [
      {errors: 0, traces: 0, logs: 0, metrics: 100},
      {errors: 0, traces: 0, logs: 100, metrics: 0},
      {errors: 0, traces: 0, logs: 0, metrics: 0},
    ]) {
      const signalStart = envelopes.length;
      application = await launchElectron(directory, launchEnvironment);
      page = await application.firstWindow();
      await expect(
        page.getByRole('heading', {name: 'Customers', exact: true})
      ).toBeVisible();
      expect(
        await page.evaluate(() => window.shopThings!.telemetry.status())
      ).toMatchObject({
        value: {activeDsn: changedDsn, activeSampling: sampling, restartRequired: false},
      });
      await page.evaluate(() => {
        setTimeout(() => {
          throw new SyntaxError('PRIVATE_SENTINEL_sampling');
        }, 0);
      });
      await application.evaluate(() => {
        setTimeout(() => {
          throw new SyntaxError('PRIVATE_SENTINEL_sampling');
        }, 0);
      });
      await page.getByRole('link', {name: 'Database settings', exact: true}).click();
      for (const process of ['main', 'renderer']) {
        if (sampling.logs > 0) {
          await expect
            .poll(() => signals('log', process, signalStart).length, {timeout: 15000})
            .toBeGreaterThan(0);
        }

        if (sampling.metrics > 0) {
          await expect
            .poll(() => signals('trace_metric', process, signalStart).length, {
              timeout: 15000,
            })
            .toBeGreaterThan(0);
        }
      }

      const next =
        sampling.logs === 0 && sampling.metrics === 100
          ? {logs: 100, metrics: 0}
          : {logs: 0, metrics: 0};
      await page
        .getByRole('spinbutton', {name: 'Log sampling (%)'})
        .fill(String(next.logs));
      await page
        .getByRole('spinbutton', {name: 'Metric sampling (%)'})
        .fill(String(next.metrics));
      if (sampling.logs === 0 && sampling.metrics === 0) {
        await page.getByRole('textbox', {name: 'Sentry DSN'}).fill('');
      }

      await page.getByRole('button', {name: 'Save monitoring'}).click();
      await expect(page.getByRole('status')).toContainText('Restart Shop Things');
      expect(
        await page.evaluate(() => window.shopThings!.telemetry.status())
      ).toMatchObject({
        value: {activeDsn: changedDsn, activeSampling: sampling, restartRequired: true},
      });
      await page.waitForTimeout(1500);
      await application.close();
      for (const process of ['main', 'renderer']) {
        expect(signals('event', process, signalStart)).toEqual([]);
        expect(signals('span', process, signalStart)).toEqual([]);
        if (sampling.logs === 0) {
          expect(signals('log', process, signalStart)).toEqual([]);
        }

        if (sampling.metrics === 0) {
          expect(signals('trace_metric', process, signalStart)).toEqual([]);
        }
      }

      if (sampling.logs === 0 && sampling.metrics === 0) {
        expect(envelopes.slice(signalStart)).toEqual([]);
      }

      await testInfo.attach(
        `monitoring-logs-${sampling.logs}-metrics-${sampling.metrics}.json`,
        {
          body: JSON.stringify(envelopes.slice(signalStart), null, 2),
          contentType: 'application/json',
        }
      );
    }

    expect(envelopes.join('\n')).not.toContain('PRIVATE_SENTINEL');
    const before = envelopes.length;
    application = await launchElectron(directory, launchEnvironment);
    page = await application.firstWindow();
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    expect(
      await page.evaluate(() => window.shopThings!.telemetry.status())
    ).toMatchObject({
      value: {activeDsn: null, activeEnabled: false, restartRequired: false},
    });
    await page.evaluate(() => window.shopThings!.database.status());
    await page.waitForTimeout(1500);
    expect(envelopes.length).toBe(before);
    expect(unselectedDeliveries).toBe(0);
  } finally {
    await application.close().catch(() => {});
    await new Promise<void>(resolve => server.close(() => resolve())).catch(() => {});
    await new Promise<void>(resolve => unselected.close(() => resolve())).catch(() => {});
    await rm(directory, {recursive: true, force: true}).catch(() => {});
  }
});

test('Settings can save while actual database startup is held and corrupt monitoring settings keep recovery usable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-held-settings-'));
  let application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_DELAY_STARTUP: 'true',
  });
  try {
    let page = await application.firstWindow();
    await page.getByRole('link', {name: 'Settings', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Settings', exact: true})
    ).toBeVisible();
    expect(
      await application.evaluate(() =>
        Boolean(Reflect.get(globalThis, 'acceptanceReleaseStartup'))
      )
    ).toBe(true);
    const input = page.getByRole('textbox', {name: 'Sentry DSN'});
    await input.fill('http://public@localhost:9000/1');
    await page.getByRole('button', {name: 'Save monitoring'}).click();
    await expect(page.getByRole('status')).toContainText('Restart Shop Things');
    expect(
      await page.evaluate(() => window.shopThings!.telemetry.status())
    ).toMatchObject({value: {activeEnabled: false, restartRequired: true}});
    await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceReleaseStartup')()
    );
    await page.getByRole('link', {name: 'Back to setup'}).click();
    await expect(page.getByRole('heading', {name: 'Settings', exact: true})).toHaveCount(
      0
    );
    await expect(page.getByRole('heading', {name: 'Set Up Your Database'})).toBeVisible();
    await application.close();
    await writeFile(join(directory, 'telemetry.json'), '{broken');
    application = await launchElectron(directory);
    page = await application.firstWindow();
    await page.getByRole('link', {name: 'Settings', exact: true}).click();
    await expect(page.getByRole('textbox', {name: 'Sentry DSN'})).toHaveValue('');
    await expect(page.getByRole('status')).toContainText('Monitoring is off');
  } finally {
    await application
      .evaluate(() => Reflect.get(globalThis, 'acceptanceReleaseStartup')?.())
      .catch(() => {});
    await application.close().catch(() => {});
    await rm(directory, {recursive: true, force: true}).catch(() => {});
  }
});
