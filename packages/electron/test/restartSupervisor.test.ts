import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {expect, test} from 'vitest';

test('original-user supervisor exercises durable outcomes and private readiness with real children', async () => {
  const result = await promisify(execFile)('/usr/bin/python3', [
    '-I',
    fileURLToPath(new URL('./restartSupervisorFixtures.py', import.meta.url)),
  ]);
  expect(result.stderr).toContain('OK');
}, 15000);
