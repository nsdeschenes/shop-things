import {screen} from '@testing-library/react';
import {expect, test} from 'vitest';

import renderRoute from '../renderRoute';

test('enables Create with a registered clean draft participant', async () => {
  renderRoute('/customers/new');
  expect(await screen.findByRole('button', {name: 'Save'})).toBeEnabled();
  expect(screen.getByRole('textbox', {name: 'First name'})).toHaveValue('');
});
