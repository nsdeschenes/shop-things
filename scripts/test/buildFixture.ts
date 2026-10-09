import {execFile, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants, lstatSync, realpathSync} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {homedir} from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

type Entry = {path: string; stamp: string; mode: number} & (
  | {kind: 'missing'}
  | {kind: 'file'; bytes: Buffer}
  | {kind: 'link'; target: string}
);
type CommandResult = {stdout: string; stderr: string};
type CommandOptions = {cwd?: string};
type BuildFixture = {
  path: (path: string) => string;
  pnpm: (args: readonly string[], options?: CommandOptions) => Promise<CommandResult>;
  nodeFile: (
    file: string,
    args?: readonly string[],
    options?: CommandOptions
  ) => Promise<CommandResult>;
};
type FixtureOptions = {sourceRoot?: string; signal?: AbortSignal};

const execute = promisify(execFile);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cacheRoot = join(homedir(), '.cache/agent-work/shop-things/build-fixtures');
const javascriptExtension = /\.[cm]?js$/;
const forbiddenComponent = /^(?:\.git|node_modules|dist|release|acceptance-reports)$/;
const foreignAbsolute = /^(?:[a-z]:|\\)/i;
const safeLabel = /[^a-z0-9-]/gi;
const pathSeparator = /[\\/]/;
const npmConfiguration = /^npm_config_/i;
const whitespace = /\s+/;
const sensitiveName =
  /^(?:\.env(?!\.example$).*|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519))$/i;

