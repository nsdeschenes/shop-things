/* oxlint-disable import/no-named-export -- Shared workspace task helpers. */
import {join} from 'node:path';

import {pnpm} from './workspace.ts';

export function testReportArguments(name: string) {
  const directory = process.env.ACCEPTANCE_REPORT_DIR;
  return directory
    ? [
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${join(directory, name + '.json')}`,
      ]
    : [];
}

export async function testElectron(smoke = false, watch = false) {
  await pnpm(['--filter', 'electron', 'exec', 'tsc', '-p', 'tsconfig.test.json']);
  await pnpm(['--filter', 'electron', 'exec', 'tsc', '-p', 'tsconfig.contract.json']);
  await pnpm([
    '--filter',
    'electron',
    'exec',
    'vitest',
    ...(watch ? [] : ['run']),
    ...(smoke ? ['--config', 'vitest.smoke.config.ts'] : []),
    ...testReportArguments(smoke ? 'smoke-tests' : 'electron-tests'),
  ]);
}

export async function testInterface(watch = false) {
  await pnpm([
    '--filter',
    '@shop-things/interface',
    'exec',
    'vitest',
    ...(watch ? [] : ['run']),
    ...testReportArguments('interface-tests'),
  ]);
}
