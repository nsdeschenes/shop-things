import {randomUUID} from 'node:crypto';
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
import type {InstallResult} from './updateInstallationResult.js';
import {inspectPackageEvidence, receiptRoot} from './updateReconciliation.js';
export type {InstallResult};
export interface InstallationOptions {
  service: Pick<ActionService, 'holdLifecycle'>;
  updatesDirectory: string;
  capabilities: () => Promise<boolean>;
  inspect?: typeof inspectPackageEvidence;
  invoke?: typeof invokeUpdateHelper;
  supervisor?: typeof startRestartSupervisor;
  exit: () => void;
  appVersion?: string;
  onRecovery?: (recheck: (() => Promise<InstallResult>) | null) => void;
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

    const temporary = join(path, 'install.json.' + randomUUID() + '.new');
    const file = await open(
      temporary,
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

    await rename(temporary, join(path, 'install.json'));
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

  const lease = held.value;
  let before: Awaited<ReturnType<typeof inspect>>;
  function retainPreparation() {
    options.onRecovery?.(async () => {
      try {
        const fresh = await inspect();
        if (
          fresh.outcome === 'uncertain' ||
          !fresh.state ||
          !options.appVersion ||
          JSON.parse(fresh.state).appVersion !== options.appVersion
        ) {
          return 'recovery';
        }

        await lease.abort();
        options.onRecovery?.(null);
        return 'retryable';
      } catch {
        return 'recovery';
      }
    });
    return 'recovery' as const;
  }

  try {
    before = await inspect();
    if (before.outcome !== 'clean' || before.state === null) {
      return retainPreparation();
    }
  } catch {
    return retainPreparation();
  }

  phase('quiescent');
  let supervisor: Awaited<ReturnType<typeof startRestartSupervisor>> | undefined;
  try {
    lease.assertCurrent();
    supervisor = await (options.supervisor ?? startRestartSupervisor)({
      attemptId: artifact.attemptId,
      updatesDirectory: options.updatesDirectory,
    });
    lease.assertCurrent();
  } catch {
    supervisor?.cancel();
    await lease.abort();
    return 'retryable';
  }

  phase('authenticating');
  let helperErrorCode: string | null = null;
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
    const outcome = await (options.invoke ?? invokeUpdateHelper)({
      protocol: 1,
      attemptId: artifact.attemptId,
      manifest: Buffer.from(candidate.bytes).toString('base64'),
      signature: Buffer.from(candidate.signature).toString('base64'),
      candidatePath: artifact.path,
    });
    helperErrorCode = outcome.errorCode;
  } catch (error) {
    exited = error instanceof HelperProcessError && error.exited;
  } finally {
    observing = false;
    clearInterval(timer);
  }

  async function reconcile(): Promise<InstallResult> {
    phase('reconciling');
    let after;
    try {
      after = await inspect(artifact.attemptId);
    } catch {
      return 'recovery';
    }

    if (!exited && after.receipt?.resolution !== 'administrator') {
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
        const finalized = await lease.finalizeForExit();
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
      after.receipt.manifestDigest === artifact.manifestDigest &&
      after.state === before.state;
    const authorizationDidNotMutate =
      after.outcome === 'clean' &&
      after.receipt === null &&
      after.generation === before.generation &&
      after.state === before.state;
    if (provenUnchanged || authorizationDidNotMutate) {
      supervisor?.cancel();
      await lease.abort();
      const reason = provenUnchanged ? after.receipt?.errorCode : helperErrorCode;
      return reason === 'PACKAGE_LOCK'
        ? 'package-lock'
        : reason === 'TRANSACTION_REJECTED'
          ? 'transaction-rejected'
          : reason === 'VERIFICATION'
            ? 'verification-rejected'
            : 'retryable';
    }

    return 'recovery';
  }

  let settled: InstallResult | null = null;
  let pending: Promise<InstallResult> | null = null;
  function recheck() {
    if (settled) {
      return Promise.resolve(settled);
    }

    pending ??= reconcile()
      .then(result => {
        if (result !== 'recovery') {
          settled = result;
          options.onRecovery?.(null);
        }

        return result;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  const result = await recheck();
  if (result === 'recovery') {
    options.onRecovery?.(recheck);
  }

  return result;
}
