import {buildAll} from './build.ts';
import {runCommand} from './processes.ts';
import {electronRoot, requireElectron} from './workspace.ts';
import {runIfMain} from './workspace.ts';

await runIfMain(import.meta.url, async () => {
  await buildAll();
  return runCommand(requireElectron('electron'), ['.'], {cwd: electronRoot});
});
