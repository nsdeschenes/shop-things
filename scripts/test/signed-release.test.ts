import {createHash, generateKeyPairSync} from 'node:crypto';
import {readFile, readdir, rm, writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import {
  type PublicUpdatePolicy,
  signStagedRelease,
  validateSignedAssets,
  validateDraftRelease,
  validatePublicPolicy,
} from '../updateRelease.ts';
import {
  createDebianFixture,
  createReleaseFixture,
  runReleaseScript,
  releaseAcceptance,
} from './releaseHelpers.ts';

test('stages exact-byte update manifest with actual embedded Debian identity', async () => {
  const directory = await createReleaseFixture();
  const commit = 'a'.repeat(40);
  const {publicKey} = generateKeyPairSync('ed25519');
  try {
    const installer = await createDebianFixture(directory, {
      policy: {
        schemaVersion: 1,
        helperProtocol: 1,
        trustedKeys: [publicKey.export({type: 'spki', format: 'pem'})],
      },
    });
    await mkdir(join(directory, 'reports'));
    await writeFile(
      join(directory, 'reports/acceptance.json'),
      JSON.stringify(await releaseAcceptance(commit, installer))
    );
    expect(
      runReleaseScript(directory, 'stage-release', {
        GITHUB_SHA: commit,
        ACCEPTANCE_REPORT_DIR: join(directory, 'reports'),
      }).status
    ).toBe(0);
    expect(await readdir(join(directory, 'release/assets'))).toContain(
      'shop-things-update-v1.json'
    );
    const manifest = JSON.parse(
      await readFile(join(directory, 'release/assets/shop-things-update-v1.json'), 'utf8')
    );
    expect(manifest).toMatchObject({
      packageName: 'shop-things',
      packageVersion: '0.0.1-1',
      appVersion: '0.0.1',
      architecture: 'arm64',
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('signs the accepted complete artifact set with installed trust and rejects altered bytes', async () => {
  const directory = await createReleaseFixture();
  const commit = 'a'.repeat(40);
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const policy: PublicUpdatePolicy = {
    schemaVersion: 1,
    helperProtocol: 1,
    trustedKeys: [publicKey.export({type: 'spki', format: 'pem'}).toString()],
  };
  try {
    const installer = await createDebianFixture(directory, {policy});
    const digest = createHash('sha256')
      .update(await readFile(installer))
      .digest('hex');
    const evidence = {
      schemaVersion: 2,
      status: 'passed',
      commit,
      artifacts: [{path: 'shop-things_0.0.1_arm64.deb', sha256: digest}],
    };
    const report = {
      schemaVersion: 3,
      status: 'passed',
      commit,
      environment: {target: 'linux-arm64-glibc'},
      shippedBackend: evidence,
      packagedRenderer: evidence,
    };
    await mkdir(join(directory, 'reports'));
    await writeFile(join(directory, 'reports/acceptance.json'), JSON.stringify(report));
    expect(
      runReleaseScript(directory, 'stage-release', {
        GITHUB_SHA: commit,
        ACCEPTANCE_REPORT_DIR: join(directory, 'reports'),
      }).status
    ).toBe(0);
    const assets = join(directory, 'release/assets');
    await signStagedRelease({
      directory: assets,
      report,
      commit,
      privateKey,
      approvedPolicy: policy,
    });
    expect(await readdir(assets)).toHaveLength(4);
    expect((await validateSignedAssets(assets, policy)).packageVersion).toBe('0.0.1-1');
    const uploaded = await Promise.all(
      (await readdir(assets)).map(async name => {
        const bytes = await readFile(join(assets, name));
        return {
          name,
          state: 'uploaded',
          size: bytes.length,
          digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        };
      })
    );
    const draft = {
      draft: true,
      prerelease: false,
      immutable: false,
      tag_name: 'v0.0.1',
      target_commitish: commit,
      assets: uploaded,
    };
    await expect(
      validateDraftRelease(draft, assets, policy, commit, '0.0.1')
    ).resolves.toBeUndefined();
    await expect(
      validateDraftRelease(
        {...draft, assets: uploaded.slice(1)},
        assets,
        policy,
        commit,
        '0.0.1'
      )
    ).rejects.toThrow('complete four-asset');
    await expect(
      validateDraftRelease(
        {...draft, target_commitish: 'b'.repeat(40)},
        assets,
        policy,
        commit,
        '0.0.1'
      )
    ).rejects.toThrow('accepted commit');
    await writeFile(
      join(assets, 'shop-things-0.0.1-linux-arm64.deb'),
      'replaced after acceptance'
    );
    await expect(validateSignedAssets(assets, policy)).rejects.toThrow();
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('publication fails closed without required independent signing approval and repository immutability', async () => {
  const {validateSigningProtection} = await import('../releaseProtection.ts');
  const environment = {
    id: 17,
    name: 'update-signing',
    protection_rules: [
      {
        type: 'required_reviewers',
        prevent_self_review: true,
        reviewers: [{type: 'User', reviewer: {id: 1, type: 'User'}}],
      },
    ],
    deployment_branch_policy: {protected_branches: false, custom_branch_policies: true},
  };
  const branches = {total_count: 1, branch_policies: [{name: 'main', type: 'branch'}]};
  expect(() =>
    validateSigningProtection(environment, branches, {
      enabled: true,
      enforced_by_owner: false,
    })
  ).not.toThrow();
  for (const unsafe of [
    {...environment, protection_rules: []},
    {...environment, deployment_branch_policy: null},
    {
      ...environment,
      protection_rules: [
        {type: 'required_reviewers', prevent_self_review: false, reviewers: []},
      ],
    },
  ]) {
    expect(() =>
      validateSigningProtection(unsafe, branches, {
        enabled: true,
        enforced_by_owner: false,
      })
    ).toThrow();
  }

  expect(() =>
    validateSigningProtection(environment, branches, {
      enabled: false,
      enforced_by_owner: false,
    })
  ).toThrow();
  expect(() =>
    validateSigningProtection(
      environment,
      {...branches, branch_policies: [{name: '*', type: 'branch'}]},
      {enabled: true, enforced_by_owner: false}
    )
  ).toThrow();
});

test('retained bridge assets remain verifiable by old installed trust without discovering new keys', async () => {
  const {sign, verifyUpdateManifest} = await import('node:crypto').then(async crypto => ({
    sign: crypto.sign,
    verifyUpdateManifest: (await import('../../packages/electron/src/updateManifest.ts'))
      .verifyUpdateManifest,
  }));
  const old = generateKeyPairSync('ed25519');
  const next = generateKeyPairSync('ed25519');
  const bridge = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      applicationId: 'com.shopthings.app',
      repository: 'nsdeschenes/shop-things',
      channel: 'stable',
      appVersion: '0.4.0',
      packageName: 'shop-things',
      packageVersion: '0.4.0-2',
      platform: 'linux',
      architecture: 'arm64',
      helperProtocol: {min: 1, max: 1},
      artifact: {
        filename: 'shop-things-0.4.0-linux-arm64.deb',
        byteLength: 12,
        sha256: 'a'.repeat(64),
      },
    })
  );
  expect(
    verifyUpdateManifest(bridge, sign(null, bridge, old.privateKey), [old.publicKey])
  ).toMatchObject({appVersion: '0.4.0', helperProtocol: {min: 1, max: 1}});
  expect(() =>
    verifyUpdateManifest(bridge, sign(null, bridge, next.privateKey), [old.publicKey])
  ).toThrow('not trusted');
  expect(
    verifyUpdateManifest(bridge, sign(null, bridge, next.privateKey), [
      old.publicKey,
      next.publicKey,
    ]).appVersion
  ).toBe('0.4.0');
});

test('tag publication refuses stale tags, authorization failures and redirects', async () => {
  const {verifyReleaseTag} = await import('../verify-release-tag.ts');
  const sha = 'a'.repeat(40);
  async function transport() {
    return new Response(JSON.stringify({object: {type: 'commit', sha: 'b'.repeat(40)}}));
  }

  await expect(
    verifyReleaseTag('0.0.1', sha, 'test-only-token', transport)
  ).rejects.toThrow('tested release commit');
  await expect(
    verifyReleaseTag(
      '0.0.1',
      sha,
      'test-only-token',
      async () => new Response('', {status: 404})
    )
  ).resolves.toBeUndefined();
  await expect(
    verifyReleaseTag(
      '0.0.1',
      sha,
      'test-only-token',
      async () => new Response('', {status: 403})
    )
  ).rejects.toThrow('could not be verified');
});

test('public trust provisioning rejects private PEM material before writing ordinary artifacts', async () => {
  const {validatePublicPolicy} = await import('../updateRelease.ts');
  const {privateKey} = generateKeyPairSync('ed25519');
  expect(() =>
    validatePublicPolicy({
      schemaVersion: 1,
      helperProtocol: 1,
      trustedKeys: [privateKey.export({type: 'pkcs8', format: 'pem'}).toString()],
    })
  ).toThrow('Only public SPKI');
});

test.each([{packageName: 'electron'}, {architecture: 'amd64'}])(
  'staging rejects accepted bytes with incompatible embedded package identity %o',
  async invalid => {
    const directory = await createReleaseFixture();
    const commit = 'a'.repeat(40);
    try {
      const installer = await createDebianFixture(directory, invalid);
      await mkdir(join(directory, 'reports'));
      await writeFile(
        join(directory, 'reports/acceptance.json'),
        JSON.stringify(await releaseAcceptance(commit, installer))
      );
      expect(
        runReleaseScript(directory, 'stage-release', {
          GITHUB_SHA: commit,
          ACCEPTANCE_REPORT_DIR: join(directory, 'reports'),
        }).status
      ).toBe(1);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  }
);

test('signing refuses a tested installer without approved embedded public trust', async () => {
  const directory = await createReleaseFixture();
  const commit = 'a'.repeat(40);
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  try {
    const installer = await createDebianFixture(directory);
    const report = await releaseAcceptance(commit, installer);
    await mkdir(join(directory, 'reports'));
    await writeFile(join(directory, 'reports/acceptance.json'), JSON.stringify(report));
    expect(
      runReleaseScript(directory, 'stage-release', {
        GITHUB_SHA: commit,
        ACCEPTANCE_REPORT_DIR: join(directory, 'reports'),
      }).status
    ).toBe(0);
    const policy: PublicUpdatePolicy = {
      schemaVersion: 1,
      helperProtocol: 1,
      trustedKeys: [publicKey.export({type: 'spki', format: 'pem'}).toString()],
    };
    await expect(
      signStagedRelease({
        directory: join(directory, 'release/assets'),
        report,
        commit,
        privateKey,
        approvedPolicy: policy,
      })
    ).rejects.toThrow();
    expect(await readdir(join(directory, 'release/assets'))).not.toContain(
      'shop-things-update-v1.sig'
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('refuses a signed release whose packaged app identity is older than its manifest', async () => {
  const directory = await createReleaseFixture();
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const policy: PublicUpdatePolicy = {
    schemaVersion: 1,
    helperProtocol: 1,
    trustedKeys: [publicKey.export({type: 'spki', format: 'pem'}).toString()],
  };
  const commit = 'a'.repeat(40);
  try {
    const installer = await createDebianFixture(directory, {policy, appVersion: '0.0.0'});
    const report = await releaseAcceptance(commit, installer);
    await mkdir(join(directory, 'reports'));
    await writeFile(join(directory, 'reports/acceptance.json'), JSON.stringify(report));
    expect(
      runReleaseScript(directory, 'stage-release', {
        GITHUB_SHA: commit,
        ACCEPTANCE_REPORT_DIR: join(directory, 'reports'),
      }).status
    ).toBe(0);
    await expect(
      signStagedRelease({
        directory: join(directory, 'release/assets'),
        report,
        commit,
        privateKey,
        approvedPolicy: policy,
      })
    ).rejects.toThrow('application identity');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('signing refuses duplicate embedded trust fields concealing private material', async () => {
  const directory = await createReleaseFixture();
  const commit = 'a'.repeat(40);
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  try {
    const publicPem = publicKey.export({type: 'spki', format: 'pem'}).toString();
    const privatePem = privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
    const rawPolicy = `{"schemaVersion":1,"helperProtocol":1,"trustedKeys":${JSON.stringify([privatePem])},"trustedKeys":${JSON.stringify([publicPem])}}`;
    const installer = await createDebianFixture(directory, {policy: rawPolicy});
    const report = await releaseAcceptance(commit, installer);
    await mkdir(join(directory, 'reports'));
    await writeFile(join(directory, 'reports/acceptance.json'), JSON.stringify(report));
    expect(
      runReleaseScript(directory, 'stage-release', {
        GITHUB_SHA: commit,
        ACCEPTANCE_REPORT_DIR: join(directory, 'reports'),
      }).status
    ).toBe(0);
    const policy: PublicUpdatePolicy = {
      schemaVersion: 1,
      helperProtocol: 1,
      trustedKeys: [publicKey.export({type: 'spki', format: 'pem'}).toString()],
    };
    await expect(
      signStagedRelease({
        directory: join(directory, 'release/assets'),
        report,
        commit,
        privateKey,
        approvedPolicy: policy,
      })
    ).rejects.toThrow('Duplicate JSON key');
    expect(await readdir(join(directory, 'release/assets'))).not.toContain(
      'shop-things-update-v1.sig'
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('shared runtime/release trust validation rejects duplicate canonical publisher keys', () => {
  const {publicKey} = generateKeyPairSync('ed25519');
  const key = publicKey.export({type: 'spki', format: 'pem'}).toString();
  expect(() =>
    validatePublicPolicy({schemaVersion: 1, helperProtocol: 1, trustedKeys: [key, key]})
  ).toThrow('Duplicate publisher key');
});
