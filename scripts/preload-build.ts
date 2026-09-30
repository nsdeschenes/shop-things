import {prepare} from './prepare.ts';
import {runCommand} from './processes.ts';
import {electronRoot} from './workspace.ts';
import {runIfMain} from './workspace.ts';

await runIfMain(import.meta.url, async () => {
  await prepare();
  return runCommand(process.execPath, ['scripts/buildPreload.mjs'], {cwd: electronRoot});
});
