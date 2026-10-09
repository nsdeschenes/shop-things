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
import {chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
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
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'arm64');
  assert.ok(process.getuid?.() && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY));
  // Operator-generated TEST key must already be provisioned in a disposable
  // bootstrap fixture. This runner never writes installed policy or packages.
  assert.ok(
    process.env.HELPER_ACCEPTANCE_TEST_KEY_FILE &&
      process.env.HELPER_ACCEPTANCE_TARGET_VERSION
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
    const payload = join(directory, 'payload');
    await mkdir(join(payload, 'DEBIAN'), {recursive: true});
    await writeFile(
      join(payload, 'DEBIAN/control'),
      `Package: shop-things\nVersion: ${version}\nArchitecture: arm64\nMaintainer: Fixture <noreply@example.com>\nDescription: Nonmutating packaged helper acceptance\n`
    );
    const identity = join(payload, 'opt/Shop Things/resources/update');
    await mkdir(identity, {recursive: true});
    await writeFile(
      join(identity, 'identity.json'),
      JSON.stringify({schemaVersion: 1, packageName: 'shop-things', appVersion: version})
    );
    const candidate = join(directory, 'candidate.deb');
    execFileSync(
      '/usr/bin/dpkg-deb',
      ['--build', '--root-owner-group', payload, candidate],
      {stdio: 'ignore'}
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
        packageVersion: version,
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
    assert.equal(valid.outcome, 'install-disabled');
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
    assert.deepEqual(snapshot(), baseline, 'Package inventory must remain unchanged');
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        status: 'passed',
        target: 'linux-arm64',
        helperDigest: createHash('sha256')
          .update(await protectedSystemFile(updateHelperPath, 1048576))
          .digest('hex'),
        checks: [
          'valid-verified-no-mutation',
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
