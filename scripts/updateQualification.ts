import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, readFile} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';

import {parseUniqueJson} from '../packages/electron/src/updateManifest.ts';
import {
  validateAcceptance,
  validatePublicPolicy,
  validateSignedAssets,
} from './updateRelease.ts';

export const qualificationCases = {
  'user-target': [
    'bootstrap',
    'two-version-upgrade',
    'authentication',
    'draft-guard',
    'original-user-restart',
    'packaged-database',
  ],
  'clean-desktop': [
    'bootstrap',
    'legacy-transition',
    'two-version-upgrade',
    'authentication',
    'capabilities',
    'staging-attacks',
    'package-policy',
    'unchanged-partial',
    'draft-guard',
    'original-user-restart',
    'launch-faults',
    'packaged-database',
  ],
  'disposable-vm': [
    'actor-interruption',
    'power-loss',
    'package-reconciliation',
    'database-storage-faults',
    'database-power-loss',
  ],
};
const hash = /^[a-f0-9]{64}$/;
const sha = /^[a-f0-9]{40}$/;
function object(value: unknown, keys: string[]) {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  assert.deepEqual(
    Object.keys(value).sort(),
    keys.sort(),
    'Unknown or missing evidence field'
  );
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum = 256): string {
  assert.ok(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= maximum &&
      !value.split('').some(character => character.charCodeAt(0) < 32)
  );
  return value;
}

function rows(value: unknown, maximum: number): unknown[] {
  assert.ok(Array.isArray(value) && value.length <= maximum);
  return value;
}

async function safePath(root: string, relative: unknown, directory = false) {
  const path = text(relative, 4096);
  assert.ok(
    !isAbsolute(path) &&
      !path.includes('\\') &&
      path.split('/').every(part => part && part !== '.' && part !== '..')
  );
  let current = root;
  assert.ok((await lstat(root)).isDirectory());
  for (const component of path.split('/')) {
    current = join(current, component);
    assert.ok(
      !(await lstat(current)).isSymbolicLink(),
      'Evidence cannot contain symbolic links'
    );
  }

  const info = await lstat(current);
  assert.ok(directory ? info.isDirectory() : info.isFile());
  return current;
}

async function json(root: string, path: unknown) {
  const file = await safePath(root, path);
  const info = await lstat(file);
  assert.ok(info.size > 0 && info.size <= 1024 * 1024, 'Bounded JSON evidence required');
  return parseUniqueJson(
    new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(await readFile(file))
  );
}

