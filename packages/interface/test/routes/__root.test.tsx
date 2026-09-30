import {screen} from '@testing-library/react';
import {expect, test} from 'vitest';

import renderRoute from '../renderRoute';

test('offers the persistent Database menu in the temporary preview', async () => {
  renderRoute('/customers');
  expect(await screen.findByRole('button', {name: 'Database'})).toBeEnabled();
  expect(
    await screen.findByText('Active database: Preview: temporary customers.sqlite')
  ).toBeVisible();
});
