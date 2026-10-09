import {rm} from 'node:fs/promises';

import type {DraftRequest, DraftResolution} from '@shop-things/contract';
import {expect, test} from 'vitest';

import {DraftCoordinator} from '../src/draftCoordinator.js';
import {HelperProcessError} from '../src/updateHelperProtocol.js';
import {installVerifiedUpdate} from '../src/updateInstallation.js';
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
    const uncertain = await installVerifiedUpdate(
      {
        service: f.service,
        updatesDirectory: f.directory,
        capabilities: async () => true,
        inspect: async attempt => ({
          outcome: attempt ? 'uncertain' : 'clean',
          generation: attempt ? 5 : 4,
          state: 'full independent baseline',
          receipt: null,
        }),
        supervisor: async () => ({
          pid: 45,
          cancel: () => {
            throw new Error('Do not cancel uncertain supervisor');
          },
        }),
        invoke: async () => {
          throw new HelperProcessError(true);
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
    // Uncertain lease is intentionally retained. Its native handle was already closed.
  } finally {
    await rm(f.directory, {recursive: true, force: true});
  }
});
