import {screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import renderRoute from '../renderRoute';

test('preview route protection focuses Stay and retains draft until committed discard navigation', async () => {
  const user = userEvent.setup();
  const {router, application} = renderRoute('/customers/new');
  const balance = await screen.findByRole('textbox', {name: 'Balance ($)'});
  await user.clear(balance);
  await user.type(balance, '-');
  await user.click(screen.getByRole('link', {name: 'Customer records Shop Things'}));
  const stay = await screen.findByRole('button', {name: 'Stay'});
  expect(stay).toHaveFocus();
  expect(router.state.location.pathname).toBe('/customers/new');
  expect(balance).toHaveValue('-');
  await user.keyboard('{Enter}');

  expect(application.protection.getState().frozen).toBe(false);
  await user.click(screen.getByRole('link', {name: 'Customer records Shop Things'}));
  await user.click(await screen.findByRole('button', {name: 'Discard'}));
  await screen.findByRole('heading', {name: 'Customers'});

  expect(application.protection.isDirty()).toBe(false);
});
