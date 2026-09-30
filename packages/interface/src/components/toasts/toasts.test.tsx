import {Toast} from '@base-ui/react/toast';
import {act, render, screen, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test, vi} from 'vitest';

import toastManager, {createToasts, toasts} from '../../application/toasts';
import Toasts from './toasts';

test('shared manager publishes notifications outside React and retains them when page content changes', async () => {
  const view = render(
    <Toast.Provider toastManager={toastManager}>
      <main>Customers</main>
      <Toasts />
    </Toast.Provider>
  );
  act(() => {
    toasts.notice({
      title: 'Export ready',
      description: 'Your customer export is ready to download.',
      timeout: 0,
    });
  });
  view.rerender(
    <Toast.Provider toastManager={toastManager}>
      <main>Customer details</main>
      <Toasts />
    </Toast.Provider>
  );
  const viewport = screen.getByRole('region', {name: 'Notifications'});
  const notifications = within(viewport);
  act(() => viewport.focus());
  expect(notifications.getByText('Export ready')).toBeVisible();
  expect(
    notifications.getByText('Your customer export is ready to download.')
  ).toBeVisible();
  await userEvent
    .setup()
    .click(notifications.getByRole('button', {name: 'Dismiss notification'}));
  expect(notifications.queryByText('Export ready')).not.toBeInTheDocument();
});

test.each([
  {type: 'success', role: 'dialog', priority: 'low', timeout: 5000},
  {type: 'warning', role: 'alertdialog', priority: 'high', timeout: 0},
  {type: 'error', role: 'alertdialog', priority: 'high', timeout: 0},
  {type: 'notice', role: 'dialog', priority: 'low', timeout: 5000},
] as const)(
  '$type preset renders with its standard priority and timeout',
  ({type, role, priority, timeout}) => {
    const manager = Toast.createToastManager();
    const notifications = createToasts(manager);
    const add = vi.spyOn(manager, 'add');
    render(
      <Toast.Provider toastManager={manager}>
        <Toasts />
      </Toast.Provider>
    );
    act(() => {
      notifications[type]({title: `${type} notification`, description: 'More details'});
    });
    expect(add).toHaveBeenCalledExactlyOnceWith({
      title: `${type} notification`,
      description: 'More details',
      type,
      priority,
      timeout,
    });
    const viewport = screen.getByRole('region', {name: 'Notifications'});
    act(() => viewport.focus());
    const toast = within(viewport).getByRole(role, {name: `${type} notification`});
    expect(toast).toBeVisible();
    expect(toast).toHaveAttribute('data-type', type);
    expect(within(toast).getByText('More details')).toBeVisible();
  }
);
