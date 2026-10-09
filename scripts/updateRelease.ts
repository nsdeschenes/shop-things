import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, createPublicKey, sign, type KeyObject} from 'node:crypto';
import {lstat, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  verifyUpdateManifest,
  type UpdateManifest,
} from '../packages/electron/src/updateManifest.ts';

export interface PublicUpdatePolicy {
  schemaVersion: 1;
  helperProtocol: 1;
  trustedKeys: string[];
}
export interface ReleaseEvidence {
  schemaVersion: number;
  status: string;
  commit: string;
  artifacts: {path: string; sha256: string}[];
}
export interface AcceptanceEvidence {
  schemaVersion: number;
  status: string;
  commit: string;
  environment: {target: string};
  shippedBackend: ReleaseEvidence;
  packagedRenderer: ReleaseEvidence;
}
const commitPattern = /^[0-9a-f]{40}$/;

export function validatePublicPolicy(value: unknown): PublicUpdatePolicy {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [
    'helperProtocol',
    'schemaVersion',
    'trustedKeys',
  ]);
  assert.ok(
    'schemaVersion' in value &&
      value.schemaVersion === 1 &&
      'helperProtocol' in value &&
      value.helperProtocol === 1
  );
  assert.ok(
    'trustedKeys' in value &&
      Array.isArray(value.trustedKeys) &&
      value.trustedKeys.length > 0 &&
      value.trustedKeys.length <= 16
  );
  const trustedKeys = value.trustedKeys.map((pem: unknown) => {
    assert.ok(
      typeof pem === 'string' &&
        pem.length <= 4096 &&
        pem.startsWith('-----BEGIN PUBLIC KEY-----\n'),
      'Only public SPKI publisher keys may be packaged'
    );
    const key = createPublicKey(pem);
    assert.equal(key.asymmetricKeyType, 'ed25519', 'Publisher key must be Ed25519');
    const canonical = key.export({type: 'spki', format: 'pem'}).toString();
    assert.equal(
      pem.trim(),
      canonical.trim(),
      'Publisher key must contain only public PEM'
    );
    return canonical;
  });
  assert.equal(new Set(trustedKeys).size, trustedKeys.length, 'Duplicate publisher key');
  return {schemaVersion: 1, helperProtocol: 1, trustedKeys};
}

export function debianIdentity(path: string) {
  const metadata = execFileSync(
    '/usr/bin/dpkg-deb',
    ['--field', path, 'Package', 'Version', 'Architecture'],
    {encoding: 'utf8', maxBuffer: 8192, timeout: 30000}
  );
  const fields = Object.fromEntries(
    metadata
      .trim()
      .split('\n')
      .map(line => line.split(': '))
  );
  assert.equal(fields.Package, 'shop-things', 'Expected Shop Things Debian identity');
  assert.equal(fields.Architecture, 'arm64', 'Expected embedded ARM64 architecture');
  assert.ok(fields.Version, 'Embedded Debian version is required');
  return {
    packageName: fields.Package,
    packageVersion: fields.Version,
    architecture: fields.Architecture,
  };
}

export function validateAcceptance(
  report: AcceptanceEvidence,
  commit: string,
  digest: string
) {
  assert.match(commit, commitPattern, 'A full tested commit SHA is required');
  assert.equal(report.schemaVersion, 3, 'Current acceptance provenance is required');
  assert.equal(report.status, 'passed', 'Acceptance must pass');
  assert.equal(report.commit, commit, 'Acceptance must test the release commit');
  assert.equal(report.environment.target, 'linux-arm64-glibc');
  for (const evidence of [report.shippedBackend, report.packagedRenderer]) {
    assert.ok(evidence, 'Both packaged acceptance records are required');
    assert.equal(evidence.schemaVersion, 2);
    assert.equal(evidence.status, 'passed');
    assert.equal(evidence.commit, commit);
    const installers = evidence.artifacts.filter(artifact =>
      artifact.path.endsWith('.deb')
    );
    assert.equal(installers.length, 1, 'Acceptance must identify one installer');
    assert.equal(
      installers[0]!.sha256,
      digest,
      'Staged bytes must be the accepted installer'
    );
  }
}

async function installerPolicy(path: string): Promise<PublicUpdatePolicy> {
  const temporary = await mkdtemp(join(tmpdir(), 'shop-things-release-policy-'));
  try {
    execFileSync('/usr/bin/dpkg-deb', ['--extract', path, temporary], {timeout: 30000});
    const policyPath = join(temporary, 'opt/Shop Things/resources/update/policy.json');
    for (const folder of [
      'opt',
      'opt/Shop Things',
      'opt/Shop Things/resources',
      'opt/Shop Things/resources/update',
    ]) {
      assert.ok(
        (await lstat(join(temporary, folder))).isDirectory(),
        'Packaged trust directories cannot be symlinks'
      );
    }

    assert.ok(
      (await lstat(policyPath)).isFile(),
      'Packaged public policy cannot be a symlink'
    );
    const bytes = await readFile(policyPath);
    assert.ok(
      bytes.length > 0 && bytes.length <= 65536,
      'Tested installer must contain approved public trust policy'
    );
    return validatePublicPolicy(
      JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes))
    );
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

