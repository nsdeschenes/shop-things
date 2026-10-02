import {rm, writeFile} from 'node:fs/promises';
import {join, relative} from 'node:path';

import {build} from 'tsdown';

const forbiddenInput = /(?:\/db\/|actionService|node:)/;

await Promise.all([
  rm('dist/preload.cjs', {force: true}),
  rm('dist/preload.meta.json', {force: true}),
]);

const metadata = {inputs: {}, outputs: {}};

const {bundles} = await build({
  config: false,
  entry: ['src/preload.ts'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  deps: {
    neverBundle: ['electron'],
    alwaysBundle: id => id !== 'electron',
    onlyImport: ['electron'],
    onlyBundle: false,
  },
  outDir: 'dist',
  dts: false,
  clean: false,
  write: false,
  outputOptions: {codeSplitting: false},
  plugins: [
    {
      name: 'preload-dependency-boundary',
      generateBundle(_options, output) {
        const inputs = [...this.getModuleIds()];
        if (inputs.some(path => forbiddenInput.test(path.replaceAll('\\', '/')))) {
          throw new Error('Backend code entered the preload bundle.');
        }

        metadata.inputs = Object.fromEntries(
          inputs
            .map(path => relative(process.cwd(), path))
            .sort((left, right) => left.localeCompare(right))
            .map(path => [path, {}])
        );

        for (const chunk of Object.values(output)) {
          if (chunk.type !== 'chunk') {
            continue;
          }

          const imports = [...chunk.imports, ...chunk.dynamicImports].map(path => ({
            path,
            external: !Object.hasOwn(output, path),
          }));

          if (imports.some(entry => !entry.external || entry.path !== 'electron')) {
            throw new Error('Unexpected preload runtime dependency.');
          }

          metadata.outputs[join('dist', chunk.fileName)] = {imports};
        }
      },
    },
  ],
});

for (const bundle of bundles) {
  for (const output of bundle.chunks) {
    await writeFile(
      join(output.outDir, output.fileName),
      output.type === 'chunk' ? output.code : output.source
    );
  }
}

await writeFile('dist/preload.meta.json', JSON.stringify(metadata, null, 2));
