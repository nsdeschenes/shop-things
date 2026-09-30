import {buildAll} from './build.ts';
import {runIfMain} from './workspace.ts';

await runIfMain(import.meta.url, async () => buildAll({interfaceBuild: false}));
