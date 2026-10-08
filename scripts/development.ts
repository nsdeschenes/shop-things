import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';

import {buildAll} from './build.ts';
import {requestOrderlyExit, RestartSupervisor} from './processes.ts';
import {sourceVersion} from './sourceVersion.ts';
import {testAll} from './test.ts';
import {root} from './workspace.ts';

export async function develop() {
  const requireElectron = createRequire(join(root, 'packages/electron/package.json'));
  let electron: ChildProcess | null = null;
  let vite: ChildProcess | null = null;
  let stopping = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const url = 'http://127.0.0.1:5173';
  const supervisor = new RestartSupervisor({
    version: sourceVersion,
    stop: async () =>
      !stopping && (electron === null || (await requestOrderlyExit(electron))),
    build: () => buildAll(),
    report: error => {
      console.error(error);
      console.error('Fix any build errors, then type r and press Enter to retry.');
    },
    start: async () => {
      if (stopping) {
        return;
      }

      if (vite === null) {
        const requireInterface = createRequire(
          join(root, 'packages/interface/package.json')
        );
        vite = spawn(
          process.execPath,
          [join(dirname(requireInterface.resolve('vite/package.json')), 'bin/vite.js')],
          {
            cwd: join(root, 'packages/interface'),
            detached: true,
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          }
        );
        vite.on('error', console.error);
      }

      const deadline = Date.now() + 15_000;
      while (true) {
        if (vite.exitCode !== null || Date.now() > deadline) {
          throw new Error('The development renderer did not become available');
        }

        try {
          if ((await fetch(url)).ok) {
            break;
          }
        } catch {
          /* Vite may still be starting. */
        }

        await delay(100);
      }

      electron = spawn(requireElectron('electron'), ['.'], {
        cwd: join(root, 'packages/electron'),
        detached: true,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: {...process.env, VITE_DEV_SERVER_URL: url},
      });
      electron.on('error', console.error);
    },
  });
  const terminal = createInterface({input: process.stdin});
  terminal.on('line', line => {
    if (!stopping && line.trim().toLowerCase() === 'r') {
      void supervisor.retry().catch(console.error);
    }
  });
  function resumeWatching() {
    clearInterval(timer);
    timer = setInterval(() => {
      void supervisor.refresh().catch(console.error);
    }, 500);
  }

  async function shutdown() {
    if (stopping) {
      return;
    }

    stopping = true;
    clearInterval(timer);
    if (electron && !(await requestOrderlyExit(electron))) {
      stopping = false;
      resumeWatching();
      console.error(
        'The application remains open. Type r and press Enter to retry updates, or retry shutdown.'
      );
      return;
    }

    // Vite holds no customer drafts; Electron always closes through parent IPC.
    terminal.close();
    vite?.kill('SIGTERM');
  }

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
  try {
    await supervisor.refresh();
  } catch (error) {
    await shutdown();
    throw error;
  }

  if (!stopping) {
    resumeWatching();
  }
}

export async function watchTests() {
  let last = null;
  while (true) {
    const version = await sourceVersion();
    if (version !== last) {
      last = version;
      try {
        await testAll();
      } catch (error) {
        console.error(error);
      }
    }

    await delay(500);
  }
}
