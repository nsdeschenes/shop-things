import {Toast} from '@base-ui/react/toast';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import {createApplication} from '../../application/controller';
import createPreviewClient from '../../application/preview';
import DatabaseActions from '../databaseActions/databaseActions';
import Toasts from '../toasts/toasts';

const snapshotId = 'a36ce376-0b4f-48ab-97e1-31c60413742e';
test('database recovery lists snapshot identity and requests a separate copy by opaque ID', async () => {
  const client = createPreviewClient();
  const recovery = {
    available: false,
    selectedPath: '/records/customers.db',
    session: null,
    version: 3,
  };
  client.database.status = async () => ({status: 'success', value: recovery});
  client.database.listMigrationSnapshots = async () => ({
    status: 'success',
    value: {
      snapshots: [
        {
          snapshotId,
          sourcePath: '/records/customers.db',
          createdAt: '2026-10-08T12:00:00.000Z',
          sourceHistory: ['initial'],
          targetHistory: ['initial', 'required-numbers'],
        },
      ],
      unavailableCount: 0,
    },
  });
  const selections: string[] = [];
  client.database.restoreMigrationSnapshot = async args => {
    selections.push(args.snapshotId);
    return {status: 'cancelled'};
  };

  const toastManager = Toast.createToastManager();
  const application = createApplication('http://localhost/', true, {
    client,
    toastManager,
  });
  render(
    <Toast.Provider toastManager={toastManager}>
      <DatabaseActions application={application} />
      <Toasts />
    </Toast.Provider>
  );
  try {
    await application.start();
    const restore = await screen.findByRole('button', {name: 'Restore new copy'});
    expect(screen.getByRole('region', {name: 'Migration snapshots'})).toHaveTextContent(
      '/records/customers.db'
    );
    expect(
      screen.getByText(
        'Installing an older app does not undo a database update. Changes saved after a snapshot are not included in that snapshot.'
      )
    ).toBeVisible();
    const user = userEvent.setup();
    await user.click(restore);
    await waitFor(() => expect(selections).toEqual([snapshotId]));
    await waitFor(() => expect(restore).toBeEnabled());
    expect(application.getState().database).toEqual(recovery);
    client.database.restoreMigrationSnapshot = async () => ({
      status: 'error',
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'The recovered copy failed validation. Choose another snapshot.',
      },
    });
    await user.click(restore);
    expect(
      await within(screen.getByRole('region', {name: 'Notifications'})).findByText(
        'The recovered copy failed validation. Choose another snapshot.'
      )
    ).toBeVisible();
    expect(application.getState().database).toEqual(recovery);
  } finally {
    application.dispose();
  }
});