function contained(root: string, path: string): boolean {
  const name = relative(root, path);
  return (
    name === '' || (!isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`))
  );
}

function privatePath(root: string, name: string): string {
  if (
    isAbsolute(name) ||
    foreignAbsolute.test(name) ||
    name.split(pathSeparator).includes('..')
  ) {
    throw new Error(`Escaping fixture path: ${name}`);
  }

  const path = resolve(root, name);
  if (!contained(root, path)) {
    throw new Error(`Escaping fixture path: ${name}`);
  }

  let ancestor = path;
  while (contained(root, ancestor)) {
    try {
      lstatSync(ancestor);
      if (!contained(root, realpathSync(ancestor))) {
        throw new Error(`Escaping fixture link: ${name}`);
      }

      break;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }

    ancestor = dirname(ancestor);
  }

  return path;
}

function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function snapshot(root: string, names: readonly string[]): Promise<Entry[]> {
  const entries: Entry[] = [];
  const metadata = await Promise.all(
    names.map(async name => {
      const path = privatePath(root, name);
      return lstat(path, {bigint: true}).catch(error => {
        if (error.code === 'ENOENT') {
          return null;
        }

        throw error;
      });
    })
  );
  for (const [index, name] of names.entries()) {
    if (
      name
        .split(pathSeparator)
        .some(part => forbiddenComponent.test(part) || sensitiveName.test(part))
    ) {
      throw new Error(`Excluded source path: ${name}`);
    }

    const path = privatePath(root, name);
    for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
      const stat = await lstat(parent).catch(error => {
        if (error.code === 'ENOENT') {
          return null;
        }

        throw error;
      });
      if (stat?.isSymbolicLink()) {
        throw new Error(`Source has a symlink ancestor: ${name}`);
      }
    }

    const stat = metadata[index];
    if (!stat) {
      entries.push({path: name, kind: 'missing', stamp: '', mode: 0});
      continue;
    }

    const stamp = [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mode,
      stat.mtimeNs,
      stat.ctimeNs,
    ].join(':');
    const mode = Number(stat.mode & 0o777n);
    if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      const resolved = await realpath(path);
      if (
        !contained(root, resolved) ||
        !(await lstat(resolved)).isFile() ||
        !names.includes(relative(root, resolved))
      ) {
        throw new Error(`Uncaptured or escaping source link: ${name}`);
      }

      entries.push({path: name, kind: 'link', stamp, mode, target});
      continue;
    }

    if (!stat.isFile()) {
      throw new Error(`Unsupported source file: ${name}`);
    }

    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await file.stat({bigint: true});
      const bytes = await file.readFile();
      const after = await file.stat({bigint: true});
      for (const current of [before, after]) {
        if (
          [
            current.dev,
            current.ino,
            current.size,
            current.mode,
            current.mtimeNs,
            current.ctimeNs,
          ].join(':') !== stamp
        ) {
          throw new Error(`Source changed during capture: ${name}`);
        }
      }

      entries.push({path: name, kind: 'file', stamp, mode, bytes});
    } finally {
      await file.close();
    }
  }

  return entries;
}

function inventory(entries: readonly Entry[]) {
  return entries.map(entry => {
    let content: string | null = null;
    if (entry.kind === 'file') {
      content = hash(entry.bytes);
    } else if (entry.kind === 'link') {
      content = entry.target;
    }

    return {path: entry.path, kind: entry.kind, mode: entry.mode, content};
  });
}

async function fileNames(root: string, directory = root): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      names.push(...(await fileNames(root, path)));
    } else {
      names.push(relative(root, path));
    }
  }

  return names.sort();
}

async function stopTree(pid: number | undefined): Promise<void> {
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    await execute('taskkill', ['/pid', String(pid), '/T', '/F']).catch(error => {
      if (error.code !== 128) {
        throw error;
      }
    });
    return;
  }

  const descendants = new Set([pid]);
  async function living() {
    const {stdout} = await execute('ps', ['-A', '-o', 'pid=,ppid=,stat=']);
    const rows = stdout
      .trim()
      .split('\n')
      .map(line => {
        const [child, parent, state] = line.trim().split(whitespace);
        return {pid: Number(child), parent: Number(parent), state};
      });
    let added = true;
    while (added) {
      added = false;
      for (const row of rows) {
        if (descendants.has(row.parent) && !descendants.has(row.pid)) {
          descendants.add(row.pid);
          added = true;
        }
      }
    }

    return rows
      .filter(row => descendants.has(row.pid) && !row.state?.startsWith('Z'))
      .map(row => row.pid);
  }

  const started = performance.now();
  let pids = await living();
  while (pids.length !== 0) {
    for (const target of pids.toReversed()) {
      try {
        process.kill(target, performance.now() - started < 2000 ? 'SIGTERM' : 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          throw error;
        }
      }
    }

    if (performance.now() - started > 5000) {
      throw new Error(`Fixture descendants did not stop: ${pids.join(', ')}`);
    }

    await new Promise(fulfill => setTimeout(fulfill, 25));
    pids = await living();
  }
}

async function inspectLinks(root: string, directory = root): Promise<void> {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (!contained(root, await realpath(path))) {
        throw new Error(`Dependency link escapes fixture: ${path}`);
      }
    } else if (entry.isDirectory()) {
      await inspectLinks(root, path);
    }
  }
}

export async function withBuildFixture<T>(
  label: string,
  callback: (fixture: BuildFixture) => Promise<T>,
  options: FixtureOptions = {}
): Promise<T> {
  const caller = await realpath(options.sourceRoot ?? sourceRoot);
  await mkdir(join(cacheRoot, 'worktrees'), {recursive: true});
  const root = await realpath(
    await mkdtemp(
      join(cacheRoot, 'worktrees', `${label.replace(safeLabel, '-').slice(0, 60)}-`)
    )
  );
  const diagnostics = join(cacheRoot, 'context', basename(root));
  await mkdir(diagnostics, {recursive: true});
  await writeFile(
    join(diagnostics, 'result.json'),
    JSON.stringify({state: 'running', root})
  );
  const environment = {...process.env};
  for (const key of Object.keys(environment)) {
    if (
      npmConfiguration.test(key) ||
      [
        'NODE_PATH',
        'NODE_OPTIONS',
        'NODE_COMPILE_CACHE',
        'NAPI_RS_NATIVE_LIBRARY_PATH',
        'GIT_DIR',
        'GIT_WORK_TREE',
      ].includes(key)
    ) {
      delete environment[key];
    }
  }

  environment.NODE_OPTIONS = '--experimental-strip-types';
  environment.TMPDIR = join(root, '.tmp');
  environment.TMP = environment.TMPDIR;
  environment.TEMP = environment.TMPDIR;
  environment.PATH = (environment.PATH ?? '')
    .split(delimiter)
    .filter(
      path => !contained(caller, resolve(path)) && !contained(sourceRoot, resolve(path))
    )
    .join(delimiter);
  const stoppingChildren = new Set<Promise<void>>();
  const active = new Map<Promise<CommandResult>, () => Promise<void>>();
  let admission = true;
  let interrupted: Error | undefined;
  const cancellation = Promise.withResolvers<never>();
  void cancellation.promise.catch(() => {});
  let commandCount = 0;
  let runtime = process.execPath;
  function cancel() {
    interrupted ??= new Error('Build fixture interrupted');
    cancellation.reject(interrupted);
    for (const stop of active.values()) {
      void stop().catch(() => {});
    }
  }

  function terminate() {
    process.exitCode = 143;
    cancel();
  }

  options.signal?.addEventListener('abort', cancel, {once: true});
  process.on('SIGTERM', terminate);
  function checkAdmission() {
    if (interrupted || options.signal?.aborted || !admission) {
      throw interrupted ?? new Error('Build fixture callback has ended or was aborted');
    }
  }

  function command(
    executable: string,
    args: readonly string[],
    cwd: string
  ): Promise<CommandResult> {
    try {
      checkAdmission();
    } catch (error) {
      return Promise.reject(error);
    }

    const number = ++commandCount;
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const commandReceipt = writeFile(
      join(diagnostics, `command-${number}.json`),
      JSON.stringify({state: 'running', executable, args, cwd, pid: child.pid})
    );
    const chunks: Buffer[] = [];
    let stdout = '';
    let stderr = '';
    let stopping: Promise<void> | undefined;
    function stop() {
      if (!stopping) {
        stopping = stopTree(child.pid);
        stoppingChildren.add(stopping);
      }

      return stopping;
    }

    const completion = new Promise<CommandResult>((fulfill, reject) => {
      let spawnError: Error | undefined;
      child.once('error', error => {
        spawnError = error;
      });
      child.stdout.on('data', (bytes: Buffer) => {
        stdout += bytes.toString();
        chunks.push(bytes);
      });
      child.stderr.on('data', (bytes: Buffer) => {
        stderr = (stderr + bytes.toString()).slice(-65536);
        chunks.push(bytes);
      });
      child.once('close', async (code, signal) => {
        try {
          await commandReceipt;
          await writeFile(
            join(diagnostics, `command-${number}.log`),
            Buffer.concat(chunks)
          );
          await writeFile(
            join(diagnostics, `command-${number}.json`),
            JSON.stringify({
              executable,
              args,
              cwd,
              code,
              signal,
              error: spawnError?.message,
            })
          );
          if (spawnError || code !== 0 || interrupted) {
            reject(
              new Error(
                `${executable} ${args.join(' ')} failed (${signal ?? code}) in private fixture ${root}\n${stdout.slice(-65536)}\n${stderr}`,
                {cause: spawnError ?? interrupted}
              )
            );
          } else {
            fulfill({stdout, stderr});
          }
        } catch (error) {
          reject(error);
        }
      });
    });
    active.set(completion, stop);
    void completion.then(
      () => active.delete(completion),
      () => active.delete(completion)
    );
    return completion;
  }

  function pnpm(args: readonly string[], cwd = root) {
    const entry = process.env.npm_execpath;
    return entry && javascriptExtension.test(entry)
      ? command(runtime, [entry, ...args], cwd)
      : command(entry ?? 'pnpm', args, cwd);
  }

  let sourceIdentity: unknown;
  const started = performance.now();
  try {
    const selected = await command(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      caller
    );
    const names = [...new Set(selected.stdout.split('\0').filter(Boolean))].sort();
    const head = (await command('git', ['rev-parse', 'HEAD'], caller)).stdout.trim();
    const before = await snapshot(caller, names);
    for (const entry of before) {
      if (entry.kind === 'missing') {
        continue;
      }

      const destination = privatePath(root, entry.path);
      await mkdir(dirname(destination), {recursive: true});
      if (entry.kind === 'file') {
        await writeFile(destination, entry.bytes, {flag: 'wx'});
        await chmod(destination, entry.mode);
      } else {
        const target = await realpath(join(caller, entry.path));
        await symlink(
          relative(dirname(destination), join(root, relative(caller, target))),
          destination
        );
      }
    }

    const after = await snapshot(caller, names);
    const currentNames = (
      await command(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        caller
      )
    ).stdout
      .split('\0')
      .filter(Boolean);
    if (
      JSON.stringify([...new Set(currentNames)].sort()) !== JSON.stringify(names) ||
      JSON.stringify(inventory(before)) !== JSON.stringify(inventory(after)) ||
      before.some((entry, index) => entry.stamp !== after[index]?.stamp)
    ) {
      throw new Error(
        'Source changed during capture: bytes, modes, links, or file set differ'
      );
    }

    const copiedNames = await fileNames(root);
    if (
      JSON.stringify(copiedNames) !==
      JSON.stringify(
        before.filter(entry => entry.kind !== 'missing').map(entry => entry.path)
      )
    ) {
      throw new Error('Copied source file set differs from captured source');
    }

    if ((await command('git', ['rev-parse', 'HEAD'], caller)).stdout.trim() !== head) {
      throw new Error('Source HEAD changed during capture');
    }

    for (const entry of before) {
      if (
        entry.kind === 'file' &&
        (!entry.bytes.equals(await readFile(privatePath(root, entry.path))) ||
          Number((await lstat(privatePath(root, entry.path))).mode & 0o777) !==
            entry.mode)
      ) {
        throw new Error(`Copied source differs: ${entry.path}`);
      }
    }

    sourceIdentity = {
      root: caller,
      head,
      digest: hash(JSON.stringify(inventory(before))),
      files: inventory(before),
    };
    await writeFile(
      join(diagnostics, 'source.json'),
      JSON.stringify(sourceIdentity, null, 2)
    );
    const capturedMs = performance.now() - started;
    await mkdir(join(root, '.tmp'));
    environment.NODE_COMPILE_CACHE = join(root, '.tmp/node-compile-cache');
    const lockfile = await readFile(join(root, 'pnpm-lock.yaml'));
    const installStarted = performance.now();
    await pnpm([
      'install',
      '--frozen-lockfile',
      '--package-import-method=copy',
      '--virtual-store-dir=node_modules/.pnpm',
      '--config.enable-global-virtual-store=false',
      '--config.side-effects-cache-readonly=true',
      '--reporter=ndjson',
    ]);
    if (!lockfile.equals(await readFile(join(root, 'pnpm-lock.yaml')))) {
      throw new Error('Frozen fixture install changed its lockfile');
    }

    await inspectLinks(root);
    const {devEngines} = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const probe = await pnpm([
      'exec',
      'node',
      '-p',
      'JSON.stringify({path:process.execPath,version:process.versions.node})',
    ]);
    const selectedRuntime: {path: string; version: string} = JSON.parse(probe.stdout);
    runtime = await realpath(selectedRuntime.path);
    if (
      !contained(root, runtime) ||
      selectedRuntime.version !== devEngines.runtime.version
    ) {
      throw new Error(`Fixture runtime differs from locked Node: ${runtime}`);
    }

    environment.PATH = [
      dirname(runtime),
      join(root, 'node_modules/.bin'),
      environment.PATH,
    ].join(delimiter);
    await writeFile(
      join(diagnostics, 'setup.json'),
      JSON.stringify({
        root,
        capturedMs,
        installMs: performance.now() - installStarted,
        runtime,
        installCount: 1,
      })
    );
    const result = await Promise.race([
      cancellation.promise,
      callback({
        path(name) {
          checkAdmission();
          return privatePath(root, name);
        },
        pnpm(args, settings) {
          return pnpm(args, privatePath(root, settings?.cwd ?? '.'));
        },
        nodeFile(file, args = [], settings) {
          return command(
            runtime,
            [privatePath(root, file), ...args],
            privatePath(root, settings?.cwd ?? '.')
          );
        },
      }),
    ]);
    admission = false;
    if (active.size !== 0) {
      throw new Error('Build fixture callback returned with unfinished commands');
    }

    if (interrupted || options.signal?.aborted) {
      throw interrupted ?? new Error('Build fixture aborted');
    }

    await rm(root, {recursive: true, force: true});
    await writeFile(
      join(diagnostics, 'result.json'),
      JSON.stringify({state: 'passed', root, sourceIdentity, commandCount})
    );
    return result;
  } catch (error) {
    admission = false;
    const completions = [...active.keys()];
    for (const stop of active.values()) {
      void stop().catch(() => {});
    }

    const teardown = await Promise.allSettled(stoppingChildren);
    await Promise.allSettled(completions);
    await writeFile(
      join(diagnostics, 'result.json'),
      JSON.stringify({
        state: interrupted ? 'interrupted' : 'failed',
        root,
        sourceIdentity,
        commandCount,
        error: String(error),
        teardownErrors: teardown
          .filter(result => result.status === 'rejected')
          .map(result => String(result.reason)),
      })
    );
    throw new Error(
      `Build fixture retained at ${root}; diagnostics at ${diagnostics}: ${String(error)}`,
      {
        cause: error,
      }
    );
  } finally {
    admission = false;
    options.signal?.removeEventListener('abort', cancel);
    process.removeListener('SIGTERM', terminate);
  }
}
