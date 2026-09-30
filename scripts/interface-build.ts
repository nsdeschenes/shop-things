import {compileInterface} from './build.ts';
import {prepare} from './prepare.ts';
import {runIfMain} from './workspace.ts';

await runIfMain(import.meta.url, async () => {
  await prepare();
  return compileInterface(true);
});
