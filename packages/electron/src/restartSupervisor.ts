import {spawn} from 'node:child_process';
import {lstat, mkdir, readFile, realpath} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {dirname, join} from 'node:path';

const supervisorPath = '/usr/lib/shop-things/update-supervisor';
const attemptPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const processStartPattern = /^[0-9]{1,24}$/;
const socketPattern = /^\/tmp\/shop-things-restart-[A-Za-z0-9_-]+\/ready\.sock$/;
const tokenPattern = /^[0-9a-f]{64}$/;
let readiness: Promise<void> | null = null;

export interface RestartSupervisor {
  pid: number;
  // Only use before package mutation, after proving cancellation is reversible.
  cancel(): void;
}

function requireOriginalUser() {
  if (
    process.platform !== 'linux' ||
    process.getuid?.() === 0 ||
    process.geteuid?.() === 0
  ) {
    throw new Error('Restart supervision requires the original Linux desktop user.');
  }
}

async function protectedFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
    throw new Error('The packaged restart supervisor is unavailable.');
  }
}

// This is main-only infrastructure. No renderer or production updater invokes it
// until the complete installation gate has acquired the held lifecycle lease.
export async function startRestartSupervisor(options: {
  attemptId: string;
  updatesDirectory: string;
}): Promise<RestartSupervisor> {
  requireOriginalUser();
  if (!attemptPattern.test(options.attemptId)) {
    throw new Error('Invalid update attempt.');
  }

  await protectedFile(supervisorPath);
  for (const path of ['/usr', '/usr/lib', '/usr/lib/shop-things']) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
      throw new Error('The packaged restart supervisor directory is unsafe.');
    }
  }

  await protectedFile(await realpath('/usr/bin/python3'));
  await mkdir(options.updatesDirectory, {recursive: true, mode: 0o700});
  const directory = await lstat(options.updatesDirectory);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  ) {
    throw new Error('The update diagnostics directory is not private.');
  }

  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const oldStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!oldStart || !processStartPattern.test(oldStart)) {
    throw new Error('The original application identity is unavailable.');
  }

  const environment = {...process.env};
  for (const name of Object.keys(environment)) {
    if (
      name.startsWith('LD_') ||
      name.startsWith('DYLD_') ||
      name.startsWith('PYTHON') ||
      [
        'NODE_OPTIONS',
        'ELECTRON_RUN_AS_NODE',
        'VITE_DEV_SERVER_URL',
        'SHOP_THINGS_RESTART_SOCKET',
        'SHOP_THINGS_RESTART_TOKEN',
        'SHOP_THINGS_RESTART_ATTEMPT',
      ].includes(name)
    ) {
      delete environment[name];
    }
  }

  const child = spawn('/usr/bin/python3', ['-I', supervisorPath], {
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: environment,
  });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => fail(new Error('The restart supervisor did not become ready.')),
      5000
    );
    function fail(error: Error) {
      clearTimeout(timeout);
      child.kill();
      reject(error);
    }

    child.once('error', fail);
    child.once('exit', () =>
      fail(new Error('The restart supervisor exited before readiness.'))
    );
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 8192) {
        fail(new Error('The restart supervisor response exceeded its limit.'));
        return;
      }

      if (!output.endsWith('\n')) {
        return;
      }

      try {
        const value: unknown = JSON.parse(output);
        if (
          JSON.stringify(value) !==
          JSON.stringify({protocol: 1, type: 'ready', attemptId: options.attemptId})
        ) {
          throw new Error('The restart supervisor rejected readiness.');
        }

        clearTimeout(timeout);
        child.removeAllListeners('exit');
        child.removeAllListeners('error');
        child.stdout.destroy();
        child.unref();
        resolve();
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Invalid supervisor response.'));
      }
    });
    child.stdin.end(
      JSON.stringify({
        protocol: 1,
        attemptId: options.attemptId,
        oldPid: process.pid,
        oldStart,
        updatesDirectory: options.updatesDirectory,
      }) + '\n'
    );
  });
  if (!child.pid) {
    throw new Error('The restart supervisor process is unavailable.');
  }

  return {
    pid: child.pid,
    cancel: () => {
      child.kill('SIGTERM');
    },
  };
}

// Called only after package reconciliation, startup database checks, and the
// authorized renderer's mounted recovery/application UI acknowledgment.
export function acknowledgeRestartReady(): Promise<void> {
  const socketPath = process.env.SHOP_THINGS_RESTART_SOCKET;
  const token = process.env.SHOP_THINGS_RESTART_TOKEN;
  const attemptId = process.env.SHOP_THINGS_RESTART_ATTEMPT;
  if (!socketPath && !token && !attemptId) {
    return Promise.resolve();
  }

  readiness ??= (async () => {
    requireOriginalUser();
    if (
      !socketPath ||
      !socketPattern.test(socketPath) ||
      !token ||
      !tokenPattern.test(token) ||
      !attemptId ||
      !attemptPattern.test(attemptId)
    ) {
      throw new Error('Invalid restart readiness credentials.');
    }

    const directory = await lstat(dirname(socketPath));
    const socket = await lstat(socketPath);
    if (
      !directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o077) !== 0 ||
      !socket.isSocket() ||
      socket.uid !== process.getuid?.() ||
      (socket.mode & 0o077) !== 0
    ) {
      throw new Error('The restart readiness socket is not private.');
    }

    await new Promise<void>((resolve, reject) => {
      const connection = createConnection(socketPath);
      let output = '';
      connection.setTimeout(3000, () =>
        connection.destroy(new Error('Restart readiness timed out.'))
      );
      connection.once('error', reject);
      connection.once('connect', () => {
        connection.write(
          JSON.stringify({protocol: 1, type: 'ready', attemptId, token}) + '\n'
        );
      });
      connection.on('data', chunk => {
        output += chunk.toString('utf8');
        if (output.length > 256) {
          connection.destroy(new Error('Restart acknowledgment exceeded its limit.'));
          return;
        }

        if (output.endsWith('\n')) {
          if (output !== '{"protocol":1,"type":"acknowledged"}\n') {
            connection.destroy(new Error('Invalid restart acknowledgment.'));
            return;
          }

          connection.destroy();
          resolve();
        }
      });
      connection.once('end', () => {
        if (!output.endsWith('\n')) {
          reject(
            new Error('The restart supervisor closed before acknowledging readiness.')
          );
        }
      });
    });
    delete process.env.SHOP_THINGS_RESTART_SOCKET;
    delete process.env.SHOP_THINGS_RESTART_TOKEN;
    delete process.env.SHOP_THINGS_RESTART_ATTEMPT;
  })().catch(error => {
    readiness = null;
    throw error;
  });
  return readiness;
}

export function restartDiagnosticPath(
  updatesDirectory: string,
  attemptId: string
): string {
  if (!attemptPattern.test(attemptId)) {
    throw new Error('Invalid update attempt.');
  }

  return join(updatesDirectory, attemptId, 'launch.json');
}
