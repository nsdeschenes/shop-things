import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {expect, test} from 'vitest';

test('helper independently verifies real signed staged Debian fixtures without package mutation', async () => {
  const result = await promisify(execFile)('/usr/bin/python3', [
    '-I',
    fileURLToPath(new URL('./updateHelperFixtures.py', import.meta.url)),
  ]);
  expect(result.stderr).toContain('OK');
}, 30000);

test('real guarded verification restores cancelled authentication and surfaces failed database reopen', async () => {
  const {fixture, success} = await import('./backendFixture.js');
  const {DraftCoordinator} = await import('../src/draftCoordinator.js');
  const {databaseOperations} = await import('../src/actionService.js');
  const {verifyUpdateUnderLease} = await import('../src/updateHelper.js');
  const drafts = new DraftCoordinator();
  let retainedDraft = 'unsaved';
  let frozen = false;
  const participant = {
    documentId: 'helper-document',
    prepare(request: import('@shop-things/contract').DraftRequest) {
      frozen = true;
      drafts.reply(participant, {...request, hasUnsavedDraft: true});
    },
    resolve(resolution: import('@shop-things/contract').DraftResolution) {
      frozen = false;
      if (resolution.outcome === 'committed') {
        retainedDraft = '';
      }
    },
  };
  drafts.register(participant);
  let failReopen = false;
  const f = await fixture({
    drafts,
    database: {
      ...databaseOperations,
      openExistingDatabase: async (...args) => {
        if (failReopen) {
          throw new Error('Controlled external database reopen failure');
        }

        return databaseOperations.openExistingDatabase(...args);
      },
    },
  });
  try {
    const original = success(await f.service.handlers['database.create']());
    retainedDraft = 'unsaved';
    const candidate = {
      id: 'candidate',
      bytes: new Uint8Array(),
      signature: new Uint8Array(),
      url: 'https://github.com/fixed',
      manifest: {
        schemaVersion: 1 as const,
        applicationId: 'com.shopthings.app' as const,
        repository: 'nsdeschenes/shop-things' as const,
        channel: 'stable' as const,
        appVersion: '0.4.0',
        packageName: 'shop-things' as const,
        packageVersion: '0.4.0-1',
        platform: 'linux' as const,
        architecture: 'arm64' as const,
        helperProtocol: {min: 1 as const, max: 1 as const},
        artifact: {
          filename: 'shop-things-0.4.0-linux-arm64.deb',
          byteLength: 1,
          sha256: 'a'.repeat(64),
        },
      },
    };
    const artifact = {
      attemptId: 'b7f650aa-0c51-4d68-a940-7f1472b86b46',
      candidateId: 'candidate',
      path: '/controlled/candidate.deb',
      packageVersion: '0.4.0-1',
      manifestDigest: 'a'.repeat(64),
    };
    const cancelled = await verifyUpdateUnderLease({
      service: f.service,
      candidate,
      artifact,
      invoke: async () => {
        expect(frozen).toBe(true);
        expect(
          await f.service.handlers['customers.list']({
            session: original.session!,
            query: '',
          })
        ).toMatchObject({status: 'error', error: {code: 'BUSY'}});
        expect(await f.service.requestClose()).toMatchObject({
          status: 'error',
          error: {code: 'BUSY'},
        });
        throw new Error('Controlled cancelled authentication');
      },
    });
    expect(cancelled).toMatchObject({status: 'success', value: {verified: false}});
    expect(f.service.status()).toEqual(original);
    expect(retainedDraft).toBe('unsaved');
    expect(frozen).toBe(false);
    const failed = await verifyUpdateUnderLease({
      service: f.service,
      candidate,
      artifact,
      invoke: async request => {
        failReopen = true;
        return {
          protocol: 1,
          type: 'outcome',
          attemptId: request.attemptId,
          outcome: 'install-disabled',
          errorCode: 'INSTALL_DISABLED',
        };
      },
    });
    expect(failed).toMatchObject({
      status: 'error',
      error: {code: 'DATABASE_UNAVAILABLE'},
    });
    expect(f.service.status()).toMatchObject({
      available: false,
      recoveryError: {code: 'DATABASE_UNAVAILABLE'},
    });
    expect(retainedDraft).toBe('unsaved');
    expect(frozen).toBe(false);
  } finally {
    await f.cleanup();
  }
});
