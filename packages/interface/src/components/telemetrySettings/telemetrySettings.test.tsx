import {screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import renderRoute from '../../../test/renderRoute';
import {createApplication} from '../../application/controller';
import createPreviewClient from '../../application/preview';

const restartMessage = /Restart Shop Things/;
const previewMessage = /Preview sends no monitoring data/;

const empty = {
  savedDsn: null,
  activeDsn: null,
  activeEnabled: false,
  restartRequired: false,
};

test('Settings remains usable while startup is held, saves for restart, retains edits after failure and clears', async () => {
  const client = createPreviewClient();
  const status = client.database.status;
  let release!: () => void;
  client.database.status = async () => {
    await new Promise<void>(resolve => {
      release = resolve;
    });
    return status();
  };

  let savedDsn: string | null = null;
  client.telemetry.status = async () => ({
    status: 'success',
    value: {...empty, savedDsn},
  });
  let fail = false;
  client.telemetry.save = async ({dsn}) => {
    if (fail) {
      return {
        status: 'error',
        error: {code: 'INTERNAL', message: 'native-private-error'},
      };
    }

    savedDsn = dsn;
    return {
      status: 'success',
      value: {...empty, savedDsn, restartRequired: dsn !== null},
    };
  };

  const application = createApplication('http://localhost', true, {client});
  renderRoute('/settings', application);
  const user = userEvent.setup();
  try {
    expect(await screen.findByRole('heading', {name: 'Settings'})).toBeVisible();
    expect(application.getState().phase).toBe('loading');
    const input = screen.getByRole('textbox', {name: 'Sentry DSN'});
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, 'https://public@host/1');
    await user.click(screen.getByRole('button', {name: 'Save monitoring'}));
    expect(savedDsn).toBe('https://public@host/1');
    expect(await screen.findByText(restartMessage)).toHaveTextContent(
      'Monitoring is off for this session.'
    );
    fail = true;
    await user.clear(input);
    await user.type(input, 'https://other@host/2');
    await user.click(screen.getByRole('button', {name: 'Save monitoring'}));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not save monitoring settings'
    );
    expect(input).toHaveValue('https://other@host/2');
    expect(savedDsn).toBe('https://public@host/1');
    fail = false;
    await user.clear(input);
    await user.click(screen.getByRole('button', {name: 'Save monitoring'}));
    await waitFor(() => expect(savedDsn).toBeNull());
    expect(screen.getByRole('button', {name: 'Save monitoring'})).toBeDisabled();
  } finally {
    release();
    application.dispose();
  }
});

test('preview monitoring is inert without storage or native saves', async () => {
  renderRoute('/settings');
  expect(await screen.findByRole('heading', {name: 'Settings'})).toBeVisible();
  expect(screen.getByRole('textbox', {name: 'Sentry DSN'})).toBeDisabled();
  expect(screen.getByRole('button', {name: 'Save monitoring'})).toBeDisabled();
  expect(screen.getByText(previewMessage)).toBeVisible();
});
