import {screen} from '@testing-library/react';
import {expect, test} from 'vitest';

import renderRoute from '../renderRoute';

test('offers the persistent Database menu and protected Create from the empty customer list', async () => {
  renderRoute('/customers');
  expect(await screen.findByRole('button', {name: 'Database'})).toBeEnabled();
  expect(
    await screen.findByText('Active database: Preview: temporary customers.sqlite')
  ).toBeVisible();
  expect(await screen.findByRole('link', {name: 'Add customer'})).toHaveAttribute(
    'href',
    '/customers/new'
  );
  expect(screen.queryByRole('textbox', {name: 'First name'})).not.toBeInTheDocument();
  expect(await screen.findByText('0 results')).toBeInTheDocument();
  expect(screen.getByRole('heading', {name: 'No Customers Yet'})).toBeInTheDocument();
});
