import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {StrictMode} from 'react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';

import AppearanceSettings from '../components/appearanceSettings/appearanceSettings';
import {AppearanceProvider, initializeAppearance} from './appearance';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = 'unrelated';
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
});

test.each([
  [null, 'system'],
  ['invalid', 'system'],
  ['DARK', 'system'],
  ['light', 'light'],
  ['dark', 'dark'],
  ['system', 'system'],
])('initializes stored %s as %s without writing storage', (stored, expected) => {
  if (stored !== null) {
    localStorage.setItem('shop-things.appearance', stored);
  }

  const write = vi.spyOn(Storage.prototype, 'setItem');
  try {
    expect(initializeAppearance()).toBe(expected);
    expect(document.documentElement).toHaveClass('unrelated');
    expect(write).not.toHaveBeenCalled();
  } finally {
    write.mockRestore();
  }
});

test.each(['access', 'read'])('unavailable storage %s falls back to System', failure => {
  function unavailable(): never {
    throw new DOMException('Storage unavailable', 'SecurityError');
  }

  const read =
    failure === 'access'
      ? vi.spyOn(window, 'localStorage', 'get').mockImplementation(unavailable)
      : vi.spyOn(Storage.prototype, 'getItem').mockImplementation(unavailable);
  try {
    expect(initializeAppearance()).toBe('system');
    expect(document.documentElement).toHaveClass('unrelated');
  } finally {
    read.mockRestore();
  }
});

test('mounting in StrictMode leaves storage empty and radio selections persist across remounts', async () => {
  const user = userEvent.setup();
  const {unmount} = render(
    <StrictMode>
      <AppearanceProvider initialPreference={initializeAppearance()}>
        <AppearanceSettings />
      </AppearanceProvider>
    </StrictMode>
  );
  expect(screen.getByRole('radio', {name: 'System'})).toBeChecked();
  expect(localStorage.length).toBe(0);
  await user.click(screen.getByRole('radio', {name: 'Dark'}));
  expect(screen.getByRole('radio', {name: 'Dark'})).toBeChecked();
  expect(localStorage.getItem('shop-things.appearance')).toBe('dark');
  expect(document.documentElement).toHaveClass('unrelated');
  unmount();
  render(
    <AppearanceProvider initialPreference={initializeAppearance()}>
      <AppearanceSettings />
    </AppearanceProvider>
  );
  expect(screen.getByRole('radio', {name: 'Dark'})).toBeChecked();
  await user.keyboard('{Tab}{ArrowRight}');
  expect(screen.getByRole('radio', {name: 'System'})).toBeChecked();
  expect(localStorage.getItem('shop-things.appearance')).toBe('system');
});

test('a failed storage write keeps the selected appearance active', async () => {
  const user = userEvent.setup();
  render(
    <AppearanceProvider initialPreference="system">
      <AppearanceSettings />
    </AppearanceProvider>
  );
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage full', 'QuotaExceededError');
  });
  try {
    await user.click(screen.getByRole('radio', {name: 'Dark'}));
    expect(screen.getByRole('radio', {name: 'Dark'})).toBeChecked();
    expect(localStorage.length).toBe(0);
  } finally {
    write.mockRestore();
  }
});
