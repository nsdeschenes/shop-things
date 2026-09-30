/* oxlint-disable import/no-named-export -- Shared workspace task helpers. */
import {buildAll} from './build.ts';
import {testElectron, testInterface, testReportArguments} from './testHelpers.ts';
import {pnpm, runIfMain} from './workspace.ts';

export async function testAll() {
  await pnpm(['--filter', '@shop-things/contract', 'test']);
  if (process.env.ACCEPTANCE_REPORT_DIR) {
    await pnpm(['--filter', '@shop-things/db', 'build']);
    await pnpm([
      '--filter',
      '@shop-things/db',
      'exec',
      'tsc',
      '-p',
      'tsconfig.test.json',
    ]);
    await pnpm([
      '--filter',
      '@shop-things/db',
      'exec',
      'vitest',
      'run',
      ...testReportArguments('db-tests'),
    ]);
  } else {
    await pnpm(['--filter', '@shop-things/db', 'test']);
  }

  await pnpm(['--filter', '@shop-things/db', 'migrations:check']);
  await buildAll({interfaceBuild: false});
  await testElectron();
  await testInterface();
  await pnpm(['exec', 'tsc', '-p', 'scripts/tsconfig.test.json']);
  return pnpm([
    'exec',
    'vitest',
    'run',
    '--config',
    'scripts/vitest.config.ts',
    ...testReportArguments('scripts-tests'),
  ]);
}

await runIfMain(import.meta.url, testAll);
