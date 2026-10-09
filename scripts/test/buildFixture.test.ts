import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants, watch} from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, delimiter, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {expect, test} from 'vitest';

import {withBuildFixture} from './buildFixture.ts';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cache = join(homedir(), '.cache/agent-work/shop-things/build-fixtures');
const captureChanged = /Source changed during capture/;
const retained = /Build fixture retained at ([^;]+);/;
const escaping = /Escaping fixture/;
const closed = /callback has ended/;
const unfinished = /unfinished commands/;
const interrupted = /interrupted/;

async function input() {
  await mkdir(join(cache, 'worktrees'), {recursive: true});
  const source = await mkdtemp(join(cache, 'worktrees/source-test-'));
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      packageManager: manifest.packageManager,
      devEngines: manifest.devEngines,
    })
  );
  await writeFile(join(source, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFile(join(source, '.gitignore'), 'ignored\nnode_modules\n');
  await execute('pnpm', ['install', '--lockfile-only'], {cwd: source});
  await execute('git', ['init', '-q'], {cwd: source});
  await writeFile(join(source, 'dirty.ts'), 'original\n');
  await writeFile(join(source, 'deleted.ts'), 'delete me\n');
  await writeFile(join(source, 'old.ts'), 'rename me\n');
  await writeFile(
    join(source, 'probe.mjs'),
    'console.log(JSON.stringify({cwd:process.cwd(),node:process.versions.node,path:process.execPath}));'
  );
  await execute('git', ['add', '.'], {cwd: source});
  await execute(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--no-gpg-sign',
      '-qm',
      'fixture source',
    ],
    {cwd: source}
  );
  return source;
}

function diagnostic(directory: string, name: string) {
  return join(cache, 'context', basename(directory), name);
}

async function retainedRoot(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
    throw new Error('Expected fixture rejection');
  } catch (error) {
    const match = retained.exec(String(error));
    if (!match?.[1]) {
      throw error;
    }

    return match[1];
  }
}

