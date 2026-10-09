import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp, writeFile, rm, mkdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import {qualifyUpdate, qualificationCases} from '../updateQualification.ts';
import {signStagedRelease} from '../updateRelease.ts';
import {
  createReleaseFixture,
  createDebianFixture,
  releaseAcceptance,
  runReleaseScript,
} from './releaseHelpers.ts';

test('missing real desktop, bundle and VM evidence remains pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qualification-'));
  try {
    const input = {
      schemaVersion: 1,
      testedSha: 'a'.repeat(40),
      bundle: null,
      runs: [],
      roles: [],
      cases: [],
    };
    await writeFile(join(root, 'input.json'), JSON.stringify(input));
    const report = await qualifyUpdate(root, 'input.json');
    expect(report.status).toBe('pending');
    expect(report.missing).toContain('signed-bundle');
    expect(report.missing).toContain('user-target:two-version-upgrade');
    expect(report.missing).toContain('disposable-vm:power-loss');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('controlled CI and process fixtures cannot count as real desktop proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qualification-'));
  try {
    await writeFile(join(root, 'fixture.log'), 'external simulated process result');
    const input = {
      schemaVersion: 1,
      testedSha: 'a'.repeat(40),
      bundle: null,
      runs: [],
      roles: [],
      cases: [
        {
          role: 'user-target',
          case: 'two-version-upgrade',
          status: 'passed',
          execution: 'controlled',
          testedSha: 'a'.repeat(40),
          installerSha256: 'b'.repeat(64),
          evidence: ['fixture.log'],
          details: 'controlled transport and process boundary only',
        },
      ],
    };
    await writeFile(join(root, 'input.json'), JSON.stringify(input));
    const report = await qualifyUpdate(root, 'input.json');
    expect(report.status).toBe('pending');
    expect(report.missing).toContain('user-target:two-version-upgrade');
    expect(report.inventory.find(file => file.path === 'fixture.log')).toMatchObject({
      byteLength: 33,
    });
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('wrong-SHA CI, duplicate JSON and escaping evidence fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qualification-'));
  try {
    await writeFile(
      join(root, 'run.json'),
      JSON.stringify({
        id: 1,
        path: '.github/workflows/update-apt.yml',
        head_sha: 'b'.repeat(40),
        head_branch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
      })
    );
    await writeFile(
      join(root, 'input.json'),
      JSON.stringify({
        schemaVersion: 1,
        testedSha: 'a'.repeat(40),
        bundle: null,
        runs: [{workflow: 'update-apt.yml', runId: 1, evidence: 'run.json'}],
        roles: [],
        cases: [],
      })
    );
    await expect(qualifyUpdate(root, 'input.json')).rejects.toThrow();
    await writeFile(join(root, 'input.json'), '{"schemaVersion":1,"schemaVersion":1}');
    await expect(qualifyUpdate(root, 'input.json')).rejects.toThrow('Duplicate');
    await expect(qualifyUpdate(root, '../input.json')).rejects.toThrow();
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('aggregates coherent signed bytes and complete reported observations without granting authority', async () => {
  const root = await createReleaseFixture();
  const testedSha = 'a'.repeat(40);
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const policy = {
    schemaVersion: 1 as const,
    helperProtocol: 1 as const,
    trustedKeys: [publicKey.export({type: 'spki', format: 'pem'}).toString()],
  };
  try {
    const installer = await createDebianFixture(root, {policy});
    const acceptance = await releaseAcceptance(testedSha, installer);
    await mkdir(join(root, 'reports'));
    await writeFile(join(root, 'reports/acceptance.json'), JSON.stringify(acceptance));
    expect(
      runReleaseScript(root, 'stage-release', {
        GITHUB_SHA: testedSha,
        ACCEPTANCE_REPORT_DIR: join(root, 'reports'),
      }).status
    ).toBe(0);
    await signStagedRelease({
      directory: join(root, 'release/assets'),
      report: acceptance,
      commit: testedSha,
      privateKey,
      approvedPolicy: policy,
    });
    const manifest = JSON.parse(
      await readFile(join(root, 'release/assets/shop-things-update-v1.json'), 'utf8')
    );
    await writeFile(join(root, 'policy.json'), JSON.stringify(policy));
    await writeFile(
      join(root, 'approval.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: 10,
        testedSha,
        environmentId: 17,
        reviewerId: 3,
        actorId: 1,
        triggeringActorId: 2,
        administratorBypassVerification: 'unobservable',
      })
    );
    await writeFile(
      join(root, 'signing-run.json'),
      JSON.stringify({
        id: 10,
        head_sha: testedSha,
        path: '.github/workflows/qualification-signing.yml',
        head_branch: 'main',
        event: 'workflow_dispatch',
        run_attempt: 1,
        status: 'completed',
        conclusion: 'success',
      })
    );
    const runs = [];
    for (const [index, workflow] of [
      'desktop.yml',
      'scripts.yml',
      'update-apt.yml',
    ].entries()) {
      const evidence = workflow + '.json';
      await writeFile(
        join(root, evidence),
        JSON.stringify({
          id: index + 1,
          head_sha: testedSha,
          head_branch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          path: '.github/workflows/' + workflow,
        })
      );
      runs.push({workflow, runId: index + 1, evidence});
    }

    await writeFile(
      join(root, 'observation.log'),
      'Synthetic aggregator fixture; no actual desktop qualification claim.'
    );
    const roles = Object.keys(qualificationCases).map(role => ({
      role,
      platform: 'linux',
      architecture: 'arm64',
      os: 'synthetic reported fixture',
      kernel: 'synthetic',
      security: {
        apparmorRestriction: '1',
        apparmorEnabled: 'Y',
        userNamespaces: '12345',
        factorySettings: 'verified',
      },
      versions: Object.fromEntries(
        [
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
        ].map(name => [name, 'fixture'])
      ),
    }));
    const cases = Object.entries(qualificationCases).flatMap(([role, names]) =>
      names.map(name => ({
        role,
        case: name,
        status: 'passed',
        execution: 'actual',
        testedSha,
        installerSha256: manifest.artifact.sha256,
        evidence: ['observation.log'],
        details: 'Synthetic reported observation exercises validation only',
      }))
    );
    const input = {
      schemaVersion: 1,
      testedSha,
      bundle: {
        directory: 'release/assets',
        policy: 'policy.json',
        acceptance: 'reports/acceptance.json',
        approval: 'approval.json',
        run: 'signing-run.json',
      },
      runs,
      roles,
      cases,
    };
    await writeFile(join(root, 'input.json'), JSON.stringify(input));
    const report = await qualifyUpdate(root, 'input.json');
    expect(report.status).toBe('passed');
    expect(report.authority).toContain('does not authorize');
    expect(report.inventory.find(file => file.path.endsWith('.deb'))?.sha256).toBe(
      manifest.artifact.sha256
    );
    input.cases[0]!.status = 'failed';
    await writeFile(join(root, 'input.json'), JSON.stringify(input));
    expect((await qualifyUpdate(root, 'input.json')).status).toBe('failed');
    await writeFile(join(root, 'release/assets/SHA256SUMS'), 'changed');
    await expect(qualifyUpdate(root, 'input.json')).rejects.toThrow();
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
