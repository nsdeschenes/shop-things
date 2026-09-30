import {render, screen, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import {createApplication} from '../../application/controller';
import createPreviewClient from '../../application/preview';
import DatabaseToasts from '../databaseToasts/databaseToasts';
import DatabaseActions from './databaseActions';

const activeLabel = /Active database:/;
const busyLabel = /Another operation/;
test('startup gates actions, recovery names the failed file, and BUSY clears pending with dismissible guidance', async () => {
  const client = createPreviewClient();
  client.database.status = async () => ({
    status: 'success',
    value: {
      available: false,
      selectedPath: '/missing/remembered.sqlite',
      session: null,
      version: 2,
      recoveryError: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'Choose a saved database or retry.',
      },
    },
  });
  client.database.retry = async () => ({
    status: 'error',
    error: {code: 'BUSY', message: 'Busy'},
  });
  const application = createApplication('http://localhost/', true, {client});
  render(
    <>
      <DatabaseActions application={application} />
      <DatabaseToasts application={application} />
    </>
  );
  expect(screen.queryByRole('button', {name: 'Database'})).not.toBeInTheDocument();
  await application.start();
  expect(await screen.findByRole('heading', {name: 'Recover Database'})).toBeVisible();
  expect(screen.queryByRole('button', {name: 'Database'})).not.toBeInTheDocument();
  expect(screen.getByText('Failed remembered file: remembered.sqlite')).toBeVisible();
  expect(screen.queryByText(activeLabel)).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', {name: 'Retry remembered database'}));
  expect(
    await screen.findByRole('alertdialog', {
      hidden: true,
    })
  ).toBeVisible();
  expect(
    within(screen.getByRole('region', {name: 'Notifications'})).getByText(
      'Another operation is in progress. Try again when it finishes.'
    )
  ).toBeVisible();
  expect(screen.queryByText('Waiting for database operation…')).not.toBeInTheDocument();
  await user.click(
    within(screen.getByRole('region', {name: 'Notifications'})).getByRole('button', {
      hidden: true,
    })
  );
  expect(
    within(screen.getByRole('region', {name: 'Notifications'})).queryByText(busyLabel)
  ).not.toBeInTheDocument();
  application.dispose();
});