export async function qualifyUpdate(root: string, inputPath: string) {
  assert.ok(isAbsolute(root));
  const input = object(await json(root, inputPath), [
    'schemaVersion',
    'testedSha',
    'bundle',
    'runs',
    'roles',
    'cases',
  ]);
  assert.equal(input.schemaVersion, 1);
  const testedSha = text(input.testedSha);
  assert.match(testedSha, sha);
  const missing: string[] = [];
  const failures: string[] = [];
  const inventory: {path: string; byteLength: number; sha256: string}[] = [];
  const files = new Set<string>();
  async function collect(value: unknown, maximum = 8 * 1024 * 1024) {
    const name = text(value, 4096);
    if (files.has(name)) {
      return;
    }

    assert.ok(files.size < 512, 'Too many evidence files');
    const path = await safePath(root, name);
    const before = await lstat(path);
    assert.ok(before.size > 0 && before.size <= maximum, 'Evidence file exceeds bound');
    const digest = createHash('sha256');
    let length = 0;
    for await (const chunk of createReadStream(path)) {
      length += chunk.length;
      assert.ok(length <= maximum);
      digest.update(chunk);
    }

    const after = await lstat(path);
    assert.ok(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        length === before.size,
      'Evidence changed while collecting'
    );
    files.add(name);
    inventory.push({path: name, byteLength: length, sha256: digest.digest('hex')});
  }

  await collect(inputPath, 1024 * 1024);
  let installerDigest: string | null = null;
  if (input.bundle === null) {
    missing.push('signed-bundle');
  } else {
    const bundle = object(input.bundle, [
      'directory',
      'policy',
      'acceptance',
      'approval',
      'run',
    ]);
    const approval = object(await json(root, bundle.approval), [
      'schemaVersion',
      'runId',
      'testedSha',
      'environmentId',
      'reviewerId',
      'actorId',
      'triggeringActorId',
      'administratorBypassVerification',
    ]);
    assert.equal(approval.schemaVersion, 1);
    assert.equal(approval.testedSha, testedSha);
    for (const key of [
      'runId',
      'environmentId',
      'reviewerId',
      'actorId',
      'triggeringActorId',
    ]) {
      assert.ok(Number.isSafeInteger(approval[key]) && Number(approval[key]) > 0);
    }

    assert.ok(
      approval.reviewerId !== approval.actorId &&
        approval.reviewerId !== approval.triggeringActorId
    );
    assert.equal(approval.administratorBypassVerification, 'unobservable');
    const signingRun = (await json(root, bundle.run)) as Record<string, unknown>;
    assert.equal(signingRun.id, approval.runId);
    assert.equal(signingRun.head_sha, testedSha);
    assert.equal(signingRun.path, '.github/workflows/qualification-signing.yml');
    assert.equal(signingRun.head_branch, 'main');
    assert.equal(signingRun.event, 'workflow_dispatch');
    assert.equal(signingRun.run_attempt, 1);
    assert.equal(signingRun.status, 'completed');
    assert.equal(signingRun.conclusion, 'success');
    await collect(bundle.approval);
    await collect(bundle.run);
    const directory = await safePath(root, bundle.directory, true);
    const policy = validatePublicPolicy(await json(root, bundle.policy));
    await collect(bundle.policy);
    const rawManifest = (await json(
      root,
      text(bundle.directory) + '/shop-things-update-v1.json'
    )) as Record<string, unknown>;
    const artifact = rawManifest.artifact as Record<string, unknown>;
    assert.ok(artifact && typeof artifact === 'object');
    const filename = text(artifact.filename);
    for (const [name, bound] of [
      [filename, 1073741824],
      ['shop-things-update-v1.json', 65536],
      ['shop-things-update-v1.sig', 1024],
      ['SHA256SUMS', 4096],
    ] as const) {
      await collect(text(bundle.directory) + '/' + name, bound);
    }

    const manifest = await validateSignedAssets(directory, policy);
    installerDigest = manifest.artifact.sha256;
    validateAcceptance(
      (await json(root, bundle.acceptance)) as Parameters<typeof validateAcceptance>[0],
      testedSha,
      installerDigest
    );
    await collect(bundle.acceptance);
  }

  const seenRuns = new Set<string>();
  for (const value of rows(input.runs, 3)) {
    const run = object(value, ['workflow', 'runId', 'evidence']);
    const workflow = text(run.workflow);
    assert.ok(
      ['desktop.yml', 'scripts.yml', 'update-apt.yml'].includes(workflow) &&
        !seenRuns.has(workflow)
    );
    assert.ok(Number.isSafeInteger(run.runId) && Number(run.runId) > 0);
    const actual = (await json(root, run.evidence)) as Record<string, unknown>;
    assert.equal(actual.id, run.runId);
    assert.equal(actual.path, '.github/workflows/' + workflow);
    assert.equal(actual.head_sha, testedSha);
    assert.equal(actual.head_branch, 'main');
    assert.equal(actual.event, 'push');
    await collect(run.evidence);
    seenRuns.add(workflow);
    if (actual.status !== 'completed') {
      missing.push('ci:' + workflow);
    } else if (actual.conclusion !== 'success') {
      failures.push('ci:' + workflow);
    }
  }

  for (const workflow of ['desktop.yml', 'scripts.yml', 'update-apt.yml']) {
    if (!seenRuns.has(workflow)) {
      missing.push('ci:' + workflow);
    }
  }

  const roles = new Set<string>();
  for (const value of rows(input.roles, 3)) {
    const role = object(value, [
      'role',
      'platform',
      'architecture',
      'os',
      'kernel',
      'versions',
      'security',
    ]);
    const name = text(role.role);
    assert.ok(Object.hasOwn(qualificationCases, name) && !roles.has(name));
    assert.equal(role.platform, 'linux');
    assert.equal(role.architecture, 'arm64');
    text(role.os, 2048);
    text(role.kernel, 2048);
    const security = object(role.security, [
      'apparmorRestriction',
      'apparmorEnabled',
      'userNamespaces',
      'factorySettings',
    ]);
    for (const value of Object.values(security)) {
      text(value);
    }

    if (security.factorySettings !== 'verified') {
      missing.push(name + ':factory-security-evidence');
    }

    const versions = object(role.versions, [
      'app',
      'package',
      'helper',
      'apt',
      'dpkg',
      'pythonApt',
      'polkit',
      'gtk',
      'electron',
      'turso',
    ]);
    for (const version of Object.values(versions)) {
      text(version);
    }

    roles.add(name);
  }

  const seenCases = new Set<string>();
  for (const value of rows(input.cases, 64)) {
    const item = object(value, [
      'role',
      'case',
      'status',
      'execution',
      'testedSha',
      'installerSha256',
      'evidence',
      'details',
    ]);
    const role = text(item.role);
    const name = text(item.case);
    assert.ok(Object.hasOwn(qualificationCases, role));
    const allowed = qualificationCases[role as keyof typeof qualificationCases];
    assert.ok(allowed.includes(name));
    const id = role + ':' + name;
    assert.ok(!seenCases.has(id));
    seenCases.add(id);
    assert.equal(item.testedSha, testedSha);
    assert.match(text(item.installerSha256), hash);
    if (installerDigest !== null) {
      assert.equal(item.installerSha256, installerDigest);
    }

    text(item.details, 4096);
    assert.ok(['passed', 'failed', 'pending'].includes(text(item.status)));
    assert.ok(['actual', 'controlled'].includes(text(item.execution)));
    const evidence = rows(item.evidence, 32);
    for (const file of evidence) {
      await collect(file);
    }

    if (item.status === 'failed') {
      failures.push(id);
    } else if (
      item.status !== 'passed' ||
      item.execution !== 'actual' ||
      evidence.length === 0 ||
      !roles.has(role)
    ) {
      missing.push(id);
    }
  }

  for (const [role, cases] of Object.entries(qualificationCases)) {
    for (const name of cases) {
      if (!seenCases.has(role + ':' + name)) {
        missing.push(role + ':' + name);
      }
    }
  }

  return {
    schemaVersion: 1,
    testedSha,
    installerSha256: installerDigest,
    status: failures.length ? 'failed' : missing.length ? 'pending' : 'passed',
    missing,
    failures,
    inventory,
    authority:
      'Evidence for independent review; does not authorize signing, qualification settings or publication.',
  };
}
