import {screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import renderRoute from '../../../test/renderRoute';
import previewCustomer from '../../fixtures/previewCustomer';
import customerFormOptions from '../../forms/customerFormOptions';
import customerFormSchema from '../../forms/customerFormSchema';

test('rejects invalid stock and prevents submission until it is a nonnegative integer', async () => {
  const user = userEvent.setup();
  const {router} = renderRoute('/customers/new');
  const stock = await screen.findByRole('textbox', {name: 'Items in stock'});
  const save = screen.getByRole('button', {name: 'Save'});
  await user.type(screen.getByRole('textbox', {name: 'Customer number'}), '3003');

  for (const value of ['-1', '1.5', 'abc', '', '9007199254740992']) {
    await user.clear(stock);
    if (value) {
      await user.type(stock, value);
    }

    expect(stock).toBeInvalid();
    expect(stock).toHaveAccessibleDescription(
      'Enter a whole number greater than or equal to 0.'
    );
    expect(save).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(router.state.location.pathname).toBe('/customers/new');
  }

  await user.clear(stock);
  await user.type(stock, '0');
  expect(stock).not.toBeInvalid();
  expect(
    screen.queryByText('Enter a whole number greater than or equal to 0.')
  ).not.toBeInTheDocument();

  await user.clear(stock);
  await user.type(stock, '2');
  expect(save).toBeEnabled();
  await user.click(save);
  expect(await screen.findByRole('heading', {name: 'Customers'})).toBeInTheDocument();
});

test('requires digits in home phone while preserving leading zeros and allowing a blank value', async () => {
  const user = userEvent.setup();
  renderRoute('/customers/1');
  const phone = await screen.findByRole('textbox', {name: 'Home phone'});
  const save = screen.getByRole('button', {name: 'Save'});

  await user.type(phone, '0123456789');
  expect(phone).toHaveValue('0123456789');
  expect(phone).not.toBeInvalid();
  expect(save).toBeEnabled();

  const parsed = customerFormSchema.parse({
    ...customerFormOptions(previewCustomer).defaultValues,
    homePhone: '0123456789',
  });
  expect(parsed.homePhone).toBe('0123456789');

  for (const value of ['abc', '902-555-1234', '+19025551234', '902 555 1234']) {
    await user.clear(phone);
    await user.type(phone, value);
    expect(phone).toBeInvalid();
    expect(phone).toHaveAccessibleDescription('Enter digits only (0–9).');
    expect(save).toBeDisabled();
  }

  await user.clear(phone);
  expect(phone).not.toBeInvalid();
  expect(screen.queryByText('Enter digits only (0–9).')).not.toBeInTheDocument();
});

test('validates balance precision and optional email addresses', async () => {
  const user = userEvent.setup();
  renderRoute('/customers/1');
  const balance = await screen.findByRole('textbox', {name: 'Balance ($)'});
  const email = screen.getByRole('textbox', {name: 'Email address'});
  const save = screen.getByRole('button', {name: 'Save'});

  await user.clear(balance);
  await user.type(balance, '1.234');
  expect(balance).toBeInvalid();
  expect(balance).toHaveAccessibleDescription(
    'Enter an amount with at most two decimal places.'
  );
  expect(save).toBeDisabled();

  await user.clear(balance);
  await user.type(balance, '-1.23');
  expect(balance).not.toBeInvalid();
  expect(save).toBeEnabled();

  await user.type(email, 'invalid');
  expect(email).toBeInvalid();
  expect(email).toHaveAccessibleDescription('Enter a valid email address.');
  expect(save).toBeDisabled();

  await user.clear(email);
  await user.type(email, 'alex@example.com');
  expect(email).not.toBeInvalid();
  expect(save).toBeEnabled();
  await user.clear(email);
  expect(email).not.toBeInvalid();
  expect(save).toBeEnabled();
});
