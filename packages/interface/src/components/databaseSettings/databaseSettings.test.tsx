import {screen} from '@testing-library/react';
import {expect, test} from 'vitest';

import renderRoute from '../../../test/renderRoute';
import {createApplication} from '../../application/controller';
import createPreviewClient from '../../application/preview';

test.each([null, '/missing/database.sqlite'])(
  'Settings nests database setup and recovery below its database heading (%s)',
  async selectedPath => {
    const client = createPreviewClient();
    client.database.status = async () => ({
      status: 'success',
      value: {available: false, selectedPath, session: null, version: 0},
    });
    const application = createApplication('http://localhost', true, {client});
    renderRoute('/settings', application);
    try {
      expect(
        await screen.findByRole('heading', {name: 'Settings', level: 1})
      ).toBeVisible();
      expect(
        screen.getByRole('heading', {name: 'Database Settings', level: 2})
      ).toBeVisible();
      expect(
        await screen.findByRole('heading', {
          name: selectedPath ? 'Recover Database' : 'Set Up Your Database',
          level: 3,
        })
      ).toBeVisible();
      expect(screen.getAllByRole('heading', {level: 1})).toHaveLength(1);
    } finally {
      application.dispose();
    }
  }
);
