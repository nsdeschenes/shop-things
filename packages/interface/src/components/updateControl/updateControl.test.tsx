import {act, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test, vi} from 'vitest';

import renderRoute from '../../../test/renderRoute';
import {createApplication} from '../../application/controller';
import createPreviewClient from '../../application/preview';
async function fixture() {
  const user = userEvent.setup();
  const client = createPreviewClient();
  const application = createApplication('http://localhost/?preview=true', false, {
    client,
  });
  renderRoute('/customers', application);
  await screen.findByRole('heading', {name: 'Customers'});
  return {user, client, application};
}

test('update control checks on open, shows availability and capability reasons, and dismisses without downloading', async () => {
  const {user, client, application} = await fixture();
  let finish!: (value: Awaited<ReturnType<typeof client.update.check>>) => void;
  const check = vi.spyOn(client.update, 'check').mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  const start = vi.spyOn(client.update, 'start');
  await user.click(screen.getByRole('button', {name: 'Check for updates'}));
  expect(screen.getByRole('status')).toHaveTextContent('Checking…');
  await act(async () =>
    finish({
      status: 'success',
      value: {
        revision: 1,
        phase: 'available',
        candidateId: 'candidate',
        targetVersion: '0.4.0',
        capabilityReasons: ['Installation is not available yet.'],
        nextActions: ['check'],
      },
    })
  );
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('Version 0.4.0 is available')
  );
  expect(screen.getByRole('button', {name: 'Update'})).toBeDisabled();
  expect(screen.getByText('Installation is not available yet.')).toBeVisible();
  expect(screen.getByLabelText('Update available')).toBeVisible();
  await user.click(screen.getByRole('button', {name: 'Close'}));
  expect(screen.queryByRole('button', {name: 'Update'})).not.toBeInTheDocument();
  expect(screen.getByRole('button', {name: 'Check for updates'})).toBeVisible();
  expect(check).toHaveBeenCalledTimes(1);
  expect(start).not.toHaveBeenCalled();
  application.dispose();
});

test('update check failure offers an explicit retry and then reports current', async () => {
  const {user, client, application} = await fixture();
  vi.spyOn(client.update, 'check')
    .mockResolvedValueOnce({
      status: 'success',
      value: {
        revision: 1,
        phase: 'check-failed',
        errorCode: 'NETWORK',
        capabilityReasons: [],
        nextActions: ['check'],
      },
    })
    .mockResolvedValueOnce({
      status: 'success',
      value: {
        revision: 2,
        phase: 'current',
        capabilityReasons: [],
        nextActions: ['check'],
      },
    });
  await user.click(screen.getByRole('button', {name: 'Check for updates'}));
  await user.click(await screen.findByRole('button', {name: 'Retry'}));
  expect(await screen.findByRole('status')).toHaveTextContent("You're up to date");
  application.dispose();
});

test('explicit Update shows progress while customer work stays available and dismissal preserves the attempt', async () => {
  const {user, client, application} = await fixture();
  const checking = vi
    .spyOn(client.update, 'check')
    .mockResolvedValueOnce({
      status: 'success',
      value: {
        revision: 1,
        phase: 'available',
        candidateId: 'candidate',
        targetVersion: '0.4.0',
        capabilityReasons: ['Installation is not available yet.'],
        nextActions: ['check', 'update'],
      },
    })
    .mockResolvedValue({
      status: 'success',
      value: {
        revision: 3,
        phase: 'downloading',
        candidateId: 'candidate',
        attemptId: 'attempt',
        targetVersion: '0.4.0',
        progress: 0.5,
        capabilityReasons: ['Installation is not available yet.'],
        nextActions: [],
      },
    });
  const start = vi.spyOn(client.update, 'start').mockResolvedValue({
    status: 'success',
    value: {
      revision: 2,
      phase: 'downloading',
      candidateId: 'candidate',
      attemptId: 'attempt',
      targetVersion: '0.4.0',
      progress: 0.5,
      capabilityReasons: ['Installation is not available yet.'],
      nextActions: [],
    },
  });
  await user.click(screen.getByRole('button', {name: 'Check for updates'}));
  await user.click(await screen.findByRole('button', {name: 'Update'}));
  expect(start).toHaveBeenCalledWith({candidateId: 'candidate'});
  expect(
    await screen.findByRole('progressbar', {name: 'Update download progress'})
  ).toHaveValue(0.5);
  expect(screen.getByRole('button', {name: 'Refresh customers'})).toBeEnabled();
  await user.click(screen.getByRole('button', {name: 'Close'}));
  await user.click(screen.getByRole('button', {name: 'Check for updates'}));
  expect(
    await screen.findByRole('progressbar', {name: 'Update download progress'})
  ).toHaveValue(0.5);
  expect(start).toHaveBeenCalledTimes(1);
  expect(checking).toHaveBeenCalledTimes(2);
  application.dispose();
});

