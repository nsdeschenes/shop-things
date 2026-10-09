import {constants} from 'node:fs';
import {lstat, open, opendir} from 'node:fs/promises';
import {join} from 'node:path';

import {attemptPattern} from './updateHelperProtocol.js';
import {parseUniqueJson} from './updateManifest.js';

export interface RestartDiagnostic {
  attemptId: string;
  phase: string;
  updatedAt: number;
}
const processStart = /^\d{1,24}$/;
const phases = new Set([
  'waiting-for-old-exit',
  'launch-intent',
  'launch-started',
  'manual-launch-intent',
  'manual-launch-started',
  'ready',
  'launch-failed',
  'launch-exited',
  'launch-slow',
  'install-unverified',
]);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error('Unsafe diagnostic directory');
  }
}

export function restartDiagnosticMessage(history: RestartDiagnostic): string {
  return history.phase === 'launch-failed'
    ? 'An earlier update restart reported that Shop Things could not start.'
    : history.phase === 'launch-exited'
      ? 'An earlier update restart exited before startup was confirmed.'
      : history.phase === 'launch-slow'
        ? 'An earlier update restart did not confirm startup in time.'
        : 'An earlier update session ended before its restart was confirmed.';
}

// Caller-owned history is presentation only. Never infer package state, authorize
// database admission, or launch another process from any of these records.
export async function readRestartDiagnostic(
  directory: string
): Promise<RestartDiagnostic | null> {
  try {
    await privateDirectory(directory);
    const entries = await opendir(directory);
    let count = 0;
    let latest: RestartDiagnostic | null = null;
    for await (const entry of entries) {
      if (++count > 64) {
        return null;
      }

      if (!entry.isDirectory() || !attemptPattern.test(entry.name)) {
        continue;
      }

      try {
        const folder = join(directory, entry.name);
        await privateDirectory(folder);
        const file = await open(
          join(folder, 'launch.json'),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        let raw: Buffer;
        try {
          const info = await file.stat();
          if (
            !info.isFile() ||
            info.uid !== process.getuid?.() ||
            (info.mode & 0o077) !== 0 ||
            info.size > 8192
          ) {
            continue;
          }

          raw = Buffer.alloc(8193);
          const {bytesRead} = await file.read(raw, 0, raw.length, 0);
          if (bytesRead > 8192) {
            continue;
          }

          raw = raw.subarray(0, bytesRead);
        } finally {
          await file.close();
        }

        const value: unknown = parseUniqueJson(
          new TextDecoder('utf-8', {fatal: true}).decode(raw)
        );
        if (
          !record(value) ||
          Object.keys(value).sort().join(',') !==
            'attemptId,child,diagnostics,installOutcome,phase,schemaVersion,updatedAt' ||
          value.schemaVersion !== 1 ||
          value.attemptId !== entry.name ||
          typeof value.phase !== 'string' ||
          !phases.has(value.phase) ||
          (value.installOutcome !== 'installed' &&
            value.installOutcome !== 'unverified') ||
          typeof value.diagnostics !== 'string' ||
          value.diagnostics.length > 1024 ||
          typeof value.updatedAt !== 'number' ||
          !Number.isSafeInteger(value.updatedAt) ||
          value.updatedAt < 0
        ) {
          continue;
        }

        if (
          value.child !== null &&
          (!record(value.child) ||
            Object.keys(value.child).sort().join(',') !== 'pid,start' ||
            typeof value.child.pid !== 'number' ||
            !Number.isSafeInteger(value.child.pid) ||
            value.child.pid <= 0 ||
            (value.child.start !== null &&
              (typeof value.child.start !== 'string' ||
                !processStart.test(value.child.start))))
        ) {
          continue;
        }

        if (!latest || value.updatedAt > latest.updatedAt) {
          latest = {
            attemptId: entry.name,
            phase: value.phase,
            updatedAt: value.updatedAt,
          };
        }
      } catch {
        /* Lost/corrupt diagnostic data cannot block healthy startup. */
      }
    }

    return latest?.phase === 'ready' ? null : latest;
  } catch {
    return null;
  }
}
