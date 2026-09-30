import {compileInterface} from './build.ts';
import {prepare} from './prepare.ts';
import {pnpm} from './workspace.ts';
import {runIfMain} from './workspace.ts';

await runIfMain(import.meta.url, async () => {
  await prepare();
  await compileInterface(false);
  return pnpm(['--filter', '@shop-things/interface', 'exec', 'vite', 'dev']);
});
