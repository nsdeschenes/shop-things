import {randomUUID, type KeyObject} from 'node:crypto';
import {unlink} from 'node:fs/promises';

import type {UpdateBridge, UpdateState} from '@shop-things/contract';

import {
  downloadUpdateCandidate,
  verifyStagedUpdateArtifact,
  UpdateDownloadError,
  type UpdateDownloadOptions,
  type VerifiedUpdateArtifact,
} from './updateDownload.js';
import {
  stableVersion,
  verifyUpdateManifest,
  type UpdateManifest,
} from './updateManifest.js';
import {requestUpdateBytes, UpdateNetworkError} from './updateNetwork.js';
import {compareDebianVersions} from './updateVersions.js';

const tagPrefix = /^v/;
export interface DiscoveredUpdateCandidate {
  id: string;
  manifest: UpdateManifest;
  bytes: Uint8Array;
  signature: Uint8Array;
  url: string;
}

export interface UpdateDiscoveryOptions {
  appVersion: string;
  packageVersion: string;
  trustedKeys: readonly (KeyObject | string)[];
  capabilityReasons: string[];
  request?: (url: string, limit: number) => Promise<Uint8Array>;
  download?: Omit<UpdateDownloadOptions, 'trustedKeys' | 'baselinePackageVersion'>;
  install?: (
    candidate: DiscoveredUpdateCandidate,
    artifact: VerifiedUpdateArtifact,
    phase: (value: UpdateState['phase']) => void
  ) => Promise<'retryable' | 'recovery' | 'restarting'>;
  admissionAllowed?: () => boolean;
  compareDebian?: (left: string, right: string) => Promise<number>;
}

