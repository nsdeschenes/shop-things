import {spawn} from 'node:child_process';
import {createHash, randomUUID, type KeyObject} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, rename, unlink, type FileHandle} from 'node:fs/promises';
import {dirname, join} from 'node:path';

import type {DiscoveredUpdateCandidate} from './updateDiscovery.js';
import {verifyUpdateManifest, type UpdateManifest} from './updateManifest.js';

const retrySeconds = /^\d+$/;
const attemptToken = /^[A-Za-z0-9_-]{1,128}$/;
export class UpdateDownloadError extends Error {
  constructor(
    public readonly code: 'NETWORK' | 'RATE_LIMIT' | 'VERIFICATION' | 'STORAGE',
    public readonly retryAt?: number
  ) {
    super(`Update preparation failed: ${code}`);
  }
}
export interface UpdateDownloadOptions {
  directory: string;
  trustedKeys: readonly (KeyObject | string)[];
  baselinePackageVersion?: string;
  transport?: (url: string, options: RequestInit) => Promise<Response>;
}
export interface VerifiedUpdateArtifact {
  attemptId: string;
  candidateId: string;
  path: string;
  packageVersion: string;
  manifestDigest: string;
}
interface DownloadObserver {
  progress(this: void, value: number): void;
  verifying(this: void): void;
}

async function privateDirectory(path: string) {
  const created = await mkdir(path, {recursive: true, mode: 0o700});
  if (created) {
    await syncDirectory(dirname(path));
  }

  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new UpdateDownloadError('STORAGE');
  }
}

async function syncDirectory(path: string) {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeRecord(directory: string, value: Record<string, unknown>) {
  const path = join(directory, `record-${randomUUID()}.tmp`);
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 8192) {
    throw new UpdateDownloadError('STORAGE');
  }

  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }

  await rename(path, join(directory, 'record.json'));
  await syncDirectory(directory);
}

export async function downloadUpdateCandidate(
  candidate: DiscoveredUpdateCandidate,
  options: UpdateDownloadOptions,
  attemptId: string,
  observer: DownloadObserver,
  signal: AbortSignal
): Promise<VerifiedUpdateArtifact> {
  if (!attemptToken.test(attemptId)) {
    throw new UpdateDownloadError('VERIFICATION');
  }

  const manifest = checkedManifest(candidate, options.trustedKeys);
  const manifestDigest = createHash('sha256').update(candidate.bytes).digest('hex');
  await privateDirectory(options.directory);
  const directory = join(options.directory, attemptId);
  await mkdir(directory, {mode: 0o700});
  await syncDirectory(options.directory);
  const path = join(directory, 'installer.deb');
  const record = {
    schemaVersion: 1,
    attemptId,
    candidateId: candidate.id,
    manifestDigest,
    targetVersion: manifest.appVersion,
    packageVersion: manifest.packageVersion,
    baselinePackageVersion: options.baselinePackageVersion ?? null,
  };
  await writeRecord(directory, {...record, phase: 'downloading'});
  const deadline = Date.now() + 1800000;
  let retries = 2;
  try {
    while (true) {
      let file: FileHandle | null = null;
      try {
        file = await open(
          path,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600
        );
        await transfer(
          candidate.url,
          manifest,
          file,
          options.transport ?? fetch,
          deadline,
          signal,
          observer.progress
        );
        observer.verifying();
        if (signal.aborted) {
          throw new UpdateDownloadError('NETWORK');
        }

        await file.sync();
        await verifyFile(file, manifest);
        if (signal.aborted) {
          throw new UpdateDownloadError('NETWORK');
        }

        await file.close();
        file = null;
        await syncDirectory(directory);
        await writeRecord(directory, {...record, phase: 'staged'});
        if (signal.aborted) {
          throw new UpdateDownloadError('NETWORK');
        }

        return {
          attemptId,
          candidateId: candidate.id,
          path,
          packageVersion: manifest.packageVersion,
          manifestDigest,
        };
      } catch (error) {
        await file?.close().catch(() => {});
        await unlink(path).catch(() => {});
        if (
          error instanceof UpdateDownloadError &&
          error.code === 'NETWORK' &&
          !signal.aborted &&
          Date.now() < deadline &&
          retries-- > 0
        ) {
          observer.progress(0);
          continue;
        }

        throw error;
      }
    }
  } catch (error) {
    const failure =
      error instanceof UpdateDownloadError ? error : new UpdateDownloadError('STORAGE');
    await writeRecord(directory, {
      ...record,
      phase: 'failed',
      errorCode: failure.code,
    }).catch(() => {});
    throw failure;
  }
}

