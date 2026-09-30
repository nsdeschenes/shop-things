import type {SpawnOptions} from 'node:child_process';
/* oxlint-disable import/no-named-export -- Shared workspace task helpers. */
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
    await run();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
