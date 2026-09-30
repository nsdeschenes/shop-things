/* oxlint-disable import/no-named-export -- Shared build/development process boundaries. */
import {spawn} from 'node:child_process';
import type {ChildProcess, SpawnOptions} from 'node:child_process';

export function runCommand(command: string, args: string[], options: SpawnOptions = {}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {stdio: 'inherit', ...options});
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code})`));
      }
    });
  });
}

export function requestOrderlyExit(child: ChildProcess, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  if (!child.connected) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>(resolve => {
    function finish(exited: boolean) {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    }

    function onExit() {
      finish(true);
    }

    const timer = setTimeout(finish, timeoutMs, false);
    child.once('exit', onExit);
    try {
      child.send({type: 'shop-things:quit'}, error => {
        if (error) {
          finish(false);
        }
      });
    } catch {
      finish(false);
    }
  });
}

type SupervisorOptions = {
  version: () => string | Promise<string>;
  stop: () => boolean | Promise<boolean>;
  build: () => void | Promise<unknown>;
  start: () => void | Promise<unknown>;
  report?: (error: unknown) => void;
};

export class RestartSupervisor {
  options: SupervisorOptions & {report: (error: unknown) => void};
  attempted: string | null;
  running: Promise<void> | null;

  constructor({version, stop, build, start, report = console.error}: SupervisorOptions) {
    this.options = {version, stop, build, start, report};
    this.attempted = null;
    this.running = null;
  }
  refresh(): Promise<void> {
    if (this.running) {
      return this.running;
    }

    this.running = this.checkAndCycle().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async checkAndCycle() {
    const version = await this.options.version();
    if (version !== this.attempted) {
      await this.cycle(version);
    }
  }
  async cycle(version: string) {
    while (version !== this.attempted) {
      this.attempted = version;
      if (!(await this.options.stop())) {
        this.options.report(
          new Error('Restart was not approved. The application remains open.')
        );
        return;
      }

      try {
        await this.options.build();
      } catch (error) {
        this.options.report(error);
        return;
      }

      const current = await this.options.version();
      if (current !== version) {
        version = current;
        continue;
      }

      await this.options.start();
    }
  }
}
