import {mkdtemp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {_electron, expect, test, type ElectronApplication} from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const executablePath = createRequire(
  new URL('../packages/electron/package.json', import.meta.url)
)('electron');
function launch(directory: string) {
  return _electron.launch({
    executablePath,
    args: [join(root, 'acceptance/electron-entry.mjs')],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      SHOP_THINGS_ACCEPTANCE_DATA: directory,
      SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
      SHOP_THINGS_ACCEPTANCE_BOUNDARY: 'true',
      SHOP_THINGS_ACCEPTANCE_RECOVERY: 'true',
      VITE_DEV_SERVER_URL: '',
    },
  });
}

async function messages(application: ElectronApplication) {
  return application.evaluate(() => Reflect.get(globalThis, 'acceptanceBoundary'));
}

async function currentDocument(application: ElectronApplication) {
  return application.evaluate(
    () =>
      Reflect.get(globalThis, 'acceptanceBoundary')
        .incoming.filter(
          (message: {channel: string; result?: unknown}) =>
            message.channel === 'shop-things:document' &&
            typeof message.result === 'string'
        )
        .at(-1).result
  );
}

async function reload(application: ElectronApplication) {
  await application.evaluate(({Menu}) => {
    Menu.getApplicationMenu()!
      .items.find(item => item.label === 'View')!
      .submenu!.items.find(item => item.label === 'Reload')!
      .click();
  });
}

async function cleanup(application: ElectronApplication, directory: string) {
  await application.evaluate(({BrowserWindow}) => {
    Reflect.set(globalThis, 'acceptanceDiscard', true);
    const mainId = Reflect.get(globalThis, 'acceptanceBoundary').incoming.find(
      (message: {channel: string; result?: unknown}) =>
        message.channel === 'shop-things:document' && typeof message.result === 'string'
    ).wc;
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.id !== mainId) {
        window.destroy();
      }
    }
  });
  await application.close();
  await rm(directory, {recursive: true, force: true});
}

test('wrong window and replaced document IPC are denied before native work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-boundary-'));
  const application = await launch(directory);
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    expect(
      await page.evaluate(() => [
        Reflect.has(window, 'shopThings'),
        Reflect.has(window, 'acceptanceBoundaryRaw'),
      ])
    ).toEqual([true, true]);
    const original = await currentDocument(application);
    const state = await page.evaluate(
      documentId =>
        Reflect.get(window, 'acceptanceBoundaryRaw').invoke(
          'shop-things:database.status',
          {documentId, arguments: undefined}
        ),
      original
    );
    expect(state.status).toBe('success');
    const pickers = await application.evaluate(
      () => Reflect.get(globalThis, 'acceptancePickers').length
    );
    const opened = application.waitForEvent('window');
    const wrongId = await application.evaluate(({BrowserWindow}) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      void window.loadURL('about:blank');
      return window.webContents.id;
    });
    const wrong = await opened;
    await wrong.waitForFunction(() => Reflect.has(window, 'acceptanceBoundaryRaw'));
    expect(
      (
        await wrong.evaluate(
          documentId =>
            Reflect.get(window, 'acceptanceBoundaryRaw').invoke(
              'shop-things:database.create',
              {documentId, arguments: undefined}
            ),
          original
        )
      ).error.code
    ).toBe('UNAUTHORIZED');
    await application.evaluate(
      ({BrowserWindow}, id) =>
        BrowserWindow.getAllWindows()
          .find(window => window.webContents.id === id)!
          .destroy(),
      wrongId
    );
    await reload(application);
    await expect.poll(() => currentDocument(application)).not.toBe(original);
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    expect(
      (
        await page.evaluate(
          documentId =>
            Reflect.get(window, 'acceptanceBoundaryRaw').invoke(
              'shop-things:database.create',
              {documentId, arguments: undefined}
            ),
          original
        )
      ).error.code
    ).toBe('UNAUTHORIZED');
    const observed = (await messages(application)).incoming.filter(
      (message: {channel: string}) => message.channel === 'shop-things:database.create'
    );
    expect(observed).toHaveLength(2);
    expect(observed.map((message: {main: boolean}) => message.main)).toEqual([
      true,
      true,
    ]);
    expect(observed[0].wc).toBe(wrongId);
    expect(observed[1].wc).not.toBe(wrongId);
    expect(observed[0].payload.documentId).toBe(original);
    expect(
      observed.every(
        (message: {result: {error: {code: string}}}) =>
          message.result.error.code === 'UNAUTHORIZED'
      )
    ).toBe(true);
    expect(
      await application.evaluate(
        () => Reflect.get(globalThis, 'acceptancePickers').length
      )
    ).toBe(pickers);
    expect(
      await page.evaluate(() => Reflect.get(window, 'shopThings').database.status())
    ).toEqual(state);
  } finally {
    await cleanup(application, directory);
  }
});

