import {expect, test} from '@playwright/test';

const lightBackground = 'rgb(241, 245, 242)';
const darkBackground = 'rgb(18, 33, 27)';
const darkSurface = 'rgb(25, 43, 36)';
const darkText = 'rgb(226, 238, 231)';

test('System follows live device changes and explicit choices persist across reloads', async ({
  page,
}) => {
  await page.emulateMedia({colorScheme: 'light'});
  await page.goto('/?preview=true#/settings/appearance');
  const root = page.locator('html');
  await expect(page.getByRole('radio', {name: 'System', exact: true})).toBeChecked();
  await expect(root).toHaveCSS('background-color', lightBackground);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.emulateMedia({colorScheme: 'dark'});
  await expect(root).toHaveCSS('background-color', darkBackground);
  await expect(root).toHaveCSS('color-scheme', 'dark');
  await page.getByRole('radio', {name: 'Light', exact: true}).check();
  await expect(root).toHaveCSS('background-color', lightBackground);
  await expect(root).toHaveCSS('color-scheme', 'light');
  await page.reload();
  await expect(page.getByRole('radio', {name: 'Light', exact: true})).toBeChecked();
  await expect(root).toHaveCSS('background-color', lightBackground);
  await page.getByRole('radio', {name: 'Dark', exact: true}).check();
  await page.emulateMedia({colorScheme: 'light'});
  await page.reload();
  await expect(page.getByRole('radio', {name: 'Dark', exact: true})).toBeChecked();
  await expect(root).toHaveCSS('background-color', darkBackground);
  await expect(root).toHaveCSS('color-scheme', 'dark');
  await page.getByRole('radio', {name: 'System', exact: true}).check();
  await expect(root).toHaveCSS('background-color', lightBackground);
  await page.emulateMedia({colorScheme: 'dark'});
  await expect(root).toHaveCSS('background-color', darkBackground);
  expect(await page.evaluate(() => localStorage.getItem('shop-things.appearance'))).toBe(
    'system'
  );
});

test('blocked storage preserves an immediate in-memory selection', async ({page}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage unavailable', 'SecurityError');
      },
    });
  });
  await page.emulateMedia({colorScheme: 'light'});
  await page.goto('/#/settings/appearance');
  await expect(page.getByRole('radio', {name: 'System', exact: true})).toBeChecked();
  await page.getByRole('radio', {name: 'Dark', exact: true}).check();
  await expect(page.getByRole('radio', {name: 'Dark', exact: true})).toBeChecked();
  await expect(page.locator('html')).toHaveCSS('background-color', darkBackground);
  await page.reload();
  await expect(page.getByRole('radio', {name: 'System', exact: true})).toBeChecked();
  await expect(page.locator('html')).toHaveCSS('background-color', lightBackground);
});

for (const preference of ['dark', 'system']) {
  test(`${preference} styles the document while telemetry is unresolved`, async ({
    page,
  }) => {
    await page.addInitScript(preference => {
      if (preference !== 'system') {
        localStorage.setItem('shop-things.appearance', preference);
      }

      const methods = new Proxy(
        {},
        {
          get: () => () => new Promise(() => {}),
        }
      );
      Reflect.set(
        window,
        'shopThings',
        new Proxy(
          {},
          {
            get: (_, group) =>
              group === 'telemetry'
                ? {
                    status: () => {
                      Reflect.set(window, 'appearanceTelemetryWaiting', true);
                      return new Promise(() => {});
                    },
                    save: () => new Promise(() => {}),
                  }
                : methods,
          }
        )
      );
    }, preference);
    await page.emulateMedia({colorScheme: 'dark'});
    await page.goto('/#/settings/appearance', {waitUntil: 'domcontentloaded'});
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'appearanceTelemetryWaiting')))
      .toBe(true);
    await expect(page.locator('#root')).toBeEmpty();
    await expect(page.locator('html')).toHaveCSS('background-color', darkBackground);
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
    await page.emulateMedia({colorScheme: 'light'});
    await expect(page.locator('html')).toHaveCSS(
      'background-color',
      preference === 'system' ? lightBackground : darkBackground
    );
  });
}

test('dark colors reach combobox, discard dialog, and toast portals', async ({page}) => {
  await page.goto('/?preview=true#/settings/appearance');
  await page.getByRole('radio', {name: 'Dark', exact: true}).check();
  await page.getByRole('link', {name: 'Back to customers'}).click();
  await page.getByRole('link', {name: 'Add customer'}).click();
  await page.getByRole('button', {name: 'Province', exact: true}).click();
  const popup = page.getByRole('listbox').locator('..');
  await expect(popup).toHaveCSS('background-color', darkSurface);
  await expect(popup).toHaveCSS('color', darkText);
  expect(
    await popup.evaluate(element => document.getElementById('root')!.contains(element))
  ).toBe(false);
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', {name: 'First name', exact: true}).fill('Appearance');
  await page.getByRole('link', {name: 'Customer records Shop Things'}).click();
  const dialog = page.getByRole('dialog', {name: 'Discard Unsaved Changes?'});
  await expect(dialog).toHaveCSS('background-color', darkSurface);
  await expect(dialog).toHaveCSS('color', darkText);
  expect(
    await dialog.evaluate(element => document.getElementById('root')!.contains(element))
  ).toBe(false);
  await page.getByRole('button', {name: 'Stay', exact: true}).click();
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  const toast = page
    .getByText('Customer saved', {exact: true})
    .locator('..')
    .locator('..')
    .locator('..');
  await expect(toast).toHaveCSS('background-color', 'rgb(48, 108, 64)');
  await expect(toast).toHaveCSS('color', 'rgb(255, 255, 255)');
  expect(
    await toast.evaluate(element => document.getElementById('root')!.contains(element))
  ).toBe(false);
});

for (const width of [320, 375]) {
  test(`Appearance settings fit a ${width}px viewport`, async ({page}) => {
    await page.setViewportSize({width, height: 800});
    await page.goto('/#/settings/appearance');
    await expect(page.getByRole('group', {name: 'Color theme'})).toBeVisible();
    for (const name of ['Database', 'Monitoring', 'Appearance']) {
      await expect(page.getByRole('tab', {name, exact: true})).toBeInViewport();
    }

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(width);
  });
}