test('a download failure retries only its current opaque attempt and stops at verified staging', async () => {
  const {user, client, application} = await fixture();
  vi.spyOn(client.update, 'check').mockResolvedValue({
    status: 'success',
    value: {
      revision: 1,
      phase: 'available',
      candidateId: 'candidate',
      targetVersion: '0.4.0',
      capabilityReasons: [],
      nextActions: ['check', 'update'],
    },
  });
  vi.spyOn(client.update, 'start').mockResolvedValue({
    status: 'success',
    value: {
      revision: 2,
      phase: 'retryable-failure',
      candidateId: 'candidate',
      attemptId: 'failed-attempt',
      targetVersion: '0.4.0',
      errorCode: 'VERIFICATION',
      capabilityReasons: [],
      nextActions: ['retry'],
    },
  });
  const retry = vi.spyOn(client.update, 'retry').mockResolvedValue({
    status: 'success',
    value: {
      revision: 3,
      phase: 'staged',
      candidateId: 'candidate',
      attemptId: 'new-attempt',
      targetVersion: '0.4.0',
      progress: 1,
      capabilityReasons: [],
      nextActions: [],
    },
  });
  await user.click(screen.getByRole('button', {name: 'Check for updates'}));
  await user.click(await screen.findByRole('button', {name: 'Update'}));
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Update verification failed. Retry to download a fresh copy.'
  );
  await user.click(screen.getByRole('button', {name: 'Retry'}));
  expect(retry).toHaveBeenCalledWith({attemptId: 'failed-attempt'});
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Download verified. Installation is not available yet.'
  );
  expect(screen.queryByRole('button', {name: 'Update'})).not.toBeInTheDocument();
  application.dispose();
});

test('package lock explains the other installation and retries only the retained attempt', async () => {
  const {user, client, application} = await fixture();
  vi.spyOn(client.update, 'check').mockResolvedValue({
    status: 'success',
    value: {
      revision: 2,
      phase: 'retryable-failure',
      attemptId: 'locked-attempt',
      errorCode: 'PACKAGE_LOCK',
      capabilityReasons: [],
      nextActions: ['retry'],
    },
  });
  const retry = vi.spyOn(client.update, 'retry').mockResolvedValue({
    status: 'success',
    value: {
      revision: 3,
      phase: 'current',
      capabilityReasons: [],
      nextActions: ['check'],
    },
  });
  await user.click(screen.getByRole('button', {name: 'Check for updates'}));
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Another installation is running. Wait for it to finish, then retry.'
  );
  await user.click(screen.getByRole('button', {name: 'Retry'}));
  expect(retry).toHaveBeenCalledWith({attemptId: 'locked-attempt'});
  application.dispose();
});

test('a delayed initial query cannot replace a newer update action state', async () => {
  const user = userEvent.setup();
  const client = createPreviewClient();
  let finish!: (result: Awaited<ReturnType<typeof client.update.getState>>) => void;
  vi.spyOn(client.update, 'getState').mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  vi.spyOn(client.update, 'check').mockResolvedValue({
    status: 'success',
    value: {revision: 4, phase: 'current', capabilityReasons: [], nextActions: ['check']},
  });
  const application = createApplication('http://localhost/?preview=true', false, {
    client,
  });
  renderRoute('/customers', application);
  await screen.findByRole('heading', {name: 'Customers'});
  await user.click(screen.getByRole('button', {name: 'Check for updates'}));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent("You're up to date")
  );
  await act(async () =>
    finish({
      status: 'success',
      value: {revision: 1, phase: 'idle', capabilityReasons: [], nextActions: ['check']},
    })
  );
  expect(screen.getByRole('status')).toHaveTextContent("You're up to date");
  application.dispose();
});