test('capture includes current dirty bytes, deletions, renames, modes and eligible additions', async ({
  signal,
}) => {
  const source = await input();
  try {
    await writeFile(join(source, 'dirty.ts'), 'dirty current bytes\n');
    await chmod(join(source, 'dirty.ts'), 0o644);
    await rm(join(source, 'deleted.ts'));
    await rename(join(source, 'old.ts'), join(source, 'renamed.ts'));
    await chmod(join(source, 'renamed.ts'), 0o755);
    await writeFile(join(source, 'addition.ts'), 'eligible addition\n');
    await writeFile(join(source, 'ignored'), 'do not copy\n');
    await symlink('dirty.ts', join(source, 'internal.ts'));
    await symlink(join(source, 'dirty.ts'), join(source, 'absolute-internal.ts'));
    let savedPath: (() => string) | undefined;
    const directory = await withBuildFixture(
      'current-source',
      async fixture => {
        savedPath = () => fixture.path('.');
        expect(await readFile(fixture.path('dirty.ts'), 'utf8')).toBe(
          'dirty current bytes\n'
        );
        expect(await readFile(fixture.path('renamed.ts'), 'utf8')).toBe('rename me\n');
        expect((await lstat(fixture.path('renamed.ts'))).mode & 0o777).toBe(0o755);
        expect(await readFile(fixture.path('addition.ts'), 'utf8')).toBe(
          'eligible addition\n'
        );
        await expect(readFile(fixture.path('deleted.ts'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(readFile(fixture.path('old.ts'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(readFile(fixture.path('ignored'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(await realpath(fixture.path('internal.ts'))).toBe(
          fixture.path('dirty.ts')
        );
        expect(await realpath(fixture.path('absolute-internal.ts'))).toBe(
          fixture.path('dirty.ts')
        );
        const node = JSON.parse((await fixture.nodeFile('probe.mjs')).stdout);
        expect(node).toEqual({
          cwd: fixture.path('.'),
          node: '26.11.0',
          path: await realpath(node.path),
        });
        expect(node.path.startsWith(fixture.path('.') + '/')).toBe(true);
        const receipt = JSON.parse(
          await readFile(diagnostic(fixture.path('.'), 'source.json'), 'utf8')
        );
        expect(
          receipt.files.find((entry: {path: string}) => entry.path === 'dirty.ts')
        ).toEqual({
          path: 'dirty.ts',
          kind: 'file',
          mode: 0o644,
          content: createHash('sha256').update('dirty current bytes\n').digest('hex'),
        });
        expect(
          receipt.files.find((entry: {path: string}) => entry.path === 'deleted.ts')
        ).toEqual({path: 'deleted.ts', kind: 'missing', mode: 0, content: null});
        return fixture.path('.');
      },
      {sourceRoot: source, signal}
    );
    expect(savedPath).toThrow(closed);
    await expect(lstat(directory)).rejects.toMatchObject({code: 'ENOENT'});
    expect(
      JSON.parse(await readFile(diagnostic(directory, 'result.json'), 'utf8')).state
    ).toBe('passed');
    expect(await readFile(join(source, 'dirty.ts'), 'utf8')).toBe(
      'dirty current bytes\n'
    );
  } finally {
    await rm(source, {recursive: true, force: true});
  }
});

test('paths reject traversal and links that escape the private fixture', async ({
  signal,
}) => {
  const source = await input();
  try {
    await withBuildFixture(
      'path-containment',
      async fixture => {
        expect(() => fixture.path('../outside')).toThrow(escaping);
        expect(() => fixture.path('/outside')).toThrow(escaping);
        expect(() => fixture.path('C:\\outside')).toThrow(escaping);
        await symlink(source, fixture.path('external'));
        expect(() => fixture.path('external/dirty.ts')).toThrow(escaping);
        expect(await readFile(fixture.path('dirty.ts'), 'utf8')).toBe('original\n');
      },
      {sourceRoot: source, signal}
    );
    await symlink(join(source, '..'), join(source, 'escape'));
    const directory = await retainedRoot(
      withBuildFixture(
        'source-link-escape',
        async () => {
          throw new Error('Callback must not run');
        },
        {sourceRoot: source, signal}
      )
    );
    const result = JSON.parse(
      await readFile(diagnostic(directory, 'result.json'), 'utf8')
    );
    expect(result.state).toBe('failed');
    expect(result.error).toContain('Escaping fixture link');
    expect(await readFile(join(source, 'dirty.ts'), 'utf8')).toBe('original\n');
  } finally {
    await rm(source, {recursive: true, force: true});
  }
});

test.each(['bytes', 'file-set'])(
  'capture rejects a concurrent source %s change before running validation',
  async change => {
    const source = await input();
    await writeFile(join(source, '000-anchor'), 'copy barrier\n');
    for (let index = 0; index < 40; index++) {
      await writeFile(join(source, `padding-${index}`), Buffer.alloc(256_000, index));
    }

    const label = `changing-${change}`;
    let copiedWatcher: ReturnType<typeof watch> | undefined;
    let mutation: Promise<void> | undefined;
    const allocationWatcher = watch(join(cache, 'worktrees'), (_event, name) => {
      if (!name?.toString().startsWith(label + '-') || copiedWatcher) {
        return;
      }

      copiedWatcher = watch(
        join(cache, 'worktrees', name.toString()),
        (_copyEvent, copiedName) => {
          if (copiedName?.toString() !== '000-anchor' || mutation) {
            return;
          }

          mutation = writeFile(
            join(source, change === 'bytes' ? 'dirty.ts' : 'new-source.ts'),
            'concurrent source bytes\n'
          );
        }
      );
    });
    try {
      const operation = withBuildFixture(
        label,
        async () => {
          throw new Error('Validation must not run');
        },
        {sourceRoot: source}
      );
      await expect(operation).rejects.toThrow(captureChanged);
      await mutation;
      expect(
        await readFile(
          join(source, change === 'bytes' ? 'dirty.ts' : 'new-source.ts'),
          'utf8'
        )
      ).toBe('concurrent source bytes\n');
      const directory = await retainedRoot(operation);
      const result = JSON.parse(
        await readFile(diagnostic(directory, 'result.json'), 'utf8')
      );
      expect(result.state).toBe('failed');
      expect(result.commandCount).toBeLessThan(5);
    } finally {
      allocationWatcher.close();
      copiedWatcher?.close();
      await mutation;
      await rm(source, {recursive: true, force: true});
    }
  }
);

test('callback failure retains private inputs and drains unfinished children', async ({
  signal,
}) => {
  const source = await input();
  try {
    await writeFile(
      join(source, 'slow.mjs'),
      `import {spawn} from 'node:child_process'; import {writeFile} from 'node:fs/promises';
const child = spawn(process.execPath, ['-e', "const {writeFileSync}=require('node:fs'); process.on('SIGTERM',()=>{}); setInterval(()=>writeFileSync('heartbeat',String(Date.now())),10);"], {detached:true, stdio:'ignore'});
await writeFile('started',JSON.stringify({parent:process.pid,child:child.pid})); setInterval(()=>{},1000);`
    );
    let pending: Promise<unknown> | undefined;
    const directory = await retainedRoot(
      withBuildFixture(
        'unfinished-child',
        async fixture => {
          pending = fixture.nodeFile('slow.mjs');
          await new Promise<void>(fulfill => {
            const observer = watch(fixture.path('.'), (_event, name) => {
              if (name?.toString() === 'heartbeat') {
                observer.close();
                fulfill();
              }
            });
          });
          await writeFile(fixture.path('dirty.ts'), 'private failed mutation\n');
        },
        {sourceRoot: source, signal}
      )
    );
    await expect(pending).rejects.toThrow();
    const result = JSON.parse(
      await readFile(diagnostic(directory, 'result.json'), 'utf8')
    );
    expect(result.state).toBe('failed');
    expect(result.error).toMatch(unfinished);
    expect(await readFile(join(directory, 'dirty.ts'), 'utf8')).toBe(
      'private failed mutation\n'
    );
    expect(await readFile(join(source, 'dirty.ts'), 'utf8')).toBe('original\n');
    const pids = JSON.parse(await readFile(join(directory, 'started'), 'utf8'));
    expect(() => process.kill(pids.parent, 0)).toThrow();
    const heartbeat = await readFile(join(directory, 'heartbeat'), 'utf8');
    await new Promise(fulfill => setTimeout(fulfill, 75));
    expect(await readFile(join(directory, 'heartbeat'), 'utf8')).toBe(heartbeat);
  } finally {
    await rm(source, {recursive: true, force: true});
  }
});

test('abort after private mutation rejects even when the callback catches child failure', async () => {
  const source = await input();
  const controller = new AbortController();
  try {
    const directory = await retainedRoot(
      withBuildFixture(
        'aborted-fixture',
        async fixture => {
          await writeFile(fixture.path('dirty.ts'), 'private interrupted mutation\n');
          controller.abort();
          await expect(fixture.nodeFile('probe.mjs')).rejects.toThrow(interrupted);
        },
        {sourceRoot: source, signal: controller.signal}
      )
    );
    expect(await readFile(join(directory, 'dirty.ts'), 'utf8')).toBe(
      'private interrupted mutation\n'
    );
    expect(
      JSON.parse(await readFile(diagnostic(directory, 'result.json'), 'utf8')).state
    ).toBe('interrupted');
    expect(await readFile(join(source, 'dirty.ts'), 'utf8')).toBe('original\n');
  } finally {
    await rm(source, {recursive: true, force: true});
  }
});

test('workspace and native dependencies resolve within an independently installed fixture', async ({
  signal,
}) => {
  await withBuildFixture(
    'dependency-isolation',
    async fixture => {
      await copyFile(
        join(root, 'scripts/test/buildFixture.test.ts'),
        fixture.path('probe-source.txt')
      );
      await writeFile(
        fixture.path('dependency-probe.mjs'),
        `
import {createRequire} from 'node:module';
import {realpathSync, readFileSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const electron = createRequire(new URL('./packages/electron/package.json', import.meta.url));
const workspace = realpathSync(new URL('./packages/electron/node_modules/@shop-things/contract/package.json', import.meta.url));
const esbuild = realpathSync(electron.resolve('esbuild'));
const database = createRequire(new URL('./packages/db/package.json', import.meta.url));
const native = realpathSync(database.resolve('@tursodatabase/database')); database('@tursodatabase/database');
const child = spawnSync('node', ['-p','process.versions.node'], {encoding:'utf8'});
writeFileSync(esbuild, Buffer.concat([readFileSync(esbuild), Buffer.from('\\nfixture mutation\\n')]));
console.log(JSON.stringify({workspace, esbuild, native, child:child.stdout.trim(), code:child.status, node:process.versions.node}));
`
      );
      const callerEsbuild = resolve(
        root,
        'packages/electron/node_modules/esbuild/lib/main.js'
      );
      const original = await readFile(callerEsbuild);
      const result = JSON.parse((await fixture.nodeFile('dependency-probe.mjs')).stdout);
      expect(result.workspace).toBe(fixture.path('packages/contract/package.json'));
      expect(result.esbuild.startsWith(fixture.path('.') + '/')).toBe(true);
      expect(result.native.startsWith(fixture.path('.') + '/')).toBe(true);
      expect({node: result.node, child: result.child, code: result.code}).toEqual({
        node: '26.11.0',
        child: '26.11.0',
        code: 0,
      });
      expect(await readFile(callerEsbuild)).toStrictEqual(original);
    },
    {signal}
  );
});

test('fixture bootstrap keeps an action-managed pnpm executable without npm_execpath', async ({
  signal,
}) => {
  const source = await input();
  const toolchain = await mkdtemp(join(cache, 'worktrees/toolchain-test-'));
  const bin = join(toolchain, 'node_modules/.bin');
  await mkdir(bin, {recursive: true});
  const previous = {
    PATH: process.env.PATH,
    PNPM_HOME: process.env.PNPM_HOME,
    CI: process.env.CI,
    npm_execpath: process.env.npm_execpath,
  };
  try {
    let launcher = process.env.npm_execpath;
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      if (launcher) {
        break;
      }

      const candidate = join(directory, 'pnpm');
      if (
        await access(candidate, constants.X_OK).then(
          () => true,
          () => false
        )
      ) {
        launcher = candidate;
      }
    }

    if (!launcher) {
      throw new Error('No real pnpm bootstrap executable found');
    }

    await symlink(launcher, join(bin, 'pnpm'));
    process.env.PATH = [bin, '/usr/bin', '/bin'].join(delimiter);
    process.env.PNPM_HOME = bin;
    process.env.CI = 'true';
    delete process.env.npm_execpath;
    await withBuildFixture(
      'ci-bootstrap',
      async fixture => {
        expect((await fixture.pnpm(['--version'])).stdout.trim()).toBe('12.4.2');
        const runtime = JSON.parse((await fixture.nodeFile('probe.mjs')).stdout);
        expect(runtime.node).toBe('26.11.0');
        expect(runtime.cwd).toBe(fixture.path('.'));
        expect(runtime.path.startsWith(fixture.path('.') + '/')).toBe(true);
      },
      {sourceRoot: source, signal}
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await rm(toolchain, {recursive: true, force: true});
    await rm(source, {recursive: true, force: true});
  }
});

test('a symlinked home cache runs a complete fixture while real escapes still fail', async () => {
  const source = await input();
  const alias = join(source, 'linked-home');
  await symlink(homedir(), alias);
  await writeFile(join(source, '.gitignore'), 'linked-home\nnode_modules\n');
  const script = join(cache, 'context', `linked-home-${basename(source)}.mjs`);
  await writeFile(
    script,
    `
import assert from 'node:assert/strict';
import {withBuildFixture} from ${JSON.stringify(join(root, 'scripts/test/buildFixture.ts'))};
await withBuildFixture('linked-home', async fixture => {
  assert.throws(() => fixture.path('../outside'), /Escaping fixture path/);
  const node = JSON.parse((await fixture.nodeFile('probe.mjs')).stdout);
  assert.equal(node.node, '26.11.0');
  assert.equal((await fixture.pnpm(['--version'])).stdout.trim(), '12.4.2');
  console.log(JSON.stringify({cwd:node.cwd, path:node.path, fixture:fixture.path('.')}));
}, {sourceRoot: ${JSON.stringify(source)}});
`
  );
  try {
    const {stdout} = await execute(process.execPath, [script], {
      env: {...process.env, HOME: alias},
    });
    const result = JSON.parse(stdout.trim());
    expect(result.cwd).toBe(result.fixture);
    expect(
      result.fixture.startsWith((await realpath(join(cache, 'worktrees'))) + '/')
    ).toBe(true);
    expect(result.path.startsWith(result.fixture + '/')).toBe(true);
  } finally {
    await rm(source, {recursive: true, force: true});
  }
});
