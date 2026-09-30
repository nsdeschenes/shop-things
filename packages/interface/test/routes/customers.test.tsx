import {screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import renderRoute from '../renderRoute';

test('opens a customer row using the internal customer ID', async () => {
  const user = userEvent.setup();
  const {router} = renderRoute('/customers');

  const customerLink = await screen.findByRole('link', {name: 'Test User'});
  expect(customerLink).toHaveAttribute('href', '/customers/1');
  expect(screen.queryByText('Customer saved.')).not.toBeInTheDocument();

  await user.click(screen.getByRole('cell', {name: '1001'}));
  expect(await screen.findByRole('heading', {name: 'Edit Customer'})).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/customers/1');
});

test('keeps the empty customer preview empty when entering a search', async () => {
  const user = userEvent.setup();
  renderRoute('/customers?preview=empty');

  expect(
    await screen.findByRole('heading', {name: 'No Customers Yet'})
  ).toBeInTheDocument();
  expect(screen.getByText('0 customers')).toBeInTheDocument();

  await user.type(screen.getByRole('textbox', {name: 'Search customers'}), 'Test');
  expect(screen.getByText('0 customers')).toBeInTheDocument();
  expect(screen.queryByRole('link', {name: 'Test User'})).not.toBeInTheDocument();
});

test('opens a blank customer form with Save disabled from Add customer', async () => {
  const user = userEvent.setup();
  renderRoute('/customers?preview=empty');

  await user.click(await screen.findByRole('link', {name: 'Add customer'}));
  expect(await screen.findByRole('heading', {name: 'New Customer'})).toBeInTheDocument();
  expect(screen.getByRole('textbox', {name: 'Customer number'})).toHaveValue('');
  expect(screen.getByRole('button', {name: 'Save'})).toBeDisabled();
});
