import {screen} from '@testing-library/react';
import {expect, test} from 'vitest';

import renderRoute from '../renderRoute';

test('keeps unfinished customer actions disabled before draft protection', async () => {
  renderRoute('/customers');
  expect(await screen.findByRole('button', {name: 'Add customer'})).toBeDisabled();
  expect(screen.queryByRole('textbox', {name: 'First name'})).not.toBeInTheDocument();
});
