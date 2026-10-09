import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {validateDraftRelease, validatePublicPolicy} from './updateRelease.ts';
import {runIfMain} from './workspace.ts';

await runIfMain(import.meta.url, async () => {
  assert.ok(
    process.env.UPDATE_TRUSTED_PUBLIC_KEYS_JSON &&
      process.env.RELEASE_DRAFT_PATH &&
      process.env.RELEASE_ASSET_DIRECTORY &&
      process.env.RELEASE_SHA &&
      process.env.VERSION
  );
  const policy = validatePublicPolicy({
    schemaVersion: 1,
    helperProtocol: 1,
    trustedKeys: JSON.parse(process.env.UPDATE_TRUSTED_PUBLIC_KEYS_JSON),
  });
  await validateDraftRelease(
    JSON.parse(await readFile(process.env.RELEASE_DRAFT_PATH, 'utf8')),
    process.env.RELEASE_ASSET_DIRECTORY,
    policy,
    process.env.RELEASE_SHA,
    process.env.VERSION
  );
});
