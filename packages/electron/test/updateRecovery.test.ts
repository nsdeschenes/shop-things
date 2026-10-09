import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {expect, test} from 'vitest';

test('interrupted protected records require signed full-plan settlement under real process locks', async () => {
  const result = await promisify(execFile)('/usr/bin/python3', [
    '-I',
    fileURLToPath(new URL('./updateRecoveryFixtures.py', import.meta.url)),
  ]);
  expect(result.stderr).toContain('OK');
}, 15000);
