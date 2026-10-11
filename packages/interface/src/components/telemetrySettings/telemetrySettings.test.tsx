import {act, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import renderRoute from '../../../test/renderRoute';
import {createApplication} from '../../application/controller';
import createPreviewClient from '../../application/preview';

const restartMessage = /Restart Shop Things/;
const previewMessage = /Preview sends no monitoring data/;
const validationMessage = /Enter a valid HTTP or HTTPS Sentry DSN/;

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

test.each(['success', 'error'] as const)(
  'monitoring status is unknown until the status request returns %s',
  async outcome => {
    const client = createPreviewClient();
    let complete!: (result: Awaited<ReturnType<typeof client.telemetry.status>>) => void;
    client.telemetry.status = () =>
      new Promise(resolve => {
        complete = resolve;
      });
    const application = createApplication('http://localhost', true, {client});
    renderRoute('/settings', application);
    try {
      await screen.findByRole('heading', {name: 'Settings'});
      expect(screen.getByRole('status')).toHaveTextContent(
        'Monitoring status is unknown for this session.'
      );
      expect(screen.getByRole('textbox', {name: 'Sentry DSN'})).toBeDisabled();
      await act(async () => {
        complete(
          outcome === 'success'
            ? {
                status: 'success',
                value: {
                  ...empty,
                  activeEnabled: true,
                  savedDsn: 'https://public@host/1',
                  activeDsn: 'https://public@host/1',
                },
              }
            : {status: 'error', error: {code: 'INTERNAL', message: 'Private failure'}}
        );
      });
      expect(screen.getByRole('status')).toHaveTextContent(
        outcome === 'success'
          ? 'Monitoring is on for this session.'
          : 'Monitoring status is unknown for this session.'
      );
      expect(screen.queryByRole('alert')?.textContent ?? null).toBe(
        outcome === 'error'
          ? 'Could not load monitoring settings. Reopen Settings to try again.'
          : null
      );
    } finally {
      application.dispose();
    }
  }
);

test('DSN validation is linked to the field, clears on edit and stays separate from save failures', async () => {
  const client = createPreviewClient();
  const saves: (string | null)[] = [];
  client.telemetry.save = async ({dsn}) => {
    saves.push(dsn);
    return {status: 'error', error: {code: 'INTERNAL', message: 'Private failure'}};
  };

  const application = createApplication('http://localhost', true, {client});
  renderRoute('/settings', application);
  const user = userEvent.setup();
  try {
    const input = await screen.findByRole('textbox', {name: 'Sentry DSN'});
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, 'invalid-dsn');
    await user.click(screen.getByRole('button', {name: 'Save monitoring'}));
    expect(saves).toEqual([]);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(validationMessage);
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'sentry-dsn-error');
    await user.clear(input);
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input).toHaveAccessibleDescription('Monitoring is off for this session.');
    await user.type(input, 'https://public@host/1');
    await user.click(screen.getByRole('button', {name: 'Save monitoring'}));
    expect(saves).toEqual(['https://public@host/1']);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not save monitoring settings.'
    );
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveAccessibleDescription('Monitoring is off for this session.');
  } finally {
    application.dispose();
  }
});
