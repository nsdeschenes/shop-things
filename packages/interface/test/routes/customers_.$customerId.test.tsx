import {screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import renderRoute from '../renderRoute';

test('edits the customer number without changing the customer route', async () => {
  const user = userEvent.setup();
  const {router} = renderRoute('/customers/1');

  const customerNumber = await screen.findByRole('textbox', {name: 'Customer number'});
  expect(customerNumber).toHaveValue('1001');
  expect(customerNumber).toBeEnabled();

  await user.clear(customerNumber);
  await user.type(customerNumber, '2002');
  expect(customerNumber).toHaveValue('2002');
  expect(router.state.location.pathname).toBe('/customers/1');
});

test('enables Save only while customer values differ from their defaults', async () => {
  const user = userEvent.setup();
  renderRoute('/customers/1');

  const customerNumber = await screen.findByRole('textbox', {name: 'Customer number'});
  const saveButton = screen.getByRole('button', {name: 'Save'});
  expect(saveButton).toBeDisabled();

  await user.clear(customerNumber);
  await user.type(customerNumber, '2002');
  expect(saveButton).toBeEnabled();

  await user.clear(customerNumber);
  await user.type(customerNumber, '1001');
  expect(saveButton).toBeDisabled();
});

test('returns to the list after Save without persisting edits to an existing customer', async () => {
  const user = userEvent.setup();
  const {router} = renderRoute('/customers/1');

  const customerNumber = await screen.findByRole('textbox', {name: 'Customer number'});
  await user.clear(customerNumber);
  await user.type(customerNumber, '2002');
  await user.click(screen.getByRole('button', {name: 'Save'}));

  expect(await screen.findByRole('heading', {name: 'Customers'})).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/customers');
  expect(screen.getByRole('cell', {name: '1001'})).toBeInTheDocument();
  expect(screen.queryByRole('cell', {name: '2002'})).not.toBeInTheDocument();
});
