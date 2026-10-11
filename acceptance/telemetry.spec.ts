import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {expect, test} from '@playwright/test';

import launchElectron from './launchElectron.js';

const dismissNotification = /^Dismiss (?:error|notification)$/;

const monitoringTabUrl = /#\/settings\/monitoring$/;
const customerKeys = ['customerNumber', 'stock', 'previousBalance', 'balance', 'donate'];

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
    SENTRY_ENVIRONMENT: 'PRIVATE_SENTINEL_environment',
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
    await expect(page.locator('meta[content^="connect-src"]')).toHaveAttribute(
      'content',
      "connect-src 'none'"
    );
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
    await expect(page.locator('meta[content^="connect-src"]')).toHaveAttribute(
      'content',
      `connect-src ${new URL(dsn).origin}`
    );
    const sentinel = 'PRIVATE_SENTINEL_customer_email_path_sql_query';
    const customerAttributes = {
      'sentry.message.template': 'PRIVATE_SENTINEL_template',
      'sentry.message.parameter.0': 'PRIVATE_SENTINEL_parameter',
      'sentry.message.parameter.1': 'PRIVATE_SENTINEL_parameter',
      'sentry.environment': 'PRIVATE_SENTINEL_scope_environment',
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
      customerNumber: 84213,
      stock: 83,
      previousBalance: '97.31',
      balance: '98.42',
      donate: true,
      'db.system.name': 'PRIVATE_SENTINEL_db_system',
      'db.operation.name': 'DELETE',
      'db.collection.name': 'sqlite_master',
      'db.query.method': 'exec',
      'db.query.text': 'SELECT "email" FROM "customers"',
      'db.statement': 'PRIVATE_SENTINEL_sql',
    };
    await page.evaluate(attributes => {
      const carrier = Reflect.get(Reflect.get(globalThis, '__SENTRY__'), '11.4.0');
      const scope = carrier.acs?.getCurrentScope() ?? carrier.defaultCurrentScope;
      scope.setAttributes(attributes);
      scope.setExtras(attributes);
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
      scope.setExtras(attributes);
      scope.setUser({
        id: attributes.id,
        email: attributes.email,
        username: attributes.firstName,
      });
      Reflect.set(globalThis, 'acceptanceObservePreparedQuery', true);
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
    await page.getByRole('textbox', {name: 'Phone', exact: true}).fill('');
    await page.getByRole('textbox', {name: 'Customer number', exact: true}).fill('73021');
    await page.getByRole('textbox', {name: 'Items in stock'}).fill('9');
    await page
      .getByRole('textbox', {name: 'Previous balance ($)', exact: true})
      .fill('-100');
    await page.getByRole('textbox', {name: 'Balance ($)', exact: true}).fill('134.25');
    await page.getByRole('button', {name: 'Save', exact: true}).click();
    await expect(page.getByText('Customer saved', {exact: true})).toBeVisible();
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    await page.getByRole('link', {name: `${sentinel} ${sentinel}`, exact: true}).click();
    await application.evaluate((_electron, sentinel) => {
      Reflect.set(globalThis, 'acceptanceNativeCustomerMonitoringFault', sentinel);
    }, sentinel);
    await page.getByRole('textbox', {name: 'Items in stock'}).fill('10');
    await page.getByRole('button', {name: 'Save', exact: true}).click();
    await expect(
      page.getByRole('main').getByRole('alert').filter({hasText: 'The operation failed.'})
    ).toBeVisible();
    await page.getByRole('button', {name: 'Save', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    await page.getByRole('link', {name: 'Add customer', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'New Customer', exact: true})
    ).toBeVisible();
    await page
      .getByRole('textbox', {name: 'First name', exact: true})
      .fill('PRIVATE_SENTINEL_created');
    await page.getByRole('textbox', {name: 'Items in stock'}).fill('4');
    await page
      .getByRole('textbox', {name: 'Previous balance ($)', exact: true})
      .fill('7.1');
    await page.getByRole('textbox', {name: 'Balance ($)', exact: true}).fill('8');
    await page.getByRole('checkbox', {name: 'Donate', exact: true}).check();
    await application.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceFault', {
        channel: 'shop-things:customers.create',
        before: true,
        reject: true,
        error: {message: 'PRIVATE_SENTINEL_transport'},
      });
    });
    await page.getByRole('button', {name: 'Save', exact: true}).click();
    await expect(
      page
        .getByRole('main')
        .getByRole('alert')
        .filter({hasText: 'The application could not complete the request.'})
    ).toBeVisible();
    await application.evaluate(() => {
      Reflect.set(
        globalThis,
        'acceptanceNativeCustomerMonitoringFault',
        'PRIVATE_SENTINEL_native_create'
      );
    });
    await page.getByRole('button', {name: 'Save', exact: true}).click();
    await expect(
      page.getByRole('main').getByRole('alert').filter({hasText: 'The operation failed.'})
    ).toBeVisible();
    await page.getByRole('button', {name: 'Save', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    await page.getByRole('link', {name: 'Database settings', exact: true}).click();
    const notifications = page.getByRole('button', {
      name: dismissNotification,
      includeHidden: true,
    });
    await notifications.evaluateAll(buttons => {
      for (const button of buttons) {
        if (button instanceof HTMLButtonElement) {
          button.click();
        }
      }
    });
    await expect(notifications).toHaveCount(0);
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
      body?: string;
      environment?: string;
      name?: string;
      trace_id?: string;
      span_id?: string;
      parent_span_id?: string;
      start_timestamp?: number;
      end_timestamp?: number;
      status?: string;
      tags?: Record<string, unknown>;
      extra?: Record<string, unknown>;
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

    const queryProbeStart = envelopes.length;
    const backupPath = join(directory, 'PRIVATE_SENTINEL_backup.sqlite');
    await application.evaluate(
      (_electron, probe) => {
        Reflect.set(globalThis, 'acceptanceQueryProbe', probe);
      },
      {sentinel, backupPath}
    );
    await page.evaluate(async () => {
      const status = await window.shopThings!.database.status();
      if (status.status !== 'success' || !status.value.session) {
        throw new Error('Database unavailable');
      }

      const result = await window.shopThings!.customers.list({
        session: status.value.session,
        query: 'PRIVATE_SENTINEL_search',
      });
      if (result.status !== 'success') {
        throw new Error('Probe changed list behavior');
      }
    });
    const probeParent = await application.evaluate(() => ({
      parent: Reflect.get(globalThis, 'acceptanceQueryProbeParent'),
      constraintFailed: Reflect.get(globalThis, 'acceptanceQueryConstraintFailed'),
      unknownFailed: Reflect.get(globalThis, 'acceptanceQueryUnknownFailed'),
      statusFailed: Reflect.get(globalThis, 'acceptanceQueryStatusFailed'),
    }));
    expect(probeParent.constraintFailed).toBe(true);
    expect(probeParent.unknownFailed).toBe(true);
    expect(probeParent.statusFailed).toBe(true);
    expect((await readFile(backupPath)).length).toBeGreaterThan(0);
    function probeQueries() {
      return signals('span', 'main', queryProbeStart).filter(
        item =>
          item.name === 'database.query' &&
          item.parent_span_id === probeParent.parent.span_id
      );
    }

    await expect.poll(() => probeQueries().length, {timeout: 25000}).toBe(8);
    expect(
      probeQueries()
        .map(item => String(item.attributes?.['db.query.method']?.value))
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(['all', 'all', 'all', 'all', 'get', 'run', 'run', 'run']);
    const queryFailures = probeQueries().filter(item => item.status === 'error');
    expect(queryFailures).toHaveLength(2);
    expect(
      queryFailures.some(
        item =>
          item.attributes?.['db.operation.name']?.value === 'INSERT' &&
          item.attributes?.['db.collection.name']?.value === 'customers'
      )
    ).toBe(true);
    const unknownQuery = queryFailures.find(
      item => item.attributes?.['db.operation.name']?.value === 'SELECT'
    );
    expect(unknownQuery?.attributes?.['db.query.text']).toBeUndefined();
    expect(unknownQuery?.attributes?.['db.collection.name']).toBeUndefined();
    const backupQuery = probeQueries().find(
      item => item.attributes?.['db.operation.name']?.value === 'VACUUM'
    );
    expect(backupQuery?.attributes?.['db.query.text']?.value).toBe('VACUUM INTO ?');
    expect(backupQuery?.attributes?.['db.collection.name']).toBeUndefined();
    for (const item of probeQueries()) {
      expect(item.trace_id).toBe(probeParent.parent.trace_id);
      expect(item.attributes?.['sentry.op']?.value).toBe('db.query');
      expect(item.attributes?.['db.system.name']?.value).toBe('sqlite');
      expect(item.attributes?.outcome?.value).toBe(
        item.status === 'error' ? 'error' : 'success'
      );
      expect(Number(item.attributes?.duration_ms?.value)).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(item.start_timestamp)).toBe(true);
      expect(Number.isFinite(item.end_timestamp)).toBe(true);
      expect(item.end_timestamp!).toBeGreaterThanOrEqual(item.start_timestamp!);
      for (const customerKey of customerKeys) {
        expect(item.attributes?.[customerKey]).toBeUndefined();
      }
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
        expect(
          signals(type, process).every(item =>
            type === 'event'
              ? item.environment === 'development'
              : item.attributes?.['sentry.environment']?.value === 'development'
          )
        ).toBe(true);
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
    await expect.poll(() => signals('event', 'main').length, {timeout: 15000}).toBe(4);
    await expect
      .poll(() => signals('event', 'renderer').length, {timeout: 15000})
      .toBe(2);
    expect(
      signals('event', 'main').some(
        item =>
          item.extra?.action === 'customers.update' &&
          item.tags?.action === 'customers.update' &&
          item.tags?.customerNumber === 73021 &&
          item.extra?.customerNumber === 73021 &&
          item.extra?.stock === 10 &&
          item.extra?.balance === '134.25' &&
          item.extra?.previousBalance === '-100.00' &&
          item.extra?.donate === false
      )
    ).toBe(true);
    for (const process of ['main', 'renderer']) {
      expect(
        signals('event', process).some(
          item =>
            item.extra?.action === 'customers.create' &&
            item.tags?.action === 'customers.create' &&
            item.tags?.stock === 4 &&
            item.extra?.stock === 4 &&
            item.extra?.balance === '8.00' &&
            item.extra?.previousBalance === '7.10' &&
            item.extra?.donate === true &&
            item.extra?.customerNumber === undefined &&
            item.tags?.customerNumber === undefined
        )
      ).toBe(true);
    }

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
                item.attributes?.action?.value === 'database.status' &&
                item.body === 'Application action database.status completed' &&
                item.attributes?.['sentry.message.template']?.value ===
                  'Application action %s completed' &&
                item.attributes?.['sentry.message.parameter.0']?.value ===
                  'database.status'
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

    const mainSpans = signals('span', 'main');
    function owningCustomerAction(item: (typeof mainSpans)[number]) {
      let current: Signal | undefined = item;
      const visited = new Set<string>();
      while (current?.span_id && !visited.has(current.span_id)) {
        if (current.name === 'customers.create' || current.name === 'customers.update') {
          return current;
        }

        visited.add(current.span_id);
        const traceId: Signal['trace_id'] = current.trace_id;
        const parentSpanId: Signal['parent_span_id'] = current.parent_span_id;
        current = mainSpans.find(
          parent => parent.trace_id === traceId && parent.span_id === parentSpanId
        );
      }

      return undefined;
    }

    for (const name of [
      'database.createCustomer',
      'database.updateCustomer',
      'database.query',
    ]) {
      const children = mainSpans.filter(
        item => item.name === name && owningCustomerAction(item)
      );
      expect(children.length, `${name} child spans`).toBeGreaterThan(0);
      for (const child of children) {
        const owner = owningCustomerAction(child)!;
        expect(child.attributes?.action?.value).toBe(owner.name);
        for (const key of customerKeys) {
          expect(child.attributes?.[key], `${name} ${key}`).toEqual(
            owner.attributes?.[key]
          );
        }
      }
    }

    for (const process of ['main', 'renderer']) {
      for (const type of ['event', 'span', 'log', 'trace_metric']) {
        const unrelated = signals(type, process).filter(item => {
          const action =
            type === 'event'
              ? item.extra?.action
              : type === 'span'
                ? item.name
                : item.attributes?.action?.value;
          return (
            action !== 'customers.create' &&
            action !== 'customers.update' &&
            !(type === 'span' && process === 'main' && owningCustomerAction(item))
          );
        });
        expect(unrelated.length, `${process} unrelated ${type}`).toBeGreaterThan(0);
        for (const item of unrelated) {
          for (const key of customerKeys) {
            expect(item.attributes?.[key], `${process} ${type} ${key}`).toBeUndefined();
            expect(item.extra?.[key], `${process} ${type} extra ${key}`).toBeUndefined();
            expect(item.tags?.[key], `${process} ${type} tag ${key}`).toBeUndefined();
          }
        }
      }

      for (const type of ['span', 'log', 'trace_metric']) {
        await expect
          .poll(
            () =>
              signals(type, process).some(
                item =>
                  (type === 'span' ? item.name : item.attributes?.action?.value) ===
                    'customers.update' &&
                  item.attributes?.customerNumber?.value === 73021 &&
                  item.attributes?.stock?.value === 9 &&
                  item.attributes?.previousBalance?.value === '-100.00' &&
                  item.attributes?.balance?.value === '134.25' &&
                  item.attributes?.donate?.value === false
              ),
            {timeout: 15000}
          )
          .toBe(true);
        await expect
          .poll(
            () =>
              signals(type, process).some(
                item =>
                  (type === 'span' ? item.name : item.attributes?.action?.value) ===
                    'customers.create' &&
                  item.attributes?.stock?.value === 4 &&
                  item.attributes?.previousBalance?.value === '7.10' &&
                  item.attributes?.balance?.value === '8.00' &&
                  item.attributes?.donate?.value === true &&
                  item.attributes?.customerNumber === undefined
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
        .toBe(index + 3);
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
    await page.getByRole('tab', {name: 'Monitoring'}).click();
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
    await expect.poll(() => signals('event', 'renderer').length).toBe(5);
    await expect.poll(() => signals('event', 'main').length).toBe(5);
    await page.evaluate(async () => {
      const carrier = Reflect.get(Reflect.get(globalThis, '__SENTRY__'), '11.4.0');
      await (carrier.acs?.getCurrentScope() ?? carrier.defaultCurrentScope)
        .getClient()
        .flush(1500);
    });
    await application.evaluate(async () => {
      const carrier = Reflect.get(Reflect.get(globalThis, '__SENTRY__'), '11.4.0');
      await (carrier.acs?.getCurrentScope() ?? carrier.defaultCurrentScope)
        .getClient()
        .flush(1500);
    });
    // Reinitialize the same production observer in a test-only client after the
    // global-error assertions; actual forms always submit the complete draft.
    await page.addScriptTag({
      path: fileURLToPath(
        new URL('../acceptance-reports/harness/telemetry-client.mjs', import.meta.url)
      ),
      type: 'module',
    });
    await page.waitForFunction(() => Reflect.has(window, 'acceptanceTelemetryClient'));
    await page.evaluate(async () => {
      const client = Reflect.get(window, 'acceptanceTelemetryClient');
      const status = await client.database.status();
      const records = await client.customers.list({
        session: status.value.session,
        query: '',
      });
      const record = records.value.find(
        (record: {customer: {customerNumber: number}}) =>
          record.customer.customerNumber === 73021
      );
      Reflect.set(window, 'acceptanceTelemetryReference', record.reference);
    });
    await application.evaluate(() => {
      Reflect.set(
        globalThis,
        'acceptanceNativeCustomerMonitoringFault',
        'PRIVATE_SENTINEL_partial_update'
      );
    });
    const partialStart = envelopes.length;
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'acceptanceTelemetryClient').customers.update({
          reference: Reflect.get(window, 'acceptanceTelemetryReference'),
          changes: {stock: 31},
        })
      )
    ).toMatchObject({status: 'error', error: {code: 'INTERNAL'}});
    for (const [index, failure] of ['reject', 'malformed'].entries()) {
      await application.evaluate((_electron, failure) => {
        Reflect.set(globalThis, 'acceptanceFault', {
          channel: 'shop-things:customers.update',
          before: true,
          [failure]: true,
          error: {message: 'PRIVATE_SENTINEL_partial_transport'},
        });
      }, failure);
      expect(
        await page.evaluate(
          stock =>
            Reflect.get(window, 'acceptanceTelemetryClient').customers.update({
              reference: Reflect.get(window, 'acceptanceTelemetryReference'),
              changes: {stock},
            }),
          32 + index
        )
      ).toMatchObject({status: 'error', error: {code: 'INTERNAL'}});
    }

    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'acceptanceTelemetryClient').customers.update({
          reference: Reflect.get(window, 'acceptanceTelemetryReference'),
          changes: {email: 'PRIVATE_SENTINEL_partial_email'},
        })
      )
    ).toMatchObject({status: 'success'});
    for (const process of ['main', 'renderer']) {
      for (const type of ['event', 'span', 'log', 'trace_metric']) {
        await expect
          .poll(
            () =>
              signals(type, process, partialStart).filter(
                item =>
                  (type === 'event'
                    ? item.extra?.action
                    : type === 'span'
                      ? item.name
                      : item.attributes?.action?.value) === 'customers.update' &&
                  (type === 'event'
                    ? item.extra?.stock
                    : item.attributes?.stock?.value) ===
                    (process === 'main' || type !== 'event' ? 31 : 32)
              ).length,
            {timeout: 15000},
            `${process} partial ${type}`
          )
          .toBeGreaterThan(0);
        for (const item of signals(type, process, partialStart)) {
          for (const key of customerKeys.filter(key => key !== 'stock')) {
            expect(item.attributes?.[key]).toBeUndefined();
            expect(item.extra?.[key]).toBeUndefined();
            expect(item.tags?.[key]).toBeUndefined();
          }
        }

        if (type !== 'event') {
          await expect
            .poll(
              () =>
                signals(type, process, partialStart).some(
                  item =>
                    (type === 'span' ? item.name : item.attributes?.action?.value) ===
                      'customers.update' && item.attributes?.stock === undefined
                ),
              {timeout: 15000},
              `${process} private-only partial ${type}`
            )
            .toBe(true);
        }
      }
    }

    await expect
      .poll(
        () =>
          signals('span', 'main', partialStart).some(
            item =>
              item.name === 'database.updateCustomer' &&
              item.attributes?.stock?.value === 31
          ),
        {timeout: 15000}
      )
      .toBe(true);

    await expect
      .poll(
        () =>
          signals('span', 'main', partialStart).filter(
            item => item.name === 'database.query' && item.attributes?.stock?.value === 31
          ).length,
        {timeout: 15000}
      )
      .toBe(1);
    await expect
      .poll(
        () =>
          signals('span', 'main', partialStart).some(
            item =>
              item.name === 'database.query' &&
              item.attributes?.action?.value === 'customers.update' &&
              customerKeys.every(key => item.attributes?.[key] === undefined)
          ),
        {timeout: 15000}
      )
      .toBe(true);

    const concurrentStart = envelopes.length;
    await application.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceConcurrentCustomerMonitoring', {});
    });
    await page.evaluate(() => {
      const client = Reflect.get(window, 'acceptanceTelemetryClient');
      const reference = Reflect.get(window, 'acceptanceTelemetryReference');
      Reflect.set(
        window,
        'acceptanceConcurrentMonitoring',
        client.customers.update({reference, changes: {stock: 41}})
      );
    });
    await expect
      .poll(() =>
        application!.evaluate(
          () =>
            Object.keys(Reflect.get(globalThis, 'acceptanceConcurrentCustomerMonitoring'))
              .length
        )
      )
      .toBe(1);
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'acceptanceTelemetryClient').customers.update({
          reference: Reflect.get(window, 'acceptanceTelemetryReference'),
          changes: {stock: 42},
        })
      )
    ).toMatchObject({status: 'error', error: {code: 'BUSY'}});
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'acceptanceTelemetryClient').database.status()
      )
    ).toMatchObject({status: 'success'});
    await expect
      .poll(
        () =>
          signals('span', 'main', concurrentStart).some(
            item =>
              item.name === 'customers.update' && item.attributes?.stock?.value === 42
          ),
        {timeout: 15000}
      )
      .toBe(true);
    expect(
      signals('span', 'main', concurrentStart).filter(
        item => item.name === 'database.query' && item.attributes?.stock?.value === 42
      )
    ).toHaveLength(0);

    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceConcurrentCustomerMonitoring')[41]();
    });
    expect(
      await page.evaluate(() => Reflect.get(window, 'acceptanceConcurrentMonitoring'))
    ).toMatchObject({status: 'error', error: {code: 'INTERNAL'}});
    await page.evaluate(() => {
      Reflect.set(
        window,
        'acceptanceConcurrentMonitoring',
        Reflect.get(window, 'acceptanceTelemetryClient').customers.update({
          reference: Reflect.get(window, 'acceptanceTelemetryReference'),
          changes: {stock: 42},
        })
      );
    });
    await expect
      .poll(() =>
        application!.evaluate(
          () =>
            Object.keys(Reflect.get(globalThis, 'acceptanceConcurrentCustomerMonitoring'))
              .length
        )
      )
      .toBe(2);
    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceConcurrentCustomerMonitoring')[42]();
    });
    expect(
      await page.evaluate(() => Reflect.get(window, 'acceptanceConcurrentMonitoring'))
    ).toMatchObject({status: 'error', error: {code: 'INTERNAL'}});
    for (const stock of [41, 42]) {
      await expect
        .poll(
          () =>
            signals('event', 'main', concurrentStart).some(
              item => item.extra?.stock === stock
            ),
          {timeout: 15000}
        )
        .toBe(true);
    }

    for (const stock of [41, 42]) {
      await expect
        .poll(
          () =>
            signals('span', 'main', concurrentStart).some(
              item =>
                item.name === 'database.updateCustomer' &&
                item.attributes?.stock?.value === stock
            ),
          {timeout: 15000}
        )
        .toBe(true);
      const child = signals('span', 'main', concurrentStart).find(
        item =>
          item.name === 'database.updateCustomer' &&
          item.attributes?.stock?.value === stock
      )!;
      const parent = signals('span', 'main', concurrentStart).find(
        item => item.span_id === child.parent_span_id && item.trace_id === child.trace_id
      );
      expect(parent?.name).toBe('customers.update');
      expect(parent?.attributes?.stock?.value).toBe(stock);
      for (const key of customerKeys.filter(key => key !== 'stock')) {
        expect(child.attributes?.[key]).toBeUndefined();
      }
    }

    for (const stock of [41, 42]) {
      await expect
        .poll(
          () =>
            signals('span', 'main', concurrentStart).filter(
              item =>
                item.name === 'database.query' && item.attributes?.stock?.value === stock
            ).length,
          {timeout: 15000}
        )
        .toBe(1);
      const query = signals('span', 'main', concurrentStart).find(
        item => item.name === 'database.query' && item.attributes?.stock?.value === stock
      )!;
      const phase = signals('span', 'main', concurrentStart).find(
        item => item.span_id === query.parent_span_id && item.trace_id === query.trace_id
      );
      expect(phase?.name).toBe('database.updateCustomer');
      expect(phase?.attributes?.stock?.value).toBe(stock);
      for (const customerKey of customerKeys.filter(key => key !== 'stock')) {
        expect(query.attributes?.[customerKey]).toBeUndefined();
      }
    }

    for (const type of ['span', 'log', 'trace_metric']) {
      await expect
        .poll(
          () =>
            signals(type, 'main', concurrentStart).some(
              item =>
                (type === 'span' ? item.name : item.attributes?.action?.value) ===
                'database.status'
            ),
          {timeout: 15000},
          `concurrent unrelated ${type}`
        )
        .toBe(true);
      const unrelated = signals(type, 'main', concurrentStart).filter(
        item =>
          (type === 'span' ? item.name : item.attributes?.action?.value) ===
          'database.status'
      );
      expect(unrelated.length).toBeGreaterThan(0);
      for (const item of unrelated) {
        for (const key of customerKeys) {
          expect(item.attributes?.[key]).toBeUndefined();
        }
      }
    }

    for (const process of ['main', 'renderer']) {
      for (const type of ['event', 'span', 'log', 'trace_metric']) {
        for (const item of signals(type, process)) {
          if (type === 'span' && item.name === 'database.query') {
            continue;
          }

          for (const fields of [item.attributes, item.tags, item.extra]) {
            expect(
              Object.keys(fields ?? {}).filter(key => key.startsWith('db.'))
            ).toEqual([]);
          }
        }
      }
    }

    await testInfo.attach('argument-provenance-envelopes.json', {
      body: JSON.stringify(envelopes, null, 2),
      contentType: 'application/json',
    });
    expect(envelopes.join('\n')).not.toContain('PRIVATE_SENTINEL');
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
    await page.getByRole('tab', {name: 'Monitoring'}).click();
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
      await page.getByRole('tab', {name: 'Monitoring'}).click();
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
    for (const process of ['main', 'renderer']) {
      for (const type of ['event', 'span', 'log', 'trace_metric']) {
        expect(
          signals(type, process).every(item =>
            type === 'event'
              ? item.environment === 'development'
              : item.attributes?.['sentry.environment']?.value === 'development'
          )
        ).toBe(true);
      }
    }

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
    await application
      .evaluate(() => {
        for (const release of Object.values(
          Reflect.get(globalThis, 'acceptanceConcurrentCustomerMonitoring') ?? {}
        )) {
          if (typeof release === 'function') {
            release();
          }
        }
      })
      .catch(() => {});
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
    await expect(page.getByRole('tab', {name: 'Database'})).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await page.getByRole('tab', {name: 'Monitoring'}).click();
    await expect(page).toHaveURL(monitoringTabUrl);
    await page.reload();
    await expect(page.getByRole('tab', {name: 'Monitoring'})).toHaveAttribute(
      'aria-selected',
      'true'
    );
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
    await page.getByRole('tab', {name: 'Monitoring'}).click();
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
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => {
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
