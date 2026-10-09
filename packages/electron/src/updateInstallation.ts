import {constants} from 'node:fs';
import {mkdir, open, rename} from 'node:fs/promises';
import {join} from 'node:path';

import type {UpdateState} from '@shop-things/contract';

import type {ActionService} from './actionService.js';
import {startRestartSupervisor} from './restartSupervisor.js';
import type {DiscoveredUpdateCandidate} from './updateDiscovery.js';
import type {VerifiedUpdateArtifact} from './updateDownload.js';
import {
  HelperProcessError,
  invokeUpdateHelper,
  protectedSystemFile,
} from './updateHelperProtocol.js';
import {inspectPackageEvidence, receiptRoot} from './updateReconciliation.js';

export type InstallResult = 'retryable' | 'recovery' | 'restarting';
export interface InstallationOptions {
  service: Pick<ActionService, 'holdLifecycle'>;
  updatesDirectory: string;
  capabilities: () => Promise<boolean>;
  inspect?: typeof inspectPackageEvidence;
  invoke?: typeof invokeUpdateHelper;
  supervisor?: typeof startRestartSupervisor;
  exit: () => void;
}
export async function durableUserInstallRecord(
  directory: string,
  attemptId: string,
  value: unknown
) {
  const path = join(directory, attemptId);
  await mkdir(path, {recursive: true, mode: 0o700});
  const folder = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const info = await folder.stat();
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error('Update diagnostics are not private.');
    }

    const file = await open(
      join(path, 'install.json.new'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      const raw = JSON.stringify(value);
      if (Buffer.byteLength(raw) > 8192) {
        throw new Error('Update diagnostics exceeded bounds.');
      }

      await file.writeFile(raw);
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(join(path, 'install.json.new'), join(path, 'install.json'));
    await folder.sync();
  } finally {
    await folder.close();
  }
}

export async function installVerifiedUpdate(
  options: InstallationOptions,
  candidate: DiscoveredUpdateCandidate,
  artifact: VerifiedUpdateArtifact,
  phase: (value: UpdateState['phase']) => void
): Promise<InstallResult> {
  const inspect = options.inspect ?? inspectPackageEvidence;
  phase('preparing');
  if (!(await options.capabilities())) {
    return 'retryable';
  }

  const held = await options.service.holdLifecycle();
  if (held.status !== 'success') {
    return 'retryable';
  }

  let before;
  try {
    before = await inspect();
    if (before.outcome !== 'clean' || before.state === null) {
      return 'recovery';
    }
  } catch {
    return 'recovery';
  }

  phase('quiescent');
  let supervisor;
  try {
    held.value.assertCurrent();
    supervisor = await (options.supervisor ?? startRestartSupervisor)({
      attemptId: artifact.attemptId,
      updatesDirectory: options.updatesDirectory,
    });
    held.value.assertCurrent();
  } catch {
    supervisor?.cancel();
    await held.value.abort();
    return 'retryable';
  }

  phase('authenticating');
  let exited = true;
  let observing = true;
  const timer = setInterval(() => {
    // This root-owned progress projection is display only. Decisions below always
    // use independently validated receipts AND fresh complete package inspection.
    void protectedSystemFile(
      join(
        receiptRoot,
        'users',
        String(process.getuid?.()),
        artifact.attemptId + '.json'
      ),
      8 * 1024 * 1024
    )
      .then(raw => {
        const value: unknown = JSON.parse(raw.toString('utf8'));
        if (
          observing &&
          typeof value === 'object' &&
          value !== null &&
          'phase' in value &&
          value.phase === 'mutation-possible'
        ) {
          phase('installing');
        }
      })
      .catch(() => {});
  }, 1000);
  try {
    await (options.invoke ?? invokeUpdateHelper)({
      protocol: 1,
      attemptId: artifact.attemptId,
      manifest: Buffer.from(candidate.bytes).toString('base64'),
      signature: Buffer.from(candidate.signature).toString('base64'),
      candidatePath: artifact.path,
    });
  } catch (error) {
    exited = error instanceof HelperProcessError && error.exited;
  } finally {
    observing = false;
    clearInterval(timer);
  }

  phase('reconciling');
  let after;
  try {
    after = await inspect(artifact.attemptId);
  } catch {
    return 'recovery';
  }

  if (!exited) {
    return 'recovery';
  }

  if (
    after.outcome === 'installed' &&
    after.receipt?.attemptId === artifact.attemptId &&
    after.receipt.manifestDigest === artifact.manifestDigest &&
    after.receipt.appVersion === candidate.manifest.appVersion &&
    after.receipt.packageVersion === candidate.manifest.packageVersion
  ) {
    try {
      await durableUserInstallRecord(options.updatesDirectory, artifact.attemptId, {
        schemaVersion: 1,
        attemptId: artifact.attemptId,
        outcome: 'installed',
        manifestDigest: artifact.manifestDigest,
        appVersion: candidate.manifest.appVersion,
        packageName: 'shop-things',
        packageVersion: candidate.manifest.packageVersion,
        architecture: 'arm64',
      });
      const finalized = await held.value.finalizeForExit();
      if (finalized.status !== 'success') {
        return 'recovery';
      }

      phase('restarting');
      options.exit();
      return 'restarting';
    } catch {
      return 'recovery';
    }
  }

  const provenUnchanged =
    after.outcome === 'unchanged' &&
    after.receipt?.attemptId === artifact.attemptId &&
    after.state === before.state;
  const authorizationDidNotMutate =
    after.outcome === 'clean' &&
    after.receipt === null &&
    after.generation === before.generation &&
    after.state === before.state;
  if (provenUnchanged || authorizationDidNotMutate) {
    supervisor.cancel();
    await held.value.abort();
    return 'retryable';
  }

  return 'recovery';
}
