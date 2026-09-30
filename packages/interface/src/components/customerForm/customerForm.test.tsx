import {screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import renderRoute from '../../../test/renderRoute';

test('empty defaults validate on Save and preserve arbitrary contacts and exact balances', async () => {
  const user = userEvent.setup();
  const {application} = renderRoute('/customers/new');
  const name = await screen.findByRole('textbox', {name: 'First name'});
  expect(screen.getByRole('textbox', {name: 'Province'})).toHaveValue('');
  expect(
    screen.queryByRole('textbox', {name: 'Customer number'})
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', {name: 'Save'}));
  expect(
    await screen.findByText('Enter a first name, a last name, or both.')
  ).toBeVisible();
  await waitFor(() => expect(name).toHaveFocus());
  await user.type(name, 'Ada');
  await user.type(screen.getByRole('textbox', {name: 'Province'}), 'somewhere');
  await user.type(screen.getByRole('textbox', {name: 'Postal code'}), 'ab cd');
  await user.type(screen.getByRole('textbox', {name: 'Home phone'}), '+1 (902) 555-1234');
  await user.type(screen.getByRole('textbox', {name: 'Email address'}), 'contact text');
  const balance = screen.getByRole('textbox', {name: 'Balance ($)'});
  await user.clear(balance);
  await user.type(balance, '-1.23');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  expect(await screen.findByRole('heading', {name: 'Ada'})).toBeVisible();
  const session = application.getState().database!.session!;
  const record = await application.request(session, client =>
    client.customers.get({session, id: 1})
  );
  expect(record).toMatchObject({
    status: 'success',
    value: {
      customer: {
        customerNumber: 1,
        province: 'somewhere',
        postalCode: 'ab cd',
        homePhone: '+1 (902) 555-1234',
        email: 'contact text',
        balance: '-1.23',
      },
    },
  });
});

test('invalid decimal drafts and failed Save retain entered values and route guards', async () => {
  const user = userEvent.setup();
  const {application} = renderRoute('/customers/new');
  await user.type(await screen.findByRole('textbox', {name: 'First name'}), 'Ada');
  const stock = screen.getByRole('textbox', {name: 'Items in stock'});
  await user.clear(stock);
  await user.type(stock, '-');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  expect(stock).toHaveValue('-');
  expect(stock).toBeInvalid();
  await user.clear(stock);
  await user.type(stock, '0');
  const balance = screen.getByRole('textbox', {name: 'Balance ($)'});
  for (const value of ['-', '1.', '.5', '1.234']) {
    await user.clear(balance);
    await user.type(balance, value);
    await user.click(screen.getByRole('button', {name: 'Save'}));
    expect(screen.getByRole('heading', {name: 'New Customer'})).toBeVisible();
    expect(balance).toHaveValue(value);
    expect(application.protection.isDirty()).toBe(true);
  }

  await user.click(screen.getByRole('link', {name: 'Cancel'}));
  const stay = await screen.findByRole('button', {name: 'Stay'});
  await waitFor(() => expect(stay).toHaveFocus());
  await user.keyboard('{Enter}');
  expect(balance).toHaveValue('1.234');
});
