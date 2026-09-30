import {act, screen, waitFor} from '@testing-library/react';
import {expect, test} from 'vitest';

import {createApplication} from '../../src/application/controller';
import createPreviewClient from '../../src/application/preview';
import renderRoute from '../renderRoute';

test('redirects a ready index to the customer list', async () => {
  const {router} = renderRoute('/');
  expect(await screen.findByRole('heading', {name: 'No Customers Yet'})).toBeVisible();
  expect(router.state.location.pathname).toBe('/customers');
});

test.each(['/customers', '/customers/1', '/customers/new'])(
  'redirects unavailable entry %s to the index and continues when ready',
  async path => {
    const client = createPreviewClient();
    const status = await client.database.status();
    if (status.status !== 'success') {
      throw new Error('Preview status failed');
    }

    const ready = status.value;
    client.database.status = async () => ({
      status: 'success',
      value: {...ready, available: false, session: null},
    });
    let emit!: Parameters<typeof client.database.onStateChanged>[0];
    client.database.onStateChanged = listener => {
      emit = listener;
      return () => {};
    };

    const application = createApplication('http://localhost/?preview=true', false, {
      client,
    });
    const {router} = renderRoute(path, application);
    expect(
      await screen.findByText('Open or create a database to view customers.')
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/');
    await act(async () => {
      emit({...ready, version: ready.version + 1});
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/customers'));
    expect(await screen.findByRole('heading', {name: 'No Customers Yet'})).toBeVisible();
  }
);