export async function validateSignedAssets(
  directory: string,
  policy: PublicUpdatePolicy
): Promise<UpdateManifest> {
  const bytes = await readFile(join(directory, 'shop-things-update-v1.json'));
  const signature = await readFile(join(directory, 'shop-things-update-v1.sig'));
  const manifest = verifyUpdateManifest(
    bytes,
    signature,
    validatePublicPolicy(policy).trustedKeys
  );
  assert.deepEqual(
    (await readdir(directory)).sort(),
    [
      'SHA256SUMS',
      manifest.artifact.filename,
      'shop-things-update-v1.json',
      'shop-things-update-v1.sig',
    ].sort(),
    'Exactly four coherent release assets are required'
  );
  const installer = join(directory, manifest.artifact.filename);
  const metadata = await lstat(installer);
  assert.ok(metadata.isFile() && metadata.size === manifest.artifact.byteLength);
  const digest = createHash('sha256')
    .update(await readFile(installer))
    .digest('hex');
  assert.equal(
    digest,
    manifest.artifact.sha256,
    'Installer bytes must match the signed manifest'
  );
  const appIdentity = JSON.parse(
    execFileSync(
      '/usr/bin/python3',
      [
        '-I',
        fileURLToPath(new URL('./readPackageIdentity.py', import.meta.url)),
        installer,
      ],
      {encoding: 'utf8', timeout: 30000, maxBuffer: 8192}
    )
  );
  assert.equal(
    appIdentity.appVersion,
    manifest.appVersion,
    'Tested package application identity must match signed manifest'
  );
  assert.deepEqual(debianIdentity(installer), {
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
    architecture: manifest.architecture,
  });
  assert.equal(
    await readFile(join(directory, 'SHA256SUMS'), 'utf8'),
    `${digest}  ${manifest.artifact.filename}\n`,
    'Checksums must cover the exact final installer'
  );
  assert.deepEqual(
    await installerPolicy(installer),
    validatePublicPolicy(policy),
    'Approved public policy must already be embedded before acceptance'
  );
  return manifest;
}

export async function signStagedRelease(options: {
  directory: string;
  report: AcceptanceEvidence;
  commit: string;
  privateKey: KeyObject;
  approvedPolicy: PublicUpdatePolicy;
}) {
  const bytes = await readFile(join(options.directory, 'shop-things-update-v1.json'));
  assert.equal(
    options.privateKey.asymmetricKeyType,
    'ed25519',
    'Signing key must be Ed25519'
  );
  const signature = sign(null, bytes, options.privateKey);
  const manifest = verifyUpdateManifest(
    bytes,
    signature,
    validatePublicPolicy(options.approvedPolicy).trustedKeys
  );
  validateAcceptance(options.report, options.commit, manifest.artifact.sha256);
  const signaturePath = join(options.directory, 'shop-things-update-v1.sig');
  await writeFile(signaturePath, signature, {flag: 'wx', mode: 0o644});
  try {
    await validateSignedAssets(options.directory, options.approvedPolicy);
  } catch (error) {
    await rm(signaturePath);
    throw error;
  }
}

export interface DraftRelease {
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  tag_name: string;
  target_commitish: string;
  assets: {name: string; state: string; size: number; digest: string | null}[];
}

export async function validateDraftRelease(
  release: DraftRelease,
  directory: string,
  policy: PublicUpdatePolicy,
  commit: string,
  version: string
) {
  const manifest = await validateSignedAssets(directory, policy);
  assert.equal(manifest.appVersion, version);
  assert.equal(release.draft, true, 'Validate the complete draft before publishing');
  assert.equal(release.prerelease, false);
  assert.equal(
    release.immutable,
    false,
    'Published immutable releases cannot be repaired in place'
  );
  assert.equal(release.tag_name, `v${version}`);
  assert.equal(
    release.target_commitish,
    commit,
    'The draft must target the accepted commit'
  );
  const names = (await readdir(directory)).sort();
  assert.deepEqual(
    release.assets.map(asset => asset.name).sort(),
    names,
    'Draft must contain the complete four-asset set'
  );
  for (const asset of release.assets) {
    assert.equal(asset.state, 'uploaded');
    const bytes = await readFile(join(directory, asset.name));
    assert.equal(asset.size, bytes.length);
    assert.equal(
      asset.digest,
      'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      'Uploaded bytes must match the independently verified local set'
    );
  }
}
