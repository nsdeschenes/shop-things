import {act, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import renderRoute from '../../../test/renderRoute';
import {createApplication} from '../../application/controller';
import createPreviewClient from '../../application/preview';

test.each([null, '/missing/database.sqlite'])(
  'Settings nests database setup and recovery below its database heading (%s)',
  async selectedPath => {
    const client = createPreviewClient();
    client.database.status = async () => ({
      status: 'success',
      value: {available: false, selectedPath, session: null, version: 0},
    });
    const application = createApplication('http://localhost', true, {client});
    renderRoute('/settings', application);
    try {
      expect(
        await screen.findByRole('heading', {name: 'Settings', level: 1})
      ).toBeVisible();
      expect(
        screen.getByRole('heading', {name: 'Database Settings', level: 2})
      ).toBeVisible();
      expect(
        await screen.findByRole('heading', {
          name: selectedPath ? 'Recover Database' : 'Set Up Your Database',
          level: 3,
        })
      ).toBeVisible();
      expect(screen.getAllByRole('heading', {level: 1})).toHaveLength(1);
    } finally {
      application.dispose();
    }
  }
);

test('Settings links navigate routes and history while preserving monitoring drafts without saving', async () => {
  const client = createPreviewClient();
  let saves = 0;
  const save = client.telemetry.save;
  client.telemetry.save = configuration => {
    saves += 1;
    return save(configuration);
  };

  const application = createApplication('http://localhost', true, {client});
  const {router} = renderRoute('/settings', application);
  const user = userEvent.setup();
  try {
    const database = await screen.findByRole('tab', {name: 'Database'});
    const monitoring = screen.getByRole('tab', {name: 'Monitoring'});
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/settings/database')
    );
    expect(database).toHaveAttribute('href', '/settings/database');
    expect(monitoring).toHaveAttribute('href', '/settings/monitoring');
    expect(database.tagName).toBe('A');
    expect(monitoring.tagName).toBe('A');
    expect(database).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', {name: 'Database Settings'})).toBeVisible();
    expect(screen.queryByRole('textbox', {name: 'Sentry DSN'})).not.toBeInTheDocument();
    await user.click(database);
    await user.keyboard('{ArrowRight}{Enter}');
    expect(monitoring).toHaveFocus();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/settings/monitoring')
    );
    expect(monitoring).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.queryByRole('heading', {name: 'Database Settings'})
    ).not.toBeInTheDocument();
    const dsn = screen.getByRole('textbox', {name: 'Sentry DSN'});
    await waitFor(() => expect(dsn).toBeEnabled());
    await user.type(dsn, 'https://public@host/1');
    const sampling = screen.getByRole('spinbutton', {name: 'Trace sampling (%)'});
    await user.clear(sampling);
    await user.type(sampling, '25');
    await user.click(database);
    expect(screen.queryByRole('textbox', {name: 'Sentry DSN'})).not.toBeInTheDocument();
    await user.keyboard('{ArrowRight}{Enter}');
    expect(screen.getByRole('textbox', {name: 'Sentry DSN'})).toHaveValue(
      'https://public@host/1'
    );
    expect(screen.getByRole('spinbutton', {name: 'Trace sampling (%)'})).toHaveValue(25);
    expect(screen.getByRole('button', {name: 'Save monitoring'})).toBeEnabled();
    await act(async () => router.history.back());
    await waitFor(() => expect(database).toHaveAttribute('aria-selected', 'true'));
    expect(router.state.location.pathname).toBe('/settings/database');
    await act(async () => router.history.forward());
    await waitFor(() => expect(monitoring).toHaveAttribute('aria-selected', 'true'));
    expect(router.state.location.pathname).toBe('/settings/monitoring');
    expect(screen.getByRole('textbox', {name: 'Sentry DSN'})).toHaveValue(
      'https://public@host/1'
    );
    expect(saves).toBe(0);
  } finally {
    application.dispose();
  }
});
