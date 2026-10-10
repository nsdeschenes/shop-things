import {expect, test} from '@playwright/test';

test('approved Back mounts the prior editor only after Stay preserves the invalid draft, then Forward restores saved data', async ({
  page,
}) => {
  await page.goto('/?preview=true');
  await page.getByRole('link', {name: 'Add customer'}).click();
  await page.getByRole('textbox', {name: 'First name'}).fill('History Probe');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Customers', exact: true})).toBeVisible();
  await page.getByRole('link', {name: 'History Probe', exact: true}).click();
  await expect(
    page.getByRole('heading', {name: 'History Probe', exact: true})
  ).toBeVisible();
  await page.getByRole('textbox', {name: 'Customer number', exact: true}).waitFor();
  const balance = page.getByRole('textbox', {name: 'Balance ($)', exact: true});
  await balance.fill('-');
  await page.evaluate(() => history.back());
  await expect(
    page.getByRole('dialog', {name: 'Discard Unsaved Changes?', exact: true})
  ).toBeVisible();
  await expect(page.getByRole('button', {name: 'Stay', exact: true})).toBeFocused();
  await page.getByRole('button', {name: 'Stay', exact: true}).click();
  await expect(balance).toHaveValue('-');
  expect(new URL(page.url()).hash).toBe('#/customers/1');
  await page.evaluate(() => history.back());
  await expect(
    page.getByRole('dialog', {name: 'Discard Unsaved Changes?', exact: true})
  ).toBeVisible();
  await page.getByRole('button', {name: 'Discard', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Customers', exact: true})).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/customers');
  await page.evaluate(() => history.forward());
  await expect(
    page.getByRole('heading', {name: 'History Probe', exact: true})
  ).toBeVisible();
  await page.getByRole('textbox', {name: 'Customer number', exact: true}).waitFor();
  await expect(page.getByRole('textbox', {name: 'Balance ($)', exact: true})).toHaveValue(
    '0.00'
  );
  await expect(
    page.getByRole('textbox', {name: 'Balance ($)', exact: true})
  ).toBeEnabled();
});