async function transfer(
  url: string,
  manifest: UpdateManifest,
  file: FileHandle,
  transport: (url: string, options: RequestInit) => Promise<Response>,
  deadline: number,
  signal: AbortSignal,
  progress: (value: number) => void
) {
  if (signal.aborted || Date.now() >= deadline) {
    throw new UpdateDownloadError('NETWORK');
  }

  const controller = new AbortController();
  function abort() {
    controller.abort();
  }

  signal.addEventListener('abort', abort, {once: true});
  const total = setTimeout(abort, Math.max(0, deadline - Date.now()));
  const request = setTimeout(abort, 30000);
  let inactivity: ReturnType<typeof setTimeout> | null = null;
  let response: Response | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    let current = url;
    for (let redirects = 0; ; redirects++) {
      const target = new URL(current);
      if (target.protocol !== 'https:' || target.username || target.password) {
        throw new UpdateDownloadError('VERIFICATION');
      }

      response = await waitForOperation(
        transport(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Shop-Things-Updater',
            Accept: 'application/octet-stream',
          },
        }),
        controller.signal
      );
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        break;
      }

      await waitForOperation(
        response.body?.cancel() ?? Promise.resolve(),
        controller.signal
      );
      const location = response.headers.get('location');
      if (!location || redirects >= 5) {
        throw new UpdateDownloadError('VERIFICATION');
      }

      current = new URL(location, current).href;
    }

    clearTimeout(request);
    if (
      (!response.ok && response.headers.has('retry-after')) ||
      response.status === 429 ||
      (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    ) {
      const retry = response.headers.get('retry-after');
      const parsed =
        retry && retrySeconds.test(retry)
          ? Date.now() + Number(retry) * 1000
          : retry
            ? Date.parse(retry)
            : Number(response.headers.get('x-ratelimit-reset')) * 1000;
      throw new UpdateDownloadError(
        'RATE_LIMIT',
        Number.isFinite(parsed) && parsed > Date.now() ? parsed : Date.now() + 60000
      );
    }

    if (!response.ok || !response.body) {
      throw new UpdateDownloadError('NETWORK');
    }

    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) !== manifest.artifact.byteLength) {
      throw new UpdateDownloadError('VERIFICATION');
    }

    reader = response.body.getReader();
    let length = 0;
    let lastProgress = 0;
    while (true) {
      inactivity = setTimeout(abort, 120000);
      const item = await waitForOperation(reader.read(), controller.signal);
      clearTimeout(inactivity);
      inactivity = null;
      if (item.done) {
        break;
      }

      length += item.value.byteLength;
      if (length > manifest.artifact.byteLength || length > 1073741824) {
        throw new UpdateDownloadError('VERIFICATION');
      }

      let offset = 0;
      while (offset < item.value.length) {
        let written;
        try {
          written = await file.write(item.value, offset, item.value.length - offset);
        } catch {
          throw new UpdateDownloadError('STORAGE');
        }

        if (written.bytesWritten <= 0) {
          throw new UpdateDownloadError('STORAGE');
        }

        offset += written.bytesWritten;
      }

      const now = Date.now();
      if (now - lastProgress >= 100 || length === manifest.artifact.byteLength) {
        progress(length / manifest.artifact.byteLength);
        lastProgress = now;
      }
    }

    if (length !== manifest.artifact.byteLength) {
      throw new UpdateDownloadError('NETWORK');
    }

    progress(1);
  } catch (error) {
    if (error instanceof UpdateDownloadError) {
      throw error;
    }

    throw new UpdateDownloadError('NETWORK');
  } finally {
    signal.removeEventListener('abort', abort);
    controller.abort();
    clearTimeout(total);
    clearTimeout(request);
    if (inactivity) {
      clearTimeout(inactivity);
    }

    if (reader) {
      void reader.cancel().catch(() => {});
    } else {
      void response?.body?.cancel().catch(() => {});
    }
  }
}

// Some test transports ignore AbortSignal; the read deadline still owns progress.
async function waitForOperation<T>(operation: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    throw new UpdateDownloadError('NETWORK');
  }

  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new UpdateDownloadError('NETWORK'));
    signal.addEventListener('abort', abort, {once: true});
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function verifyFile(file: FileHandle, manifest: UpdateManifest) {
  const before = await file.stat();
  if (
    !before.isFile() ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o077) !== 0 ||
    before.size !== manifest.artifact.byteLength
  ) {
    throw new UpdateDownloadError('VERIFICATION');
  }

  const hash = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  let offset = 0;
  while (offset < before.size) {
    const result = await file.read(
      buffer,
      0,
      Math.min(buffer.length, before.size - offset),
      offset
    );
    if (!result.bytesRead) {
      throw new UpdateDownloadError('VERIFICATION');
    }

    hash.update(buffer.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }

  if (hash.digest('hex') !== manifest.artifact.sha256) {
    throw new UpdateDownloadError('VERIFICATION');
  }

  const metadata = await packageMetadata(file);
  const after = await file.stat();
  if (
    metadata !== `shop-things\t${manifest.packageVersion}\tarm64` ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new UpdateDownloadError('VERIFICATION');
  }
}

// Pass the already-open regular file, not a path that can be swapped during inspection.
function packageMetadata(file: FileHandle): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/usr/bin/dpkg-deb',
      [
        '--show',
        '--showformat=${Package}\t${Version}\t${Architecture}',
        '/proc/self/fd/3',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe', file.fd],
        env: {PATH: '/usr/bin:/bin', LC_ALL: 'C'},
      }
    );
    const chunks: Buffer[] = [];
    let length = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new UpdateDownloadError('VERIFICATION'));
    }, 30000);
    child.stdout?.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 4096) {
        child.kill('SIGKILL');
        reject(new UpdateDownloadError('VERIFICATION'));
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr?.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new UpdateDownloadError('VERIFICATION'));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      } else {
        reject(new UpdateDownloadError('VERIFICATION'));
      }
    });
  });
}

export async function verifyStagedUpdateArtifact(
  candidate: DiscoveredUpdateCandidate,
  artifact: VerifiedUpdateArtifact,
  trustedKeys: readonly (KeyObject | string)[]
): Promise<void> {
  const manifest = checkedManifest(candidate, trustedKeys);
  if (
    candidate.id !== artifact.candidateId ||
    createHash('sha256').update(candidate.bytes).digest('hex') !== artifact.manifestDigest
  ) {
    throw new UpdateDownloadError('VERIFICATION');
  }

  const file = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await verifyFile(file, manifest);
  } finally {
    await file.close();
  }
}

function checkedManifest(
  candidate: DiscoveredUpdateCandidate,
  keys: readonly (KeyObject | string)[]
): UpdateManifest {
  try {
    return verifyUpdateManifest(candidate.bytes, candidate.signature, keys);
  } catch {
    throw new UpdateDownloadError('VERIFICATION');
  }
}
