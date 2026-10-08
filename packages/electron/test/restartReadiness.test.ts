import {chmod, mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test, vi} from 'vitest';

import {acknowledgeRestartReady} from '../src/restartSupervisor.js';

test('new app acknowledges private supervisor readiness only with its bounded launch credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-restart-'));
  const socketPath = join(directory, 'ready.sock');
  const attempt = 'b7f650aa-0c51-4d68-a940-7f1472b86b46';
  const token = 'a'.repeat(64);
  const messages: unknown[] = [];
  const server = createServer(connection => {
    connection.once('data', value => {
      messages.push(JSON.parse(value.toString()));
      connection.end('{"protocol":1,"type":"acknowledged"}\n');
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    await chmod(socketPath, 0o600);
    vi.stubEnv('SHOP_THINGS_RESTART_SOCKET', socketPath);
    vi.stubEnv('SHOP_THINGS_RESTART_ATTEMPT', attempt);
    vi.stubEnv('SHOP_THINGS_RESTART_TOKEN', token);
    await acknowledgeRestartReady();
    expect(messages).toEqual([{protocol: 1, type: 'ready', attemptId: attempt, token}]);
    expect(process.env.SHOP_THINGS_RESTART_TOKEN).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, {recursive: true, force: true});
  }
});

test('malformed readiness credentials fail without acknowledging startup', async () => {
  vi.resetModules();
  const module = await import('../src/restartSupervisor.js');
  try {
    vi.stubEnv('SHOP_THINGS_RESTART_SOCKET', '/tmp/unapproved/socket');
    vi.stubEnv('SHOP_THINGS_RESTART_ATTEMPT', 'stale');
    vi.stubEnv('SHOP_THINGS_RESTART_TOKEN', 'wrong');
    await expect(module.acknowledgeRestartReady()).rejects.toThrow(
      'Invalid restart readiness credentials'
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
