// Explicit disposable ARM64 desktop fixture; never an ordinary CI/app entry.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
} from 'node:crypto';
import {chmod, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  invokeUpdateHelper,
  protectedSystemFile,
  updateHelperPath,
  updateIdentityPath,
} from '../packages/electron/src/updateHelperProtocol.ts';
import {stableVersion} from '../packages/electron/src/updateManifest.ts';
import {loadInstalledUpdatePolicy} from '../packages/electron/src/updatePolicy.ts';
import {root, runIfMain} from './workspace.ts';

await runIfMain(import.meta.url, async () => {
  assert.equal(
    process.env.HELPER_ACCEPTANCE_DISPOSABLE_INSTALL,
    '1',
    'This mutating acceptance runner requires an explicitly disposable installation.'
  );
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'arm64');
  assert.ok(process.getuid?.() && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY));
  // Operator-generated TEST key must already be provisioned in a disposable
  // bootstrap fixture. This runner never writes installed policy or packages.
  assert.ok(
    process.env.HELPER_ACCEPTANCE_TEST_KEY_FILE &&
      process.env.HELPER_ACCEPTANCE_TARGET_VERSION &&
      process.env.HELPER_ACCEPTANCE_TARGET_PACKAGE_VERSION &&
      process.env.HELPER_ACCEPTANCE_INSTALLER_FILE
  );
  const privateKey = createPrivateKey(
    await readFile(process.env.HELPER_ACCEPTANCE_TEST_KEY_FILE)
  );
  const publicKey = createPublicKey(privateKey)
    .export({type: 'spki', format: 'pem'})
    .toString();
  const policy = await loadInstalledUpdatePolicy();
  assert.ok(policy.trustedKeys.includes(publicKey));
  assert.deepEqual(
    await protectedSystemFile(updateHelperPath, 1048576),
    await readFile(join(root, 'packages/electron/update/updater-helper.py'))
  );
  const version = process.env.HELPER_ACCEPTANCE_TARGET_VERSION;
  assert.match(version, stableVersion);
  const current = JSON.parse(
    (await protectedSystemFile(updateIdentityPath, 4096)).toString()
  );
  assert.notEqual(version, current.appVersion);
  function snapshot() {
    return execFileSync(
      '/usr/bin/dpkg-query',
      [
        '--show',
        '--showformat=${binary:Package}\t${Status}\t${Version}\t${Architecture}\n',
      ],
      {maxBuffer: 16777216}
    );
  }

  const baseline = snapshot();
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-packaged-helper-'));
  await chmod(directory, 0o700);
  try {
    // Use the complete already-built/qualified installer. Never construct a tiny
    // package that would replace the real application with an identity-only payload.
    const candidate = join(directory, 'candidate.deb');
    await writeFile(
      candidate,
      await readFile(process.env.HELPER_ACCEPTANCE_INSTALLER_FILE!)
    );
    await chmod(candidate, 0o600);
    const bytes = await readFile(candidate);
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        applicationId: 'com.shopthings.app',
        repository: 'nsdeschenes/shop-things',
        channel: 'stable',
        appVersion: version,
        packageName: 'shop-things',
        packageVersion: process.env.HELPER_ACCEPTANCE_TARGET_PACKAGE_VERSION,
        platform: 'linux',
        architecture: 'arm64',
        helperProtocol: {min: 1, max: 1},
        artifact: {
          filename: `shop-things-${version}-linux-arm64.deb`,
          byteLength: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      })
    );
    const request = {
      protocol: 1 as const,
      attemptId: randomUUID(),
      manifest: manifest.toString('base64'),
      signature: sign(null, manifest, privateKey).toString('base64'),
      candidatePath: candidate,
    };
    const valid = await invokeUpdateHelper(request);
    assert.equal(valid.outcome, 'installed');
    const installedBaseline = snapshot();
    // The valid fixture is a real package transaction; subsequent attacks must
    // preserve the newly installed state rather than the old package baseline.
    const link = join(directory, 'link.deb');
    await symlink(candidate, link);
    for (const changed of [
      {...request, candidatePath: link},
      {...request, signature: Buffer.alloc(64).toString('base64')},
    ]) {
      assert.equal(
        (await invokeUpdateHelper({...changed, attemptId: randomUUID()})).outcome,
        'rejected'
      );
    }

    await writeFile(candidate, Buffer.concat([bytes, Buffer.from('tampered')]));
    assert.equal(
      (await invokeUpdateHelper({...request, attemptId: randomUUID()})).outcome,
      'rejected'
    );
    assert.notDeepEqual(
      installedBaseline,
      baseline,
      'The valid upgrade must change the installed package inventory'
    );
    assert.deepEqual(
      snapshot(),
      installedBaseline,
      'Rejected attacks must preserve installed package inventory'
    );
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        status: 'passed',
        target: 'linux-arm64',
        helperDigest: createHash('sha256')
          .update(await protectedSystemFile(updateHelperPath, 1048576))
          .digest('hex'),
        checks: [
          'valid-installed-transaction',
          'symlink-rejected',
          'bad-signature-rejected',
          'tamper-rejected',
          'full-package-inventory-unchanged',
        ],
      })
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
