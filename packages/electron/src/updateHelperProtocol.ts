import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
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
  outcome: 'install-disabled' | 'rejected';
  errorCode: 'INSTALL_DISABLED' | 'VERIFICATION';
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
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 8192) {
        child.kill('SIGTERM');
      } else {
        output = Buffer.concat([output, chunk]);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostics += chunk.length;
      if (diagnostics > 8192) {
        child.kill('SIGTERM');
      }
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      try {
        if (code !== 0) {
          throw new Error('Authentication or verification did not complete.');
        }

        const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(output));
        if (
          value.protocol !== 1 ||
          value.type !== 'outcome' ||
          value.attemptId !== request.attemptId ||
          !(
            (value.outcome === 'install-disabled' &&
              value.errorCode === 'INSTALL_DISABLED') ||
            (value.outcome === 'rejected' && value.errorCode === 'VERIFICATION')
          )
        ) {
          throw new Error('Invalid helper outcome.');
        }

        const expectedFields =
          value.outcome === 'rejected'
            ? ['protocol', 'type', 'attemptId', 'outcome', 'errorCode']
            : [
                'protocol',
                'type',
                'attemptId',
                'outcome',
                'errorCode',
                'manifestDigest',
                'appVersion',
                'packageVersion',
                'baseline',
              ];
        if (Object.keys(value).sort().join(',') !== expectedFields.sort().join(',')) {
          throw new Error('Unknown helper outcome fields.');
        }

        if (value.outcome === 'install-disabled') {
          const manifest = JSON.parse(
            Buffer.from(request.manifest, 'base64').toString('utf8')
          );
          if (
            value.manifestDigest !==
              createHash('sha256')
                .update(Buffer.from(request.manifest, 'base64'))
                .digest('hex') ||
            value.appVersion !== manifest.appVersion ||
            value.packageVersion !== manifest.packageVersion ||
            !value.baseline ||
            Object.keys(value.baseline).sort().join(',') !==
              'appVersion,architecture,packageVersion' ||
            value.baseline.architecture !== 'arm64' ||
            typeof value.baseline.appVersion !== 'string' ||
            value.baseline.appVersion.length > 128 ||
            typeof value.baseline.packageVersion !== 'string' ||
            value.baseline.packageVersion.length > 128
          ) {
            throw new Error('Invalid verified helper identity.');
          }
        }

        resolve(value);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(bytes);
  });
}
