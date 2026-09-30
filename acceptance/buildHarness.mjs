import {createRequire} from 'node:module';

const requireElectron = createRequire(
  new URL('../packages/electron/package.json', import.meta.url)
);
const {build} = requireElectron('esbuild');
await build({
  entryPoints: ['acceptance/controlled-editor.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: 'acceptance-reports/harness/controlled-editor.mjs',
});
