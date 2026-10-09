import type {SpawnOptions} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {runCommand} from './processes.ts';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const electronRoot = join(root, 'packages/electron');
export const requireElectron = createRequire(join(electronRoot, 'package.json'));
const pnpmScript = process.env.npm_execpath;
const javascriptExtension = /\.[cm]?js$/;
export function pnpm(args: string[], options: SpawnOptions = {}) {
  return pnpmScript && javascriptExtension.test(pnpmScript)
    ? runCommand(process.execPath, [pnpmScript, ...args], {cwd: root, ...options})
    : runCommand('pnpm', args, {cwd: root, ...options});
}

export async function runIfMain(url: string, run: () => void | Promise<unknown>) {
  if (!process.argv[1] || resolve(process.argv[1]) !== fileURLToPath(url)) {
    return;
  }

  try {
    const {devEngines, scripts} = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8')
    );
    if (process.versions.node !== devEngines.runtime.version) {
      const entry = fileURLToPath(url);
      const command = Object.entries(scripts).find(
        ([, value]) =>
          typeof value === 'string' && value.includes(entry.slice(root.length + 1))
      )?.[0];
      throw new Error(
        `Node ${devEngines.runtime.version} is required; found ${process.versions.node}. Run ${command ? `pnpm ${command}` : `pnpm exec node ${entry}`} to use the locked runtime.`
      );
    }

    await run();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
