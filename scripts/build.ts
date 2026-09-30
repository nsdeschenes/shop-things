/* oxlint-disable import/no-named-export -- Shared workspace task helpers. */
import {rm} from 'node:fs/promises';
import {join} from 'node:path';

import {inspectBrowserDependencies} from './inspectBrowserDependencies.ts';
import {prepare} from './prepare.ts';
import {runCommand} from './processes.ts';
import {electronRoot, pnpm, runIfMain} from './workspace.ts';

async function compileElectron() {
  await rm(join(electronRoot, 'dist'), {recursive: true, force: true});
  await pnpm([
    '--filter',
    'electron',
    'exec',
    'tsc',
    '--noEmit',
    'false',
    '--allowImportingTsExtensions',
    'false',
    '--rootDir',
    'src',
    '--outDir',
    'dist',
    '--incremental',
    'false',
  ]);
  await runCommand(process.execPath, ['scripts/buildPreload.mjs'], {cwd: electronRoot});
}

export async function compileInterface(build: boolean) {
  await pnpm(['--filter', '@shop-things/interface', 'exec', 'tsc', '-b', '--force']);
  await pnpm([
    '--filter',
    '@shop-things/interface',
    'exec',
    'tsc',
    '-p',
    'tsconfig.contract.json',
  ]);
  if (build) {
    await pnpm(['--filter', '@shop-things/interface', 'exec', 'vite', 'build']);
  }
}

export async function buildAll({interfaceBuild = true} = {}) {
  await prepare();
  await compileElectron();
  await compileInterface(interfaceBuild);
  await inspectBrowserDependencies();
}

await runIfMain(import.meta.url, buildAll);
