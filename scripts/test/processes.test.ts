import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import {requestOrderlyExit, RestartSupervisor, runCommand} from '../processes.mjs';

async function childProcess(mode: 'accept' | 'deny') {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    process.on('message', message => {
      if(message.type === 'shop-things:quit') {
        if(${JSON.stringify(mode)} === 'deny') process.send({denied:true});
        else setTimeout(() => {process.send({closed:true});process.disconnect();},40);
      }
      if(message.type === 'finish-test') process.disconnect();
    });
    process.send({ready:true});
  `,
    ],
    {stdio: ['ignore', 'ignore', 'inherit', 'ipc']}
  );
  await once(child, 'message');
  return child;
}

test('orderly restart waits for a real child to close', async () => {
  const accepted = await childProcess('accept');
  expect(await requestOrderlyExit(accepted, 1000)).toBe(true);
  expect(accepted.exitCode).toBe(0);
  expect(accepted.killed).toBe(false);
});

test('failed builds prevent launches until a successful cycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-build-gate-'));
  const versionPath = join(directory, 'version');
  const launchPath = join(directory, 'launched');
  await writeFile(versionPath, '1');
  let failing = true;
  const failures: unknown[] = [];
  const supervisor = new RestartSupervisor({
    version: () => readFile(versionPath, 'utf8'),
    stop: async () => true,
    async build() {
      await runCommand(
        process.execPath,
        ['-e', failing ? 'process.exit(1)' : 'process.exit(0)'],
        {
          stdio: 'ignore',
        }
      );
    },
    start: () =>
      runCommand(
        process.execPath,
        [
          '-e',
          "require('node:fs').appendFileSync(process.argv[1],'launched\\n')",
          launchPath,
        ],
        {stdio: 'ignore'}
      ),
    report: (error: unknown) => failures.push(error),
  });
  try {
    await supervisor.refresh();
    await expect(readFile(launchPath)).rejects.toMatchObject({code: 'ENOENT'});
    expect(failures.length).toBe(1);
    failing = false;
    await writeFile(versionPath, '2');
    await supervisor.refresh();
    expect(await readFile(launchPath, 'utf8')).toBe('launched\n');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('edits during a real build reject obsolete output and serialize concurrent refreshes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-build-change-'));
  const source = join(directory, 'source');
  await writeFile(source, 'first');
  let builds = 0,
    launches = 0;
  const supervisor = new RestartSupervisor({
    version: () => readFile(source, 'utf8'),
    stop: async () => true,
    async build() {
      builds++;
      await runCommand(
        process.execPath,
        [
          '-e',
          builds === 1
            ? "require('node:fs').writeFileSync(process.argv[1],'second')"
            : 'process.exit(0)',
          source,
        ],
        {stdio: 'ignore'}
      );
    },
    start: async () => {
      launches++;
    },
  });
  try {
    await Promise.all([supervisor.refresh(), supervisor.refresh(), supervisor.refresh()]);
    expect(builds).toBe(2);
    expect(launches).toBe(1);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('a denied real application shutdown prevents destructive rebuild or replacement launch', async () => {
  const child = await childProcess('deny');
  let builds = 0,
    launches = 0;
  const supervisor = new RestartSupervisor({
    version: async () => 'changed',
    stop: () => requestOrderlyExit(child, 40),
    build: async () => {
      builds++;
    },
    start: async () => {
      launches++;
    },
    report: () => {},
  });
  try {
    await supervisor.refresh();
    expect(builds).toBe(0);
    expect(launches).toBe(0);
    expect(child.exitCode).toBe(null);
    expect(child.killed).toBe(false);
    expect(child.killed).toBe(false);
  } finally {
    child.send({type: 'finish-test'});
    await once(child, 'exit');
  }
});
