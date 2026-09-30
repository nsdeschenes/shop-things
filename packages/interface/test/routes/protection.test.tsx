import {screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import renderRoute from '../renderRoute';

test('preview route protection focuses Stay and retains draft until committed discard navigation', async () => {
  const user = userEvent.setup();
  const {router, application} = renderRoute('/customers/new');
  await screen.findByRole('heading', {name: 'Customer Editing Unavailable'});
  let values = {balance: '-'};
  let resets = 0;
  application.protection.registerEditor({
    values: () => values,
    baseline: () => ({balance: '0.00'}),
    reset() {
      values = {balance: '0.00'};
      resets++;
    },
  });
  await user.click(screen.getByRole('link', {name: 'Customer records Shop Things'}));
  const stay = await screen.findByRole('button', {name: 'Stay'});
  expect(stay).toHaveFocus();
  expect(router.state.location.pathname).toBe('/customers/new');
  expect(values.balance).toBe('-');
  await user.keyboard('{Enter}');
  expect(resets).toBe(0);
  expect(application.protection.getState().frozen).toBe(false);
  await user.click(screen.getByRole('link', {name: 'Customer records Shop Things'}));
  await user.click(await screen.findByRole('button', {name: 'Discard'}));
  await screen.findByRole('heading', {name: 'Customers'});
  expect(resets).toBe(1);
  expect(values.balance).toBe('0.00');
});
