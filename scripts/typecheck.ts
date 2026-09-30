/* oxlint-disable import/no-named-export -- Shared workspace task helpers. */
import {join} from 'node:path';

import {pnpm, root, runIfMain} from './workspace.ts';

type Package = 'contract' | 'db' | 'electron' | 'interface' | 'scripts';

export async function typecheck(packages: Package[]) {
  const projects = {
    contract: ['tsconfig.typecheck.json'],
    db: ['tsconfig.typecheck.json'],
    electron: ['tsconfig.typecheck.json'],
    interface: [
      'tsconfig.typecheck.json',
      'tsconfig.node.json',
      'tsconfig.typecheck.contract.json',
    ],
    scripts: ['tsconfig.json'],
  };
  const results = await Promise.allSettled(
    packages.flatMap(name =>
      projects[name].map(project =>
        pnpm(['exec', 'tsc', '--noEmit', '-p', project], {
          cwd: join(root, name === 'scripts' ? 'scripts' : `packages/${name}`),
        }).catch(error => {
          throw new Error(`Type checking ${name}/${project} failed`, {cause: error});
        })
      )
    )
  );
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) {
    throw new AggregateError(
      failures.map(result => result.reason),
      'Type checking failed'
    );
  }
}

await runIfMain(import.meta.url, () => {
  const name = process.argv[2];
  if (name === undefined) {
    return typecheck(['contract', 'db', 'electron', 'interface', 'scripts']);
  }

  if (
    name === 'contract' ||
    name === 'db' ||
    name === 'electron' ||
    name === 'interface' ||
    name === 'scripts'
  ) {
    return typecheck([name]);
  }

  throw new Error(`Unknown type-check package: ${name}`);
});
