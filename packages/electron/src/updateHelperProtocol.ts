import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import {dirname} from 'node:path';

export const updateHelperPath = '/usr/lib/shop-things/updater-helper';
export const updateIdentityPath = '/usr/lib/shop-things/update/identity.json';
export const attemptPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface HelperInstallRequest {
  protocol: 1;
  attemptId: string;
  manifest: string;
  signature: string;
  candidatePath: string;
}
export interface HelperVerificationOutcome {
  protocol: 1;
  type: 'outcome';
  attemptId?: string;
  outcome: 'install-disabled' | 'rejected' | 'installed' | 'unchanged' | 'uncertain';
  errorCode: string | null;
}
export class HelperProcessError extends Error {
  readonly exited: boolean;
  constructor(exited: boolean) {
    super('The helper did not produce a complete verified outcome.');
    this.exited = exited;
  }
}

export async function protectedSystemFile(path: string, maximum: number, read = true) {
  let directory = dirname(path);
  while (directory !== '/') {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new Error('The installed updater directory is not protected.');
    }

    directory = dirname(directory);
  }

  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0 ||
      metadata.size > maximum ||
      (!read && (metadata.mode & 0o111) === 0)
    ) {
      throw new Error('The installed updater file is not protected.');
    }

    return read ? await file.readFile() : Buffer.alloc(0);
  } finally {
    await file.close();
  }
}

export async function invokeUpdateHelper(
  request: HelperInstallRequest
): Promise<HelperVerificationOutcome> {
  if (!attemptPattern.test(request.attemptId)) {
    throw new Error('Invalid update attempt.');
  }

  const bytes = Buffer.from(JSON.stringify(request));
  if (bytes.length > 100000) {
    throw new Error('Helper request exceeded bounds.');
  }

  await protectedSystemFile(updateHelperPath, 1048576, false);
  const child = spawn('/usr/bin/pkexec', ['--disable-internal-agent', updateHelperPath], {
    env: {PATH: '/usr/bin:/bin', LC_ALL: 'C'},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return await new Promise((resolve, reject) => {
    let output = Buffer.alloc(0);
    let diagnostics = 0;
    let excessive = false;
    // Never terminate an authorization/helper process that could be mutating.
    const timer = setTimeout(() => reject(new HelperProcessError(false)), 1800000);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 8192) {
        excessive = true;
      } else {
        output = Buffer.concat([output, chunk]);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostics += chunk.length;
      if (diagnostics > 8192) {
        excessive = true;
      }
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new HelperProcessError(true));
    });
    child.once('close', code => {
      clearTimeout(timer);
      try {
        if (code !== 0) {
          throw new Error('Authentication or verification did not complete.');
        }

        const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(output));
        if (
          excessive ||
          value.protocol !== 1 ||
          value.type !== 'outcome' ||
          value.attemptId !== request.attemptId ||
          !['rejected', 'installed', 'unchanged', 'uncertain'].includes(value.outcome) ||
          Object.keys(value).sort().join(',') !==
            'attemptId,errorCode,outcome,protocol,type' ||
          !(
            value.errorCode === null ||
            (typeof value.errorCode === 'string' && value.errorCode.length <= 64)
          )
        ) {
          throw new HelperProcessError(true);
        }

        resolve(value);
      } catch {
        reject(new HelperProcessError(true));
      }
    });
    child.stdin.end(bytes);
  });
}
