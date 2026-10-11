import {createRequire} from 'node:module';

const requireElectron = createRequire(
  new URL('../packages/electron/package.json', import.meta.url)
);
const {build} = requireElectron('esbuild');
await build({
  entryPoints: ['acceptance/controlled-editor.ts', 'acceptance/telemetry-client.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outdir: 'acceptance-reports/harness',
  outExtension: {'.js': '.mjs'},
});