test('one application subscription and participant span route/editor mounts and retired documents receive no new state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-boundary-cleanup-'));
  const application = await launch(directory);
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    const first = await currentDocument(application);
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.getByRole('link', {name: 'Alpha One'}).click();
      await page.getByRole('button', {name: 'Edit customer'}).click();
      await expect(page.getByRole('textbox', {name: 'First name'})).toHaveValue('Alpha');
      await page.getByRole('link', {name: 'Cancel', exact: true}).click();
      await page.getByRole('link', {name: 'Add customer'}).click();
      await page.getByRole('link', {name: 'Cancel', exact: true}).click();
    }

    const before = await messages(application);
    const subscribed = before.incoming.filter(
      (message: {channel: string; result?: unknown}) =>
        message.channel === 'shop-things:state-subscribe' && message.result === true
    );
    const registered = before.incoming.filter(
      (message: {channel: string; result?: unknown}) =>
        message.channel === 'shop-things:draft-register' && message.result === true
    );
    expect(subscribed).toHaveLength(1);
    expect(registered).toHaveLength(1);
    expect(subscribed[0].payload.documentId).toBe(first);
    expect(registered[0].payload.documentId).toBe(first);
    expect(
      before.incoming.filter((message: {channel: string}) =>
        ['shop-things:state-unsubscribe', 'shop-things:draft-unregister'].includes(
          message.channel
        )
      )
    ).toHaveLength(0);
    await reload(application);
    await expect.poll(() => currentDocument(application)).not.toBe(first);
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    const second = await currentDocument(application);
    const replaced = await messages(application);
    const subscriptions = replaced.incoming.filter(
      (message: {channel: string; result?: unknown}) =>
        message.channel === 'shop-things:state-subscribe' && message.result === true
    );
    const participants = replaced.incoming.filter(
      (message: {channel: string; result?: unknown}) =>
        message.channel === 'shop-things:draft-register' && message.result === true
    );
    expect(subscriptions).toHaveLength(2);
    expect(participants).toHaveLength(2);
    expect(subscriptions[1].payload.documentId).toBe(second);
    expect(participants[1].payload.documentId).toBe(second);
    expect(subscriptions[1].payload.subscriptionId).not.toBe(
      subscriptions[0].payload.subscriptionId
    );
    expect(participants[1].payload.registrationId).not.toBe(
      participants[0].payload.registrationId
    );
    // A current frame cannot resurrect an old document's controls after replacement.
    expect(
      await page.evaluate(
        payload =>
          Reflect.get(window, 'acceptanceBoundaryRaw').invoke(
            'shop-things:state-subscribe',
            payload
          ),
        subscribed[0].payload
      )
    ).toBe(false);
    expect(
      await page.evaluate(
        payload =>
          Reflect.get(window, 'acceptanceBoundaryRaw').invoke(
            'shop-things:draft-register',
            payload
          ),
        registered[0].payload
      )
    ).toBe(false);
    const offset = replaced.outgoing.length;
    await application.evaluate(
      (_electron, path) => Reflect.get(globalThis, 'acceptanceFiles').push({path}),
      join(directory, 'customers.sqlite')
    );
    await page.getByRole('button', {name: 'Database', exact: true}).click();
    await page.getByRole('menuitem', {name: 'Open database', exact: true}).click();
    await expect(page.getByText('Database opened.', {exact: true})).toBeVisible();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    const final = await messages(application);
    const delivered = final.outgoing
      .slice(offset)
      .filter(
        (message: {channel: string}) => message.channel === 'shop-things:state-changed'
      );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload.subscriptionId).toBe(
      subscriptions[1].payload.subscriptionId
    );
    const prepared = final.outgoing
      .slice(offset)
      .filter(
        (message: {channel: string}) => message.channel === 'shop-things:draft-prepare'
      );
    expect(prepared).toHaveLength(1);
    expect(prepared[0].payload.registrationId).toBe(
      participants[1].payload.registrationId
    );
    expect(prepared[0].payload.request.documentId).toBe(second);
    const reply = final.incoming.find(
      (message: {channel: string; payload?: {reply?: {requestId: string}}}) =>
        message.channel === 'shop-things:draft-reply' &&
        message.payload?.reply?.requestId === prepared[0].payload.request.requestId
    );
    expect(reply.payload.reply.hasUnsavedDraft).toBe(false);
    expect(
      await application.evaluate(
        () => Reflect.get(globalThis, 'acceptanceDialogs').length
      )
    ).toBe(0);
  } finally {
    await cleanup(application, directory);
  }
});

