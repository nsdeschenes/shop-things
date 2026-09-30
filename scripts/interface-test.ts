import {compileInterface} from './build.ts';
import {prepare} from './prepare.ts';
import {testInterface} from './testHelpers.ts';
import {runIfMain} from './workspace.ts';

await runIfMain(import.meta.url, async () => {
  await prepare();
  await compileInterface(false);
  return testInterface();
});
