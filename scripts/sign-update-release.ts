import assert from 'node:assert/strict';
import {createPrivateKey} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';

import {signStagedRelease, validatePublicPolicy} from './updateRelease.ts';
import {runIfMain} from './workspace.ts';

await runIfMain(import.meta.url, async () => {
  const pem = process.env.UPDATE_SIGNING_PRIVATE_KEY;
  delete process.env.UPDATE_SIGNING_PRIVATE_KEY;
  assert.ok(pem, 'The protected signing environment must supply a private key');
  assert.ok(
    process.env.UPDATE_TRUSTED_PUBLIC_KEYS_JSON,
    'Approved installed public keys are required'
  );
  assert.ok(
    process.env.RELEASE_SHA &&
      process.env.ACCEPTANCE_REPORT_PATH &&
      process.env.RELEASE_ASSET_DIRECTORY
  );
  const approvedPolicy = validatePublicPolicy({
    schemaVersion: 1,
    helperProtocol: 1,
    trustedKeys: JSON.parse(process.env.UPDATE_TRUSTED_PUBLIC_KEYS_JSON),
  });
  await signStagedRelease({
    directory: process.env.RELEASE_ASSET_DIRECTORY,
    report: JSON.parse(await readFile(process.env.ACCEPTANCE_REPORT_PATH, 'utf8')),
    commit: process.env.RELEASE_SHA,
    privateKey: createPrivateKey(pem),
    approvedPolicy,
  });
  if (process.env.SIGNING_PUBLIC_POLICY_PATH) {
    await writeFile(
      process.env.SIGNING_PUBLIC_POLICY_PATH,
      JSON.stringify(approvedPolicy) + '\n',
      {flag: 'wx', mode: 0o644}
    );
  }
});
