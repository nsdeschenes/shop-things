import {screen} from '@testing-library/react';
import {expect, test} from 'vitest';

import renderRoute from '../renderRoute';

test('offers temporary customer workflows without database file controls', async () => {
  renderRoute('/customers');
  expect(
    await screen.findByText('Browser preview — temporary data', {exact: false})
  ).toBeVisible();
  expect(screen.queryByRole('button', {name: 'Database'})).not.toBeInTheDocument();
  expect(await screen.findByRole('link', {name: 'Add customer'})).toHaveAttribute(
    'href',
    '/customers/new'
  );
  expect(screen.queryByRole('textbox', {name: 'First name'})).not.toBeInTheDocument();
  expect(await screen.findByText('0 results')).toBeInTheDocument();
  expect(screen.getByRole('heading', {name: 'No Customers Yet'})).toBeInTheDocument();
});
