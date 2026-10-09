import type {ActionResults} from '@shop-things/contract';

import type {ActionService} from './actionService.js';
import type {DiscoveredUpdateCandidate} from './updateDiscovery.js';
import type {VerifiedUpdateArtifact} from './updateDownload.js';
import {attemptPattern, invokeUpdateHelper} from './updateHelperProtocol.js';

export {
  invokeUpdateHelper,
  protectedSystemFile,
  updateHelperPath,
  updateIdentityPath,
} from './updateHelperProtocol.js';
export type {
  HelperInstallRequest,
  HelperVerificationOutcome,
} from './updateHelperProtocol.js';

type Outcome<T> =
  | {status: 'success'; value: T}
  | Exclude<ActionResults['database.status'], {status: 'success'}>;

// Main-only composition seam for controlled acceptance. Shipped Update stays disabled.
// This helper version contains no package mutation; every result may safely abort.
// #181 must replace that guarantee with independently durable transaction evidence.
export async function verifyUpdateUnderLease(options: {
  service: Pick<ActionService, 'holdLifecycle'>;
  candidate: DiscoveredUpdateCandidate;
  artifact: VerifiedUpdateArtifact;
  invoke?: typeof invokeUpdateHelper;
}): Promise<Outcome<{verified: boolean}>> {
  if (
    options.artifact.candidateId !== options.candidate.id ||
    !attemptPattern.test(options.artifact.attemptId)
  ) {
    return {
      status: 'error',
      error: {code: 'VALIDATION', message: 'This update is no longer selected.'},
    };
  }

  const held = await options.service.holdLifecycle();
  if (held.status !== 'success') {
    return held;
  }

  let verified = false;
  try {
    held.value.assertCurrent();
    const result = await (options.invoke ?? invokeUpdateHelper)({
      protocol: 1,
      attemptId: options.artifact.attemptId,
      manifest: Buffer.from(options.candidate.bytes).toString('base64'),
      signature: Buffer.from(options.candidate.signature).toString('base64'),
      candidatePath: options.artifact.path,
    });
    verified = result.outcome === 'install-disabled';
  } catch {
    verified = false;
  }

  const restored = await held.value.abort();
  if (restored.status !== 'success') {
    return restored;
  }

  return {status: 'success', value: {verified}};
}
