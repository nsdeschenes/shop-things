import type {TelemetryConfiguration, TelemetrySettingsState} from '@shop-things/contract';
import {defaultTelemetrySampling} from '@shop-things/contract/schemas';
import {act, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import renderRoute from '../../../test/renderRoute';
import {createApplication} from '../../application/controller';
import createPreviewClient from '../../application/preview';

const restartMessage = /Restart Shop Things/;
const previewMessage = /Preview sends no monitoring data/;
const validationMessage = /Enter a valid HTTP or HTTPS Sentry DSN/;
const productionValidationMessage = /Use an HTTPS Sentry DSN in production/;
const customerDisclosure = /Customer number, stock, balances, and donation flag/;
const personalFieldsDisclosure =
  /Personal fields and selected data file locations are excluded\. Application code locations may be reported/;
const transportDisclosure = /Production requires HTTPS/;

const empty: TelemetrySettingsState = {
  environment: 'development',
  savedDsn: null,
  activeDsn: null,
  savedSampling: {...defaultTelemetrySampling},
  activeSampling: {...defaultTelemetrySampling},
  activeEnabled: false,
  restartRequired: false,
};

test('production monitoring rejects remote HTTP in the field and saves loopback HTTP or disables', async () => {
  const client = createPreviewClient();
  const saves: TelemetryConfiguration[] = [];
  const state = {...empty, environment: 'production' as const};
  client.telemetry.status = async () => ({status: 'success', value: state});
  client.telemetry.save = async configuration => {
    saves.push(configuration);
    return {
      status: 'success',
      value: {
        ...state,
        savedDsn: configuration.dsn,
        restartRequired: configuration.dsn !== null,
      },
    };
  };

  const application = createApplication('http://localhost', true, {client});
  renderRoute('/settings/monitoring', application);
  const user = userEvent.setup();
  try {
    const input = await screen.findByRole('textbox', {name: 'Sentry DSN'});
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, 'http://public@remote.example/1');
    await user.click(screen.getByRole('button', {name: 'Save monitoring'}));
    expect(saves).toEqual([]);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(productionValidationMessage);
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'sentry-dsn-error');
    await user.clear(input);
    await user.type(input, 'http://public@127.0.0.1:9000/1');
    await user.click(screen.getByRole('button', {name: 'Save monitoring'}));
    expect(saves).toEqual([
      {dsn: 'http://public@127.0.0.1:9000/1', sampling: defaultTelemetrySampling},
    ]);
    expect(input).not.toHaveAttribute('aria-invalid');
    await user.clear(input);
    await user.click(screen.getByRole('button', {name: 'Save monitoring'}));
    expect(saves.at(-1)?.dsn).toBeNull();
  } finally {
    application.dispose();
  }
});

test('monitoring discloses permitted business fields, private exclusions, and production transport restrictions', async () => {
  renderRoute('/settings/monitoring');
  await screen.findByRole('heading', {name: 'Settings'});
  expect(screen.getByText(customerDisclosure)).toHaveTextContent(
    'Customer number, stock, balances, and donation flag supplied when creating or updating a customer may be reported.'
  );
  expect(screen.getByText(personalFieldsDisclosure)).toBeVisible();
  expect(screen.getByText(transportDisclosure)).toHaveTextContent(
    'Production requires HTTPS for remote destinations. HTTP is allowed only for localhost, 127.0.0.1, or [::1]. Development also allows remote HTTP.'
  );
});

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
  renderRoute('/settings/monitoring', application);
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
  renderRoute('/settings/monitoring');
  expect(await screen.findByRole('heading', {name: 'Settings'})).toBeVisible();
  expect(screen.getByRole('textbox', {name: 'Sentry DSN'})).toBeDisabled();
  expect(screen.getByRole('button', {name: 'Save monitoring'})).toBeDisabled();
  expect(screen.getByRole('spinbutton', {name: 'Error sampling (%)'})).toBeDisabled();
  expect(screen.getByRole('spinbutton', {name: 'Trace sampling (%)'})).toBeDisabled();
  expect(screen.getByRole('spinbutton', {name: 'Log sampling (%)'})).toBeDisabled();
  expect(screen.getByRole('spinbutton', {name: 'Metric sampling (%)'})).toBeDisabled();
  expect(screen.getByText(previewMessage)).toBeVisible();
});