function compareAppVersions(left: string, right: string): number {
  const a = left.split('+')[0]!.split('.').map(BigInt);
  const b = right.split('+')[0]!.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (a[index]! > b[index]!) {
      return 1;
    }

    if (a[index]! < b[index]!) {
      return -1;
    }
  }

  return 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class UpdateDiscovery {
  private state: UpdateState;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private pending: Promise<Awaited<ReturnType<UpdateBridge['check']>>> | null = null;
  private candidate: DiscoveredUpdateCandidate | null = null;
  private attempt: {
    id: string;
    candidate: DiscoveredUpdateCandidate;
    controller: AbortController;
    artifact: VerifiedUpdateArtifact | null;
  } | null = null;
  private transferring: Promise<void> | null = null;
  private downloadBackoffUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private backoffUntil = 0;
  private stopped = false;
  private controller: AbortController | null = null;

  constructor(private readonly options: UpdateDiscoveryOptions) {
    this.state = {
      revision: 0,
      phase: 'idle',
      capabilityReasons: options.capabilityReasons,
      nextActions: ['check'],
    };
  }

  // Main-only identity lookup; the renderer receives only the opaque ID and version.
  getCandidate(candidateId: string): DiscoveredUpdateCandidate | null {
    return this.candidate?.id === candidateId ? structuredClone(this.candidate) : null;
  }

  getState: UpdateBridge['getState'] = async () => ({
    status: 'success',
    value: structuredClone(this.state),
  });
  onStateChanged: UpdateBridge['onStateChanged'] = callback => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };

  private publish(state: Omit<UpdateState, 'revision' | 'capabilityReasons'>) {
    this.state = {
      ...state,
      revision: this.state.revision + 1,
      capabilityReasons: this.options.capabilityReasons,
    };
    for (const listener of this.listeners) {
      listener(structuredClone(this.state));
    }
  }

  setPackageRecovery() {
    this.publish({
      phase: 'package-recovery',
      errorCode: 'PACKAGE_UNCERTAIN',
      nextActions: [],
    });
  }
  check: UpdateBridge['check'] = () => {
    if (this.options.admissionAllowed?.() === false) {
      return this.getState({});
    }

    if (this.attempt) {
      return this.getState({});
    }

    if (this.pending) {
      return this.pending;
    }

    if (Date.now() < this.backoffUntil) {
      return Promise.resolve({status: 'success', value: structuredClone(this.state)});
    }

    this.stopped = false;
    this.controller = new AbortController();
    this.publish({
      phase: 'checking',
      ...(this.candidate
        ? {
            candidateId: this.candidate.id,
            targetVersion: this.candidate.manifest.appVersion,
          }
        : {}),
      nextActions: [],
    });
    this.pending = this.discover()
      .then(candidate => {
        this.candidate = candidate;
        if (!this.stopped) {
          this.publish(
            candidate
              ? {
                  phase: 'available',
                  candidateId: candidate.id,
                  targetVersion: candidate.manifest.appVersion,
                  nextActions: this.options.download ? ['check', 'update'] : ['check'],
                }
              : {phase: 'current', nextActions: ['check']}
          );
        }

        return {status: 'success' as const, value: structuredClone(this.state)};
      })
      .catch((error: unknown) => {
        const code =
          error instanceof UpdateNetworkError
            ? error.code
            : this.options.trustedKeys.length === 0
              ? 'TRUST_UNAVAILABLE'
              : error instanceof DiscoveryLimit
                ? 'DISCOVERY_LIMIT'
                : 'NETWORK';
        if (error instanceof UpdateNetworkError && error.retryAt) {
          this.backoffUntil = error.retryAt;
        }

        if (!this.stopped) {
          this.publish({phase: 'check-failed', errorCode: code, nextActions: ['check']});
        }

        return {status: 'success' as const, value: structuredClone(this.state)};
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  };

  start: UpdateBridge['start'] = async ({candidateId}) => {
    if (this.options.admissionAllowed?.() === false) {
      return {
        status: 'error',
        error: {code: 'BUSY', message: 'Resolve the package recovery before updating.'},
      };
    }

    if (this.attempt || this.transferring) {
      return {
        status: 'error',
        error: {code: 'BUSY', message: 'An update attempt is already active.'},
      };
    }

    if (this.state.phase !== 'available' || this.candidate?.id !== candidateId) {
      return {
        status: 'error',
        error: {
          code: 'VALIDATION',
          message: 'Check for updates before selecting a version.',
        },
      };
    }

    if (!this.options.download) {
      return {
        status: 'error',
        error: {code: 'BUSY', message: 'Installation is not available yet.'},
      };
    }

    this.launchDownload(this.candidate);
    return this.getState({});
  };
  retry: UpdateBridge['retry'] = async ({attemptId}) => {
    if (
      this.options.admissionAllowed?.() === false ||
      !this.attempt ||
      this.attempt.id !== attemptId ||
      this.state.phase !== 'retryable-failure' ||
      this.transferring
    ) {
      return {
        status: 'error',
        error: {
          code: 'VALIDATION',
          message: 'There is no failed update attempt to retry.',
        },
      };
    }

    if (Date.now() < this.downloadBackoffUntil) {
      return {
        status: 'error',
        error: {
          code: 'BUSY',
          message: 'The release service has limited requests. Wait before retrying.',
        },
      };
    }

    this.launchDownload(this.attempt.candidate);
    return this.getState({});
  };

  private launchDownload(candidate: DiscoveredUpdateCandidate) {
    const options = this.options.download;
    if (!options) {
      throw new Error('Update download is unavailable.');
    }

    const attempt = {
      id: randomUUID(),
      candidate: structuredClone(candidate),
      controller: new AbortController(),
      artifact: null as VerifiedUpdateArtifact | null,
    };
    this.attempt = attempt;
    const identity = {
      candidateId: candidate.id,
      attemptId: attempt.id,
      targetVersion: candidate.manifest.appVersion,
    };
    this.publish({...identity, phase: 'downloading', progress: 0, nextActions: []});
    this.transferring = downloadUpdateCandidate(
      attempt.candidate,
      {
        ...options,
        trustedKeys: this.options.trustedKeys,
        baselinePackageVersion: this.options.packageVersion,
      },
      attempt.id,
      {
        progress: progress =>
          this.publish({...identity, phase: 'downloading', progress, nextActions: []}),
        verifying: () =>
          this.publish({...identity, phase: 'verifying', progress: 1, nextActions: []}),
      },
      attempt.controller.signal
    )
      .then(async artifact => {
        attempt.artifact = artifact;
        if (!this.options.install) {
          this.publish({...identity, phase: 'staged', progress: 1, nextActions: []});
          return;
        }

        try {
          const result = await this.options.install(
            attempt.candidate,
            artifact,
            phase => {
              this.publish({...identity, phase, nextActions: []});
            }
          );
          this.publish({
            ...identity,
            phase:
              result === 'retryable'
                ? 'retryable-failure'
                : result === 'restarting'
                  ? 'restarting'
                  : 'package-recovery',
            ...(result === 'restarting'
              ? {}
              : {
                  errorCode:
                    result === 'retryable'
                      ? ('AUTHENTICATION' as const)
                      : ('PACKAGE_UNCERTAIN' as const),
                }),
            nextActions: result === 'retryable' ? ['retry'] : [],
          });
        } catch {
          this.publish({
            ...identity,
            phase: 'package-recovery',
            errorCode: 'PACKAGE_UNCERTAIN',
            nextActions: [],
          });
        }
      })
      .catch((error: unknown) => {
        const failure =
          error instanceof UpdateDownloadError
            ? error
            : new UpdateDownloadError('STORAGE');
        if (failure.retryAt) {
          this.downloadBackoffUntil = failure.retryAt;
        }

        this.publish({
          ...identity,
          phase: 'retryable-failure',
          errorCode: failure.code,
          nextActions: ['retry'],
        });
      })
      .finally(() => {
        this.transferring = null;
      });
  }

  // Main re-verifies staged bytes before handing an untrusted reference to the helper.
  async getVerifiedArtifact(attemptId: string): Promise<VerifiedUpdateArtifact | null> {
    const attempt = this.attempt;
    if (
      !attempt ||
      attempt.id !== attemptId ||
      !attempt.artifact ||
      this.state.phase !== 'staged'
    ) {
      return null;
    }

    const artifact = attempt.artifact;
    try {
      await verifyStagedUpdateArtifact(
        attempt.candidate,
        artifact,
        this.options.trustedKeys
      );
    } catch {
      await unlink(artifact.path).catch(() => {});
      if (this.attempt === attempt && attempt.artifact === artifact) {
        attempt.artifact = null;
        this.publish({
          candidateId: attempt.candidate.id,
          attemptId: attempt.id,
          targetVersion: attempt.candidate.manifest.appVersion,
          phase: 'retryable-failure',
          errorCode: 'VERIFICATION',
          nextActions: ['retry'],
        });
      }

      throw new UpdateDownloadError('VERIFICATION');
    }

    return this.attempt === attempt && attempt.artifact === artifact
      ? structuredClone(artifact)
      : null;
  }

  startChecking() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.check({});
    }, 3600000);
    this.timer.unref();
    if (this.pending) {
      void this.pending.then(() => {
        if (this.timer) {
          void this.check({});
        }
      });
    } else {
      void this.check({});
    }
  }
  stop() {
    this.stopped = true;
    this.controller?.abort();
    this.attempt?.controller.abort();
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = null;
  }

  private async discover() {
    if (!this.options.trustedKeys.length) {
      throw new Error('Installed update trust is unavailable.');
    }

    if (!stableVersion.test(this.options.appVersion)) {
      throw new Error('Installed app version is not stable.');
    }

    const retryBudget = {remaining: 2};
    const request =
      this.options.request ??
      ((url: string, limit: number) =>
        requestUpdateBytes(url, limit, retryBudget, this.controller?.signal));
    const compareDebian = this.options.compareDebian ?? compareDebianVersions;
    let selected: typeof this.candidate = null;
    for (let page = 1; page <= 10; page++) {
      if (this.stopped) {
        throw new Error('Release checking stopped.');
      }

      const bytes = await request(
        `https://api.github.com/repos/nsdeschenes/shop-things/releases?per_page=100&page=${page}`,
        4194304
      );
      const releases: unknown = JSON.parse(
        new TextDecoder('utf-8', {fatal: true}).decode(bytes)
      );
      if (!Array.isArray(releases) || releases.length > 100) {
        throw new Error('Invalid GitHub release metadata.');
      }

      for (const release of releases) {
        if (this.stopped) {
          throw new Error('Release checking stopped.');
        }

        if (
          !isObject(release) ||
          release.draft !== false ||
          release.prerelease !== false ||
          typeof release.tag_name !== 'string' ||
          release.tag_name.length > 129 ||
          !Array.isArray(release.assets)
        ) {
          continue;
        }

        const assets = release.assets;
        const version = release.tag_name.replace(tagPrefix, '');
        if (
          !stableVersion.test(version) ||
          compareAppVersions(version, this.options.appVersion) <= 0 ||
          (selected && compareAppVersions(version, selected.manifest.appVersion) <= 0)
        ) {
          continue;
        }

        function assetUrl(name: string): string | null {
          const matches = assets.filter(
            (asset: unknown) => isObject(asset) && asset.name === name
          );
          const asset: unknown = matches[0];
          if (
            matches.length !== 1 ||
            !isObject(asset) ||
            typeof asset.browser_download_url !== 'string'
          ) {
            return null;
          }

          try {
            const url = new URL(asset.browser_download_url);
            if (
              url.protocol !== 'https:' ||
              url.host !== 'github.com' ||
              url.username ||
              url.password ||
              url.search ||
              url.hash ||
              decodeURIComponent(url.pathname) !==
                `/nsdeschenes/shop-things/releases/download/${release.tag_name}/${name}`
            ) {
              return null;
            }

            return url.href;
          } catch {
            return null;
          }
        }

        const manifestUrl = assetUrl('shop-things-update-v1.json');
        const signatureUrl = assetUrl('shop-things-update-v1.sig');
        const installerUrl = assetUrl(`shop-things-${version}-linux-arm64.deb`);
        if (!manifestUrl || !signatureUrl || !installerUrl) {
          continue;
        }

        const manifestBytes = await request(manifestUrl, 65536);
        const signature = await request(signatureUrl, 64);
        let manifest: UpdateManifest;
        try {
          manifest = verifyUpdateManifest(
            manifestBytes,
            signature,
            this.options.trustedKeys
          );
        } catch {
          continue;
        }

        if (
          manifest.appVersion !== version ||
          (await compareDebian(manifest.packageVersion, this.options.packageVersion)) <= 0
        ) {
          continue;
        }

        selected = {
          id: randomUUID(),
          manifest,
          bytes: manifestBytes,
          signature,
          url: installerUrl,
        };
      }

      if (releases.length < 100) {
        return selected;
      }
    }

    if (!selected) {
      throw new DiscoveryLimit();
    }

    return selected;
  }
}
class DiscoveryLimit extends Error {}
