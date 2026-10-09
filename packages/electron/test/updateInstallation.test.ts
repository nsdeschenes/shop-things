import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import type {DraftRequest, DraftResolution} from '@shop-things/contract';
import {expect, test} from 'vitest';

import {DraftCoordinator} from '../src/draftCoordinator.js';
import {HelperProcessError} from '../src/updateHelperProtocol.js';
import {installVerifiedUpdate, type InstallResult} from '../src/updateInstallation.js';
import {fixture, success} from './backendFixture.js';

test('cancelled fixed authentication restores retained draft only with unchanged initialized root evidence', async () => {
  const drafts = new DraftCoordinator();
  let frozen = false;
  let retained = 'invalid unsaved value';
  const participant = {
    documentId: 'installation',
    prepare(request: DraftRequest) {
      frozen = true;
      drafts.reply(participant, {...request, hasUnsavedDraft: true});
    },
    resolve(resolution: DraftResolution) {
      frozen = false;
      if (resolution.outcome === 'committed') {
        retained = '';
      }
    },
  };
  drafts.register(participant);
  const f = await fixture({drafts});
  try {
    const original = success(await f.service.handlers['database.create']());
    retained = 'invalid unsaved value';
    const manifest = {
      schemaVersion: 1,
      applicationId: 'com.shopthings.app',
      repository: 'nsdeschenes/shop-things',
      channel: 'stable',
      appVersion: '0.4.0',
      packageName: 'shop-things',
      packageVersion: '0.4.0',
      platform: 'linux',
      architecture: 'arm64',
      helperProtocol: {min: 1, max: 1},
      artifact: {
        filename: 'shop-things-0.4.0-linux-arm64.deb',
        byteLength: 1,
        sha256: 'a'.repeat(64),
      },
    } as const;
    const candidate = {
      id: 'opaque',
      bytes: new Uint8Array(),
      signature: new Uint8Array(),
      url: 'https://github.com/fixture',
      manifest,
    };
    const artifact = {
      attemptId: 'b7f650aa-0c51-4d68-a940-7f1472b86b46',
      candidateId: 'opaque',
      path: '/controlled/file',
      packageVersion: '0.4.0',
      manifestDigest: 'a'.repeat(64),
    };
    let cancelled = false;
    const result = await installVerifiedUpdate(
      {
        service: f.service,
        updatesDirectory: f.directory,
        capabilities: async () => true,
        inspect: async () => ({
          outcome: 'clean',
          generation: 4,
          state: 'full independent baseline',
          receipt: null,
        }),
        supervisor: async () => ({
          pid: 44,
          cancel: () => {
            cancelled = true;
          },
        }),
        invoke: async () => {
          expect(frozen).toBe(true);
          expect(await f.service.requestClose()).toMatchObject({
            status: 'error',
            error: {code: 'BUSY'},
          });
          throw new HelperProcessError(true);
        },
        exit: () => {
          throw new Error('Cancellation must not exit');
        },
      },
      candidate,
      artifact,
      () => {}
    );
    expect(result).toBe('retryable');
    expect(cancelled).toBe(true);
    expect(f.service.status()).toEqual(original);
    expect(retained).toBe('invalid unsaved value');
    expect(frozen).toBe(false);
    let administratorResolved = false;
    async function missingContinuation(): Promise<InstallResult> {
      throw new Error('Missing retained continuation');
    }

    let continuation = missingContinuation;

    let supervisorCancelled = 0;
    const uncertain = await installVerifiedUpdate(
      {
        service: f.service,
        updatesDirectory: f.directory,
        capabilities: async () => true,
        inspect: async attempt => ({
          outcome: attempt
            ? administratorResolved
              ? 'unchanged'
              : 'uncertain'
            : 'clean',
          generation: attempt ? 5 : 4,
          state: 'full independent baseline',
          receipt:
            administratorResolved && attempt
              ? {
                  attemptId: artifact.attemptId,
                  manifestDigest: artifact.manifestDigest,
                  appVersion: '0.4.0',
                  packageVersion: '0.4.0',
                  resolution: 'administrator',
                }
              : null,
        }),
        onRecovery: recheck => {
          if (recheck) {
            continuation = recheck;
          }
        },
        supervisor: async () => ({
          pid: 45,
          cancel: () => {
            supervisorCancelled++;
            expect(administratorResolved).toBe(true);
          },
        }),
        invoke: async () => {
          throw new HelperProcessError(false);
        },
        exit: () => {},
      },
      candidate,
      artifact,
      () => {}
    );
    expect(uncertain).toBe('recovery');
    expect(frozen).toBe(true);
    expect(await f.service.handlers['database.retry']()).toMatchObject({
      status: 'error',
      error: {code: 'BUSY'},
    });
    expect(retained).toBe('invalid unsaved value');
    expect(supervisorCancelled).toBe(0);
    administratorResolved = true;
    expect(await continuation()).toBe('retryable');
    expect(retained).toBe('invalid unsaved value');
    expect(frozen).toBe(false);
    expect(f.service.status()).toEqual(original);
    expect(supervisorCancelled).toBe(1);
    expect(await continuation()).toBe('retryable');
    expect(supervisorCancelled).toBe(1);

    let installed = false;
    let exits = 0;
    expect(
      await installVerifiedUpdate(
        {
          service: f.service,
          updatesDirectory: f.directory,
          capabilities: async () => true,
          inspect: async attempt => ({
            outcome: attempt ? (installed ? 'installed' : 'uncertain') : 'clean',
            generation: attempt ? 7 : 6,
            state:
              installed && attempt
                ? 'independently verified full intended inventory'
                : 'full independent baseline',
            receipt:
              installed && attempt
                ? {
                    attemptId: artifact.attemptId,
                    manifestDigest: artifact.manifestDigest,
                    appVersion: '0.4.0',
                    packageVersion: '0.4.0',
                    resolution: 'administrator',
                  }
                : null,
          }),
          onRecovery: recheck => {
            if (recheck) {
              continuation = recheck;
            }
          },
          supervisor: async () => ({
            pid: 46,
            cancel: () => {
              throw new Error('Verified install must retain supervisor');
            },
          }),
          invoke: async () => {
            throw new HelperProcessError(false);
          },
          exit: () => {
            exits++;
          },
        },
        candidate,
        artifact,
        () => {}
      )
    ).toBe('recovery');
    expect(frozen).toBe(true);
    const directory = join(f.directory, artifact.attemptId);
    await mkdir(directory, {mode: 0o700});
    await writeFile(
      join(directory, 'install.json'),
      JSON.stringify({outcome: 'installed'})
    );
    await writeFile(join(directory, 'install.json.new'), 'retained crash evidence');
    expect(await continuation()).toBe('recovery');
    expect(exits).toBe(0);
    expect(retained).toBe('invalid unsaved value');
    installed = true;
    const first = continuation();
    const second = continuation();
    expect(first).toBe(second);
    expect(await first).toBe('restarting');
    expect(exits).toBe(1);
    expect(await continuation()).toBe('restarting');
    expect(exits).toBe(1);
    expect(
      JSON.parse(await readFile(join(directory, 'install.json'), 'utf8'))
    ).toMatchObject({attemptId: artifact.attemptId, outcome: 'installed'});
    expect(await readFile(join(directory, 'install.json.new'), 'utf8')).toBe(
      'retained crash evidence'
    );
    expect(f.service.status()).toMatchObject({available: false, session: null});
  } finally {
    await rm(f.directory, {recursive: true, force: true});
  }
});