test('the authorized webContents main frame succeeds while its actual child frame is rejected before service work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-frame-'));
  const application = await launch(directory);
  try {
    const primary = await application.firstWindow();
    await expect(primary.getByText('3 results', {exact: true})).toBeVisible();
    const opened = application.waitForEvent('window');
    const authorized = await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceCreateAuthorizedFrame')()
    );
    const page = await opened;
    await page.waitForFunction(() => Reflect.has(window, 'acceptanceBoundaryRaw'));
    function invoke(documentId: string) {
      return Reflect.get(window, 'acceptanceBoundaryRaw').invoke(
        'acceptance-frame:shop-things:database.status',
        {documentId, arguments: undefined}
      );
    }

    expect((await page.evaluate(invoke, authorized.documentId)).status).toBe('success');
    expect(
      await application.evaluate(() => Reflect.get(globalThis, 'acceptanceFrameCalls'))
    ).toEqual(['database.status']);
    await page.evaluate(() => {
      const iframe = document.createElement('iframe');
      iframe.src = 'data:text/html,<title>Authorized window child frame</title>';
      document.body.append(iframe);
    });
    const child = page.frames().find(frame => frame !== page.mainFrame())!;
    await child.waitForFunction(() => Reflect.has(window, 'acceptanceBoundaryRaw'));
    expect(await child.evaluate(invoke, authorized.documentId)).toMatchObject({
      status: 'error',
      error: {code: 'UNAUTHORIZED'},
    });
    expect(
      await application.evaluate(() => Reflect.get(globalThis, 'acceptanceFrameCalls'))
    ).toEqual(['database.status']);
    // The same authorized main frame remains usable after the rejected child call.
    expect((await page.evaluate(invoke, authorized.documentId)).status).toBe('success');
    const observed = (await messages(application)).incoming.filter(
      (message: {channel: string}) =>
        message.channel === 'acceptance-frame:shop-things:database.status'
    );
    expect(observed.map((message: {wc: number}) => message.wc)).toEqual([
      authorized.wc,
      authorized.wc,
      authorized.wc,
    ]);
    expect(observed.map((message: {main: boolean}) => message.main)).toEqual([
      true,
      false,
      true,
    ]);
    expect(
      await application.evaluate(() => Reflect.get(globalThis, 'acceptanceFrameCalls'))
    ).toEqual(['database.status', 'database.status']);
  } finally {
    await cleanup(application, directory);
  }
});
