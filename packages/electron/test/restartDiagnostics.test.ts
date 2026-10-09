import {mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import {
  readRestartDiagnostic,
  restartDiagnosticMessage,
} from '../src/restartDiagnostics.js';

test('manual startup reads bounded private restart history only as a diagnostic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restart-diagnostics-'));
  const attemptId = 'b7f650aa-0c51-4d68-a940-7f1472b86b46';
  const folder = join(root, attemptId);
  await mkdir(folder, {mode: 0o700});
  const path = join(folder, 'launch.json');
  const value = {
    schemaVersion: 1,
    attemptId,
    phase: 'launch-failed',
    installOutcome: 'installed',
    diagnostics: 'untrusted raw message',
    updatedAt: 10,
    child: null,
  };
  try {
    await writeFile(path, JSON.stringify(value), {mode: 0o600});
    expect(await readRestartDiagnostic(root)).toEqual({
      attemptId,
      phase: 'launch-failed',
      updatedAt: 10,
    });
    expect(
      restartDiagnosticMessage({attemptId, phase: 'launch-failed', updatedAt: 10})
    ).toBe('An earlier update restart reported that Shop Things could not start.');
    await writeFile(path, JSON.stringify({...value, phase: 'ready'}));
    expect(await readRestartDiagnostic(root)).toBeNull();
    await writeFile(path, '{"schemaVersion":1,"schemaVersion":1}');
    expect(await readRestartDiagnostic(root)).toBeNull();
    await writeFile(path, 'x'.repeat(8193));
    expect(await readRestartDiagnostic(root)).toBeNull();
    await rm(path);
    await symlink('/etc/passwd', path);
    expect(await readRestartDiagnostic(root)).toBeNull();
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
