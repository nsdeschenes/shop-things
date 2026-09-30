import {develop} from './development.ts';
import {runIfMain} from './workspace.ts';

await runIfMain(import.meta.url, async () => develop());
