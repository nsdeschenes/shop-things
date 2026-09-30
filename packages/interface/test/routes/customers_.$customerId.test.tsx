import {screen} from '@testing-library/react';
import {expect, test} from 'vitest';

import renderRoute from '../renderRoute';

test('shows a missing preview customer without enabling editing', async () => {
  renderRoute('/customers/1');
  expect(
    await screen.findByRole('heading', {name: 'Customer Not Found'})
  ).toBeInTheDocument();
  expect(screen.getByRole('link', {name: 'Back to customers'})).toHaveAttribute(
    'href',
    '/customers'
  );
  expect(screen.queryByRole('textbox', {name: 'First name'})).not.toBeInTheDocument();
});

test.each(['abc', '0', '-1', '9007199254740992'])(
  'rejects invalid customer ID %s through the route error component',
  async id => {
    renderRoute(`/customers/${id}`);
    expect(
      await screen.findByRole('heading', {name: 'Customer Not Found'})
    ).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This customer no longer exists.'
    );
  }
);
