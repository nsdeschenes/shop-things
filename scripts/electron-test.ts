import {buildAll} from './build.ts';
import {testElectron} from './testHelpers.ts';
import {runIfMain} from './workspace.ts';

await runIfMain(import.meta.url, async () => {
  await buildAll({interfaceBuild: false});
  return testElectron();
});
