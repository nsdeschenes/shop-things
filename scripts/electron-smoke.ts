import {testElectron} from './testHelpers.ts';
import {runIfMain} from './workspace.ts';

await runIfMain(import.meta.url, async () => {
  // Compare the packaged artifact with the build that produced it.
  return testElectron(true);
});
