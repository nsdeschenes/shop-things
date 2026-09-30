import {screen} from '@testing-library/react';
import {expect, test} from 'vitest';

import renderRoute from '../renderRoute';

test('shows a missing preview customer without enabling editing', async () => {
  renderRoute('/customers/1');
  expect(
    await screen.findByRole('heading', {name: 'Customer not found'})
  ).toBeInTheDocument();
  expect(screen.getByRole('link', {name: 'Back to customers'})).toHaveAttribute(
    'href',
    '/customers'
  );
  expect(screen.queryByRole('textbox', {name: 'First name'})).not.toBeInTheDocument();
});
