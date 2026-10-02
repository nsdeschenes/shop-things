import {rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import {createReleaseFixture, runReleaseScript} from './releaseHelpers.ts';

test('accepts aligned workspace versions and rejects a mismatched package', async () => {
  const directory = await createReleaseFixture();
  try {
    expect(
      runReleaseScript(directory, 'check-release-version', {VERSION: '0.0.1'}).status
    ).toBe(0);
    await writeFile(
      join(directory, 'packages/interface/package.json'),
      '{"version":"0.0.0"}'
    );
    const result = runReleaseScript(directory, 'check-release-version', {
      VERSION: '0.0.1',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/interface/package.json must use 0.0.1');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
