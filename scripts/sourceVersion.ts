/* oxlint-disable import/no-named-export -- Shared workspace task helpers. */
import {createHash} from 'node:crypto';
import {readFile, readdir, realpath} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join, relative} from 'node:path';

import {root} from './workspace.ts';

const configurationFile = /^(?:tsconfig.*\.json|vite\.config\.ts|tsdown\.config\.ts)$/;
async function paths(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, {withFileTypes: true});
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const output = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await paths(path)));
    } else if (entry.isFile()) {
      output.push(path);
    }
  }

  return output;
}

export async function sourceVersion() {
  const files = [
    join(root, 'package.json'),
    join(root, 'pnpm-lock.yaml'),
    join(root, 'pnpm-workspace.yaml'),
    join(root, 'tsconfig.json'),
    ...(await paths(join(root, 'scripts'))),
  ];
  for (const name of ['contract', 'db', 'electron', 'interface']) {
    const packageRoot = join(root, 'packages', name);
    files.push(
      ...(await paths(join(packageRoot, 'src'))),
      ...(await paths(join(packageRoot, 'test'))),
      ...(await paths(join(packageRoot, 'scripts'))),
      ...(await paths(join(packageRoot, 'migrations'))),
      join(packageRoot, 'package.json')
    );
    for (const entry of await readdir(packageRoot)) {
      if (configurationFile.test(entry)) {
        files.push(join(packageRoot, entry));
      }
    }
  }

  for (const packageRoot of [
    root,
    ...['contract', 'db', 'electron', 'interface'].map(name =>
      join(root, 'packages', name)
    ),
  ]) {
    const manifest: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const requirePackage = createRequire(join(packageRoot, 'package.json'));
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      if (dependency.startsWith('@shop-things/')) {
        continue;
      }

      let dependencyManifest = null;
      for (const directory of requirePackage.resolve.paths(dependency) ?? []) {
        const candidate = join(directory, dependency, 'package.json');
        try {
          await readFile(candidate);
          dependencyManifest = await realpath(candidate);
          break;
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            throw error;
          }
        }
      }

      if (dependencyManifest === null) {
        throw new Error(`Cannot resolve dependency manifest: ${dependency}`);
      }

      files.push(dependencyManifest);
    }
  }

  const hash = createHash('sha256');
  for (const path of files.sort((left, right) => left.localeCompare(right))) {
    hash.update(relative(root, path));
    hash.update(await readFile(path));
  }

  return hash.digest('hex');
}