test('sampling-only edits validate, retain failed saves and persist for restart', async () => {
  const client = createPreviewClient();
  const dsn = 'https://public@host/1';
  let savedSampling: TelemetryConfiguration['sampling'] = {...defaultTelemetrySampling};
  function status() {
    return {
      ...empty,
      savedDsn: dsn,
      activeDsn: dsn,
      activeEnabled: true,
      savedSampling,
      restartRequired: Object.values(savedSampling).some(
        percentage => percentage !== 100
      ),
    };
  }

  client.telemetry.status = async () => ({status: 'success', value: status()});
  const saves: TelemetryConfiguration[] = [];
  let fail = true;
  client.telemetry.save = async configuration => {
    saves.push(configuration);
    if (fail) {
      return {status: 'error', error: {code: 'INTERNAL', message: 'Private failure'}};
    }

    savedSampling = configuration.sampling;
    return {status: 'success', value: status()};
  };

  const application = createApplication('http://localhost', true, {client});
  renderRoute('/settings/monitoring', application);
  const user = userEvent.setup();
  try {
    const errors = await screen.findByRole('spinbutton', {name: 'Error sampling (%)'});
    const traces = screen.getByRole('spinbutton', {name: 'Trace sampling (%)'});
    const logs = screen.getByRole('spinbutton', {name: 'Log sampling (%)'});
    const metrics = screen.getByRole('spinbutton', {name: 'Metric sampling (%)'});
    await waitFor(() => expect(errors).toBeEnabled());
    const save = screen.getByRole('button', {name: 'Save monitoring'});
    expect(save).toBeDisabled();
    await user.clear(logs);
    await user.type(logs, '101');
    expect(save).toBeEnabled();
    await user.click(save);
    expect(saves).toEqual([]);
    expect(logs).toHaveAttribute('aria-invalid', 'true');
    await user.clear(logs);
    await user.type(logs, '100');
    expect(save).toBeDisabled();
    await user.clear(metrics);
    expect(save).toBeEnabled();
    await user.click(save);
    expect(saves).toEqual([]);
    expect(metrics).toHaveAttribute('aria-invalid', 'true');
    await user.type(metrics, '12.5');
    await user.clear(logs);
    await user.type(logs, '30');
    await user.clear(errors);
    await user.type(errors, '101');
    await user.click(save);
    expect(saves).toEqual([]);
    expect(errors).toHaveAttribute('aria-invalid', 'true');
    expect(errors).toHaveAccessibleDescription(
      'Percentage of errors to send. Enter a percentage from 0 to 100.'
    );
    await user.clear(errors);
    expect(errors).not.toHaveAttribute('aria-invalid');
    await user.click(save);
    expect(errors).toHaveAttribute('aria-invalid', 'true');
    expect(saves).toEqual([]);
    await user.type(errors, '25.5');
    await user.clear(traces);
    await user.type(traces, '0');
    await user.click(save);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not save monitoring settings.'
    );
    expect(errors).toHaveValue(25.5);
    expect(traces).toHaveValue(0);
    expect(errors).not.toHaveAttribute('aria-invalid');
    expect(savedSampling).toEqual(defaultTelemetrySampling);
    fail = false;
    await user.click(save);
    expect(savedSampling).toEqual({errors: 25.5, traces: 0, logs: 30, metrics: 12.5});
    expect(saves).toEqual([
      {dsn, sampling: savedSampling},
      {dsn, sampling: savedSampling},
    ]);
    expect(screen.getByRole('status')).toHaveTextContent(restartMessage);
    expect(save).toBeDisabled();
  } finally {
    application.dispose();
  }
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
    renderRoute('/settings/monitoring', application);
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
  renderRoute('/settings/monitoring', application);
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
