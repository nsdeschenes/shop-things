/* oxlint-disable import/no-named-export -- Shared workspace task helpers. */
import {readFile} from 'node:fs/promises';
import {createRequire, builtinModules} from 'node:module';
import {join} from 'node:path';

import {electronRoot, requireElectron, root} from './workspace.ts';

const prohibitedDependency = /(?:^|\/)(?:electron|drizzle-orm|@tursodatabase|db)(?:\/|$)/;
export async function inspectBrowserDependencies() {
  const {build} = await import(requireElectron.resolve('esbuild'));
  const prohibited = prohibitedDependency;
  const manifest: {exports: Record<string, Record<string, string>>} = JSON.parse(
    await readFile(join(root, 'packages/contract/package.json'), 'utf8')
  );
  const visited = new Set<string>();
  async function inspectManifest(path: string) {
    if (visited.has(path)) {
      return;
    }

    visited.add(path);
    const read = createRequire(path);
    const value: {dependencies?: Record<string, string>} = JSON.parse(
      await readFile(path, 'utf8')
    );
    for (const dependency of Object.keys(value.dependencies ?? {})) {
      if (
        prohibited.test(dependency) ||
        builtinModules.includes(dependency) ||
        dependency.startsWith('node:')
      ) {
        throw new Error(`Prohibited contract dependency: ${dependency}`);
      }

      await inspectManifest(read.resolve(`${dependency}/package.json`));
    }
  }

  await inspectManifest(join(root, 'packages/contract/package.json'));
  if (
    Object.values(manifest.exports).some(entry =>
      Object.values(entry).some(path => !path.startsWith('./dist/'))
    )
  ) {
    throw new Error('Contract exports must resolve compiled artifacts');
  }

  const bundled: {
    metafile: {
      inputs: Record<string, unknown>;
      outputs: Record<string, {imports: unknown[]}>;
    };
  } = await build({
    entryPoints: [
      join(root, 'packages/contract/dist/client.js'),
      join(root, 'packages/contract/dist/schemas.js'),
    ],
    bundle: true,
    write: false,
    outdir: 'contract-inspection',
    platform: 'browser',
    metafile: true,
  });
  if (Object.keys(bundled.metafile.inputs).some(path => prohibited.test(path))) {
    throw new Error('Backend dependency entered the browser contract');
  }

  if (
    Object.values(bundled.metafile.outputs).some(output => output.imports.length !== 0)
  ) {
    throw new Error('Contract bundle contains unresolved runtime imports');
  }

  const preload: {
    outputs: Record<string, {imports: {external: boolean; path: string}[]}>;
  } = JSON.parse(await readFile(join(electronRoot, 'dist/preload.meta.json'), 'utf8'));
  if (
    Object.values(preload.outputs).some(output =>
      output.imports.some(entry => !entry.external || entry.path !== 'electron')
    )
  ) {
    throw new Error('Preload bundle has an unexpected runtime import');
  }
}
