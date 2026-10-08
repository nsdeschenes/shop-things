import {pnpm, runIfMain} from './workspace.ts';

export async function prepare() {
  await pnpm(['--filter', '@shop-things/contract', 'build']);
  await pnpm(['--filter', '@shop-things/db', 'build']);
}

await runIfMain(import.meta.url, prepare);
