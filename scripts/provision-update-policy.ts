import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';

import {validatePublicPolicy} from './updateRelease.ts';
import {runIfMain} from './workspace.ts';

await runIfMain(import.meta.url, async () => {
  assert.ok(
    process.env.UPDATE_TRUSTED_PUBLIC_KEYS_JSON,
    'Supply approved public publisher keys before build and acceptance'
  );
  const policy = validatePublicPolicy({
    schemaVersion: 1,
    helperProtocol: 1,
    trustedKeys: JSON.parse(process.env.UPDATE_TRUSTED_PUBLIC_KEYS_JSON),
  });
  await writeFile('packages/electron/update/policy.json', JSON.stringify(policy) + '\n', {
    flag: 'wx',
    mode: 0o644,
  });
});
