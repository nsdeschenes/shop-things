import {expect, test} from '@playwright/test';

test('native preview unload warning preserves a dismissed invalid draft and accepted reload clears all temporary storage', async ({
  page,
  browser,
}) => {
  await page.goto('/?preview=true');
  await page.getByRole('link', {name: 'Add customer'}).click();
  await page.getByRole('textbox', {name: 'First name'}).fill('Unload Probe');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(
    page.getByRole('heading', {name: 'Unload Probe', exact: true})
  ).toBeVisible();
  await page.getByRole('button', {name: 'Edit customer'}).click();
  await page.getByRole('textbox', {name: 'Balance ($)', exact: true}).fill('-');
  let accept = false;
  const dialogs: string[] = [];
  page.on('dialog', async dialog => {
    dialogs.push(dialog.type());
    if (accept) {
      await dialog.accept();
    } else {
      await dialog.dismiss();
    }
  });
  await expect(page.reload({timeout: 10000})).rejects.toThrow();
  expect(dialogs).toEqual(['beforeunload']);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox', {name: 'Balance ($)', exact: true})).toHaveValue(
    '-'
  );
  accept = true;
  await page.reload();
  expect(dialogs).toEqual(['beforeunload', 'beforeunload']);
  await page.getByRole('link', {name: 'Customer records Shop Things'}).click();
  await expect(page.getByText('No customers yet', {exact: true})).toBeVisible();
  expect(
    await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      indexed: (await indexedDB.databases()).length,
      native: Reflect.has(window, 'shopThings'),
    }))
  ).toEqual({local: 0, session: 0, indexed: 0, native: false});
  test
    .info()
    .annotations.push({type: 'chromium-version', description: browser.version()});
});
