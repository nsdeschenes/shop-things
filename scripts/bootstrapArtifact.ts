import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';

const digestPattern = /^[a-f0-9]{64}$/;
const packagePattern = /^Package: shop-things\nVersion: [^\n]+\nArchitecture: arm64\n$/;

interface AcceptedPackageReport {
  status: string;
  target: string;
  commit: string;
  dirtyCheckout: boolean;
  artifacts: {path: string; sha256: string}[];
  installedSystem: {package: string};
}

// External fixture evidence, never package-install authority or release approval.
export async function acceptedBootstrapArtifact(
  release: string,
  accepted: AcceptedPackageReport,
  commit: string
) {
  assert.equal(accepted.status, 'passed', 'Require passed packaged acceptance');
  assert.equal(accepted.target, 'linux-arm64');
  assert.equal(accepted.commit, commit, 'Require the exact accepted checkout');
  assert.equal(accepted.dirtyCheckout, false);
  const names = (await readdir(release)).filter(name => name.endsWith('_arm64.deb'));
  assert.equal(names.length, 1, 'Require the single raw ARM64 installer');
  const name = names[0];
  assert.ok(name);
  const artifacts = accepted.artifacts.filter(file => file.path.endsWith('_arm64.deb'));
  assert.equal(artifacts.length, 1);
  const artifact = artifacts[0];
  assert.ok(artifact);
  assert.equal(artifact.path, name, 'Require the exact accepted raw artifact');
  assert.match(artifact.sha256, digestPattern);
  const path = join(release, name);
  const sha256 = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  assert.equal(sha256, artifact.sha256, 'Installer bytes must match accepted inventory');
  const metadata = execFileSync(
    '/usr/bin/dpkg-deb',
    ['--field', path, 'Package', 'Version', 'Architecture'],
    {encoding: 'utf8'}
  );
  assert.match(metadata, packagePattern);
  assert.equal(
    metadata,
    accepted.installedSystem.package,
    'Require the accepted installed package identity'
  );
  return {path, sha256};
}
